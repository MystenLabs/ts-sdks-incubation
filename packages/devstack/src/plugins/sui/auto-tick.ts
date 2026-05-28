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

import { Effect, Schedule, type Scope } from 'effect';

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
	const { intervalMs } = option;
	if (typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs > 0) {
		return intervalMs;
	}
	throw suiConfigError({
		field: 'autoTick.intervalMs',
		message: `sui: autoTick.intervalMs must be a positive finite number (got ${String(intervalMs)})`,
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
 */
export const runAutoTickClock = (
	advancer: ClockAdvancer,
	intervalMs: number,
): Effect.Effect<void, never, Scope.Scope> =>
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
		yield* tick.pipe(Effect.repeat(Schedule.spaced(`${intervalMs} millis`)), Effect.forkScoped);
	});
