// Cross-service log store tests.
//
// Invariants under test:
//   1. Append assigns a monotonic `seq` and queries return newest-first.
//   2. PER-SERVICE rings: a noisy service evicts only ITS OWN old records —
//      it can NOT evict a quiet service's records (the core fix).
//   3. `perServiceCapacity` bounds each ring independently (drops oldest).
//   4. `maxServices` bounds the ring count; eviction PREFERS to retain
//      error-bearing rings (a crashed service's error trail survives a chatty
//      all-`info` service).
//   5. Cross-service `query` merges all rings, orders newest-first by `seq`,
//      and composes filters (service / level / search / sinceMillis) + limit.
//   6. `services` reports the distinct sorted ring set.
//   7. Config resolution honors explicit options > env vars > defaults.

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	applyLogFilter,
	makeLogStore,
	pickEvictionVictim,
	queryRings,
	resolveLogStoreConfig,
	DEFAULT_PER_SERVICE_CAPACITY,
	DEFAULT_MAX_SERVICES,
	ENV_PER_SERVICE_CAPACITY,
	ENV_MAX_SERVICES,
	type LogRecord,
} from '../../../../src/substrate/runtime/observability/log-store.ts';

describe('LogStore', () => {
	it.effect('assigns monotonic seq and returns newest-first', () =>
		Effect.gen(function* () {
			const store = yield* makeLogStore({ perServiceCapacity: 100 });
			yield* store.append({ level: 'info', service: 'a', message: 'one' });
			yield* store.append({ level: 'warn', service: 'b', message: 'two' });
			const out = yield* store.query();
			expect(out.map((r) => r.message)).toEqual(['two', 'one']);
			expect(out.map((r) => r.seq)).toEqual([1, 0]);
		}),
	);

	it.effect('per-service isolation: a noisy service does NOT evict a quiet one', () =>
		Effect.gen(function* () {
			// Tiny per-service cap; plenty of distinct-ring headroom.
			const store = yield* makeLogStore({ perServiceCapacity: 3, maxServices: 16 });

			// Quiet service logs ONE error then goes silent.
			yield* store.append({ level: 'error', service: 'quiet', message: 'CRASHED' });

			// Noisy service floods well past the global old capacity (5000).
			for (let i = 0; i < 50; i += 1) {
				yield* store.append({ level: 'info', service: 'noisy', message: `spam ${i}` });
			}

			// The quiet service's error is STILL retained — the old single-ring
			// design would have evicted it long ago.
			const quietLogs = yield* store.query({ services: ['quiet'] });
			expect(quietLogs.map((r) => r.message)).toEqual(['CRASHED']);

			// The noisy ring is bounded to its own capacity (3), not the quiet
			// ring's records.
			const noisyLogs = yield* store.query({ services: ['noisy'] });
			expect(noisyLogs.map((r) => r.message)).toEqual(['spam 49', 'spam 48', 'spam 47']);
		}),
	);

	it.effect('perServiceCapacity bounds each ring (drops oldest)', () =>
		Effect.gen(function* () {
			const store = yield* makeLogStore({ perServiceCapacity: 3 });
			for (let i = 0; i < 5; i += 1) {
				yield* store.append({ level: 'info', service: 's', message: `m${i}` });
			}
			const out = yield* store.query();
			expect(out.map((r) => r.message)).toEqual(['m4', 'm3', 'm2']);
		}),
	);

	it.effect('maxServices eviction prefers to RETAIN error-bearing rings', () =>
		Effect.gen(function* () {
			// Room for exactly 2 rings.
			const store = yield* makeLogStore({ perServiceCapacity: 10, maxServices: 2 });

			// svc-a: an old error trail (the thing we must NOT lose).
			yield* store.append({
				level: 'error',
				service: 'svc-a',
				message: 'boom',
				timestampMillis: 1_000,
			});
			// svc-b: a chatty all-info ring, newer activity.
			yield* store.append({
				level: 'info',
				service: 'svc-b',
				message: 'chatter',
				timestampMillis: 5_000,
			});

			// A third service arrives → must evict one ring. Even though svc-a
			// is the LEAST recently active, it carries an error so it is
			// retained; the error-free svc-b is dropped instead.
			yield* store.append({
				level: 'info',
				service: 'svc-c',
				message: 'new',
				timestampMillis: 6_000,
			});

			const services = yield* store.services;
			expect(services).toEqual(['svc-a', 'svc-c']);

			const errTrail = yield* store.query({ services: ['svc-a'] });
			expect(errTrail.map((r) => r.message)).toEqual(['boom']);
		}),
	);

	it.effect('maxServices eviction falls back to LRU when all rings carry errors', () =>
		Effect.gen(function* () {
			const store = yield* makeLogStore({ perServiceCapacity: 10, maxServices: 2 });
			yield* store.append({
				level: 'error',
				service: 'old',
				message: 'e1',
				timestampMillis: 1_000,
			});
			yield* store.append({
				level: 'error',
				service: 'recent',
				message: 'e2',
				timestampMillis: 9_000,
			});
			// New service; both existing rings carry an error → evict the one
			// whose newest record is oldest ('old').
			yield* store.append({
				level: 'error',
				service: 'fresh',
				message: 'e3',
				timestampMillis: 10_000,
			});
			expect(yield* store.services).toEqual(['fresh', 'recent']);
		}),
	);

	it.effect('cross-service query merges rings newest-first by seq', () =>
		Effect.gen(function* () {
			const store = yield* makeLogStore({ perServiceCapacity: 100 });
			// Interleave appends across services; seq is the global cursor.
			yield* store.append({ level: 'info', service: 'a', message: 'a0' });
			yield* store.append({ level: 'info', service: 'b', message: 'b0' });
			yield* store.append({ level: 'info', service: 'a', message: 'a1' });
			yield* store.append({ level: 'info', service: 'c', message: 'c0' });
			yield* store.append({ level: 'info', service: 'b', message: 'b1' });

			const out = yield* store.query();
			expect(out.map((r) => r.message)).toEqual(['b1', 'c0', 'a1', 'b0', 'a0']);
			expect(out.map((r) => r.seq)).toEqual([4, 3, 2, 1, 0]);
		}),
	);

	it.effect('applies service / level / search filters and limit across rings', () =>
		Effect.gen(function* () {
			const store = yield* makeLogStore({ perServiceCapacity: 100 });
			yield* store.append({ level: 'info', service: 'pg', message: 'boot ok' });
			yield* store.append({ level: 'error', service: 'pg', message: 'boot FAILED' });
			yield* store.append({ level: 'info', service: 'sui', message: 'ready' });

			const byService = yield* store.query({ services: ['pg'] });
			expect(byService.map((r) => r.message)).toEqual(['boot FAILED', 'boot ok']);

			const byLevel = yield* store.query({ levels: ['error'] });
			expect(byLevel.map((r) => r.message)).toEqual(['boot FAILED']);

			const bySearch = yield* store.query({ search: 'failed' });
			expect(bySearch.map((r) => r.message)).toEqual(['boot FAILED']);

			// Limit caps the newest-first merged stream.
			const limited = yield* store.query({ limit: 1 });
			expect(limited).toHaveLength(1);
			expect(limited[0]!.message).toBe('ready');
		}),
	);

	it.effect('services reports distinct sorted set', () =>
		Effect.gen(function* () {
			const store = yield* makeLogStore({ perServiceCapacity: 100 });
			yield* store.append({ level: 'info', service: 'sui', message: 'x' });
			yield* store.append({ level: 'info', service: 'pg', message: 'y' });
			yield* store.append({ level: 'info', service: 'pg', message: 'z' });
			expect(yield* store.services).toEqual(['pg', 'sui']);
		}),
	);
});

describe('queryRings / applyLogFilter (pure)', () => {
	const rec = (
		seq: number,
		service: string,
		timestampMillis: number,
		level: LogRecord['level'] = 'info',
		message = `m${seq}`,
	): LogRecord => ({ seq, timestampMillis, level, service, message, fields: {} });

	it('queryRings honors sinceMillis across rings', () => {
		const rings = new Map([
			['a', { records: [rec(0, 'a', 100), rec(2, 'a', 300)], hasError: false }],
			['b', { records: [rec(1, 'b', 200)], hasError: false }],
		]);
		const out = queryRings(rings, { sinceMillis: 150 }, 100);
		expect(out.map((r) => r.seq)).toEqual([2, 1]);
	});

	it('queryRings returns [] for empty rings and non-positive limit', () => {
		expect(queryRings(new Map(), undefined, 100)).toEqual([]);
		const rings = new Map([['a', { records: [rec(0, 'a', 1)], hasError: false }]]);
		expect(queryRings(rings, { limit: 0 }, 100)).toEqual([]);
	});

	it('applyLogFilter honors sinceMillis (flat array)', () => {
		const records: LogRecord[] = [rec(0, 'a', 100, 'info', 'old'), rec(1, 'a', 200, 'info', 'new')];
		const out = applyLogFilter(records, { sinceMillis: 150 }, 100);
		expect(out.map((r) => r.message)).toEqual(['new']);
	});

	it('pickEvictionVictim prefers an error-free ring over an error-bearing one', () => {
		const rings = new Map([
			// error-bearing but least recently active
			['err', { records: [rec(0, 'err', 1_000, 'error')], hasError: true }],
			// error-free, more recent
			['ok', { records: [rec(1, 'ok', 5_000)], hasError: false }],
		]);
		expect(pickEvictionVictim(rings)).toBe('ok');
	});

	it('pickEvictionVictim falls back to oldest-newest LRU when all carry errors', () => {
		const rings = new Map([
			['old', { records: [rec(0, 'old', 1_000, 'error')], hasError: true }],
			['recent', { records: [rec(1, 'recent', 9_000, 'fatal')], hasError: true }],
		]);
		expect(pickEvictionVictim(rings)).toBe('old');
	});

	it('pickEvictionVictim returns null for no rings', () => {
		expect(pickEvictionVictim(new Map())).toBeNull();
	});
});

describe('resolveLogStoreConfig', () => {
	it('uses module defaults with no config or env', () => {
		const r = resolveLogStoreConfig({}, {});
		expect(r.perServiceCapacity).toBe(DEFAULT_PER_SERVICE_CAPACITY);
		expect(r.maxServices).toBe(DEFAULT_MAX_SERVICES);
	});

	it('reads env vars when config is absent', () => {
		const r = resolveLogStoreConfig(
			{},
			{ [ENV_PER_SERVICE_CAPACITY]: '50', [ENV_MAX_SERVICES]: '7' },
		);
		expect(r.perServiceCapacity).toBe(50);
		expect(r.maxServices).toBe(7);
	});

	it('explicit config wins over env vars', () => {
		const r = resolveLogStoreConfig(
			{ perServiceCapacity: 11, maxServices: 3 },
			{ [ENV_PER_SERVICE_CAPACITY]: '50', [ENV_MAX_SERVICES]: '7' },
		);
		expect(r.perServiceCapacity).toBe(11);
		expect(r.maxServices).toBe(3);
	});

	it('falls back to defaults for non-numeric / non-positive env', () => {
		const r = resolveLogStoreConfig(
			{},
			{ [ENV_PER_SERVICE_CAPACITY]: 'nope', [ENV_MAX_SERVICES]: '0' },
		);
		expect(r.perServiceCapacity).toBe(DEFAULT_PER_SERVICE_CAPACITY);
		expect(r.maxServices).toBe(DEFAULT_MAX_SERVICES);
	});
});
