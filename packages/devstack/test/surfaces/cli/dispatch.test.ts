// Top-level dispatcher tests.
//
// These pin the public CLI surface after the Stricli migration:
// attached lifecycle commands, direct/offline maintenance commands,
// command-scoped flags, and no public peer-command verbs.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import { makeSnapshotReader } from '../../../src/cli/snapshot-reader.ts';
import {
	SNAPSHOT_GRAPH_INPUT_VERSION,
	SNAPSHOT_META_VERSION,
	SnapshotLayout,
} from '../../../src/orchestrators/snapshot/index.ts';
import { dispatch, type CliDeps, type GlobalFlags } from '../../../src/surfaces/cli/index.ts';
import { CliNoSupervisorError } from '../../../src/surfaces/cli/errors.ts';
import type { CliIO } from '../../../src/surfaces/cli/output.ts';

interface Harness {
	readonly io: CliIO;
	readonly stdout: ReadonlyArray<string>;
	readonly stderr: ReadonlyArray<string>;
	readonly exitCode: number | null;
	readonly upRuns: ReadonlyArray<GlobalFlags>;
	readonly applyRuns: ReadonlyArray<GlobalFlags>;
	readonly captures: ReadonlyArray<{
		readonly snapshotId?: string;
		readonly name?: string;
		readonly configPath?: string;
	}>;
	readonly restores: ReadonlyArray<string>;
	readonly deletes: ReadonlyArray<string>;
	readonly confirmations: ReadonlyArray<{
		readonly verb: string;
		readonly prompt: string;
	}>;
	readonly pruneCalls: number;
	readonly pruneDryRuns: number;
	readonly pruneSelections: ReadonlyArray<{
		readonly groupKeys: ReadonlyArray<string>;
		readonly resources: {
			readonly containers: boolean;
			readonly networks: boolean;
			readonly volumes: boolean;
			readonly images: boolean;
		};
		readonly dryRun: boolean;
	}>;
	readonly wipeCalls: number;
}

interface HarnessOptions {
	readonly confirmResponses?: ReadonlyArray<boolean>;
}

const tempRoots: Array<string> = [];

const packageVersion = (): string => {
	const pkg = JSON.parse(
		readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
	) as {
		readonly version: string;
	};
	return pkg.version;
};

const makeHarness = (
	options: HarnessOptions = {},
): {
	deps: CliDeps;
	read: () => Harness;
} => {
	const stdout: Array<string> = [];
	const stderr: Array<string> = [];
	let exitCode: number | null = null;
	const upRuns: Array<GlobalFlags> = [];
	const applyRuns: Array<GlobalFlags> = [];
	const captures: Array<{
		snapshotId?: string;
		name?: string;
		configPath?: string;
	}> = [];
	const restores: Array<string> = [];
	const deletes: Array<string> = [];
	const confirmations: Array<{ readonly verb: string; readonly prompt: string }> = [];
	const confirmResponses = [...(options.confirmResponses ?? [])];
	let pruneCalls = 0;
	let pruneDryRuns = 0;
	const pruneSelections: Array<{
		readonly groupKeys: ReadonlyArray<string>;
		readonly resources: {
			readonly containers: boolean;
			readonly networks: boolean;
			readonly volumes: boolean;
			readonly images: boolean;
		};
		readonly dryRun: boolean;
	}> = [];
	let wipeCalls = 0;

	const io: CliIO = {
		writeStdout: (line) => Effect.sync(() => void stdout.push(line)),
		writeStderr: (line) => Effect.sync(() => void stderr.push(line)),
		setExitCode: (code) =>
			Effect.sync(() => {
				exitCode = code;
			}),
	};
	const confirm: CliDeps['wipe']['confirm'] = (input) =>
		Effect.sync(() => {
			confirmations.push(input);
			return confirmResponses.shift() ?? false;
		});

	const deps: CliDeps = {
		up: {
			run: (flags) =>
				Effect.sync(() => {
					upRuns.push(flags);
					return { exitCode: 0 };
				}),
		},
		apply: {
			run: (flags) =>
				Effect.sync(() => {
					applyRuns.push(flags);
					return { exitCode: 0 };
				}),
		},
		codegen: {
			run: () => Effect.sync(() => ({ exitCode: 0 })),
		},
		status: {
			reader: { readState: () => Effect.succeed(null) },
		},
		snapshot: {
			reader: {
				list: () => Effect.succeed([]),
				resolve: () => Effect.succeed({ tag: 'not-found' }),
			},
			capture: (args) =>
				Effect.sync(() => {
					captures.push(args);
					return {
						snapshotId: args.snapshotId ?? 'generated-snapshot-id',
						name: args.name ?? 'manual-generated',
					};
				}),
			restore: (snapshotId) =>
				Effect.sync(() => {
					restores.push(snapshotId);
				}),
			delete: (snapshotId) =>
				Effect.sync(() => {
					deletes.push(snapshotId);
				}),
			confirm,
		},
		prune: {
			inventory: () =>
				Effect.succeed({
					groups: [
						{
							key: 'arena/main',
							app: 'arena',
							stack: 'main',
							live: false,
							livePids: [],
							shared: false,
							sharedKind: null,
							autoPrunable: true,
							containers: 2,
							runningContainers: 0,
							networks: 1,
							volumes: 1,
							images: 3,
						},
						{
							key: 'wallet/main',
							app: 'wallet',
							stack: 'main',
							live: true,
							livePids: [123],
							shared: false,
							sharedKind: null,
							autoPrunable: false,
							containers: 1,
							runningContainers: 1,
							networks: 1,
							volumes: 0,
							images: 1,
						},
					],
					totals: {
						groups: 2,
						liveGroups: 1,
						sharedGroups: 0,
						containers: 3,
						runningContainers: 1,
						networks: 2,
						volumes: 1,
						images: 4,
					},
				}),
			prune: (selection) =>
				Effect.sync(() => {
					pruneCalls += 1;
					if (selection.dryRun) pruneDryRuns += 1;
					pruneSelections.push(selection);
					return {
						kind: 'completed' as const,
						summary: {
							inspectedGroups: 2,
							selectedGroups: selection.groupKeys.length,
							skippedLiveGroups: 1,
							containersRemoved: selection.resources.containers ? 2 : 0,
							networksRemoved: selection.resources.networks ? 1 : 0,
							networksSkipped: 0,
							volumesRemoved: selection.resources.volumes ? 1 : 0,
							imagesRemoved: selection.resources.images ? 3 : 0,
							foreignNetworkHolders: [],
							staleNetworkEndpoints: [],
						},
					};
				}),
			select: (_inventory, resources) => Effect.succeed({ groupKeys: ['arena/main'], resources }),
		},
		doctor: { probes: [] },
		config: {
			loader: {
				load: () =>
					Effect.succeed({
						stack: { _tag: 'Stack' },
						resolvedConfigPath: '/tmp/devstack.config.ts',
					} as never),
			},
		},
		wipe: {
			wipe: () =>
				Effect.sync(() => {
					wipeCalls += 1;
				}),
			confirm,
		},
	};

	return {
		deps,
		read: () => ({
			io,
			stdout,
			stderr,
			exitCode,
			upRuns,
			applyRuns,
			captures,
			restores,
			deletes,
			confirmations,
			pruneCalls,
			pruneDryRuns,
			pruneSelections,
			wipeCalls,
		}),
	};
};

const run = async (
	argv: ReadonlyArray<string>,
	deps: CliDeps,
	h: { io: CliIO },
	options: {
		readonly stdinIsTty?: boolean;
		readonly env?: Record<string, string | undefined>;
	} = {},
) => {
	await Effect.runPromise(
		dispatch(deps, {
			argv,
			env: options.env ?? {},
			stdinIsTty: options.stdinIsTty ?? true,
			io: h.io,
		}),
	);
};

const makeSnapshotCatalog = () => {
	const stackRoot = mkdtempSync(join(tmpdir(), 'devstack-cli-snapshot-'));
	tempRoots.push(stackRoot);
	const snapshotId = 'dir-canonical';
	const metadataId = 'meta-wrong';
	const snapshotDir = join(stackRoot, 'snapshots', snapshotId);
	mkdirSync(snapshotDir, { recursive: true });
	writeFileSync(
		join(snapshotDir, SnapshotLayout.metaFile),
		JSON.stringify(
			{
				version: SNAPSHOT_META_VERSION,
				id: metadataId,
				label: 'friendly-name',
				createdAt: 1_700_000_000_000,
				app: 'app',
				stack: 'main',
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
	return { stackRoot, snapshotId, metadataId };
};

describe('dispatch', () => {
	afterEach(() => {
		for (const root of tempRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('unknown verb uses EX_USAGE', async () => {
		const { deps, read } = makeHarness();
		await run(['frobnicate'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(64);
		expect(h.stderr.join('\n')).toMatch(/No command registered/);
	});

	it('reports the package version', async () => {
		const { deps, read } = makeHarness();
		await run(['--version'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(h.stdout.join('\n')).toContain(packageVersion());
		expect(h.stderr).toHaveLength(0);
	});

	it('unknown verb honors json output when requested before the verb', async () => {
		const { deps, read } = makeHarness();
		await run(['--json', 'frobnicate'], deps, { io: read().io });
		const h = read();
		expect(h.stdout).toHaveLength(1);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.ok).toBe(false);
		expect(env.error.code).toBe('USAGE');
		expect(env.error.exitCode).toBe(64);
		expect(h.stderr).toHaveLength(0);
	});

	it('removed peer commands are not public routes', async () => {
		for (const verb of ['down', 'logs', 'exec', 'fork', 'stack']) {
			const { deps, read } = makeHarness();
			await run([verb], deps, { io: read().io });
			const h = read();
			expect(h.exitCode).toBe(64);
			expect(h.stderr.join('\n')).toMatch(/No command registered/);
		}
	});

	it('accepts fork networks at the CLI boundary', async () => {
		const { deps, read } = makeHarness();
		await run(['apply', '--network', 'mainnet-fork'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(h.stderr).toHaveLength(0);
		expect(h.applyRuns).toHaveLength(1);
		expect(h.applyRuns[0]!.network).toBe('mainnet-fork');
	});

	it('restores process.env[DEVSTACK_NETWORK] after each invocation', async () => {
		// Guards the documented bridge: `setNetworkEnv` mutates
		// `process.env.DEVSTACK_NETWORK` so the deepbook factory's
		// config-load-time env read picks up `--network`. The scoped
		// finalizer must restore the prior value (or unset it) so
		// concurrent CLI invocations in the same process — tests,
		// embedded harnesses — do not leak network state to siblings.
		const KEY = 'DEVSTACK_NETWORK';
		const prior = process.env[KEY];
		delete process.env[KEY];
		try {
			// Invocation 1: --network=testnet mutates the env for the
			// duration of the command, then must restore (unset).
			const first = makeHarness();
			await run(['apply', '--network', 'testnet'], first.deps, { io: first.read().io });
			expect(first.read().exitCode).toBe(0);
			expect(process.env[KEY]).toBeUndefined();

			// Invocation 2: no --network flag, no env preset.
			// `flags.network` should be undefined inside the command —
			// proving the prior invocation did not leak.
			const second = makeHarness();
			await run(['apply'], second.deps, { io: second.read().io });
			expect(second.read().exitCode).toBe(0);
			expect(second.read().applyRuns[0]!.network).toBeUndefined();
			expect(process.env[KEY]).toBeUndefined();

			// Invocation 3: a prior value must be restored (not deleted).
			process.env[KEY] = 'localnet';
			const third = makeHarness();
			await run(['apply', '--network', 'testnet'], third.deps, { io: third.read().io });
			expect(third.read().exitCode).toBe(0);
			expect(process.env[KEY]).toBe('localnet');
		} finally {
			if (prior === undefined) delete process.env[KEY];
			else process.env[KEY] = prior;
		}
	});

	it('restores process.env[DEVSTACK_NETWORK] when the wrapped command FAILS', async () => {
		// The `setNetworkEnv` restore is registered via `Effect.addFinalizer`
		// inside `Effect.scoped` (surfaces/cli/index.ts), so the prior value
		// must be restored on the FAILURE path too — not just on success.
		// A leaked `--network` from a failed invocation would poison a
		// sibling invocation in the same process (tests / embedded harness).
		const KEY = 'DEVSTACK_NETWORK';
		const prior = process.env[KEY];
		try {
			process.env[KEY] = 'localnet';
			const { deps, read } = makeHarness();
			// Force the wrapped command effect to fail while `--network` is set.
			const failingDeps: CliDeps = {
				...deps,
				apply: {
					run: () => Effect.fail(new CliNoSupervisorError({ app: 'a', stack: 's' })),
				},
			};
			await run(['apply', '--network', 'testnet'], failingDeps, { io: read().io });
			// The command failed (non-zero exit) AND the prior env was restored.
			expect(read().exitCode).not.toBe(0);
			expect(process.env[KEY]).toBe('localnet');
		} finally {
			if (prior === undefined) delete process.env[KEY];
			else process.env[KEY] = prior;
		}
	});

	it('lifecycle commands run through attached/direct deps', async () => {
		const { deps, read } = makeHarness();
		await run(['up', '--renderer', 'plain', '--config', 'devstack.ci.ts'], deps, {
			io: read().io,
		});
		await run(['apply', '--config', 'devstack.ci.ts'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(h.upRuns).toHaveLength(1);
		expect(h.upRuns[0]!.renderer).toBe('plain');
		expect(h.upRuns[0]!.configPath).toBe('devstack.ci.ts');
		expect(h.applyRuns).toHaveLength(1);
		expect(h.applyRuns[0]!.configPath).toBe('devstack.ci.ts');
	});

	it('command-scoped flags reject flags on commands that do not own them', async () => {
		for (const argv of [
			['status', '--yes'],
			['apply', '--renderer', 'plain'],
			['up', '--dry-run'],
			['snapshot', 'restore', 'baseline', '--config', 'devstack.ci.ts'],
		]) {
			const { deps, read } = makeHarness();
			await run(argv, deps, { io: read().io });
			const h = read();
			expect(h.exitCode).toBe(64);
			expect(h.stderr.join('\n')).toMatch(/flag|argument|Unexpected/i);
			expect(h.upRuns).toHaveLength(0);
			expect(h.applyRuns).toHaveLength(0);
		}
	});

	it('status tolerates a missing projection', async () => {
		const { deps, read } = makeHarness();
		await run(['status', '--json'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.ok).toBe(true);
		expect(env.data.present).toBe(false);
	});

	it('global-looking json before a known verb fails before routing', async () => {
		const { deps, read } = makeHarness();
		await run(['--json', 'status'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(64);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.error.summary).toContain('No command registered for `--json`');
	});

	it('snapshot list with no entries succeeds', async () => {
		const { deps, read } = makeHarness();
		await run(['snapshot', 'list', '--json'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.data.entries).toEqual([]);
	});

	it('snapshot save invokes direct capture with command-scoped name', async () => {
		const { deps, read } = makeHarness();
		await run(['snapshot', 'save', 'seeded', '--config', 'devstack.ci.ts', '--json'], deps, {
			io: read().io,
		});
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(h.captures).toEqual([{ name: 'seeded', configPath: 'devstack.ci.ts' }]);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.data).toEqual({ snapshotId: 'generated-snapshot-id', name: 'seeded' });
	});

	it('snapshot save preserves typed direct failures', async () => {
		const { deps, read } = makeHarness();
		const depsWithNoSupervisor: CliDeps = {
			...deps,
			snapshot: {
				...deps.snapshot,
				capture: () =>
					Effect.fail(
						new CliNoSupervisorError({
							app: 'devstack',
							stack: 'deepbook-trader',
							hint: 'start the stack with `devstack up` first',
						}),
					),
			},
		};
		await run(['snapshot', 'save', 'baseline', '--json'], depsWithNoSupervisor, {
			io: read().io,
		});
		const h = read();
		expect(h.exitCode).toBe(69);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.error.summary).toContain('no supervisor running for devstack/deepbook-trader');
		expect(env.error.summary).not.toContain('snapshot capture failed');
	});

	it('snapshot list keeps the artifact directory id canonical when metadata id differs', async () => {
		const { deps, read } = makeHarness();
		const catalog = makeSnapshotCatalog();
		const depsWithCatalog: CliDeps = {
			...deps,
			snapshot: {
				...deps.snapshot,
				reader: makeSnapshotReader({ stackRoot: catalog.stackRoot }),
			},
		};
		await run(['snapshot', 'list', '--json'], depsWithCatalog, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.data.entries).toEqual([
			{
				snapshotId: catalog.snapshotId,
				name: 'friendly-name',
				createdAt: 1_700_000_000_000,
				size: null,
			},
		]);
		expect(JSON.stringify(env.data.entries)).not.toContain(catalog.metadataId);
	});

	it('snapshot restore and delete resolve names to artifact directory ids', async () => {
		const { deps, read } = makeHarness();
		const catalog = makeSnapshotCatalog();
		const depsWithCatalog: CliDeps = {
			...deps,
			snapshot: {
				...deps.snapshot,
				reader: makeSnapshotReader({ stackRoot: catalog.stackRoot }),
			},
		};
		await run(['snapshot', 'restore', 'friendly-name', '--yes', '--json'], depsWithCatalog, {
			io: read().io,
		});
		await run(['snapshot', 'delete', 'friendly-name', '--yes', '--json'], depsWithCatalog, {
			io: read().io,
		});
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(h.restores).toEqual([catalog.snapshotId]);
		expect(h.deletes).toEqual([catalog.snapshotId]);
		expect(JSON.parse(h.stdout[0]!).data.snapshotId).toBe(catalog.snapshotId);
		expect(JSON.parse(h.stdout[1]!).data.snapshotId).toBe(catalog.snapshotId);
	});

	it('snapshot restore and delete require confirmation before mutating', async () => {
		const { deps, read } = makeHarness({ confirmResponses: [true, false] });
		const catalog = makeSnapshotCatalog();
		const depsWithCatalog: CliDeps = {
			...deps,
			snapshot: {
				...deps.snapshot,
				reader: makeSnapshotReader({ stackRoot: catalog.stackRoot }),
			},
		};

		await run(['snapshot', 'restore', 'friendly-name', '--json'], depsWithCatalog, {
			io: read().io,
		});
		await run(['snapshot', 'delete', 'friendly-name', '--json'], depsWithCatalog, {
			io: read().io,
		});

		const h = read();
		expect(h.exitCode).toBe(43);
		expect(h.confirmations.map((prompt) => prompt.verb)).toEqual([
			'snapshot restore',
			'snapshot delete',
		]);
		expect(h.confirmations[0]?.prompt).toContain(catalog.snapshotId);
		expect(h.restores).toEqual([catalog.snapshotId]);
		expect(h.deletes).toEqual([]);
		expect(JSON.parse(h.stdout[0]!).ok).toBe(true);
		expect(JSON.parse(h.stdout[1]!).error.summary).toContain(
			'snapshot delete confirmation declined',
		);
	});

	it('snapshot restore and delete require --yes when prompts are unavailable', async () => {
		const { deps, read } = makeHarness();
		const catalog = makeSnapshotCatalog();
		const depsWithCatalog: CliDeps = {
			...deps,
			snapshot: {
				...deps.snapshot,
				reader: makeSnapshotReader({ stackRoot: catalog.stackRoot }),
			},
		};

		await run(
			['snapshot', 'restore', 'friendly-name', '--json'],
			depsWithCatalog,
			{
				io: read().io,
			},
			{ stdinIsTty: false },
		);

		const h = read();
		expect(h.exitCode).toBe(43);
		expect(h.confirmations).toEqual([]);
		expect(h.restores).toEqual([]);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.error.code).toBe('CONFIRM_REQUIRED');
		expect(env.error.summary).toContain('snapshot restore requires confirmation');
	});

	it('snapshot restore refuses ambiguous names', async () => {
		const { deps, read } = makeHarness();
		const catalog = makeSnapshotCatalog();
		const duplicateId = 'dir-duplicate';
		const duplicateDir = join(catalog.stackRoot, 'snapshots', duplicateId);
		mkdirSync(duplicateDir, { recursive: true });
		writeFileSync(
			join(duplicateDir, SnapshotLayout.metaFile),
			JSON.stringify(
				{
					version: SNAPSHOT_META_VERSION,
					id: duplicateId,
					label: 'friendly-name',
					createdAt: 1_700_000_001_000,
					app: 'app',
					stack: 'main',
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
		const depsWithCatalog: CliDeps = {
			...deps,
			snapshot: {
				...deps.snapshot,
				reader: makeSnapshotReader({ stackRoot: catalog.stackRoot }),
			},
		};

		await run(['snapshot', 'restore', 'friendly-name', '--json'], depsWithCatalog, {
			io: read().io,
		});

		const h = read();
		expect(h.exitCode).toBe(64);
		expect(h.restores).toEqual([]);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.error.summary).toContain('snapshot reference is ambiguous: friendly-name');
		expect(env.error.hint).toContain(catalog.snapshotId);
		expect(env.error.hint).toContain(duplicateId);
	});

	it('schema emits the curated command set', async () => {
		const { deps, read } = makeHarness();
		await run(['schema', '--json'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		const envelope = JSON.parse(h.stdout[0]!);
		expect(envelope.ok).toBe(true);
		expect(envelope.command).toBe('schema');
		const schema = envelope.data;
		expect(schema.verbs).toEqual([
			'up',
			'apply',
			'codegen',
			'status',
			'doctor',
			'config',
			'schema',
			'snapshot',
			'prune',
			'wipe',
		]);
		expect(schema.verbs).not.toContain('down');
		expect(schema.verbs).not.toContain('logs');
		expect(schema.verbs).not.toContain('exec');
		expect(
			schema.commands.subcommands.find((c: { name: string }) => c.name === 'snapshot'),
		).toMatchObject({
			name: 'snapshot',
			subcommands: expect.arrayContaining([expect.objectContaining({ name: 'restore' })]),
		});
	});

	it('top-level and nested help do not execute command deps', async () => {
		const { deps, read } = makeHarness();
		await run(['--help'], deps, { io: read().io });
		await run(['snapshot', '--help'], deps, { io: read().io });
		await run(['snapshot', 'restore', '--help'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(h.stdout.join('\n')).toContain('devstack');
		expect(h.stdout.join('\n')).toContain('snapshot');
		expect(h.upRuns).toHaveLength(0);
		expect(h.applyRuns).toHaveLength(0);
		expect(h.captures).toHaveLength(0);
	});

	it('prune confirmation and dry-run are local to the prune command', async () => {
		const { deps, read } = makeHarness();
		await run(['prune', '--json'], deps, { io: read().io }, { stdinIsTty: false });
		let h = read();
		expect(h.exitCode).toBe(43);
		expect(JSON.parse(h.stdout[0]!).error.code).toBe('CONFIRM_REQUIRED');
		expect(h.pruneCalls).toBe(0);

		await run(['prune', '--dry-run', '--json'], deps, { io: read().io }, { stdinIsTty: false });
		h = read();
		expect(h.exitCode).toBe(0);
		expect(JSON.parse(h.stdout[1]!).dryRun).toBe(true);
		expect(h.pruneCalls).toBe(1);
		expect(h.pruneDryRuns).toBe(1);
		expect(h.pruneSelections[0]?.resources).toEqual({
			containers: true,
			networks: true,
			volumes: true,
			images: false,
		});

		await run(['prune', '--yes', '--json'], deps, { io: read().io });
		h = read();
		expect(h.exitCode).toBe(0);
		expect(h.pruneCalls).toBe(2);
		expect(JSON.parse(h.stdout[2]!).data.outcome.summary.containersRemoved).toBe(2);
	});

	it('prune resource flags flow into the selected removal scope', async () => {
		const { deps, read } = makeHarness();
		await run(
			['prune', '--dry-run', '--include-images', '--no-networks', '--json'],
			deps,
			{ io: read().io },
			{ stdinIsTty: false },
		);
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(h.pruneSelections).toHaveLength(1);
		expect(h.pruneSelections[0]?.resources).toEqual({
			containers: true,
			networks: false,
			volumes: true,
			images: true,
		});
		const payload = JSON.parse(h.stdout[0]!);
		expect(payload.data.outcome.summary.networksRemoved).toBe(0);
		expect(payload.data.outcome.summary.imagesRemoved).toBe(3);
	});

	it('prune --list prints inventory without pruning', async () => {
		const { deps, read } = makeHarness();
		await run(['prune', '--list', '--json'], deps, { io: read().io }, { stdinIsTty: false });
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(h.pruneCalls).toBe(0);
		const payload = JSON.parse(h.stdout[0]!);
		expect(payload.data.inventory.totals.groups).toBe(2);
		expect(payload.data.inventory.groups[0].key).toBe('arena/main');
	});

	it('prune inventory is not scoped by active app or stack env defaults', async () => {
		const { deps, read } = makeHarness();
		await run(
			['prune', '--list', '--json'],
			deps,
			{ io: read().io },
			{
				stdinIsTty: false,
				env: {
					DEVSTACK_APP: 'arena',
					DEVSTACK_STACK: 'main',
				},
			},
		);
		const h = read();
		expect(h.exitCode).toBe(0);
		const payload = JSON.parse(h.stdout[0]!);
		expect(payload.data.inventory.groups.map((group: { key: string }) => group.key)).toEqual([
			'arena/main',
			'wallet/main',
		]);
	});

	it('wipe has the same destructive command-scoped contract', async () => {
		const { deps, read } = makeHarness({ confirmResponses: [true] });
		await run(['wipe', '--dry-run', '--json'], deps, { io: read().io }, { stdinIsTty: false });
		await run(['wipe', '--json'], deps, { io: read().io });
		await run(['wipe', '--yes', '--json'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(JSON.parse(h.stdout[0]!).dryRun).toBe(true);
		expect(h.confirmations.map((prompt) => prompt.verb)).toEqual(['wipe']);
		expect(h.wipeCalls).toBe(2);
	});

	it('wipe requires --yes when prompts are unavailable', async () => {
		const { deps, read } = makeHarness();
		await run(['wipe', '--json'], deps, { io: read().io }, { stdinIsTty: false });
		const h = read();
		expect(h.exitCode).toBe(43);
		expect(h.confirmations).toEqual([]);
		expect(h.wipeCalls).toBe(0);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.error.summary).toContain('wipe requires confirmation');
	});
});
