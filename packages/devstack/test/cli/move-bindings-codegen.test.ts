import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { account, defineDevstack, localPackage, sui } from '@mysten-incubation/devstack';

const suiPlugin = sui();
const alice = account('alice');
const hello = localPackage('hello', {
\tsourcePath: ${JSON.stringify(movePackagePath)},
\tpublisher: alice,
});

export default defineDevstack({ members: [suiPlugin, alice, hello], stackName: 'main' });
`.trimStart(),
	);
	return configPath;
};

// `devstack codegen` is stack-FREE: it Move-compiles local package sources
// via the host `sui` binary + real `@mysten/codegen` and emits the committed
// `src/generated` tree WITHOUT booting a stack (no Docker, no publish). The
// emitted bindings are id-free (the `config.ts` resolves ids at app build
// time via `__DEVSTACK_IDS__`), so this is a pure deterministic projection.
describe('cli codegen Move bindings', () => {
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
			const generatedConfigPath = join(appRoot, 'src/generated/config.ts');
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
					'codegen',
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

				// The committed `config.ts` must runtime-resolve the active
				// network + its connection map (sui's `staticCodegen`): NO baked
				// network name, NO literal rpc URL. Regression guard for the
				// missing-`network`/`networks` bug that broke app `tsc`.
				const generatedConfig = readFileSync(generatedConfigPath, 'utf8');
				expect(generatedConfig).toContain('network: resolveNetwork()');
				expect(generatedConfig).toContain('networks: resolveNetworks()');
				expect(generatedConfig).toMatch(
					/import \{[^}]*\bresolveNetwork\b[^}]*\bresolveNetworks\b[^}]*\} from '\.\/config-runtime\.js';/,
				);
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
