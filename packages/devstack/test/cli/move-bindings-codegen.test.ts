import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli/main.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = join(packageRoot, 'test/fixtures/move/hello');
const tempRoots: Array<string> = [];

const hasSui = (): boolean => {
	const result = spawnSync('sui', ['--version'], {
		encoding: 'utf8',
		timeout: 5_000,
	});
	return result.status === 0;
};

const makeTempRoot = (prefix: string): string => {
	const root = mkdtempSync(join(packageRoot, `.tmp-${prefix}-`));
	tempRoots.push(root);
	return root;
};

const writeMoveBindingsConfig = (appRoot: string, movePackagePath: string): string => {
	const configPath = join(appRoot, 'devstack.config.ts');
	writeFileSync(
		configPath,
		`
import { Effect } from 'effect';
import {
\tcapabilities,
\tdefineDevstack,
\tdefineNodePlugin,
\tdefineTag,
\ttype CodegenableDecl,
} from '@mysten-incubation/devstack';

const MoveBindingsProofTag = defineTag<'test/move-bindings-proof', { readonly packageName: string }>(
\t'test/move-bindings-proof',
\t'test',
);

const moveBindingsProofPlugin = defineNodePlugin({
\tprovides: MoveBindingsProofTag,
\tconsumes: [] as const,
\tkind: 'leaf-long-running',
\tacquire: () => Effect.succeed({ packageName: 'hello' } as const),
\tcapabilities: () =>
\t\tcapabilities({
\t\t\tkind: 'codegenable',
\t\t\temitterName: 'package',
\t\t\toutputPath: 'package/@local/hello.ts',
\t\t\tsensitive: false,
\t\t\temit: () =>
\t\t\t\tEffect.succeed({
\t\t\t\t\tpackageBindings: {
\t\t\t\t\t\tname: 'hello',
\t\t\t\t\t\tpackageId: '0x123',
\t\t\t\t\t\tmvrPlaceholder: '@local/hello',
\t\t\t\t\t\tsourcePath: ${JSON.stringify(movePackagePath)},
\t\t\t\t\t\texcluded: false,
\t\t\t\t\t},
\t\t\t\t}),
\t\t} satisfies CodegenableDecl<
\t\t\t{
\t\t\t\treadonly packageBindings: {
\t\t\t\t\treadonly name: string;
\t\t\t\t\treadonly packageId: string;
\t\t\t\t\treadonly mvrPlaceholder: string;
\t\t\t\t\treadonly sourcePath: string;
\t\t\t\t\treadonly excluded: false;
\t\t\t\t};
\t\t\t},
\t\t\t'package'
\t\t>),
});

export default defineDevstack(moveBindingsProofPlugin, { stackName: 'main' });
`.trimStart(),
	);
	return configPath;
};

describe('cli apply Move bindings codegen', () => {
	afterEach(() => {
		for (const root of tempRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!hasSui())(
		'runs host sui move summary, real @mysten/codegen, and imports generated bindings',
		async () => {
			const appRoot = makeTempRoot('cli-move-bindings-app');
			const stateRoot = makeTempRoot('cli-move-bindings-state');
			const movePackagePath = join(appRoot, 'move/hello');
			cpSync(fixtureRoot, movePackagePath, { recursive: true });
			rmSync(join(movePackagePath, 'package_summaries'), { recursive: true, force: true });

			const configPath = writeMoveBindingsConfig(appRoot, movePackagePath);
			const generatedBindingPath = join(appRoot, 'src/generated/bindings/hello/hello.ts');
			const sourceSummaryPath = join(movePackagePath, 'package_summaries/hello/hello.json');
			const previousExitCode = process.exitCode;
			const previousEnv = {
				DEVSTACK_APP: process.env.DEVSTACK_APP,
				DEVSTACK_STACK: process.env.DEVSTACK_STACK,
				DEVSTACK_NETWORK: process.env.DEVSTACK_NETWORK,
				DEVSTACK_STATE_DIR: process.env.DEVSTACK_STATE_DIR,
				DEVSTACK_CONFIG: process.env.DEVSTACK_CONFIG,
			};

			try {
				process.exitCode = undefined;
				delete process.env.DEVSTACK_APP;
				delete process.env.DEVSTACK_STACK;
				delete process.env.DEVSTACK_NETWORK;
				delete process.env.DEVSTACK_STATE_DIR;
				delete process.env.DEVSTACK_CONFIG;

				expect(existsSync(sourceSummaryPath)).toBe(false);
				expect(existsSync(generatedBindingPath)).toBe(false);

				await runCli([
					'--config',
					configPath,
					'--state-dir',
					stateRoot,
					'--app',
					'cli-move-bindings-codegen',
					'--stack',
					'main',
					'--network',
					'localnet',
					'apply',
				]);

				expect(process.exitCode).toBe(0);
				expect(existsSync(sourceSummaryPath)).toBe(false);
				expect(existsSync(generatedBindingPath)).toBe(true);

				const mod = (await import(
					`${pathToFileURL(generatedBindingPath).href}?t=${Date.now()}`
				)) as {
					readonly Greeting: unknown;
					readonly mint: (options: unknown) => unknown;
				};
				expect(mod.Greeting).toBeDefined();
				expect(typeof mod.mint).toBe('function');
			} finally {
				process.exitCode = previousExitCode;
				for (const [key, value] of Object.entries(previousEnv)) {
					if (value === undefined) {
						delete process.env[key];
					} else {
						process.env[key] = value;
					}
				}
			}
		},
		120_000,
	);
});
