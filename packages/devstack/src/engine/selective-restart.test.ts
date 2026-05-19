// End-to-end integration test for Phase 3 of `notes/selective-restart.md`.
//
// What this pins
// ---
// The selective-restart contract: when a watch fires for primitive K,
// (a) K + its strictly-downstream consumers re-acquire (their build
// bodies re-run, their finalizers ran in between), AND (b) every other
// primitive in the stack keeps its build body's result + its scope
// alive (its finalizer did NOT fire).
//
// We stage four primitives with a 4-node dep chain:
//
//   sui ← package ← codegen ← dev
//
// `package` declares `watch:` against a temp directory ("Move sources").
// We touch that directory, observe:
//   - `package` + `codegen` + `dev` re-ran their build bodies (acquire
//     count incremented).
//   - `sui`'s build body did NOT re-run.
//   - `package`'s finalizer fired before its re-acquire; `sui`'s did not.
//
// Why this lives at the engine layer rather than under `tui/` or
// `supervisor.test.ts`: the supervisor test infra is dominated by
// real-docker fixtures; this test uses pure in-memory tags with a
// hand-rolled watch-fire driver so the assertion surface is the
// engine + tag-substrate contract, not the docker-runner.
//
// Test gate row: P3.T4 in `notes/selective-restart.md`.

import { Context, Effect, Layer, Ref, Scope } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import {
	buildDepGraph,
	computeDownstreamClosure,
	type DownstreamClosure,
} from './dep-graph.js';
import { EngineHandle, EngineLive, type EngineHandleShape } from './engine.js';

type Acquires = {
	readonly counts: Ref.Ref<ReadonlyMap<string, number>>;
	readonly finalizers: Ref.Ref<ReadonlyMap<string, number>>;
};

const bump = (
	ref: Ref.Ref<ReadonlyMap<string, number>>,
	key: string,
): Effect.Effect<void> =>
	Ref.update(ref, (m) => {
		const next = new Map(m);
		next.set(key, (m.get(key) ?? 0) + 1);
		return next;
	});

// Build a primitive: every acquire increments its acquire counter,
// every scope close increments its finalizer counter, and the build
// registers its ambient scope with the engine so `invalidateSubset`
// can target it. The build runs inside its own forked sub-scope (mimicking
// what Effect's MemoMap does for each `Layer.effect` entry) so per-primitive
// teardown via `invalidateSubset` doesn't cascade to siblings.
const makePrimitive = (
	key: string,
	acquires: Acquires,
): {
	readonly key: string;
	readonly __watchPaths: ReadonlyArray<string>;
	readonly __upstreamKeys: ReadonlyArray<string>;
	readonly acquire: Effect.Effect<void, never, EngineHandle | Scope.Scope>;
} => ({
	key,
	__watchPaths: [],
	__upstreamKeys: [],
	acquire: Effect.gen(function* () {
		const outer = yield* Effect.scope;
		const engine = yield* EngineHandle;
		// Fork a sub-scope off the outer (cycle) scope — this is what
		// `Layer.effect` does for each entry via its MemoMap. The
		// sub-scope is what we register with the engine; when
		// `invalidateSubset` closes it, the outer scope is untouched.
		const primitiveScope = yield* Scope.fork(outer);
		yield* engine.registerPrimitiveScope(key, primitiveScope);
		// Finalizer + acquire-count bump live INSIDE the sub-scope so
		// closing it via `invalidateSubset` fires the finalizer for
		// THIS primitive without cascading.
		yield* Scope.addFinalizer(primitiveScope, bump(acquires.finalizers, key));
		yield* bump(acquires.counts, key);
	}),
});

// Trigger the selective-restart cascade: union owner + downstream
// closure for `ownerKey`, then call `engine.invalidateSubset`. This is
// what `watchPathFiber` does in production (see `supervisor.ts`
// formatRestartCascade + invalidateSubset).
const triggerSelective = (
	engine: EngineHandleShape,
	closure: DownstreamClosure,
	ownerKey: string,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const downstream = closure.get(ownerKey) ?? new Set<string>();
		const affected = new Set<string>([ownerKey, ...downstream]);
		yield* engine.invalidateSubset(affected);
	});

const acquirePrimitive = (
	engine: EngineHandleShape,
	prim: ReturnType<typeof makePrimitive>,
): Effect.Effect<void, never, Scope.Scope> =>
	prim.acquire.pipe(Effect.provideService(EngineHandle, engine));

describe('P3.T4 — selective-restart end-to-end', () => {
	it.effect(
		'a watch-fire on package only re-acquires package + downstream (codegen, dev); sui stays live',
		() =>
			// This is the canonical case from the plan: editing a `.move`
			// source under `Package`'s `__watchPaths` should re-acquire
			// `Package` + its consumers, but leave `Sui` (a heavy-infra
			// upstream that's not downstream of `Package`) untouched.
			//
			// We exercise the engine API surface directly rather than
			// going through the full supervisor + Layer.buildWithMemoMap
			// pipeline because the supervisor test infra is heavy and
			// the contract we want to pin lives entirely in the engine
			// + dep-graph + tag-substrate triangle.
			Effect.gen(function* () {
				const counts = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
				const finalizers = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
				const acquires: Acquires = { counts, finalizers };

				const ctx = yield* Layer.build(EngineLive).pipe(Effect.scoped);
				const engine = Context.get(ctx, EngineHandle);

				// Dep chain: sui ← package ← codegen ← dev
				const sui = {
					...makePrimitive('sui', acquires),
					__upstreamKeys: [] as ReadonlyArray<string>,
				};
				const pkg = {
					...makePrimitive('package', acquires),
					__upstreamKeys: ['sui'] as ReadonlyArray<string>,
				};
				const codegen = {
					...makePrimitive('codegen', acquires),
					__upstreamKeys: ['package'] as ReadonlyArray<string>,
				};
				const dev = {
					...makePrimitive('dev', acquires),
					__upstreamKeys: ['codegen'] as ReadonlyArray<string>,
				};

				// Build the dep graph the way the supervisor does at
				// compose time. The closure is what the watch fiber
				// passes through to `invalidateSubset`.
				const graph = buildDepGraph([sui, pkg, codegen, dev]);
				const closure = computeDownstreamClosure(graph);

				// Cycle 1: acquire every primitive on its own scope.
				// (Production wraps these in `Layer.effect` + a shared
				// MemoMap so re-acquiring re-runs the build body; here
				// we approximate that by re-calling `acquirePrimitive`
				// inside a fresh scope on each "cycle".)
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* acquirePrimitive(engine, sui);
						yield* acquirePrimitive(engine, pkg);
						yield* acquirePrimitive(engine, codegen);
						yield* acquirePrimitive(engine, dev);

						// Verify cycle 1's baseline: every primitive
						// ran once, no finalizers yet.
						const c1 = yield* Ref.get(counts);
						expect(c1.get('sui')).toBe(1);
						expect(c1.get('package')).toBe(1);
						expect(c1.get('codegen')).toBe(1);
						expect(c1.get('dev')).toBe(1);

						const f1 = yield* Ref.get(finalizers);
						expect(f1.get('sui') ?? 0).toBe(0);
						expect(f1.get('package') ?? 0).toBe(0);

						// Trigger the watch fire on `package` —
						// `invalidateSubset({package, codegen, dev})`.
						yield* triggerSelective(engine, closure, 'package');

						// After invalidateSubset: affected scopes are
						// closed; their finalizers ran. Sui's scope
						// is still open (its finalizer hasn't run).
						const fMid = yield* Ref.get(finalizers);
						expect(fMid.get('package') ?? 0).toBe(1);
						expect(fMid.get('codegen') ?? 0).toBe(1);
						expect(fMid.get('dev') ?? 0).toBe(1);
						expect(fMid.get('sui') ?? 0).toBe(0); // Critical — Sui untouched.

						// Cycle 2: re-acquire affected primitives. Sui
						// is NOT re-acquired by selective restart (its
						// scope is still live; nothing evicted it).
						yield* acquirePrimitive(engine, pkg);
						yield* acquirePrimitive(engine, codegen);
						yield* acquirePrimitive(engine, dev);

						const c2 = yield* Ref.get(counts);
						expect(c2.get('sui')).toBe(1); // Critical — Sui's build did NOT re-run.
						expect(c2.get('package')).toBe(2);
						expect(c2.get('codegen')).toBe(2);
						expect(c2.get('dev')).toBe(2);
					}),
				);

				// On outer scope close, sui's finalizer fires exactly once.
				// (Affected primitives' second-cycle finalizers also fire
				// here on scope cleanup — total finalizer count for
				// affected primitives ends at 2.)
				const fEnd = yield* Ref.get(finalizers);
				expect(fEnd.get('sui')).toBe(1);
				expect(fEnd.get('package')).toBe(2);
				expect(fEnd.get('codegen')).toBe(2);
				expect(fEnd.get('dev')).toBe(2);
			}),
	);

	it.effect('a watch-fire on codegen only re-acquires codegen + dev; sui + package stay live', () =>
		// Mid-chain trigger: confirms downstream-only semantics. The
		// owner key's upstream (sui, package) is NOT affected; only
		// the owner + its strictly-downstream consumers re-acquire.
		Effect.gen(function* () {
			const counts = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
			const finalizers = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
			const acquires: Acquires = { counts, finalizers };

			const ctx = yield* Layer.build(EngineLive).pipe(Effect.scoped);
			const engine = Context.get(ctx, EngineHandle);

			const sui = makePrimitive('sui', acquires);
			const pkg = {
				...makePrimitive('package', acquires),
				__upstreamKeys: ['sui'] as ReadonlyArray<string>,
			};
			const codegen = {
				...makePrimitive('codegen', acquires),
				__upstreamKeys: ['package'] as ReadonlyArray<string>,
			};
			const dev = {
				...makePrimitive('dev', acquires),
				__upstreamKeys: ['codegen'] as ReadonlyArray<string>,
			};

			const graph = buildDepGraph([sui, pkg, codegen, dev]);
			const closure = computeDownstreamClosure(graph);

			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* acquirePrimitive(engine, sui);
					yield* acquirePrimitive(engine, pkg);
					yield* acquirePrimitive(engine, codegen);
					yield* acquirePrimitive(engine, dev);

					yield* triggerSelective(engine, closure, 'codegen');

					const f = yield* Ref.get(finalizers);
					expect(f.get('sui') ?? 0).toBe(0);
					expect(f.get('package') ?? 0).toBe(0); // Upstream of owner — untouched.
					expect(f.get('codegen') ?? 0).toBe(1);
					expect(f.get('dev') ?? 0).toBe(1);
				}),
			);
		}),
	);

	it.effect('a watch-fire on dev (leaf) only re-acquires dev itself; upstream stays live', () =>
		// Leaf trigger: when the owner has no downstream consumers,
		// the affected set is just `{owner}`. Selective restart still
		// works — only the owner re-acquires.
		Effect.gen(function* () {
			const counts = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
			const finalizers = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
			const acquires: Acquires = { counts, finalizers };

			const ctx = yield* Layer.build(EngineLive).pipe(Effect.scoped);
			const engine = Context.get(ctx, EngineHandle);

			const sui = makePrimitive('sui', acquires);
			const pkg = {
				...makePrimitive('package', acquires),
				__upstreamKeys: ['sui'] as ReadonlyArray<string>,
			};
			const codegen = {
				...makePrimitive('codegen', acquires),
				__upstreamKeys: ['package'] as ReadonlyArray<string>,
			};
			const dev = {
				...makePrimitive('dev', acquires),
				__upstreamKeys: ['codegen'] as ReadonlyArray<string>,
			};

			const graph = buildDepGraph([sui, pkg, codegen, dev]);
			const closure = computeDownstreamClosure(graph);

			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* acquirePrimitive(engine, sui);
					yield* acquirePrimitive(engine, pkg);
					yield* acquirePrimitive(engine, codegen);
					yield* acquirePrimitive(engine, dev);

					yield* triggerSelective(engine, closure, 'dev');

					const f = yield* Ref.get(finalizers);
					expect(f.get('sui') ?? 0).toBe(0);
					expect(f.get('package') ?? 0).toBe(0);
					expect(f.get('codegen') ?? 0).toBe(0);
					expect(f.get('dev') ?? 0).toBe(1);
				}),
			);
		}),
	);
});
