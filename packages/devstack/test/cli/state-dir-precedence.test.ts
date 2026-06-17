// State-dir precedence ladder (CLI `runCli`):
//
//   `--state-dir` flag > `config.options.stateDir`
//   (`defineDevstack({ stateDir })`) > `$DEVSTACK_STATE_DIR`
//   > `<cwd>/.devstack`.
//
// `runCli` resolves the runtime root before dispatching a verb, reading
// `config.options.stateDir` best-effort from the discovered
// `devstack.config.ts`. We observe the chosen runtime root indirectly via
// `status`, which (offline) projects the on-disk manifest at
// `<runtimeRoot>/stacks/<stack>/manifest.json`: a manifest written at the
// EXPECTED resolved location surfaces as `present: true`. The `--config`
// flag is not a `status` option, so the config is discovered by walking up
// from the working directory (the same path `configStateDirBestEffort`
// uses).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/cli/main.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tempRoots: Array<string> = [];

const makeTempRoot = (prefix: string): string => {
	const root = mkdtempSync(join(packageRoot, `.tmp-${prefix}-`));
	tempRoots.push(root);
	return root;
};

/** Writes a `devstack.config.ts` exporting an empty stack with the given
 *  `stateDir` option. Empty members keep the config evaluation cheap and
 *  Docker-free for an offline `status` run. */
const writeConfigWithStateDir = (appRoot: string, stateDir: string): void => {
	writeFileSync(
		join(appRoot, 'devstack.config.ts'),
		`
import { defineDevstack } from '@mysten-incubation/devstack';

export default defineDevstack({ members: [], stateDir: ${JSON.stringify(stateDir)} });
`.trimStart(),
	);
};

const captureProcessWrite =
	(bucket: Array<string>): typeof process.stdout.write =>
	(chunk, encodingOrCallback?, callback?) => {
		bucket.push(String(chunk));
		if (typeof encodingOrCallback === 'function') encodingOrCallback();
		if (typeof callback === 'function') callback();
		return true;
	};

const ENV_KEYS = [
	'DEVSTACK_APP',
	'DEVSTACK_STACK',
	'DEVSTACK_NETWORK',
	'DEVSTACK_STATE_DIR',
	'DEVSTACK_CONFIG',
] as const;

/** Runs `status --json` from `cwd` with a clean env (plus any overrides),
 *  capturing stdout/stderr and restoring all process-global mutations. */
const runStatusFromCwd = async (
	cwd: string,
	argv: ReadonlyArray<string>,
	envOverrides: Readonly<Record<string, string>> = {},
): Promise<{
	readonly present: boolean;
	readonly stderr: string;
	readonly exitCode: number | undefined;
}> => {
	const previousExitCode = process.exitCode;
	const previousCwd = process.cwd();
	const previousEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	const stdout: Array<string> = [];
	const stderr: Array<string> = [];
	const stdoutSpy = vi
		.spyOn(process.stdout, 'write')
		.mockImplementation(captureProcessWrite(stdout));
	const stderrSpy = vi
		.spyOn(process.stderr, 'write')
		.mockImplementation(captureProcessWrite(stderr));
	try {
		process.exitCode = undefined;
		for (const k of ENV_KEYS) delete process.env[k];
		for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
		process.chdir(cwd);
		await runCli(['status', '--app', 'precedence-app', '--stack', 'main', '--json', ...argv]);
		const envelope =
			stdout.join('').trim().length > 0
				? (JSON.parse(stdout.join('')) as { readonly data?: { readonly present?: boolean } })
				: undefined;
		return {
			present: envelope?.data?.present === true,
			stderr: stderr.join(''),
			exitCode: process.exitCode,
		};
	} finally {
		process.chdir(previousCwd);
		process.exitCode = previousExitCode;
		for (const k of ENV_KEYS) {
			const v = previousEnv[k];
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
	}
};

/** Writes a minimal on-disk manifest at `<runtimeRoot>/stacks/main/manifest.json`
 *  — the durable record the offline `status` projects when the stack is
 *  down. Its mere presence at the EXPECTED resolved location is what makes
 *  `status` report `present: true`, so it pins the resolved runtime root. */
const seedManifest = (runtimeRoot: string): void => {
	const stackRoot = join(runtimeRoot, 'stacks', 'main');
	mkdirSync(stackRoot, { recursive: true });
	writeFileSync(
		join(stackRoot, 'manifest.json'),
		JSON.stringify({
			identity: { app: 'precedence-app', stack: 'main', network: 'localnet' },
			manifestVersion: 1,
			endpoints: {},
			extras: {},
		}),
		'utf8',
	);
};

describe('cli state-dir precedence ladder', () => {
	afterEach(() => {
		for (const root of tempRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('config.options.stateDir is honored when it is the only signal', async () => {
		const appRoot = makeTempRoot('statedir-config-only-app');
		const configStateDir = makeTempRoot('statedir-config-only-state');
		writeConfigWithStateDir(appRoot, configStateDir);
		seedManifest(configStateDir);

		const result = await runStatusFromCwd(appRoot, []);
		expect(result.stderr).toBe('');
		expect(result.exitCode).toBe(0);
		expect(result.present).toBe(true);
	}, 60_000);

	it('--state-dir flag beats config.options.stateDir', async () => {
		const appRoot = makeTempRoot('statedir-flag-wins-app');
		const configStateDir = makeTempRoot('statedir-flag-wins-config-state');
		const flagStateDir = makeTempRoot('statedir-flag-wins-flag-state');
		writeConfigWithStateDir(appRoot, configStateDir);
		// Manifest lives ONLY under the flag dir — `present: true` proves
		// the flag won over the config's stateDir.
		seedManifest(flagStateDir);

		const result = await runStatusFromCwd(appRoot, ['--state-dir', flagStateDir]);
		expect(result.stderr).toBe('');
		expect(result.exitCode).toBe(0);
		expect(result.present).toBe(true);
	}, 60_000);

	it('config.options.stateDir beats $DEVSTACK_STATE_DIR', async () => {
		const appRoot = makeTempRoot('statedir-config-beats-env-app');
		const configStateDir = makeTempRoot('statedir-config-beats-env-config-state');
		const envStateDir = makeTempRoot('statedir-config-beats-env-env-state');
		writeConfigWithStateDir(appRoot, configStateDir);
		// Manifest lives ONLY under the config dir — `present: true` proves
		// the config value won over the env var.
		seedManifest(configStateDir);

		const result = await runStatusFromCwd(appRoot, [], { DEVSTACK_STATE_DIR: envStateDir });
		expect(result.stderr).toBe('');
		expect(result.exitCode).toBe(0);
		expect(result.present).toBe(true);
	}, 60_000);

	it('no-config verb falls back to the cwd-local .devstack default', async () => {
		const appRoot = makeTempRoot('statedir-cwd-default-app');
		// No devstack.config.ts in appRoot or any ancestor inside the temp
		// tree; with no flag/env the runtime root must default to
		// `<cwd>/.devstack`.
		const cwdDefault = join(appRoot, '.devstack');
		mkdirSync(cwdDefault, { recursive: true });
		seedManifest(cwdDefault);

		const result = await runStatusFromCwd(appRoot, []);
		expect(result.stderr).toBe('');
		expect(result.exitCode).toBe(0);
		expect(result.present).toBe(true);
	}, 60_000);
});
