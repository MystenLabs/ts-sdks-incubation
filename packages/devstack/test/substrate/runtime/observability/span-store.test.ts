// Span store + recording tracer tests.
//
// Invariants under test:
//   1. The recording Tracer captures completed `Effect.withSpan` spans into
//      the ring with name / service (from `devstack.plugin`) / status.
//   2. A failed effect's span records `status: 'error'`.
//   3. Parent/child spans share a traceId and the child records its
//      parentId.
//   4. Filters compose (service / status / search) and `limit` caps.
//   5. The ring is bounded to capacity.

import { Effect, Fiber, Tracer } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	applySpanFilter,
	makeSpanStore,
	type SpanRecord,
} from '../../../../src/substrate/runtime/observability/span-store.ts';
import { SpanAttr } from '../../../../src/substrate/runtime/observability/spans.ts';

describe('SpanStore + recording tracer', () => {
	it.effect('records a completed span with name + service + ok status', () =>
		Effect.gen(function* () {
			const store = yield* makeSpanStore(100);
			yield* Effect.succeed(1).pipe(
				Effect.withSpan('acquire-node', { attributes: { [SpanAttr.plugin]: 'postgres' } }),
				Effect.provideService(Tracer.Tracer, store.tracer),
			);
			const spans = yield* store.query();
			expect(spans).toHaveLength(1);
			expect(spans[0]!.name).toBe('acquire-node');
			expect(spans[0]!.service).toBe('postgres');
			expect(spans[0]!.status).toBe('ok');
			expect(spans[0]!.durationMillis).toBeGreaterThanOrEqual(0);
		}),
	);

	it.effect('records error status for a failed effect', () =>
		Effect.gen(function* () {
			const store = yield* makeSpanStore(100);
			yield* Effect.fail('boom').pipe(
				Effect.withSpan('failing-op', { attributes: { [SpanAttr.plugin]: 'sui' } }),
				Effect.provideService(Tracer.Tracer, store.tracer),
				Effect.catch(() => Effect.void),
			);
			const spans = yield* store.query();
			expect(spans).toHaveLength(1);
			expect(spans[0]!.status).toBe('error');
			expect(spans[0]!.service).toBe('sui');
		}),
	);

	it.effect('child span shares traceId and records parentId', () =>
		Effect.gen(function* () {
			const store = yield* makeSpanStore(100);
			yield* Effect.void.pipe(
				Effect.withSpan('child'),
				Effect.withSpan('parent'),
				Effect.provideService(Tracer.Tracer, store.tracer),
			);
			const spans = yield* store.query();
			const child = spans.find((s) => s.name === 'child')!;
			const parent = spans.find((s) => s.name === 'parent')!;
			expect(child).toBeDefined();
			expect(parent).toBeDefined();
			expect(child.traceId).toBe(parent.traceId);
			expect(child.parentId).toBe(parent.spanId);
			expect(parent.parentId).toBeNull();
		}),
	);

	it.effect('derives service from span-name head when no plugin attribute', () =>
		Effect.gen(function* () {
			const store = yield* makeSpanStore(100);
			yield* Effect.void.pipe(
				Effect.withSpan('lifecycle.supervisor.runCommand'),
				Effect.provideService(Tracer.Tracer, store.tracer),
			);
			const spans = yield* store.query();
			expect(spans[0]!.service).toBe('lifecycle');
		}),
	);

	it.effect('derives plugin name from a devstack.plugin.<name>.… span name', () =>
		Effect.gen(function* () {
			const store = yield* makeSpanStore(100);
			yield* Effect.void.pipe(
				// Attribute-less plugin span: the `devstack.plugin.<name>.` prefix
				// recovers `<name>` rather than bucketing under the shared `devstack`.
				Effect.withSpan('devstack.plugin.postgres.acquire'),
				Effect.provideService(Tracer.Tracer, store.tracer),
			);
			const spans = yield* store.query();
			expect(spans[0]!.service).toBe('postgres');
		}),
	);

	it('applySpanFilter composes service/status/search and limit', () => {
		const records: SpanRecord[] = [
			{
				traceId: 't',
				spanId: '1',
				parentId: null,
				name: 'acquire-node',
				service: 'pg',
				startMillis: 100,
				durationMillis: 5,
				status: 'ok',
				attributes: {},
			},
			{
				traceId: 't',
				spanId: '2',
				parentId: null,
				name: 'boot',
				service: 'pg',
				startMillis: 200,
				durationMillis: 5,
				status: 'error',
				attributes: {},
			},
			{
				traceId: 't',
				spanId: '3',
				parentId: null,
				name: 'ready',
				service: 'sui',
				startMillis: 300,
				durationMillis: 5,
				status: 'ok',
				attributes: {},
			},
		];
		expect(applySpanFilter(records, { services: ['pg'] }, 100).map((s) => s.name)).toEqual([
			'boot',
			'acquire-node',
		]);
		expect(applySpanFilter(records, { statuses: ['error'] }, 100).map((s) => s.name)).toEqual([
			'boot',
		]);
		expect(applySpanFilter(records, { search: 'acquire' }, 100).map((s) => s.name)).toEqual([
			'acquire-node',
		]);
		expect(applySpanFilter(records, { limit: 1 }, 100).map((s) => s.name)).toEqual(['ready']);
	});

	it.effect('a fork under a tracer-bearing context records its spans', () =>
		// Pins the supervisor-wiring assumption: `startSupervisor` provides
		// `spanStore.tracer` onto its own effects so `Effect.forkScoped`'d
		// fibers (command loop, background tasks) inherit it and their
		// `lifecycle.supervisor.*` spans land in the ring — instead of hitting
		// the default no-op tracer and evaporating.
		Effect.gen(function* () {
			const store = yield* makeSpanStore(100);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const fiber = yield* Effect.forkScoped(
						Effect.void.pipe(Effect.withSpan('lifecycle.supervisor.runCommand')),
					);
					yield* Fiber.join(fiber);
				}).pipe(Effect.provideService(Tracer.Tracer, store.tracer)),
			);
			const spans = yield* store.query();
			expect(spans.map((s) => s.name)).toContain('lifecycle.supervisor.runCommand');
		}),
	);

	it.effect('bounds the ring to capacity', () =>
		Effect.gen(function* () {
			const store = yield* makeSpanStore(2);
			for (let i = 0; i < 4; i += 1) {
				yield* Effect.void.pipe(
					Effect.withSpan(`op-${i}`),
					Effect.provideService(Tracer.Tracer, store.tracer),
				);
			}
			const spans = yield* store.query();
			expect(spans.map((s) => s.name)).toEqual(['op-3', 'op-2']);
		}),
	);
});
