// Fork-mode seed-objects accumulator.
//
// Distilled-doc finding (5-sui § Opportunities): today's code uses
// a module-scope `Set<string>` with an explicit
// `clearKnownPackageSeedObjects()` contract between composes. That
// is a foot-gun — tests that compose more than once must remember
// to clear; the responsibility sits with the user, not the
// framework.
//
// Fix: confine the accumulator to plugin-instance state. Each
// `sui()` factory call constructs a fresh `SeedObjectsAccumulator`
// inside its acquire body's scope; KnownPackage declarations
// elsewhere in the stack discover it via the StrategyContributor
// registry (`sui:seed-objects`).
//
// The substrate-redesign substrate-violations document already
// flags module-scope mutable state as forbidden; this file is the
// implementation of the cure.

import { Effect, Ref } from 'effect';

/** Plugin-instance-scoped accumulator. Constructed inside the
 *  Sui plugin's `acquire` body; the lifetime is the plugin's scope. */
export interface SeedObjectsAccumulator {
	/** Merge a set of seed object ids. KnownPackage declarations
	 *  call this during their own acquire — Sui's fork builder
	 *  reads the accumulated set AFTER scheduler ordering puts
	 *  KnownPackage upstream of the fork container. */
	readonly contribute: (objects: ReadonlyArray<string>) => Effect.Effect<void>;
	/** Snapshot the accumulated set. Called by fork's acquire when
	 *  composing the `--object` seed flags. */
	readonly snapshot: Effect.Effect<ReadonlyArray<string>>;
}

/** Capability key the StrategyContributor registry dispatches on.
 *  KnownPackage declarations look this up; Sui's fork mode
 *  contributes it from inside acquire. */
export const SEED_OBJECTS_CAPABILITY_KEY = 'sui:seed-objects' as const;

/** Construct a fresh accumulator. Each Sui plugin instance gets
 *  one — the substrate's scope-boundary handles isolation across
 *  parallel stacks. */
export const makeSeedObjectsAccumulator = (): Effect.Effect<SeedObjectsAccumulator> =>
	Effect.gen(function* () {
		const ref = yield* Ref.make<ReadonlyArray<string>>([]);

		const contribute = (objects: ReadonlyArray<string>): Effect.Effect<void> =>
			Ref.update(ref, (prev) => {
				// Stable union — sorted + lowercased so the configHash
				// is invariant under contribution order (architecture
				// § sui § Invariants).
				const set = new Set(prev);
				for (const o of objects) set.add(o.toLowerCase());
				return Array.from(set).sort();
			});

		const snapshot = Ref.get(ref);

		return { contribute, snapshot };
	});
