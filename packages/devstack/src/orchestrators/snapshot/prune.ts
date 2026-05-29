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
// rebuild. Prune holds only `snapshot.reservation` (not stack liveness)
// and is CLI-exposed, so this scoping is what keeps it safe against a
// running stack.

import { Effect, FileSystem, Schema } from 'effect';

import type { ContainerRuntime } from '../../contracts/container-runtime.ts';
import { SNAPSHOT_IMAGE_ROLE } from '../../runtime/docker/container.ts';
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
 * same catalog are not supported (caller holds `snapshot.reservation`
 * or `stack.lock`).
 *
 * Also removes committed snapshot byproduct images via the runtime
 * adapter's label-filtered image cleanup, scoped to `role:
 * SNAPSHOT_IMAGE_ROLE` so build images are never touched.
 */
export const runPrune = (
	inputs: PruneInputs,
): Effect.Effect<PruneResult, PrunePhaseError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* Effect.annotateCurrentSpan({
			'devstack.snapshot.phase': 'prune',
		});
		const catalogDir = `${inputs.stackRoot}/${SNAPSHOTS_DIR_NAME}`;
		const catalogExists = yield* fs
			.exists(catalogDir)
			.pipe(Effect.catch(() => Effect.succeed(false)));
		if (!catalogExists) {
			return { inspected: 0, reaped: [], imagesSwept: 0 } satisfies PruneResult;
		}
		const ids = yield* fs
			.readDirectory(catalogDir)
			.pipe(Effect.catch(failPhase('enumerate-catalog', `readdir ${catalogDir} failed`)));

		const reaped: Array<{ id: string; classification: 'abandoned' }> = [];
		for (const id of ids) {
			const dir = `${catalogDir}/${id}`;
			const meta = yield* readMetaOpt(dir);
			// Partial artifacts (no meta) — reap to free the disk slot.
			// The catalog list already hides them; reaping is just GC.
			if (meta === null) {
				yield* fs
					.remove(dir, { recursive: true, force: true })
					.pipe(Effect.catch(failPhase('sweep-directories', `remove ${dir} failed`)));
				reaped.push({ id, classification: 'abandoned' });
			}
		}

		// Sweep committed snapshot byproduct images via the runtime
		// adapter's label-scoped image cleanup. Architecture § Decision §8 —
		// committed snapshot images accumulate (a hard-killed capture can
		// leak its temp image before cleanup); the orchestrator GCs them
		// alongside catalog prune. The `role: SNAPSHOT_IMAGE_ROLE` narrowing
		// is what distinguishes these byproducts from the live stack's
		// build images (which share `{app, stack}` but carry a different
		// role / no role) — without it, prune would untag build images and
		// force silent rebuilds.
		const imagesSwept = yield* inputs.runtime
			.removeManagedImages({ ...inputs.imageLabelFilter, role: SNAPSHOT_IMAGE_ROLE })
			.pipe(Effect.catch(failPhase('sweep-images', `image sweep failed`)));

		return {
			inspected: ids.length,
			reaped,
			imagesSwept,
		} satisfies PruneResult;
	}).pipe(Effect.withSpan('orchestrator.snapshot.prune'));
