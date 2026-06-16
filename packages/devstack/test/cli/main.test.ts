import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname as nodeHostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, Fiber, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { degradedStatusFromContext, identityInputsFromArgv, runCli } from '../../src/cli/main.ts';
import { readStackContext } from '../../src/build-integrations/runtime/read-stack-context.ts';
import {
	CACHE_DIR_NAME,
	contributionPath,
	DEPLOY_CACHE_NAMESPACES,
	SNAPSHOT_CONTRIBUTION_VERSION,
	SNAPSHOT_GRAPH_INPUT_VERSION,
	SnapshotLayout,
	SNAPSHOT_META_VERSION,
	writeArtifactIntegrity,
} from '../../src/orchestrators/snapshot/index.ts';
import {
	commandChannelPaths,
	COMMAND_CHANNEL_COMMANDS_FILE_NAME,
	makeCommandChannelSubscriber,
} from '../../src/substrate/runtime/cross-process/index.ts';
import { processStartTime } from '../../src/substrate/runtime/cross-process/liveness.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tempRoots: Array<string> = [];

const makeTempRoot = (prefix: string): string => {
	const root = mkdtempSync(join(packageRoot, `.tmp-${prefix}-`));
	tempRoots.push(root);
	return root;
};

const writeCodegenConfig = (appRoot: string, stackName = 'main'): string => {
	const configPath = join(appRoot, 'devstack.config.ts');
	writeFileSync(
		configPath,
		`
import { Effect } from 'effect';
import {
\tdefineDevstack,
\tdefinePlugin,
\tPluginContext,
} from '@mysten-incubation/devstack';

const cliApplyCodegenPlugin = definePlugin({
\tid: 'test/cli-apply-codegen',
\trole: 'service',
\tsection: 'service',
\tstart: () =>
\t\tEffect.gen(function* () {
\t\t\tconst ctx = yield* PluginContext;
\t\t\tconst value = { message: 'from-cli-apply' } as const;
\t\t\tctx.codegen({
\t\t\t\tkind: 'codegenable',
\t\t\t\temitterName: 'cli-apply-proof',
\t\t\t\toutputPath: 'cli-apply-proof.ts',
\t\t\t\tsensitive: false,
\t\t\t\temit: (emit) =>
\t\t\t\t\tEffect.sync(() => {
\t\t\t\t\t\temit.exportConst('cliApplyProof', value);
\t\t\t\t\t\treturn emit.done();
\t\t\t\t\t}),
\t\t\t});
\t\t\treturn value;
\t\t}),
});

export default defineDevstack({ members: [cliApplyCodegenPlugin], stackName: '${stackName}' });
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

/** Writes a minimal on-disk manifest at `<stackRoot>/manifest.json` — the
 *  durable record the offline `status` projects when the stack is down.
 *  The manifest identity tuple is `{ app, stack, network }`; the degraded
 *  status carries `network` onto the projection's `network`. Endpoints are
 *  seeded so the status output can assert the endpoint slice survives offline. */
const seedManifest = (
	stackRoot: string,
	params: {
		readonly app: string;
		readonly stack: string;
		readonly network: string;
		readonly endpoints?: Readonly<
			Record<
				string,
				{
					readonly name: string;
					readonly url: string;
					readonly displayUrl: string | null;
					readonly wireProtocol: 'http' | 'h2c' | 'tcp';
					readonly pluginKey: string;
					readonly endpointKey: string;
				}
			>
		>;
	},
): void => {
	mkdirSync(stackRoot, { recursive: true });
	writeFileSync(
		join(stackRoot, 'manifest.json'),
		JSON.stringify({
			identity: { app: params.app, stack: params.stack, network: params.network },
			manifestVersion: 1,
			endpoints: params.endpoints ?? {},
			extras: {},
		}),
		'utf8',
	);
};

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
				network: 'localnet',
				graphInput: {
					version: SNAPSHOT_GRAPH_INPUT_VERSION,
					graphInputId: 'graph-fixture',
					nodes: [],
				},
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
	// This baseline snapshot records no host-tree / deploy-cache subtrees, so the
	// restore cache preflight (now checked against the SNAPSHOT, not the live
	// stack) has nothing to verify and passes. The live cache seed below is left
	// as a harmless realistic fixture (a deployed stack would have one).
	mkdirSync(join(stackRoot, CACHE_DIR_NAME, DEPLOY_CACHE_NAMESPACES[0]!), { recursive: true });
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
				network: 'localnet',
				graphInput: {
					version: SNAPSHOT_GRAPH_INPUT_VERSION,
					graphInputId: 'graph-fixture',
					nodes: [],
				},
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
): ReadonlyArray<{
	readonly command: { readonly tag: string; readonly snapshotId?: string; readonly name?: string };
}> =>
	readFileSync(join(stackRoot, COMMAND_CHANNEL_COMMANDS_FILE_NAME), 'utf8')
		.trim()
		.split('\n')
		.flatMap((line) =>
			line === ''
				? []
				: [
						JSON.parse(line) as {
							readonly command: {
								readonly tag: string;
								readonly snapshotId?: string;
								readonly name?: string;
							};
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

	it('apply publishes to a live supervisor instead of starting a second one-shot stack', async () => {
		const appRoot = makeTempRoot('cli-live-apply-app');
		const stateRoot = makeTempRoot('cli-live-apply-state');
		const configPath = writeCodegenConfig(appRoot);
		const stackRoot = join(stateRoot, 'stacks', 'main');
		const generatedPath = join(appRoot, 'src', 'generated', 'cli-apply-proof.ts');
		const observed: Array<{ readonly tag?: string }> = [];
		const previousExitCode = process.exitCode;
		const previousEnv = {
			DEVSTACK_APP: process.env.DEVSTACK_APP,
			DEVSTACK_STACK: process.env.DEVSTACK_STACK,
			DEVSTACK_NETWORK: process.env.DEVSTACK_NETWORK,
			DEVSTACK_STATE_DIR: process.env.DEVSTACK_STATE_DIR,
			DEVSTACK_CONFIG: process.env.DEVSTACK_CONFIG,
		};

		writeLiveRoster(stackRoot);
		const subscriberFiber = Effect.runFork(
			Effect.scoped(
				Effect.gen(function* () {
					const subscriber = yield* makeCommandChannelSubscriber(commandChannelPaths(stackRoot), {
						fromOffset: 'start',
						pollMillis: 20,
					});
					yield* subscriber.commands.pipe(
						Stream.take(1),
						Stream.runForEach((record) =>
							Effect.gen(function* () {
								yield* Effect.sync(() => {
									observed.push(record.command as { readonly tag?: string });
								});
								yield* subscriber.publishReply(record.id, { kind: 'ack', detail: 'applied' });
							}),
						),
					);
				}),
			),
		);

		try {
			process.exitCode = undefined;
			await new Promise((resolve) => setTimeout(resolve, 50));

			await runCli([
				'apply',
				'--config',
				configPath,
				'--state-dir',
				stateRoot,
				'--app',
				'cli-live-apply',
				'--stack',
				'main',
				'--network',
				'localnet',
			]);

			expect(process.exitCode).toBe(0);
			expect(observed).toEqual([{ tag: 'apply.requested' }]);
			expect(readCommandLog(stackRoot).map((record) => record.command.tag)).toEqual([
				'apply.requested',
			]);
			expect(existsSync(generatedPath)).toBe(false);
		} finally {
			process.exitCode = previousExitCode;
			for (const [key, value] of Object.entries(previousEnv)) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await Effect.runPromise(Fiber.interrupt(subscriberFiber));
		}
	}, 60_000);

	it('status defaults runtime state to cwd-local .devstack', async () => {
		const appRoot = makeTempRoot('cli-default-state-app');
		const homeRoot = makeTempRoot('cli-default-state-home');
		const stackRoot = join(appRoot, '.devstack', 'stacks', 'main');
		const previousExitCode = process.exitCode;
		const previousCwd = process.cwd();
		const previousEnv = {
			DEVSTACK_APP: process.env.DEVSTACK_APP,
			DEVSTACK_STACK: process.env.DEVSTACK_STACK,
			DEVSTACK_NETWORK: process.env.DEVSTACK_NETWORK,
			DEVSTACK_STATE_DIR: process.env.DEVSTACK_STATE_DIR,
			DEVSTACK_CONFIG: process.env.DEVSTACK_CONFIG,
			HOME: process.env.HOME,
		};
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
			delete process.env.DEVSTACK_APP;
			delete process.env.DEVSTACK_STACK;
			delete process.env.DEVSTACK_NETWORK;
			delete process.env.DEVSTACK_STATE_DIR;
			delete process.env.DEVSTACK_CONFIG;
			process.env.HOME = homeRoot;
			process.chdir(appRoot);
			// Offline status now projects the on-disk MANIFEST (the projection
			// twin was deleted). Seed a manifest with one endpoint at the
			// cwd-local `.devstack/stacks/main` location.
			seedManifest(stackRoot, {
				app: 'local-app',
				stack: 'main',
				network: 'localnet',
				endpoints: {
					'rpc#0:rpc': {
						name: 'rpc',
						url: 'http://127.0.0.1:9000',
						displayUrl: null,
						wireProtocol: 'http',
						pluginKey: 'rpc#0',
						endpointKey: 'rpc#0:rpc',
					},
				},
			});

			await runCli(['status', '--app', 'local-app', '--stack', 'main', '--json']);

			expect(stderr.join('')).toBe('');
			expect(process.exitCode).toBe(0);
			const envelope = JSON.parse(stdout.join('')) as {
				readonly ok: true;
				readonly data: {
					readonly present: boolean;
					readonly identity: unknown;
					readonly rowCount: number;
					readonly accountCount: number;
					readonly packageCount: number;
					readonly endpoints: ReadonlyArray<{ readonly name: string; readonly url: string }>;
				};
			};
			expect(envelope.data.present).toBe(true);
			// Degraded offline status: identity + endpoints come from the
			// manifest; the live-only slices (rows/accounts/packages) are empty.
			expect(envelope.data.identity).toEqual({
				app: 'local-app',
				stack: 'main',
				network: 'localnet',
			});
			expect(envelope.data.rowCount).toBe(0);
			expect(envelope.data.accountCount).toBe(0);
			expect(envelope.data.packageCount).toBe(0);
			expect(envelope.data.endpoints).toEqual([
				{ endpointKey: 'rpc#0:rpc', name: 'rpc', url: 'http://127.0.0.1:9000' },
			]);
			expect(existsSync(join(homeRoot, '.devstack', 'stacks', 'main'))).toBe(false);
		} finally {
			process.chdir(previousCwd);
			process.exitCode = previousExitCode;
			for (const [key, value] of Object.entries(previousEnv)) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it('snapshot save publishes to a live supervisor and waits for capture result', async () => {
		const stateRoot = makeTempRoot('cli-live-snapshot-state');
		const stackRoot = join(stateRoot, 'stacks', 'alpha');
		const observed: Array<{
			readonly tag?: string;
			readonly snapshotId?: string;
			readonly name?: string;
		}> = [];
		const previousExitCode = process.exitCode;
		const stdout: Array<string> = [];
		const stderr: Array<string> = [];
		const stdoutSpy = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(captureProcessWrite(stdout));
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(captureProcessWrite(stderr));

		writeLiveRoster(stackRoot);
		const subscriberFiber = Effect.runFork(
			Effect.scoped(
				Effect.gen(function* () {
					const subscriber = yield* makeCommandChannelSubscriber(commandChannelPaths(stackRoot), {
						fromOffset: 'start',
						pollMillis: 20,
					});
					yield* subscriber.commands.pipe(
						Stream.take(1),
						Stream.runForEach((record) =>
							Effect.gen(function* () {
								const command = record.command as {
									readonly tag?: string;
									readonly snapshotId?: string;
									readonly name?: string;
								};
								yield* Effect.sync(() => {
									observed.push(command);
								});
								if (command.snapshotId !== undefined) {
									yield* subscriber.publishEvent({
										tag: 'snapshot.captured',
										snapshotId: command.snapshotId,
										...(command.name === undefined ? {} : { name: command.name }),
										at: Date.now(),
									});
								}
								yield* subscriber.publishReply(record.id, {
									kind: 'ack',
									detail: 'captured',
									payload: {
										kind: 'captured',
										snapshotId: command.snapshotId,
										...(command.name === undefined ? {} : { name: command.name }),
									},
								});
							}),
						),
					);
				}),
			),
		);

		try {
			process.exitCode = undefined;
			await new Promise((resolve) => setTimeout(resolve, 50));

			await runCli([
				'snapshot',
				'save',
				'seeded',
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
			expect(observed).toHaveLength(1);
			expect(observed[0]?.tag).toBe('snapshot.capture');
			expect(observed[0]?.name).toBe('seeded');
			expect(observed[0]?.snapshotId).toMatch(/^snap-\d+-[0-9a-f]{8}$/);
			expect(readCommandLog(stackRoot).map((record) => record.command.tag)).toEqual([
				'snapshot.capture',
			]);
			const envelope = JSON.parse(stdout.join('')) as {
				readonly ok: true;
				readonly data: { readonly snapshotId: string; readonly name: string };
			};
			expect(envelope.data).toEqual({
				snapshotId: observed[0]?.snapshotId,
				name: 'seeded',
			});
		} finally {
			process.exitCode = previousExitCode;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
			await Effect.runPromise(Fiber.interrupt(subscriberFiber));
		}
	}, 60_000);

	it('snapshot save: explicit --stack overrides config stackName', async () => {
		const appRoot = makeTempRoot('cli-live-snapshot-config-app');
		const stateRoot = makeTempRoot('cli-live-snapshot-config-state');
		const configPath = writeCodegenConfig(appRoot, 'config-stack');
		const cliStackRoot = join(stateRoot, 'stacks', 'cli-stack');
		const configStackRoot = join(stateRoot, 'stacks', 'config-stack');
		const observed: Array<{
			readonly tag?: string;
			readonly snapshotId?: string;
			readonly name?: string;
		}> = [];
		const previousExitCode = process.exitCode;
		const stdout: Array<string> = [];
		const stderr: Array<string> = [];
		const stdoutSpy = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(captureProcessWrite(stdout));
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(captureProcessWrite(stderr));

		// Live supervisor lives on the EXPLICIT --stack (cli-stack). Under the
		// corrected precedence (explicit flag/env > config stackName), the verb
		// must target cli-stack, NOT the config-declared config-stack.
		writeLiveRoster(cliStackRoot);
		const subscriberFiber = Effect.runFork(
			Effect.scoped(
				Effect.gen(function* () {
					const subscriber = yield* makeCommandChannelSubscriber(
						commandChannelPaths(cliStackRoot),
						{
							fromOffset: 'start',
							pollMillis: 20,
						},
					);
					yield* subscriber.commands.pipe(
						Stream.take(1),
						Stream.runForEach((record) =>
							Effect.gen(function* () {
								const command = record.command as {
									readonly tag?: string;
									readonly snapshotId?: string;
									readonly name?: string;
								};
								yield* Effect.sync(() => {
									observed.push(command);
								});
								if (command.snapshotId !== undefined) {
									yield* subscriber.publishEvent({
										tag: 'snapshot.captured',
										snapshotId: command.snapshotId,
										...(command.name === undefined ? {} : { name: command.name }),
										at: Date.now(),
									});
								}
								yield* subscriber.publishReply(record.id, {
									kind: 'ack',
									detail: 'captured',
									payload: {
										kind: 'captured',
										snapshotId: command.snapshotId,
										...(command.name === undefined ? {} : { name: command.name }),
									},
								});
							}),
						),
					);
				}),
			),
		);

		try {
			process.exitCode = undefined;
			await new Promise((resolve) => setTimeout(resolve, 50));

			await runCli([
				'snapshot',
				'save',
				'seeded',
				'--config',
				configPath,
				'--state-dir',
				stateRoot,
				'--app',
				'labeled-app',
				'--stack',
				'cli-stack',
				'--json',
			]);

			expect(process.exitCode).toBe(0);
			expect(stderr.join('')).toBe('');
			expect(observed).toHaveLength(1);
			expect(observed[0]?.tag).toBe('snapshot.capture');
			expect(observed[0]?.name).toBe('seeded');
			expect(readCommandLog(cliStackRoot).map((record) => record.command.tag)).toEqual([
				'snapshot.capture',
			]);
			expect(existsSync(join(configStackRoot, COMMAND_CHANNEL_COMMANDS_FILE_NAME))).toBe(false);
		} finally {
			process.exitCode = previousExitCode;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
			await Effect.runPromise(Fiber.interrupt(subscriberFiber));
		}
	}, 60_000);

	it('apply infers app and stack identity from the config package when omitted', async () => {
		const appRoot = makeTempRoot('cli-identity-app');
		const stateRoot = makeTempRoot('cli-identity-state');
		writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: '@org/inferred-cli-app' }));
		const configPath = join(appRoot, 'devstack.config.ts');
		writeFileSync(
			configPath,
			`
import { Effect } from 'effect';
import { defineDevstack } from '../src/api/define-devstack.ts';
import { definePlugin } from '../src/api/define-plugin.ts';
import { PluginContext } from '../src/substrate/plugin-ctx.ts';

const cliApplyCodegenPlugin = definePlugin({
\tid: 'test/cli-identity-codegen',
\trole: 'service',
\tsection: 'service',
\tstart: () =>
\t\tEffect.gen(function* () {
\t\t\tconst ctx = yield* PluginContext;
\t\t\tconst value = { message: 'from-cli-identity' } as const;
\t\t\tctx.codegen({
\t\t\t\tkind: 'codegenable',
\t\t\t\temitterName: 'cli-identity-proof',
\t\t\t\toutputPath: 'cli-identity-proof.ts',
\t\t\t\tsensitive: false,
\t\t\t\temit: (emit) =>
\t\t\t\t\tEffect.sync(() => {
\t\t\t\t\t\temit.exportConst('cliIdentityProof', value);
\t\t\t\t\t\treturn emit.done();
\t\t\t\t\t}),
\t\t\t});
\t\t\treturn value;
\t\t}),
});

export default defineDevstack({ members: [cliApplyCodegenPlugin], stackName: 'main' });
`.trimStart(),
		);
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

			await runCli([
				'apply',
				'--config',
				configPath,
				'--state-dir',
				stateRoot,
				'--network',
				'localnet',
			]);

			expect(process.exitCode).toBe(0);
			// `apply` flushes the manifest during its one-shot boot. The
			// degraded status builder projects that manifest's identity
			// (carrying `network` onto `network`).
			const ctx = readStackContext({
				manifestPath: join(stateRoot, 'stacks', 'main', 'manifest.json'),
			});
			expect(degradedStatusFromContext(ctx).identity).toEqual({
				app: 'inferred-cli-app',
				stack: 'main',
				network: 'localnet',
			});
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

	it('status projects the on-disk manifest from the runtime stacks root', async () => {
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
			seedManifest(stackRoot, {
				app: 'labeled-app',
				stack: 'alpha',
				network: 'localnet',
			});

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
				network: 'localnet',
			});
		} finally {
			process.exitCode = previousExitCode;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it('status infers app and stack identity from the current package when omitted', async () => {
		const appRoot = makeTempRoot('cli-status-inferred-app');
		const stateRoot = makeTempRoot('cli-status-inferred-state');
		writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: '@org/connect-four' }));
		const previousExitCode = process.exitCode;
		const previousCwd = process.cwd();
		const previousEnv = {
			DEVSTACK_APP: process.env.DEVSTACK_APP,
			DEVSTACK_STACK: process.env.DEVSTACK_STACK,
			DEVSTACK_NETWORK: process.env.DEVSTACK_NETWORK,
			DEVSTACK_STATE_DIR: process.env.DEVSTACK_STATE_DIR,
			DEVSTACK_CONFIG: process.env.DEVSTACK_CONFIG,
		};
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
			delete process.env.DEVSTACK_APP;
			delete process.env.DEVSTACK_STACK;
			delete process.env.DEVSTACK_NETWORK;
			delete process.env.DEVSTACK_STATE_DIR;
			delete process.env.DEVSTACK_CONFIG;
			process.chdir(appRoot);

			await runCli(['status', '--state-dir', stateRoot]);

			expect(stderr.join('')).toBe('');
			expect(process.exitCode).toBe(0);
			expect(stdout.join('')).toContain('status: no state present for connect-four / connect-four');
		} finally {
			process.chdir(previousCwd);
			process.exitCode = previousExitCode;
			for (const [key, value] of Object.entries(previousEnv)) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
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
				'--yes',
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
				'--yes',
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
				readonly data: { readonly snapshotId: string; readonly name: string | null };
			};
			expect(envelope.data).toEqual({ snapshotId: 'baseline', name: 'workflow-baseline' });
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
				'--yes',
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
				readonly data: { readonly snapshotId: string; readonly name: string | null };
			};
			expect(envelope.data).toEqual({ snapshotId: 'baseline', name: 'workflow-baseline' });
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

	// Regression: `identityInputsFromArgv` must REJECT `--flag` with no
	// following value AND `--flag --next-flag` (where the next token looks
	// like a flag). Silently absorbing `--next-flag` as the value would
	// quietly demote a downstream flag, hiding a user typo.
	describe('identityInputsFromArgv', () => {
		it('throws when --app has no following value', () => {
			expect(() => identityInputsFromArgv(['--app'], {})).toThrow(/flag --app requires a value/);
		});

		it('throws when --stack is followed by another flag (typo guard)', () => {
			expect(() => identityInputsFromArgv(['--stack', '--network', 'localnet'], {})).toThrow(
				/flag --stack requires a value; got "--network" which looks like a flag/,
			);
		});

		it('accepts --name=value form even when next token is a flag', () => {
			const out = identityInputsFromArgv(['--stack=main', '--app', 'demo'], {});
			expect(out.stack).toBe('main');
			expect(out.app).toBe('demo');
		});

		it('falls back to env when neither --flag nor --flag=value is present', () => {
			const out = identityInputsFromArgv([], {
				DEVSTACK_APP: 'envapp',
				DEVSTACK_STACK: 'envstack',
			});
			expect(out.app).toBe('envapp');
			expect(out.stack).toBe('envstack');
		});
	});

	// Regression: a malformed `--network` value reaches `resolveIdentity`
	// -> `resolveNetworkSync`, which THROWS `DevstackNetworkParseError` (a
	// plain Error, not a CliError) OUTSIDE the argv pre-parse try/catch and
	// BEFORE dispatch. Without the in-`runCli` guard this escapes to the
	// bin entry's generic `.catch` (raw stderr, exit 1, no envelope),
	// violating the sysexits contract. `flags.test.ts` only exercises the
	// dispatcher's own `--network` validation via `dispatch()` directly, so
	// only a `runCli`-level assertion covers the real bin path.
	it('malformed --network exits USAGE (64) with a JSON envelope, not generic 1', async () => {
		const previousExitCode = process.exitCode;
		const previousNetwork = process.env.DEVSTACK_NETWORK;
		const previousJson = process.env.DEVSTACK_JSON;
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
			delete process.env.DEVSTACK_NETWORK;
			delete process.env.DEVSTACK_JSON;

			await runCli(['status', '--network', 'bogus', '--json']);

			// Exactly USAGE (64) — never the disallowed generic exit 1.
			expect(process.exitCode).toBe(64);
			// Envelope is on stdout, NOT a raw stderr line.
			expect(stderr.join('')).toBe('');
			const envelope = JSON.parse(stdout.join('')) as {
				readonly ok: false;
				readonly error: {
					readonly code: string;
					readonly exitCode: number;
					readonly summary: string;
				};
			};
			expect(envelope.ok).toBe(false);
			expect(envelope.error.code).toBe('USAGE');
			expect(envelope.error.exitCode).toBe(64);
			expect(envelope.error.summary).toContain('bogus');
		} finally {
			process.exitCode = previousExitCode;
			if (previousNetwork === undefined) delete process.env.DEVSTACK_NETWORK;
			else process.env.DEVSTACK_NETWORK = previousNetwork;
			if (previousJson === undefined) delete process.env.DEVSTACK_JSON;
			else process.env.DEVSTACK_JSON = previousJson;
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	// Regression for the Phase B3 fix: an attached supervisor receiving
	// `prune.requested` MUST dispatch to the lifecycle-prune orchestrator
	// (the same code path the offline `devstack prune` verb uses), NOT to
	// `params.snapshot.prune({})`. The snapshot-orchestrator prune only
	// cleans the snapshot catalog; routing prune.requested there would
	// silently leave stale containers/networks/volumes/images behind.
	//
	// The handler is a closed-over local in `cli/wirings/up.ts`, so this is
	// a static-text guard against accidental regression — same style as the
	// other source-level invariants pinned by `test/style/*`.
	it('attached prune.requested routes to runLifecyclePrune, never params.snapshot.prune', () => {
		// The attached supervisor command handler lives in `cli/wirings/up.ts`
		// (was inline in `cli/main.ts` before Phase 15).
		const up = readFileSync(join(packageRoot, 'src/cli/wirings/up.ts'), 'utf8');
		// Locate the IMPLEMENTATION switch case (`case 'prune.requested':`
		// inside `makeSnapshotCommandHandler`).
		const caseIdx = up.lastIndexOf("case 'prune.requested':");
		expect(caseIdx).toBeGreaterThan(0);
		// Capture the case body up to the next `case` or `default`.
		const tail = up.slice(caseIdx);
		const nextCase = tail.slice(1).search(/\n\s*(case |default:)/);
		const body = nextCase === -1 ? tail : tail.slice(0, nextCase + 1);
		// Must invoke the lifecycle-prune orchestrator.
		expect(body).toMatch(/runLifecyclePrune\s*\(/);
		expect(body).toMatch(/collectLifecyclePruneInventory\s*\(/);
		// Must NOT route to the snapshot-orchestrator prune.
		expect(body).not.toMatch(/params\.snapshot\.prune\b/);
	});
});
