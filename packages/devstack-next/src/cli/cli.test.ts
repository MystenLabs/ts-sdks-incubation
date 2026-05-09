import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineDevstackConfig } from '../config.js';
import type { DevstackConfig, Env } from '../engine/types.js';
import { define } from '../factories/define.js';
import { snapshotPathFor, tryReadSnapshot } from '../persistence/index.js';
import { sui } from '../plugins/sui.js';
import { runApply } from './apply.js';
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

describe('runUp', () => {
	it('runs the first cycle, idles until stopSignal, writes snapshot at cycle:end', async () => {
		let resolveStop: () => void = () => undefined;
		const stopSignal = new Promise<void>((r) => {
			resolveStop = r;
		});
		const out = new CaptureStream();

		// The supervisor finishes cycle 0, schedules a snapshot write at
		// cycle:end, then idles. We resolve the stop signal as soon as the
		// stderr renderer reports cycle:end so the test doesn't block.
		const subscription = setInterval(() => {
			if (out.text.includes('] end (')) {
				resolveStop();
				clearInterval(subscription);
			}
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
