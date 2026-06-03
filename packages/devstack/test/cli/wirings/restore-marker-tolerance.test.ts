// Stage D2 stale-marker tolerance.
//
// The crash-recovery marker subsystem (the recovery scanner + its marker
// schema/IO module) was deleted: restore now leaves promoted images at
// their TARGET names so the next boot's image-match adoption re-runs the
// deploy with no scanner. A pre-D2 binary that crashed mid image-promotion
// may have left a v2 `snapshot.restore-pending.json` on disk; the new boot
// path must TOLERATE it — unlink it best-effort (WITHOUT parsing) before any
// plugin acquire, and otherwise be a no-op.
//
// Inverting `clearStaleRestoreMarker` (skipping the unlink, or failing on a
// missing/locked file) flips one of these assertions.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, FileSystem } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	clearStaleRestoreMarker,
	RESTORE_PENDING_FILE_NAME,
} from '../../../src/cli/wirings/restore-marker-tolerance.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';

const TEMP_PREFIX = 'devstack-stale-marker';

// A v2 marker shaped like one a pre-D2 binary would have written. The
// tolerance step must NOT parse it — its contents are irrelevant.
const V2_MARKER = JSON.stringify({
	version: 2,
	snapshotId: 'snap-abc12345',
	artifactDir: '/some/artifact',
	containers: [
		{
			plugin: 'postgres',
			role: 'db',
			targetImageName: 'devstack-build:postgres-original',
			stagedImageTag: 'devstack-snapshot:restore-deadbeef',
			digest: 'sha256:loaded-postgres-db',
		},
	],
});

describe('clearStaleRestoreMarker', () => {
	it.effect('unlinks a stale v2 restore-pending marker and proceeds', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'runtime-stack');
				mkdirSync(stackRoot, { recursive: true });
				const markerPath = join(stackRoot, RESTORE_PENDING_FILE_NAME);
				writeFileSync(markerPath, V2_MARKER);
				expect(existsSync(markerPath)).toBe(true);

				const fs = yield* FileSystem.FileSystem;
				yield* clearStaleRestoreMarker(fs, stackRoot);

				// Boot proceeds (the effect succeeds) and the stale marker is
				// gone — a pre-D2 crash leaves nothing for D2 to trip over.
				expect(existsSync(markerPath)).toBe(false);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it.effect('is a no-op when no marker is present', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'runtime-stack');
				mkdirSync(stackRoot, { recursive: true });

				const fs = yield* FileSystem.FileSystem;
				// Must not fail when the marker is absent (the common boot path).
				yield* clearStaleRestoreMarker(fs, stackRoot);

				expect(existsSync(join(stackRoot, RESTORE_PENDING_FILE_NAME))).toBe(false);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);
});
