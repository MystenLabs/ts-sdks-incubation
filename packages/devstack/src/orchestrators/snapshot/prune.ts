// Prune — label-scoped orphan sweep.
//
// Architecture § 4: the L3 prune orchestrator sweeps snapshot-byproduct
// images and snapshot-catalog directories whose meta document is missing
// (partial artifacts) or unreadable. Stack-wide registry pruning (engine
// resources / stack roster) is a sibling orchestrator and lives elsewhere;
// this file is scoped to snapshot-adjacent artifacts.

import { Effect, FileSystem, Schema } from 'effect';

import type { ContainerRuntime } from '../../contracts/container-runtime.ts';
import { decodeJsonText } from '../../substrate/runtime/runtime-decode.ts';
import { SnapshotMetadataSchema, type SnapshotMetadata } from './descriptor.ts';
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

const failPhase =
	(
		phase: PrunePhaseError['phase'],
		detail: string,
	): ((cause: unknown) => Effect.Effect<never, PrunePhaseError>) =>
	(cause) =>
		Effect.fail(new PrunePhaseError({ phase, detail, cause }));

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

export interface PruneInputs {
	/** Stack root containing the `snapshots/` catalog. */
	readonly stackRoot: string;
	/** Filter for managed image cleanup. */
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
 * Also removes managed images via the runtime adapter's label-filtered
 * image cleanup.
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

		// Sweep snapshot-byproduct images via the runtime adapter's
		// label-scoped image cleanup. Architecture § Decision §8 —
		// committed snapshot images accumulate; the orchestrator GCs
		// alongside catalog prune.
		const imagesSwept = yield* inputs.runtime
			.removeManagedImages(inputs.imageLabelFilter)
			.pipe(Effect.catch(failPhase('sweep-images', `image sweep failed`)));

		return {
			inspected: ids.length,
			reaped,
			imagesSwept,
		} satisfies PruneResult;
	}).pipe(Effect.withSpan('orchestrator.snapshot.prune'));
