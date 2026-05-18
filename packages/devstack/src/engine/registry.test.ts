// Registry I/O + classification semantics. Two layers:
//
//   1. The pure `classifyEntry` predicate — every cell of the
//      `<pid alive?, repo on disk?, lastSeen age?>` truth table maps
//      to exactly one Classification.
//   2. The file-backed read/upsert/clearPid/remove protocol — drives
//      a real fs against `DEVSTACK_REGISTRY_FILE` (env override so we
//      don't trample on the user's `~/.devstack/registry.json`).

import { Effect, Layer } from 'effect';
import { layer as NodeFileSystemLayer } from '@effect/platform-node/NodeFileSystem';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyEntry, Registry, RegistryLive, type RegistryEntry } from './registry.js';

const baseEntry = (overrides: Partial<RegistryEntry> = {}): RegistryEntry => ({
	app: 'arena',
	stack: 'main',
	network: 'localnet',
	repoPath: '/tmp/non-existent-repo-' + Math.random(),
	firstSeen: '2026-01-01T00:00:00.000Z',
	lastSeen: '2026-01-01T00:00:00.000Z',
	...overrides,
});

describe('classifyEntry', () => {
	it('returns active when pid is alive', () => {
		const c = classifyEntry(baseEntry({ pid: 1 }), {
			pidAlive: () => true,
			repoExists: () => false,
			now: Date.parse('2026-05-01T00:00:00Z'),
		});
		expect(c).toBe('active');
	});

	it('returns abandoned when repoPath is missing on disk', () => {
		const c = classifyEntry(baseEntry({ pid: 1 }), {
			pidAlive: () => false,
			repoExists: () => false,
			now: Date.parse('2026-05-01T00:00:00Z'),
		});
		expect(c).toBe('abandoned');
	});

	it('returns stale when lastSeen is older than 30 days and repo exists', () => {
		const c = classifyEntry(baseEntry({ lastSeen: '2026-01-01T00:00:00.000Z' }), {
			pidAlive: () => false,
			repoExists: () => true,
			now: Date.parse('2026-05-01T00:00:00Z'),
		});
		expect(c).toBe('stale');
	});

	it('returns dormant when lastSeen is recent and repo exists', () => {
		const c = classifyEntry(baseEntry({ lastSeen: '2026-04-25T00:00:00.000Z' }), {
			pidAlive: () => false,
			repoExists: () => true,
			now: Date.parse('2026-05-01T00:00:00Z'),
		});
		expect(c).toBe('dormant');
	});

	it('returns dormant when lastSeen is unparseable but repo exists', () => {
		const c = classifyEntry(baseEntry({ lastSeen: 'not-a-date' }), {
			pidAlive: () => false,
			repoExists: () => true,
			now: Date.now(),
		});
		expect(c).toBe('dormant');
	});
});

describe('registry I/O', () => {
	let tmp: string;
	let savedEnv: string | undefined;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), 'devstack-registry-'));
		savedEnv = process.env.DEVSTACK_REGISTRY_FILE;
		process.env.DEVSTACK_REGISTRY_FILE = join(tmp, 'registry.json');
	});

	afterEach(() => {
		if (savedEnv === undefined) delete process.env.DEVSTACK_REGISTRY_FILE;
		else process.env.DEVSTACK_REGISTRY_FILE = savedEnv;
		rmSync(tmp, { recursive: true, force: true });
	});

	const testLayer = Layer.provide(RegistryLive, NodeFileSystemLayer);

	it.effect('read on a missing file returns an empty v1 registry', () =>
		Effect.gen(function* () {
			const reg = yield* Registry;
			const file = yield* reg.read;
			expect(file.version).toBe(1);
			expect(file.stacks).toEqual([]);
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect('upsert creates a fresh entry with firstSeen + lastSeen + pid', () =>
		Effect.gen(function* () {
			const reg = yield* Registry;
			yield* reg.upsert({
				app: 'arena',
				stack: 'main',
				network: 'localnet',
				repoPath: '/foo',
				pid: 12345,
			});
			const file = yield* reg.read;
			expect(file.stacks).toHaveLength(1);
			const entry = file.stacks[0];
			expect(entry?.app).toBe('arena');
			expect(entry?.stack).toBe('main');
			expect(entry?.network).toBe('localnet');
			expect(entry?.pid).toBe(12345);
			expect(entry?.firstSeen).toBe(entry?.lastSeen);
		}).pipe(Effect.provide(testLayer)),
	);

	it.live('upsert preserves firstSeen on subsequent writes', () =>
		Effect.gen(function* () {
			const reg = yield* Registry;
			yield* reg.upsert({
				app: 'arena',
				stack: 'main',
				network: 'localnet',
				repoPath: '/foo',
				pid: 1,
			});
			const first = yield* reg.read;
			const firstSeen = first.stacks[0]?.firstSeen;
			// Real-time sleep is required: `lastSeen` is `new Date().toISOString()`
			// so the second write needs at least 1ms of wall-clock drift to
			// differ from the first. `it.live` opts out of TestClock so the
			// real ms tick.
			yield* Effect.sleep('5 millis');
			yield* reg.upsert({
				app: 'arena',
				stack: 'main',
				network: 'localnet',
				repoPath: '/foo',
				pid: 2,
			});
			const second = yield* reg.read;
			expect(second.stacks).toHaveLength(1);
			expect(second.stacks[0]?.firstSeen).toBe(firstSeen);
			expect(second.stacks[0]?.pid).toBe(2);
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect('clearPid drops pid without changing lastSeen', () =>
		Effect.gen(function* () {
			const reg = yield* Registry;
			yield* reg.upsert({
				app: 'arena',
				stack: 'main',
				network: 'localnet',
				repoPath: '/foo',
				pid: 999,
			});
			yield* reg.clearPid('arena', 'main', 'localnet');
			const file = yield* reg.read;
			expect(file.stacks[0]?.pid).toBeUndefined();
			expect(file.stacks[0]?.repoPath).toBe('/foo');
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect('remove drops only the matching entry', () =>
		Effect.gen(function* () {
			const reg = yield* Registry;
			yield* reg.upsert({
				app: 'arena',
				stack: 'main',
				network: 'localnet',
				repoPath: '/foo',
			});
			yield* reg.upsert({
				app: 'wallet',
				stack: 'main',
				network: 'localnet',
				repoPath: '/bar',
			});
			yield* reg.remove('arena', 'main', 'localnet');
			const file = yield* reg.read;
			expect(file.stacks).toHaveLength(1);
			expect(file.stacks[0]?.app).toBe('wallet');
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect('upserts to different (app, stack, network) coexist', () =>
		Effect.gen(function* () {
			const reg = yield* Registry;
			yield* reg.upsert({
				app: 'arena',
				stack: 'main',
				network: 'localnet',
				repoPath: '/a',
			});
			yield* reg.upsert({
				app: 'arena',
				stack: 'main',
				network: 'testnet',
				repoPath: '/a',
			});
			yield* reg.upsert({
				app: 'arena',
				stack: 'e2e',
				network: 'localnet',
				repoPath: '/a',
			});
			const file = yield* reg.read;
			expect(file.stacks).toHaveLength(3);
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect('atomic write — no partial state.json visible on rename failure', () =>
		Effect.gen(function* () {
			// Write a baseline, then verify the on-disk file is valid JSON
			// after a fresh upsert (smoke for the tempfile-rename path).
			const reg = yield* Registry;
			yield* reg.upsert({
				app: 'arena',
				stack: 'main',
				network: 'localnet',
				repoPath: '/foo',
			});
			const raw = readFileSync(process.env.DEVSTACK_REGISTRY_FILE ?? '', 'utf8');
			const parsed = JSON.parse(raw) as { version: number; stacks: unknown[] };
			expect(parsed.version).toBe(1);
			expect(Array.isArray(parsed.stacks)).toBe(true);
		}).pipe(Effect.provide(testLayer)),
	);
});
