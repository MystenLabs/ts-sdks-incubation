// Auto-tick clock — local-mode-only.
//
// Architecture invariant: "Auto-tick is local-mode-only" — the
// public option is exposed only on fork (where it advances the
// fork binary's clock + checkpoint) AND local (where it nudges
// localnet's consensus to commit pending txs in tests that don't
// produce traffic).
//
// The fiber is `forkScoped` against the plugin's acquire scope:
// teardown happens automatically on wipe/restart/Ctrl-C. Failure
// policy is **log-warn-and-continue** — a single advance-clock
// RPC failure must not break the supervisor.

import { Effect, Schedule, type Fiber, type Scope } from 'effect';

import { expectPositiveFiniteNumber } from '../../substrate/runtime/config-validation.ts';
import { SpanAttr } from '../../substrate/runtime/observability/spans.ts';
import { suiConfigError } from './errors.ts';
import type { SuiPluginError } from './errors.ts';
import { SuiSpans } from './spans.ts';

/** Public knob shape mirroring the user-facing API. */
export type AutoTickOption = boolean | { readonly intervalMs: number };

/** Default cadence when caller passes `autoTick: true`. */
export const DEFAULT_AUTO_TICK_INTERVAL_MS = 1000;

/** Resolve the public option to a numeric interval. Returns
 *  `undefined` when auto-tick is OFF. Throws on a misconfigured
 *  option (0 / negative / non-finite) — the substrate's
 *  acquire-time validation catches this before any I/O. */
export const resolveAutoTickIntervalMs = (option?: AutoTickOption): number | undefined => {
	if (option === undefined || option === false) return undefined;
	if (option === true) return DEFAULT_AUTO_TICK_INTERVAL_MS;
	return expectPositiveFiniteNumber(option.intervalMs, {
		field: 'autoTick.intervalMs',
		message: `sui: autoTick.intervalMs must be a positive finite number (got ${String(
			option.intervalMs,
		)})`,
		mkError: suiConfigError,
	});
};

/** Plugin-internal shim — the minimal admin surface the auto-tick
 *  fiber needs. Local-mode wires this to a no-op (localnet's
 *  validator advances its own clock); fork-mode wires it to the
 *  `ForkingService.advanceClock` gRPC method. Stub: the concrete
 *  gRPC binding lands when the Mysten Sui SDK is introduced. */
export interface ClockAdvancer {
	readonly advanceClock: (intervalMs: number) => Effect.Effect<void, SuiPluginError>;
}

/**
 * Fork a scope-bound fiber that calls `advanceClock(intervalMs)` on
 * a `Schedule.spaced(intervalMs)` cadence. The fiber dies on the
 * surrounding scope's close (wipe / restart / Ctrl-C).
 *
 * Returns the fiber handle. Today's code discards the handle — the
 * distilled doc flags a designed-for-but-not-landed re-config path
 * (`engine/sui-fork/control.ts` opportunity). We keep the handle
 * returned so a future cadence-change surface has a join point.
 */
export const runAutoTickClock = (
	advancer: ClockAdvancer,
	intervalMs: number,
): Effect.Effect<Fiber.Fiber<void>, never, Scope.Scope> =>
	Effect.gen(function* () {
		const tick = advancer.advanceClock(intervalMs).pipe(
			Effect.catch((err) =>
				Effect.logWarning('sui auto-tick advance failed; next tick will retry').pipe(
					Effect.annotateLogs({
						[SuiSpans.autoTickIntervalMs]: intervalMs,
						[SpanAttr.phase]: err.phase,
						[SpanAttr.errorMessage]: err.message,
					}),
				),
			),
		);
		const fiber = yield* tick.pipe(
			Effect.repeat(Schedule.spaced(`${intervalMs} millis`)),
			Effect.forkScoped,
		);
		return fiber as Fiber.Fiber<void>;
	});

/** Build a no-op advancer for local mode. Localnet's validator
 *  drives consensus on its own; the auto-tick fiber surface exists
 *  for symmetry but doesn't have anything to advance. */
export const noopClockAdvancer: ClockAdvancer = {
	advanceClock: () => Effect.void as Effect.Effect<void, SuiPluginError>,
};
