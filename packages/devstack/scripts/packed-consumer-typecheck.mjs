import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), 'devstack-pack-consumer.'));
const keepTemp = process.env.DEVSTACK_KEEP_SMOKE === '1';
const consumerConfigFile = 'installed-consumer.devstack.ts';

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

const runtimeImportSmoke = [
	"await import('@mysten-incubation/devstack');",
	"await import('@mysten-incubation/devstack/runtime');",
].join('\n');

const removedSubpathSmoke = `
for (const subpath of ['browser', 'browser/setup', 'contracts', 'substrate']) {
\ttry {
\t\tawait import(\`@mysten-incubation/devstack/\${subpath}\`);
\t} catch (error) {
\t\tif (error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
\t\t\tcontinue;
\t\t}
\t\tthrow error;
\t}
\tthrow new Error(\`expected @mysten-incubation/devstack/\${subpath} to be unexported\`);
}
`.trim();

const stackContextSmoke = `
import { readStackContext } from '@mysten-incubation/devstack/runtime';

const ctx = readStackContext({ cwd: process.cwd(), env: {}, stack: 'main' });
if (ctx.identity.app !== 'installed-consumer-smoke') {
\tthrow new Error(\`expected app installed-consumer-smoke, got \${ctx.identity.app}\`);
}
if (ctx.identity.stack !== 'main') {
\tthrow new Error(\`expected stack main, got \${ctx.identity.stack}\`);
}
if (ctx.identity.network !== 'localnet') {
\tthrow new Error(\`expected network localnet, got \${ctx.identity.network}\`);
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
					skipLibCheck: true,
					verbatimModuleSyntax: true,
					types: ['node'],
				},
				include: ['src/**/*.ts', consumerConfigFile],
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(consumerRoot, 'src/index.ts'),
		[
			"import '@mysten-incubation/devstack';",
			"import '@mysten-incubation/devstack/runtime';",
			'',
		].join('\n'),
	);
	writeFileSync(
		join(consumerRoot, consumerConfigFile),
		`
import { writeFileSync } from 'node:fs';
import { Effect } from 'effect';
import { defineDevstack, definePlugin } from '@mysten-incubation/devstack';

const installedConsumerSmokePlugin = definePlugin({
\tid: 'installed-consumer/smoke',
\trole: 'service',
\tsection: 'service',
\tstart: () =>
\t\tEffect.sync(() => {
\t\t\twriteFileSync(new URL('./installed-consumer-smoke.marker', import.meta.url), 'acquired\\n');
\t\t\treturn { message: 'acquired' } as const;
\t\t}),
});

export default defineDevstack({ members: [installedConsumerSmokePlugin], stackName: 'main' });
`.trimStart(),
	);

	run(
		'npm',
		[
			'install',
			join(tempRoot, tarball),
			'@types/node@24.12.2',
			'effect@4.0.0-beta.65',
			'typescript@5.9.3',
			'vite@6.4.2',
		],
		{
			cwd: consumerRoot,
			stdio: 'ignore',
		},
	);

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
		'packed consumer removed subpath smoke',
		'node',
		['--input-type=module', '--eval', removedSubpathSmoke],
		consumerRoot,
	);
	console.log('packed consumer removed subpath smoke passed');

	runSmoke(
		'packed consumer minimal boot smoke',
		'npx',
		[
			'--offline',
			'devstack',
			'apply',
			'--config',
			`./${consumerConfigFile}`,
			'--state-dir',
			'.devstack',
			'--app',
			'installed-consumer-smoke',
			'--stack',
			'main',
			'--network',
			'localnet',
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

	const typecheck = runTsc(consumerRoot);
	if (typecheck.status !== 0) {
		throw new Error(
			[
				'packed consumer failed with skipLibCheck enabled',
				typecheck.stdout.trim(),
				typecheck.stderr.trim(),
			]
				.filter(Boolean)
				.join('\n'),
		);
	}
	console.log('packed consumer skipLibCheck typecheck passed');
} finally {
	if (keepTemp) {
		console.log(`kept packed-consumer smoke artifacts at ${tempRoot}`);
	} else {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}
