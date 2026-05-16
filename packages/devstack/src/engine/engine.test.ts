// Engine focuses on a tiny set of state transitions over a Ref of
// `TuiState`. Most of the surface is covered by the ink component tests
// (which render the resolved state via the production engine). The
// transitions we lock down here are the ones that are easy to break in
// isolation: phase narration + the implicit clear-on-terminal logic that
// keeps `(running genesis)` from sticking to a `ready` row.

import { Cause, Context, Deferred, Effect, Layer, Ref } from 'effect';
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

describe('EngineHandle restart signaling — request / arm / process-during', () => {
	// Hot-restart triggers (file watcher, SIGUSR2, TUI `r`) all converge
	// on `requestRestart`. The launch loop awaits the current Deferred,
	// then calls `armRestartSignal` IMMEDIATELY after wake to swap in a
	// fresh one before any processing. The split between request (just
	// succeeds the current deferred) and arm (only the loop swaps) closes
	// the lost-wake-up race the previous swap-in-request design had:
	//
	//   OLD bug: `requestRestart` swapped in a fresh deferred AND
	//   succeeded the old one. A request that landed between wake and
	//   the loop's next read would swap in a deferred that the loop's
	//   later reset would overwrite — the succeed went to a deferred no
	//   one was awaiting. Lost wake-up.
	//
	//   NEW: only the loop swaps (via `armRestartSignal`, atomically
	//   right after wake). A request that lands during processing
	//   succeeds the FRESHLY ARMED deferred, and the loop's next await
	//   observes it instantly. No orphan deferreds.

	it.effect('requestRestart succeeds the current deferred without swapping', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			const before = yield* Ref.get(engine.restartSignal);

			yield* engine.requestRestart;
			yield* Deferred.await(before);

			// Ref still holds the SAME deferred — request doesn't swap.
			const after = yield* Ref.get(engine.restartSignal);
			expect(after).toBe(before);
			expect(yield* Deferred.isDone(after)).toBe(true);
		}),
	);

	it.effect(
		'concurrent requestRestart calls coalesce into a single wake (Deferred.succeed is idempotent)',
		() =>
			Effect.gen(function* () {
				const engine = yield* buildEngine();
				const d = yield* Ref.get(engine.restartSignal);

				// Fire many concurrent requests against the same deferred.
				yield* Effect.all(
					Array.from({ length: 8 }, () => engine.requestRestart),
					{ concurrency: 'unbounded' },
				);

				// Only one wake-up is observed (idempotent succeed); the
				// deferred is resolved exactly once.
				yield* Deferred.await(d);
				expect(yield* Deferred.isDone(d)).toBe(true);
			}),
	);

	it.effect(
		'armRestartSignal installs a fresh deferred without disturbing the previously resolved one',
		() =>
			Effect.gen(function* () {
				const engine = yield* buildEngine();
				const before = yield* Ref.get(engine.restartSignal);
				yield* engine.requestRestart;

				yield* engine.armRestartSignal;
				const after = yield* Ref.get(engine.restartSignal);

				// Fresh deferred installed; previously-resolved deferred stays
				// resolved so any fiber that captured it pre-arm still wakes.
				expect(after).not.toBe(before);
				yield* Deferred.await(before);
				expect(yield* Deferred.isDone(after)).toBe(false);
			}),
	);

	it.effect('regression: request during processing wakes the next cycle (no lost signal)', () =>
		// Simulates the wake → arm → request-lands → next-await sequence
		// that the OLD code mishandled. The fresh deferred armed
		// immediately after wake must be the one that the request
		// succeeds, and the next await must observe that success.
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			const cycleN = yield* Ref.get(engine.restartSignal);

			// Cycle N: a request lands, loop wakes.
			yield* engine.requestRestart;
			yield* Deferred.await(cycleN);

			// Loop arms a fresh deferred BEFORE doing any restart work.
			yield* engine.armRestartSignal;
			const cycleNplus1 = yield* Ref.get(engine.restartSignal);
			expect(cycleNplus1).not.toBe(cycleN);
			expect(yield* Deferred.isDone(cycleNplus1)).toBe(false);

			// A new request lands during cycle N+1 setup (between arm and
			// the next await). It succeeds the freshly armed deferred.
			yield* engine.requestRestart;

			// The next cycle's await observes the success immediately —
			// the wake-up is NOT lost.
			yield* Deferred.await(cycleNplus1);
			expect(yield* Deferred.isDone(cycleNplus1)).toBe(true);
		}),
	);
});

describe('EngineHandle.notifyChangedTags watch-event attribution', () => {
	// The watcher fiber calls `notifyChangedTags` BEFORE `requestRestart`
	// so the next cycle's launch can read the Ref to surface which
	// primitive(s) triggered this restart. The Ref de-dupes across
	// repeated notifications (e.g. two debounced events on overlapping
	// paths) and clears on `clearChangedTags` so each cycle starts with
	// fresh attribution.

	it.effect('accumulates de-duped tag keys across multiple notify calls', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.notifyChangedTags(['publish.hello']);
			yield* engine.notifyChangedTags(['bindings.hello', 'publish.hello']);
			const tags = yield* Ref.get(engine.changedTags);
			// Set-merge order isn't guaranteed; assert membership instead.
			expect([...tags].sort()).toEqual(['bindings.hello', 'publish.hello']);
		}),
	);

	it.effect('clears on clearChangedTags so each cycle starts fresh', () =>
		Effect.gen(function* () {
			const engine = yield* buildEngine();
			yield* engine.notifyChangedTags(['publish.hello']);
			yield* engine.clearChangedTags;
			const tags = yield* Ref.get(engine.changedTags);
			expect(tags).toEqual([]);
		}),
	);

	it.effect('an empty notify is a noop (existing attribution preserved)', () =>
		Effect.gen(function* () {
			// A watcher fiber that hashes a directory event (no `__watchPaths`
			// match) skips notify entirely — pinning this so a future refactor
			// that always calls notify with []`empty doesn't accidentally
			// clobber a prior cycle's attribution.
			const engine = yield* buildEngine();
			yield* engine.notifyChangedTags(['publish.hello']);
			yield* engine.notifyChangedTags([]);
			const tags = yield* Ref.get(engine.changedTags);
			expect(tags).toEqual(['publish.hello']);
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
				op: 'sui move build',
				message: "sui move build exited 2: error: unexpected argument '--json' found",
			});
			const wrapped = new PublishError({
				stage: 'build',
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
				op: 'docker run',
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
