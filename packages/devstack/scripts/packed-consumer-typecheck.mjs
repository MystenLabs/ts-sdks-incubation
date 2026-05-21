import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), 'devstack-pack-consumer.'));
const keepTemp = process.env.DEVSTACK_KEEP_SMOKE === '1';

const run = (command, args, options = {}) =>
	execFileSync(command, args, {
		cwd: options.cwd ?? packageRoot,
		encoding: 'utf8',
		stdio: options.stdio ?? 'pipe',
	});

const runTsc = (consumerRoot, extraArgs = []) =>
	spawnSync('npx', ['tsc', '--noEmit', ...extraArgs], {
		cwd: consumerRoot,
		encoding: 'utf8',
	});

const runSmoke = (label, command, args, cwd) => {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
	});

	if (result.status !== 0) {
		throw new Error(
			[`${label} failed`, result.error?.message, result.stdout.trim(), result.stderr.trim()]
				.filter(Boolean)
				.join('\n'),
		);
	}
};

const knownEffectSchemaBug =
	/effect\/dist\/internal\/schema\/schema\.d\.ts\(3,15\): error TS2304: Cannot find name 'SchemaErrorTypeId'\./;

const runtimeImportSmoke = [
	"await import('@mysten-incubation/devstack');",
	"await import('@mysten-incubation/devstack/vite');",
	"await import('@mysten-incubation/devstack/runtime');",
].join('\n');

const stackContextSmoke = `
import { readStackContext } from '@mysten-incubation/devstack/runtime';

const ctx = readStackContext({ cwd: process.cwd(), env: {}, stack: 'main' });
if (ctx.identity.app !== 'installed-consumer-smoke') {
\tthrow new Error(\`expected app installed-consumer-smoke, got \${ctx.identity.app}\`);
}
if (ctx.identity.stack !== 'main') {
\tthrow new Error(\`expected stack main, got \${ctx.identity.stack}\`);
}
if (ctx.identity.chain !== 'localnet') {
\tthrow new Error(\`expected chain localnet, got \${ctx.identity.chain}\`);
}
`.trim();

const assertFileExists = (path, label) => {
	if (!existsSync(path)) {
		throw new Error(`${label} was not written at ${path}`);
	}
};

try {
	run('pnpm', ['pack', '--pack-destination', tempRoot], { stdio: 'ignore' });

	const tarball = readdirSync(tempRoot).find((file) => file.endsWith('.tgz'));
	if (tarball === undefined) {
		throw new Error(`pnpm pack did not write a tarball into ${tempRoot}`);
	}

	const consumerRoot = join(tempRoot, 'consumer');
	mkdirSync(join(consumerRoot, 'src'), { recursive: true });
	writeFileSync(
		join(consumerRoot, 'package.json'),
		JSON.stringify(
			{
				name: 'devstack-packed-consumer-smoke',
				version: '0.0.0',
				private: true,
				type: 'module',
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(consumerRoot, 'tsconfig.json'),
		JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2022',
					lib: ['ES2022', 'DOM', 'ESNext.Disposable'],
					module: 'ESNext',
					moduleResolution: 'bundler',
					strict: true,
					skipLibCheck: false,
					verbatimModuleSyntax: true,
					types: [],
				},
				include: ['src/**/*.ts'],
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(consumerRoot, 'src/index.ts'),
		[
			"import '@mysten-incubation/devstack';",
			"import '@mysten-incubation/devstack/vite';",
			"import '@mysten-incubation/devstack/runtime';",
			'',
		].join('\n'),
	);
	writeFileSync(
		join(consumerRoot, 'devstack.config.ts'),
		`
import { writeFileSync } from 'node:fs';
import { Effect } from 'effect';
import { defineDevstack, defineNodePlugin, defineTag } from '@mysten-incubation/devstack';

const InstalledConsumerSmokeTag = defineTag<
\t'installed-consumer/smoke',
\t{ readonly message: 'acquired' }
>('installed-consumer/smoke', 'installed-consumer-smoke');

const installedConsumerSmokePlugin = defineNodePlugin({
\tprovides: InstalledConsumerSmokeTag,
\tconsumes: [] as const,
\tkind: 'leaf-long-running',
\tacquire: () =>
\t\tEffect.sync(() => {
\t\t\twriteFileSync(new URL('./installed-consumer-smoke.marker', import.meta.url), 'acquired\\n');
\t\t\treturn { message: 'acquired' } as const;
\t\t}),
});

export default defineDevstack(installedConsumerSmokePlugin, { stackName: 'main' });
`.trimStart(),
	);

	run('npm', ['install', join(tempRoot, tarball), 'typescript@5.9.3', 'vite@6.4.2'], {
		cwd: consumerRoot,
		stdio: 'ignore',
	});

	runSmoke('packed consumer CLI smoke', 'npx', ['--offline', 'devstack', '--help'], consumerRoot);
	console.log('packed consumer CLI smoke passed');

	runSmoke(
		'packed consumer runtime ESM import smoke',
		'node',
		['--input-type=module', '--eval', runtimeImportSmoke],
		consumerRoot,
	);
	console.log('packed consumer runtime ESM import smoke passed');

	runSmoke(
		'packed consumer minimal boot smoke',
		'npx',
		[
			'--offline',
			'devstack',
			'--config',
			'./devstack.config.ts',
			'--state-dir',
			'.devstack',
			'--app',
			'installed-consumer-smoke',
			'--stack',
			'main',
			'--network',
			'localnet',
			'apply',
		],
		consumerRoot,
	);
	assertFileExists(
		join(consumerRoot, 'installed-consumer-smoke.marker'),
		'packed consumer minimal boot marker',
	);
	assertFileExists(
		join(consumerRoot, '.devstack', 'stacks', 'main', 'manifest.json'),
		'packed consumer minimal boot manifest',
	);
	runSmoke(
		'packed consumer stack context smoke',
		'node',
		['--input-type=module', '--eval', stackContextSmoke],
		consumerRoot,
	);
	console.log('packed consumer minimal boot smoke passed');

	const skipLibCheck = runTsc(consumerRoot, ['--skipLibCheck']);
	if (skipLibCheck.status !== 0) {
		throw new Error(
			[
				'packed consumer failed with --skipLibCheck',
				skipLibCheck.stdout.trim(),
				skipLibCheck.stderr.trim(),
			]
				.filter(Boolean)
				.join('\n'),
		);
	}

	const strict = runTsc(consumerRoot);
	if (strict.status === 0) {
		console.log('packed consumer strict typecheck passed');
		process.exitCode = 0;
	} else {
		const output = [strict.stdout, strict.stderr].join('\n').trim();
		const errors = output
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.includes(' error TS'));

		if (errors.length === 1 && knownEffectSchemaBug.test(errors[0])) {
			console.log('packed consumer skipLibCheck typecheck passed');
			console.log(
				`strict typecheck is blocked by known upstream Effect declaration bug: ${errors[0]}`,
			);
			process.exitCode = 0;
		} else {
			throw new Error(
				['packed consumer strict typecheck failed with unexpected errors', output]
					.filter(Boolean)
					.join('\n'),
			);
		}
	}
} finally {
	if (keepTemp) {
		console.log(`kept packed-consumer smoke artifacts at ${tempRoot}`);
	} else {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}
