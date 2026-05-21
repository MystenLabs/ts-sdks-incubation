// Prune — label-scoped orphan sweep.
//
// Architecture § 4 / Decision §10: plugins emit `LifenessClassifier`
// decls; the L3 prune orchestrator dispatches to them with the
// registry-persisted hints and reaps anything classified `abandoned`.
//
// This module is the snapshot-orchestrator-side of prune: sweeping
// snapshot-byproduct images, snapshot-catalog directories that lost
// their owning stack, and cache entries whose chainId is no longer
// referenced anywhere.
//
// The substrate-wide registry prune (engine resources / stack
// roster) is a sibling orchestrator and lives elsewhere; this file
// is scoped to snapshot adjacent artifacts.

import { Effect, FileSystem, Schema } from 'effect';

import type {
	LifenessClassification,
	LifenessClassifierDecl,
	LifenessHints,
} from '../../contracts/liveness-classifier.ts';
import type { ContainerRuntime } from '../../contracts/container-runtime.ts';
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
			'classify',
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

/** Per-classifier dispatch entry — the L3 prune orchestrator hands
 *  the classifier the persisted hints for one snapshot artifact /
 *  cache entry / etc., and the classifier returns `'alive' | 'dormant'
 *  | 'stale' | 'abandoned'`. */
export interface ClassifierDispatch {
	readonly plugin: string;
	readonly decl: LifenessClassifierDecl;
}

export interface PruneInputs {
	/** Stack root containing the `snapshots/` catalog. */
	readonly stackRoot: string;
	/** Filter for managed image cleanup. */
	readonly imageLabelFilter: { readonly app: string; readonly stack: string };
	/** Classifiers contributed by plugins — same set the L3 prune
	 *  orchestrator dispatches to. Iterated in declaration order; the
	 *  first non-`alive` classification wins. */
	readonly classifiers: ReadonlyArray<ClassifierDispatch>;
	readonly runtime: ContainerRuntime;
}

export interface PruneResult {
	readonly inspected: number;
	readonly reaped: ReadonlyArray<{
		readonly id: string;
		readonly classification: LifenessClassification;
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
		const raw = yield* Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: () => null,
		}).pipe(Effect.catch(() => Effect.succeed(null)));
		if (raw === null) return null;
		return yield* Schema.decodeUnknownEffect(SnapshotMetadataSchema)(raw).pipe(
			Effect.catch(() => Effect.succeed(null)),
		);
	});

/** Build the hints document a classifier consumes. Snapshot prune is
 *  age- + identity-based by default; plugin-specific hints flow
 *  through `pluginHints`. */
const hintsFor = (meta: SnapshotMetadata): LifenessHints => ({
	heartbeatAt: meta.createdAt,
	claimPid: null,
	claimStartTime: null,
	pluginHints: {
		snapshotId: meta.id,
		identity: meta.identity,
		participants: meta.participants,
	},
});

// -----------------------------------------------------------------------------
// Top-level prune
// -----------------------------------------------------------------------------

/**
 * Walk the snapshot catalog, dispatch each artifact's hints through
 * the contributed classifiers, and reap anything classified
 * `abandoned`. Concurrent sweeps over the same catalog are not
 * supported (caller holds `snapshot.reservation` or `stack.lock`).
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

		const reaped: Array<{ id: string; classification: LifenessClassification }> = [];
		for (const id of ids) {
			const dir = `${catalogDir}/${id}`;
			const meta = yield* readMetaOpt(dir);
			// Partial artifacts (no meta) — classify as `abandoned` by
			// convention. The catalog list already hides them; reaping
			// is just freeing the disk slot.
			if (meta === null) {
				yield* fs
					.remove(dir, { recursive: true, force: true })
					.pipe(Effect.catch(failPhase('sweep-directories', `remove ${dir} failed`)));
				reaped.push({ id, classification: 'abandoned' });
				continue;
			}
			const hints = hintsFor(meta);
			let classification: LifenessClassification = 'alive';
			for (const { decl } of inputs.classifiers) {
				const c = yield* decl
					.classify(hints)
					.pipe(Effect.catch(() => Effect.succeed('alive' as LifenessClassification)));
				if (c !== 'alive') {
					classification = c;
					break;
				}
			}
			if (classification === 'abandoned') {
				yield* fs
					.remove(dir, { recursive: true, force: true })
					.pipe(Effect.catch(failPhase('sweep-directories', `remove ${dir} failed`)));
				reaped.push({ id, classification });
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
