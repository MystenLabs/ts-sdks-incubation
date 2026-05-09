import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineDevstackConfig } from '../config.js';
import type { DevstackConfig, Env, SnapshotRecord } from '../engine/types.js';
import { define } from '../factories/define.js';
import {
	labeledSnapshotPath,
	labeledSnapshotsDir,
	snapshotPathFor,
	tryReadSnapshot,
	writeSnapshot,
} from '../persistence/index.js';
import { sui } from '../plugins/sui.js';
import { mkdir, writeFile as writeFsFile } from 'node:fs/promises';
import { dep } from '../factories/dep.js';
import { runApply } from './apply.js';
import { runDoctor } from './doctor.js';
import { runReset } from './reset.js';
import { readActiveStack } from './env.js';
import { runStackDown, runStackList, runStackNew, runStackUse } from './stack.js';
import {
	runSnapshotDelete,
	runSnapshotList,
	runSnapshotRestore,
	runSnapshotSave,
} from './snapshot.js';
import { runStatus } from './status.js';
import { runUp } from './up.js';

// In-memory write stream that captures everything written for assertions.
class CaptureStream extends Writable {
	chunks: string[] = [];
	override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
		this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
		cb();
	}
	get text(): string {
		return this.chunks.join('');
	}
}

// `runApply`'s `out` parameter expects NodeJS.WriteStream. CaptureStream
// is a Writable; cast at the boundary. Tests only consume `chunks`.
function asWriteStream(s: CaptureStream): NodeJS.WriteStream {
	return s as unknown as NodeJS.WriteStream;
}

let appDir: string;
let env: Env;

beforeEach(async () => {
	appDir = await mkdtemp(join(tmpdir(), 'devstack-next-cli-'));
	env = { appName: 'demo', appDir, network: 'testnet' };
});

afterEach(async () => {
	await rm(appDir, { recursive: true, force: true });
});

// Synthetic config: sui.create({ network: 'testnet' }) is a stub (no
// Docker), plus a downstream consumer that reads the rpc url. Exercises
// dep traversal + snapshot round-trip without external I/O.
function syntheticConfig(): DevstackConfig {
	const consumer = define({
		name: 'consumer',
		deps: { rpc: sui.get('rpc') },
		start: async ({ deps: { rpc } }) => ({ rpcUrl: rpc.url }),
	});
	return defineDevstackConfig({ stack: [sui.create({ network: 'testnet' }), consumer] });
}

describe('runApply', () => {
	it('runs one cycle, writes a snapshot, returns exit 0 on success', async () => {
		const out = new CaptureStream();
		const result = await runApply({
			config: syntheticConfig(),
			env,
			out: asWriteStream(out),
		});
		expect(result.exitCode).toBe(0);
		expect(result.cycle.errored).toEqual([]);
		expect(result.cycle.ran.length).toBeGreaterThan(0);
		// The snapshot file landed at the path the persistence layer reports.
		expect(result.snapshotPath).toBe(snapshotPathFor(env));
		const written = await readFile(result.snapshotPath, 'utf8');
		const parsed = JSON.parse(written) as { nodeStates: Record<string, unknown> };
		expect(Object.keys(parsed.nodeStates)).toContain('sui.testnet');
		expect(Object.keys(parsed.nodeStates)).toContain('consumer');
	});

	it('emits a JSON summary on summaryOut when --json is set', async () => {
		const stderrCapture = new CaptureStream();
		const stdoutCapture = new CaptureStream();
		await runApply({
			config: syntheticConfig(),
			env,
			out: asWriteStream(stderrCapture),
			summaryOut: asWriteStream(stdoutCapture),
			json: true,
		});
		const summary = JSON.parse(stdoutCapture.text);
		expect(summary.command).toBe('apply');
		expect(summary.network).toBe('testnet');
		expect(summary.errored).toEqual([]);
		expect(summary.ran).toContain('sui.testnet');
	});

	it('returns exit 1 when a node errors', async () => {
		// faucet on mainnet throws when consumed — surface the error path.
		const consumer = define({
			name: 'consumer',
			deps: { faucet: sui.get('faucet') },
			start: async ({ deps: { faucet } }) => ({ url: faucet.url }),
		});
		const config = defineDevstackConfig({
			stack: [sui.create({ network: 'mainnet' }), consumer],
		});
		const result = await runApply({
			config,
			env: { ...env, network: 'mainnet' },
			out: asWriteStream(new CaptureStream()),
		});
		expect(result.exitCode).toBe(1);
		expect(result.cycle.errored.length).toBe(1);
		expect(result.cycle.errored[0]?.name).toBe('consumer');
	});

	it('hydrates from a prior snapshot on warm start', async () => {
		const out1 = new CaptureStream();
		const first = await runApply({
			config: syntheticConfig(),
			env,
			out: asWriteStream(out1),
		});
		expect(first.exitCode).toBe(0);
		const before = await tryReadSnapshot(env);
		expect(before).toBeDefined();
		const firstHash = before!.nodeStates['sui.testnet']?.lastInputHash;

		const out2 = new CaptureStream();
		const second = await runApply({
			config: syntheticConfig(),
			env,
			out: asWriteStream(out2),
		});
		expect(second.exitCode).toBe(0);
		const after = await tryReadSnapshot(env);
		const secondHash = after!.nodeStates['sui.testnet']?.lastInputHash;
		// Same input → same hash. Hydration short-circuited the second run.
		expect(secondHash).toBe(firstHash);
	});
});

describe('runStatus', () => {
	it('returns exit 1 with a "no snapshot" message before any apply', async () => {
		const out = new CaptureStream();
		const result = await runStatus({ env, out: asWriteStream(out) });
		expect(result.exitCode).toBe(1);
		expect(result.snapshot).toBeUndefined();
		expect(out.text).toContain('no snapshot at');
	});

	it('reads the on-disk snapshot after a prior apply', async () => {
		await runApply({
			config: syntheticConfig(),
			env,
			out: asWriteStream(new CaptureStream()),
		});
		const out = new CaptureStream();
		const result = await runStatus({ env, out: asWriteStream(out) });
		expect(result.exitCode).toBe(0);
		expect(result.snapshot).toBeDefined();
		expect(out.text).toContain('sui.testnet');
		expect(out.text).toContain('satisfied');
	});

	it('emits structured JSON when --json is set', async () => {
		await runApply({
			config: syntheticConfig(),
			env,
			out: asWriteStream(new CaptureStream()),
		});
		const out = new CaptureStream();
		await runStatus({ env, out: asWriteStream(out), json: true });
		const parsed = JSON.parse(out.text) as {
			command: string;
			exists: boolean;
			nodes: { name: string; status: string }[];
		};
		expect(parsed.command).toBe('status');
		expect(parsed.exists).toBe(true);
		const sui = parsed.nodes.find((n) => n.name === 'sui.testnet');
		expect(sui?.status).toBe('satisfied');
	});
});

describe('runSnapshot*', () => {
	const localEnv = (override?: Partial<Env>): Env => ({
		appName: 'demo',
		appDir,
		network: 'localnet',
		stack: 'main',
		...override,
	});

	function sampleRecord(env: Env, createdAt: number): SnapshotRecord {
		const recordEnv: SnapshotRecord['env'] = { appName: env.appName, network: env.network };
		if (env.stack !== undefined) recordEnv.stack = env.stack;
		return {
			createdAt,
			env: recordEnv,
			nodeStates: {
				'sui.localnet': {
					lastInputHash: 'abc',
					lastRunAt: createdAt,
					identity: 'id1',
					state: { rpcUrl: 'http://localhost:9000' },
				},
			},
			meta: { devstackVersion: '0.0.0-dev' },
		};
	}

	it('save copies the canonical snapshot to a labeled file', async () => {
		const env = localEnv();
		await writeSnapshot(env, sampleRecord(env, Date.UTC(2026, 4, 8, 12, 0, 0)));
		const out = new CaptureStream();
		const result = await runSnapshotSave({ env, label: 'baseline', out: asWriteStream(out) });
		expect(result.exitCode).toBe(0);
		expect(result.id).toBe('20260508T120000');
		expect(result.label).toBe('baseline');
		expect(result.path).toBe(labeledSnapshotPath(env, '20260508T120000', 'baseline'));
		const body = await readFile(result.path!, 'utf8');
		expect(JSON.parse(body).createdAt).toBe(Date.UTC(2026, 4, 8, 12, 0, 0));
		expect(out.text).toContain('saved snapshot 20260508T120000');
	});

	it('save errors when no canonical snapshot exists', async () => {
		const out = new CaptureStream();
		const result = await runSnapshotSave({
			env: localEnv(),
			label: 'baseline',
			out: asWriteStream(out),
		});
		expect(result.exitCode).toBe(1);
		expect(out.text).toContain('no snapshot at');
	});

	it('save without a label writes <id>.json', async () => {
		const env = localEnv();
		await writeSnapshot(env, sampleRecord(env, Date.UTC(2026, 0, 1, 0, 0, 0)));
		const result = await runSnapshotSave({
			env,
			out: asWriteStream(new CaptureStream()),
		});
		expect(result.exitCode).toBe(0);
		expect(result.path).toBe(labeledSnapshotPath(env, '20260101T000000'));
	});

	it('save rejects malformed labels', async () => {
		const env = localEnv();
		await writeSnapshot(env, sampleRecord(env, Date.now()));
		await expect(
			runSnapshotSave({ env, label: 'not/a label', out: asWriteStream(new CaptureStream()) }),
		).rejects.toThrow(/label/);
	});

	it('list returns newest-first; empty when no snapshots', async () => {
		const env = localEnv();
		const empty = await runSnapshotList({ env, out: asWriteStream(new CaptureStream()) });
		expect(empty.entries).toEqual([]);

		await writeSnapshot(env, sampleRecord(env, Date.UTC(2026, 0, 1, 0, 0, 0)));
		await runSnapshotSave({ env, label: 'old', out: asWriteStream(new CaptureStream()) });
		await writeSnapshot(env, sampleRecord(env, Date.UTC(2026, 5, 1, 0, 0, 0)));
		await runSnapshotSave({ env, label: 'new', out: asWriteStream(new CaptureStream()) });

		const out = new CaptureStream();
		const result = await runSnapshotList({ env, out: asWriteStream(out) });
		expect(result.exitCode).toBe(0);
		expect(result.entries.map((e) => e.label)).toEqual(['new', 'old']);
		expect(out.text).toContain('20260601T000000');
		expect(out.text).toContain('20260101T000000');
	});

	it('list emits structured JSON when --json is set', async () => {
		const env = localEnv();
		await writeSnapshot(env, sampleRecord(env, Date.UTC(2026, 4, 8, 12, 0, 0)));
		await runSnapshotSave({ env, label: 'baseline', out: asWriteStream(new CaptureStream()) });
		const out = new CaptureStream();
		await runSnapshotList({ env, out: asWriteStream(out), json: true });
		const parsed = JSON.parse(out.text) as {
			snapshots: { id: string; label?: string }[];
		};
		expect(parsed.snapshots).toHaveLength(1);
		expect(parsed.snapshots[0]?.label).toBe('baseline');
	});

	it('restore copies a labeled snapshot back to the canonical path', async () => {
		const env = localEnv();
		await writeSnapshot(env, sampleRecord(env, Date.UTC(2026, 4, 8, 12, 0, 0)));
		await runSnapshotSave({ env, label: 'baseline', out: asWriteStream(new CaptureStream()) });
		// Mutate the canonical snapshot so restore has a visible effect.
		await writeSnapshot(env, sampleRecord(env, Date.UTC(2030, 0, 1, 0, 0, 0)));
		const before = await tryReadSnapshot(env);
		expect(before?.createdAt).toBe(Date.UTC(2030, 0, 1, 0, 0, 0));

		const out = new CaptureStream();
		const result = await runSnapshotRestore({ env, ref: 'baseline', out: asWriteStream(out) });
		expect(result.exitCode).toBe(0);
		const after = await tryReadSnapshot(env);
		expect(after?.createdAt).toBe(Date.UTC(2026, 4, 8, 12, 0, 0));
		expect(out.text).toContain('restored snapshot');
	});

	it('restore by id-prefix works when unambiguous', async () => {
		const env = localEnv();
		await writeSnapshot(env, sampleRecord(env, Date.UTC(2026, 4, 8, 12, 0, 0)));
		await runSnapshotSave({ env, out: asWriteStream(new CaptureStream()) });
		await writeSnapshot(env, sampleRecord(env, Date.UTC(2030, 0, 1, 0, 0, 0)));
		const result = await runSnapshotRestore({
			env,
			ref: '20260508',
			out: asWriteStream(new CaptureStream()),
		});
		expect(result.exitCode).toBe(0);
		const restored = await tryReadSnapshot(env);
		expect(restored?.createdAt).toBe(Date.UTC(2026, 4, 8, 12, 0, 0));
	});

	it('restore returns exit 1 when ref does not match', async () => {
		const out = new CaptureStream();
		const result = await runSnapshotRestore({
			env: localEnv(),
			ref: 'nope',
			out: asWriteStream(out),
		});
		expect(result.exitCode).toBe(1);
		expect(out.text).toContain('no snapshot matching');
	});

	it('delete removes the labeled snapshot file', async () => {
		const env = localEnv();
		await writeSnapshot(env, sampleRecord(env, Date.UTC(2026, 4, 8, 12, 0, 0)));
		await runSnapshotSave({ env, label: 'doomed', out: asWriteStream(new CaptureStream()) });
		const dir = labeledSnapshotsDir(env);
		expect(await readdir(dir)).toHaveLength(1);

		const out = new CaptureStream();
		const result = await runSnapshotDelete({ env, ref: 'doomed', out: asWriteStream(out) });
		expect(result.exitCode).toBe(0);
		expect(await readdir(dir)).toEqual([]);
		expect(out.text).toContain('deleted snapshot');
	});

	it('save / list / delete refuse non-localnet networks', async () => {
		const liveEnv = { ...localEnv(), network: 'testnet' };
		await expect(
			runSnapshotSave({ env: liveEnv, label: 'x', out: asWriteStream(new CaptureStream()) }),
		).rejects.toThrow(/localnet/);
		await expect(
			runSnapshotList({ env: liveEnv, out: asWriteStream(new CaptureStream()) }),
		).rejects.toThrow(/localnet/);
	});

	it('list tolerates a corrupt entry instead of crashing', async () => {
		const env = localEnv();
		await writeSnapshot(env, sampleRecord(env, Date.UTC(2026, 4, 8, 12, 0, 0)));
		await runSnapshotSave({ env, label: 'good', out: asWriteStream(new CaptureStream()) });
		// Drop a malformed file in the snapshots dir.
		await writeFile(join(labeledSnapshotsDir(env), '20260101T000000-broken.json'), '{not json');
		const out = new CaptureStream();
		const result = await runSnapshotList({ env, out: asWriteStream(out) });
		expect(result.exitCode).toBe(0);
		expect(result.entries).toHaveLength(2);
		expect(result.entries.map((e) => e.label).sort()).toEqual(['broken', 'good']);
	});
});

describe('runReset', () => {
	const localEnv = (override?: Partial<Env>): Env => ({
		appName: 'demo',
		appDir,
		network: 'localnet',
		stack: 'main',
		...override,
	});

	function snapshotWithRunnerStates(env: Env, deadPid: number): SnapshotRecord {
		const recordEnv: SnapshotRecord['env'] = { appName: env.appName, network: env.network };
		if (env.stack !== undefined) recordEnv.stack = env.stack;
		return {
			createdAt: 1_700_000_000_000,
			env: recordEnv,
			nodeStates: {
				'sui.localnet.container': {
					lastInputHash: 'abc',
					lastRunAt: 1_700_000_000_000,
					identity: 'id1',
					// DockerContainerState shape — fake id, dockerContainerExists
					// returns false → we don't actually call docker rm.
					state: {
						containerId: 'fakecontainer000000000000000000000000000000000000000000000000fake',
						startedAt: 1_700_000_000_000,
						image: 'mystenlabs/sui-tools:devnet',
						args: ['sui-test-validator'],
						hostPorts: { 'sui.rpc': 9000 },
					},
				},
				'host.proc': {
					lastInputHash: 'def',
					lastRunAt: 1_700_000_000_000,
					identity: 'id2',
					// HostProcessState shape — pid is dead, isAlive returns
					// false → no kill attempted.
					state: {
						pid: deadPid,
						startedAt: 1_700_000_000_000,
						command: 'true',
						args: [],
					},
				},
				'plain.action': {
					lastInputHash: 'ghi',
					lastRunAt: 1_700_000_000_000,
					identity: 'id3',
					// Not a runner state — must be ignored.
					state: { value: 42 },
				},
			},
			meta: { devstackVersion: '0.0.0-dev' },
		};
	}

	it('removes the per-stack state directory', async () => {
		const env = localEnv();
		await writeSnapshot(env, snapshotWithRunnerStates(env, 1));
		expect(await tryReadSnapshot(env)).toBeDefined();

		const out = new CaptureStream();
		const result = await runReset({ env, out: asWriteStream(out), noStop: true });
		expect(result.exitCode).toBe(0);
		expect(await tryReadSnapshot(env)).toBeUndefined();
		expect(result.removedPaths.length).toBeGreaterThan(0);
	});

	it('keeps labeled snapshots when --keep-snapshots is set', async () => {
		const env = localEnv();
		await writeSnapshot(env, snapshotWithRunnerStates(env, 1));
		await runSnapshotSave({ env, label: 'kept', out: asWriteStream(new CaptureStream()) });
		expect(await readdir(labeledSnapshotsDir(env))).toHaveLength(1);

		await runReset({
			env,
			out: asWriteStream(new CaptureStream()),
			noStop: true,
			keepSnapshots: true,
		});
		expect(await tryReadSnapshot(env)).toBeUndefined();
		expect(await readdir(labeledSnapshotsDir(env))).toHaveLength(1);
	});

	it('skips already-dead processes / nonexistent containers without error', async () => {
		const env = localEnv();
		// Pick a pid that can't be alive — out of range.
		await writeSnapshot(env, snapshotWithRunnerStates(env, 0x7fff_ffff));
		const out = new CaptureStream();
		const result = await runReset({ env, out: asWriteStream(out) });
		expect(result.exitCode).toBe(0);
		// No kills happened (container fake, pid dead).
		expect(result.killed).toEqual([]);
	});

	it('emits structured JSON when --json is set', async () => {
		const env = localEnv();
		await writeSnapshot(env, snapshotWithRunnerStates(env, 0x7fff_ffff));
		const out = new CaptureStream();
		await runReset({ env, out: asWriteStream(out), json: true, noStop: true });
		const parsed = JSON.parse(out.text) as {
			command: string;
			killed: unknown[];
			removedPaths: string[];
		};
		expect(parsed.command).toBe('reset');
		expect(parsed.killed).toEqual([]);
		expect(parsed.removedPaths.length).toBeGreaterThan(0);
	});

	it('refuses non-localnet networks', async () => {
		await expect(
			runReset({
				env: { ...localEnv(), network: 'testnet' },
				out: asWriteStream(new CaptureStream()),
			}),
		).rejects.toThrow(/localnet/);
	});
});

describe('runDoctor', () => {
	const localEnv = (override?: Partial<Env>): Env => ({
		appName: 'demo',
		appDir,
		network: 'localnet',
		stack: 'main',
		...override,
	});

	it('always emits a checks list with docker + sui CLI checks', async () => {
		const out = new CaptureStream();
		const result = await runDoctor({ env: localEnv(), out: asWriteStream(out) });
		const names = result.checks.map((c) => c.name);
		expect(names).toContain('docker daemon');
		expect(names).toContain('sui CLI');
		// Without a snapshot, the host-ports informational check fires once.
		expect(names.filter((n) => n === 'host ports')).toHaveLength(1);
	});

	it('exit code reflects required-check failures', async () => {
		const result = await runDoctor({
			env: localEnv(),
			out: asWriteStream(new CaptureStream()),
		});
		const requiredFailed = result.checks.filter((c) => c.required && !c.ok).length;
		expect(result.exitCode).toBe(requiredFailed === 0 ? 0 : 1);
	});

	it('reports an informational entry per snapshot-allocated port', async () => {
		const env = localEnv();
		// Hand-write a snapshot with a `ports` node mapping two slots and a
		// docker container with a third hostPort.
		const record: SnapshotRecord = {
			createdAt: 1_700_000_000_000,
			env: { appName: env.appName, network: env.network, stack: env.stack ?? 'main' },
			nodeStates: {
				ports: {
					lastInputHash: 'abc',
					lastRunAt: 1_700_000_000_000,
					identity: 'id',
					state: { map: { 'sui.rpc': 49100, 'sui.faucet': 49101 } },
				},
				'sui.localnet.container': {
					lastInputHash: 'def',
					lastRunAt: 1_700_000_000_000,
					identity: 'id2',
					state: {
						containerId: 'fake',
						startedAt: 1_700_000_000_000,
						image: 'mystenlabs/sui-tools:devnet',
						args: [],
						hostPorts: { 'sui.rpc': 49100 },
					},
				},
			},
			meta: { devstackVersion: '0.0.0-dev' },
		};
		await writeSnapshot(env, record);
		const result = await runDoctor({ env, out: asWriteStream(new CaptureStream()) });
		const portChecks = result.checks.filter((c) => c.name.startsWith('port '));
		expect(portChecks.map((c) => c.name).sort()).toEqual(['port 49100', 'port 49101']);
		// All port checks are informational (ok=true, required=false).
		for (const c of portChecks) {
			expect(c.ok).toBe(true);
			expect(c.required).toBe(false);
		}
	});

	it('emits structured JSON when --json is set', async () => {
		const out = new CaptureStream();
		await runDoctor({ env: localEnv(), out: asWriteStream(out), json: true });
		const parsed = JSON.parse(out.text) as {
			command: string;
			checks: { name: string; ok: boolean; required: boolean }[];
		};
		expect(parsed.command).toBe('doctor');
		expect(parsed.checks.some((c) => c.name === 'docker daemon')).toBe(true);
	});
});

describe('runStackList', () => {
	const localEnv = (override?: Partial<Env>): Env => ({
		appName: 'demo',
		appDir,
		network: 'localnet',
		stack: 'main',
		...override,
	});

	function record(env: Env, createdAt: number): SnapshotRecord {
		const recordEnv: SnapshotRecord['env'] = { appName: env.appName, network: env.network };
		if (env.stack !== undefined) recordEnv.stack = env.stack;
		return {
			createdAt,
			env: recordEnv,
			nodeStates: {
				'plain.action': {
					lastInputHash: 'abc',
					lastRunAt: createdAt,
					identity: 'id',
					state: { value: 1 },
				},
			},
			meta: { devstackVersion: '0.0.0-dev' },
		};
	}

	it('lists every stack on disk, marks no-snapshot dirs', async () => {
		const env = localEnv();
		await writeSnapshot(env, record(env, 1_000_000_000_000));
		await writeSnapshot({ ...env, stack: 'test' }, record({ ...env, stack: 'test' }, 2_000_000_000_000));
		// An empty stack dir simulates `mkdir` without a run.
		const fs = await import('node:fs/promises');
		await fs.mkdir(join(appDir, '.devstack/stacks/empty'), { recursive: true });

		const out = new CaptureStream();
		const result = await runStackList({ env, out: asWriteStream(out) });
		expect(result.exitCode).toBe(0);
		expect(result.stacks.map((s) => s.name).sort()).toEqual(['empty', 'main', 'test']);
		const empty = result.stacks.find((s) => s.name === 'empty');
		expect(empty?.hasSnapshot).toBe(false);
		expect(out.text).toContain('main');
		expect(out.text).toContain('test');
		expect(out.text).toContain('empty');
	});

	it('emits structured JSON when --json is set', async () => {
		const env = localEnv();
		await writeSnapshot(env, record(env, 1_000_000_000_000));
		const out = new CaptureStream();
		await runStackList({ env, out: asWriteStream(out), json: true });
		const parsed = JSON.parse(out.text) as {
			command: string;
			stacks: { name: string; hasSnapshot: boolean }[];
		};
		expect(parsed.command).toBe('stack list');
		expect(parsed.stacks).toHaveLength(1);
		expect(parsed.stacks[0]?.name).toBe('main');
	});

	it('returns empty list when no stacks dir exists', async () => {
		const env = localEnv();
		const out = new CaptureStream();
		const result = await runStackList({ env, out: asWriteStream(out) });
		expect(result.exitCode).toBe(0);
		expect(result.stacks).toEqual([]);
		expect(out.text).toContain('no stacks');
	});

	it('refuses non-localnet networks', async () => {
		await expect(
			runStackList({
				env: { ...localEnv(), network: 'testnet' },
				out: asWriteStream(new CaptureStream()),
			}),
		).rejects.toThrow(/localnet/);
	});
});

describe('runStackDown', () => {
	const localEnv = (override?: Partial<Env>): Env => ({
		appName: 'demo',
		appDir,
		network: 'localnet',
		stack: 'main',
		...override,
	});

	it('reports nothing-to-do when no snapshot exists', async () => {
		const out = new CaptureStream();
		const result = await runStackDown({ env: localEnv(), out: asWriteStream(out) });
		expect(result.exitCode).toBe(0);
		expect(result.killed).toEqual([]);
		expect(out.text).toContain('no snapshot');
	});

	it('preserves on-disk state (sister to reset)', async () => {
		const env = localEnv();
		const snapshot: SnapshotRecord = {
			createdAt: 1_700_000_000_000,
			env: { appName: env.appName, network: env.network, stack: env.stack ?? 'main' },
			nodeStates: {
				'host.proc': {
					lastInputHash: 'x',
					lastRunAt: 1_700_000_000_000,
					identity: 'id',
					state: { pid: 0x7fff_ffff, startedAt: 1, command: 'true', args: [] },
				},
			},
			meta: { devstackVersion: '0.0.0-dev' },
		};
		await writeSnapshot(env, snapshot);

		await runStackDown({ env, out: asWriteStream(new CaptureStream()) });
		// Snapshot file is still present (this is what makes `down`
		// different from `reset`).
		expect(await tryReadSnapshot(env)).toBeDefined();
	});

	it('refuses non-localnet networks', async () => {
		await expect(
			runStackDown({
				env: { ...localEnv(), network: 'testnet' },
				out: asWriteStream(new CaptureStream()),
			}),
		).rejects.toThrow(/localnet/);
	});
});

describe('runStackNew + runStackUse', () => {
	const localEnv = (): Env => ({
		appName: 'demo',
		appDir,
		network: 'localnet',
	});

	it('runStackNew creates the per-stack directory (idempotent)', async () => {
		const out = new CaptureStream();
		const first = await runStackNew({
			env: localEnv(),
			name: 'qa',
			out: asWriteStream(out),
		});
		expect(first.exitCode).toBe(0);
		expect(first.created).toBe(true);
		expect(first.stackDir).toBe(join(appDir, '.devstack/stacks/qa'));

		const out2 = new CaptureStream();
		const second = await runStackNew({
			env: localEnv(),
			name: 'qa',
			out: asWriteStream(out2),
		});
		expect(second.created).toBe(false);
		expect(out2.text).toContain('already exists');
	});

	it('runStackNew rejects invalid names', async () => {
		await expect(
			runStackNew({
				env: localEnv(),
				name: 'BAD/name',
				out: asWriteStream(new CaptureStream()),
			}),
		).rejects.toThrow(/invalid/);
	});

	it('runStackUse writes the active pointer; readActiveStack reads it back', async () => {
		const out = new CaptureStream();
		const result = await runStackUse({
			env: localEnv(),
			name: 'qa',
			out: asWriteStream(out),
		});
		expect(result.exitCode).toBe(0);
		expect(result.active).toBe('qa');
		expect(result.previous).toBeUndefined();
		expect(await readActiveStack(appDir)).toBe('qa');
	});

	it('runStackUse reports the prior active when overwriting', async () => {
		await runStackUse({
			env: localEnv(),
			name: 'qa',
			out: asWriteStream(new CaptureStream()),
		});
		const out = new CaptureStream();
		const result = await runStackUse({
			env: localEnv(),
			name: 'staging',
			out: asWriteStream(out),
		});
		expect(result.previous).toBe('qa');
		expect(result.active).toBe('staging');
		expect(out.text).toContain("was 'qa'");
	});

	it('runStackUse mkdir-creates the stack dir alongside writing active', async () => {
		await runStackUse({
			env: localEnv(),
			name: 'fresh',
			out: asWriteStream(new CaptureStream()),
		});
		const fs = await import('node:fs/promises');
		const stat = await fs.stat(join(appDir, '.devstack/stacks/fresh'));
		expect(stat.isDirectory()).toBe(true);
	});

	it('readActiveStack returns undefined when no pointer is set', async () => {
		expect(await readActiveStack(appDir)).toBeUndefined();
	});

	it('readActiveStack ignores invalid pointer contents', async () => {
		const fs = await import('node:fs/promises');
		await fs.mkdir(join(appDir, '.devstack'), { recursive: true });
		await fs.writeFile(join(appDir, '.devstack/active'), 'BAD/Name\n', 'utf8');
		expect(await readActiveStack(appDir)).toBeUndefined();
	});

	it('refuses non-localnet networks', async () => {
		await expect(
			runStackNew({
				env: { ...localEnv(), network: 'testnet' },
				name: 'qa',
				out: asWriteStream(new CaptureStream()),
			}),
		).rejects.toThrow(/localnet/);
	});
});

describe('runUp file-watching', () => {
	it('re-cycles when a watched path changes', async () => {
		const env = { appName: 'demo', appDir, network: 'localnet' as const, stack: 'main' };
		const watchedDir = join(appDir, 'sources');
		await mkdir(watchedDir, { recursive: true });
		await writeFsFile(join(watchedDir, 'a.txt'), 'first\n');

		// Producer that registers `watchedDir` for fs-watching and counts
		// how many times it has been (re-)started. We assert runCount > 1
		// after touching the file.
		let runCount = 0;
		type S = { runCount: number };
		const watcher = define<S>({
			name: 'fs-watch-probe',
			provides: { rev: dep((s: S) => s.runCount) },
			// `inputs` flips every cycle so the engine doesn't short-circuit
			// us via input-hash equality. The `watch()` registration is the
			// real subject under test.
			inputs: () => ({ now: Date.now() }),
			start: async ({ watch }) => {
				watch(watchedDir);
				runCount += 1;
				return { runCount };
			},
		});
		const config = defineDevstackConfig({ stack: [watcher] });

		let resolveStop: () => void = () => undefined;
		const stopSignal = new Promise<void>((r) => {
			resolveStop = r;
		});
		const out = new CaptureStream();

		// Wait for cycle 0 to complete, then mutate the watched file. The
		// fs.watch callback should fire engine.invalidate + engine.cycle,
		// which re-runs `watcher.start` → runCount becomes 2.
		const guard = setTimeout(() => {
			resolveStop();
		}, 5000);
		const driver = (async () => {
			while (runCount === 0) await new Promise((r) => setTimeout(r, 20));
			// Ensure the watcher is registered before we mutate. attachFileWatcher
			// runs an initial refresh after the first cycle:end emit, then again
			// on subsequent cycle:ends — give it one tick to land before we mutate.
			await new Promise((r) => setTimeout(r, 50));
			await writeFsFile(join(watchedDir, 'a.txt'), 'second\n');
			while (runCount < 2) await new Promise((r) => setTimeout(r, 20));
			resolveStop();
		})();

		try {
			const code = await runUp({
				config,
				env,
				out: asWriteStream(out),
				stopSignal,
				renderer: 'plain',
				watchDebounceMs: 25,
			});
			expect(code).toBe(0);
		} finally {
			clearTimeout(guard);
			await driver.catch(() => undefined);
		}

		expect(runCount).toBeGreaterThanOrEqual(2);
	});

	it('does not register watchers when noWatch is set', async () => {
		const env = { appName: 'demo', appDir, network: 'localnet' as const, stack: 'main' };
		const watchedDir = join(appDir, 'sources');
		await mkdir(watchedDir, { recursive: true });
		await writeFsFile(join(watchedDir, 'a.txt'), 'first\n');

		let runCount = 0;
		type S = { runCount: number };
		const watcher = define<S>({
			name: 'fs-watch-probe',
			provides: { rev: dep((s: S) => s.runCount) },
			inputs: () => ({ now: Date.now() }),
			start: async ({ watch }) => {
				watch(watchedDir);
				runCount += 1;
				return { runCount };
			},
		});
		const config = defineDevstackConfig({ stack: [watcher] });

		let resolveStop: () => void = () => undefined;
		const stopSignal = new Promise<void>((r) => {
			resolveStop = r;
		});
		const out = new CaptureStream();

		const driver = (async () => {
			while (runCount === 0) await new Promise((r) => setTimeout(r, 20));
			// Mutate the watched file. With --no-watch, no cycle should
			// fire — runCount stays at 1.
			await writeFsFile(join(watchedDir, 'a.txt'), 'second\n');
			await new Promise((r) => setTimeout(r, 200));
			resolveStop();
		})();

		const code = await runUp({
			config,
			env,
			out: asWriteStream(out),
			stopSignal,
			renderer: 'plain',
			noWatch: true,
		});
		await driver;
		expect(code).toBe(0);
		expect(runCount).toBe(1);
	});
});

describe('runUp', () => {
	it('runs the first cycle, idles until stopSignal, writes snapshot at cycle:end', async () => {
		let resolveStop: () => void = () => undefined;
		const stopSignal = new Promise<void>((r) => {
			resolveStop = r;
		});
		const out = new CaptureStream();

		// The supervisor finishes cycle 0, schedules a snapshot write at
		// cycle:end, then idles. The cycle:end snapshot write is fire-and-
		// forget (`void engine.saveSnapshot().then(writeSnapshot)`), so we
		// can't stop on the renderer's `] end (` line — the snapshot file
		// may not exist yet by the time runUp returns. Poll for the
		// snapshot file directly instead.
		const subscription = setInterval(() => {
			void tryReadSnapshot(env).then((snap) => {
				if (snap !== undefined) {
					resolveStop();
					clearInterval(subscription);
				}
			});
		}, 5);
		// Belt-and-suspenders timeout — never block this test forever.
		const guard = setTimeout(() => {
			resolveStop();
			clearInterval(subscription);
		}, 5000);

		try {
			const code = await runUp({
				config: syntheticConfig(),
				env,
				out: asWriteStream(out),
				stopSignal,
			});
			expect(code).toBe(0);
		} finally {
			clearTimeout(guard);
			clearInterval(subscription);
		}

		// Snapshot file should exist after the cycle:end snapshot write.
		const snapshot = await tryReadSnapshot(env);
		expect(snapshot).toBeDefined();
		expect(Object.keys(snapshot!.nodeStates)).toContain('sui.testnet');
		// Output should show the cycle and shutdown lines.
		expect(out.text).toContain('] start');
		expect(out.text).toContain('] end (');
		expect(out.text).toContain('[shutdown]');
	});
});
