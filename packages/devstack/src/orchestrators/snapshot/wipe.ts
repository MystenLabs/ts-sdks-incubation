// Wipe — label-scoped teardown.
//
// Architecture § Snapshot responsibilities:
//   "Provide a wipe operation scoped to one `(app, stack)` that tears
//   down containers, networks, volumes, and per-stack on-disk state,
//   with the snapshot catalog AND the deploy cache surviving together
//   by default; a hard reset drops both."
//
// Wipe-scope coupling (decision-1): `snapshots/` and `cache/` ride ONE
// flag (`keepSnapshots`). An ordinary wipe preserves both so a later
// restore can REUSE the live deploy cache (the deploy ids survive the
// teardown); a hard reset (`keepSnapshots: false`) drops both so a
// fresh boot re-proves every on-chain artifact against the next chain.
//
// Label-scoped: enumeration uses partial `ContainerLabelTuple` filters
// (just `{ app, stack }`); the orchestrator does NOT reach for plugin
// names. The runtime adapter sweeps containers/networks/volumes
// matching the label set.

import { Effect, FileSystem, Schema } from 'effect';

import type { ContainerLabelTuple } from '../../contracts/snapshotable.ts';
import type { ContainerRuntime } from '../../contracts/container-runtime.ts';
import { appName, stackName } from '../../substrate/brand.ts';
import {
	cachePolicy,
	labelScope,
	reconcileLabel,
	reconcileSpec,
	type ReconcileFsOp,
} from '../../substrate/runtime/reconcile/index.ts';
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
	/** Preserve the wipe-scoped state — the snapshot catalog (`snapshots/`)
	 *  AND the deploy cache (`cache/`) — across the teardown. Defaults to
	 *  true: an ordinary wipe keeps both so a later restore can REUSE the
	 *  live deploy cache. Set false for a hard reset, which drops both
	 *  alongside the runtime tree so a fresh boot re-proves every on-chain
	 *  artifact against the next chain. The two dirs are coupled — there
	 *  is no asymmetric "keep snapshots, drop cache" (or vice versa). */
	readonly keepSnapshots?: boolean;
}

// -----------------------------------------------------------------------------
// Preserve predicate — the single source of truth for "what survives a
// wipe on disk". Both `runWipe` (the destructive pass) and `planWipe`
// (the dry-run enumeration) consult this so the preview can never drift
// from what the real wipe removes.
// -----------------------------------------------------------------------------

/** True when a direct child of `stackRoot` is PRESERVED (not removed)
 *  by a wipe under `preserve`. The snapshot catalog (`snapshots/`) and
 *  the deploy cache (`cache/`) survive TOGETHER by default and are
 *  dropped together on a hard reset — they ride the one `preserve`
 *  flag. Every other child — state, cross-process artifacts, per-plugin
 *  runtime trees — is removed regardless. */
const isPreservedChild = (name: string, preserve: boolean): boolean =>
	preserve && (name === SNAPSHOTS_DIR_NAME || name === CACHE_DIR_NAME);

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
	 *  everything except the wipe-scoped survivors (`snapshots/` AND
	 *  `cache/`, kept together unless this is a hard reset). Empty when
	 *  the stack root does not exist yet. */
	readonly onDiskPaths: ReadonlyArray<string>;
	/** Direct children PRESERVED on disk (`snapshots/` and `cache/`,
	 *  coupled) — surfaced so the preview is explicit about survivors. */
	readonly preserved: ReadonlyArray<string>;
}

/**
 * Enumerate the concrete targets a wipe of `inputs.labelMatch` would
 * remove, WITHOUT removing anything. Read-only: lists matching
 * containers via the runtime adapter and reads the stack-root directory
 * to classify each child against the SAME preserve predicate `runWipe`
 * uses (`snapshots/` and `cache/` survive together by default). Backs
 * `devstack wipe --dry-run`.
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

		const preserve = inputs.keepSnapshots ?? true;
		const children = yield* fs
			.readDirectory(inputs.stackRoot)
			.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
		const onDiskPaths: Array<string> = [];
		const preserved: Array<string> = [];
		for (const name of [...children].sort()) {
			if (isPreservedChild(name, preserve)) {
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
 * Tear down a stack's live footprint. The snapshot catalog AND the
 * deploy cache survive together by default (architecture § wipe).
 *
 * Routed through the unified reconcile (redesign §2): a flat LABEL-scope
 * spec — `target: 'absent'` (hard container/network/volume rm) +
 * `fsPlan: [sweep-children(isPreservedChild), reap-empty]` — executed by
 * `reconcileLabel`. The legacy per-step order is preserved exactly:
 *
 *   1. Force-remove managed containers by `{ app, stack }` labels.
 *   2. Remove managed networks and volumes by the same label filter.
 *   3. Sweep the runtime tree EXCEPT the wipe-scoped survivors
 *      (`snapshots/` AND `cache/`) by default — the `sweep-children` op
 *      consults the SAME `isPreservedChild` predicate `planWipe` uses, so
 *      the preview can never drift from what the real wipe removes.
 *   4. Reap the now-empty stack root when nothing survived so wipe doesn't
 *      leak an empty `stacks/<stack>/` directory (the `reap-empty` op,
 *      reading the preserved-count threaded from `sweep-children`).
 *
 * `WipePhaseError` tags are preserved by passing each step's failer into
 * the reconcile (containers → `sweep-containers`; networks/volumes →
 * `sweep-networks-volumes`; child removal → `remove-runtime-tree`). The
 * reap-empty step is best-effort (no phase) exactly as before.
 *
 * cachePolicy stays a `{cache, snapshots}` PAIR (guardrail §3.1). The two
 * dispositions ride the ONE `keepSnapshots` flag (decision-1: `snapshots/`
 * and `cache/` are coupled — there is no asymmetric keep-snapshots-drop-
 * cache degree of freedom on disk). The pair models the future
 * `--keep-cache` axis; the on-disk preservation is driven by
 * `isPreservedChild`, not by the policy enum.
 */
export const runWipe = (
	inputs: WipeInputs,
): Effect.Effect<void, WipePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({
			'devstack.snapshot.phase': 'wipe',
			'devstack.app': inputs.labelMatch.app,
			'devstack.stack': inputs.labelMatch.stack,
		});

		const preserve = inputs.keepSnapshots ?? true;
		const disposition = preserve ? 'preserve' : 'drop';

		const sweepChildren: ReconcileFsOp<WipePhaseError> = {
			op: 'sweep-children',
			stackRoot: inputs.stackRoot,
			preserve: (name) => isPreservedChild(name, preserve),
			// Mirror the legacy per-child failer (the failing child's name
			// is no longer available here, so detail names the step).
			onError: failPhase('remove-runtime-tree', `remove stack-root child failed`),
		};
		const reapEmpty: ReconcileFsOp<WipePhaseError> = {
			op: 'reap-empty',
			stackRoot: inputs.stackRoot,
		};

		yield* reconcileLabel(
			reconcileSpec<WipePhaseError>({
				target: 'absent',
				scope: labelScope({
					app: appName(inputs.labelMatch.app),
					stack: stackName(inputs.labelMatch.stack),
				}),
				direction: 'drain',
				cachePolicy: cachePolicy(disposition, disposition),
				fsPlan: { ops: [sweepChildren, reapEmpty] },
			}),
			{
				runtime: inputs.runtime,
				onContainersError: failPhase('sweep-containers', `container sweep failed`),
				onNetworksError: failPhase('sweep-networks-volumes', `network sweep failed`),
				onVolumesError: failPhase('sweep-networks-volumes', `volume sweep failed`),
			},
		);
	}).pipe(Effect.withSpan('orchestrator.snapshot.wipe'));

/** Centralized constant — the canonical snapshot-catalog directory
 *  name. Used by both `runWipe` (to preserve) and the substrate's
 *  path resolver (to compose `snapshotDir`). Distilled §17 calls out
 *  the "centralize the snapshots-dir-name constant" opportunity. */
export const SNAPSHOTS_DIR_NAME = 'snapshots';

/** Canonical stack-local artifact-cache directory name. `runWipe`
 *  preserves it together with `snapshots/` under the one `keepSnapshots`
 *  flag (default); a hard reset (`keepSnapshots: false`) removes it so a
 *  fresh boot re-proves on-chain artifacts against the next chain. */
export const CACHE_DIR_NAME = 'cache';
