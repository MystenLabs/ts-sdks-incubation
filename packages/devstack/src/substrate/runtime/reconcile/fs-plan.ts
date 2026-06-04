// fs-plan executor.
//
// Runs a typed `ReconcileFsPlan` (an ordered list of `ReconcileFsOp`s,
// see `./spec.ts`) over the file-tree + docker image store. This is the
// single executor every label-scope flow's fsPlan compiles down to;
// `reconcileLabel` (`./label.ts`) calls it after the container target
// converges.
//
// Two op families:
//
//   - DIRECT ops — `sweep-children`, `reap-empty`, `reap-meta-missing`,
//     `reap-images`. These are exactly the ops wipe + prune need; each
//     carries the caller's per-direction predicate / classifier + a phase
//     failer so routing a flow through the executor PRESERVES that flow's
//     existing error tags. The executor never picks its own error tag and
//     never collapses the per-direction preserve predicate into a
//     cache-policy projection.
//
//   - SWAP-TREE op (`swap-tree`) — publishes a new tree via the UNCHANGED
//     `stageAndSwap` primitive (NOT modified, NOT reimplemented). The
//     executor only ASSEMBLES stageAndSwap's args from the op. Both restore
//     and capture route through this one op; each caller supplies its own
//     staging-tree build body as the op's generic `buildEffect`.
//
// `stageAndSwap` is untouched; the preserve-list builders are
// per-direction constants supplied by the CALLER, never derived inside
// the executor.

import { Effect, FileSystem } from 'effect';

import type { ContainerRuntime } from '../../../contracts/container-runtime.ts';
import type { ContainerLabelTuple } from '../../../contracts/snapshotable.ts';
import { stageAndSwap, StageAndSwapError } from '../stage-and-swap/index.ts';
import type { ReconcileFsOp, ReconcileFsPlan, ReconcileLabelTuple } from './spec.ts';

// -----------------------------------------------------------------------------
// Executor deps + result
// -----------------------------------------------------------------------------

/** Everything the fs-plan executor needs beyond `FileSystem` (provided as
 *  a requirement). `runtime` + `imageLabelFilter` back the `reap-images`
 *  op; flows with no image op may omit both. */
export interface FsPlanDeps {
	readonly runtime?: ContainerRuntime;
	/** The label tuple the `reap-images` op sweeps on (already narrowed to
	 *  its target role by the caller, e.g. `role: SNAPSHOT_IMAGE_ROLE`). */
	readonly imageLabelFilter?: ReconcileLabelTuple;
}

/** Per-plan result the executor accumulates — the counts/ids the routed
 *  flows still surface (prune's `inspected` + `reaped` + `imagesSwept`).
 *  Wipe consumes none of these (it returns `void`); they default empty. */
export interface FsPlanResult {
	/** Catalog entries examined by `reap-meta-missing` (prune's
	 *  `inspected`). Zero for plans with no catalog-reap op. */
	readonly inspected: number;
	readonly reapedIds: ReadonlyArray<string>;
	readonly imagesSwept: number;
}

// -----------------------------------------------------------------------------
// Per-op runners (DIRECT ops — implemented)
// -----------------------------------------------------------------------------

/** Remove every direct child of `stackRoot` the preserve predicate does
 *  NOT keep. Returns `{ preservedCount, sawChildren }` so a following
 *  `reap-empty` can decide whether the root is now empty using the SAME
 *  directory listing. */
const runSweepChildren = <E>(
	op: Extract<ReconcileFsOp<E>, { op: 'sweep-children' }>,
): Effect.Effect<{ preservedCount: number; sawChildren: boolean }, E, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const children = yield* fs
			.readDirectory(op.stackRoot)
			.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
		let preservedCount = 0;
		for (const name of children) {
			if (op.preserve(name)) {
				preservedCount += 1;
				continue;
			}
			yield* fs
				.remove(`${op.stackRoot}/${name}`, { recursive: true, force: true })
				.pipe(Effect.catch(op.onError));
		}
		return { preservedCount, sawChildren: children.length > 0 };
	});

/** Reap `stackRoot` itself when ZERO preserved children survive (so a wipe
 *  never leaks an empty `stacks/<stack>/` shell). Best-effort. `recursive`
 *  is required to remove a directory at all; it is safe precisely because
 *  the `preservedCount === 0` guard means no preserved subtree exists. */
const runReapEmpty = (
	op: Extract<ReconcileFsOp<never>, { op: 'reap-empty' }>,
	preservedCount: number,
	sawChildren: boolean,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		if (preservedCount === 0 && sawChildren) {
			yield* fs.remove(op.stackRoot, { recursive: true, force: true }).pipe(Effect.ignore);
		}
	});

/** Reap snapshot-catalog directories whose `meta.json` is missing /
 *  unreadable (partial artifacts). Returns `{ reaped, inspected }` so
 *  prune keeps its `PruneResult.reaped` + `inspected`. Reads the catalog
 *  read-only first, then classifies each entry via the caller's
 *  `isMetaMissing`. An absent catalog yields zero inspected (early
 *  return). */
const runReapMetaMissing = <E>(
	op: Extract<ReconcileFsOp<E>, { op: 'reap-meta-missing' }>,
): Effect.Effect<{ reaped: ReadonlyArray<string>; inspected: number }, E, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const catalogExists = yield* fs
			.exists(op.catalogDir)
			.pipe(Effect.catch(() => Effect.succeed(false)));
		if (!catalogExists) return { reaped: [] as ReadonlyArray<string>, inspected: 0 };
		const ids = yield* fs.readDirectory(op.catalogDir).pipe(Effect.catch(op.onReaddirError));
		const reaped: Array<string> = [];
		for (const id of ids) {
			const dir = `${op.catalogDir}/${id}`;
			const metaMissing = yield* op.isMetaMissing(dir);
			if (metaMissing) {
				yield* fs.remove(dir, { recursive: true, force: true }).pipe(Effect.catch(op.onRemoveError));
				reaped.push(id);
			}
		}
		return { reaped, inspected: ids.length };
	});

/** Sweep committed byproduct images via the runtime adapter's label-scoped
 *  cleanup (the `reap-byproducts` mechanism). Returns the swept count so
 *  prune keeps its `PruneResult.imagesSwept`. */
const runReapImages = <E>(
	op: Extract<ReconcileFsOp<E>, { op: 'reap-images' }>,
	deps: FsPlanDeps,
): Effect.Effect<number, E> =>
	Effect.gen(function* () {
		if (deps.runtime === undefined || deps.imageLabelFilter === undefined) {
			// A `reap-images` op without a runtime/filter is a wiring bug, not
			// a runtime condition — fail closed so it surfaces immediately.
			return yield* Effect.die(
				'fs-plan reap-images: FsPlanDeps must carry `runtime` + `imageLabelFilter`',
			);
		}
		return yield* deps.runtime
			.removeManagedImages(deps.imageLabelFilter as Partial<ContainerLabelTuple>)
			.pipe(Effect.catch(op.onError));
	});

// -----------------------------------------------------------------------------
// Per-op runner (SWAP-TREE op — publish the op's `buildEffect` tree)
// -----------------------------------------------------------------------------

/** Publish a new `targetPath` tree via the UNCHANGED `stageAndSwap`
 *  primitive (NOT modified, NOT reimplemented). The executor only
 *  ASSEMBLES `stageAndSwap`'s args from the op: the build body, the
 *  staging/backup sibling paths, the per-direction `preserveFromTarget` /
 *  `preserveOnPreseed` riders (NOT a cache-policy projection — guardrail
 *  §3.1), and the optional publish lock. The build's success value is
 *  observed by the caller through its OWN closure (restore pushes staged
 *  image refs into a caller-held array), so it is discarded here. The
 *  primitive's `StageAndSwapError` is mapped through the op's `onSwapError`
 *  failer into the caller's error tag `E`, mirroring the DIRECT ops — the
 *  executor never invents an error tag. */
const runSwapTree = <E>(
	op: Extract<ReconcileFsOp<E>, { op: 'swap-tree' }>,
): Effect.Effect<void, E, FileSystem.FileSystem> => {
	// `op.buildEffect` fails with the caller's `E`; `stageAndSwap` adds its
	// own `StageAndSwapError` from the rename. Map ONLY that concrete
	// stage-and-swap error through the op's `onSwapError` failer (the build's
	// own `E` errors pass straight through). `catchAll` + an explicit
	// `_tag` guard keeps this fully typed without `catchTag` widening the
	// failer's parameter when `E` is generic.
	const swapped: Effect.Effect<unknown, E | StageAndSwapError, FileSystem.FileSystem> = stageAndSwap(
		{
			targetPath: op.targetPath,
			stagingPath: op.stagingPath,
			backupPath: op.backupPath,
			build: op.buildEffect,
			...(op.preserveFromTarget === undefined
				? {}
				: { preserveFromTarget: op.preserveFromTarget }),
			...(op.preserveOnPreseed === undefined ? {} : { preserveOnPreseed: op.preserveOnPreseed }),
			...(op.publishLockPath === undefined ? {} : { publishLockPath: op.publishLockPath }),
		},
	);
	return swapped.pipe(
		Effect.catch((error: E | StageAndSwapError) =>
			error instanceof StageAndSwapError ? op.onSwapError(error) : Effect.fail(error),
		),
		Effect.asVoid,
	);
};

// -----------------------------------------------------------------------------
// The executor
// -----------------------------------------------------------------------------

/**
 * Run an ordered `ReconcileFsPlan` in sequence, accumulating the
 * counts/ids the routed flows surface (`FsPlanResult`). DIRECT ops mutate
 * the runtime tree / image store; the `swap-tree` op publishes a new tree
 * through the unchanged `stageAndSwap` (its build's success value is
 * observed by the caller's own closure, so it does not thread back into
 * `FsPlanResult`).
 *
 * `reap-empty` reads the preserved-child count produced by the IMMEDIATELY
 * PRECEDING `sweep-children` op (wipe's plan is always
 * `[sweep-children, reap-empty]`) — the count threads through the fold so
 * the root is reaped only when no preserved child survived.
 */
export const executeFsPlan = <E>(
	plan: ReconcileFsPlan<E>,
	deps: FsPlanDeps = {},
): Effect.Effect<FsPlanResult, E, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const reapedIds: Array<string> = [];
		let inspected = 0;
		let imagesSwept = 0;
		// Threaded from the last `sweep-children` so a following `reap-empty`
		// sees the preserved-count computed by that sweep.
		let lastSweep = { preservedCount: 0, sawChildren: false };

		for (const op of plan.ops) {
			switch (op.op) {
				case 'sweep-children': {
					lastSweep = yield* runSweepChildren(op);
					break;
				}
				case 'reap-empty': {
					yield* runReapEmpty(op, lastSweep.preservedCount, lastSweep.sawChildren);
					break;
				}
				case 'reap-meta-missing': {
					const result = yield* runReapMetaMissing(op);
					reapedIds.push(...result.reaped);
					inspected += result.inspected;
					break;
				}
				case 'reap-images': {
					imagesSwept += yield* runReapImages(op, deps);
					break;
				}
				case 'swap-tree': {
					// Build the staging tree via the op's `buildEffect` and
					// publish it through the UNCHANGED `stageAndSwap`. The
					// preserve riders (`preserveFromTarget` /
					// `preserveOnPreseed`) map 1:1 onto `stageAndSwap`'s args as
					// PER-DIRECTION constants — NOT a cache-policy projection.
					// Both restore and capture route their build bodies through
					// this same runner.
					yield* runSwapTree(op);
					break;
				}
			}
		}

		return { inspected, reapedIds, imagesSwept } satisfies FsPlanResult;
	});
