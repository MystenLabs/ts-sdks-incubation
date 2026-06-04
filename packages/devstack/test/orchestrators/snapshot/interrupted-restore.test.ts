// Interrupted-restore sentinel + boot-time auto-recovery tests.
//
// Pins:
//   - write → read → clear roundtrip (the sentinel rides the swap as a
//     plain JSON file at the runtime-root, so these are direct FS ops);
//   - `readRestoreSentinel` collapses absent / unparseable to `null`;
//   - `recoverInterruptedRestore` is a NO-OP when the sentinel is absent
//     (the clean-boot case) and INVOKES restore when present;
//   - loop-safety: a SUCCESSFUL recovery clears the sentinel; a FAILING
//     recovery LEAVES it for the next boot to retry;
//   - an unsafe-id sentinel is cleared without invoking restore.

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	snapshotIdFromString,
	type SnapshotId,
} from '../../../src/orchestrators/snapshot/descriptor.ts';
import {
	clearRestoreSentinel,
	readRestoreSentinel,
	recoverInterruptedRestore,
	RESTORE_SENTINEL_FILE_NAME,
	SNAPSHOT_RESTORE_SENTINEL_VERSION,
	writeRestoreSentinel,
} from '../../../src/orchestrators/snapshot/interrupted-restore.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';

const TEMP_PREFIX = 'snapshot-interrupted-restore-test';

const sentinelPath = (root: string): string => join(root, RESTORE_SENTINEL_FILE_NAME);

const SNAP_ID = snapshotIdFromString('snap-12345');

describe('interrupted-restore sentinel IO', () => {
	it.effect('write → read → clear roundtrip', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const artifactDir = join(root, 'snapshots', SNAP_ID);

				// Write into the (here, same) root — production writes into the
				// staging tree, which the swap renames into the live root.
				yield* writeRestoreSentinel(root, { snapshotId: SNAP_ID, artifactDir });
				expect(existsSync(sentinelPath(root))).toBe(true);

				const read = yield* readRestoreSentinel(root);
				expect(read).not.toBeNull();
				expect(read?.version).toBe(SNAPSHOT_RESTORE_SENTINEL_VERSION);
				expect(read?.snapshotId).toBe(SNAP_ID);
				expect(read?.artifactDir).toBe(artifactDir);

				yield* clearRestoreSentinel(root);
				expect(existsSync(sentinelPath(root))).toBe(false);

				// Read after clear → null.
				const afterClear = yield* readRestoreSentinel(root);
				expect(afterClear).toBeNull();
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it.effect('readRestoreSentinel returns null when absent', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const read = yield* readRestoreSentinel(root);
				expect(read).toBeNull();
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it.effect('readRestoreSentinel returns null when the file is unparseable', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				writeFileSync(sentinelPath(root), '{ not valid json');
				const read = yield* readRestoreSentinel(root);
				expect(read).toBeNull();
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it.effect('clearRestoreSentinel is a no-op when the sentinel is absent', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				yield* clearRestoreSentinel(root);
				expect(existsSync(sentinelPath(root))).toBe(false);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);
});

describe('recoverInterruptedRestore', () => {
	it.effect('is a no-op when no sentinel is present (clean boot)', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const calls: SnapshotId[] = [];
				yield* recoverInterruptedRestore({
					liveRoot: root,
					restoreSnapshot: (id) =>
						Effect.sync(() => {
							calls.push(id);
						}),
				});
				expect(calls).toEqual([]);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it.effect('invokes restore with the sentinel id when present, then clears', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const artifactDir = join(root, 'snapshots', SNAP_ID);
				yield* writeRestoreSentinel(root, { snapshotId: SNAP_ID, artifactDir });

				const calls: SnapshotId[] = [];
				yield* recoverInterruptedRestore({
					liveRoot: root,
					restoreSnapshot: (id) =>
						Effect.sync(() => {
							calls.push(id);
						}),
				});

				// Restore was invoked exactly once with the sentinel's id.
				expect(calls).toEqual([SNAP_ID]);
				// A successful recovery clears the sentinel so the next boot is clean.
				expect(existsSync(sentinelPath(root))).toBe(false);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it.effect('leaves the sentinel in place when the recovery restore fails (retry)', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const artifactDir = join(root, 'snapshots', SNAP_ID);
				yield* writeRestoreSentinel(root, { snapshotId: SNAP_ID, artifactDir });

				const calls: SnapshotId[] = [];
				// Recovery swallows the failure (boot must not wedge) but DELIBERATELY
				// leaves the sentinel for the next boot's retry.
				yield* recoverInterruptedRestore({
					liveRoot: root,
					restoreSnapshot: (id) =>
						Effect.gen(function* () {
							calls.push(id);
							return yield* Effect.fail('still-failing artifact' as const);
						}),
				});

				expect(calls).toEqual([SNAP_ID]);
				// Sentinel survives so the next boot retries.
				expect(existsSync(sentinelPath(root))).toBe(true);
				const stillThere = yield* readRestoreSentinel(root);
				expect(stillThere?.snapshotId).toBe(SNAP_ID);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it.effect('clears an unsafe-id sentinel without invoking restore', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				// Hand-write a sentinel carrying an unsafe (path-escaping) id —
				// `writeRestoreSentinel` only accepts a branded `SnapshotId`, so a
				// corrupt/tampered on-disk file is the only way this arises.
				writeFileSync(
					sentinelPath(root),
					JSON.stringify({
						version: SNAPSHOT_RESTORE_SENTINEL_VERSION,
						snapshotId: '../escape',
						artifactDir: join(root, 'snapshots', 'x'),
					}),
				);

				const calls: string[] = [];
				yield* recoverInterruptedRestore({
					liveRoot: root,
					restoreSnapshot: (id) =>
						Effect.sync(() => {
							calls.push(id);
						}),
				});

				// Restore was never invoked, and the unsafe sentinel was cleared so
				// it cannot re-trigger every boot.
				expect(calls).toEqual([]);
				expect(existsSync(sentinelPath(root))).toBe(false);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);
});
