// Cross-service log store tests.
//
// Invariants under test:
//   1. Append assigns a monotonic `seq` and returns newest-first on query.
//   2. The ring is bounded: appends past capacity drop the oldest record.
//   3. Filters compose (service / level / search / sinceMillis) and `limit`
//      caps the newest-first result.
//   4. `services` reports the distinct sorted service set.

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	applyLogFilter,
	makeLogStore,
	type LogRecord,
} from '../../../../src/substrate/runtime/observability/log-store.ts';

describe('LogStore', () => {
	it.effect('assigns monotonic seq and returns newest-first', () =>
		Effect.gen(function* () {
			const store = yield* makeLogStore(100);
			yield* store.append({ level: 'info', service: 'a', message: 'one' });
			yield* store.append({ level: 'warn', service: 'b', message: 'two' });
			const out = yield* store.query();
			expect(out.map((r) => r.message)).toEqual(['two', 'one']);
			expect(out.map((r) => r.seq)).toEqual([1, 0]);
		}),
	);

	it.effect('bounds the ring to capacity (drops oldest)', () =>
		Effect.gen(function* () {
			const store = yield* makeLogStore(3);
			for (let i = 0; i < 5; i += 1) {
				yield* store.append({ level: 'info', service: 's', message: `m${i}` });
			}
			const out = yield* store.query();
			expect(out.map((r) => r.message)).toEqual(['m4', 'm3', 'm2']);
		}),
	);

	it.effect('applies service / level / search filters and limit', () =>
		Effect.gen(function* () {
			const store = yield* makeLogStore(100);
			yield* store.append({ level: 'info', service: 'pg', message: 'boot ok' });
			yield* store.append({ level: 'error', service: 'pg', message: 'boot FAILED' });
			yield* store.append({ level: 'info', service: 'sui', message: 'ready' });

			const byService = yield* store.query({ services: ['pg'] });
			expect(byService.map((r) => r.message)).toEqual(['boot FAILED', 'boot ok']);

			const byLevel = yield* store.query({ levels: ['error'] });
			expect(byLevel.map((r) => r.message)).toEqual(['boot FAILED']);

			const bySearch = yield* store.query({ search: 'failed' });
			expect(bySearch.map((r) => r.message)).toEqual(['boot FAILED']);

			const limited = yield* store.query({ limit: 1 });
			expect(limited).toHaveLength(1);
			expect(limited[0]!.message).toBe('ready');
		}),
	);

	it.effect('services reports distinct sorted set', () =>
		Effect.gen(function* () {
			const store = yield* makeLogStore(100);
			yield* store.append({ level: 'info', service: 'sui', message: 'x' });
			yield* store.append({ level: 'info', service: 'pg', message: 'y' });
			yield* store.append({ level: 'info', service: 'pg', message: 'z' });
			expect(yield* store.services).toEqual(['pg', 'sui']);
		}),
	);

	it('applyLogFilter honors sinceMillis', () => {
		const records: LogRecord[] = [
			{ seq: 0, timestampMillis: 100, level: 'info', service: 'a', message: 'old', fields: {} },
			{ seq: 1, timestampMillis: 200, level: 'info', service: 'a', message: 'new', fields: {} },
		];
		const out = applyLogFilter(records, { sinceMillis: 150 }, 100);
		expect(out.map((r) => r.message)).toEqual(['new']);
	});
});
