import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, Exit, Stream } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type {
	ContainerHandle,
	ContainerRuntime,
	ContainerRuntimeError,
	ImageRef,
} from '../../../src/contracts/container-runtime.ts';
import type { ContainerLabelTuple } from '../../../src/contracts/snapshotable.ts';
import {
	CapturePhaseError,
	IdentityEmptyError,
	SnapshotLayout,
	SNAPSHOT_CONTRIBUTION_VERSION,
	containerImagesBundlePath,
	contributionPath,
	runCapture,
	snapshotIdFromString,
	type SnapshotCaptureProgress,
	type SnapshotParticipant,
} from '../../../src/orchestrators/snapshot/index.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';
import {
	dockerSaveBundleTar,
	dockerSaveBundleTarWithLateMetadata,
	tarEntry,
} from './image-bundle-fixtures.ts';

const TEMP_PREFIX = 'snapshot-capture-test';
const imageBundlePath = containerImagesBundlePath();

const label = (role: string): ContainerLabelTuple => ({
	app: 'capture-app',
	stack: 'main',
	plugin: 'sui',
	role,
});

const participant = (
	roles: ReadonlyArray<string>,
	labelForRole: (role: string) => ContainerLabelTuple = label,
): SnapshotParticipant => ({
	plugin: 'sui#0',
	decl: {
		kind: 'snapshotable',
		subtrees: [],
		managedContainers: roles.map(labelForRole),
		missingTolerance: 'fine',
	},
	captureIdentity: Effect.succeed({ chain: 'sui:local' }),
	captureContribution: Effect.succeed({ ok: true }),
});

it.effect('refuses to write a capture artifact with empty contributed identity', () =>
	withTempRoot(TEMP_PREFIX, (root) =>
		Effect.gen(function* () {
			const runtime = runtimeStub({
				handlesByRole: {},
				saveImage: () => Stream.empty,
				pauseCalls: [],
				saveCalls: [],
				unpauseCalls: [],
			});
			const emptyIdentityParticipant: SnapshotParticipant = {
				...participant([]),
				captureIdentity: Effect.succeed({}),
			};
			const exit = yield* runCaptureExit(root, runtime, [emptyIdentityParticipant]).pipe(
				Effect.provide(NodeFileSystem.layer),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			const error = Exit.findErrorOption(exit);
			expect(error._tag).toBe('Some');
			if (error._tag === 'Some') {
				expect(error.value).toBeInstanceOf(IdentityEmptyError);
			}
			expect(existsSync(join(root, 'artifact', SnapshotLayout.metaFile))).toBe(false);
		}),
	),
);

const runtimeStub = (opts: {
	readonly handlesByRole: Readonly<
		Record<string, ContainerHandle | ReadonlyArray<ContainerHandle>>
	>;
	readonly saveImage: (ref: ImageRef) => Stream.Stream<Uint8Array, ContainerRuntimeError>;
	readonly saveImages?: (
		refs: ReadonlyArray<ImageRef>,
	) => Stream.Stream<Uint8Array, ContainerRuntimeError>;
	readonly pauseCalls: Array<string>;
	readonly saveCalls: Array<ImageRef>;
	readonly removeImageCalls?: Array<ImageRef>;
	readonly unpauseCalls: Array<string>;
	readonly commitErrorFor?: (handle: ContainerHandle) => ContainerRuntimeError | undefined;
	readonly committedRefFor?: (handle: ContainerHandle) => ImageRef & { readonly tag: string };
}): ContainerRuntime => ({
	ensureImage: () => Effect.die('ensureImage not used'),
	ensureNetwork: () => Effect.die('ensureNetwork not used'),
	ensureContainer: () => Effect.die('ensureContainer not used'),
	exec: () => Effect.die('exec not used'),
	runOneShot: () => Effect.die('runOneShot not used'),
	inspectByLabels: (labels) => {
		const matched = opts.handlesByRole[labels.role]!;
		return Effect.succeed(Array.isArray(matched) ? matched : [matched]);
	},
	followLogs: () => Stream.empty,
	pause: (handle) =>
		Effect.sync(() => {
			opts.pauseCalls.push(handle.name);
		}),
	pauseAndCommit: (handle) =>
		Effect.gen(function* () {
			const error = opts.commitErrorFor?.(handle);
			if (error !== undefined) {
				return yield* Effect.fail(error);
			}
			return (
				opts.committedRefFor?.(handle) ?? {
					digest: `sha256:${handle.name}`,
					tag: `snapshot:${handle.name}`,
				}
			);
		}),
	saveImage: (ref) => {
		opts.saveCalls.push(ref);
		return opts.saveImage(ref);
	},
	saveImages: (refs) => {
		opts.saveCalls.push(...refs);
		return (
			opts.saveImages?.(refs) ??
			Stream.make(dockerSaveBundleTar(refs.map((ref) => ref.tag ?? ref.digest)))
		);
	},
	loadImage: () => Effect.die('loadImage not used'),
	tagImage: () => Effect.die('tagImage not used'),
	removeImage: (ref) =>
		Effect.sync(() => {
			opts.removeImageCalls?.push(ref);
		}),
	unpause: (handle) =>
		Effect.sync(() => {
			opts.unpauseCalls.push(handle.name);
		}),
	stop: () => Effect.die('stop not used'),
	sweepOrphans: () => Effect.die('sweepOrphans not used'),
	removeManagedContainers: () => Effect.die('removeManagedContainers not used'),
	removeManagedImages: () => Effect.die('removeManagedImages not used'),
	removeManagedNetworks: () => Effect.die('removeManagedNetworks not used'),
	removeManagedVolumes: () => Effect.die('removeManagedVolumes not used'),
});

const runCaptureExit = (
	root: string,
	runtime: ContainerRuntime,
	participants: ReadonlyArray<SnapshotParticipant>,
	labelValue: string | null = null,
	onProgress?: (progress: SnapshotCaptureProgress) => Effect.Effect<void>,
) =>
	Effect.exit(
		runCapture({
			stagingDir: join(root, 'artifact'),
			snapshotId: snapshotIdFromString('snap-images'),
			label: labelValue,
			app: 'capture-app',
			stack: 'main',
			network: 'sui:local',
			runtimeStackRoot: join(root, 'runtime-stack'),
			participants,
			runtime,
			onProgress,
		}),
	);

it.effect('captures an already-paused container without unpausing it afterwards', () =>
	withTempRoot(TEMP_PREFIX, (root) =>
		Effect.gen(function* () {
			const pauseCalls: string[] = [];
			const saveCalls: ImageRef[] = [];
			const removeImageCalls: ImageRef[] = [];
			const unpauseCalls: string[] = [];
			const runtime = runtimeStub({
				handlesByRole: {
					validator: {
						id: 'validator-id',
						name: 'validator-container',
						imageName: 'devstack-build:sui-validator',
						status: 'paused',
						ips: [],
					},
				},
				saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
				pauseCalls,
				saveCalls,
				removeImageCalls,
				unpauseCalls,
			});

			mkdirSync(join(root, 'artifact'), { recursive: true });
			const exit = yield* runCaptureExit(root, runtime, [participant(['validator'])]).pipe(
				Effect.provide(NodeFileSystem.layer),
			);

			expect(Exit.isSuccess(exit)).toBe(true);
			if (!Exit.isSuccess(exit)) return;
			expect(exit.value.label).toBe(null);
			expect(saveCalls.map((ref) => ref.tag)).toEqual(['snapshot:validator-container']);
			expect(unpauseCalls).toEqual([]);
		}),
	),
);

it.effect('records user-facing labels in metadata without using them as artifact paths', () =>
	withTempRoot(TEMP_PREFIX, (root) =>
		Effect.gen(function* () {
			const pauseCalls: string[] = [];
			const saveCalls: ImageRef[] = [];
			const unpauseCalls: string[] = [];
			const runtime = runtimeStub({
				handlesByRole: {},
				saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
				pauseCalls,
				saveCalls,
				unpauseCalls,
			});

			mkdirSync(join(root, 'artifact'), { recursive: true });
			const exit = yield* runCaptureExit(
				root,
				runtime,
				[participant([])],
				'release candidate',
			).pipe(Effect.provide(NodeFileSystem.layer));

			expect(Exit.isSuccess(exit)).toBe(true);
			if (!Exit.isSuccess(exit)) return;
			expect(exit.value.id).toBe('snap-images');
			expect(exit.value.label).toBe('release candidate');
			expect(existsSync(join(root, 'artifact', 'release candidate'))).toBe(false);
		}),
	),
);

it.effect('captures exited and created containers instead of silently omitting them', () =>
	withTempRoot(TEMP_PREFIX, (root) =>
		Effect.gen(function* () {
			const pauseCalls: string[] = [];
			const saveCalls: ImageRef[] = [];
			const unpauseCalls: string[] = [];
			const runtime = runtimeStub({
				handlesByRole: {
					db: {
						id: 'db-id',
						name: 'db-container',
						imageName: 'devstack-build:db',
						status: 'exited',
						ips: [],
					},
					worker: {
						id: 'worker-id',
						name: 'worker-container',
						imageName: 'devstack-build:worker',
						status: 'created',
						ips: [],
					},
				},
				saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
				pauseCalls,
				saveCalls,
				unpauseCalls,
			});

			mkdirSync(join(root, 'artifact'), { recursive: true });
			const exit = yield* runCaptureExit(root, runtime, [participant(['db', 'worker'])]).pipe(
				Effect.provide(NodeFileSystem.layer),
			);

			expect(Exit.isSuccess(exit)).toBe(true);
			if (!Exit.isSuccess(exit)) return;
			expect(exit.value.containers).toEqual([
				{
					plugin: 'sui',
					role: 'db',
					imageName: 'devstack-build:db',
					snapshotTag: 'snapshot:db-container',
					tarPath: imageBundlePath,
				},
				{
					plugin: 'sui',
					role: 'worker',
					imageName: 'devstack-build:worker',
					snapshotTag: 'snapshot:worker-container',
					tarPath: imageBundlePath,
				},
			]);
			expect(saveCalls.map((ref) => ref.tag)).toEqual([
				'snapshot:db-container',
				'snapshot:worker-container',
			]);
			expect(unpauseCalls).toEqual([]);
		}),
	),
);

describe('snapshot capture container images', () => {
	it.effect('writes contribution docs for plugin keys containing slashes', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const pauseCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const removeImageCalls: ImageRef[] = [];
				const unpauseCalls: string[] = [];
				const pluginKey = 'account/alice#0';
				const runtime = runtimeStub({
					handlesByRole: {},
					saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
					pauseCalls,
					saveCalls,
					removeImageCalls,
					unpauseCalls,
				});
				const slashParticipant: SnapshotParticipant = {
					...participant([]),
					plugin: pluginKey,
					captureContribution: Effect.succeed({ account: 'alice' }),
				};

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [slashParticipant]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isSuccess(exit)).toBe(true);
				if (!Exit.isSuccess(exit)) return;
				const relPath = contributionPath(pluginKey);
				expect(relPath).toMatch(/^contributions\/p-[0-9a-f]+\.json$/);
				expect(exit.value.participants).toEqual([pluginKey]);
				const doc = JSON.parse(readFileSync(join(root, 'artifact', relPath), 'utf8')) as {
					version?: unknown;
					plugin?: unknown;
					opaqueState?: unknown;
				};
				expect(doc.version).toBe(SNAPSHOT_CONTRIBUTION_VERSION);
				expect(doc.plugin).toBe(pluginKey);
				expect(doc.opaqueState).toEqual({
					encoding: 'json',
					value: { account: 'alice' },
				});
			}),
		),
	);

	it.effect('streams committed images to one deduplicated bundle and records restore refs', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const pauseCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const removeImageCalls: ImageRef[] = [];
				const unpauseCalls: string[] = [];
				const handlesByRole: Record<string, ContainerHandle> = {
					validator: {
						id: 'validator-id',
						name: 'validator-container',
						imageName: 'devstack-build:sui-validator',
						status: 'running',
						ips: [],
					},
					postgres: {
						id: 'postgres-id',
						name: 'postgres-container',
						imageName: 'devstack-build:sui-postgres',
						status: 'running',
						ips: [],
					},
				};
				const runtime = runtimeStub({
					handlesByRole,
					saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
					pauseCalls,
					saveCalls,
					removeImageCalls,
					unpauseCalls,
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [
					participant(['validator', 'postgres']),
				]).pipe(Effect.provide(NodeFileSystem.layer));

				expect(Exit.isSuccess(exit)).toBe(true);
				if (!Exit.isSuccess(exit)) return;
				expect(exit.value.containers).toEqual([
					{
						plugin: 'sui',
						role: 'validator',
						imageName: 'devstack-build:sui-validator',
						snapshotTag: 'snapshot:validator-container',
						tarPath: imageBundlePath,
					},
					{
						plugin: 'sui',
						role: 'postgres',
						imageName: 'devstack-build:sui-postgres',
						snapshotTag: 'snapshot:postgres-container',
						tarPath: imageBundlePath,
					},
				]);
				const savedBundleText = readFileSync(join(root, 'artifact', imageBundlePath), 'utf8');
				expect(savedBundleText).toContain('manifest.json');
				expect(savedBundleText).toContain('snapshot:validator-container');
				expect(savedBundleText).toContain('snapshot:postgres-container');
				expect(pauseCalls).toEqual(['validator-container', 'postgres-container']);
				expect(saveCalls.map((ref) => ref.tag)).toEqual([
					'snapshot:validator-container',
					'snapshot:postgres-container',
				]);
				expect(removeImageCalls).toEqual([]);
				expect(unpauseCalls).toEqual(['validator-container', 'postgres-container']);
			}),
		),
	);

	it.effect(
		'unpauses every container the orchestrator intended to pause when pause fails mid-list',
		() =>
			withTempRoot(TEMP_PREFIX, (root) =>
				Effect.gen(function* () {
					// Regression — prior to this fix, the `paused` array
					// was populated AFTER `pause` returned success, so a
					// pause failure on the SECOND container left the
					// first container paused (its `unpause` never ran in
					// the finalizer) and a half-paused second container
					// was missed entirely. After the fix, every container
					// the orchestrator INTENDED to pause is recorded
					// before the syscall, so the finalizer attempts
					// `unpause` for both — `unpause` against a non-paused
					// container is a swallowed no-op.
					const pauseCalls: string[] = [];
					const saveCalls: ImageRef[] = [];
					const unpauseCalls: string[] = [];
					const handlesByRole: Record<string, ContainerHandle> = {
						alpha: {
							id: 'alpha-id',
							name: 'alpha-container',
							imageName: 'devstack-build:alpha',
							status: 'running',
							ips: [],
						},
						beta: {
							id: 'beta-id',
							name: 'beta-container',
							imageName: 'devstack-build:beta',
							status: 'running',
							ips: [],
						},
					};
					const failingRuntime: ContainerRuntime = {
						...runtimeStub({
							handlesByRole,
							saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
							pauseCalls,
							saveCalls,
							unpauseCalls,
						}),
						pause: (handle) =>
							Effect.gen(function* () {
								pauseCalls.push(handle.name);
								if (handle.name === 'beta-container') {
									return yield* Effect.fail({
										_tag: 'ContainerRuntimeError' as const,
										reason: 'daemon-unreachable' as const,
										detail: `pause failed for ${handle.name}`,
									} satisfies ContainerRuntimeError);
								}
							}),
					};

					mkdirSync(join(root, 'artifact'), { recursive: true });
					const exit = yield* runCaptureExit(root, failingRuntime, [
						participant(['alpha', 'beta']),
					]).pipe(Effect.provide(NodeFileSystem.layer));

					expect(Exit.isFailure(exit)).toBe(true);
					// Both pauses attempted in order.
					expect(pauseCalls).toEqual(['alpha-container', 'beta-container']);
					// Finalizer unpauses BOTH — alpha (confirmed paused)
					// AND beta (intent recorded before failure). The
					// runtime sees both unpause calls; in a real Docker
					// daemon beta would surface "container not paused"
					// which is treated as best-effort.
					expect(unpauseCalls.sort()).toEqual(['alpha-container', 'beta-container']);
				}),
			),
	);

	it.effect('keeps running containers paused through host-tree and contribution capture', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const pauseCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const unpauseCalls: string[] = [];
				const progress: SnapshotCaptureProgress[] = [];
				let contributionSawUnpauseCalls: ReadonlyArray<string> = [];
				const runtimeStackRoot = join(root, 'runtime-stack');
				mkdirSync(join(root, 'artifact'), { recursive: true });
				mkdirSync(join(runtimeStackRoot, 'stateful'), { recursive: true });
				writeFileSync(join(runtimeStackRoot, 'stateful', 'marker.txt'), 'captured');
				const runtime = runtimeStub({
					handlesByRole: {
						db: {
							id: 'db-id',
							name: 'db-container',
							imageName: 'devstack-build:db',
							status: 'running',
							ips: [],
						},
						worker: {
							id: 'worker-id',
							name: 'worker-container',
							imageName: 'devstack-build:worker',
							status: 'running',
							ips: [],
						},
					},
					saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
					pauseCalls,
					saveCalls,
					unpauseCalls,
				});
				const statefulParticipant: SnapshotParticipant = {
					...participant(['db', 'worker']),
					decl: {
						...participant(['db', 'worker']).decl,
						subtrees: ['stateful'],
					},
					captureContribution: Effect.sync(() => {
						contributionSawUnpauseCalls = [...unpauseCalls];
						return { ok: true };
					}),
				};

				const exit = yield* Effect.exit(
					runCapture({
						stagingDir: join(root, 'artifact'),
						snapshotId: snapshotIdFromString('snap-images'),
						label: null,
						app: 'capture-app',
						stack: 'main',
						network: 'sui:local',
						runtimeStackRoot,
						participants: [statefulParticipant],
						runtime,
						onProgress: (next) =>
							Effect.sync(() => {
								progress.push(next);
							}),
					}),
				).pipe(Effect.provide(NodeFileSystem.layer));

				expect(Exit.isSuccess(exit)).toBe(true);
				expect(pauseCalls).toEqual(['db-container', 'worker-container']);
				expect(contributionSawUnpauseCalls).toEqual([]);
				expect(unpauseCalls).toEqual(['db-container', 'worker-container']);
				expect(progress.map((entry) => entry.phase)).toContain('paused');
				expect(progress.map((entry) => entry.phase)).toContain('capturing-host-tree');
				expect(progress.find((entry) => entry.phase === 'paused')).toMatchObject({
					pausedContainers: 2,
					totalContainers: 2,
				});
			}),
		),
	);

	it.effect('accepts saved image bundle metadata after leading layer blobs before publish', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const pauseCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const removeImageCalls: ImageRef[] = [];
				const unpauseCalls: string[] = [];
				const runtime = runtimeStub({
					handlesByRole: {
						validator: {
							id: 'validator-id',
							name: 'validator-container',
							imageName: 'devstack-build:sui-validator',
							status: 'running',
							ips: [],
						},
					},
					saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
					saveImages: (refs) =>
						Stream.make(
							dockerSaveBundleTarWithLateMetadata(refs.map((ref) => ref.tag ?? ref.digest)),
						),
					pauseCalls,
					saveCalls,
					removeImageCalls,
					unpauseCalls,
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [participant(['validator'])]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isSuccess(exit)).toBe(true);
				expect(saveCalls.map((ref) => ref.tag)).toEqual(['snapshot:validator-container']);
				expect(removeImageCalls).toEqual([]);
				expect(unpauseCalls).toEqual(['validator-container']);
				expect(existsSync(join(root, 'artifact', SnapshotLayout.metaFile))).toBe(true);
				expect(readFileSync(join(root, 'artifact', imageBundlePath))).toHaveLength(
					dockerSaveBundleTarWithLateMetadata(['snapshot:validator-container']).length,
				);
			}),
		),
	);

	it.effect('rejects an image bundle without Docker or OCI metadata before publish', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const pauseCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const removeImageCalls: ImageRef[] = [];
				const unpauseCalls: string[] = [];
				const runtime = runtimeStub({
					handlesByRole: {
						validator: {
							id: 'validator-id',
							name: 'validator-container',
							imageName: 'devstack-build:sui-validator',
							status: 'running',
							ips: [],
						},
					},
					saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
					saveImages: () =>
						Stream.make(
							Buffer.concat([tarEntry('repositories', Buffer.from('{}')), Buffer.alloc(1024)]),
						),
					pauseCalls,
					saveCalls,
					removeImageCalls,
					unpauseCalls,
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [participant(['validator'])]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(CapturePhaseError);
					if (error.value._tag === 'SnapshotCapturePhaseError') {
						expect(error.value.phase).toBe('save-images');
						expect(error.value.detail).toContain('does not contain manifest.json or index.json');
					}
				}
				expect(saveCalls.map((ref) => ref.tag)).toEqual(['snapshot:validator-container']);
				expect(removeImageCalls).toEqual([
					{ digest: 'sha256:validator-container', tag: 'snapshot:validator-container' },
				]);
				expect(unpauseCalls).toEqual(['validator-container']);
				expect(existsSync(join(root, 'artifact', SnapshotLayout.metaFile))).toBe(false);
			}),
		),
	);

	it.effect('rejects corrupt image bundle metadata before publish', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const pauseCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const removeImageCalls: ImageRef[] = [];
				const unpauseCalls: string[] = [];
				const runtime = runtimeStub({
					handlesByRole: {
						validator: {
							id: 'validator-id',
							name: 'validator-container',
							imageName: 'devstack-build:sui-validator',
							status: 'running',
							ips: [],
						},
					},
					saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
					saveImages: () => Stream.make(tarEntry('manifest.json', Buffer.from('{not json'))),
					pauseCalls,
					saveCalls,
					removeImageCalls,
					unpauseCalls,
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [participant(['validator'])]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(CapturePhaseError);
					if (error.value._tag === 'SnapshotCapturePhaseError') {
						expect(error.value.phase).toBe('save-images');
						expect(error.value.detail).toContain('manifest.json');
					}
				}
				expect(saveCalls.map((ref) => ref.tag)).toEqual(['snapshot:validator-container']);
				expect(removeImageCalls).toEqual([
					{ digest: 'sha256:validator-container', tag: 'snapshot:validator-container' },
				]);
				expect(unpauseCalls).toEqual(['validator-container']);
				expect(existsSync(join(root, 'artifact', SnapshotLayout.metaFile))).toBe(false);
			}),
		),
	);

	it.effect('rejects saved image bundle tag mismatches before publish', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const pauseCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const removeImageCalls: ImageRef[] = [];
				const unpauseCalls: string[] = [];
				const runtime = runtimeStub({
					handlesByRole: {
						validator: {
							id: 'validator-id',
							name: 'validator-container',
							imageName: 'devstack-build:sui-validator',
							status: 'running',
							ips: [],
						},
					},
					saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
					saveImages: () => Stream.make(dockerSaveBundleTar(['snapshot:other'])),
					pauseCalls,
					saveCalls,
					removeImageCalls,
					unpauseCalls,
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [participant(['validator'])]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(CapturePhaseError);
					if (error.value._tag === 'SnapshotCapturePhaseError') {
						expect(error.value.phase).toBe('save-images');
						expect(error.value.detail).toContain('snapshot:validator-container');
						expect(error.value.detail).toContain('snapshot:other');
					}
				}
				expect(saveCalls.map((ref) => ref.tag)).toEqual(['snapshot:validator-container']);
				expect(removeImageCalls).toEqual([
					{ digest: 'sha256:validator-container', tag: 'snapshot:validator-container' },
				]);
				expect(unpauseCalls).toEqual(['validator-container']);
				expect(existsSync(join(root, 'artifact', SnapshotLayout.metaFile))).toBe(false);
			}),
		),
	);

	it.effect('rejects duplicate managed container identities before image writes', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const pauseCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const unpauseCalls: string[] = [];
				const runtime = runtimeStub({
					handlesByRole: {
						db: [
							{
								id: 'db-a-id',
								name: 'db-a-container',
								imageName: 'devstack-build:db-a',
								status: 'running',
								ips: [],
							},
							{
								id: 'db-b-id',
								name: 'db-b-container',
								imageName: 'devstack-build:db-b',
								status: 'running',
								ips: [],
							},
						],
					},
					saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
					pauseCalls,
					saveCalls,
					unpauseCalls,
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [participant(['db'])]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(CapturePhaseError);
					if (error.value._tag === 'SnapshotCapturePhaseError') {
						expect(error.value.phase).toBe('commit');
						expect(error.value.detail).toContain(
							'duplicate managed container snapshot identity sui/db',
						);
					}
				}
				expect(pauseCalls).toEqual([]);
				expect(saveCalls).toEqual([]);
				expect(unpauseCalls).toEqual([]);
				expect(existsSync(join(root, 'artifact', imageBundlePath))).toBe(false);
			}),
		),
	);

	it.effect('removes committed temp tags when a later commit fails before image save', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const pauseCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const removeImageCalls: ImageRef[] = [];
				const unpauseCalls: string[] = [];
				const runtime = runtimeStub({
					handlesByRole: {
						db: {
							id: 'db-id',
							name: 'db-container',
							imageName: 'devstack-build:db',
							status: 'running',
							ips: [],
						},
						worker: {
							id: 'worker-id',
							name: 'worker-container',
							imageName: 'devstack-build:worker',
							status: 'running',
							ips: [],
						},
					},
					saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
					pauseCalls,
					saveCalls,
					removeImageCalls,
					unpauseCalls,
					commitErrorFor: (handle) =>
						handle.name === 'worker-container'
							? {
									_tag: 'ContainerRuntimeError',
									reason: 'image-save-failed',
									detail: 'commit failed',
								}
							: undefined,
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [participant(['db', 'worker'])]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(CapturePhaseError);
					if (error.value._tag === 'SnapshotCapturePhaseError') {
						expect(error.value.phase).toBe('commit');
					}
				}
				expect(saveCalls).toEqual([]);
				expect(removeImageCalls).toEqual([
					{ digest: 'sha256:db-container', tag: 'snapshot:db-container' },
				]);
				expect(unpauseCalls).toEqual(['db-container', 'worker-container']);
			}),
		),
	);

	it.effect(
		'removes a committed temp tag when snapshot tag validation fails before image save',
		() =>
			withTempRoot(TEMP_PREFIX, (root) =>
				Effect.gen(function* () {
					const pauseCalls: string[] = [];
					const saveCalls: ImageRef[] = [];
					const removeImageCalls: ImageRef[] = [];
					const unpauseCalls: string[] = [];
					const runtime = runtimeStub({
						handlesByRole: {
							db: {
								id: 'db-id',
								name: 'db-container',
								imageName: 'devstack-build:db',
								status: 'running',
								ips: [],
							},
						},
						saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
						pauseCalls,
						saveCalls,
						removeImageCalls,
						unpauseCalls,
						committedRefFor: () => ({
							digest: 'sha256:db-container',
							tag: 'sha256:db-container',
						}),
					});

					mkdirSync(join(root, 'artifact'), { recursive: true });
					const exit = yield* runCaptureExit(root, runtime, [participant(['db'])]).pipe(
						Effect.provide(NodeFileSystem.layer),
					);

					expect(Exit.isFailure(exit)).toBe(true);
					const error = Exit.findErrorOption(exit);
					expect(error._tag).toBe('Some');
					if (error._tag === 'Some') {
						expect(error.value).toBeInstanceOf(CapturePhaseError);
						if (error.value._tag === 'SnapshotCapturePhaseError') {
							expect(error.value.phase).toBe('commit');
							expect(error.value.detail).toContain('restorable snapshot tag');
						}
					}
					expect(saveCalls).toEqual([]);
					expect(removeImageCalls).toEqual([
						{ digest: 'sha256:db-container', tag: 'sha256:db-container' },
					]);
					expect(unpauseCalls).toEqual(['db-container']);
				}),
			),
	);

	it.effect('unpauses committed containers when image save fails', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const pauseCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const removeImageCalls: ImageRef[] = [];
				const unpauseCalls: string[] = [];
				const runtime = runtimeStub({
					handlesByRole: {
						validator: {
							id: 'validator-id',
							name: 'validator-container',
							imageName: 'devstack-build:sui-validator',
							status: 'running',
							ips: [],
						},
					},
					saveImage: () =>
						Stream.fail({
							_tag: 'ContainerRuntimeError',
							reason: 'image-save-failed',
							detail: 'save failed',
						}),
					saveImages: () =>
						Stream.fail({
							_tag: 'ContainerRuntimeError',
							reason: 'image-save-failed',
							detail: 'save failed',
						}),
					pauseCalls,
					saveCalls,
					removeImageCalls,
					unpauseCalls,
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [participant(['validator'])]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(CapturePhaseError);
					expect(error.value._tag).toBe('SnapshotCapturePhaseError');
					if (error.value._tag === 'SnapshotCapturePhaseError') {
						expect(error.value.phase).toBe('save-images');
					}
				}
				expect(pauseCalls).toEqual(['validator-container']);
				expect(saveCalls.map((ref) => ref.tag)).toEqual(['snapshot:validator-container']);
				expect(removeImageCalls).toEqual([
					{ digest: 'sha256:validator-container', tag: 'snapshot:validator-container' },
				]);
				expect(unpauseCalls).toEqual(['validator-container']);
			}),
		),
	);

	it.effect('removes committed temp tags when batched image save fails immediately', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const pauseCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const removeImageCalls: ImageRef[] = [];
				const unpauseCalls: string[] = [];
				const runtime = runtimeStub({
					handlesByRole: {
						db: {
							id: 'db-id',
							name: 'db-container',
							imageName: 'devstack-build:db',
							status: 'running',
							ips: [],
						},
						worker: {
							id: 'worker-id',
							name: 'worker-container',
							imageName: 'devstack-build:worker',
							status: 'running',
							ips: [],
						},
					},
					saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
					saveImages: () =>
						Stream.fail({
							_tag: 'ContainerRuntimeError',
							reason: 'image-save-failed',
							detail: 'save spawn failed',
						}),
					pauseCalls,
					saveCalls,
					removeImageCalls,
					unpauseCalls,
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [participant(['db', 'worker'])]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(CapturePhaseError);
					if (error.value._tag === 'SnapshotCapturePhaseError') {
						expect(error.value.phase).toBe('save-images');
					}
				}
				expect(saveCalls.map((ref) => ref.tag)).toEqual([
					'snapshot:db-container',
					'snapshot:worker-container',
				]);
				expect(removeImageCalls).toEqual([
					{ digest: 'sha256:db-container', tag: 'snapshot:db-container' },
					{ digest: 'sha256:worker-container', tag: 'snapshot:worker-container' },
				]);
				expect(unpauseCalls).toEqual(['db-container', 'worker-container']);
			}),
		),
	);

	it.effect('rejects digest-only image names before pause/save side effects', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const pauseCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const unpauseCalls: string[] = [];
				const runtime = runtimeStub({
					handlesByRole: {
						validator: {
							id: 'validator-id',
							name: 'validator-container',
							imageName: 'sha256:abc123',
							status: 'running',
							ips: [],
						},
					},
					saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
					pauseCalls,
					saveCalls,
					unpauseCalls,
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [participant(['validator'])]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(CapturePhaseError);
					if (error.value._tag === 'SnapshotCapturePhaseError') {
						expect(error.value.phase).toBe('commit');
						expect(error.value.detail).toContain('restorable Docker tag destination');
					}
				}
				expect(pauseCalls).toEqual([]);
				expect(saveCalls).toEqual([]);
				expect(unpauseCalls).toEqual([]);
			}),
		),
	);

	it.effect('rejects unsafe container label path segments before writing image artifacts', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const pauseCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const unpauseCalls: string[] = [];
				const runtime = runtimeStub({
					handlesByRole: {
						validator: {
							id: 'validator-id',
							name: 'validator-container',
							imageName: 'devstack-build:sui-validator',
							status: 'running',
							ips: [],
						},
					},
					saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
					pauseCalls,
					saveCalls,
					unpauseCalls,
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [
					participant(['validator'], (role) => ({
						...label(role),
						plugin: '../sui',
					})),
				]).pipe(Effect.provide(NodeFileSystem.layer));

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(CapturePhaseError);
					if (error.value._tag === 'SnapshotCapturePhaseError') {
						expect(error.value.phase).toBe('commit');
						expect(error.value.detail).toContain('unsafe snapshot plugin path segment');
					}
				}
				expect(pauseCalls).toEqual([]);
				expect(saveCalls).toEqual([]);
				expect(unpauseCalls).toEqual([]);
			}),
		),
	);
});

// Regression for Phase B3: identity-merge fail-on-conflict at capture
// time. Pre-fix, capture silently last-write-wins'd colliding identity
// keys; the conflict only surfaced at restore time (way after the
// operator could have fixed the offending plugins). Post-fix, capture
// fails AT THE CAPTURE SITE with `IdentityContributionConflictError`
// (`_tag: 'SnapshotIdentityContributionConflict'`).
describe('snapshot capture — identity contribution conflict', () => {
	it.effect('two plugins contributing different values for the same key fail at capture', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const pauseCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const unpauseCalls: string[] = [];
				const runtime = runtimeStub({
					handlesByRole: {},
					saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
					pauseCalls,
					saveCalls,
					unpauseCalls,
				});

				const a: SnapshotParticipant = {
					...participant([]),
					plugin: 'sui#0',
					captureIdentity: Effect.succeed({ chain: 'sui:local' }),
					captureContribution: Effect.succeed({}),
				};
				const b: SnapshotParticipant = {
					...participant([]),
					plugin: 'pyth#0',
					captureIdentity: Effect.succeed({ chain: 'sui:testnet' }),
					captureContribution: Effect.succeed({}),
				};

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [a, b]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					const tag = (error.value as { readonly _tag?: string })._tag;
					expect(tag).toBe('SnapshotIdentityContributionConflict');
					const conflict = error.value as unknown as {
						readonly key: string;
						readonly conflictingPlugins: ReadonlyArray<string>;
						readonly values: ReadonlyArray<string>;
					};
					expect(conflict.key).toBe('chain');
					expect([...conflict.conflictingPlugins].sort()).toEqual(['pyth#0', 'sui#0']);
					expect([...conflict.values].sort()).toEqual(['sui:local', 'sui:testnet']);
				}
				// And NO artifact was written — the failure happens before
				// metadata flush.
				expect(existsSync(join(root, 'artifact', SnapshotLayout.metaFile))).toBe(false);
			}),
		),
	);

	it.effect('two plugins contributing the SAME value for the same key succeed', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const pauseCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const unpauseCalls: string[] = [];
				const runtime = runtimeStub({
					handlesByRole: {},
					saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
					pauseCalls,
					saveCalls,
					unpauseCalls,
				});

				const a: SnapshotParticipant = {
					...participant([]),
					plugin: 'sui#0',
					captureIdentity: Effect.succeed({ chain: 'sui:local' }),
					captureContribution: Effect.succeed({}),
				};
				const b: SnapshotParticipant = {
					...participant([]),
					plugin: 'pyth#0',
					captureIdentity: Effect.succeed({ chain: 'sui:local' }),
					captureContribution: Effect.succeed({}),
				};

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [a, b]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isSuccess(exit)).toBe(true);
			}),
		),
	);
});
