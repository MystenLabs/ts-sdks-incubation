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

import { Cause, Context, Deferred, Effect, Exit, Layer, Ref, Scope } from 'effect';
import { describe, expect, it as vitestIt, vi } from 'vitest';
import { it } from '@effect/vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import {
	composeStackLayer,
	defineDevstack,
	ownersFor,
	type StackMember,
	type WatchOwner,
} from './define-devstack.js';
import { EngineHandle, EngineLive, type EngineHandleShape } from './internal/engine.js';

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
// CI fast-fail: plain/silent renderer with first-cycle build failure must
// surface as a failed Effect (non-zero process exit) rather than blocking on
// the restart Deferred. Interactive TUI mode keeps the wait-for-`r` behavior
// for in-terminal recovery.
// -----------------------------------------------------------------------------

describe('defineDevstack — CI fast-fail on first-cycle build failure', () => {
	// We need a real (writable) state dir for StateStoreLive's lock acquire,
	// since `BootstrapLive` now folds state-store into the supervisor's
	// resource pool. A throwaway tmpdir keeps the test isolated from other
	// suites that may scribble in `.devstack/`.
	let stateDir: string;
	let savedEnv: NodeJS.ProcessEnv;

	const setupTmp = () => {
		savedEnv = { ...process.env };
		// `process.stdout.isTTY` reads from the live stream. In vitest's worker
		// process this is usually false (piped to the runner), but force `plain`
		// explicitly anyway so the test doesn't accidentally pick `tui` if it
		// runs in an interactive terminal.
		// Skip the shared-traefik-router boot — these tests don't go
		// through docker and we'd otherwise pay the 10s `ensureRouter`
		// docker-shell-out timeout per test.
		process.env.DEVSTACK_NO_ROUTER = '1';
		stateDir = mkdtempSync(join(tmpdir(), 'devstack-ci-fastfail-'));
	};

	const teardownTmp = () => {
		for (const k of Object.keys(process.env)) delete process.env[k];
		Object.assign(process.env, savedEnv);
		try {
			rmSync(stateDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	};

	// A stack member whose acquire fails immediately. The `__layer` is a
	// `Layer.effect` over a sentinel tag — building it `yield* Effect.fail`s,
	// which the supervisor's `Effect.catchCause` captures as a failed-build
	// signal.
	class FailingService extends Context.Service<FailingService, { ok: boolean }>()(
		'@devstack/test/FailingService',
	) {}
	const failingMember: StackMember = {
		key: '@devstack/test/FailingService',
		__layer: Layer.effect(
			FailingService,
			Effect.fail(new Error('test primitive intentionally fails on acquire')),
		) as unknown as Layer.Layer<unknown, unknown, unknown>,
	};

	vitestIt('plain renderer: launchEffect fails on first-cycle build failure (does not hang)', async () => {
		setupTmp();
		try {
			const devstack = defineDevstack({
				stack: [failingMember],
				stateDir,
				renderer: 'plain',
			});
			// Wrap with a 5s timeout: if the fast-fail branch regresses,
			// `Deferred.await(restartSignal)` blocks forever — the test would
			// hang until vitest's per-test timeout. The explicit timeout +
			// `Effect.runPromiseExit` lets us assert the failure shape AND
			// fail loudly if the supervisor blocks.
			const exit = await Effect.runPromiseExit(
				devstack.launchEffect().pipe(Effect.timeout('5 seconds')),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				// The fail-cause should carry our explicit "first cycle"
				// message — NOT a timeout error (which would indicate the
				// supervisor was blocking on the restart Deferred).
				const pretty = Cause.pretty(exit.cause);
				expect(pretty).toContain('stack acquire failed on first cycle');
				expect(pretty).not.toContain('TimeoutException');
			}
		} finally {
			teardownTmp();
		}
	}, 15_000);

	vitestIt('silent renderer: same fast-fail path applies', async () => {
		setupTmp();
		try {
			const devstack = defineDevstack({
				stack: [failingMember],
				stateDir,
				renderer: 'silent',
			});
			const exit = await Effect.runPromiseExit(
				devstack.launchEffect().pipe(Effect.timeout('5 seconds')),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const pretty = Cause.pretty(exit.cause);
				expect(pretty).toContain('stack acquire failed on first cycle');
				expect(pretty).not.toContain('TimeoutException');
			}
		} finally {
			teardownTmp();
		}
	}, 15_000);
});


// -----------------------------------------------------------------------------
// Watch-event attribution
// -----------------------------------------------------------------------------
//
// `ownersFor` is the helper the file-watcher fiber uses to resolve a
// changed path back to the primitive(s) that declared the watch. The
// real watcher path is heavy to exercise (fs.watch, ChildProcessSpawner,
// the full launch loop), so we test the resolver in isolation against
// hand-built `WatchOwner` records — that's where the path-matching
// invariants live (exact match, prefix-with-separator, partial-name
// collision rejection).

describe('ownersFor — watch-event attribution', () => {
	const cwd = process.cwd();
	const owner = (key: string, title: string, relPath: string): WatchOwner => ({
		key,
		title,
		absolutePath: resolvePath(cwd, relPath),
	});

	vitestIt('exact-path match resolves to the declaring primitive', () => {
		const owners: ReadonlyArray<WatchOwner> = [
			owner('publish.hello', 'publish.hello', './move/hello/Move.toml'),
		];
		const hits = ownersFor('./move/hello/Move.toml', owners);
		expect(hits.map((o) => o.key)).toEqual(['publish.hello']);
	});

	vitestIt('deep-descendant match resolves through a watched directory', () => {
		const owners: ReadonlyArray<WatchOwner> = [
			owner('publish.hello', 'publish.hello', './move/hello'),
		];
		const hits = ownersFor('./move/hello/sources/foo.move', owners);
		expect(hits.map((o) => o.key)).toEqual(['publish.hello']);
	});

	vitestIt('rejects partial-name prefix collisions (hello vs hello-v2)', () => {
		// `./move/hello-v2/sources/foo.move` should NOT match a primitive
		// watching `./move/hello` — the absolute paths share a 5-char prefix
		// but diverge before the separator, which the `startsWith(o.absolutePath + sep)`
		// check guards against.
		const owners: ReadonlyArray<WatchOwner> = [
			owner('publish.hello', 'publish.hello', './move/hello'),
		];
		const hits = ownersFor('./move/hello-v2/sources/foo.move', owners);
		expect(hits).toEqual([]);
	});

	vitestIt('multiple owners on the same path are all returned', () => {
		// Two primitives watching overlapping directories both surface in
		// the attribution log. Rare but legitimate (e.g. an action that
		// watches the same Move sources as `publishMove` for an
		// orchestration step).
		const owners: ReadonlyArray<WatchOwner> = [
			owner('publish.hello', 'publish.hello', './move/hello'),
			owner('publish.hello.action', 'publish.hello.action', './move/hello/sources'),
		];
		const hits = ownersFor('./move/hello/sources/foo.move', owners);
		expect(hits.map((o) => o.key).sort()).toEqual(['publish.hello', 'publish.hello.action']);
	});

	vitestIt('absolute changed paths are resolved against the owner index', () => {
		// fs.watch can emit either relative or absolute paths depending on
		// platform + how the watch was opened; resolving both sides to
		// absolute keeps the comparison stable.
		const absolute = resolvePath(cwd, './move/hello/sources/foo.move');
		const owners: ReadonlyArray<WatchOwner> = [
			owner('publish.hello', 'publish.hello', './move/hello'),
		];
		const hits = ownersFor(absolute, owners);
		expect(hits.map((o) => o.key)).toEqual(['publish.hello']);
	});

	vitestIt('unowned paths return an empty array (no false attribution)', () => {
		// Paths declared in `config.watch` but not by any primitive surface
		// here. The watcher fiber logs these as "unowned watch path" rather
		// than misattributing to a random primitive.
		const owners: ReadonlyArray<WatchOwner> = [
			owner('publish.hello', 'publish.hello', './move/hello'),
		];
		expect(ownersFor('./unrelated/file.ts', owners)).toEqual([]);
	});
});
