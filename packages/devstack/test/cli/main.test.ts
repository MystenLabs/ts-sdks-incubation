import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname as nodeHostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/cli/main.ts';
import {
	contributionPath,
	SNAPSHOT_CONTRIBUTION_VERSION,
	SnapshotLayout,
	SNAPSHOT_META_VERSION,
	writeArtifactIntegrity,
} from '../../src/orchestrators/snapshot/index.ts';
import type { SubscribableState } from '../../src/substrate/projection.ts';
import { COMMAND_CHANNEL_COMMANDS_FILE_NAME } from '../../src/substrate/runtime/cross-process/index.ts';
import { processStartTime } from '../../src/substrate/runtime/cross-process/liveness.ts';
import { writeProjectionSnapshot } from '../../src/substrate/runtime/projection/index.ts';

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
\tcodegenable,
\tdefineDevstack,
\tdefinePlugin,
} from '@mysten-incubation/devstack';

const cliApplyCodegenPlugin = definePlugin({
\tid: 'test/cli-apply-codegen',
\tkind: 'leaf-long-running',
\tstart: () => Effect.succeed({ message: 'from-cli-apply' } as const),
\tcapabilities: ({ value }) => [
\t\tcodegenable({
\t\t\temitterName: 'cli-apply-proof',
\t\t\toutputPath: 'cli-apply-proof.ts',
\t\t\tsensitive: false,
\t\t\temit: () => Effect.succeed({ cliApplyProof: value }),
\t\t}),
\t],
});

export default defineDevstack({ members: [cliApplyCodegenPlugin], stackName: 'main' });
`.trimStart(),
	);
	return configPath;
};

const OFFLINE_RESTORE_PLUGIN_KEY = 'test/offline-restore#0';
const OFFLINE_RESTORE_IDENTITY = JSON.stringify({ marker: 'offline-restore' });
const OFFLINE_RESTORE_SUI_PLUGIN_KEY = 'sui#0';
const OFFLINE_RESTORE_SUI_SNAPSHOT_IDENTITY = JSON.stringify({
	chain: 'snapshot-chain',
	kind: 'sui-chain',
});

const makeProjectionState = (params: {
	readonly app: string;
	readonly stack: string;
	readonly network: string;
}): SubscribableState => ({
	identity: params,
	cycle: { id: 1, startedAt: 123, phase: 'running' },
	rows: [],
	endpoints: [],
	accounts: [],
	packages: [],
	errors: [],
	lastEvent: { seq: 1, at: 124 },
	stackBuild: [],
});

const writeSnapshotMetadata = (stackRoot: string, snapshotId: string): void => {
	const snapshotDir = join(stackRoot, 'snapshots', snapshotId);
	mkdirSync(snapshotDir, { recursive: true });
	writeFileSync(
		join(snapshotDir, SnapshotLayout.metaFile),
		JSON.stringify(
			{
				version: SNAPSHOT_META_VERSION,
				id: snapshotId,
				label: 'workflow-baseline',
				createdAt: 1_700_000_000_000,
				app: 'labeled-app',
				stack: 'alpha',
				network: 'sui:local',
				hostTreeIncluded: false,
				subtrees: [],
				containers: [],
				identity: {},
				participants: [],
			},
			null,
			2,
		),
	);
};

const writeRestorableSnapshotArtifact = async (
	stackRoot: string,
	snapshotId: string,
	identity: Readonly<Record<string, string>> = {
		[OFFLINE_RESTORE_PLUGIN_KEY]: OFFLINE_RESTORE_IDENTITY,
	},
): Promise<void> => {
	const snapshotDir = join(stackRoot, 'snapshots', snapshotId);
	mkdirSync(join(snapshotDir, SnapshotLayout.contributionsDir), { recursive: true });
	const participants = Object.entries(identity);
	writeFileSync(
		join(snapshotDir, SnapshotLayout.metaFile),
		JSON.stringify(
			{
				version: SNAPSHOT_META_VERSION,
				id: snapshotId,
				label: 'workflow-baseline',
				createdAt: 1_700_000_000_000,
				app: 'labeled-app',
				stack: 'alpha',
				network: 'sui:local',
				hostTreeIncluded: false,
				subtrees: [],
				containers: [],
				identity,
				participants: participants.map(([plugin]) => plugin),
			},
			null,
			2,
		),
	);
	for (const [plugin, value] of participants) {
		writeFileSync(
			join(snapshotDir, contributionPath(plugin)),
			JSON.stringify(
				{
					version: SNAPSHOT_CONTRIBUTION_VERSION,
					plugin,
					identity: { [plugin]: value },
				},
				null,
				2,
			),
		);
	}
	await Effect.runPromise(
		writeArtifactIntegrity(snapshotDir).pipe(Effect.provide(NodeFileSystem.layer)),
	);
};

const writeLiveRoster = (stackRoot: string): void => {
	mkdirSync(stackRoot, { recursive: true });
	writeFileSync(
		join(stackRoot, 'roster.json'),
		JSON.stringify({
			version: 1,
			holders: [
				{
					pid: process.pid,
					startTime: processStartTime(process.pid) ?? 0,
					hostname: nodeHostname(),
					claimedAt: Date.now(),
					heartbeatAt: Date.now(),
					intent: 'normal',
				},
			],
		}),
		'utf8',
	);
};

const readCommandLog = (
	stackRoot: string,
): ReadonlyArray<{ readonly command: { readonly tag: string; readonly snapshotId?: string } }> =>
	readFileSync(join(stackRoot, COMMAND_CHANNEL_COMMANDS_FILE_NAME), 'utf8')
		.trim()
		.split('\n')
		.flatMap((line) =>
			line === ''
				? []
				: [
						JSON.parse(line) as {
							readonly command: { readonly tag: string; readonly snapshotId?: string };
						},
					],
		);

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
				'apply',
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

	it('status reads persisted projection from the runtime stacks root', async () => {
		const stateRoot = makeTempRoot('cli-status-state');
		const stackRoot = join(stateRoot, 'stacks', 'alpha');
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
			await Effect.runPromise(
				writeProjectionSnapshot(
					stackRoot,
					makeProjectionState({
						app: 'labeled-app',
						stack: 'alpha',
						network: 'sui:local',
					}),
				),
			);

			await runCli([
				'status',
				'--state-dir',
				stateRoot,
				'--app',
				'labeled-app',
				'--stack',
				'alpha',
				'--json',
			]);

			expect(stderr.join('')).toBe('');
			expect(process.exitCode).toBe(0);
			const envelope = JSON.parse(stdout.join('')) as {
				readonly ok: true;
				readonly data: { readonly present: boolean; readonly identity: unknown };
			};
			expect(envelope.data.present).toBe(true);
			expect(envelope.data.identity).toEqual({
				app: 'labeled-app',
				stack: 'alpha',
				network: 'sui:local',
			});
		} finally {
			process.exitCode = previousExitCode;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it('snapshot list reads snapshots from the runtime stacks root', async () => {
		const stateRoot = makeTempRoot('cli-snapshot-state');
		const stackRoot = join(stateRoot, 'stacks', 'alpha');
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
			writeSnapshotMetadata(stackRoot, 'baseline');

			await runCli([
				'snapshot',
				'list',
				'--state-dir',
				stateRoot,
				'--app',
				'labeled-app',
				'--stack',
				'alpha',
				'--json',
			]);

			expect(stderr.join('')).toBe('');
			expect(process.exitCode).toBe(0);
			const envelope = JSON.parse(stdout.join('')) as {
				readonly ok: true;
				readonly data: { readonly entries: ReadonlyArray<{ readonly snapshotId: string }> };
			};
			expect(envelope.data.entries.map((entry) => entry.snapshotId)).toEqual(['baseline']);
		} finally {
			process.exitCode = previousExitCode;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it('snapshot restore refuses to bypass a live attached supervisor', async () => {
		const stateRoot = makeTempRoot('cli-snapshot-restore-state');
		const stackRoot = join(stateRoot, 'stacks', 'alpha');
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
			writeSnapshotMetadata(stackRoot, 'baseline');
			writeLiveRoster(stackRoot);

			await runCli([
				'snapshot',
				'restore',
				'workflow-baseline',
				'--state-dir',
				stateRoot,
				'--app',
				'labeled-app',
				'--stack',
				'alpha',
				'--json',
			]);

			expect(process.exitCode).toBe(40);
			expect(stderr.join('')).toBe('');
			const envelope = JSON.parse(stdout.join('')) as {
				readonly ok: false;
				readonly error: { readonly summary: string };
			};
			expect(envelope.error.summary).toContain('supervisor live for labeled-app/alpha');
			expect(existsSync(join(stackRoot, COMMAND_CHANNEL_COMMANDS_FILE_NAME))).toBe(false);
			expect(
				existsSync(join(stateRoot, 'labeled-app', 'alpha', COMMAND_CHANNEL_COMMANDS_FILE_NAME)),
			).toBe(false);
		} finally {
			process.exitCode = previousExitCode;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it('snapshot restore runs directly without a live roster', async () => {
		const stateRoot = makeTempRoot('cli-snapshot-direct-restore-state');
		const stackRoot = join(stateRoot, 'stacks', 'alpha');
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
			await writeRestorableSnapshotArtifact(stackRoot, 'baseline');

			await runCli([
				'snapshot',
				'restore',
				'baseline',
				'--state-dir',
				stateRoot,
				'--app',
				'labeled-app',
				'--stack',
				'alpha',
				'--json',
			]);

			expect(process.exitCode).toBe(0);
			expect(stderr.join('')).toBe('');
			const envelope = JSON.parse(stdout.join('')) as {
				readonly ok: true;
				readonly data: { readonly snapshotId: string };
			};
			expect(envelope.data).toEqual({ snapshotId: 'baseline' });
			const commandLogPath = join(stackRoot, COMMAND_CHANNEL_COMMANDS_FILE_NAME);
			const commandLog = existsSync(commandLogPath) ? readCommandLog(stackRoot) : [];
			expect(
				commandLog.map((record) => ({
					tag: record.command.tag,
					snapshotId: record.command.snapshotId,
				})),
			).toEqual([]);
		} finally {
			process.exitCode = previousExitCode;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it('snapshot restore uses snapshot Sui identity before acquiring without a live roster', async () => {
		const appRoot = makeTempRoot('cli-snapshot-direct-restore-sui-app');
		const stateRoot = makeTempRoot('cli-snapshot-direct-restore-sui-state');
		const stackRoot = join(stateRoot, 'stacks', 'alpha');
		const acquireMarker = join(appRoot, 'sui-acquired');
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
			await writeRestorableSnapshotArtifact(stackRoot, 'baseline', {
				[OFFLINE_RESTORE_SUI_PLUGIN_KEY]: OFFLINE_RESTORE_SUI_SNAPSHOT_IDENTITY,
			});

			await runCli([
				'snapshot',
				'restore',
				'baseline',
				'--state-dir',
				stateRoot,
				'--app',
				'labeled-app',
				'--stack',
				'alpha',
				'--json',
			]);

			expect(process.exitCode).toBe(0);
			expect(stderr.join('')).toBe('');
			expect(existsSync(acquireMarker)).toBe(false);
			const envelope = JSON.parse(stdout.join('')) as {
				readonly ok: true;
				readonly data: { readonly snapshotId: string };
			};
			expect(envelope.data).toEqual({ snapshotId: 'baseline' });
		} finally {
			process.exitCode = previousExitCode;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it('down is not a public runCli command', async () => {
		const stateRoot = makeTempRoot('cli-down-state');
		const stackRoot = join(stateRoot, 'stacks', 'alpha');
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
			writeLiveRoster(stackRoot);

			await runCli([
				'down',
				'--state-dir',
				stateRoot,
				'--app',
				'labeled-app',
				'--stack',
				'alpha',
				'--json',
			]);

			expect(process.exitCode).toBe(64);
			expect(stderr.join('')).toBe('');
			const envelope = JSON.parse(stdout.join('')) as {
				readonly ok: false;
				readonly error: { readonly summary: string };
			};
			expect(envelope.error.summary).toContain('No command registered for `down`');
			expect(existsSync(join(stackRoot, COMMAND_CHANNEL_COMMANDS_FILE_NAME))).toBe(false);
			expect(
				existsSync(join(stateRoot, 'labeled-app', 'alpha', COMMAND_CHANNEL_COMMANDS_FILE_NAME)),
			).toBe(false);
		} finally {
			process.exitCode = previousExitCode;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

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
			await runCli(['up', '--config', missingConfig, '--state-dir', stateRoot, '--help']);

			expect(process.exitCode).toBe(0);
			expect(stdout.join('')).toContain('devstack up');
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
			await runCli(['apply', '--config', missingConfig, '--state-dir', stateRoot, '--help']);

			expect(process.exitCode).toBe(0);
			expect(stdout.join('')).toContain('devstack apply');
			expect(stderr.join('')).toBe('');
		} finally {
			process.exitCode = previousExitCode;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it('exec is not a public runCli command', async () => {
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
			await runCli(['exec', '--json', '--', process.execPath, '-e', 'process.exit(23)']);
			expect(process.exitCode).toBe(64);
			expect(stderr.join('')).toBe('');
			const envelope = JSON.parse(stdout.join('')) as {
				readonly ok: false;
				readonly error: { readonly summary: string };
			};
			expect(envelope.error.summary).toContain('No command registered for `exec`');
		} finally {
			process.exitCode = previousExitCode;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});
});
