// Phase B (notes/parallel-graph-resolution.md §3.2) — `composeStackLayer`
// topological-level scheduler.
//
// Coverage focus:
//   1. Members in DIFFERENT topo levels build in the expected
//      provider-before-consumer order (cross-level edges visible via
//      `Layer.provideMerge` between levels).
//   2. Members in the SAME level build concurrently — siblings whose
//      build bodies block on a shared signal both make progress before
//      either resolves.
//   3. The scheduler still yields a single Effect Context with every
//      service across every level, satisfying downstream `Context.get`
//      calls from the supervisor's run loop.
//
// The tests build the layer with `Layer.build`, then assert against
// `Context.get` reads + a Ref-based start-order trace. No docker, no
// state-store; everything runs inside an Effect scope. Mirrors the
// shape `composeStackLayer` produces in production.

import { Context, Deferred, Effect, Layer, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { composeStackLayer, type StackMember } from './supervisor.js';
import { tag } from '../advanced/tag.js';

// Build a `StackMember` from a tag instance — the same shape
// `composeStackLayer` consumes in `defineDevstack`. Casts at the
// boundary because the runtime augmented `tag` extras don't surface
// in TS's `LayeredTag` shape.
const asMember = (t: unknown): StackMember => t as StackMember;

describe('composeStackLayer scheduler — cross-level ordering', () => {
	it.effect('a consumer declared after its provider via upstreamKeys still resolves', () =>
		Effect.gen(function* () {
			// Two tags: `provider` (leaf) and `consumer` (yields provider).
			// The consumer's build body reads from provider's resolved
			// value; the scheduler must put provider at a strictly-lower
			// level so the value is visible.
			const provider = tag('@test/scheduler/provider', Effect.succeed({ value: 'p' }), {
				upstreamKeys: [],
			});

			const consumer = tag(
				'@test/scheduler/consumer',
				Effect.gen(function* () {
					const p = yield* provider;
					return { upstream: p.value };
				}),
				{ upstreamKeys: [provider] },
			);

			const layer = composeStackLayer([asMember(provider), asMember(consumer)]);
			const ctx = yield* Layer.build(layer).pipe(Effect.scoped);
			expect(Context.get(ctx, consumer).upstream).toBe('p');
		}),
	);

	it.effect('declared upstreams resolve in level-then-input order (no fold required)', () =>
		Effect.gen(function* () {
			// Provider DECLARED after consumer in the input stack — only
			// the upstream declaration tells the scheduler what comes
			// first. The old `reduce(provideMerge)` fold would fail here
			// because consumer would be folded onto an accumulator that
			// hadn't seen provider yet; the topo scheduler routes around
			// it via levels.
			const provider = tag('@test/scheduler/p2', Effect.succeed({ value: 'p2' }), {
				upstreamKeys: [],
			});

			const consumer = tag(
				'@test/scheduler/c2',
				Effect.gen(function* () {
					const p = yield* provider;
					return { upstream: p.value };
				}),
				{ upstreamKeys: [provider] },
			);

			// Note: `consumer` comes FIRST in the stack. The dep graph
			// puts provider at level 0 anyway and consumer at level 1.
			const layer = composeStackLayer([asMember(consumer), asMember(provider)]);
			const ctx = yield* Layer.build(layer).pipe(Effect.scoped);
			expect(Context.get(ctx, consumer).upstream).toBe('p2');
		}),
	);
});

describe('composeStackLayer scheduler — same-level parallel build', () => {
	it.effect('two siblings with no cross-dep build concurrently', () =>
		Effect.gen(function* () {
			// Both leaves block on the SAME deferred. If they built
			// sequentially, the first would deadlock waiting for the
			// deferred and the second would never start; with parallel
			// build the second starts, completes the deferred, both
			// resolve.
			//
			// We seed both bodies with a join-point Ref that records the
			// "started" count. Sibling A waits for the count to reach 2
			// (both started) before completing — sibling B does the same.
			// Sequential build would never reach count=2; parallel build
			// does.
			const startedRef = yield* Ref.make(0);
			const startedBoth = yield* Deferred.make<void>();

			const makeSibling = (key: string) =>
				tag(
					key,
					Effect.gen(function* () {
						yield* Ref.update(startedRef, (n) => n + 1);
						const n = yield* Ref.get(startedRef);
						if (n >= 2) {
							yield* Deferred.succeed(startedBoth, void 0);
						}
						yield* Deferred.await(startedBoth);
						return { key };
					}),
					{ upstreamKeys: [] },
				);

			const a = makeSibling('@test/scheduler/sib-a');
			const b = makeSibling('@test/scheduler/sib-b');

			const layer = composeStackLayer([asMember(a), asMember(b)]);
			const ctx = yield* Layer.build(layer).pipe(Effect.scoped, Effect.timeout('2 seconds'));
			// Both siblings observed the other's start signal — proves
			// parallel build.
			expect(Context.get(ctx, a).key).toBe('@test/scheduler/sib-a');
			expect(Context.get(ctx, b).key).toBe('@test/scheduler/sib-b');
		}),
	);
});

describe('composeStackLayer scheduler — diamond resolution', () => {
	it.effect('two consumers of a shared provider both see the same instance', () =>
		Effect.gen(function* () {
			// sui ← walrus + seal. The provider builds once (Effect's
			// MemoMap deduplicates inside the user-layer scope) and both
			// consumers see the same value.
			const buildCount = yield* Ref.make(0);
			const provider = tag(
				'@test/scheduler/diamond-sui',
				Effect.gen(function* () {
					yield* Ref.update(buildCount, (n) => n + 1);
					return { chainId: 'fake-chain' };
				}),
				{ upstreamKeys: [] },
			);

			const walrus = tag(
				'@test/scheduler/diamond-walrus',
				Effect.gen(function* () {
					const sui = yield* provider;
					return { chain: sui.chainId };
				}),
				{ upstreamKeys: [provider] },
			);
			const seal = tag(
				'@test/scheduler/diamond-seal',
				Effect.gen(function* () {
					const sui = yield* provider;
					return { chain: sui.chainId };
				}),
				{ upstreamKeys: [provider] },
			);

			const layer = composeStackLayer([asMember(provider), asMember(walrus), asMember(seal)]);
			const ctx = yield* Layer.build(layer).pipe(Effect.scoped);

			// Provider built ONCE across the two consumer levels.
			expect(yield* Ref.get(buildCount)).toBe(1);
			// Both consumers received the same chain id.
			expect(Context.get(ctx, walrus).chain).toBe('fake-chain');
			expect(Context.get(ctx, seal).chain).toBe('fake-chain');
		}),
	);
});

describe('composeStackLayer scheduler — degenerate inputs', () => {
	it.effect('empty stack produces a buildable layer with no extra services', () =>
		Effect.gen(function* () {
			const layer = composeStackLayer([]);
			// Build + immediate scope close — exercises the no-levels path
			// in the scheduler (which seeds `Layer.empty`). No services
			// are exposed; the test passes by not throwing.
			yield* Layer.build(layer).pipe(Effect.scoped);
		}),
	);

	it.effect('un-keyed hand-rolled layers still ship via level 0', () =>
		Effect.gen(function* () {
			// Hand-rolled `Layer.succeed` carries no `key`, no
			// `__upstreamKeys`. `composeStackLayer` lifts it into level
			// 0 alongside the keyed leaves, where it's visible to
			// downstream consumers.
			class Marker extends Context.Service<Marker, { readonly value: string }>()(
				'@test/scheduler/hand-rolled-marker',
			) {}
			const handRolled = Layer.succeed(Marker, { value: 'hand-rolled' });

			const consumer = tag(
				'@test/scheduler/hr-consumer',
				Effect.gen(function* () {
					const m = yield* Marker;
					return { mirror: m.value };
				}),
				{ upstreamKeys: [] }, // can't reference an unkeyed layer; the body's yield* drives the wiring.
			);

			// `__layer` is the only required field for a hand-rolled
			// stack member; `__layers` / `key` / `__upstreamKeys` are
			// omitted. The scheduler treats it as a level-0 leaf via the
			// unkeyed bucket.
			const handRolledMember: StackMember = {
				__layer: handRolled as unknown as Layer.Layer<unknown, unknown, never>,
			};
			const layer = composeStackLayer([handRolledMember, asMember(consumer)]);
			const ctx = yield* Layer.build(layer).pipe(Effect.scoped);
			expect(Context.get(ctx, consumer).mirror).toBe('hand-rolled');
		}),
	);
});
