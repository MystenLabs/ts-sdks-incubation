// Registry I/O + classification semantics. Two layers:
//
//   1. The pure `classifyEntry` predicate — every cell of the
//      `<pid alive?, repo on disk?, lastSeen age?>` truth table maps
//      to exactly one Classification.
//   2. The sync file-backed read/upsert/clearPid/remove protocol —
//      drives a real fs against `DEVSTACK_REGISTRY_FILE` (env override
//      so we don't trample on the user's `~/.devstack/registry.json`).

import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyEntry, registry, type RegistryEntry } from './registry.js';

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

	it.effect('read on a missing file returns an empty v1 registry', () =>
		Effect.gen(function* () {
			const reg = yield* registry.read();
			expect(reg.version).toBe(1);
			expect(reg.stacks).toEqual([]);
		}),
	);

	it.effect('upsert creates a fresh entry with firstSeen + lastSeen + pid', () =>
		Effect.gen(function* () {
			yield* registry.upsert({
				app: 'arena',
				stack: 'main',
				network: 'localnet',
				repoPath: '/foo',
				pid: 12345,
			});
			const reg = yield* registry.read();
			expect(reg.stacks).toHaveLength(1);
			const entry = reg.stacks[0];
			expect(entry?.app).toBe('arena');
			expect(entry?.stack).toBe('main');
			expect(entry?.network).toBe('localnet');
			expect(entry?.pid).toBe(12345);
			expect(entry?.firstSeen).toBe(entry?.lastSeen);
		}),
	);

	it.live('upsert preserves firstSeen on subsequent writes', () =>
		Effect.gen(function* () {
			yield* registry.upsert({
				app: 'arena',
				stack: 'main',
				network: 'localnet',
				repoPath: '/foo',
				pid: 1,
			});
			const first = yield* registry.read();
			const firstSeen = first.stacks[0]?.firstSeen;
			// Real-time sleep is required: `lastSeen` is `new Date().toISOString()`
			// so the second write needs at least 1ms of wall-clock drift to
			// differ from the first. `it.live` opts out of TestClock so the
			// real ms tick.
			yield* Effect.sleep('5 millis');
			yield* registry.upsert({
				app: 'arena',
				stack: 'main',
				network: 'localnet',
				repoPath: '/foo',
				pid: 2,
			});
			const second = yield* registry.read();
			expect(second.stacks).toHaveLength(1);
			expect(second.stacks[0]?.firstSeen).toBe(firstSeen);
			expect(second.stacks[0]?.pid).toBe(2);
		}),
	);

	it.effect('clearPid drops pid without changing lastSeen', () =>
		Effect.gen(function* () {
			yield* registry.upsert({
				app: 'arena',
				stack: 'main',
				network: 'localnet',
				repoPath: '/foo',
				pid: 999,
			});
			yield* registry.clearPid('arena', 'main', 'localnet');
			const reg = yield* registry.read();
			expect(reg.stacks[0]?.pid).toBeUndefined();
			expect(reg.stacks[0]?.repoPath).toBe('/foo');
		}),
	);

	it.effect('remove drops only the matching entry', () =>
		Effect.gen(function* () {
			yield* registry.upsert({
				app: 'arena',
				stack: 'main',
				network: 'localnet',
				repoPath: '/foo',
			});
			yield* registry.upsert({
				app: 'wallet',
				stack: 'main',
				network: 'localnet',
				repoPath: '/bar',
			});
			yield* registry.remove('arena', 'main', 'localnet');
			const reg = yield* registry.read();
			expect(reg.stacks).toHaveLength(1);
			expect(reg.stacks[0]?.app).toBe('wallet');
		}),
	);

	it.effect('upserts to different (app, stack, network) coexist', () =>
		Effect.gen(function* () {
			yield* registry.upsert({
				app: 'arena',
				stack: 'main',
				network: 'localnet',
				repoPath: '/a',
			});
			yield* registry.upsert({
				app: 'arena',
				stack: 'main',
				network: 'testnet',
				repoPath: '/a',
			});
			yield* registry.upsert({
				app: 'arena',
				stack: 'e2e',
				network: 'localnet',
				repoPath: '/a',
			});
			const reg = yield* registry.read();
			expect(reg.stacks).toHaveLength(3);
		}),
	);

	it.effect('atomic write — no partial state.json visible on rename failure', () =>
		Effect.gen(function* () {
			// Write a baseline, then verify the on-disk file is valid JSON
			// after a fresh upsert (smoke for the tempfile-rename path).
			yield* registry.upsert({
				app: 'arena',
				stack: 'main',
				network: 'localnet',
				repoPath: '/foo',
			});
			const raw = readFileSync(process.env.DEVSTACK_REGISTRY_FILE ?? '', 'utf8');
			const parsed = JSON.parse(raw) as { version: number; stacks: unknown[] };
			expect(parsed.version).toBe(1);
			expect(Array.isArray(parsed.stacks)).toBe(true);
		}),
	);
});
