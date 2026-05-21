import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
	SnapshotLayout,
	SNAPSHOT_CONTRIBUTION_VERSION,
	contributionPath,
	runCapture,
	snapshotIdFromString,
	type SnapshotParticipant,
} from '../../../src/orchestrators/snapshot/index.ts';

const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'snapshot-capture-test-'));

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

const runtimeStub = (opts: {
	readonly handlesByRole: Readonly<
		Record<string, ContainerHandle | ReadonlyArray<ContainerHandle>>
	>;
	readonly saveImage: (ref: ImageRef) => Stream.Stream<Uint8Array, ContainerRuntimeError>;
	readonly pauseCalls: Array<string>;
	readonly saveCalls: Array<ImageRef>;
	readonly unpauseCalls: Array<string>;
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
	pauseAndCommit: (handle) =>
		Effect.sync(() => {
			opts.pauseCalls.push(handle.name);
			return {
				digest: `sha256:${handle.name}`,
				tag: `snapshot:${handle.name}`,
			};
		}),
	saveImage: (ref) => {
		opts.saveCalls.push(ref);
		return opts.saveImage(ref);
	},
	loadImage: () => Effect.die('loadImage not used'),
	tagImage: () => Effect.die('tagImage not used'),
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
			stateFilePath: join(root, 'runtime-stack', SnapshotLayout.stateFile),
			participants,
			runtime,
		}),
	);

it.effect('captures an already-paused container without unpausing it afterwards', () =>
	Effect.gen(function* () {
		const root = freshRoot();
		const pauseCalls: string[] = [];
		const saveCalls: ImageRef[] = [];
		const unpauseCalls: string[] = [];
		try {
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
				unpauseCalls,
			});

			mkdirSync(join(root, 'artifact'), { recursive: true });
			const exit = yield* runCaptureExit(root, runtime, [participant(['validator'])]).pipe(
				Effect.provide(NodeFileSystem.layer),
			);

			expect(Exit.isSuccess(exit)).toBe(true);
			if (!Exit.isSuccess(exit)) return;
			expect(exit.value.label).toBe(null);
			expect(
				JSON.parse(readFileSync(join(root, 'artifact', SnapshotLayout.integrityFile), 'utf8')),
			).toMatchObject({ version: 1 });
			expect(saveCalls.map((ref) => ref.tag)).toEqual(['snapshot:validator-container']);
			expect(unpauseCalls).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}),
);

it.effect('records user-facing labels in metadata without using them as artifact paths', () =>
	Effect.gen(function* () {
		const root = freshRoot();
		const pauseCalls: string[] = [];
		const saveCalls: ImageRef[] = [];
		const unpauseCalls: string[] = [];
		try {
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
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}),
);

it.effect('refuses corrupt runtime state before publishing snapshot metadata', () =>
	Effect.gen(function* () {
		const root = freshRoot();
		const pauseCalls: string[] = [];
		const saveCalls: ImageRef[] = [];
		const unpauseCalls: string[] = [];
		try {
			const runtime = runtimeStub({
				handlesByRole: {},
				saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
				pauseCalls,
				saveCalls,
				unpauseCalls,
			});
			const runtimeStackRoot = join(root, 'runtime-stack');
			mkdirSync(join(root, 'artifact'), { recursive: true });
			mkdirSync(runtimeStackRoot, { recursive: true });
			writeFileSync(
				join(runtimeStackRoot, SnapshotLayout.stateFile),
				'{"version":999,"plugins":{}}',
			);

			const exit = yield* runCaptureExit(root, runtime, [participant([])]).pipe(
				Effect.provide(NodeFileSystem.layer),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			const error = Exit.findErrorOption(exit);
			expect(error._tag).toBe('Some');
			if (error._tag === 'Some') {
				expect(error.value).toBeInstanceOf(CapturePhaseError);
				if (error.value._tag === 'SnapshotCapturePhaseError') {
					expect(error.value.phase).toBe('read-state');
				}
			}
			expect(existsSync(join(root, 'artifact', SnapshotLayout.metaFile))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}),
);

it.effect('captures exited and created containers instead of silently omitting them', () =>
	Effect.gen(function* () {
		const root = freshRoot();
		const pauseCalls: string[] = [];
		const saveCalls: ImageRef[] = [];
		const unpauseCalls: string[] = [];
		try {
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
					tarPath: 'containers/sui/db.tar',
				},
				{
					plugin: 'sui',
					role: 'worker',
					imageName: 'devstack-build:worker',
					tarPath: 'containers/sui/worker.tar',
				},
			]);
			expect(saveCalls.map((ref) => ref.tag)).toEqual([
				'snapshot:db-container',
				'snapshot:worker-container',
			]);
			expect(unpauseCalls).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}),
);

describe('snapshot capture container images', () => {
	it.effect('writes contribution docs for plugin keys containing slashes', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			const pauseCalls: string[] = [];
			const saveCalls: ImageRef[] = [];
			const unpauseCalls: string[] = [];
			try {
				const pluginKey = 'account/alice#0';
				const runtime = runtimeStub({
					handlesByRole: {},
					saveImage: (ref) => Stream.make(Buffer.from(`tar:${ref.tag ?? ref.digest}`)),
					pauseCalls,
					saveCalls,
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
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect(
		'streams committed images to artifact tars and records the image ref ensureContainer expects',
		() =>
			Effect.gen(function* () {
				const root = freshRoot();
				const pauseCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const unpauseCalls: string[] = [];
				try {
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
							tarPath: 'containers/sui/validator.tar',
						},
						{
							plugin: 'sui',
							role: 'postgres',
							imageName: 'devstack-build:sui-postgres',
							tarPath: 'containers/sui/postgres.tar',
						},
					]);
					expect(readFileSync(join(root, 'artifact', 'containers/sui/validator.tar'), 'utf8')).toBe(
						'tar:snapshot:validator-container',
					);
					expect(readFileSync(join(root, 'artifact', 'containers/sui/postgres.tar'), 'utf8')).toBe(
						'tar:snapshot:postgres-container',
					);
					expect(pauseCalls).toEqual(['validator-container', 'postgres-container']);
					expect(saveCalls.map((ref) => ref.tag)).toEqual([
						'snapshot:validator-container',
						'snapshot:postgres-container',
					]);
					expect(unpauseCalls).toEqual(['validator-container', 'postgres-container']);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
	);

	it.effect('rejects duplicate managed container artifact paths before image writes', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			const pauseCalls: string[] = [];
			const saveCalls: ImageRef[] = [];
			const unpauseCalls: string[] = [];
			try {
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
							'duplicate managed container snapshot artifact path containers/sui/db.tar',
						);
					}
				}
				expect(pauseCalls).toEqual([]);
				expect(saveCalls).toEqual([]);
				expect(unpauseCalls).toEqual([]);
				expect(existsSync(join(root, 'artifact', 'containers/sui/db.tar'))).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('unpauses committed containers when image save fails', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			const pauseCalls: string[] = [];
			const saveCalls: ImageRef[] = [];
			const unpauseCalls: string[] = [];
			try {
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
					expect(error.value._tag).toBe('SnapshotCapturePhaseError');
					if (error.value._tag === 'SnapshotCapturePhaseError') {
						expect(error.value.phase).toBe('commit');
					}
				}
				expect(pauseCalls).toEqual(['validator-container']);
				expect(saveCalls.map((ref) => ref.tag)).toEqual(['snapshot:validator-container']);
				expect(unpauseCalls).toEqual(['validator-container']);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('rejects digest-only image names before pause/save side effects', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			const pauseCalls: string[] = [];
			const saveCalls: ImageRef[] = [];
			const unpauseCalls: string[] = [];
			try {
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
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('rejects unsafe container label path segments before writing image artifacts', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			const pauseCalls: string[] = [];
			const saveCalls: ImageRef[] = [];
			const unpauseCalls: string[] = [];
			try {
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
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
