// Shared phase-error failer factory.
//
// The four snapshot orchestrators (capture / restore / prune / wipe)
// each define a phase-tagged error class and the SAME curried failer
// shape over it:
//
//   (phase, detail, plugin?) => (cause: unknown) => Effect.fail(
//     new XPhaseError({ phase, detail, cause, ...(plugin ? { plugin } : {}) }))
//
// The error CLASSES differ (distinct `_tag`s, distinct `phase`
// literal unions, and only capture/restore carry an optional
// `plugin`), so the factory is parameterized on the constructor.
// `makePhaseFailer(ErrorClass)` returns that orchestrator's curried
// failer; each call site keeps byte-identical behavior.
//
// The sibling `lifecycle-prune/errors.ts` failer is intentionally NOT
// built on this — it is a single-curry-level `(phase) => (cause) =>
// new LifecyclePruneError(...)` that returns a plain error (not an
// `Effect.fail`), takes a typed `DockerRuntimeError`, and synthesizes
// its own `detail`. Different model; left alone.

import { Effect } from 'effect';

/** Fields the factory needs to construct any of the snapshot phase
 *  errors. `plugin` is optional and only consumed by the error classes
 *  that declare it (capture / restore); the prune / wipe classes ignore
 *  it (the factory never passes a key for those call sites). */
interface PhaseErrorFields<Phase extends string> {
	readonly phase: Phase;
	readonly detail: string;
	readonly cause?: unknown;
	readonly plugin?: string;
}

/**
 * Build an orchestrator's curried error-failer from its phase-tagged
 * error constructor.
 *
 * `makePhaseFailer(XPhaseError)` returns
 * `(phase, detail, plugin?) => (cause) => Effect.fail(new XPhaseError(...))`.
 *
 * The `plugin` argument is forwarded only when defined, so call sites
 * for the plugin-less classes (`PrunePhaseError`, `WipePhaseError`)
 * produce the exact same constructor payload as before.
 */
export const makePhaseFailer =
	<Phase extends string, E>(ErrorClass: new (fields: PhaseErrorFields<Phase>) => E) =>
	(
		phase: Phase,
		detail: string,
		plugin?: string,
	): ((cause: unknown) => Effect.Effect<never, E>) =>
	(cause) =>
		Effect.fail(
			new ErrorClass({ phase, detail, cause, ...(plugin === undefined ? {} : { plugin }) }),
		);
