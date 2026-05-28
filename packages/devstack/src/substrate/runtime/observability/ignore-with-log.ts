// Best-effort with diagnostic breadcrumb — pipe-fn helpers.
//
// STYLE_GUIDE §18 calls out the "best-effort cleanup must still leave
// a visible breadcrumb" rule:
//
//   `.pipe(Effect.ignore)` on a best-effort effect silently swallows
//   the failure. Cleanup paths (router scope-close, lifecycle-prune
//   roster reads, faucet warm-up retries) tolerate the failure but
//   must NOT lose the cause — the cause has to land in the log
//   stream so a leaked dispatch file / stale roster / dead faucet
//   doesn't go silent.
//
// Two surfaces:
//
//   - `logDebugAndIgnore(message, attrs?)` — for diagnostic-only
//     failures whose only consequence is missing telemetry (a
//     roster file that didn't exist yet, an empty live-pid set).
//     Routes the cause through `Effect.logDebug` so the line ends up
//     in the buffered log but doesn't surface to the operator
//     stream.
//   - `logWarningAndIgnore(message, attrs?)` — for failures that
//     COULD indicate a real problem (a scope-close cleanup that
//     could leak a file, contention on a lock we expected to hold)
//     but which the local call site can't act on. Routes the cause
//     through `Effect.logWarning` so it appears in operator output.
//
// Both helpers use `Effect.tapCause` so the full Cause (defects,
// interruptions, error stacks) is preserved in the `cause` log
// annotation; the underlying `Effect.ignore` then collapses the
// effect to `void` with no error channel.
//
// For sites that need a fallback VALUE (not just ignore), use
// `logDebugAndFallback(fallback, message, attrs?)` /
// `logWarningAndFallback(fallback, message, attrs?)`. These mirror
// the lifecycle-prune pattern where a missing roster collapses to an
// empty live-pid array.

import { Effect } from 'effect';

type LogAttrs = Readonly<Record<string, unknown>>;

const mergeAttrs = (attrs: LogAttrs | undefined, cause: unknown): LogAttrs =>
	attrs === undefined ? { cause } : { ...attrs, cause };

/** Tap the cause through `Effect.logDebug`, then collapse to `void`.
 *  For best-effort cleanup whose only consequence is missing
 *  telemetry. */
export const logDebugAndIgnore =
	(message: string, attrs?: LogAttrs) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
		self.pipe(
			Effect.tapCause((cause) => Effect.logDebug(message, mergeAttrs(attrs, cause))),
			Effect.ignore,
		);

/** Tap the cause through `Effect.logWarning`, then collapse to `void`.
 *  For best-effort cleanup that COULD indicate a real leak / drop. */
export const logWarningAndIgnore =
	(message: string, attrs?: LogAttrs) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
		self.pipe(
			Effect.tapCause((cause) => Effect.logWarning(message, mergeAttrs(attrs, cause))),
			Effect.ignore,
		);

/** Tap the cause through `Effect.logDebug`, then catch into a fallback
 *  value. For diagnostic-only failures whose downstream call needs a
 *  concrete value (e.g. roster read collapses to empty live-pid set). */
export const logDebugAndFallback =
	<F>(fallback: F, message: string, attrs?: LogAttrs) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | F, never, R> =>
		self.pipe(
			Effect.tapCause((cause) => Effect.logDebug(message, mergeAttrs(attrs, cause))),
			Effect.catch(() => Effect.succeed(fallback)),
		);

/** Tap the cause through `Effect.logWarning`, then catch into a
 *  fallback value. For failures that COULD indicate a real problem
 *  but which the local call site can't act on. */
export const logWarningAndFallback =
	<F>(fallback: F, message: string, attrs?: LogAttrs) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | F, never, R> =>
		self.pipe(
			Effect.tapCause((cause) => Effect.logWarning(message, mergeAttrs(attrs, cause))),
			Effect.catch(() => Effect.succeed(fallback)),
		);
