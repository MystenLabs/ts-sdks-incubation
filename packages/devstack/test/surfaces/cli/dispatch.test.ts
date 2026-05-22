// Top-level dispatcher tests.
//
// These pin the public CLI surface after the Stricli migration:
// attached lifecycle commands, direct/offline maintenance commands,
// command-scoped flags, and no public peer-command verbs.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import { makeSnapshotReader } from '../../../src/cli/snapshot-reader.ts';
import {
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
		readonly label?: string;
		readonly configPath?: string;
	}>;
	readonly restores: ReadonlyArray<string>;
	readonly deletes: ReadonlyArray<string>;
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

const tempRoots: Array<string> = [];

const makeHarness = (): {
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
		label?: string;
		configPath?: string;
	}> = [];
	const restores: Array<string> = [];
	const deletes: Array<string> = [];
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
		status: {
			reader: { readState: () => Effect.succeed(null) },
		},
		snapshot: {
			reader: { list: () => Effect.succeed([]), resolve: () => Effect.succeed(null) },
			capture: (args) =>
				Effect.sync(() => {
					captures.push(args);
				}),
			restore: (snapshotId) =>
				Effect.sync(() => {
					restores.push(snapshotId);
				}),
			delete: (snapshotId) =>
				Effect.sync(() => {
					deletes.push(snapshotId);
				}),
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
				label: 'friendly-label',
				createdAt: 1_700_000_000_000,
				app: 'app',
				stack: 'main',
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
		for (const verb of ['down', 'logs', 'codegen', 'exec', 'fork', 'stack']) {
			const { deps, read } = makeHarness();
			await run([verb], deps, { io: read().io });
			const h = read();
			expect(h.exitCode).toBe(64);
			expect(h.stderr.join('\n')).toMatch(/No command registered/);
		}
	});

	it('marks fork networks as coming soon at the CLI boundary', async () => {
		const { deps, read } = makeHarness();
		await run(['apply', '--network', 'mainnet-fork'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(64);
		expect(h.stderr.join('\n')).toMatch(/fork networks are coming soon/i);
		expect(h.applyRuns).toHaveLength(0);
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

	it('snapshot save invokes direct capture with command-scoped args', async () => {
		const { deps, read } = makeHarness();
		await run(
			['snapshot', 'save', 'baseline', '--label', 'seeded', '--config', 'devstack.ci.ts', '--json'],
			deps,
			{ io: read().io },
		);
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(h.captures).toEqual([
			{ snapshotId: 'baseline', label: 'seeded', configPath: 'devstack.ci.ts' },
		]);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.data.snapshotId).toBe('baseline');
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
							stack: 'deepbook-full',
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
		expect(env.error.summary).toContain('no supervisor running for devstack/deepbook-full');
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
				label: 'friendly-label',
				createdAt: 1_700_000_000_000,
				size: null,
			},
		]);
		expect(JSON.stringify(env.data.entries)).not.toContain(catalog.metadataId);
	});

	it('snapshot restore and delete resolve labels to artifact directory ids', async () => {
		const { deps, read } = makeHarness();
		const catalog = makeSnapshotCatalog();
		const depsWithCatalog: CliDeps = {
			...deps,
			snapshot: {
				...deps.snapshot,
				reader: makeSnapshotReader({ stackRoot: catalog.stackRoot }),
			},
		};
		await run(['snapshot', 'restore', 'friendly-label', '--json'], depsWithCatalog, {
			io: read().io,
		});
		await run(['snapshot', 'delete', 'friendly-label', '--json'], depsWithCatalog, {
			io: read().io,
		});
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(h.restores).toEqual([catalog.snapshotId]);
		expect(h.deletes).toEqual([catalog.snapshotId]);
		expect(JSON.parse(h.stdout[0]!).data.snapshotId).toBe(catalog.snapshotId);
		expect(JSON.parse(h.stdout[1]!).data.snapshotId).toBe(catalog.snapshotId);
	});

	it('schema emits the curated command set', async () => {
		const { deps, read } = makeHarness();
		await run(['schema', '--json'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		const schema = JSON.parse(h.stdout[0]!);
		expect(schema.verbs).toEqual([
			'up',
			'apply',
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

	it('wipe has the same destructive command-scoped contract', async () => {
		const { deps, read } = makeHarness();
		await run(['wipe', '--dry-run', '--json'], deps, { io: read().io }, { stdinIsTty: false });
		await run(['wipe', '--yes', '--json'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(JSON.parse(h.stdout[0]!).dryRun).toBe(true);
		expect(h.wipeCalls).toBe(1);
	});
});
