import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, Exit, Fiber, Stream } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type {
	ContainerRuntime,
	ContainerRuntimeError,
	ImageRef,
	TagImageOptions,
} from '../../../src/contracts/container-runtime.ts';
import type { ContainerLabelTuple } from '../../../src/contracts/snapshotable.ts';
import {
	CACHE_DIR_NAME,
	DEPLOY_CACHE_NAMESPACES,
	IdentityEmptyError,
	IdentityMismatchError,
	RestorePhaseError,
	runRestore,
	SNAPSHOT_CONTRIBUTION_VERSION,
	SNAPSHOT_META_VERSION,
	SnapshotLayout,
	containerImagesBundlePath,
	contributionPath,
	snapshotIdFromString,
	writeArtifactIntegrity,
	type RestoreParticipant,
	type SnapshotMetadata,
	type SnapshotRuntimeIdentity,
} from '../../../src/orchestrators/snapshot/index.ts';
import {
	COMMAND_CHANNEL_COMMANDS_FILE_NAME,
	COMMAND_CHANNEL_EVENTS_FILE_NAME,
	commandChannelPaths,
	makeCommandChannelPublisher,
	makeCommandChannelSubscriber,
	type CommandRecord,
	type EventRecord,
} from '../../../src/substrate/runtime/cross-process/command-channel/index.ts';
import { makeContainerRuntimeStub } from '../../helpers/container-runtime-stub.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';
import { dockerSaveBundleTarWithLateMetadata, writeImageBundle } from './image-bundle-fixtures.ts';

const TEMP_PREFIX = 'snapshot-restore-test';

const runtimeIdentity: SnapshotRuntimeIdentity = {
	app: 'restore-app',
	stack: 'main',
	network: 'sui:local',
};

const RESTORE_TEST_IDENTITY = { chain: runtimeIdentity.network } as const;

const restoreIdentityParticipants = (): ReadonlyArray<RestoreParticipant> => [
	{
		plugin: 'sui#0',
		liveIdentity: Effect.succeed(RESTORE_TEST_IDENTITY),
	},
];

const metadata = (overrides: Partial<SnapshotMetadata> = {}): SnapshotMetadata => ({
	version: SNAPSHOT_META_VERSION,
	id: 'snap-safe',
	label: null,
	createdAt: 1,
	app: runtimeIdentity.app,
	stack: runtimeIdentity.stack,
	network: runtimeIdentity.network,
	hostTreeIncluded: false,
	subtrees: [],
	containers: [],
	identity: RESTORE_TEST_IDENTITY,
	participants: [],
	...overrides,
});

const writeArtifact = (root: string, meta: SnapshotMetadata): string => {
	const artifactDir = join(root, 'snapshots', meta.id);
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(join(artifactDir, SnapshotLayout.metaFile), JSON.stringify(meta, null, 2));
	return artifactDir;
};

const imageBundlePath = containerImagesBundlePath();

const capturedContainer = (
	overrides: Partial<SnapshotMetadata['containers'][number]> = {},
): SnapshotMetadata['containers'][number] => ({
	plugin: 'postgres',
	role: 'db',
	imageName: 'devstack-build:postgres-original',
	snapshotTag: 'devstack-snapshot:postgres-db',
	tarPath: imageBundlePath,
	...overrides,
});

const tarWithSingleEntry = (entryPath: string): Buffer => {
	const header = Buffer.alloc(512);
	header.write(entryPath, 0, 'utf8');
	header.write('00000000000', 124, 'ascii');
	header[156] = '0'.charCodeAt(0);
	return Buffer.concat([header, Buffer.alloc(1024)]);
};

/** Build a checksum-less ustar archive with one or more entries. Sufficient for
 *  the JS tar READER (it parses path/size/typeflag and never verifies the
 *  checksum or magic), so it drives the host-tree cache-namespace scan in the
 *  preflight. NOT valid enough for system `tar -x` (which DOES check the
 *  checksum) — extraction tests build a real archive via spawn('tar'). Each
 *  entry is either a zero-size path or `{ path, body }` for a regular file. */
const tarWithEntries = (entries: ReadonlyArray<string | { path: string; body: string }>): Buffer => {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const path = typeof entry === 'string' ? entry : entry.path;
		const body = typeof entry === 'string' ? '' : entry.body;
		const bodyBytes = Buffer.from(body, 'utf8');
		const header = Buffer.alloc(512);
		header.write(path, 0, 'utf8');
		header.write(bodyBytes.length.toString(8).padStart(11, '0'), 124, 'ascii');
		header[156] = '0'.charCodeAt(0);
		blocks.push(header);
		if (bodyBytes.length > 0) {
			const padded = Buffer.alloc(Math.ceil(bodyBytes.length / 512) * 512);
			bodyBytes.copy(padded);
			blocks.push(padded);
		}
	}
	// Two trailing zero blocks mark end-of-archive.
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
};

const runtimeStub = (
	sweepCalls: Array<Partial<ContainerLabelTuple>>,
	opts: {
		readonly loadBytes?: Array<number>;
		readonly tagCalls?: Array<{
			readonly src: ImageRef;
			readonly newTag: string;
			readonly opts: TagImageOptions | undefined;
		}>;
		readonly loadedRef?: ImageRef;
		readonly loadedRefs?: ReadonlyArray<ImageRef>;
		readonly loadError?: ContainerRuntimeError;
		readonly tagError?: ContainerRuntimeError;
		readonly tagErrorFor?: (newTag: string) => ContainerRuntimeError | undefined;
		readonly removeImageCalls?: Array<ImageRef>;
		readonly removeImageErrorFor?: (ref: ImageRef) => ContainerRuntimeError | undefined;
		readonly events?: Array<string>;
		/** Drive the promote-GC: resolves a name to the digest it points at.
		 *  Each successive call for the same name reads the next element of the
		 *  queued list (old digest BEFORE promote, new digest AFTER). A name
		 *  absent from the map resolves to `null` (default — no orphan to GC), so
		 *  existing tests are unaffected. */
		readonly inspectDigestsFor?: Map<string, Array<string | null>>;
	} = {},
): ContainerRuntime =>
	makeContainerRuntimeStub({
		saveImages: () => Stream.empty,
		loadImage: (tar) =>
			Stream.runCollect(tar).pipe(
				Effect.mapError(
					(cause): ContainerRuntimeError => ({
						_tag: 'ContainerRuntimeError',
						reason: 'image-load-failed',
						detail: String(cause),
					}),
				),
				Effect.flatMap((chunks) => {
					for (const chunk of chunks) {
						opts.loadBytes?.push(...chunk);
					}
					opts.events?.push('load');
					return opts.loadError !== undefined
						? Effect.fail(opts.loadError)
						: Effect.succeed({
								refs: opts.loadedRefs ?? [
									opts.loadedRef ?? {
										digest: 'sha256:loaded-postgres-db',
										tag: 'devstack-snapshot:postgres-db',
									},
									{
										digest: 'sha256:loaded-postgres-worker',
										tag: 'devstack-snapshot:postgres-worker',
									},
								],
							});
				}),
			),
		tagImage: (src, newTag, tagOpts) =>
			Effect.gen(function* () {
				opts.events?.push(`tag:${newTag}`);
				opts.tagCalls?.push({ src, newTag, opts: tagOpts });
				const tagError = opts.tagErrorFor?.(newTag) ?? opts.tagError;
				if (tagError !== undefined) {
					return yield* Effect.fail(tagError);
				}
			}),
		removeImage: (ref) =>
			Effect.gen(function* () {
				opts.events?.push(`remove-image:${ref.tag ?? ref.digest}`);
				opts.removeImageCalls?.push(ref);
				const removeError = opts.removeImageErrorFor?.(ref);
				if (removeError !== undefined) {
					return yield* Effect.fail(removeError);
				}
			}),
		inspectImageDigest: (ref) =>
			Effect.sync(() => {
				const queue = opts.inspectDigestsFor?.get(ref);
				if (queue === undefined || queue.length === 0) return null;
				return queue.shift() ?? null;
			}),
		removeManagedContainers: (labelMatch) =>
			Effect.sync(() => {
				opts.events?.push(`remove:${labelMatch.plugin}/${labelMatch.role}`);
				sweepCalls.push(labelMatch);
				return 1;
			}),
	});

/** Seed a live deploy-cache namespace under a runtime-stack root so the
 *  PR#1 cache-existence preflight (fail-closed when the sole source of the
 *  on-chain ids is gone) is satisfied. The dedicated `cache-missing` test
 *  below deliberately does NOT call this. */
const seedDeployCacheAt = (stackRoot: string): void => {
	mkdirSync(join(stackRoot, CACHE_DIR_NAME, DEPLOY_CACHE_NAMESPACES[0]!), { recursive: true });
};

const runRestoreExit = (
	root: string,
	meta: SnapshotMetadata,
	identity: SnapshotRuntimeIdentity,
	sweepCalls: Array<Partial<ContainerLabelTuple>>,
	runtime: ContainerRuntime = runtimeStub(sweepCalls),
	participants: ReadonlyArray<RestoreParticipant> = restoreIdentityParticipants(),
) =>
	Effect.gen(function* () {
		seedDeployCacheAt(join(root, 'runtime-stack'));
		const artifactDir = writeArtifact(root, meta);
		yield* writeArtifactIntegrity(artifactDir);
		return yield* Effect.exit(
			runRestore({
				snapshotId: snapshotIdFromString(meta.id),
				artifactDir,
				runtimeStackRoot: join(root, 'runtime-stack'),
				runtimeStagingPath: join(root, 'runtime-stack.staging'),
				runtimeBackupPath: join(root, 'runtime-stack.bak'),
				participants,
				runtime,
				runtimeIdentity: identity,
			}),
		);
	});

describe('snapshot restore safety', () => {
	it.effect('refuses mismatched metadata runtime identity before cleanup', () =>
		Effect.gen(function* () {
			const fields: ReadonlyArray<keyof SnapshotRuntimeIdentity> = ['app', 'stack', 'network'];
			for (const field of fields) {
				yield* withTempRoot(TEMP_PREFIX, (root) =>
					Effect.gen(function* () {
						const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
						const loadBytes: number[] = [];
						const tagCalls: Array<{
							readonly src: ImageRef;
							readonly newTag: string;
							readonly opts: TagImageOptions | undefined;
						}> = [];
						const foreignMeta = metadata({
							[field]: `${runtimeIdentity[field]}-foreign`,
							containers: [
								capturedContainer({
									plugin: 'postgres#0',
									imageName: 'postgres:test',
								}),
							],
						});
						const exit = yield* runRestoreExit(
							root,
							foreignMeta,
							runtimeIdentity,
							sweepCalls,
							runtimeStub(sweepCalls, { loadBytes, tagCalls }),
						).pipe(Effect.provide(NodeFileSystem.layer));

						expect(Exit.isFailure(exit)).toBe(true);
						const error = Exit.findErrorOption(exit);
						expect(error._tag).toBe('Some');
						if (error._tag === 'Some') {
							expect(error.value).toBeInstanceOf(IdentityMismatchError);
							expect(error.value._tag).toBe('SnapshotIdentityMismatch');
							if (error.value._tag === 'SnapshotIdentityMismatch') {
								expect(error.value.key).toBe(field);
							}
						}
						expect(sweepCalls).toEqual([]);
						expect(loadBytes).toEqual([]);
						expect(tagCalls).toEqual([]);
					}),
				);
			}
		}),
	);

	it.effect('refuses snapshots with no contributed identity before cleanup', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const emptyIdentityMeta = metadata({
					identity: {},
					containers: [
						capturedContainer({
							plugin: 'postgres#0',
							imageName: 'postgres:test',
						}),
					],
				});
				const exit = yield* runRestoreExit(
					root,
					emptyIdentityMeta,
					runtimeIdentity,
					sweepCalls,
				).pipe(Effect.provide(NodeFileSystem.layer));

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(IdentityEmptyError);
					if (error.value instanceof IdentityEmptyError) {
						expect(error.value.source).toBe('snapshot');
					}
				}
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	// -------------------------------------------------------------------------
	// Boot-time / offline restore — NO live participants.
	//
	// The warm-boot hook, the interrupted-restore recovery, and the offline CLI
	// verb all run restore BEFORE the supervisor registers any snapshot
	// participant, so `participants === []`. The bug these pin: a
	// participants-required contribution guard compared `meta.identity` against
	// an empty live slice and ALWAYS failed `IdentityMissingLive`, which
	// silently degraded `--warm` to cold and wedged the interrupted-restore
	// recovery forever. The contract: with no live stack the cross-plugin
	// contribution guard is SKIPPED (vacuously satisfied), but the runtime
	// guard (app/stack/network) and the snapshot-side emptiness refusal STILL
	// fire.
	// -------------------------------------------------------------------------

	it.effect('boot-time restore (no live participants) clears the contribution guard', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const meta = metadata({
					containers: [
						capturedContainer({
							plugin: 'postgres#0',
							imageName: 'postgres:test',
						}),
					],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir);
				// NO participants — the boot-time path. Previously this failed
				// `IdentityMissingLive`; now the contribution guard is skipped and
				// the restore proceeds to the swap + container replacement.
				const exit = yield* runRestoreExit(
					root,
					meta,
					runtimeIdentity,
					sweepCalls,
					runtimeStub(sweepCalls),
					[],
				).pipe(Effect.provide(NodeFileSystem.layer));

				expect(Exit.isSuccess(exit)).toBe(true);
				expect(sweepCalls).toEqual([
					{
						app: runtimeIdentity.app,
						stack: runtimeIdentity.stack,
						plugin: 'postgres#0',
						role: 'db',
					},
				]);
			}),
		),
	);

	it.effect('boot-time restore still refuses a foreign runtime identity', () =>
		Effect.gen(function* () {
			const fields: ReadonlyArray<keyof SnapshotRuntimeIdentity> = ['app', 'stack', 'network'];
			for (const field of fields) {
				yield* withTempRoot(TEMP_PREFIX, (root) =>
					Effect.gen(function* () {
						const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
						const foreignMeta = metadata({
							[field]: `${runtimeIdentity[field]}-foreign`,
							containers: [
								capturedContainer({
									plugin: 'postgres#0',
									imageName: 'postgres:test',
								}),
							],
						});
						// NO participants → contribution guard skipped, but the runtime
						// guard's live side is `runtimeIdentity` (NOT the snapshot), so a
						// foreign app/stack/network is still refused before any mutation.
						const exit = yield* runRestoreExit(
							root,
							foreignMeta,
							runtimeIdentity,
							sweepCalls,
							runtimeStub(sweepCalls),
							[],
						).pipe(Effect.provide(NodeFileSystem.layer));

						expect(Exit.isFailure(exit)).toBe(true);
						const error = Exit.findErrorOption(exit);
						expect(error._tag).toBe('Some');
						if (error._tag === 'Some') {
							expect(error.value).toBeInstanceOf(IdentityMismatchError);
							if (error.value._tag === 'SnapshotIdentityMismatch') {
								expect(error.value.key).toBe(field);
							}
						}
						// Refused before any mutation.
						expect(sweepCalls).toEqual([]);
					}),
				);
			}
		}),
	);

	it.effect('boot-time restore still refuses a snapshot with no recorded identity', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const emptyIdentityMeta = metadata({
					identity: {},
					containers: [
						capturedContainer({
							plugin: 'postgres#0',
							imageName: 'postgres:test',
						}),
					],
				});
				// NO participants, but an empty `meta.identity` is untrusted
				// regardless of a live stack — the snapshot-side emptiness refusal
				// (`requireIdentity`) still fires before any mutation.
				const exit = yield* runRestoreExit(
					root,
					emptyIdentityMeta,
					runtimeIdentity,
					sweepCalls,
					runtimeStub(sweepCalls),
					[],
				).pipe(Effect.provide(NodeFileSystem.layer));

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(IdentityEmptyError);
					if (error.value instanceof IdentityEmptyError) {
						expect(error.value.source).toBe('snapshot');
					}
				}
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	it.effect('scopes restore container replacement to the current app and stack', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const meta = metadata({
					containers: [
						capturedContainer({
							plugin: 'postgres#0',
							imageName: 'postgres:test',
						}),
					],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir);
				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isSuccess(exit)).toBe(true);
				expect(sweepCalls).toEqual([
					{
						app: runtimeIdentity.app,
						stack: runtimeIdentity.stack,
						plugin: 'postgres#0',
						role: 'db',
					},
				]);
			}),
		),
	);

	it.effect('refuses a missing container tar before restore cleanup', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const meta = metadata({
					containers: [
						capturedContainer({
							imageName: 'postgres:test',
						}),
					],
				});
				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('load-image');
					}
				}
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	it.effect('refuses a missing contribution doc before restore cleanup', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const meta = metadata({
					containers: [
						capturedContainer({
							imageName: 'postgres:test',
						}),
					],
					participants: ['postgres'],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir);

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('read-contribution');
					}
				}
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	it.effect('refuses a host-tree tar with traversal entries before extraction', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const meta = metadata({
					hostTreeIncluded: true,
					subtrees: [
						{
							plugin: 'postgres',
							relPath: 'postgres/data',
							missingTolerance: 'fatal',
							secretMaterial: false,
						},
					],
				});
				const artifactDir = writeArtifact(root, meta);
				writeFileSync(
					join(artifactDir, SnapshotLayout.hostTreeTar),
					tarWithSingleEntry('../escape'),
				);

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('untar-host-tree');
					}
				}
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	it.effect('accepts contribution docs for plugin keys containing slashes', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const pluginKey = 'account/alice#0';
				const meta = metadata({ participants: [pluginKey] });
				const artifactDir = writeArtifact(root, meta);
				mkdirSync(join(artifactDir, SnapshotLayout.contributionsDir), { recursive: true });
				writeFileSync(
					join(artifactDir, contributionPath(pluginKey)),
					JSON.stringify({
						version: SNAPSHOT_CONTRIBUTION_VERSION,
						plugin: pluginKey,
						identity: {},
						opaqueState: {
							encoding: 'json',
							value: { account: 'alice' },
						},
					}),
				);

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isSuccess(exit)).toBe(true);
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	it.effect('refuses contribution docs with unknown versions before restore cleanup', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const pluginKey = 'postgres';
				const meta = metadata({ participants: [pluginKey] });
				const artifactDir = writeArtifact(root, meta);
				mkdirSync(join(artifactDir, SnapshotLayout.contributionsDir), { recursive: true });
				writeFileSync(
					join(artifactDir, contributionPath(pluginKey)),
					JSON.stringify({
						version: 999,
						plugin: pluginKey,
						identity: {},
					}),
				);

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('read-contribution');
					}
				}
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	it.effect('refuses corrupt contribution docs before restore cleanup', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const pluginKey = 'postgres';
				const meta = metadata({ participants: [pluginKey] });
				const artifactDir = writeArtifact(root, meta);
				mkdirSync(join(artifactDir, SnapshotLayout.contributionsDir), { recursive: true });
				writeFileSync(join(artifactDir, contributionPath(pluginKey)), '{not json');

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('read-contribution');
					}
				}
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	it.effect('preserves only runtime-control paths and drops plugin-owned + live cache state', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const stackRoot = join(root, 'runtime-stack');
				const walletTokenPath = join(stackRoot, 'wallet', 'token');
				const meta = metadata();
				const artifactDir = writeArtifact(stackRoot, meta);
				writeFileSync(join(stackRoot, COMMAND_CHANNEL_COMMANDS_FILE_NAME), 'command-log\n');
				writeFileSync(join(stackRoot, COMMAND_CHANNEL_EVENTS_FILE_NAME), 'event-log\n');
				writeFileSync(join(stackRoot, 'roster.json'), '{"version":1,"holders":[]}\n');
				mkdirSync(join(stackRoot, 'wallet'), { recursive: true });
				writeFileSync(walletTokenPath, '0123456789abcdef0123456789abcdef');
				writeFileSync(join(stackRoot, 'wallet', 'session'), 'drop');
				// Self-contained snapshots: the deploy cache rides the snapshot's
				// host-tree, NOT preserved-from-live. This snapshot carries NO
				// host-tree (hostTreeIncluded: false), so the swap drops the LIVE
				// cache entirely — including the deploy namespace and the generic
				// per-call `cache/entry`. (When the snapshot DOES carry the cache,
				// the untarred copy lands in staging — see the cross-machine test.)
				const deployNs = DEPLOY_CACHE_NAMESPACES[0]!;
				mkdirSync(join(stackRoot, CACHE_DIR_NAME, deployNs), { recursive: true });
				writeFileSync(join(stackRoot, CACHE_DIR_NAME, deployNs, 'ids.json'), 'deploy-ids');
				writeFileSync(join(stackRoot, CACHE_DIR_NAME, 'entry'), 'cache');
				writeFileSync(join(stackRoot, 'unrelated-runtime-state'), 'drop');
				yield* writeArtifactIntegrity(artifactDir).pipe(Effect.provide(NodeFileSystem.layer));

				const exit = yield* Effect.exit(
					runRestore({
						snapshotId: snapshotIdFromString(meta.id),
						artifactDir,
						runtimeStackRoot: stackRoot,
						runtimeStagingPath: join(root, 'runtime-stack.staging'),
						runtimeBackupPath: join(root, 'runtime-stack.bak'),
						participants: restoreIdentityParticipants(),
						runtime: runtimeStub(sweepCalls),
						runtimeIdentity,
					}),
				).pipe(Effect.provide(NodeFileSystem.layer));

				expect(Exit.isSuccess(exit)).toBe(true);
				expect(readFileSync(join(stackRoot, COMMAND_CHANNEL_COMMANDS_FILE_NAME), 'utf8')).toBe(
					'command-log\n',
				);
				expect(readFileSync(join(stackRoot, COMMAND_CHANNEL_EVENTS_FILE_NAME), 'utf8')).toBe(
					'event-log\n',
				);
				expect(readFileSync(join(stackRoot, 'roster.json'), 'utf8')).toBe(
					'{"version":1,"holders":[]}\n',
				);
				// The LIVE deploy cache is NOT preserved from live — the snapshot is
				// the sole source, and this snapshot carries none, so it is dropped.
				expect(existsSync(join(stackRoot, CACHE_DIR_NAME, deployNs))).toBe(false);
				expect(existsSync(walletTokenPath)).toBe(false);
				expect(existsSync(join(stackRoot, 'wallet', 'session'))).toBe(false);
				expect(existsSync(join(stackRoot, 'snapshots', meta.id, SnapshotLayout.metaFile))).toBe(
					true,
				);
				// The generic per-call cache entry is dropped too.
				expect(existsSync(join(stackRoot, CACHE_DIR_NAME, 'entry'))).toBe(false);
				expect(existsSync(join(stackRoot, 'unrelated-runtime-state'))).toBe(false);
			}),
		),
	);

	// The SNAPSHOT's host-tree cache is the SOLE source of the on-chain ids on
	// restore (self-contained snapshots). If the metadata RECORDS a deploy-cache
	// subtree but the host-tree tar is MISSING it (a partial/corrupt artifact),
	// restore must REFUSE with a typed `cache-missing` error BEFORE any mutation
	// rather than let the next boot re-deploy that namespace with fresh ids and
	// orphan its pre-snapshot objects. Checked against the SNAPSHOT, not the live
	// stack — so a cross-machine restore onto an empty live cache is unaffected.
	it.effect('refuses with cache-missing when the snapshot host-tree omits a recorded cache ns', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const deployNs = DEPLOY_CACHE_NAMESPACES[0]!;
				// Metadata claims the snapshot captured `cache/<ns>`...
				const meta = metadata({
					containers: [capturedContainer()],
					hostTreeIncluded: true,
					subtrees: [
						{
							plugin: '__deploy-cache__',
							relPath: `${CACHE_DIR_NAME}/${deployNs}`,
							missingTolerance: 'fine',
							secretMaterial: false,
						},
					],
				});
				const artifactDir = writeArtifact(join(root, 'runtime-stack'), meta);
				writeImageBundle(artifactDir);
				// ...but the host-tree tar carries an UNRELATED entry, not the cache.
				writeFileSync(
					join(artifactDir, SnapshotLayout.hostTreeTar),
					tarWithEntries(['postgres/data/x']),
				);
				yield* writeArtifactIntegrity(artifactDir).pipe(Effect.provide(NodeFileSystem.layer));

				const exit = yield* Effect.exit(
					runRestore({
						snapshotId: snapshotIdFromString(meta.id),
						artifactDir,
						runtimeStackRoot: join(root, 'runtime-stack'),
						runtimeStagingPath: join(root, 'runtime-stack.staging'),
						runtimeBackupPath: join(root, 'runtime-stack.bak'),
						participants: restoreIdentityParticipants(),
						runtime: runtimeStub(sweepCalls),
						runtimeIdentity,
					}),
				).pipe(Effect.provide(NodeFileSystem.layer));

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('cache-missing');
					}
				}
				// Fail-closed BEFORE any mutation — no container sweep ran.
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	// The positive companion: when the snapshot's host-tree CARRIES every
	// deploy-cache namespace its metadata records, the preflight passes and the
	// snapshot's cache is untarred into the swapped tree (sole source). Mirrors a
	// CROSS-MACHINE restore — the live stack has NO cache; the snapshot supplies
	// the ids.
	it.effect('restores the deploy cache from the snapshot host-tree (cross-machine)', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const stackRoot = join(root, 'runtime-stack');
				const deployNs = DEPLOY_CACHE_NAMESPACES[0]!;
				const cacheRel = `${CACHE_DIR_NAME}/${deployNs}/local/ids.json`;
				const meta = metadata({
					hostTreeIncluded: true,
					subtrees: [
						{
							plugin: '__deploy-cache__',
							relPath: `${CACHE_DIR_NAME}/${deployNs}`,
							missingTolerance: 'fine',
							secretMaterial: false,
						},
					],
				});
				const artifactDir = writeArtifact(stackRoot, meta);
				// Build a REAL host-tree tar (valid checksum so system `tar -x`
				// extracts it) carrying the deploy-cache namespace, mirroring what
				// capture's `tarHostTree` produces.
				const srcDir = join(root, 'host-tree-src');
				mkdirSync(join(srcDir, CACHE_DIR_NAME, deployNs, 'local'), { recursive: true });
				writeFileSync(join(srcDir, cacheRel), 'snapshot-deploy-ids');
				const tarResult = spawnSync(
					'tar',
					['-c', '-f', join(artifactDir, SnapshotLayout.hostTreeTar), '-C', srcDir, '-p', cacheRel],
					{ encoding: 'utf8' },
				);
				expect(tarResult.status, tarResult.stderr).toBe(0);
				// The live stack has NO cache at all — a fresh-runner shape.
				expect(existsSync(join(stackRoot, CACHE_DIR_NAME))).toBe(false);
				yield* writeArtifactIntegrity(artifactDir).pipe(Effect.provide(NodeFileSystem.layer));

				const exit = yield* Effect.exit(
					runRestore({
						snapshotId: snapshotIdFromString(meta.id),
						artifactDir,
						runtimeStackRoot: stackRoot,
						runtimeStagingPath: join(root, 'runtime-stack.staging'),
						runtimeBackupPath: join(root, 'runtime-stack.bak'),
						participants: restoreIdentityParticipants(),
						runtime: runtimeStub(sweepCalls),
						runtimeIdentity,
					}),
				).pipe(Effect.provide(NodeFileSystem.layer));

				expect(Exit.isSuccess(exit)).toBe(true);
				// The cache came from the snapshot, not from any live copy.
				expect(readFileSync(join(stackRoot, cacheRel), 'utf8')).toBe('snapshot-deploy-ids');
			}),
		),
	);

	it.effect('verifies artifact integrity before loading images or replacing containers', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const events: string[] = [];
				const meta = metadata({
					containers: [capturedContainer()],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir);
				const imageTarPath = join(artifactDir, imageBundlePath);
				writeFileSync(imageTarPath, Buffer.from([1, 2, 3]));
				yield* writeArtifactIntegrity(artifactDir).pipe(Effect.provide(NodeFileSystem.layer));
				writeFileSync(imageTarPath, Buffer.from([9, 9, 9]));

				const exit = yield* Effect.exit(
					runRestore({
						snapshotId: snapshotIdFromString(meta.id),
						artifactDir,
						runtimeStackRoot: join(root, 'runtime-stack'),
						runtimeStagingPath: join(root, 'runtime-stack.staging'),
						runtimeBackupPath: join(root, 'runtime-stack.bak'),
						participants: restoreIdentityParticipants(),
						runtime: runtimeStub(sweepCalls, { events }),
						runtimeIdentity,
					}),
				).pipe(Effect.provide(NodeFileSystem.layer));

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('verify-integrity');
					}
				}
				expect(events).toEqual([]);
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	it.live(
		'keeps command and event tails readable after a live restore swap',
		() =>
			withTempRoot(TEMP_PREFIX, (root) =>
				Effect.gen(function* () {
					const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
					const stackRoot = join(root, 'runtime-stack');
					const meta = metadata();
					const artifactDir = writeArtifact(stackRoot, meta);
					seedDeployCacheAt(stackRoot);
					yield* writeArtifactIntegrity(artifactDir).pipe(Effect.provide(NodeFileSystem.layer));
					const paths = commandChannelPaths(stackRoot);
					const preRestorePublisher = yield* makeCommandChannelPublisher(paths);
					const preRestoreSubscriber = yield* makeCommandChannelSubscriber(paths);
					yield* preRestorePublisher.publish({ tag: 'snapshot.restore', snapshotId: meta.id });
					yield* preRestoreSubscriber.publishEvent({ tag: 'before.restore' });

					const publisher = yield* makeCommandChannelPublisher(paths);
					const subscriber = yield* makeCommandChannelSubscriber(paths, {
						fromOffset: 'current',
						pollMillis: 20,
					});
					const commands: CommandRecord[] = [];
					const events: EventRecord[] = [];
					const commandFiber = yield* Effect.forkChild(
						subscriber.commands.pipe(
							Stream.take(1),
							Stream.runForEach((record) =>
								Effect.sync(() => {
									commands.push(record);
								}),
							),
						),
						{ startImmediately: true },
					);
					const eventFiber = yield* Effect.forkChild(
						publisher.events.pipe(
							Stream.take(1),
							Stream.runForEach((record) =>
								Effect.sync(() => {
									events.push(record);
								}),
							),
						),
						{ startImmediately: true },
					);
					yield* Effect.sleep('30 millis');

					const exit = yield* Effect.exit(
						runRestore({
							snapshotId: snapshotIdFromString(meta.id),
							artifactDir,
							runtimeStackRoot: stackRoot,
							runtimeStagingPath: join(root, 'runtime-stack.staging'),
							runtimeBackupPath: join(root, 'runtime-stack.bak'),
							participants: restoreIdentityParticipants(),
							runtime: runtimeStub(sweepCalls),
							runtimeIdentity,
						}),
					).pipe(Effect.provide(NodeFileSystem.layer));
					expect(Exit.isSuccess(exit)).toBe(true);

					yield* publisher.publish({ tag: 'shutdown.requested' });
					yield* subscriber.publishEvent({ tag: 'after.restore' });

					const commandDone = yield* Fiber.await(commandFiber).pipe(
						Effect.timeoutOption('2 seconds'),
					);
					const eventDone = yield* Fiber.await(eventFiber).pipe(Effect.timeoutOption('2 seconds'));
					expect(commandDone._tag).toBe('Some');
					expect(eventDone._tag).toBe('Some');
					expect(commands).toHaveLength(1);
					expect((commands[0]!.command as { tag: string }).tag).toBe('shutdown.requested');
					expect(events).toHaveLength(1);
					expect(events[0]!.kind).toBe('engine');
					if (events[0]!.kind === 'engine') {
						expect((events[0]!.event as { tag: string }).tag).toBe('after.restore');
					}
				}),
			),
		{ timeout: 30_000 },
	);

	it.effect('does not run restore cleanup when docker load fails for a readable image bundle', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const events: string[] = [];
				const meta = metadata({
					containers: [capturedContainer()],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir);
				const runtime = runtimeStub(sweepCalls, {
					events,
					loadError: {
						_tag: 'ContainerRuntimeError',
						reason: 'image-load-failed',
						detail: 'corrupt docker tar',
					},
				});

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls, runtime).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('load-image');
					}
				}
				expect(events).toEqual(['load']);
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	it.effect('streams the full image bundle to docker load when metadata follows layer blobs', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const loadBytes: number[] = [];
				const meta = metadata({
					containers: [capturedContainer()],
				});
				const artifactDir = writeArtifact(root, meta);
				const bundle = dockerSaveBundleTarWithLateMetadata(['devstack-snapshot:postgres-db']);
				mkdirSync(join(artifactDir, SnapshotLayout.containersDir), { recursive: true });
				writeFileSync(join(artifactDir, imageBundlePath), bundle);

				const exit = yield* runRestoreExit(
					root,
					meta,
					runtimeIdentity,
					sweepCalls,
					runtimeStub(sweepCalls, { loadBytes }),
				).pipe(Effect.provide(NodeFileSystem.layer));

				expect(Exit.isSuccess(exit)).toBe(true);
				expect(loadBytes).toHaveLength(bundle.length);
				expect(Buffer.from(loadBytes).includes(Buffer.from('manifest.json'))).toBe(true);
			}),
		),
	);

	it.effect('refuses a Docker save bundle missing metadata snapshot tags before docker load', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const events: string[] = [];
				const meta = metadata({
					containers: [capturedContainer()],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir, ['devstack-snapshot:other']);
				const runtime = runtimeStub(sweepCalls, { events });

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls, runtime).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('load-image');
						expect(error.value.detail).toContain('devstack-snapshot:postgres-db');
					}
				}
				expect(events).toEqual([]);
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	it.effect('refuses unexpected Docker save bundle tags before docker load', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const events: string[] = [];
				const meta = metadata({
					containers: [capturedContainer()],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir, ['devstack-snapshot:postgres-db', 'devstack-snapshot:extra']);
				const runtime = runtimeStub(sweepCalls, { events });

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls, runtime).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('load-image');
						expect(error.value.detail).toContain('devstack-snapshot:extra');
					}
				}
				expect(events).toEqual([]);
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	it.effect('accepts an OCI image layout bundle without legacy Docker manifest', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const events: string[] = [];
				const meta = metadata({
					containers: [capturedContainer()],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir, ['devstack-snapshot:postgres-db'], { format: 'oci-layout' });
				const runtime = runtimeStub(sweepCalls, { events });

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls, runtime).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isSuccess(exit)).toBe(true);
				expect(events[0]).toBe('load');
			}),
		),
	);

	it.effect('refuses OCI image layout bundle tag mismatches before docker load', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const events: string[] = [];
				const meta = metadata({
					containers: [capturedContainer()],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir, ['devstack-snapshot:other'], { format: 'oci-layout' });
				const runtime = runtimeStub(sweepCalls, { events });

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls, runtime).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('load-image');
						expect(error.value.detail).toContain('devstack-snapshot:postgres-db');
					}
				}
				expect(events).toEqual([]);
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	it.effect('refuses duplicate snapshot tags before loading image bundles', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const events: string[] = [];
				const meta = metadata({
					containers: [
						capturedContainer({
							role: 'db',
							imageName: 'devstack-build:postgres-db',
							snapshotTag: 'devstack-snapshot:duplicate',
						}),
						capturedContainer({
							role: 'worker',
							imageName: 'devstack-build:postgres-worker',
							snapshotTag: 'devstack-snapshot:duplicate',
						}),
					],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir);

				const exit = yield* runRestoreExit(
					root,
					meta,
					runtimeIdentity,
					sweepCalls,
					runtimeStub(sweepCalls, { events }),
				).pipe(Effect.provide(NodeFileSystem.layer));

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('preflight');
						expect(error.value.detail).toContain('duplicate container snapshotTag');
					}
				}
				expect(events).toEqual([]);
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	it.effect('cleans restore-staging image refs when a staging tag fails', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const events: string[] = [];
				const removeImageCalls: ImageRef[] = [];
				const imageName = 'devstack-build:postgres-original';
				const meta = metadata({
					containers: [
						capturedContainer({
							imageName,
						}),
					],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir);
				const runtime = runtimeStub(sweepCalls, {
					events,
					removeImageCalls,
					tagError: {
						_tag: 'ContainerRuntimeError',
						reason: 'image-tag-failed',
						detail: 'tag refused',
					},
				});

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls, runtime).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('retag-image');
					}
				}
				expect(events).toHaveLength(3);
				expect(events[0]).toBe('load');
				expect(events[1]?.startsWith('tag:devstack-snapshot:restore-')).toBe(true);
				expect(events[2]).toBe(`remove-image:${events[1]!.slice('tag:'.length)}`);
				expect(removeImageCalls).toEqual([
					{
						digest: 'sha256:loaded-postgres-db',
						tag: events[1]!.slice('tag:'.length),
					},
				]);
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	it.effect('cleans earlier restore-staging refs when a later staging tag fails', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const events: string[] = [];
				const removeImageCalls: ImageRef[] = [];
				let stagingTagAttempts = 0;
				const meta = metadata({
					containers: [
						capturedContainer({
							role: 'db',
							imageName: 'devstack-build:postgres-db',
							snapshotTag: 'devstack-snapshot:postgres-db',
						}),
						capturedContainer({
							role: 'worker',
							imageName: 'devstack-build:postgres-worker',
							snapshotTag: 'devstack-snapshot:postgres-worker',
						}),
					],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir, [
					'devstack-snapshot:postgres-db',
					'devstack-snapshot:postgres-worker',
				]);
				const runtime = runtimeStub(sweepCalls, {
					events,
					removeImageCalls,
					tagErrorFor: (newTag) => {
						if (!newTag.startsWith('devstack-snapshot:restore-')) return undefined;
						stagingTagAttempts += 1;
						return stagingTagAttempts === 2
							? {
									_tag: 'ContainerRuntimeError',
									reason: 'image-tag-failed',
									detail: 'second staging tag refused',
								}
							: undefined;
					},
				});

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls, runtime).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('retag-image');
					}
				}
				const stagingTags = events
					.filter((event) => event.startsWith('tag:devstack-snapshot:restore-'))
					.map((event) => event.slice('tag:'.length));
				expect(stagingTags).toHaveLength(2);
				const removeImageEvents = events.filter((event) => event.startsWith('remove-image:'));
				expect(removeImageEvents).toHaveLength(2);
				expect(removeImageEvents).toEqual(
					expect.arrayContaining([
						`remove-image:${stagingTags[0]}`,
						`remove-image:${stagingTags[1]}`,
					]),
				);
				expect(removeImageCalls).toHaveLength(2);
				expect(removeImageCalls).toEqual(
					expect.arrayContaining([
						{
							digest: 'sha256:loaded-postgres-db',
							tag: stagingTags[0],
						},
						{
							digest: 'sha256:loaded-postgres-worker',
							tag: stagingTags[1],
						},
					]),
				);
				expect(events).not.toContain('tag:devstack-build:postgres-db');
				expect(events).not.toContain('tag:devstack-build:postgres-worker');
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	it.effect('does not replace containers when filesystem publish fails after image staging', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const events: string[] = [];
				const removeImageCalls: ImageRef[] = [];
				const stackRoot = join(root, 'runtime-stack');
				const backupPath = join(root, 'runtime-stack.bak');
				const imageName = 'devstack-build:postgres-original';
				const meta = metadata({
					containers: [
						capturedContainer({
							imageName,
						}),
					],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir);
				yield* writeArtifactIntegrity(artifactDir).pipe(Effect.provide(NodeFileSystem.layer));
				mkdirSync(stackRoot, { recursive: true });
				seedDeployCacheAt(stackRoot);
				writeFileSync(join(stackRoot, 'live-state'), 'old');
				mkdirSync(backupPath, { recursive: true });
				writeFileSync(join(backupPath, 'blocks-backup-rename'), 'occupied');

				const exit = yield* Effect.exit(
					runRestore({
						snapshotId: snapshotIdFromString(meta.id),
						artifactDir,
						runtimeStackRoot: stackRoot,
						runtimeStagingPath: join(root, 'runtime-stack.staging'),
						runtimeBackupPath: backupPath,
						participants: restoreIdentityParticipants(),
						runtime: runtimeStub(sweepCalls, { events, removeImageCalls }),
						runtimeIdentity,
					}),
				).pipe(Effect.provide(NodeFileSystem.layer));

				expect(Exit.isFailure(exit)).toBe(true);
				expect(events).toHaveLength(3);
				expect(events[0]).toBe('load');
				expect(events[1]?.startsWith('tag:devstack-snapshot:restore-')).toBe(true);
				expect(events[2]).toBe(`remove-image:${events[1]!.slice('tag:'.length)}`);
				expect(removeImageCalls).toEqual([
					{
						digest: 'sha256:loaded-postgres-db',
						tag: events[1]!.slice('tag:'.length),
					},
				]);
				expect(events).not.toContain(`tag:${imageName}`);
				expect(sweepCalls).toEqual([]);
				expect(readFileSync(join(stackRoot, 'live-state'), 'utf8')).toBe('old');
			}),
		),
	);

	it.effect(
		'fails loud and writes no recovery marker when post-publish image promotion fails',
		() =>
			withTempRoot(TEMP_PREFIX, (root) =>
				Effect.gen(function* () {
					const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
					const events: string[] = [];
					const stackRoot = join(root, 'runtime-stack');
					const imageName = 'devstack-build:postgres-original';
					const meta = metadata({
						containers: [
							capturedContainer({
								imageName,
							}),
						],
					});
					const artifactDir = writeArtifact(root, meta);
					writeImageBundle(artifactDir);
					const finalTagError: ContainerRuntimeError = {
						_tag: 'ContainerRuntimeError',
						reason: 'image-tag-failed',
						detail: 'final tag refused',
					};
					const runtime = runtimeStub(sweepCalls, {
						events,
						tagErrorFor: (newTag) => (newTag === imageName ? finalTagError : undefined),
					});

					const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls, runtime).pipe(
						Effect.provide(NodeFileSystem.layer),
					);

					expect(Exit.isFailure(exit)).toBe(true);
					const error = Exit.findErrorOption(exit);
					expect(error._tag).toBe('Some');
					if (error._tag === 'Some') {
						expect(error.value).toBeInstanceOf(RestorePhaseError);
						if (error.value._tag === 'SnapshotRestorePhaseError') {
							expect(error.value.phase).toBe('retag-image');
						}
					}
					// Promotion re-tags the staged image to its TARGET name —
					// the resumption contract is carried by the image name
					// itself (the next boot's image-match adoption finds it
					// locally), NOT by an on-disk marker. load → tag staging →
					// tag target (fails) → finalizer removes the staging tag so
					// Docker is not littered with orphan restore-* refs.
					expect(events).toHaveLength(4);
					expect(events[0]).toBe('load');
					expect(events[1]?.startsWith('tag:devstack-snapshot:restore-')).toBe(true);
					expect(events[2]).toBe(`tag:${imageName}`);
					const stagingTag = events[1]!.slice('tag:'.length);
					expect(events[3]).toBe(`remove-image:${stagingTag}`);
					expect(sweepCalls).toEqual([]);
					// No crash-recovery marker is ever written — the subsystem
					// was deleted in Stage D2.
					expect(existsSync(join(stackRoot, 'snapshot.restore-pending.json'))).toBe(false);
				}),
			),
	);

	it.effect('clears orphan staging tags and writes no marker when mid-promote fails', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const events: string[] = [];
				const removeImageCalls: ImageRef[] = [];
				const stackRoot = join(root, 'runtime-stack');
				const dbImageName = 'devstack-build:postgres-db';
				const workerImageName = 'devstack-build:postgres-worker';
				const meta = metadata({
					containers: [
						capturedContainer({
							role: 'db',
							imageName: dbImageName,
							snapshotTag: 'devstack-snapshot:postgres-db',
						}),
						capturedContainer({
							role: 'worker',
							imageName: workerImageName,
							snapshotTag: 'devstack-snapshot:postgres-worker',
						}),
					],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir, [
					'devstack-snapshot:postgres-db',
					'devstack-snapshot:postgres-worker',
				]);
				// Promotion runs in metadata order; fail the SECOND
				// promotion (worker → workerImageName) so the first image
				// has already been promoted (and its staging tag removed
				// via removeSourceAfterTag inside the docker runtime),
				// while the second image's staging tag is still live and
				// must be cleaned by the scope finalizer.
				const runtime = runtimeStub(sweepCalls, {
					events,
					removeImageCalls,
					tagErrorFor: (newTag) =>
						newTag === workerImageName
							? {
									_tag: 'ContainerRuntimeError',
									reason: 'image-tag-failed',
									detail: 'second promotion refused',
								}
							: undefined,
				});

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls, runtime).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('retag-image');
						expect(error.value.plugin).toBe('postgres');
					}
				}

				// No crash-recovery marker is written — the subsystem was
				// deleted in Stage D2. The first image (`db`) was already
				// promoted to its TARGET name before `worker` failed, so on a
				// re-run of restore the next boot's image-match adoption picks
				// up whatever landed; there is no on-disk breadcrumb to parse.
				expect(existsSync(join(stackRoot, 'snapshot.restore-pending.json'))).toBe(false);

				// Container removal never runs once promotion fails.
				expect(sweepCalls).toEqual([]);

				// Staging tag bookkeeping: both staging refs were minted
				// during stage; promotion of db succeeded (and the docker
				// runtime would drop its staging tag via
				// removeSourceAfterTag — the stub doesn't model that, but
				// the finalizer's removeImage warning path tolerates a
				// missing ref). The finalizer MUST call removeImage on
				// every staged ref so no orphan devstack-snapshot:restore-*
				// tags survive scope close.
				const stagingTagEvents = events
					.filter((event) => event.startsWith('tag:devstack-snapshot:restore-'))
					.map((event) => event.slice('tag:'.length));
				expect(stagingTagEvents).toHaveLength(2);

				const promotionEvents = events.filter(
					(event) => event === `tag:${dbImageName}` || event === `tag:${workerImageName}`,
				);
				expect(promotionEvents).toEqual([`tag:${dbImageName}`, `tag:${workerImageName}`]);

				const removeImageEvents = events.filter((event) => event.startsWith('remove-image:'));
				expect(removeImageEvents).toHaveLength(2);
				expect(removeImageEvents).toEqual(
					expect.arrayContaining([
						`remove-image:${stagingTagEvents[0]}`,
						`remove-image:${stagingTagEvents[1]}`,
					]),
				);
				expect(removeImageCalls).toHaveLength(2);
				expect(removeImageCalls).toEqual(
					expect.arrayContaining(
						stagingTagEvents.map((tag) => ({
							digest: expect.stringMatching(/^sha256:/) as unknown as string,
							tag,
						})),
					),
				);
			}),
		),
	);

	it.effect('does not run restore cleanup when host-tree expansion fails', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const events: string[] = [];
				const imageName = 'devstack-build:postgres-original';
				const meta = metadata({
					hostTreeIncluded: true,
					subtrees: [
						{
							plugin: 'postgres',
							relPath: 'postgres/data',
							missingTolerance: 'fatal',
							secretMaterial: false,
						},
					],
					containers: [
						capturedContainer({
							imageName,
						}),
					],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir);
				writeFileSync(join(artifactDir, SnapshotLayout.hostTreeTar), Buffer.from('not-a-tar'));
				const runtime = runtimeStub(sweepCalls, { events });

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls, runtime).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('untar-host-tree');
					}
				}
				expect(events).toEqual([]);
				expect(sweepCalls).toEqual([]);
			}),
		),
	);

	it.effect(
		'loads the saved image bundle and tags the recorded snapshot image under the original ref',
		() =>
			withTempRoot(TEMP_PREFIX, (root) =>
				Effect.gen(function* () {
					const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
					const loadBytes: number[] = [];
					const tagCalls: Array<{
						readonly src: ImageRef;
						readonly newTag: string;
						readonly opts: TagImageOptions | undefined;
					}> = [];
					const events: string[] = [];
					const meta = metadata({
						containers: [
							capturedContainer({
								imageName: 'devstack-build:postgres-original',
							}),
						],
					});
					const artifactDir = writeArtifact(root, meta);
					writeImageBundle(artifactDir);
					const runtime = runtimeStub(sweepCalls, {
						loadBytes,
						tagCalls,
						events,
					});

					const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls, runtime).pipe(
						Effect.provide(NodeFileSystem.layer),
					);

					expect(Exit.isSuccess(exit)).toBe(true);
					if (!Exit.isSuccess(exit)) return;
					expect(events).toHaveLength(4);
					expect(events[0]).toBe('load');
					expect(events[1]?.startsWith('tag:devstack-snapshot:restore-')).toBe(true);
					expect(events[2]).toBe('tag:devstack-build:postgres-original');
					expect(events[3]).toBe('remove:postgres/db');
					expect(sweepCalls).toEqual([
						{
							app: runtimeIdentity.app,
							stack: runtimeIdentity.stack,
							plugin: 'postgres',
							role: 'db',
						},
					]);
					expect(loadBytes.length).toBeGreaterThan(0);
					expect(Buffer.from(loadBytes).toString('utf8')).toContain('manifest.json');
					expect(tagCalls).toEqual([
						{
							src: {
								digest: 'sha256:loaded-postgres-db',
								tag: 'devstack-snapshot:postgres-db',
							},
							newTag: events[1]!.slice('tag:'.length),
							opts: { removeSourceAfterTag: true },
						},
						{
							src: {
								digest: 'sha256:loaded-postgres-db',
								tag: events[1]!.slice('tag:'.length),
							},
							newTag: 'devstack-build:postgres-original',
							opts: { removeSourceAfterTag: true },
						},
					]);
				}),
			),
	);

	it.effect('loads a shared image bundle once for multiple captured containers', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const events: string[] = [];
				const meta = metadata({
					containers: [
						capturedContainer({
							role: 'db',
							imageName: 'devstack-build:postgres-db',
							snapshotTag: 'devstack-snapshot:postgres-db',
						}),
						capturedContainer({
							role: 'worker',
							imageName: 'devstack-build:postgres-worker',
							snapshotTag: 'devstack-snapshot:postgres-worker',
						}),
					],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir, [
					'devstack-snapshot:postgres-db',
					'devstack-snapshot:postgres-worker',
				]);
				const exit = yield* runRestoreExit(
					root,
					meta,
					runtimeIdentity,
					sweepCalls,
					runtimeStub(sweepCalls, { events }),
				).pipe(Effect.provide(NodeFileSystem.layer));

				expect(Exit.isSuccess(exit)).toBe(true);
				expect(events.filter((event) => event === 'load')).toHaveLength(1);
				expect(
					events.filter((event) => event.startsWith('tag:devstack-snapshot:restore-')),
				).toHaveLength(2);
				expect(events).toContain('tag:devstack-build:postgres-db');
				expect(events).toContain('tag:devstack-build:postgres-worker');
				expect(sweepCalls).toEqual([
					{
						app: runtimeIdentity.app,
						stack: runtimeIdentity.stack,
						plugin: 'postgres',
						role: 'db',
					},
					{
						app: runtimeIdentity.app,
						stack: runtimeIdentity.stack,
						plugin: 'postgres',
						role: 'worker',
					},
				]);
			}),
		),
	);

	// -------------------------------------------------------------------------
	// Promote-time image GC — drop the layer the captured imageName resolved to
	// BEFORE the promote retag (its superseded prior restore/capture layer).
	// `promoteStagedImages` retags `image.captured.imageName` onto the freshly-
	// staged layer; the layer the name USED to resolve to is then orphaned and
	// would dangle forever. Mirrors capture's `resumeAfterCapture` GC: inspect
	// old → promote → inspect new → best-effort remove old IFF non-null + !=new.
	// -------------------------------------------------------------------------

	it.effect('restore promote removes the superseded layer at the captured imageName', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const events: string[] = [];
				const removeImageCalls: ImageRef[] = [];
				const imageName = 'devstack-build:postgres-original';
				const meta = metadata({
					containers: [capturedContainer({ imageName })],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir);
				// imageName resolved to an OLD layer before promote; resolves to a
				// distinct NEW layer after. The old layer is the orphan to GC.
				const runtime = runtimeStub(sweepCalls, {
					events,
					removeImageCalls,
					inspectDigestsFor: new Map([
						[imageName, ['sha256:old-layer', 'sha256:new-layer']],
					]),
				});

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls, runtime).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isSuccess(exit)).toBe(true);
				// The superseded old layer is removed exactly once, by digest-only
				// ref (drops the orphan layer, never the live imageName tag).
				const gcRemovals = removeImageCalls.filter(
					(ref) => ref.tag === undefined && ref.digest === 'sha256:old-layer',
				);
				expect(gcRemovals).toEqual([{ digest: 'sha256:old-layer' }]);
				// Ordering: the GC removal runs strictly AFTER the promote retag.
				const promoteIdx = events.indexOf(`tag:${imageName}`);
				const gcIdx = events.indexOf('remove-image:sha256:old-layer');
				expect(promoteIdx).toBeGreaterThanOrEqual(0);
				expect(gcIdx).toBeGreaterThan(promoteIdx);
				// Restore still completes — containers swept.
				expect(sweepCalls).toEqual([
					{
						app: runtimeIdentity.app,
						stack: runtimeIdentity.stack,
						plugin: 'postgres',
						role: 'db',
					},
				]);
			}),
		),
	);

	it.effect('restore promote does not remove an identical (unchanged) layer', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const events: string[] = [];
				const removeImageCalls: ImageRef[] = [];
				const imageName = 'devstack-build:postgres-original';
				const meta = metadata({
					containers: [capturedContainer({ imageName })],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir);
				// Old digest === new digest: the staged layer is byte-identical, so
				// imageName still resolves to it after the promote. Removing the
				// "old" digest would delete the LIVE layer — the equal-digest guard
				// must skip it. (A null first read is also a no-GC case, covered by
				// the default stub in every other passing test.)
				const runtime = runtimeStub(sweepCalls, {
					events,
					removeImageCalls,
					inspectDigestsFor: new Map([
						[imageName, ['sha256:same-layer', 'sha256:same-layer']],
					]),
				});

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls, runtime).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isSuccess(exit)).toBe(true);
				// No GC removal of the captured layer digest.
				expect(removeImageCalls.some((ref) => ref.digest === 'sha256:same-layer')).toBe(false);
				expect(events).not.toContain('remove-image:sha256:same-layer');
			}),
		),
	);

	it.effect('restore promote GC failure is swallowed and does not fail the restore', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const events: string[] = [];
				const removeImageCalls: ImageRef[] = [];
				const imageName = 'devstack-build:postgres-original';
				const meta = metadata({
					containers: [capturedContainer({ imageName })],
				});
				const artifactDir = writeArtifact(root, meta);
				writeImageBundle(artifactDir);
				// The orphan digest is distinct (GC fires), but removeImage REFUSES
				// for that digest. The best-effort catch must log+swallow so the
				// restore still succeeds and the container sweep still runs.
				const runtime = runtimeStub(sweepCalls, {
					events,
					removeImageCalls,
					inspectDigestsFor: new Map([
						[imageName, ['sha256:old-layer', 'sha256:new-layer']],
					]),
					removeImageErrorFor: (ref) =>
						ref.digest === 'sha256:old-layer' && ref.tag === undefined
							? {
									_tag: 'ContainerRuntimeError',
									reason: 'image-remove-failed',
									detail: 'image in use',
								}
							: undefined,
				});

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls, runtime).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				// Restore SUCCEEDS despite the GC removal failing.
				expect(Exit.isSuccess(exit)).toBe(true);
				// The GC removal WAS attempted (then swallowed).
				expect(
					removeImageCalls.some(
						(ref) => ref.tag === undefined && ref.digest === 'sha256:old-layer',
					),
				).toBe(true);
				// And the container sweep — which runs AFTER promotion — still ran.
				expect(sweepCalls).toEqual([
					{
						app: runtimeIdentity.app,
						stack: runtimeIdentity.stack,
						plugin: 'postgres',
						role: 'db',
					},
				]);
			}),
		),
	);
});
