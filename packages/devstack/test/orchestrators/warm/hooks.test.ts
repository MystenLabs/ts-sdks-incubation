// Warm boot-cache hooks — fast, in-process hit/miss/stale unit tests.
//
// `runWarmRestore` / `runWarmCapture` are the entire warm decision surface
// (`src/orchestrators/warm/hooks.ts`). The expensive halves they orchestrate —
// the snapshot bounce and the supervisor acquire — are STUBBED here: a
// recording `WarmSnapshotOps` captures every `capture`/`restore`/`list`/
// `delete` call, the fingerprint is an injectable constant, and the sidecar is
// read/written against a real temp stack root with `NodeFileSystem`. No Docker,
// no supervisor — just the branch logic:
//
//   HIT          fingerprint matches the on-disk sidecar AND the artifact is in
//                the catalog → `restore` called, `warmRestored` set, and the
//                follow-on capture is a no-op (already-restored tree).
//   MISS-absent  no sidecar → no restore, no delete; a follow-on capture writes
//                a fresh sidecar.
//   STALE        sidecar fingerprint differs from the recomputed one → the
//                stale artifact is deleted + the sidecar cleared, then a
//                follow-on capture writes a NEW sidecar.

import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, FileSystem, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	runWarmCapture,
	runWarmRestore,
	type WarmHookDeps,
	type WarmSnapshotOps,
} from '../../../src/orchestrators/warm/hooks.ts';
import {
	WARM_BASELINE_SIDECAR_FILE,
	readWarmBaseline,
	writeWarmBaseline,
	type WarmBaselineSidecar,
} from '../../../src/orchestrators/warm/baseline.ts';
import { WARM_BASELINE_SNAPSHOT_ID } from '../../../src/orchestrators/warm/fingerprint.ts';
import type {
	SnapshotCatalogEntry,
	SnapshotMetadata,
} from '../../../src/orchestrators/snapshot/index.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';

// -----------------------------------------------------------------------------
// A recording snapshot stub. Each method records its call and returns a
// canned result; `list` returns whatever catalog the test seeded. The hooks
// never read the returned `SnapshotMetadata`, so a minimal cast suffices.
// -----------------------------------------------------------------------------

interface RecordedOps {
	readonly captures: Array<{ id: string; label?: string }>;
	readonly restores: Array<string>;
	readonly deletes: Array<string>;
	listCalls: number;
}

const fakeMeta = (id: string): SnapshotMetadata =>
	({ id, label: null, createdAt: 0 }) as unknown as SnapshotMetadata;

const catalogEntry = (id: string): SnapshotCatalogEntry => ({
	id,
	directory: `/snapshots/${id}`,
	metadata: null,
});

const recordingOps = (
	catalog: ReadonlyArray<SnapshotCatalogEntry>,
): { ops: WarmSnapshotOps; rec: RecordedOps } => {
	const rec: RecordedOps = { captures: [], restores: [], deletes: [], listCalls: 0 };
	const ops: WarmSnapshotOps = {
		list: Effect.sync(() => {
			rec.listCalls += 1;
			return catalog;
		}),
		restore: (args) =>
			Effect.sync(() => {
				rec.restores.push(args.id);
				return fakeMeta(args.id);
			}),
		delete: (id) =>
			Effect.sync(() => {
				rec.deletes.push(id);
			}),
		capture: (args) =>
			Effect.sync(() => {
				rec.captures.push({ id: args.id, ...(args.label === undefined ? {} : { label: args.label }) });
				return fakeMeta(args.id);
			}),
	};
	return { ops, rec };
};

// Stable fingerprints used across the three cases. `FP_CURRENT` is what the
// boot recomputes; `FP_STALE` is an older sidecar's value.
const FP_CURRENT = 'a'.repeat(64);
const FP_STALE = 'b'.repeat(64);

/** Build `WarmHookDeps` over a real temp `stackRoot`, the recording ops, a
 *  constant fingerprint, and fresh Refs. Returns the deps + the recorder +
 *  the Refs so a test can assert post-conditions. */
const makeDeps = (args: {
	readonly fs: FileSystem.FileSystem;
	readonly stackRoot: string;
	readonly catalog: ReadonlyArray<SnapshotCatalogEntry>;
	readonly fingerprint: string;
}): Effect.Effect<{
	readonly deps: WarmHookDeps;
	readonly rec: RecordedOps;
	readonly warmRestoredRef: Ref.Ref<boolean>;
	readonly warmFingerprintRef: Ref.Ref<string | null>;
}> =>
	Effect.gen(function* () {
		const { ops, rec } = recordingOps(args.catalog);
		const warmRestoredRef = yield* Ref.make(false);
		const warmFingerprintRef = yield* Ref.make<string | null>(null);
		const deps: WarmHookDeps = {
			snapshot: ops,
			fs: args.fs,
			stackRoot: args.stackRoot,
			computeFingerprint: Effect.succeed(args.fingerprint),
			warmRestoredRef,
			warmFingerprintRef,
		};
		return { deps, rec, warmRestoredRef, warmFingerprintRef };
	});

/** Read the sidecar straight off disk (bypassing `readWarmBaseline`'s
 *  null-on-corrupt tolerance) so a test can assert exact bytes / absence. */
const sidecarOnDisk = (
	stackRoot: string,
): Effect.Effect<WarmBaselineSidecar | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = join(stackRoot, WARM_BASELINE_SIDECAR_FILE);
		const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
		if (!exists) return null;
		const text = yield* fs.readFileString(path).pipe(Effect.orDie);
		return JSON.parse(text) as WarmBaselineSidecar;
	});

describe('warm hooks — hit/miss/stale', () => {
	it.effect('HIT: fingerprint matches sidecar + artifact present → restore, no capture', () =>
		withTempRoot('warm-hooks-hit', (root) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const stackRoot = join(root, 'stack');
				yield* fs.makeDirectory(stackRoot, { recursive: true });
				// Seed a matching sidecar + a catalog that has the baseline artifact.
				yield* writeWarmBaseline(stackRoot, {
					version: 1,
					fingerprint: FP_CURRENT,
					snapshotId: WARM_BASELINE_SNAPSHOT_ID,
					capturedAt: 111,
				});
				const { deps, rec, warmRestoredRef, warmFingerprintRef } = yield* makeDeps({
					fs,
					stackRoot,
					catalog: [catalogEntry(WARM_BASELINE_SNAPSHOT_ID)],
					fingerprint: FP_CURRENT,
				});

				yield* runWarmRestore(deps);

				// Restore happened; nothing was deleted.
				expect(rec.restores).toEqual([WARM_BASELINE_SNAPSHOT_ID]);
				expect(rec.deletes).toEqual([]);
				expect(yield* Ref.get(warmRestoredRef)).toBe(true);
				expect(yield* Ref.get(warmFingerprintRef)).toBe(FP_CURRENT);

				// The follow-on capture must be a no-op — this boot was a restore.
				yield* runWarmCapture(deps);
				expect(rec.captures).toEqual([]);

				// The matching sidecar is untouched (no recapture).
				const sc = yield* readWarmBaseline(stackRoot);
				expect(sc?.fingerprint).toBe(FP_CURRENT);
				expect(sc?.capturedAt).toBe(111);
			}),
		).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('MISS-absent: no sidecar → no restore; capture writes a fresh sidecar', () =>
		withTempRoot('warm-hooks-miss', (root) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const stackRoot = join(root, 'stack');
				yield* fs.makeDirectory(stackRoot, { recursive: true });
				// No sidecar, empty catalog.
				const { deps, rec, warmRestoredRef } = yield* makeDeps({
					fs,
					stackRoot,
					catalog: [],
					fingerprint: FP_CURRENT,
				});

				yield* runWarmRestore(deps);

				// Nothing to restore, nothing stale to delete.
				expect(rec.restores).toEqual([]);
				expect(rec.deletes).toEqual([]);
				expect(yield* Ref.get(warmRestoredRef)).toBe(false);
				// No sidecar was written by the restore phase.
				expect(yield* sidecarOnDisk(stackRoot)).toBeNull();

				// The follow-on capture captures the baseline + writes a sidecar.
				yield* runWarmCapture(deps);
				expect(rec.captures).toEqual([
					{ id: WARM_BASELINE_SNAPSHOT_ID, label: 'warm-baseline' },
				]);
				const sc = yield* readWarmBaseline(stackRoot);
				expect(sc).not.toBeNull();
				expect(sc?.fingerprint).toBe(FP_CURRENT);
				expect(sc?.snapshotId).toBe(WARM_BASELINE_SNAPSHOT_ID);
			}),
		).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('STALE: sidecar fingerprint differs → delete + clear, then recapture', () =>
		withTempRoot('warm-hooks-stale', (root) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const stackRoot = join(root, 'stack');
				yield* fs.makeDirectory(stackRoot, { recursive: true });
				// Seed a STALE sidecar (old fingerprint) + the stale artifact in the
				// catalog; the boot recomputes a DIFFERENT current fingerprint.
				yield* writeWarmBaseline(stackRoot, {
					version: 1,
					fingerprint: FP_STALE,
					snapshotId: WARM_BASELINE_SNAPSHOT_ID,
					capturedAt: 222,
				});
				const { deps, rec, warmRestoredRef } = yield* makeDeps({
					fs,
					stackRoot,
					catalog: [catalogEntry(WARM_BASELINE_SNAPSHOT_ID)],
					fingerprint: FP_CURRENT,
				});

				yield* runWarmRestore(deps);

				// Stale → no restore; the stale artifact is deleted + the sidecar
				// cleared off disk.
				expect(rec.restores).toEqual([]);
				expect(rec.deletes).toEqual([WARM_BASELINE_SNAPSHOT_ID]);
				expect(yield* Ref.get(warmRestoredRef)).toBe(false);
				expect(yield* sidecarOnDisk(stackRoot)).toBeNull();

				// The follow-on capture recaptures + writes a NEW sidecar with the
				// CURRENT fingerprint.
				yield* runWarmCapture(deps);
				expect(rec.captures).toEqual([
					{ id: WARM_BASELINE_SNAPSHOT_ID, label: 'warm-baseline' },
				]);
				const sc = yield* readWarmBaseline(stackRoot);
				expect(sc?.fingerprint).toBe(FP_CURRENT);
				expect(sc?.fingerprint).not.toBe(FP_STALE);
			}),
		).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});
