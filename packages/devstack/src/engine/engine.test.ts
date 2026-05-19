// Engine focuses on a tiny set of state transitions over a Ref of
// `TuiState`. Most of the surface is covered by the ink component tests
// (which render the resolved state via the production engine). The
// transitions we lock down here are the ones that are easy to break in
// isolation: phase narration + the implicit clear-on-terminal logic that
// keeps `(running genesis)` from sticking to a `ready` row.

import { Cause, Context, Effect, Fiber, Layer, Ref, Scope } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { EngineHandle, EngineLive, type EngineHandleShape } from './engine.js';
import { DockerError, PublishError } from '../engine/errors.js';
import { SuiCliError } from './sui-cli.js';

const buildEngine = (): Effect.Effect<EngineHandleShape> =>
	Effect.gen(function* () {
		const ctx = yield* Layer.build(EngineLive).pipe(Effect.scoped);
		return Context.get(ctx, EngineHandle);
	});

describe('EngineHandle.setPhase', () => {
	it.effect("updates the entry's phase while it is acquiring", () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.seedTags([{ key: 'sui.localnet', kind: 'service' }]);
			yield* engine.markAcquiring('sui.localnet', 'service');
			yield* engine.setPhase('sui.localnet', 'starting container');

			const state = yield* Ref.get(engine.tuiState);
			const entry = state.entries.find((e) => e.key === 'sui.localnet');
			expect(entry?.phase).toBe('starting container');
			expect(entry?.status).toBe('acquiring');
		}),
	);

	it.effect('overwrites prior phase on subsequent calls', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.seedTags([{ key: 'sui.localnet', kind: 'service' }]);
			yield* engine.markAcquiring('sui.localnet', 'service');
			yield* engine.setPhase('sui.localnet', 'building image');
			yield* engine.setPhase('sui.localnet', 'running genesis');

			const state = yield* Ref.get(engine.tuiState);
			expect(state.entries[0]?.phase).toBe('running genesis');
		}),
	);

	it.effect('clears phase automatically on transition to ready', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.seedTags([{ key: 'sui.localnet', kind: 'service' }]);
			yield* engine.markAcquiring('sui.localnet', 'service');
			yield* engine.setPhase('sui.localnet', 'awaiting rpc');
			yield* engine.markReady('sui.localnet', {
				title: 'sui.localnet',
				primary: 'http://127.0.0.1:9000',
			});

			const state = yield* Ref.get(engine.tuiState);
			const entry = state.entries[0];
			expect(entry?.status).toBe('ready');
			expect(entry?.phase).toBeUndefined();
		}),
	);

	it.effect('clears phase automatically on transition to failed', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.seedTags([{ key: 'accounts.alice', kind: 'action' }]);
			yield* engine.markAcquiring('accounts.alice', 'action');
			yield* engine.setPhase('accounts.alice', 'requesting funds');
			yield* engine.markFailed('accounts.alice', Cause.fail(new Error('faucet 503')));

			const state = yield* Ref.get(engine.tuiState);
			const entry = state.entries[0];
			expect(entry?.status).toBe('failed');
			expect(entry?.phase).toBeUndefined();
			expect(entry?.error).toContain('faucet 503');
		}),
	);

	it.effect('is a noop for unknown keys (no auto-register)', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.setPhase('phantom', 'starting');
			const state = yield* Ref.get(engine.tuiState);
			expect(state.entries.length).toBe(0);
		}),
	);
});

describe('EngineHandle restart signaling — Queue.dropping semantics', () => {
	// Hot-restart triggers (file watcher, SIGUSR2, TUI `r`) all converge
	// on `requestRestart`. The launch loop yields `awaitRestart` between
	// cycles. Both are backed by a single `Queue.dropping(1)`:
	//
	//   - `requestRestart` (offer): non-blocking. If the queue already
	//     has one pending wake, the offer is silently dropped — concurrent
	//     requests coalesce into a single wake.
	//   - `awaitRestart` (take): blocks if the queue is empty, returns
	//     immediately if a wake has been buffered.
	//
	//   OLD bug (Ref<Deferred> + separate arm):
	//     loop wakes from Deferred.await, then runs `Ref.set` with a
	//     fresh deferred. A `requestRestart` that lands BETWEEN the wake
	//     and the arm reads the just-succeeded deferred (no-op) and the
	//     wake is lost. Pressing `r` once does nothing; pressing twice
	//     works.
	//
	//   NEW (queue):
	//     no separate "currently armed" reference exists. A request
	//     landing in the wake → next-take gap is preserved inside the
	//     queue and the next take returns immediately. The bug is
	//     structurally impossible.

	it.live('awaitRestart blocks when no request is pending', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			// Fork the await; it should still be running after a short tick.
			const fiber = yield* Effect.forkChild(engine.awaitRestart);
			yield* Effect.sleep('20 millis');
			expect(fiber.pollUnsafe()).toBeUndefined();
			yield* Fiber.interrupt(fiber);
		}),
	);

	it.effect('requestRestart wakes a pending awaitRestart', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			const fiber = yield* Effect.forkChild(engine.awaitRestart);
			yield* engine.requestRestart;
			yield* Fiber.join(fiber);
		}),
	);

	it.live('concurrent requestRestart calls coalesce into a single wake', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();

			// Fire many concurrent requests against an empty queue.
			yield* Effect.all(
				Array.from({ length: 8 }, () => engine.requestRestart),
				{ concurrency: 'unbounded' },
			);

			// First take wakes immediately on the buffered request.
			yield* engine.awaitRestart;

			// A second take MUST block — only one wake was preserved, not
			// eight. If concurrent offers had each enqueued an entry the
			// take below would return immediately.
			const fiber = yield* Effect.forkChild(engine.awaitRestart);
			yield* Effect.sleep('20 millis');
			expect(fiber.pollUnsafe()).toBeUndefined();
			yield* Fiber.interrupt(fiber);
		}),
	);

	it.effect('regression: request during the wake → next-await gap is NOT lost', () =>
		// Simulates the wake → process → next-await sequence the OLD
		// Ref<Deferred> code mishandled. The queue absorbs the request
		// that fires during the inter-cycle gap; the next await returns
		// immediately on it.
		Effect.gen(function* () {
			const engine = yield* buildEngine();

			// Cycle N: a request lands and the loop wakes.
			yield* engine.requestRestart;
			yield* engine.awaitRestart;

			// Between wake and the next await: a new request lands. With
			// the OLD design this would have succeeded the already-resolved
			// deferred (no-op) and been lost. With the queue the wake is
			// preserved in the queue's internal buffer.
			yield* engine.requestRestart;

			// Cycle N+1's await observes the wake immediately. We use a
			// short timeout to fail loudly rather than hang the suite.
			yield* engine.awaitRestart.pipe(Effect.timeout('1 second'));
		}),
	);
});


describe('EngineHandle.markFailed root-cause extraction', () => {
	it.effect('walks the cause chain to the innermost message for the row summary', () =>
		// The outer wrapper's message is the same generic preamble for every
		// publish failure ('publishMove(...): build failed'); the user needs
		// to see the sui-cli's actual reason ('unexpected argument...'). The
		// engine row pulls the deepest message off the cause chain so the
		// 60-char budget surfaces the root cause instead of the wrapper.
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.seedTags([{ key: 'publish.demo', kind: 'action' }]);
			const root = new SuiCliError({
				phase: 'sui move build',
				message: "sui move build exited 2: error: unexpected argument '--json' found",
			});
			const wrapped = new PublishError({
				phase: 'build',
				message: 'publishMove(demo): build failed',
				cause: root,
			});
			yield* engine.markFailed('publish.demo', Cause.fail(wrapped));
			const state = yield* Ref.get(engine.tuiState);
			const entry = state.entries.find((e) => e.key === 'publish.demo');
			expect(entry?.error).toContain("unexpected argument '--json' found");
			expect(entry?.error).not.toContain('publishMove(demo): build failed');
		}),
	);

	it.effect('prefers tagged-error stderr over message when both are present', () =>
		// DockerError carries the cli's verbatim stderr in `stderr` and a
		// short summary in `message`. The row's job is to surface the real
		// stderr line (the daemon's actual error) — that's what the user
		// has to copy into a search engine.
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.seedTags([{ key: 'sui.localnet', kind: 'service' }]);
			const docker = new DockerError({
				phase: 'docker run',
				message: 'docker run — exit 125',
				stderr: 'Error response from daemon: pull access denied',
				exitCode: 125,
			});
			yield* engine.markFailed('sui.localnet', Cause.fail(docker));
			const state = yield* Ref.get(engine.tuiState);
			const entry = state.entries.find((e) => e.key === 'sui.localnet');
			expect(entry?.error).toContain('pull access denied');
		}),
	);
});

describe('EngineHandle selective-restart surface — Phase 3', () => {
	// Phase 3 of selective-restart lands two collaborators that work as one
	// pair: a shadow cache mirroring Effect's MemoMap by tag identity, and
	// `invalidateSubset(keys)` which (a) closes each affected primitive's
	// scope (releases its container / files / fibers) AND (b) evicts the
	// shadow-cache entry (forces the next consumer's `yield*` to re-run
	// the Layer build).
	//
	// The pair is exercised together at the supervisor integration layer
	// (`engine/supervisor.test.ts::watch-fire selective-restart …`); the
	// tests below pin the per-engine semantics in isolation: shadow-cache
	// shape, eviction semantics, scope-closing behavior, sibling
	// preservation, and the user-`r`-still-rebuilds-everything pin.

	// Helper that synthesizes a registered scope + shadow entry without
	// going through `withEngineLifecycle`. The wrap call would require an
	// EngineHandle in the R channel (the same handle we're testing), which
	// is awkward to provide; for these tests we register synthetic scopes
	// directly so the assertions stay focused on the engine API surface.
	const registerScopeForKey = (
		engine: EngineHandleShape,
		key: string,
	): Effect.Effect<{
		readonly scope: Scope.Closeable;
		readonly finalizedRef: Ref.Ref<boolean>;
	}> =>
		Effect.gen(function* () {
			const scope = yield* Scope.make();
			const finalizedRef = yield* Ref.make(false);
			yield* Scope.addFinalizer(
				scope,
				Ref.set(finalizedRef, true),
			);
			yield* engine.registerPrimitiveScope(key, scope);
			return { scope, finalizedRef };
		});

	it.effect(
		'P3.T1 — shadow cache is populated on registerPrimitiveScope and evicted on invalidateSubset',
		() =>
			// Pinning the shadow-cache shape: presence is one entry per
			// registered primitive; eviction operates on the per-key
			// granularity that `invalidateSubset` exposes. Siblings stay
			// in the cache.
			Effect.gen(function* () {
				const engine = yield* buildEngine();
				yield* registerScopeForKey(engine, 'k1');
				yield* registerScopeForKey(engine, 'k2');
				yield* registerScopeForKey(engine, 'k3');

				const before = yield* Ref.get(engine._shadowCache);
				expect(before.has('k1')).toBe(true);
				expect(before.has('k2')).toBe(true);
				expect(before.has('k3')).toBe(true);

				yield* engine.invalidateSubset(new Set(['k1', 'k2']));

				const after = yield* Ref.get(engine._shadowCache);
				expect(after.has('k1')).toBe(false);
				expect(after.has('k2')).toBe(false);
				// Sibling not in the set survives.
				expect(after.has('k3')).toBe(true);
			}),
	);

	it.effect('P3.T2 — invalidateSubset closes the primitive scope and runs finalizers', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			const k = yield* registerScopeForKey(engine, 'k');

			expect(yield* Ref.get(k.finalizedRef)).toBe(false);

			yield* engine.invalidateSubset(new Set(['k']));

			expect(yield* Ref.get(k.finalizedRef)).toBe(true);
		}),
	);

	it.effect('P3.T3 — invalidateSubset spares scopes outside the affected set', () =>
		// Critical invariant: a watch-fire on one primitive's path must NOT
		// release siblings' scopes. This is THE behavior selective restart
		// exists to deliver — without it the whole feature collapses back
		// to "kick the whole stack."
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			const k1 = yield* registerScopeForKey(engine, 'k1');
			const k2 = yield* registerScopeForKey(engine, 'k2');
			const k3 = yield* registerScopeForKey(engine, 'k3');

			yield* engine.invalidateSubset(new Set(['k1']));

			expect(yield* Ref.get(k1.finalizedRef)).toBe(true);
			expect(yield* Ref.get(k2.finalizedRef)).toBe(false);
			expect(yield* Ref.get(k3.finalizedRef)).toBe(false);
		}),
	);

	it.effect(
		'P3.T2b — invalidateSubset on an unknown key is a no-op (no error, no other entries touched)',
		() =>
			// The dep graph + the engine's scope registry can disagree if a
			// primitive failed before reaching `registerPrimitiveScope` —
			// the dep graph still names it, the engine doesn't have a scope
			// for it. The engine treats this as benign rather than fatal so
			// a partial-acquire cycle's watch-fire doesn't tear down the
			// supervisor.
			Effect.gen(function* () {
				const engine = yield* buildEngine();
				yield* registerScopeForKey(engine, 'k1');

				// Should not throw; should leave registered entries alone.
				yield* engine.invalidateSubset(new Set(['ghost']));

				const cache = yield* Ref.get(engine._shadowCache);
				expect(cache.has('k1')).toBe(true);
			}),
	);

	it.effect('P3.T2c — invalidateSubset({}) is a no-op', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			const k = yield* registerScopeForKey(engine, 'k');

			yield* engine.invalidateSubset(new Set<string>());

			expect(yield* Ref.get(k.finalizedRef)).toBe(false);
			const cache = yield* Ref.get(engine._shadowCache);
			expect(cache.has('k')).toBe(true);
		}),
	);

	it.live(
		'P3.T5 — user-r path (requestRestart) does NOT call invalidateSubset and does NOT touch scopes',
		() =>
			// Pinning the user-vs-watch split: pressing `r` is the explicit
			// "tear down EVERYTHING" gesture, but it does so by closing the
			// supervisor's outer scope (which cascades into every primitive's
			// scope via MemoMap). `invalidateSubset` is the watch-driven,
			// targeted path. `requestRestart` must not touch the per-primitive
			// scope registry or the shadow cache — those belong to the
			// selective-restart machinery.
			Effect.gen(function* () {
				const engine = yield* buildEngine();
				const k = yield* registerScopeForKey(engine, 'k');

				// Fire `requestRestart` and pull it off the queue (so this
				// test doesn't leak a pending wake into the next test).
				const fiber = yield* Effect.forkChild(engine.awaitRestart);
				yield* engine.requestRestart;
				yield* Fiber.join(fiber);

				expect(yield* Ref.get(k.finalizedRef)).toBe(false);
				const cache = yield* Ref.get(engine._shadowCache);
				expect(cache.has('k')).toBe(true);
			}),
	);

	it.effect('shadow cache survives an explicit close of an unrelated primitive scope', () =>
		// The shadow-cache eviction path is `invalidateSubset` exclusively
		// — `closePrimitiveScope` (which `invalidateSubset` calls internally)
		// does NOT touch the shadow cache when invoked separately. This is
		// load-bearing because the supervisor's `r` path does NOT go through
		// `invalidateSubset` — it closes the outer scope which cascades to
		// every primitive's scope, but doesn't re-populate the shadow cache
		// (a fresh cycle does that when its primitives register their
		// scopes anew). Mid-cycle: the shadow cache stays in sync with
		// what's registered, no orphan entries.
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* registerScopeForKey(engine, 'k1');

			yield* engine.closePrimitiveScope('k1');

			// `closePrimitiveScope` on its own leaves the shadow cache
			// entry in place — `invalidateSubset` is the surface that
			// evicts. (The next watch-fire that targets k1 via
			// `invalidateSubset` will both close + evict in one call.)
			const cache = yield* Ref.get(engine._shadowCache);
			expect(cache.has('k1')).toBe(true);
		}),
	);
});

describe('EngineHandle meta-tests — Phase 3 deletions', () => {
	// P3.T6 — `notifyChangedTags` was removed when `invalidateSubset`
	// shipped. The watch fiber used to call `notifyChangedTags(matched
	// keys)` BEFORE `requestRestart` so the next cycle could log "triggered
	// by …"; under selective restart there's no next cycle to log on, the
	// watch fiber handles the cascade message inline. The API + the Ref +
	// the cycle-log call site are all deleted.
	//
	// `@ts-expect-error` ratchets the rule: any future PR that brings the
	// surface back will fail this test because the `notifyChangedTags`
	// field won't be there to error on (the expect-error then fails
	// because the line typechecks). Type-level assertion paired with a
	// runtime presence check for belt-and-braces.

	it.effect('notifyChangedTags is gone from the EngineHandleShape', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			// @ts-expect-error — `notifyChangedTags` was removed in Phase 3.
			expect(engine.notifyChangedTags).toBeUndefined();
			// @ts-expect-error — `changedTags` was removed in Phase 3.
			expect(engine.changedTags).toBeUndefined();
			// @ts-expect-error — `clearChangedTags` was removed in Phase 3.
			expect(engine.clearChangedTags).toBeUndefined();
		}),
	);
});
