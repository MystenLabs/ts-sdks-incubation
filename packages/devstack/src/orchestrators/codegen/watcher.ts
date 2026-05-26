// Codegen file watcher — re-emit on contribution change.
//
// Distilled-doc §"On-change (watched re-emit)" + §"Output dir
// excluded from watcher": when the supervisor restarts due to any
// watched input change, codegen re-runs as part of the new cycle.
// The output directory itself MUST be excluded from the watcher so
// the atomic rename does not feed back into a restart loop.
//
// Architecture seam:
//   - The watcher's INPUT is not files — it is the substrate's
//     SubscriptionRef of resolved-plugin state. When any plugin's
//     resolved value changes (because its acquire re-ran), the
//     orchestrator's watcher trips and re-emits.
//   - For the bindings emitter, the input INCLUDES Move-source
//     mtimes. The bindings sub-watcher polls the source tree once
//     per cycle (the v3 implementation did the same).
//
// This module ships:
//   - `excludeFromWatcher(outputDir)` — declarative path the
//     substrate watcher consults.
//   - `watchContributions(...)` — composes a re-emit fiber that
//     observes a contribution stream and calls `runEmitCycle()` on
//     change.

import { Effect, Stream } from 'effect';

import type { Codegenable } from './service.ts';

/**
 * Coalescing window for the contribution stream. Acquire-side
 * supervisor restarts can republish a contribution set several times
 * in quick succession (one event per plugin that re-acquires); a
 * trailing-edge debounce collapses that burst into ONE emit cycle.
 *
 * 150ms is a typical HMR-friendly window — small enough that a
 * single human-typed save still feels instant, large enough to swallow
 * the multi-event acquire fan-out. The previous `Ref<latest>` + tap
 * pattern claimed to coalesce but actually ran one full emit cycle
 * per source emission (each cycle is a stage-and-swap, so bursts
 * produced HMR storms — opportunities-backlog #9).
 */
export const CONTRIBUTION_DEBOUNCE_MS = 150;

/**
 * Declare the output dir as excluded from the substrate's thick
 * file watcher. The watcher implementation reads this list to skip
 * path-prefix matches.
 *
 * Pure helper — returns the literal exclusion pattern. Wired into
 * the supervisor by the orchestrator's boot Layer.
 */
export const excludeFromWatcher = (outputDir: string): { readonly excludeGlob: string } => ({
	// Glob form so the watcher's minimatch filter trims it pre-
	// debounce. Trailing `/**` covers all descendants.
	excludeGlob: `${outputDir.replace(/\/+$/, '')}/**`,
});

/**
 * Spawn a re-emit fiber that re-runs the codegen cycle whenever
 * `contributions` (a Stream of `ReadonlyArray<Codegenable>`) emits
 * a new value.
 *
 * Coalescing: `Stream.debounce` keeps only the LAST emission inside
 * each `CONTRIBUTION_DEBOUNCE_MS` window, then runs the cycle once.
 * Without it, an acquire-side burst of N plugin restarts would
 * trigger N stage-and-swap cycles back-to-back (HMR storm).
 *
 * Architecture posture: codegen is NOT a long-running service. The
 * fiber is bound to the supervisor's scope; when the stack scope
 * closes, the stream finalizes and the fiber dies.
 */
export const watchContributions = <E, R>(
	contributions: Stream.Stream<ReadonlyArray<Codegenable>, E, R>,
	runEmitCycle: (decls: ReadonlyArray<Codegenable>) => Effect.Effect<void, E, R>,
): Effect.Effect<void, E, R> =>
	contributions.pipe(
		Stream.debounce(`${CONTRIBUTION_DEBOUNCE_MS} millis`),
		Stream.mapEffect((decls) => runEmitCycle(decls)),
		Stream.runDrain,
		Effect.withSpan('codegen.watchContributions'),
	);
