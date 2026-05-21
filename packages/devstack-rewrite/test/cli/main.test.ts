import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/cli/main.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tempRoots: Array<string> = [];

const makeTempRoot = (prefix: string): string => {
	const root = mkdtempSync(join(packageRoot, `.tmp-${prefix}-`));
	tempRoots.push(root);
	return root;
};

const writeCodegenConfig = (appRoot: string): string => {
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
} from '@mysten-incubation/devstack-rewrite';

const CliApplyCodegenTag = defineTag<'test/cli-apply-codegen', { readonly message: string }>(
\t'test/cli-apply-codegen',
\t'test',
);

const cliApplyCodegenPlugin = defineNodePlugin({
\tprovides: CliApplyCodegenTag,
\tconsumes: [] as const,
\tkind: 'leaf-long-running',
\tacquire: () => Effect.succeed({ message: 'from-cli-apply' } as const),
\tcapabilities: (resolved) =>
\t\tcapabilities({
\t\t\tkind: 'codegenable',
\t\t\temitterName: 'cli-apply-proof',
\t\t\toutputPath: 'cli-apply-proof.ts',
\t\t\tsensitive: false,
\t\t\temit: () => Effect.succeed({ cliApplyProof: resolved }),
\t\t} satisfies CodegenableDecl<
\t\t\t{ readonly cliApplyProof: { readonly message: string } },
\t\t\t'cli-apply-proof'
\t\t>),
});

export default defineDevstack(cliApplyCodegenPlugin, { stackName: 'main' });
`.trimStart(),
	);
	return configPath;
};

const captureProcessWrite =
	(bucket: Array<string>): typeof process.stdout.write =>
	(chunk, encodingOrCallback?, callback?) => {
		bucket.push(String(chunk));
		if (typeof encodingOrCallback === 'function') {
			encodingOrCallback();
		}
		if (typeof callback === 'function') {
			callback();
		}
		return true;
	};

describe('cli/main', () => {
	afterEach(() => {
		for (const root of tempRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('apply runs production codegen lifecycle and emits importable generated code', async () => {
		const appRoot = makeTempRoot('cli-codegen-app');
		const stateRoot = makeTempRoot('cli-codegen-state');
		const configPath = writeCodegenConfig(appRoot);
		const generatedPath = join(appRoot, 'src', 'generated', 'cli-apply-proof.ts');
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

			expect(existsSync(generatedPath)).toBe(false);

			await runCli([
				'--config',
				configPath,
				'--state-dir',
				stateRoot,
				'--app',
				'cli-apply-codegen',
				'--stack',
				'main',
				'--network',
				'localnet',
				'apply',
			]);

			expect(process.exitCode).toBe(0);
			expect(existsSync(generatedPath)).toBe(true);

			const mod = (await import(`${pathToFileURL(generatedPath).href}?t=${Date.now()}`)) as {
				readonly cliApplyProof: { readonly message: string };
			};
			expect(mod.cliApplyProof).toEqual({ message: 'from-cli-apply' });
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
	}, 60_000);

	it('up help through runCli does not load config or start the live path', async () => {
		const appRoot = makeTempRoot('cli-up-help-app');
		const stateRoot = makeTempRoot('cli-up-help-state');
		const missingConfig = join(appRoot, 'missing.config.ts');
		const previousExitCode = process.exitCode;
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
			await runCli(['--config', missingConfig, '--state-dir', stateRoot, 'up', '--help']);

			expect(process.exitCode).toBe(0);
			expect(stdout.join('')).toContain('Usage: devstack up');
			expect(stderr.join('')).toBe('');
		} finally {
			process.exitCode = previousExitCode;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it('apply help through runCli does not load config or start the live path', async () => {
		const appRoot = makeTempRoot('cli-apply-help-app');
		const stateRoot = makeTempRoot('cli-apply-help-state');
		const missingConfig = join(appRoot, 'missing.config.ts');
		const previousExitCode = process.exitCode;
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
			await runCli(['--config', missingConfig, '--state-dir', stateRoot, 'apply', '--help']);

			expect(process.exitCode).toBe(0);
			expect(stdout.join('')).toContain('Usage: devstack apply');
			expect(stderr.join('')).toBe('');
		} finally {
			process.exitCode = previousExitCode;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});
});
