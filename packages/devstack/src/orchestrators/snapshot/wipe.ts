// Wipe — label-scoped teardown.
//
// Architecture § Snapshot responsibilities:
//   "Provide a wipe operation scoped to one `(app, stack)` that tears
//   down containers, networks, volumes, and per-stack on-disk state,
//   with snapshots surviving by default."
//
// Label-scoped: enumeration uses partial `ContainerLabelTuple` filters
// (just `{ app, stack }`); the orchestrator does NOT reach for plugin
// names. The runtime adapter sweeps containers/networks/volumes
// matching the label set.

import { Effect, FileSystem, Schema } from 'effect';

import type { ContainerLabelTuple } from '../../contracts/snapshotable.ts';
import type { ContainerRuntime } from '../../contracts/container-runtime.ts';
import { makePhaseFailer } from './phase-error.ts';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class WipePhaseError extends Schema.TaggedErrorClass<WipePhaseError>()(
	'SnapshotWipePhaseError',
	{
		phase: Schema.Literals([
			'sweep-containers',
			'sweep-networks-volumes',
			'remove-state',
			'remove-runtime-tree',
		]),
		detail: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

const failPhase = makePhaseFailer(WipePhaseError);

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

export interface WipeInputs {
	readonly labelMatch: Pick<ContainerLabelTuple, 'app' | 'stack'>;
	readonly stackRoot: string;
	readonly stateFilePath: string;
	readonly runtime: ContainerRuntime;
	/** Preserve the snapshot catalog (default behavior). When false,
	 *  the catalog is removed alongside the runtime tree. */
	readonly keepSnapshots?: boolean;
	/** Preserve stack-local artifact caches. Defaults to false; wipe
	 *  should force on-chain artifacts to re-prove against the next
	 *  chain instead of carrying local ids across a reset. */
	readonly keepCache?: boolean;
}

// -----------------------------------------------------------------------------
// Wipe
// -----------------------------------------------------------------------------

/**
 * Tear down a stack's live footprint. Snapshots survive by default
 * (architecture § wipe).
 *
 * Order:
 *   1. Force-remove managed containers by `{ app, stack }` labels.
 *   2. Remove managed networks and volumes by the same label filter.
 *   3. Remove state.json.
 *   4. Remove the runtime tree EXCEPT the snapshot catalog by default.
 */
export const runWipe = (
	inputs: WipeInputs,
): Effect.Effect<void, WipePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* Effect.annotateCurrentSpan({
			'devstack.snapshot.phase': 'wipe',
			'devstack.app': inputs.labelMatch.app,
			'devstack.stack': inputs.labelMatch.stack,
		});

		// 1. Containers.
		yield* inputs.runtime
			.removeManagedContainers(inputs.labelMatch)
			.pipe(Effect.catch(failPhase('sweep-containers', `container sweep failed`)));

		// 2. Networks + volumes.
		yield* inputs.runtime
			.removeManagedNetworks(inputs.labelMatch)
			.pipe(Effect.catch(failPhase('sweep-networks-volumes', `network sweep failed`)));
		yield* inputs.runtime
			.removeManagedVolumes(inputs.labelMatch)
			.pipe(Effect.catch(failPhase('sweep-networks-volumes', `volume sweep failed`)));

		// 3. Remove state.json.
		yield* fs
			.remove(inputs.stateFilePath, { force: true })
			.pipe(Effect.catch(failPhase('remove-state', `remove state.json failed`)));

		// 4. Remove the runtime tree — but PRESERVE snapshots by default.
		//    Strategy: enumerate the stack root and remove each child
		//    whose name is not `snapshots/` (when preserved). Stack-local
		//    artifact caches are state and are removed unless explicitly
		//    requested otherwise.
		const children = yield* fs
			.readDirectory(inputs.stackRoot)
			.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
		const keepSnapshots = inputs.keepSnapshots ?? true;
		const keepCache = inputs.keepCache ?? false;
		for (const name of children) {
			if (keepSnapshots && name === 'snapshots') continue;
			if (keepCache && name === 'cache') continue;
			yield* fs
				.remove(`${inputs.stackRoot}/${name}`, { recursive: true, force: true })
				.pipe(Effect.catch(failPhase('remove-runtime-tree', `remove ${name} failed`)));
		}
	}).pipe(Effect.withSpan('orchestrator.snapshot.wipe'));

/** Centralized constant — the canonical snapshot-catalog directory
 *  name. Used by both `runWipe` (to preserve) and the substrate's
 *  path resolver (to compose `snapshotDir`). Distilled §17 calls out
 *  the "centralize the snapshots-dir-name constant" opportunity. */
export const SNAPSHOTS_DIR_NAME = 'snapshots';
