// Reconcile seam contract — pure types + constructors, zero behavior.
//
// One `reconcile(spec)` model unifies the lifecycle flows (up / down /
// restart / restore / wipe / prune / capture) over a small set of
// orthogonal axes. This module defines ONLY the seam contract — the
// structured spec every flow compiles down to.
//
// The axes:
//   - target     — `running | absent` (intent only; `decideRunAction`
//                  picks the concrete docker action, engine untouched).
//   - fsPlan     — staged file-tree mutation vocabulary.
//   - cachePolicy— a STRUCTURED PAIR over the content-addressed cache +
//                  its snapshot byproducts (the two dispositions move
//                  together today but must be modelable independently —
//                  never a coarse enum).
//   - scope      — `graph-keys(subset)` (in-supervisor, dep-ordered) |
//                  `label(tuple)` (out-of-supervisor, flat sweep).
//   - direction  — `converge` (forward dep order) | `drain` (reverse).
//   - locks      — declared lock riders.
//   - ownership  — cross-process arbitration rider (arbitration stays
//                  ABOVE reconcile — modelled, not executed here).
//
// The graph axis (`reconcileGraph`, `./graph.ts`) handles
// `scope.kind === 'graph-keys'` + `converge|drain`; the label axis
// (`reconcileLabel`, `./label.ts`) handles `scope.kind === 'label'`
// sweeps + their fsPlan. Slots not yet executed in a given axis are
// typed-but-inert there.

import type { AppName, PluginKey, StackName } from '../../brand.ts';

// -----------------------------------------------------------------------------
// Scope — where the reconcile applies
// -----------------------------------------------------------------------------

/** A flat label tuple identifying an out-of-supervisor surface (docker
 *  resources by `app`/`stack`, optionally narrowed to one `plugin` or a
 *  `role`). Used by the label-scope flows (wipe / prune / capture) that
 *  sweep resources without a live dep-graph.
 *
 *  `role` is a free `string` — it carries the docker ownership-label role
 *  value (`ContainerLabelTuple.role`), which spans the plugin roles
 *  (`service | task`) AND the synthetic byproduct roles (e.g.
 *  `SNAPSHOT_IMAGE_ROLE = 'snapshot-image'`, which prune narrows its image
 *  sweep to). It is NOT restricted to `PluginRole`. */
export interface ReconcileLabelTuple {
	readonly app: AppName;
	readonly stack: StackName;
	readonly plugin?: PluginKey;
	readonly role?: string;
}

/** Where a reconcile applies. `graph-keys` is the in-supervisor,
 *  dep-ordered subset; `label` is the flat out-of-supervisor sweep. */
export type ReconcileScope =
	| { readonly kind: 'graph-keys'; readonly keys: ReadonlyArray<PluginKey> }
	| { readonly kind: 'label'; readonly tuple: ReconcileLabelTuple };

// -----------------------------------------------------------------------------
// Cache policy — a STRUCTURED PAIR, never a coarse enum
// -----------------------------------------------------------------------------

/** How the live content-addressed cache (`cache/<ns>/<chain>/<hash>`) is
 *  treated. `reuse-verified` is the default and IS warm-restart id
 *  stability (memory: warm-restart-id-stability). */
export type CacheDisposition = 'reuse-verified' | 'preserve' | 'drop';

/** How the snapshot byproducts of the cache are treated, INDEPENDENTLY of
 *  the cache itself. `reap-byproducts` is prune's GC of meta-missing
 *  snapshot images. */
export type SnapshotsDisposition = 'preserve' | 'drop' | 'reap-byproducts';

/** The structured cache-policy pair. The two dispositions are projections
 *  of one decision today (e.g. wipe's `--keep-cache`), but they MUST be
 *  modelable independently — control-file / per-namespace preservation is
 *  a restore-direction constant, never folded into a single enum. Else
 *  warm-restart ids churn / the command-channel breaks (guard:
 *  `private-content-boot.test.ts`). */
export interface CachePolicy {
	readonly cacheDisposition: CacheDisposition;
	readonly snapshotsDisposition: SnapshotsDisposition;
}

// -----------------------------------------------------------------------------
// fsPlan — the staged file-tree mutation vocabulary
// -----------------------------------------------------------------------------
//
// A `ReconcileFsPlan` is an ORDERED list of `ReconcileFsOp`s the executor
// (`./fs-plan.ts`) runs in sequence. Two op families:
//
//   - DIRECT fs/runtime ops — `sweep-children`, `reap-empty`,
//     `reap-meta-missing`, `reap-images`. These are the ops wipe + prune
//     need; they mutate the runtime tree / docker image store directly
//     (no tree swap).
//   - SWAP-TREE ops — `swap-tree`, `untar-artifact`, `tar-subtrees`.
//     These run through the unchanged `stageAndSwap` primitive; their
//     preserve riders (`preserveFromTarget` / `preserveOnPreseed`) stay
//     PER-DIRECTION named constants, never collapsed into one cache-policy
//     projection.
//
// Each op carries the live callbacks / failers it needs (this is an
// in-process plan, not a serialized one — like `ReconcileGraphDeps` it
// holds live objects). The preserve-list BUILDERS are per-direction: wipe
// supplies its wholesale `isPreservedChild` predicate here; restore's
// per-namespace + control-file preserve list is a SEPARATE constant.

import type { Effect as EffectT, FileSystem } from 'effect';

import type {
	StageAndSwapError,
	StageAndSwapPreservedPath,
} from '../stage-and-swap/index.ts';

/** A per-op failure mapper: turns an underlying defect into the caller's
 *  phase-tagged error so routing a flow through the executor preserves
 *  that flow's existing error tags (e.g. `WipePhaseError` /
 *  `PrunePhaseError`). The executor never invents its own error tag. */
export type ReconcileFsFailer<E> = (cause: unknown) => EffectT.Effect<never, E>;

/** DIRECT op — remove every direct child of `stackRoot` for which
 *  `preserve(name)` is FALSE. The wipe preserve predicate
 *  (`isPreservedChild`) is supplied here as a per-direction constant (no
 *  wholesale-preserve collapse into cache policy). */
export interface SweepChildrenOp<E> {
	readonly op: 'sweep-children';
	readonly stackRoot: string;
	/** True when a direct child is PRESERVED (kept). */
	readonly preserve: (name: string) => boolean;
	readonly onError: ReconcileFsFailer<E>;
}

/** DIRECT op — reap `stackRoot` itself when ZERO preserved children
 *  survive (so a wipe never leaks an empty `stacks/<stack>/` shell).
 *  Best-effort: a racing re-created child just leaves the dir. */
export interface ReapEmptyOp {
	readonly op: 'reap-empty';
	readonly stackRoot: string;
}

/** DIRECT op — reap snapshot-catalog directories under `catalogDir` whose
 *  `meta.json` is missing/unreadable (partial artifacts). `isMetaMissing`
 *  is the per-direction classifier (prune supplies its meta read+decode).
 *  Reaped ids are reported back so prune keeps its `PruneResult.reaped`. */
export interface ReapMetaMissingOp<E> {
	readonly op: 'reap-meta-missing';
	readonly catalogDir: string;
	/** Classify a catalog entry as a partial artifact (no readable meta).
	 *  May read the filesystem (prune's classifier reads + decodes
	 *  `meta.json`), so it carries the `FileSystem` requirement. */
	readonly isMetaMissing: (dir: string) => EffectT.Effect<boolean, E, FileSystem.FileSystem>;
	readonly onReaddirError: ReconcileFsFailer<E>;
	readonly onRemoveError: ReconcileFsFailer<E>;
}

/** DIRECT op — sweep committed byproduct images via the runtime adapter's
 *  label-scoped image cleanup. Prune narrows the label tuple to
 *  `role: SNAPSHOT_IMAGE_ROLE` so only snapshot byproducts are reaped —
 *  never the live stack's build images. The swept count is reported back
 *  so prune keeps its `PruneResult.imagesSwept`. This op is the
 *  `reap-byproducts` cache-disposition's concrete mechanism. */
export interface ReapImagesOp<E> {
	readonly op: 'reap-images';
	readonly onError: ReconcileFsFailer<E>;
}

/** SWAP-TREE op — restore publishes via `untar-artifact`; capture builds
 *  via `tar-subtrees`. Publish a new `targetPath` tree by running `build`
 *  (which populates the staging dir) then the UNCHANGED `stageAndSwap`
 *  rename — `stageAndSwap` is NOT modified and NOT reimplemented; the
 *  executor only assembles its args from this op. The build's result is
 *  observed by
 *  the caller through its OWN closure (e.g. restore pushes staged image
 *  refs into a caller-held array), so the executor discards it and returns
 *  the default `FsPlanResult` — the build value never threads back through
 *  the op vocabulary.
 *
 *  The preserve riders map 1:1 onto `stageAndSwap`'s args as PER-DIRECTION
 *  named constants, NOT a cache-policy projection: `preserveFromTarget` is
 *  restore's per-namespace cache + control-file list; `preserveOnPreseed`
 *  is codegen's whole-tree pre-build clone. */
export interface SwapTreeOp<E> {
	readonly op: 'swap-tree';
	/** The build body's identity — `untar-artifact` (restore) /
	 *  `tar-subtrees` (capture). Names the build so the vocabulary is
	 *  closed; the actual work is in `build`. */
	readonly build: 'untar-artifact' | 'tar-subtrees';
	readonly targetPath: string;
	readonly stagingPath: string;
	readonly backupPath: string;
	/** The user effect that populates `stagingPath` (restore untars the
	 *  host-tree + loads/stages the committed image bundle). Carries the
	 *  caller's error tag `E`; its success value is observed via the
	 *  caller's own closure (see above) and discarded by the executor. */
	readonly buildEffect: EffectT.Effect<unknown, E, FileSystem.FileSystem>;
	/** Per-direction preserve rider — NOT a cache-policy projection.
	 *  Restore supplies its per-namespace cache + control-file list here as
	 *  a restore-direction constant. */
	readonly preserveFromTarget?: ReadonlyArray<StageAndSwapPreservedPath>;
	/** Per-direction preserve rider — codegen's whole-tree pre-build clone
	 *  (mtime-stable). */
	readonly preserveOnPreseed?: boolean;
	/** Caller-supplied publish lock (restore blocks command/event writers
	 *  while the stack root is momentarily absent during the rename). */
	readonly publishLockPath?: string;
	/** Maps `stageAndSwap`'s `StageAndSwapError` into the caller's error
	 *  channel `E`, mirroring the failer the DIRECT ops carry. Restore
	 *  passes an identity pass-through (it keeps `StageAndSwapError` in its
	 *  own public signature, behavior-preserving), so the executor never
	 *  invents an error tag and `executeFsPlan<E>` stays `Effect<…, E, …>`
	 *  rather than widening every label-flow's error with a swap error it
	 *  can never raise. */
	readonly onSwapError: (cause: StageAndSwapError) => EffectT.Effect<never, E>;
}

/** One file-tree mutation op. Every op is parameterized on the caller's
 *  error tag `E`; `swap-tree`'s `buildEffect` carries `E` directly and the
 *  executor surfaces `E | StageAndSwapError` from the rename. */
export type ReconcileFsOp<E> =
	| SweepChildrenOp<E>
	| ReapEmptyOp
	| ReapMetaMissingOp<E>
	| ReapImagesOp<E>
	| SwapTreeOp<E>;

/** The staged file-tree mutation plan: an ordered list of ops the
 *  executor runs in sequence. */
export interface ReconcileFsPlan<E = never> {
	readonly ops: ReadonlyArray<ReconcileFsOp<E>>;
}

/** An ordered precondition that runs as step 0, BEFORE the first mutation
 *  (e.g. restore's identity-guard, fail-closed). An opaque tagged slot in
 *  the contract; axes that don't run preconditions ignore it. Guard:
 *  `restore.test.ts` (sweep/load/tag === [] on mismatch). */
export interface ReconcilePrecondition {
	readonly tag: string;
}

/** Declared lock riders the reconcile must hold for its duration (e.g.
 *  `stack.lock`; codegen uses its own `codegenLockFile`). */
export interface ReconcileLocks {
	readonly files: ReadonlyArray<string>;
}

/** Cross-process ownership arbitration rider. Arbitration STAYS ABOVE
 *  reconcile in `cli/wirings`; this slot only declares the required rider
 *  so the contract is closed. */
export interface ReconcileOwnership {
	readonly requireSoleHolder: boolean;
}

// -----------------------------------------------------------------------------
// The unified spec
// -----------------------------------------------------------------------------

/** The container intent. `decideRunAction` picks the concrete docker
 *  action (`fresh|adopt|unpause-adopt|resume|recreate|refuse|stop`); the
 *  caller only declares the desired end-state. */
export type ReconcileTarget = 'running' | 'absent';

/** Traversal direction over the dep-graph: `converge` is forward (acquire)
 *  order, `drain` is reverse (teardown) order. */
export type ReconcileDirection = 'converge' | 'drain';

/** The one structured spec every lifecycle flow compiles down to. The
 *  `E` parameter is the caller's fs-plan error tag (e.g. `WipePhaseError`
 *  / `PrunePhaseError`), defaulting to `never` for the graph flows that
 *  carry no fsPlan. The graph axis (`reconcileGraph`) consumes `target`,
 *  `cachePolicy`, `scope` (graph-keys) and `direction`; the label axis
 *  (`reconcileLabel`) additionally executes `fsPlan` over a label scope.
 *  The remaining slots stay typed-but-optional. */
export interface ReconcileSpec<E = never> {
	readonly precondition?: ReconcilePrecondition;
	readonly target: ReconcileTarget;
	readonly fsPlan?: ReconcileFsPlan<E>;
	readonly cachePolicy: CachePolicy;
	readonly scope: ReconcileScope;
	readonly direction: ReconcileDirection;
	readonly locks?: ReconcileLocks;
	readonly ownership?: ReconcileOwnership;
}

// -----------------------------------------------------------------------------
// Pure constructors (no behavior)
// -----------------------------------------------------------------------------

/** A graph-keys scope over an explicit subset of plugin keys. */
export const graphKeysScope = (keys: ReadonlyArray<PluginKey>): ReconcileScope => ({
	kind: 'graph-keys',
	keys,
});

/** A flat label scope over an out-of-supervisor surface (docker resources
 *  by `{app, stack[, plugin, role]}`). The label flows (wipe / prune)
 *  are wired through `reconcileLabel`. */
export const labelScope = (tuple: ReconcileLabelTuple): ReconcileScope => ({
	kind: 'label',
	tuple,
});

/** The structured cache-policy pair constructor. */
export const cachePolicy = (
	cacheDisposition: CacheDisposition,
	snapshotsDisposition: SnapshotsDisposition,
): CachePolicy => ({ cacheDisposition, snapshotsDisposition });

/** `reuse-verified` cache + `preserve` snapshots — the warm-restart
 *  default carried by up / restart. */
export const reuseVerifiedPolicy = (): CachePolicy =>
	cachePolicy('reuse-verified', 'preserve');

/** `preserve` cache + `preserve` snapshots — the down / restore default
 *  (nothing dropped; stop ≠ rm). */
export const preserveAllPolicy = (): CachePolicy => cachePolicy('preserve', 'preserve');

/** Pure spec constructor. No behavior — just folds the axes into the
 *  closed `ReconcileSpec` shape. Generic on the fs-plan error tag `E`. */
export const reconcileSpec = <E = never>(spec: ReconcileSpec<E>): ReconcileSpec<E> => spec;
