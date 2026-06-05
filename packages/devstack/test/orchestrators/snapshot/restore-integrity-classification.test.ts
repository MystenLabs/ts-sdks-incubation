// Asserts the contract between `verifyArtifactIntegrity`'s tagged-error
// kinds and `runRestore`'s `RestorePhaseError.phase` projection. The
// load-bearing rule (STYLE_GUIDE.md §2 rule 5): the phase classifier
// MUST branch by tag/kind, never by message substring.

import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, Exit, Stream } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type {
	ContainerRuntime,
	ImageRef,
	TagImageOptions,
} from '../../../src/contracts/container-runtime.ts';
import {
	RestorePhaseError,
	runRestore,
	SNAPSHOT_META_VERSION,
	SnapshotLayout,
	snapshotIdFromString,
	writeArtifactIntegrity,
	type RestoreParticipant,
	type SnapshotMetadata,
	type SnapshotRuntimeIdentity,
} from '../../../src/orchestrators/snapshot/index.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';

const runtimeIdentity: SnapshotRuntimeIdentity = {
	app: 'restore-app',
	stack: 'main',
	network: 'sui:local',
};

const TEST_IDENTITY = { chain: runtimeIdentity.network } as const;

const identityParticipants = (): ReadonlyArray<RestoreParticipant> => [
	{
		plugin: 'sui#0',
		liveIdentity: Effect.succeed(TEST_IDENTITY),
	},
];

const metadata = (): SnapshotMetadata => ({
	version: SNAPSHOT_META_VERSION,
	id: 'snap-classify',
	label: null,
	createdAt: 1,
	app: runtimeIdentity.app,
	stack: runtimeIdentity.stack,
	network: runtimeIdentity.network,
	hostTreeIncluded: false,
	subtrees: [],
	containers: [],
	identity: TEST_IDENTITY,
	participants: [],
});

const writeArtifact = (root: string, meta: SnapshotMetadata): string => {
	const artifactDir = join(root, 'snapshots', meta.id);
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(join(artifactDir, SnapshotLayout.metaFile), JSON.stringify(meta, null, 2));
	return artifactDir;
};

const runtimeStub = (): ContainerRuntime => ({
	ensureImage: () => Effect.die('ensureImage not used'),
	ensureNetwork: () => Effect.die('ensureNetwork not used'),
	ensureContainer: () => Effect.die('ensureContainer not used'),
	exec: () => Effect.die('exec not used'),
	runOneShot: () => Effect.die('runOneShot not used'),
	inspectByLabels: () => Effect.die('inspectByLabels not used'),
	pauseAndCommit: () => Effect.die('pauseAndCommit not used'),
	saveImages: () => Stream.empty,
	loadImage: () => Effect.die('loadImage not used'),
	tagImage: (_src: ImageRef, _newTag: string, _opts: TagImageOptions | undefined) =>
		Effect.die('tagImage not used'),
	removeImage: () => Effect.void,
	inspectImageDigest: () => Effect.succeed(null),
	stop: () => Effect.die('stop not used'),
	removeManagedContainers: () => Effect.succeed(0),
	removeManagedImages: () => Effect.die('removeManagedImages not used'),
	removeManagedNetworks: () => Effect.die('removeManagedNetworks not used'),
	removeManagedVolumes: () => Effect.die('removeManagedVolumes not used'),
});

const runRestoreExit = (root: string, artifactDir: string, meta: SnapshotMetadata) =>
	Effect.exit(
		runRestore({
			snapshotId: snapshotIdFromString(meta.id),
			artifactDir,
			runtimeStackRoot: join(root, 'runtime-stack'),
			runtimeStagingPath: join(root, 'runtime-stack.staging'),
			runtimeBackupPath: join(root, 'runtime-stack.bak'),
			participants: identityParticipants(),
			runtime: runtimeStub(),
			runtimeIdentity,
		}),
	);

const expectRestorePhase = (exit: Exit.Exit<unknown, unknown>, expectedPhase: string): void => {
	expect(Exit.isFailure(exit)).toBe(true);
	const error = Exit.findErrorOption(exit);
	expect(error._tag).toBe('Some');
	if (error._tag === 'Some') {
		expect(error.value).toBeInstanceOf(RestorePhaseError);
		if (error.value instanceof RestorePhaseError) {
			expect(error.value.phase).toBe(expectedPhase);
		}
	}
};

describe('restore integrity classification', () => {
	it.effect('classifies SnapshotIntegrityError(kind=missing) as phase=read-integrity', () =>
		withTempRoot('restore-integrity-classify', (root) =>
			Effect.gen(function* () {
				const meta = metadata();
				const artifactDir = writeArtifact(root, meta);
				// Deliberately do NOT write integrity.json.

				const exit = yield* runRestoreExit(root, artifactDir, meta).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expectRestorePhase(exit, 'read-integrity');
			}),
		),
	);

	it.effect('classifies SnapshotIntegrityError(kind=corrupt) as phase=verify-integrity', () =>
		withTempRoot('restore-integrity-classify', (root) =>
			Effect.gen(function* () {
				const meta = metadata();
				const artifactDir = writeArtifact(root, meta);
				writeFileSync(join(artifactDir, SnapshotLayout.integrityFile), '{ not json at all');

				const exit = yield* runRestoreExit(root, artifactDir, meta).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expectRestorePhase(exit, 'verify-integrity');
			}),
		),
	);

	it.effect('classifies SnapshotIntegrityError(kind=mismatch) as phase=verify-integrity', () =>
		withTempRoot('restore-integrity-classify', (root) =>
			Effect.gen(function* () {
				const meta = metadata();
				const artifactDir = writeArtifact(root, meta);
				yield* writeArtifactIntegrity(artifactDir).pipe(Effect.provide(NodeFileSystem.layer));

				// Mutate meta.json so its recorded hash no longer matches.
				const metaPath = join(artifactDir, SnapshotLayout.metaFile);
				const original = readFileSync(metaPath, 'utf8');
				writeFileSync(metaPath, `${original}\n`);

				const exit = yield* runRestoreExit(root, artifactDir, meta).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expectRestorePhase(exit, 'verify-integrity');
			}),
		),
	);

	it.effect('classifies SnapshotIntegrityError(kind=walk-failed) as phase=verify-integrity', () =>
		withTempRoot('restore-integrity-classify', (root) =>
			Effect.gen(function* () {
				const meta = metadata();
				const artifactDir = writeArtifact(root, meta);
				yield* writeArtifactIntegrity(artifactDir).pipe(Effect.provide(NodeFileSystem.layer));

				// Add a symlink inside the artifact dir. The walker's
				// `stat` reports it as neither File nor Directory, which
				// triggers `failWalk(... not a regular file ...)` —
				// kind=walk-failed.
				symlinkSync('/tmp/does-not-exist-snapshot-target', join(artifactDir, 'dangling.link'));

				const exit = yield* runRestoreExit(root, artifactDir, meta).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expectRestorePhase(exit, 'verify-integrity');
			}),
		),
	);
});
