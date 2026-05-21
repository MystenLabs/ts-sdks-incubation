// Top-level dispatcher tests.
//
// These exercise the verb router + the error path → exit-code wiring
// without booting the engine. The verb dependencies are stubbed; we
// only verify that:
//   - unknown verb → USAGE exit code + envelope
//   - `down` publishes the right command
//   - `status` survives a null projection (architecture: tolerant)
//   - `--schema --json` short-circuits
//   - `--json` mode emits exactly one envelope on stdout

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
import type { EngineCommand } from '../../../src/substrate/events.ts';
import { dispatch, type CliDeps } from '../../../src/surfaces/cli/index.ts';
import type { CliIO } from '../../../src/surfaces/cli/output.ts';

// --- IO + publisher harness -------------------------------------------------

interface Harness {
	readonly io: CliIO;
	readonly stdout: ReadonlyArray<string>;
	readonly stderr: ReadonlyArray<string>;
	readonly exitCode: number | null;
	readonly published: ReadonlyArray<EngineCommand>;
}

const makeHarness = (): Promise<{
	deps: CliDeps;
	read: () => Harness;
}> => {
	const stdout: Array<string> = [];
	const stderr: Array<string> = [];
	let exitCode: number | null = null;
	const published: Array<EngineCommand> = [];

	const io: CliIO = {
		writeStdout: (line) => Effect.sync(() => void stdout.push(line)),
		writeStderr: (line) => Effect.sync(() => void stderr.push(line)),
		setExitCode: (code) =>
			Effect.sync(() => {
				exitCode = code;
			}),
	};

	const publisher = {
		publish: (cmd: EngineCommand) =>
			Effect.sync(() => {
				published.push(cmd);
			}),
	};

	const subscriber = {
		subscribe: () => Effect.succeed({ unsubscribe: Effect.void }),
	};

	const deps: CliDeps = {
		up: {
			loader: {
				load: () => Effect.succeed({ stack: { _tag: 'Stack' as const }, resolvedConfigPath: '/x' }),
			},
			publisher,
			subscriber,
			shutdown: { await: Effect.void },
		},
		down: { publisher },
		status: {
			reader: { readState: () => Effect.succeed(null) },
		},
		snapshot: {
			publisher,
			reader: { list: () => Effect.succeed([]), resolve: () => Effect.succeed(null) },
		},
		prune: { publisher },
		logs: { subscriber, shutdown: Effect.void },
		doctor: { probes: [] },
		codegen: { publisher },
		config: {
			loader: {
				load: () => Effect.succeed({ stack: { _tag: 'Stack' as const }, resolvedConfigPath: '/x' }),
			},
		},
		apply: { publisher },
		wipe: { publisher },
		stack: {
			resolveAppRoot: () => Effect.succeed('/tmp/devstack-test'),
		},
		fork: { publisher },
	};

	return Promise.resolve({
		deps,
		read: () => ({
			io,
			stdout,
			stderr,
			exitCode,
			published,
		}),
	});
};

const run = async (argv: ReadonlyArray<string>, deps: CliDeps, h: { io: CliIO }) => {
	await Effect.runPromise(
		dispatch(deps, {
			argv,
			env: {},
			stdinIsTty: true,
			io: h.io,
		}),
	);
};

const tempRoots: Array<string> = [];

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

// --- Tests -----------------------------------------------------------------

describe('dispatch', () => {
	afterEach(() => {
		for (const root of tempRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('unknown verb → USAGE exit code', async () => {
		const { deps, read } = await makeHarness();
		await run(['frobnicate'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(64); // EX_USAGE
		expect(h.stderr.join('\n')).toMatch(/unknown command/);
	});

	it('--json mode writes one envelope on stdout for unknown verb', async () => {
		const { deps, read } = await makeHarness();
		await run(['--json', 'frobnicate'], deps, { io: read().io });
		const h = read();
		expect(h.stdout).toHaveLength(1);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.ok).toBe(false);
		expect(env.error.code).toBe('USAGE');
		expect(env.error.exitCode).toBe(64);
		expect(h.stderr).toHaveLength(0);
	});

	it('exec is not exposed as a release command', async () => {
		const { deps, read } = await makeHarness();
		await run(['--json', 'exec', 'postgres', '--', 'psql'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(64);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.error.code).toBe('USAGE');
		expect(env.error.summary).toMatch(/unknown command: exec/);
	});

	it('down publishes shutdown.requested', async () => {
		const { deps, read } = await makeHarness();
		await run(['down'], deps, { io: read().io });
		const h = read();
		expect(h.published).toEqual([{ tag: 'shutdown.requested' }]);
		expect(h.exitCode).toBe(0);
	});

	it('codegen publishes codegen.requested', async () => {
		const { deps, read } = await makeHarness();
		await run(['codegen'], deps, { io: read().io });
		const h = read();
		expect(h.published).toEqual([{ tag: 'codegen.requested' }]);
		expect(h.exitCode).toBe(0);
	});

	it('status tolerates null projection', async () => {
		const { deps, read } = await makeHarness();
		await run(['--json', 'status'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.ok).toBe(true);
		expect(env.data.present).toBe(false);
	});

	it('snapshot list with no entries succeeds', async () => {
		const { deps, read } = await makeHarness();
		await run(['--json', 'snapshot', 'list'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.data.entries).toEqual([]);
	});

	it('snapshot list keeps the artifact directory id canonical when metadata id differs', async () => {
		const { deps, read } = await makeHarness();
		const catalog = makeSnapshotCatalog();
		const depsWithCatalog: CliDeps = {
			...deps,
			snapshot: {
				...deps.snapshot,
				reader: makeSnapshotReader({ stackRoot: catalog.stackRoot }),
			},
		};
		await run(['--json', 'snapshot', 'list'], depsWithCatalog, { io: read().io });
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

	it('snapshot restore on missing id → SNAPSHOT_NOT_FOUND', async () => {
		const { deps, read } = await makeHarness();
		await run(['--json', 'snapshot', 'restore', 'nope'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(41);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.error.code).toBe('SNAPSHOT_NOT_FOUND');
	});

	it('snapshot restore by label publishes the artifact directory id when metadata id differs', async () => {
		const { deps, read } = await makeHarness();
		const catalog = makeSnapshotCatalog();
		const depsWithCatalog: CliDeps = {
			...deps,
			snapshot: {
				...deps.snapshot,
				reader: makeSnapshotReader({ stackRoot: catalog.stackRoot }),
			},
		};
		await run(['--json', 'snapshot', 'restore', 'friendly-label'], depsWithCatalog, {
			io: read().io,
		});
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(h.published).toEqual([{ tag: 'snapshot.restore', snapshotId: catalog.snapshotId }]);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.data.snapshotId).toBe(catalog.snapshotId);
		expect(env.data.snapshotId).not.toBe(catalog.metadataId);
	});

	it('--schema --json short-circuits before any verb', async () => {
		const { deps, read } = await makeHarness();
		await run(['--schema', '--json'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		const schema = JSON.parse(h.stdout[0]!);
		expect(schema.verbs).toContain('up');
		expect(schema.verbs).not.toContain('exec');
		expect(schema.verbs).not.toContain('restart');
		expect(
			schema.commands.subcommands.find((c: { name: string }) => c.name === 'snapshot'),
		).toMatchObject({
			name: 'snapshot',
			subcommands: expect.arrayContaining([expect.objectContaining({ name: 'restore' })]),
		});
		expect(schema.exitCodes.find((e: { name: string }) => e.name === 'CONFIG').code).toBe(78);
	});

	it('top-level help is generated from the command tree', async () => {
		const { deps, read } = await makeHarness();
		await run(['--help'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(h.stdout).toHaveLength(1);
		expect(h.stdout[0]).toContain('Usage: devstack [--global-flags] <command> [args...]');
		expect(h.stdout[0]).toContain('snapshot');
		expect(h.stdout[0]).toContain('--config <path>');
		expect(h.published).toEqual([]);
	});

	it('up help short-circuits before loading config or publishing', async () => {
		const { deps, read } = await makeHarness();
		let loadCalls = 0;
		const depsWithGuard: CliDeps = {
			...deps,
			up: {
				...deps.up,
				loader: {
					load: () =>
						Effect.sync(() => {
							loadCalls += 1;
							return { stack: { _tag: 'Stack' as const }, resolvedConfigPath: '/loaded' };
						}),
				},
			},
		};
		await run(['up', '--help'], depsWithGuard, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(h.stdout[0]).toContain('Usage: devstack up');
		expect(loadCalls).toBe(0);
		expect(h.published).toEqual([]);
	});

	it('apply help short-circuits before publishing', async () => {
		const { deps, read } = await makeHarness();
		await run(['apply', '--help'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(h.stdout[0]).toContain('Usage: devstack apply');
		expect(h.published).toEqual([]);
	});

	it('snapshot help and nested snapshot help short-circuit successfully', async () => {
		const { deps, read } = await makeHarness();
		await run(['snapshot', '--help'], deps, { io: read().io });
		await run(['snapshot', 'restore', '--help'], deps, { io: read().io });
		const h = read();
		expect(h.exitCode).toBe(0);
		expect(h.stdout[0]).toContain('Usage: devstack snapshot <command> [args...]');
		expect(h.stdout[0]).toContain('save');
		expect(h.stdout[1]).toContain('Usage: devstack snapshot restore <id-or-label>');
		expect(h.published).toEqual([]);
	});

	it('prune in non-TTY without --yes → CONFIRM_REQUIRED', async () => {
		const { deps, read } = await makeHarness();
		await Effect.runPromise(
			dispatch(deps, {
				argv: ['--json', 'prune'],
				env: {},
				stdinIsTty: false,
				io: read().io,
			}),
		);
		const h = read();
		expect(h.exitCode).toBe(43);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.error.code).toBe('CONFIRM_REQUIRED');
	});

	it('prune --dry-run short-circuits before confirm check', async () => {
		const { deps, read } = await makeHarness();
		await Effect.runPromise(
			dispatch(deps, {
				argv: ['--json', '--dry-run', 'prune'],
				env: {},
				stdinIsTty: false, // would normally trip CONFIRM_REQUIRED
				io: read().io,
			}),
		);
		const h = read();
		expect(h.exitCode).toBe(0);
		const env = JSON.parse(h.stdout[0]!);
		expect(env.ok).toBe(true);
		expect(env.dryRun).toBe(true);
		// dry-run MUST NOT publish
		expect(h.published).toEqual([]);
	});

	it('prune --yes publishes prune.requested', async () => {
		const { deps, read } = await makeHarness();
		await run(['--yes', 'prune'], deps, { io: read().io });
		const h = read();
		expect(h.published).toEqual([{ tag: 'prune.requested' }]);
		expect(h.exitCode).toBe(0);
	});
});
