// Reconcile over a flat label scope.
//
// The out-of-supervisor sibling of `reconcileGraph` (`./graph.ts`). Where
// the graph axis is dep-ordered (in-supervisor), the LABEL axis is a FLAT
// sweep over docker resources matched by an `{app, stack[, plugin, role]}`
// tuple plus a file-tree fs-plan — there is no live dep-graph to order
// (guardrail: graph-scope gets dep-order, label-scope gets the flat
// `removeManaged*` sweep).
//
// `reconcileLabel(spec, deps)` executes, in order:
//
//   1. container TARGET — when `target === 'absent'`, force-remove managed
//      containers + networks + volumes at the label tuple via the EXISTING
//      `removeManaged{Containers,Networks,Volumes}` family (NOT
//      reimplemented). Each removal is mapped through a CALLER-supplied
//      failer so the routed flow keeps its existing error tags (wipe's
//      `sweep-containers` / `sweep-networks-volumes`). `target === 'running'`
//      is not a label-scope flow today (die seam).
//
//   2. fsPlan — the file-tree + image ops via `executeFsPlan`
//      (`./fs-plan.ts`). Prune carries NO container target (its only
//      docker mutation is the `reap-images` op inside the fsPlan); wipe
//      carries both.
//
// `decideRunAction` / `ensureContainer` are untouched — label scope
// never picks a per-container docker action (the
// `removeManaged*` family is a flat label sweep, not the per-node
// converger). `stageAndSwap` is untouched.

import { Effect, FileSystem } from 'effect';

import type { ContainerRuntime } from '../../../contracts/container-runtime.ts';
import type { ContainerLabelTuple } from '../../../contracts/snapshotable.ts';
import { executeFsPlan, type FsPlanResult } from './fs-plan.ts';
import type { ReconcileSpec } from './spec.ts';

// -----------------------------------------------------------------------------
// Deps
// -----------------------------------------------------------------------------

/** A per-resource failure mapper — maps a `removeManaged*` defect onto the
 *  caller's phase-tagged error (so routing wipe through here keeps its
 *  `sweep-containers` / `sweep-networks-volumes` tags). */
export type ReconcileLabelFailer<E> = (cause: unknown) => Effect.Effect<never, E>;

/** Everything `reconcileLabel` needs to drive the kept `removeManaged*`
 *  family + the fs-plan executor. The container failers are only consulted
 *  when `spec.target === 'absent'`; a target-less flow (prune) omits them.
 *  `imageLabelFilter` is threaded to the fs-plan's `reap-images` op. */
export interface ReconcileLabelDeps<E> {
	readonly runtime: ContainerRuntime;
	/** Caller failers for the container TARGET sweep (absent-hard). */
	readonly onContainersError?: ReconcileLabelFailer<E>;
	readonly onNetworksError?: ReconcileLabelFailer<E>;
	readonly onVolumesError?: ReconcileLabelFailer<E>;
}

// -----------------------------------------------------------------------------
// reconcileLabel
// -----------------------------------------------------------------------------

/**
 * Reconcile a flat label-scope spec toward its target + fs-plan. Returns
 * the `FsPlanResult` (reaped ids + swept image count) the routed flows
 * surface; flows that mutate nothing on disk just get the empty result.
 *
 * Order is `target → fsPlan`: for `wipe` the containers/networks/volumes
 * are gone BEFORE the runtime tree is swept; for `prune` there is no
 * container target, so it is purely the fsPlan (catalog reap + image
 * reap).
 */
export const reconcileLabel = <E>(
	spec: ReconcileSpec<E>,
	deps: ReconcileLabelDeps<E>,
): Effect.Effect<FsPlanResult, E, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		if (spec.scope.kind !== 'label') {
			// Wiring bug — `reconcileLabel` is the label-axis executor; a
			// graph-keys spec must go through `reconcileGraph`.
			return yield* Effect.die(
				'reconcileLabel: expected a label scope; graph-keys scopes go through reconcileGraph',
			);
		}
		const tuple = spec.scope.tuple;
		yield* Effect.annotateCurrentSpan({
			'devstack.reconcile.scope': 'label',
			'devstack.app': tuple.app,
			'devstack.stack': tuple.stack,
		});

		// 1. Container TARGET — flat label sweep via the kept removeManaged*
		//    family. No dep ordering for label scope.
		if (spec.target === 'absent') {
			const labelMatch: Partial<ContainerLabelTuple> = {
				app: tuple.app,
				stack: tuple.stack,
				...(tuple.plugin === undefined ? {} : { plugin: tuple.plugin }),
				...(tuple.role === undefined ? {} : { role: tuple.role }),
			};
			yield* deps.runtime
				.removeManagedContainers(labelMatch)
				.pipe(Effect.catch(deps.onContainersError ?? ((cause) => Effect.die(cause))));
			yield* deps.runtime
				.removeManagedNetworks(labelMatch)
				.pipe(Effect.catch(deps.onNetworksError ?? ((cause) => Effect.die(cause))));
			yield* deps.runtime
				.removeManagedVolumes(labelMatch)
				.pipe(Effect.catch(deps.onVolumesError ?? ((cause) => Effect.die(cause))));
		}

		// 2. fsPlan — file-tree + image ops. Threads the runtime +
		//    (role-narrowed) label filter so the `reap-images` op can sweep.
		if (spec.fsPlan === undefined) {
			return { inspected: 0, reapedIds: [], imagesSwept: 0 } satisfies FsPlanResult;
		}
		return yield* executeFsPlan(spec.fsPlan, {
			runtime: deps.runtime,
			imageLabelFilter: tuple,
		});
	}).pipe(Effect.withSpan('lifecycle.reconcile.label'));
