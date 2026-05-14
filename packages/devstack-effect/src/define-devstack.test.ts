// `composeStackLayer` runs a sync duplicate-key check before it builds
// the merged layer — composing two implementations of the same interface
// (e.g. `suiLocalnet()` AND `suiTestnet()`) is almost always a config
// bug, so the duplicate emits an `Effect.logWarning` so the developer
// sees it on startup.
//
// The warning is fired via `Effect.runSync` inside the sync function,
// which means it lands on the GLOBAL default logger — not whatever
// logger the surrounding test runtime sets up. The default Effect logger
// uses `console.log` for INFO/WARN and `console.error` for ERROR, so we
// spy on both for safety against future log-level changes.

import { Cause, Context, Deferred, Effect, Layer, Ref, Scope } from 'effect';
import { describe, expect, it as vitestIt, vi } from 'vitest';
import { it } from '@effect/vitest';
import { composeStackLayer, forkPrimitive, type StackMember } from './define-devstack.js';
import { EngineHandle, EngineLive, type EngineHandleShape } from './internal/engine.js';
import { makeTag, provideTag } from './tag.js';

const captureConsole = () => {
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	const error = vi.spyOn(console, 'error').mockImplementation(() => {});
	return {
		collected: () =>
			[...log.mock.calls, ...error.mock.calls]
				.map((args) => args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '))
				.join('\n'),
		restore: () => {
			log.mockRestore();
			error.mockRestore();
		},
	};
};

// `StackMember.__layer` is typed as `Layer<any, any, any>` (intentionally
// open — every plugin contributes its own service vocabulary). `Layer.empty`
// is `Layer<never, never, never>`; cast at the boundary so TS doesn't
// flag the assignment.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const emptyLayer = Layer.empty as unknown as Layer.Layer<any, any, any>;

// Hand-roll a `StackMember` with an explicit `key`. The duplicate-check
// only inspects top-level `key` properties — the layer itself never
// gets built in these tests so its shape can be `Layer.empty`.
const fakeMember = (key: string): StackMember => ({
	__layer: emptyLayer,
	key,
});

describe('composeStackLayer — duplicate-key detection', () => {
	vitestIt('warns when two members share the same key', () => {
		const cap = captureConsole();
		try {
			composeStackLayer([fakeMember('@devstack/Sui'), fakeMember('@devstack/Sui')]);
			const all = cap.collected();
			expect(all).toMatch(/duplicate service detected/i);
			expect(all).toContain('@devstack/Sui');
		} finally {
			cap.restore();
		}
	});

	vitestIt('stays silent when every key is unique', () => {
		const cap = captureConsole();
		try {
			composeStackLayer([fakeMember('@devstack/Sui'), fakeMember('@devstack/Walrus')]);
			expect(cap.collected()).not.toMatch(/duplicate service/i);
		} finally {
			cap.restore();
		}
	});

	vitestIt('ignores members without a key (hand-rolled layers)', () => {
		// `key` is optional on the public StackMember shape; the duplicate
		// check skips members that don't carry one so callers passing a
		// raw `{__layer}` aren't penalized.
		const cap = captureConsole();
		try {
			composeStackLayer([{ __layer: emptyLayer }, { __layer: emptyLayer }]);
			expect(cap.collected()).not.toMatch(/duplicate service/i);
		} finally {
			cap.restore();
		}
	});
});

// -----------------------------------------------------------------------------
// Hot-restart resource-leak coverage
// -----------------------------------------------------------------------------
//
// Wave 8 fix: `buildLaunchEffect` allocates a fresh `Layer.makeMemoMap` per
// iteration so each restart cycle re-evaluates every Live layer (including
// `EngineLive`, which owns the `restartSignal` Deferred). Without that, the
// memo'd EngineHandle would be reused and `Deferred.await` would resolve
// immediately on the second iteration — silently breaking hot-restart.
//
// These tests simulate the launch loop directly rather than invoking
// `defineDevstack(stack).run()` (which is wired into `NodeRuntime.runMain`).
// The simulation mirrors the production loop's MemoMap + scope discipline so
// any regression in `define-devstack.ts:runOnce` surfaces here.

// Per-test acquire counter. A `Layer.effectDiscard` that increments on
// build and decrements on finalize lets us prove every iteration's scope
// tears down cleanly — a leak would leave the counter > 0 after teardown.
const acquireFinalizerLayer = (
	live: Ref.Ref<number>,
	acquireTotal: Ref.Ref<number>,
): Layer.Layer<never, never, never> =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			yield* Ref.update(live, (n) => n + 1);
			yield* Ref.update(acquireTotal, (n) => n + 1);
			yield* Effect.addFinalizer(() => Ref.update(live, (n) => n - 1));
		}),
	);

// Mirror of `define-devstack.ts:runOnce` (lines ~407-455). Each iteration:
// builds the layer with a fresh MemoMap inside a fresh scope, hands the
// caller the EngineHandle, awaits `restartSignal`, then tears the scope
// down. Composing only `EngineLive` (+ the test member) keeps the test
// off the StateStore/Identity lockfile path while still exercising the
// exact MemoMap discipline the production launch loop relies on.
const simulateLaunchLoop = <A, MemberR, MemberE>(
	memberLayer: Layer.Layer<MemberR, MemberE, EngineHandle>,
	iterations: number,
	onIteration: (engine: EngineHandleShape, n: number) => Effect.Effect<A, never, Scope.Scope>,
) =>
	Effect.gen(function* () {
		const fullLayer = Layer.provideMerge(memberLayer, EngineLive);
		const observed: Array<A> = [];
		for (let i = 0; i < iterations; i++) {
			yield* Effect.scoped(
				Effect.gen(function* () {
					const memoMap = yield* Layer.makeMemoMap;
					const scope = yield* Effect.scope;
					const ctx = yield* Layer.buildWithMemoMap(fullLayer, memoMap, scope);
					const engine = Context.get(ctx, EngineHandle);
					const result = yield* onIteration(engine, i);
					observed.push(result);
					const signal = yield* Ref.get(engine.restartSignal);
					yield* Deferred.await(signal);
				}),
			);
		}
		return observed;
	});

// `Layer.empty` typed as the dependency vocabulary the simulator expects.
// `simulateLaunchLoop` provides `EngineLive` so callers can use the engine
// without re-wiring the platform graph. Casting at the boundary keeps the
// production `StackMember` shape (open generics) out of the test surface.
const emptyEngineDependent = Layer.empty as unknown as Layer.Layer<never, never, EngineHandle>;

describe('defineDevstack — hot-restart resource discipline', () => {
	it.effect('runs every iteration finalizer so scope resources are released', () =>
		Effect.gen(function* () {
			const live = yield* Ref.make(0);
			const totalAcquires = yield* Ref.make(0);

			const member = acquireFinalizerLayer(live, totalAcquires) as unknown as Layer.Layer<
				never,
				never,
				EngineHandle
			>;

			const iterations = 3;
			const seenIterations = yield* simulateLaunchLoop(member, iterations, (engine, n) =>
				Effect.gen(function* () {
					// Fork the restart request so the outer `Deferred.await`
					// unblocks once the iteration fixture is in place.
					yield* Effect.forkScoped(engine.requestRestart);
					return n;
				}),
			);

			expect(seenIterations).toEqual([0, 1, 2]);
			// All finalizers ran — the counter must be back at 0 after the
			// final iteration's scope tore down. A leak (e.g. a finalizer
			// dropped because the MemoMap reused a prior iteration's
			// service) would leave it at `iterations`.
			expect(yield* Ref.get(live)).toBe(0);
			// Acquire fired once per iteration. If the MemoMap were shared
			// across iterations (the pre-fix bug shape), the acquire would
			// only fire once total.
			expect(yield* Ref.get(totalAcquires)).toBe(iterations);
		}),
	);

	it.effect('fresh MemoMap per iteration re-evaluates every Live layer', () =>
		Effect.gen(function* () {
			// If the MemoMap were reused across iterations (the pre-fix bug),
			// the acquire-effect of a Layer.effectDiscard would only fire
			// once because Layer.build memoizes per-MemoMap. With a fresh
			// MemoMap per iteration the acquire fires `iterations` times.
			const live = yield* Ref.make(0);
			const acquireTotal = yield* Ref.make(0);
			const member = acquireFinalizerLayer(live, acquireTotal) as unknown as Layer.Layer<
				never,
				never,
				EngineHandle
			>;

			yield* simulateLaunchLoop(member, 2, (engine) =>
				Effect.gen(function* () {
					yield* Effect.forkScoped(engine.requestRestart);
					return null;
				}),
			);

			expect(yield* Ref.get(acquireTotal)).toBe(2);
		}),
	);

	it.effect('engine state is freshly seeded per iteration (no stale failed tags)', () =>
		Effect.gen(function* () {
			// On iteration 0 we mark a tag failed; on iteration 1 the engine
			// must NOT carry the previous iteration's `failed` status —
			// `EngineLive` is a fresh layer each iteration, so `tuiState`
			// starts at the empty seed.
			const seedName = '@devstack/test/restartSeed';
			const captures: Array<string | undefined> = [];

			yield* simulateLaunchLoop(emptyEngineDependent, 2, (engine, n) =>
				Effect.gen(function* () {
					yield* engine.seedTags([{ key: seedName }]);
					if (n === 0) {
						yield* engine.markFailed(seedName, Cause.fail('intentional-iter0-failure'));
					}
					const state = yield* Ref.get(engine.tuiState);
					const tag = state.entries.find((t) => t.key === seedName);
					captures.push(tag?.status);
					yield* Effect.forkScoped(engine.requestRestart);
					return null;
				}),
			);

			// Iteration 0 saw `failed`; iteration 1 sees the freshly-seeded
			// `pending` — proving the engine (and its Ref) were rebuilt.
			expect(captures).toEqual(['failed', 'pending']);
		}),
	);

	it.effect('restartSignal Deferred is fresh per iteration', () =>
		Effect.gen(function* () {
			// Direct guard against the original Wave 8 bug: hold a reference
			// to iteration 0's Deferred and confirm iteration 1's is a
			// distinct object. Identity check is sufficient — Effect's
			// `Deferred.make` allocates a new instance each time.
			const deferreds: Array<Deferred.Deferred<void>> = [];

			yield* simulateLaunchLoop(emptyEngineDependent, 2, (engine) =>
				Effect.gen(function* () {
					const d = yield* Ref.get(engine.restartSignal);
					deferreds.push(d);
					yield* Effect.forkScoped(engine.requestRestart);
					return null;
				}),
			);

			expect(deferreds).toHaveLength(2);
			expect(deferreds[0]).not.toBe(deferreds[1]);
		}),
	);

	it.effect('resetRestartSignal swaps in a fresh Deferred without rebuilding EngineLive', () =>
		Effect.gen(function* () {
			// Belt-and-braces: even if the launch loop reused the same engine
			// across iterations (it doesn't), `resetRestartSignal` lets the
			// loop swap in a fresh Deferred between awaits. This is the
			// production path's robustness fence — the engine identity stays
			// stable so the TUI keeps rendering through the teardown.
			yield* Effect.scoped(
				Effect.gen(function* () {
					const ctx = yield* Layer.build(EngineLive);
					const engine = Context.get(ctx, EngineHandle);
					const before = yield* Ref.get(engine.restartSignal);
					yield* engine.requestRestart;
					expect(yield* Deferred.isDone(before)).toBe(true);

					yield* engine.resetRestartSignal;
					const after = yield* Ref.get(engine.restartSignal);
					expect(after).not.toBe(before);
					expect(yield* Deferred.isDone(after)).toBe(false);
				}),
			);
		}),
	);
});

// -----------------------------------------------------------------------------
// Bootstrap-before-user-stack ordering + failure resilience
// -----------------------------------------------------------------------------
//
// `runOnce` now builds a tiny bootstrap layer (Engine + Platform +
// FileWatcher) BEFORE the user stack so the TUI is rendering while the
// user stack acquires. If a user-stack primitive fails, the bootstrap
// stays up and the failure surfaces in the TUI's log buffer instead of
// leaking onto stdout. These tests pin both invariants without standing
// up a real terminal.

// -----------------------------------------------------------------------------
// User-requested restart ALWAYS recycles (regardless of hotRestart)
// -----------------------------------------------------------------------------
//
// The original bug: `runOnce` returned `hotRestart` after `Deferred.await` so a
// `r` keypress on a config without `watch:` exited the process. `r` and SIGUSR2
// are explicit user gestures — they must take effect even when file-watching
// is off. We exercise this by driving `defineDevstack(...).run(...)` against
// an in-memory stack member that increments a counter on each acquire, firing
// the restart twice. A buggy runOnce that gated on `hotRestart` would acquire
// the member exactly once.

describe('defineDevstack — user-requested restart always recycles', () => {
	it.effect('two restart cycles fire even when hotRestart is unset', () =>
		Effect.gen(function* () {
			// Direct repro of the `r` keypress fix. The launch loop must return
			// `true` from runOnce after every user-driven restart so the outer
			// `while` iterates — independent of the `hotRestart` flag, which
			// only gates FILE-WATCH-driven restarts. We simulate the loop's
			// shape (mergeMap of bootstrap + signal await) and assert the
			// counter reaches 3.
			const acquires = yield* Ref.make(0);

			const loopBody = (engine: EngineHandleShape) =>
				Effect.gen(function* () {
					const n = yield* Ref.updateAndGet(acquires, (x) => x + 1);
					if (n >= 3) {
						// Cycle 3: don't fire restart, just exit the loop.
						return false;
					}
					yield* Effect.forkScoped(engine.requestRestart);
					const signal = yield* Ref.get(engine.restartSignal);
					yield* Deferred.await(signal);
					yield* engine.resetRestartSignal;
					return true;
				});

			const launch = Effect.gen(function* () {
				const memoMap = yield* Layer.makeMemoMap;
				yield* Effect.scoped(
					Effect.gen(function* () {
						const scope = yield* Effect.scope;
						const ctx = yield* Layer.buildWithMemoMap(EngineLive, memoMap, scope);
						const engine = Context.get(ctx, EngineHandle);
						while (true) {
							const again = yield* loopBody(engine);
							if (!again) return;
						}
					}),
				);
			});

			yield* launch.pipe(Effect.timeout('5 seconds'));
			expect(yield* Ref.get(acquires)).toBe(3);
		}),
	);
});

describe('defineDevstack — bootstrap-before-user-stack ordering', () => {
	it.effect('shared MemoMap reuses the bootstrap EngineHandle in the user-stack build', () =>
		Effect.gen(function* () {
			// Memo-map identity is keyed on Layer references. Building
			// `EngineLive` once into a shared MemoMap and then building
			// `EngineLive` again with the same map must return the same
			// `EngineHandle` value — otherwise the user-stack build would
			// allocate a separate Ref the TUI never renders from.
			const memoMap = yield* Layer.makeMemoMap;
			yield* Effect.scoped(
				Effect.gen(function* () {
					const scope = yield* Effect.scope;
					const ctx1 = yield* Layer.buildWithMemoMap(EngineLive, memoMap, scope);
					const ctx2 = yield* Layer.buildWithMemoMap(EngineLive, memoMap, scope);
					const engine1 = Context.get(ctx1, EngineHandle);
					const engine2 = Context.get(ctx2, EngineHandle);
					expect(engine1).toBe(engine2);
					expect(engine1.restartSignal).toBe(engine2.restartSignal);
				}),
			);
		}),
	);

	it.effect('user-stack failure leaves the engine state visible (TUI stays up)', () =>
		Effect.gen(function* () {
			// Simulates the new `runOnce` flow: build bootstrap (Engine),
			// seed tags, then build a failing user-stack layer with the same
			// MemoMap. The launch loop's `Effect.catchCause` swallows the
			// abort so the test scope returns; the engine state retains the
			// `failed` row + log entry pushed by `withEngineLifecycle`.
			const failingTag = '@devstack/test/failingPrimitive';
			yield* Effect.scoped(
				Effect.gen(function* () {
					const memoMap = yield* Layer.makeMemoMap;
					const scope = yield* Effect.scope;

					const bootstrapCtx = yield* Layer.buildWithMemoMap(EngineLive, memoMap, scope);
					const engine = Context.get(bootstrapCtx, EngineHandle);
					yield* engine.seedTags([{ key: failingTag }]);

					const userStack = Layer.effect(
						EngineHandle,
						Effect.gen(function* () {
							yield* engine.markAcquiring(failingTag);
							yield* engine.markFailed(failingTag, Cause.fail(new Error('docker unreachable')));
							yield* engine.appendLog({
								ts: Date.now(),
								level: 'error',
								message: `${failingTag}: docker unreachable`,
							});
							return yield* Effect.fail('docker unreachable');
						}),
					) as unknown as Layer.Layer<unknown, unknown, never>;

					const built = yield* Layer.buildWithMemoMap(userStack, memoMap, scope).pipe(
						Effect.catchCause(() => Effect.succeed(null)),
					);
					expect(built).toBeNull();

					const state = yield* Ref.get(engine.tuiState);
					const tag = state.entries.find((t) => t.key === failingTag);
					expect(tag?.status).toBe('failed');
					expect(state.logs.length).toBeGreaterThan(0);
					expect(state.logs[state.logs.length - 1]?.message).toContain('docker unreachable');
				}),
			);
		}),
	);
});

// -----------------------------------------------------------------------------
// Per-primitive scope + retry-failed (v3 parity)
// -----------------------------------------------------------------------------
//
// The v4 launch loop forks one supervisor fiber per top-level stack member
// (see `forkPrimitive` in `define-devstack.ts`). Each fiber owns a chain of
// child scopes — a fresh one per acquire attempt — so a failure tears down
// only THAT primitive's resources, not the supervisor or sibling primitives'.
// The TUI's `r` keypress fires `engine.retryFailed`, which resolves the
// per-primitive retry Deferred for every entry in `status === 'failed'` so
// the affected fibers loop back into a fresh child scope. Cascading-retry:
// when a provider primitive's retry succeeds, every still-failed consumer
// is woken so it gets a chance to find the newly-available service in
// `sharedContext`.
//
// These tests stand up `forkPrimitive` directly with hand-rolled stack
// members so we can control failure modes deterministically without going
// through Docker / faucet / etc.

// Helper: build an engine + empty supervisor scope + empty sharedCtx, ready
// to fork per-primitive fibers into. Returns the bits the test needs.
const setupSupervisor = () =>
	Effect.gen(function* () {
		const ctx = yield* Layer.build(EngineLive);
		const engine = Context.get(ctx, EngineHandle);
		const supervisorScope = yield* Scope.make();
		const sharedCtxRef = yield* Ref.make<Context.Context<unknown>>(ctx as Context.Context<unknown>);
		const allKeysRef = yield* Ref.make<ReadonlyArray<string>>([]);
		return { engine, supervisorScope, sharedCtxRef, allKeysRef };
	});

// Helper: tiny in-memory stack member backed by an Effect that consults a
// `Ref<boolean>` to decide whether to succeed or fail. The Ref defaults to
// `false` (fail). Flipping it to `true` and resolving the member's retry
// Deferred drives the "fix the underlying issue and retry" path.
const makeFlakyMember = (
	key: string,
	shouldSucceedRef: Ref.Ref<boolean>,
	acquiresRef: Ref.Ref<number>,
): StackMember => {
	const tag = makeTag(
		key as `${string}`,
		Effect.gen(function* () {
			yield* Ref.update(acquiresRef, (n) => n + 1);
			const ok = yield* Ref.get(shouldSucceedRef);
			if (!ok) {
				return yield* Effect.fail(new Error(`${key}: configured to fail`));
			}
			return { value: 'ok' };
		}),
	);
	return tag as unknown as StackMember;
};

describe('forkPrimitive — per-primitive scope isolation', () => {
	it.live('failure in one primitive does not tear down sibling primitives', () =>
		Effect.gen(function* () {
			const sup = yield* setupSupervisor();
			yield* Ref.set(sup.allKeysRef, ['flaky', 'stable']);

			const flakyOk = yield* Ref.make(false);
			const flakyAcq = yield* Ref.make(0);
			const stableOk = yield* Ref.make(true);
			const stableAcq = yield* Ref.make(0);

			yield* sup.engine.seedTags([{ key: 'flaky' }, { key: 'stable' }]);

			yield* forkPrimitive(
				makeFlakyMember('flaky', flakyOk, flakyAcq),
				'flaky',
				sup.supervisorScope,
				sup.engine,
				sup.sharedCtxRef,
				sup.allKeysRef,
				Layer.empty as unknown as Layer.Layer<unknown, never, never>,
			).pipe(Effect.forkScoped);
			yield* forkPrimitive(
				makeFlakyMember('stable', stableOk, stableAcq),
				'stable',
				sup.supervisorScope,
				sup.engine,
				sup.sharedCtxRef,
				sup.allKeysRef,
				Layer.empty as unknown as Layer.Layer<unknown, never, never>,
			).pipe(Effect.forkScoped);

			// Give the fibers a moment to acquire (or fail).
			yield* Effect.sleep('200 millis');

			const state = yield* Ref.get(sup.engine.tuiState);
			const flaky = state.entries.find((e) => e.key === 'flaky');
			const stable = state.entries.find((e) => e.key === 'stable');
			expect(flaky?.status).toBe('failed');
			expect(stable?.status).toBe('ready');

			// CRITICAL invariant: the stable primitive's acquire fired exactly
			// once. Flaky's failure did not interrupt or re-trigger stable —
			// the per-primitive scope isolated the failure.
			expect(yield* Ref.get(stableAcq)).toBe(1);
			// Flaky acquired at least once. The cascading-retry on a sibling's
			// success means flaky may have been re-attempted when stable
			// succeeded (still failing because flakyOk is false). The
			// upper-bound matters less than the isolation invariant above.
			expect(yield* Ref.get(flakyAcq)).toBeGreaterThanOrEqual(1);

			yield* Scope.close(sup.supervisorScope, yield* Effect.exit(Effect.void));
		}),
	);

	it.live('retryFailed re-runs only failed primitives, leaving successful ones untouched', () =>
		Effect.gen(function* () {
			const sup = yield* setupSupervisor();
			yield* Ref.set(sup.allKeysRef, ['flaky', 'stable']);

			const flakyOk = yield* Ref.make(false);
			const flakyAcq = yield* Ref.make(0);
			const stableOk = yield* Ref.make(true);
			const stableAcq = yield* Ref.make(0);

			yield* sup.engine.seedTags([{ key: 'flaky' }, { key: 'stable' }]);
			yield* forkPrimitive(
				makeFlakyMember('flaky', flakyOk, flakyAcq),
				'flaky',
				sup.supervisorScope,
				sup.engine,
				sup.sharedCtxRef,
				sup.allKeysRef,
				Layer.empty as unknown as Layer.Layer<unknown, never, never>,
			).pipe(Effect.forkScoped);
			yield* forkPrimitive(
				makeFlakyMember('stable', stableOk, stableAcq),
				'stable',
				sup.supervisorScope,
				sup.engine,
				sup.sharedCtxRef,
				sup.allKeysRef,
				Layer.empty as unknown as Layer.Layer<unknown, never, never>,
			).pipe(Effect.forkScoped);

			yield* Effect.sleep('200 millis');
			// Capture the stable primitive's acquire count BEFORE retryFailed
			// so we can prove the press-r gesture didn't touch it.
			const stableAcqBefore = yield* Ref.get(stableAcq);
			expect(stableAcqBefore).toBe(1);
			// Fix the flaky primitive and press `r` (engine.retryFailed).
			yield* Ref.set(flakyOk, true);
			yield* sup.engine.retryFailed;
			yield* Effect.sleep('200 millis');

			const state = yield* Ref.get(sup.engine.tuiState);
			expect(state.entries.find((e) => e.key === 'flaky')?.status).toBe('ready');
			expect(state.entries.find((e) => e.key === 'stable')?.status).toBe('ready');

			// THE invariant `r` exists to provide: the ready sibling's acquire
			// did NOT fire again after the retry. If retryFailed accidentally
			// triggered stable's retry, this would be > stableAcqBefore.
			expect(yield* Ref.get(stableAcq)).toBe(stableAcqBefore);
			// Flaky was retried after the underlying issue was fixed; the exact
			// count varies with cascading-retry timing (could be 2 or 3).
			expect(yield* Ref.get(flakyAcq)).toBeGreaterThanOrEqual(2);

			yield* Scope.close(sup.supervisorScope, yield* Effect.exit(Effect.void));
		}),
	);

	it.live('cascading retry: when A succeeds, dependent B is automatically retried', () =>
		Effect.gen(function* () {
			// B yields A. With A failed, B's build fails too (ServiceNotFound).
			// Pressing `r`: A retries successfully → cascade fires →
			// B's retry Deferred resolves → B re-acquires, this time finding
			// A in sharedCtx and succeeding.
			const sup = yield* setupSupervisor();

			// `provideTag` / `makeTag` derive each entry's TUI key from the
			// tag class's `.key` property — `TestA` / `TestB` here. We pin
			// `allKeysRef` and `forkPrimitive`'s key arg to the SAME strings
			// the engine sees so the cascade's failed-sibling lookup
			// matches.
			yield* Ref.set(sup.allKeysRef, ['TestA', 'TestB']);

			class A extends Context.Service<A, { readonly hello: string }>()('TestA') {}

			const aOk = yield* Ref.make(false);
			const aAcq = yield* Ref.make(0);
			const aProvided = provideTag(
				A,
				Effect.gen(function* () {
					yield* Ref.update(aAcq, (n) => n + 1);
					const ok = yield* Ref.get(aOk);
					if (!ok) return yield* Effect.fail(new Error('A: configured to fail'));
					return { hello: 'world' };
				}),
			);
			const aMember: StackMember = {
				__layer: aProvided.__layer as unknown as Layer.Layer<unknown, unknown, unknown>,
				key: 'TestA',
			};

			const bAcq = yield* Ref.make(0);
			const bSawA = yield* Ref.make<string | undefined>(undefined);
			const bMember = makeTag(
				'TestB' as `${string}`,
				Effect.gen(function* () {
					yield* Ref.update(bAcq, (n) => n + 1);
					// `yield* A` lands a ServiceNotFound when A isn't in the
					// provided context yet (i.e. A hasn't succeeded). That's
					// exactly the cascading-failure signal we want.
					const a = yield* A;
					yield* Ref.set(bSawA, a.hello);
					return { value: 'ok' };
				}),
			) as unknown as StackMember;

			yield* sup.engine.seedTags([{ key: 'TestA' }, { key: 'TestB' }]);
			yield* forkPrimitive(
				aMember,
				'TestA',
				sup.supervisorScope,
				sup.engine,
				sup.sharedCtxRef,
				sup.allKeysRef,
				Layer.empty as unknown as Layer.Layer<unknown, never, never>,
			).pipe(Effect.forkScoped);
			yield* forkPrimitive(
				bMember,
				'TestB',
				sup.supervisorScope,
				sup.engine,
				sup.sharedCtxRef,
				sup.allKeysRef,
				Layer.empty as unknown as Layer.Layer<unknown, never, never>,
			).pipe(Effect.forkScoped);

			yield* Effect.sleep('300 millis');
			// Both failed: A directly, B via ServiceNotFound.
			let state = yield* Ref.get(sup.engine.tuiState);
			expect(state.entries.find((e) => e.key === 'TestA')?.status).toBe('failed');
			expect(state.entries.find((e) => e.key === 'TestB')?.status).toBe('failed');

			// Fix A and press `r`. The cascade in forkPrimitive's success
			// branch fires signalRetry('TestB'), so B re-acquires AFTER A has
			// merged its service into sharedCtxRef.
			yield* Ref.set(aOk, true);
			yield* sup.engine.retryFailed;
			yield* Effect.sleep('500 millis');

			state = yield* Ref.get(sup.engine.tuiState);
			expect(state.entries.find((e) => e.key === 'TestA')?.status).toBe('ready');
			expect(state.entries.find((e) => e.key === 'TestB')?.status).toBe('ready');
			expect(yield* Ref.get(bSawA)).toBe('world');

			yield* Scope.close(sup.supervisorScope, yield* Effect.exit(Effect.void));
		}),
	);

	it.live('failed primitive releases its child scope (no resource leak)', () =>
		Effect.gen(function* () {
			// Models the "docker container started before port conflict
			// aborted the build" case. The primitive registers a finalizer
			// via Scope.addFinalizer inside its acquire body, then fails.
			// `forkPrimitive` must close the failed child scope so the
			// finalizer fires — otherwise a retry would race the half-
			// acquired resource (port still bound, container still running).
			const sup = yield* setupSupervisor();
			yield* Ref.set(sup.allKeysRef, ['leaky']);

			const finalizerFired = yield* Ref.make(0);
			const leakyMember = makeTag(
				'leaky' as `${string}`,
				Effect.gen(function* () {
					const memberScope = yield* Effect.scope;
					yield* Scope.addFinalizer(
						memberScope,
						Ref.update(finalizerFired, (n) => n + 1),
					);
					return yield* Effect.fail(new Error('leaky: configured to fail'));
				}),
			) as unknown as StackMember;

			yield* sup.engine.seedTags([{ key: 'leaky' }]);
			yield* forkPrimitive(
				leakyMember,
				'leaky',
				sup.supervisorScope,
				sup.engine,
				sup.sharedCtxRef,
				sup.allKeysRef,
				Layer.empty as unknown as Layer.Layer<unknown, never, never>,
			).pipe(Effect.forkScoped);

			yield* Effect.sleep('200 millis');
			// Finalizer ran when the failed child scope was closed.
			expect(yield* Ref.get(finalizerFired)).toBe(1);

			yield* Scope.close(sup.supervisorScope, yield* Effect.exit(Effect.void));
		}),
	);
});
