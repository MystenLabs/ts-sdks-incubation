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
import type { PluginRole } from '../../lifecycle.ts';

// -----------------------------------------------------------------------------
// Scope — where the reconcile applies
// -----------------------------------------------------------------------------

/** A flat label tuple identifying an out-of-supervisor surface (docker
 *  resources by `app`/`stack`, optionally narrowed to one `plugin` or a
 *  `role`). Used by the label-scope flows (wipe / prune / capture) that
 *  sweep resources without a live dep-graph. Phase A does NOT execute
 *  this scope — it's the typed target the later phases route through. */
export interface ReconcileLabelTuple {
	readonly app: AppName;
	readonly stack: StackName;
	readonly plugin?: PluginKey;
	readonly role?: PluginRole;
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

/** P2 seam — the staged file-tree mutation plan over the unchanged
 *  `stageAndSwap` vocabulary. Defined minimally now; the executor lands in
 *  P2. Phase A never reads this. */
export interface ReconcileFsPlan {
	/** `stageAndSwap` operation vocabulary (redesign §2). */
	readonly op:
		| 'swap-tree'
		| 'sweep-children'
		| 'untar-artifact'
		| 'tar-subtrees'
		| 'reap-empty';
	/** Preserve riders kept as named direction-constants in P2 (no
	 *  preserve-list collapse — guardrail §3.1). */
	readonly preserveFromTarget?: boolean;
	readonly preserveOnPreseed?: boolean;
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

/** The one structured spec every lifecycle flow compiles down to. In
 *  Phase A only `target`, `cachePolicy`, `scope` (graph-keys) and
 *  `direction` are consumed by `reconcileGraph`; the remaining slots are
 *  typed-but-optional for P2/P4/P6. */
export interface ReconcileSpec {
	readonly precondition?: ReconcilePrecondition;
	readonly target: ReconcileTarget;
	readonly fsPlan?: ReconcileFsPlan;
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

// `labelScope` (the flat out-of-supervisor scope constructor) is intentionally
// NOT defined yet — there is no caller until P3 wires label-scoped
// wipe / restore-removal. The `label` variant of `ReconcileScope` (and
// `ReconcileLabelTuple`) stays typed so the contract is closed; the
// constructor is re-added when P3 first uses it (STYLE_GUIDE §5: no orphan
// exports waiting for a wiring layer).

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
 *  closed `ReconcileSpec` shape. */
export const reconcileSpec = (spec: ReconcileSpec): ReconcileSpec => spec;
