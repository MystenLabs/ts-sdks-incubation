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
	IdentityEmptyError,
	IdentityMismatchError,
	RESTORE_PENDING_FILE_NAME,
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
		readonly events?: Array<string>;
	} = {},
): ContainerRuntime => ({
	ensureImage: () => Effect.die('ensureImage not used'),
	ensureNetwork: () => Effect.die('ensureNetwork not used'),
	ensureContainer: () => Effect.die('ensureContainer not used'),
	exec: () => Effect.die('exec not used'),
	runOneShot: () => Effect.die('runOneShot not used'),
	inspectByLabels: () => Effect.die('inspectByLabels not used'),
	followLogs: () => Stream.empty,
	pause: () => Effect.die('pause not used'),
	pauseAndCommit: () => Effect.die('pauseAndCommit not used'),
	saveImage: () => Stream.empty,
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
		Effect.sync(() => {
			opts.events?.push(`remove-image:${ref.tag ?? ref.digest}`);
			opts.removeImageCalls?.push(ref);
		}),
	unpause: () => Effect.die('unpause not used'),
	stop: () => Effect.die('stop not used'),
	sweepOrphans: () => Effect.die('sweepOrphans not used'),
	removeManagedContainers: (labelMatch) =>
		Effect.sync(() => {
			opts.events?.push(`remove:${labelMatch.plugin}/${labelMatch.role}`);
			sweepCalls.push(labelMatch);
			return 1;
		}),
	removeManagedImages: () => Effect.die('removeManagedImages not used'),
	removeManagedNetworks: () => Effect.die('removeManagedNetworks not used'),
	removeManagedVolumes: () => Effect.die('removeManagedVolumes not used'),
});

const runRestoreExit = (
	root: string,
	meta: SnapshotMetadata,
	identity: SnapshotRuntimeIdentity,
	sweepCalls: Array<Partial<ContainerLabelTuple>>,
	runtime: ContainerRuntime = runtimeStub(sweepCalls),
) =>
	Effect.gen(function* () {
		const artifactDir = writeArtifact(root, meta);
		yield* writeArtifactIntegrity(artifactDir);
		return yield* Effect.exit(
			runRestore({
				snapshotId: snapshotIdFromString(meta.id),
				artifactDir,
				runtimeStackRoot: join(root, 'runtime-stack'),
				runtimeStagingPath: join(root, 'runtime-stack.staging'),
				runtimeBackupPath: join(root, 'runtime-stack.bak'),
				participants: restoreIdentityParticipants(),
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

	it.effect('refuses snapshot state docs with unknown versions before restore cleanup', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const meta = metadata();
				const artifactDir = writeArtifact(root, meta);
				writeFileSync(
					join(artifactDir, SnapshotLayout.stateFile),
					JSON.stringify({ version: 999, plugins: {} }),
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
						expect(error.value.phase).toBe('read-state');
					}
				}
				expect(sweepCalls).toEqual([]);
				expect(existsSync(join(root, 'runtime-stack'))).toBe(false);
			}),
		),
	);

	it.effect('refuses corrupt snapshot state docs before restore cleanup', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const sweepCalls: Array<Partial<ContainerLabelTuple>> = [];
				const meta = metadata();
				const artifactDir = writeArtifact(root, meta);
				writeFileSync(join(artifactDir, SnapshotLayout.stateFile), '{not json');

				const exit = yield* runRestoreExit(root, meta, runtimeIdentity, sweepCalls).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePhaseError);
					if (error.value._tag === 'SnapshotRestorePhaseError') {
						expect(error.value.phase).toBe('read-state');
					}
				}
				expect(sweepCalls).toEqual([]);
				expect(existsSync(join(root, 'runtime-stack'))).toBe(false);
			}),
		),
	);

	it.effect('preserves only runtime-control paths and drops plugin-owned wallet state', () =>
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
				writeFileSync(join(stackRoot, 'container-claims.json'), '{"version":1,"claims":[]}\n');
				writeFileSync(join(stackRoot, 'snapshot.reservation'), '{"creatorPid":1}\n');
				mkdirSync(join(stackRoot, 'wallet'), { recursive: true });
				writeFileSync(walletTokenPath, '0123456789abcdef0123456789abcdef');
				writeFileSync(join(stackRoot, 'wallet', 'session'), 'drop');
				mkdirSync(join(stackRoot, 'cache'), { recursive: true });
				writeFileSync(join(stackRoot, 'cache', 'entry'), 'cache');
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
				expect(readFileSync(join(stackRoot, 'container-claims.json'), 'utf8')).toBe(
					'{"version":1,"claims":[]}\n',
				);
				expect(readFileSync(join(stackRoot, 'snapshot.reservation'), 'utf8')).toBe(
					'{"creatorPid":1}\n',
				);
				expect(existsSync(walletTokenPath)).toBe(false);
				expect(existsSync(join(stackRoot, 'wallet', 'session'))).toBe(false);
				expect(existsSync(join(stackRoot, 'snapshots', meta.id, SnapshotLayout.metaFile))).toBe(
					true,
				);
				expect(existsSync(join(stackRoot, 'cache', 'entry'))).toBe(false);
				expect(existsSync(join(stackRoot, 'unrelated-runtime-state'))).toBe(false);
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
				mkdirSync(stackRoot, { recursive: true });
				writeFileSync(join(stackRoot, 'live-state'), 'old');
				mkdirSync(backupPath, { recursive: true });
				writeFileSync(join(backupPath, 'blocks-backup-rename'), 'occupied');
				yield* writeArtifactIntegrity(artifactDir).pipe(Effect.provide(NodeFileSystem.layer));

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
				expect(existsSync(join(stackRoot, RESTORE_PENDING_FILE_NAME))).toBe(false);
			}),
		),
	);

	it.effect('leaves a restore-pending marker when post-publish image promotion fails', () =>
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
				// load → tag staging → tag target (fails) → finalizer
				// removes the staging tag so Docker is not littered with
				// orphan restore-* refs.
				expect(events).toHaveLength(4);
				expect(events[0]).toBe('load');
				expect(events[1]?.startsWith('tag:devstack-snapshot:restore-')).toBe(true);
				expect(events[2]).toBe(`tag:${imageName}`);
				const stagingTag = events[1]!.slice('tag:'.length);
				expect(events[3]).toBe(`remove-image:${stagingTag}`);
				expect(sweepCalls).toEqual([]);
				const pending = JSON.parse(
					readFileSync(join(stackRoot, RESTORE_PENDING_FILE_NAME), 'utf8'),
				) as {
					readonly version: number;
					readonly snapshotId: string;
					readonly containers: ReadonlyArray<{
						readonly plugin: string;
						readonly role: string;
						readonly targetImageName: string;
						readonly stagedImageTag: string;
						readonly digest: string;
					}>;
				};
				expect(pending.version).toBe(2);
				expect(pending.snapshotId).toBe(meta.id);
				expect(pending.containers).toEqual([
					{
						plugin: 'postgres',
						role: 'db',
						targetImageName: imageName,
						stagedImageTag: stagingTag,
						digest: 'sha256:loaded-postgres-db',
					},
				]);
			}),
		),
	);

	it.effect('keeps pending marker and clears orphan staging tags when mid-promote fails', () =>
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

				// Re-supervise breadcrumb: the swapped tree still carries
				// the pending marker (we never reached clearRestorePendingMarker).
				// `promoteStagedImages` rewrites the marker after each
				// successful tag so the post-failure marker carries ONLY
				// the still-pending entries — `db` was tagged successfully,
				// `worker` failed, so only `worker` should remain pending.
				// The next supervise calls `recoverPendingRestore` which
				// only has to retry `worker`.
				const pending = JSON.parse(
					readFileSync(join(stackRoot, RESTORE_PENDING_FILE_NAME), 'utf8'),
				) as {
					readonly version: number;
					readonly snapshotId: string;
					readonly containers: ReadonlyArray<{
						readonly plugin: string;
						readonly role: string;
						readonly targetImageName: string;
						readonly stagedImageTag: string;
						readonly digest: string;
					}>;
				};
				expect(pending.version).toBe(2);
				expect(pending.snapshotId).toBe(meta.id);
				expect(pending.containers).toHaveLength(1);
				expect(pending.containers[0]?.role).toBe('worker');
				expect(pending.containers[0]?.targetImageName).toBe(workerImageName);
				expect(pending.containers[0]?.digest).toBe('sha256:loaded-postgres-worker');

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
					expect(existsSync(join(root, 'runtime-stack', RESTORE_PENDING_FILE_NAME))).toBe(false);
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
});
