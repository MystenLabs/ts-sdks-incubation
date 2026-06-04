// Prune — label-scoped orphan sweep.
//
// Architecture § 4: the L3 prune orchestrator sweeps committed snapshot
// byproduct images and snapshot-catalog directories whose meta document
// is missing (partial artifacts) or unreadable. Stack-wide registry
// pruning (engine resources / stack roster) is a sibling orchestrator and
// lives elsewhere; this file is scoped to snapshot-adjacent artifacts.
//
// Image sweep scope (load-bearing): committed snapshot images are stamped
// at `docker commit` time with `{managed, app, stack, role:
// SNAPSHOT_IMAGE_ROLE}` (see `runtime/docker/container.ts`). Prune scopes
// its sweep to THAT role so it reaps only snapshot byproducts. Plugin
// BUILD images share `{managed, app, stack}` but carry the source
// plugin's real role (or none) — never `SNAPSHOT_IMAGE_ROLE` — so the
// sweep can NEVER untag a live stack's build images and force a silent
// rebuild. Prune holds `stack.lock` only briefly (not stack liveness)
// and is CLI-exposed, so this scoping is what keeps it safe against a
// running stack.

import { Effect, FileSystem, Schema } from 'effect';

import type { ContainerRuntime } from '../../contracts/container-runtime.ts';
import { SNAPSHOT_IMAGE_ROLE } from '../../runtime/docker/container.ts';
import { appName, stackName } from '../../substrate/brand.ts';
import {
	labelScope,
	reconcileLabel,
	reconcileSpec,
	type ReconcileFsOp,
} from '../../substrate/runtime/reconcile/index.ts';
import { decodeJsonText } from '../../substrate/runtime/runtime-decode.ts';
import { SnapshotMetadataSchema, type SnapshotMetadata } from './descriptor.ts';
import { makePhaseFailer } from './phase-error.ts';
import { SNAPSHOTS_DIR_NAME } from './wipe.ts';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class PrunePhaseError extends Schema.TaggedErrorClass<PrunePhaseError>()(
	'SnapshotPrunePhaseError',
	{
		phase: Schema.Literals([
			'enumerate-catalog',
			'read-meta',
			'sweep-images',
			'sweep-directories',
		]),
		detail: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

const failPhase = makePhaseFailer(PrunePhaseError);

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

export interface PruneInputs {
	/** Stack root containing the `snapshots/` catalog. */
	readonly stackRoot: string;
	/** App/stack scope for the committed-snapshot-image sweep. Prune
	 *  narrows this to `role: SNAPSHOT_IMAGE_ROLE` before removing images,
	 *  so only this stack's snapshot byproducts are swept — never its
	 *  build images, never a sibling stack. */
	readonly imageLabelFilter: { readonly app: string; readonly stack: string };
	readonly runtime: ContainerRuntime;
}

export interface PruneResult {
	readonly inspected: number;
	readonly reaped: ReadonlyArray<{
		readonly id: string;
		/** Reason the artifact was reaped. Currently only `'abandoned'`
		 *  (partial artifact with no readable meta document). */
		readonly classification: 'abandoned';
	}>;
	/** Count of committed snapshot byproduct images removed (those stamped
	 *  with `role: SNAPSHOT_IMAGE_ROLE` in this app/stack). Build images
	 *  are never included. */
	readonly imagesSwept: number;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const readMetaOpt = (
	dir: string,
): Effect.Effect<SnapshotMetadata | null, PrunePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = `${dir}/meta.json`;
		const exists = yield* fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)));
		if (!exists) return null;
		const text = yield* fs
			.readFileString(path)
			.pipe(Effect.catch(failPhase('read-meta', `read ${path} failed`)));
		return yield* decodeJsonText(SnapshotMetadataSchema, text, {
			source: path,
			mkError: () => null,
		}).pipe(Effect.catch(() => Effect.succeed(null)));
	});

// -----------------------------------------------------------------------------
// Top-level prune
// -----------------------------------------------------------------------------

/**
 * Walk the snapshot catalog and reap partial artifacts (entries whose
 * `meta.json` is missing or unparseable). Concurrent sweeps over the
 * same catalog are not supported (caller holds `stack.lock`).
 *
 * Also removes committed snapshot byproduct images via the runtime
 * adapter's label-filtered image cleanup, scoped to `role:
 * SNAPSHOT_IMAGE_ROLE` so build images are never touched.
 *
 * Routed through the unified reconcile: a flat LABEL-scope spec narrowed
 * to `role: SNAPSHOT_IMAGE_ROLE`, carrying NO container target (prune
 * mutates no containers — `target: 'running'` is the label-scope no-op
 * container target) and an `fsPlan` of two ops — `reap-meta-missing`
 * (catalog GC) then `reap-images` (byproduct image sweep). Prune never
 * touches the live deploy cache — only the snapshot byproducts (the image
 * GC); the `PruneResult` shape carries `reaped` + `imagesSwept`.
 */
export const runPrune = (
	inputs: PruneInputs,
): Effect.Effect<PruneResult, PrunePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const catalogDir = `${inputs.stackRoot}/${SNAPSHOTS_DIR_NAME}`;

		// Catalog GC — reap partial artifacts (no readable meta). The
		// `isMetaMissing` classifier is prune's projection: a
		// `readMetaOpt` read+decode lifted to a predicate.
		const reapMetaMissing: ReconcileFsOp<PrunePhaseError> = {
			op: 'reap-meta-missing',
			catalogDir,
			isMetaMissing: (dir) => readMetaOpt(dir).pipe(Effect.map((meta) => meta === null)),
			onReaddirError: failPhase('enumerate-catalog', `readdir ${catalogDir} failed`),
			onRemoveError: failPhase('sweep-directories', `remove catalog entry failed`),
		};

		// Byproduct image sweep — architecture § Decision §8. The
		// `role: SNAPSHOT_IMAGE_ROLE` narrowing (carried on the label tuple)
		// distinguishes these byproducts from the live stack's build images
		// (which share `{app, stack}` but carry a different role / no role) —
		// without it, prune would untag build images and force silent
		// rebuilds.
		const reapImages: ReconcileFsOp<PrunePhaseError> = {
			op: 'reap-images',
			onError: failPhase('sweep-images', `image sweep failed`),
		};

		const result = yield* reconcileLabel(
			reconcileSpec<PrunePhaseError>({
				// No container target — prune mutates no containers. Label-scope
				// only sweeps containers/networks/volumes when `target` is
				// `absent`; `running` leaves them untouched.
				target: 'running',
				scope: labelScope({
					app: appName(inputs.imageLabelFilter.app),
					stack: stackName(inputs.imageLabelFilter.stack),
					role: SNAPSHOT_IMAGE_ROLE,
				}),
				direction: 'drain',
				fsPlan: { ops: [reapMetaMissing, reapImages] },
			}),
			{ runtime: inputs.runtime },
		);

		return {
			inspected: result.inspected,
			reaped: result.reapedIds.map((id) => ({ id, classification: 'abandoned' as const })),
			imagesSwept: result.imagesSwept,
		} satisfies PruneResult;
	});
