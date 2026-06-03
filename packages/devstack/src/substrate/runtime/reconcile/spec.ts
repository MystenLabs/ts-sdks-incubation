// Reconcile seam contract — P0 (pure types + constructors, zero behavior).
//
// One `reconcile(spec)` model unifies the seven hand-written lifecycle
// flows (up / down / restart / restore / wipe / prune / capture) over a
// small set of orthogonal axes. This module defines ONLY the seam
// contract — the structured spec every flow eventually compiles down to.
// No flow is rewired here; see `lifecycle-redesign.md` §2 (unified model)
// and §3 (guardrails).
//
// The axes (redesign §2):
//   - target     — `running | absent` (intent only; `decideRunAction`
//                  still picks the concrete docker action, engine
//                  unchanged — guardrail §3.6).
//   - fsPlan     — staged file-tree mutation vocabulary (P2 seam).
//   - cachePolicy— a STRUCTURED PAIR over the content-addressed cache +
//                  its snapshot byproducts (guardrail §3.1: the two
//                  dispositions move together today but must be modelable
//                  independently — never a coarse enum).
//   - scope      — `graph-keys(subset)` (in-supervisor, dep-ordered) |
//                  `label(tuple)` (out-of-supervisor, flat sweep).
//   - direction  — `converge` (forward dep order) | `drain` (reverse).
//   - locks      — declared lock riders (P4/P6 seam).
//   - ownership  — cross-process arbitration rider (P6 seam; stays ABOVE
//                  reconcile per guardrail §3.4 — modelled, not executed).
//
// Phase A wires ONLY `scope.kind === 'graph-keys'` + `converge|drain`
// through `reconcileGraph` (see `./graph.ts`). The other axes are
// typed-but-inert placeholder slots so later phases (P2/P4/P6) can fill
// them without re-shaping the contract.

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
 *  dep-ordered subset (Phase A); `label` is the flat out-of-supervisor
 *  sweep (later phases). */
export type ReconcileScope =
	| { readonly kind: 'graph-keys'; readonly keys: ReadonlyArray<PluginKey> }
	| { readonly kind: 'label'; readonly tuple: ReconcileLabelTuple };

// -----------------------------------------------------------------------------
// Cache policy — a STRUCTURED PAIR, never a coarse enum (guardrail §3.1)
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
// Later-phase placeholder slots (typed-but-inert in Phase A)
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// fsPlan — the staged file-tree mutation vocabulary (redesign §2, P2)
// -----------------------------------------------------------------------------
//
// A `ReconcileFsPlan` is an ORDERED list of `ReconcileFsOp`s the executor
// (`./fs-plan.ts`) runs in sequence. Two op families:
//
//   - DIRECT fs/runtime ops (implemented in P2) — `sweep-children`,
//     `reap-empty`, `reap-meta-missing`, `reap-images`. These are the
//     ops wipe + prune need NOW; they mutate the runtime tree / docker
//     image store directly (no tree swap).
//   - SWAP-TREE ops (typed seams, NOT implemented — P4/P5/E own them) —
//     `swap-tree`, `untar-artifact`, `tar-subtrees`. These run through the
//     unchanged `stageAndSwap` primitive; their preserve riders
//     (`preserveFromTarget` / `preserveOnPreseed`) stay PER-DIRECTION
//     named constants, never collapsed into one cache-policy projection
//     (guardrail §3.1).
//
// Each op carries the live callbacks / failers it needs (this is an
// in-process plan, not a serialized one — like `ReconcileGraphDeps` it
// holds live objects). The preserve-list BUILDERS are per-direction: wipe
// supplies its wholesale `isPreservedChild` predicate here; restore's
// per-namespace + control-file preserve list is a SEPARATE P4 constant.

import type { Effect as EffectT, FileSystem } from 'effect';

/** A per-op failure mapper: turns an underlying defect into the caller's
 *  phase-tagged error so routing a flow through the executor preserves
 *  that flow's existing error tags (e.g. `WipePhaseError` /
 *  `PrunePhaseError`). The executor never invents its own error tag. */
export type ReconcileFsFailer<E> = (cause: unknown) => EffectT.Effect<never, E>;

/** DIRECT op — remove every direct child of `stackRoot` for which
 *  `preserve(name)` is FALSE. The wipe preserve predicate
 *  (`isPreservedChild`) is supplied here as a per-direction constant
 *  (guardrail §3.1: no wholesale-preserve collapse into cache policy). */
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

/** SWAP-TREE seam (NOT implemented — P4/P5/E). Publish a new `targetPath`
 *  tree by running `build` then the unchanged `stageAndSwap` rename. The
 *  preserve riders are per-direction named constants (guardrail §3.1). */
export interface SwapTreeOp {
	readonly op: 'swap-tree';
	readonly targetPath: string;
	/** `untar-artifact` (restore) / `tar-subtrees` (capture) are the build
	 *  bodies of a swap-tree; named here so the vocabulary is closed. The
	 *  builders land in P4/E. */
	readonly build?: 'untar-artifact' | 'tar-subtrees';
	/** Per-direction preserve riders — NOT a cache-policy projection. */
	readonly preserveFromTarget?: boolean;
	readonly preserveOnPreseed?: boolean;
}

/** One file-tree mutation op. The implemented ops are parameterized on the
 *  caller's error tag `E`; the swap-tree seam carries no failer yet (its
 *  runner lands in P4/P5/E). */
export type ReconcileFsOp<E> =
	| SweepChildrenOp<E>
	| ReapEmptyOp
	| ReapMetaMissingOp<E>
	| ReapImagesOp<E>
	| SwapTreeOp;

/** The staged file-tree mutation plan (redesign §2): an ordered list of
 *  ops the executor runs in sequence. */
export interface ReconcileFsPlan<E = never> {
	readonly ops: ReadonlyArray<ReconcileFsOp<E>>;
}

/** P4 seam — an ordered precondition that runs as step 0, BEFORE the first
 *  mutation (e.g. restore's identity-guard, fail-closed). Typed as an
 *  opaque tagged slot now; the runner lands in P4. Phase A never reads
 *  this. Guard: `restore.test.ts` (sweep/load/tag === [] on mismatch). */
export interface ReconcilePrecondition {
	readonly tag: string;
}

/** P4/P6 seam — declared lock riders the reconcile must hold for its
 *  duration (e.g. `stack.lock`; codegen uses its own `codegenLockFile`).
 *  Typed-but-inert in Phase A. */
export interface ReconcileLocks {
	readonly files: ReadonlyArray<string>;
}

/** P6 seam — cross-process ownership arbitration rider. Arbitration STAYS
 *  ABOVE reconcile in `cli/wirings` (guardrail §3.4); this slot only
 *  declares the required rider so the contract is closed. Phase A never
 *  reads this. */
export interface ReconcileOwnership {
	readonly requireSoleHolder: boolean;
}

// -----------------------------------------------------------------------------
// The unified spec
// -----------------------------------------------------------------------------

/** The container intent. `decideRunAction` still picks the concrete docker
 *  action (`fresh|adopt|unpause-adopt|resume|recreate|refuse|stop`); the
 *  caller only declares the desired end-state (guardrail §3.6). */
export type ReconcileTarget = 'running' | 'absent';

/** Traversal direction over the dep-graph: `converge` is forward (acquire)
 *  order, `drain` is reverse (teardown) order. */
export type ReconcileDirection = 'converge' | 'drain';

/** The one structured spec every lifecycle flow compiles down to. The
 *  `E` parameter is the caller's fs-plan error tag (e.g. `WipePhaseError`
 *  / `PrunePhaseError`), defaulting to `never` for the graph flows that
 *  carry no fsPlan. In Phase A only `target`, `cachePolicy`, `scope`
 *  (graph-keys) and `direction` were consumed by `reconcileGraph`; P2/P3
 *  add `fsPlan` execution + the label scope. The remaining slots stay
 *  typed-but-optional for P4/P6. */
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
 *  by `{app, stack[, plugin, role]}`). Re-added in P3, now that label
 *  flows (wipe / prune) are wired through `reconcileLabel`. */
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
 *  default carried by up / restart (redesign §2 table). */
export const reuseVerifiedPolicy = (): CachePolicy =>
	cachePolicy('reuse-verified', 'preserve');

/** `preserve` cache + `preserve` snapshots — the down / restore default
 *  (nothing dropped; stop ≠ rm). */
export const preserveAllPolicy = (): CachePolicy => cachePolicy('preserve', 'preserve');

/** Pure spec constructor. No behavior — just folds the axes into the
 *  closed `ReconcileSpec` shape. Generic on the fs-plan error tag `E`. */
export const reconcileSpec = <E = never>(spec: ReconcileSpec<E>): ReconcileSpec<E> => spec;
