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
		phase: Schema.Literals(['sweep-containers', 'sweep-networks-volumes', 'remove-runtime-tree']),
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
// Preserve predicate — the single source of truth for "what survives a
// wipe on disk". Both `runWipe` (the destructive pass) and `planWipe`
// (the dry-run enumeration) consult this so the preview can never drift
// from what the real wipe removes.
// -----------------------------------------------------------------------------

interface PreservePolicy {
	readonly keepSnapshots: boolean;
	readonly keepCache: boolean;
}

const resolvePreservePolicy = (inputs: WipeInputs): PreservePolicy => ({
	keepSnapshots: inputs.keepSnapshots ?? true,
	keepCache: inputs.keepCache ?? false,
});

/** True when a direct child of `stackRoot` is PRESERVED (not removed)
 *  by a wipe under `policy`. `snapshots/` survives by default; `cache/`
 *  survives only when explicitly requested. Every other child — state,
 *  cross-process artifacts, per-plugin runtime trees — is removed. */
const isPreservedChild = (name: string, policy: PreservePolicy): boolean =>
	(policy.keepSnapshots && name === SNAPSHOTS_DIR_NAME) ||
	(policy.keepCache && name === CACHE_DIR_NAME);

// -----------------------------------------------------------------------------
// Dry-run enumeration
// -----------------------------------------------------------------------------

/** Concrete teardown targets a wipe of one `(app, stack)` would remove.
 *  Produced by `planWipe` WITHOUT mutating anything so `devstack wipe
 *  --dry-run` can show the operator exactly what a real wipe deletes. */
export interface WipeTargets {
	readonly app: string;
	readonly stack: string;
	/** Managed container NAMES that match the `{ app, stack }` label
	 *  filter — enumerated via the runtime adapter so the preview lists
	 *  the exact containers a real wipe force-removes. */
	readonly containers: ReadonlyArray<string>;
	/** Networks/volumes are removed by the SAME `{ app, stack }` label
	 *  filter the runtime adapter sweeps on. The contract exposes no
	 *  by-label LIST for these, so the plan reports the selector that
	 *  scopes the removal rather than a (daemon-round-trip) name list. */
	readonly networkLabelMatch: Pick<ContainerLabelTuple, 'app' | 'stack'>;
	readonly volumeLabelMatch: Pick<ContainerLabelTuple, 'app' | 'stack'>;
	/** Absolute path of the per-stack runtime root. Its non-preserved
	 *  children (see `onDiskPaths`) are removed; the directory itself is
	 *  reaped too when nothing survives. */
	readonly stackRoot: string;
	/** Absolute paths of the `stackRoot` children a real wipe removes —
	 *  everything except the preserved `snapshots/` (and `cache/` unless
	 *  `keepCache`). Empty when the stack root does not exist yet. */
	readonly onDiskPaths: ReadonlyArray<string>;
	/** Direct children PRESERVED on disk (`snapshots/`, optionally
	 *  `cache/`) — surfaced so the preview is explicit about survivors. */
	readonly preserved: ReadonlyArray<string>;
}

/**
 * Enumerate the concrete targets a wipe of `inputs.labelMatch` would
 * remove, WITHOUT removing anything. Read-only: lists matching
 * containers via the runtime adapter and reads the stack-root directory
 * to classify each child against the SAME preserve predicate `runWipe`
 * uses. Backs `devstack wipe --dry-run`.
 */
export const planWipe = (
	inputs: WipeInputs,
): Effect.Effect<WipeTargets, WipePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* Effect.annotateCurrentSpan({
			'devstack.snapshot.phase': 'wipe-plan',
			'devstack.app': inputs.labelMatch.app,
			'devstack.stack': inputs.labelMatch.stack,
		});

		const handles = yield* inputs.runtime
			.inspectByLabels(inputs.labelMatch as ContainerLabelTuple)
			.pipe(Effect.catch(failPhase('sweep-containers', `container inspect failed`)));
		const containers = handles.map((h) => h.name).sort();

		const policy = resolvePreservePolicy(inputs);
		const children = yield* fs
			.readDirectory(inputs.stackRoot)
			.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
		const onDiskPaths: Array<string> = [];
		const preserved: Array<string> = [];
		for (const name of [...children].sort()) {
			if (isPreservedChild(name, policy)) {
				preserved.push(name);
				continue;
			}
			onDiskPaths.push(`${inputs.stackRoot}/${name}`);
		}

		return {
			app: inputs.labelMatch.app,
			stack: inputs.labelMatch.stack,
			containers,
			networkLabelMatch: inputs.labelMatch,
			volumeLabelMatch: inputs.labelMatch,
			stackRoot: inputs.stackRoot,
			onDiskPaths,
			preserved,
		} satisfies WipeTargets;
	}).pipe(Effect.withSpan('orchestrator.snapshot.wipe.plan'));

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
 *   3. Remove the runtime tree EXCEPT the snapshot catalog by default.
 *   4. Remove the now-empty stack root when nothing survived (no
 *      preserved child remains) so wipe doesn't leak an empty
 *      `stacks/<stack>/` directory.
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

		// 3. Remove the runtime tree — but PRESERVE snapshots by default.
		//    Strategy: enumerate the stack root and remove each child the
		//    preserve predicate does NOT keep (`snapshots/` by default;
		//    `cache/` only when `keepCache`). Stack-local artifact caches
		//    are state and are removed unless explicitly requested.
		const policy = resolvePreservePolicy(inputs);
		const children = yield* fs
			.readDirectory(inputs.stackRoot)
			.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
		let preservedCount = 0;
		for (const name of children) {
			if (isPreservedChild(name, policy)) {
				preservedCount += 1;
				continue;
			}
			yield* fs
				.remove(`${inputs.stackRoot}/${name}`, { recursive: true, force: true })
				.pipe(Effect.catch(failPhase('remove-runtime-tree', `remove ${name} failed`)));
		}

		// 4. Reap the now-empty stack root. When NOTHING was preserved
		//    (no `snapshots/`/`cache/` survivor) every child was removed in
		//    step 3 — any child whose removal FAILED would have raised a
		//    `remove-runtime-tree` error and aborted before here — so the
		//    directory is empty at this point. Leaving it behind leaks an
		//    empty `stacks/<stack>/` shell that `prune --list` would show as
		//    a bare group. `recursive` is required to remove a directory at
		//    all (a plain `remove` raises EISDIR even for an empty dir); it
		//    is safe here precisely BECAUSE the `preservedCount === 0` guard
		//    means no preserved subtree exists to be recursively swept.
		//    Best-effort: a (racing) re-created child just leaves the dir.
		if (preservedCount === 0 && children.length > 0) {
			yield* fs.remove(inputs.stackRoot, { recursive: true, force: true }).pipe(Effect.ignore);
		}
	}).pipe(Effect.withSpan('orchestrator.snapshot.wipe'));

/** Centralized constant — the canonical snapshot-catalog directory
 *  name. Used by both `runWipe` (to preserve) and the substrate's
 *  path resolver (to compose `snapshotDir`). Distilled §17 calls out
 *  the "centralize the snapshots-dir-name constant" opportunity. */
export const SNAPSHOTS_DIR_NAME = 'snapshots';

/** Canonical stack-local artifact-cache directory name. `runWipe`
 *  preserves it only under `keepCache`; otherwise it is removed so a
 *  reset re-proves on-chain artifacts against the next chain. */
export const CACHE_DIR_NAME = 'cache';
