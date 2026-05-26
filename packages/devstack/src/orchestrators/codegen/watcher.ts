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

import { Effect, Ref, Stream } from 'effect';

import type { Codegenable } from './service.ts';

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
 * `contributions` (a Stream of `ReadonlyArray<Codegenable>`)
 * emits a new value.
 *
 * Architecture posture: codegen is NOT a long-running service. The
 * fiber is bound to the supervisor's scope; when the stack scope
 * closes, the fiber dies. We use a `Ref<latest>` so the most
 * recent contribution set always wins on a coalesced burst.
 */
export const watchContributions = <E, R>(
	contributions: Stream.Stream<ReadonlyArray<Codegenable>, E, R>,
	runEmitCycle: (decls: ReadonlyArray<Codegenable>) => Effect.Effect<void, E, R>,
): Effect.Effect<void, E, R> =>
	Effect.gen(function* () {
		const latest = yield* Ref.make<ReadonlyArray<Codegenable> | null>(null);
		// Run a side-effecting tap on the contribution stream. The tap
		// stores the latest set and triggers the emit cycle. If two
		// updates arrive while a cycle is in-flight, the next cycle
		// sees only the latest — coalescing avoids HMR storms.
		yield* contributions.pipe(
			Stream.tap((decls) => Ref.set(latest, decls)),
			Stream.tap(() =>
				Effect.gen(function* () {
					const decls = yield* Ref.get(latest);
					if (decls !== null) yield* runEmitCycle(decls);
				}),
			),
			Stream.runDrain,
		);
	}).pipe(Effect.withSpan('codegen.watchContributions'));
