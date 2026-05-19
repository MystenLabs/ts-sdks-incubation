// Fork-mode "live-control" helpers — the supervisor-side surface that
// drives a running `sui-fork` container beyond the one-shot admin RPCs
// (`status`, `advanceClock`, `advanceCheckpoint`, `impersonate`) that
// `buildForkControl` in `services/sui.ts` already exposes.
//
// Two responsibilities, file-disjoint from the rest of the sui-fork
// engine bits so the supervisor's call site stays a one-liner each:
//
//   - `resolveAutoTickIntervalMs` + `runAutoTickClock` — translates the
//     public `SuiForkOptions.autoTick` knob (`boolean | { intervalMs:
//     number }`) into a wall-clock interval and forks a scope-bound
//     fiber that calls `ForkControl.advanceClock(intervalMs)` on a
//     `Schedule.spaced(intervalMs)` cadence. The fiber dies cleanly on
//     scope teardown (the surrounding stack acquire's scope), so wipe /
//     restart / Ctrl-C all stop the tick without orphaning anything.
//
//   - `subscribeCheckpoints` + `subscribeCheckpointsWithFallback` —
//     wraps the SDK's `SubscriptionServiceClient.subscribeCheckpoints`
//     server-streaming RPC in an `Effect.Stream`. The fallback variant
//     catches stream errors (the fork may not implement the
//     subscription RPC, the connection may drop, etc.) and switches to
//     a polling `Schedule.spaced(2s)` loop over
//     `forkingService.GetStatus` until the next consumer-driven retry.
//
// Why these live in `engine/sui-fork/` and not `services/sui.ts`: the
// helpers know about the SDK's wire shape (`SuiGrpcClient`,
// `ForkingServiceClient`, `SubscriptionServiceClient`) but NOT about
// the supervisor's identity / docker / phase machinery. Splitting them
// out keeps `services/sui.ts` focused on lifecycle wiring and lets a
// future fork-control front-end (`packages/dev-wallet` panel, an
// `examples/fork-greeting` script) reach for these primitives directly.

import { Effect, type Fiber, Result, Schedule, type Scope, Stream } from 'effect';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiError } from '../errors.js';
import { stringifyCause } from '../stringify-cause.js';

// -----------------------------------------------------------------------------
// Auto-tick clock
// -----------------------------------------------------------------------------

/** Default cadence when the caller passes `autoTick: true` without an
 *  explicit interval. 1s keeps clock-gated Move logic moving without
 *  flooding the fork with consensus-commit-prologue txs. */
export const DEFAULT_AUTO_TICK_INTERVAL_MS = 1000;

/** Public shape of the `SuiForkOptions.autoTick` knob. `false` /
 *  `undefined` mean "no auto-tick"; `true` means "tick every
 *  `DEFAULT_AUTO_TICK_INTERVAL_MS`"; the object form lets the caller
 *  pin a custom cadence. */
export type AutoTickOption = boolean | { readonly intervalMs: number };

/** Translate the public knob into a numeric interval in milliseconds
 *  (or `undefined` when auto-tick is off). Centralized so the
 *  `services/sui.ts` call site, the dev-wallet relay, and tests all
 *  see the same defaulting + validation rules. */
export const resolveAutoTickIntervalMs = (option?: AutoTickOption): number | undefined => {
	if (option === undefined || option === false) return undefined;
	if (option === true) return DEFAULT_AUTO_TICK_INTERVAL_MS;
	const ms = option.intervalMs;
	// Defensive: a 0 / negative / non-finite interval would loop the
	// fork's advance-clock RPC as fast as the event loop allows. Treat
	// it as a configuration error.
	if (!Number.isFinite(ms) || ms <= 0) {
		throw new Error(
			`Sui({fork:{autoTick:{intervalMs}}}): intervalMs must be a positive finite number ` +
				`(got ${String(ms)}).`,
		);
	}
	return ms;
};

/**
 * Resume-aware variant — folds an on-disk `ForkMeta.runtime.autoTickMs`
 * in as a fallback when the caller did NOT pass a
 * fresh `autoTick` option. Precedence:
 *
 *   1. Fresh option present (any of `true` / `false` / `{intervalMs}`)
 *      → that wins. Including the explicit `false` case, which is how
 *      a caller turns auto-tick *off* across a resume.
 *   2. No fresh option AND a saved cadence on disk → use the saved
 *      value (the supervisor's previous boot wrote it via
 *      `ensureForkMetaConsistent`).
 *   3. Neither → `undefined`. Auto-tick stays off.
 *
 * The saved value is validated before reuse: a non-positive / non-
 * finite number is treated as a corrupt meta and ignored (the
 * supervisor doesn't loop advance-clock at infinite rate just because
 * an operator hand-edited `meta.json`).
 */
export const resolveResumeAutoTickIntervalMs = (args: {
	readonly option?: AutoTickOption;
	readonly savedAutoTickMs?: number;
}): number | undefined => {
	if (args.option !== undefined) {
		return resolveAutoTickIntervalMs(args.option);
	}
	const saved = args.savedAutoTickMs;
	if (saved === undefined || !Number.isFinite(saved) || saved <= 0) return undefined;
	return saved;
};

/** Effect-side advance-clock RPC the fiber loops on. Mirrors
 *  `buildForkControl`'s `advanceClock` but accepts the client + the
 *  ms-to-advance directly so it's testable without spinning up the
 *  full `ForkControl` adapter. */
const advanceClockOnce = (
	client: SuiGrpcClient,
	durationMs: number,
): Effect.Effect<void, SuiError> =>
	Effect.tryPromise({
		try: () => client.forkingService.advanceClock({ durationMs: BigInt(durationMs) }).response,
		catch: (cause) =>
			new SuiError({
				phase: 'fork-advance-clock',
				message: `auto-tick: advanceClock(${durationMs}ms) failed: ${stringifyCause(cause)}`,
				cause,
			}),
	}).pipe(Effect.asVoid);

/**
 * Fork a scope-bound auto-tick fiber. Returns the running fiber so the
 * supervisor can keep a reference (e.g. for explicit `Fiber.interrupt`
 * on a re-config) without losing the cleaner scope-tied teardown.
 *
 * Failure policy: a single `advanceClock` failure is logged at WARN
 * and the loop continues — the fork may be mid-restart, the operator
 * may be running a manual `advanceCheckpoint` that serializes against
 * the clock, or the gRPC connection may have hiccupped. We deliberately
 * do NOT propagate the failure into the outer scope: an auto-tick
 * blip should not tear the whole stack down.
 */
export const runAutoTickClock = (args: {
	readonly client: SuiGrpcClient;
	readonly intervalMs: number;
}): Effect.Effect<Fiber.Fiber<unknown, never>, never, Scope.Scope> =>
	Effect.gen(function* () {
		const tick = advanceClockOnce(args.client, args.intervalMs).pipe(
			Effect.catch((cause) =>
				Effect.logWarning(`sui-fork auto-tick: ${stringifyCause(cause)}`).pipe(Effect.asVoid),
			),
			Effect.withSpan('SuiForkAutoTickTick', {
				attributes: { 'fork.autoTick.intervalMs': args.intervalMs },
			}),
		);
		return yield* Effect.forkScoped(tick.pipe(Effect.repeat(Schedule.spaced(args.intervalMs))));
	});

// -----------------------------------------------------------------------------
// Subscriptions
// -----------------------------------------------------------------------------

/** Stable wire shape emitted on every checkpoint event. Mirrors the
 *  SDK's `SubscribeCheckpointsResponse` (cursor + the checkpoint body)
 *  but collapses bigint fields to `number` for parity with `ForkStatus`
 *  and exposes only the bits downstream consumers (the `fork status
 *  --follow` CLI, the dev-wallet panel) actually need. */
export interface ForkCheckpointEvent {
	readonly cursor: number;
	readonly source: 'subscription' | 'poll';
	/** When the event was synthesized on the consumer side. Useful for
	 *  the CLI's `--follow` mode timestamp column. */
	readonly receivedAtMs: number;
}

/**
 * Server-streaming `SubscribeCheckpoints` wrapped as an `Effect.Stream`.
 * The stream emits one `ForkCheckpointEvent` per upstream message and
 * closes when the server closes. Errors propagate through the stream's
 * error channel (the caller is expected to wrap with the fallback
 * variant below for a polling cushion).
 *
 * Implementation note: the SDK's `subscriptionService.subscribeCheckpoints`
 * returns a `ServerStreamingCall` whose `.responses` is an
 * `AsyncIterable<SubscribeCheckpointsResponse>`. We adapt it via
 * `Stream.fromAsyncIterable`. The underlying gRPC stream is closed when
 * the caller drops the iterator (Effect tears it down on scope close).
 */
export const subscribeCheckpoints = (
	client: SuiGrpcClient,
): Stream.Stream<ForkCheckpointEvent, SuiError> =>
	Stream.unwrap(
		Effect.sync(() => {
			const call = client.subscriptionService.subscribeCheckpoints({});
			const iterable = call.responses;
			return Stream.fromAsyncIterable(
				iterable,
				(cause) =>
					new SuiError({
						phase: 'fork-status',
						message: `sui.fork.subscribeCheckpoints stream errored: ${stringifyCause(cause)}`,
						cause,
					}),
			).pipe(
				Stream.map(
					(resp): ForkCheckpointEvent => ({
						cursor: resp.cursor !== undefined ? Number(resp.cursor) : 0,
						source: 'subscription',
						receivedAtMs: Date.now(),
					}),
				),
			);
		}),
	);

/**
 * Polling backstop. Yields a synthetic `ForkCheckpointEvent` whenever
 * the local checkpoint sequence advances past the cursor we last saw.
 * Used as the fallback path on subscription disconnect (R4 of the
 * parent plan) and also as a standalone "I don't trust the subscription
 * RPC" implementation for the upstream-image-version detection layer
 * to fall back on.
 *
 * `pollIntervalMs` defaults to 2_000 ms — slow enough to be polite to
 * the fork process, fast enough that a checkpoint advance (which is
 * an operator-driven verb in fork mode) lands within a single human
 * reaction time.
 */
export const pollCheckpoints = (
	client: SuiGrpcClient,
	pollIntervalMs = 2_000,
): Stream.Stream<ForkCheckpointEvent, SuiError> => {
	const tick = Effect.tryPromise({
		try: () => client.forkingService.getStatus({}).response,
		catch: (cause) =>
			new SuiError({
				phase: 'fork-status',
				message: `sui.fork.pollCheckpoints GetStatus failed: ${stringifyCause(cause)}`,
				cause,
			}),
	});
	// `mapAccum` carries a `lastCursor` state across emissions so we
	// only surface a `ForkCheckpointEvent` when the local sequence
	// actually advances. Polling the fork's status at 2s cadence is
	// chatty by design; the dedupe keeps the consumer-side event stream
	// quiet between operator-driven advance-checkpoint verbs.
	return Stream.fromEffectSchedule(tick, Schedule.spaced(pollIntervalMs)).pipe(
		Stream.mapAccum(
			() => -1,
			(lastCursor, resp): readonly [number, ReadonlyArray<ForkCheckpointEvent>] => {
				const cursor = Number(resp.checkpointSequenceNumber);
				if (cursor <= lastCursor) return [lastCursor, []];
				return [
					cursor,
					[
						{
							cursor,
							source: 'poll',
							receivedAtMs: Date.now(),
						},
					],
				];
			},
		),
	);
};

/**
 * The R4 composite: subscribe first, fall back to polling on stream
 * error. The fallback path keeps polling indefinitely so a transient
 * subscription disconnect doesn't drop the consumer.
 *
 * Why not return a Stream that auto-promotes back to subscription
 * after a reconnect window: the parent plan's R4 explicitly trades
 * "perfect parity" for "polling stays alive" — re-attempting the
 * subscription mid-stream would race against checkpoint advances that
 * landed during the gap, which is exactly the problem polling
 * sidesteps. Consumers that want subscription parity post-reconnect
 * can re-acquire the stream (drop the current one, call
 * `subscribeCheckpointsWithFallback` again).
 */
export const subscribeCheckpointsWithFallback = (
	client: SuiGrpcClient,
	pollIntervalMs = 2_000,
): Stream.Stream<ForkCheckpointEvent, SuiError> =>
	subscribeCheckpoints(client).pipe(
		Stream.catch(() =>
			pollCheckpoints(client, pollIntervalMs).pipe(
				Stream.tap(() =>
					Effect.logDebug(
						`sui.fork.subscribeCheckpoints: subscription stream ended, polling at ${pollIntervalMs}ms`,
					),
				),
			),
		),
	);

// -----------------------------------------------------------------------------
// Test-only surface
// -----------------------------------------------------------------------------

/** Re-exported for tests that want to exercise the auto-tick / polling
 *  loops without spinning up a real fork container. The `Result` re-
 *  export is incidental — tests building synthetic streams for `catch`
 *  cases reuse it. */
export const _internal = {
	advanceClockOnce,
	Result,
};
