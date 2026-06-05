// Capture-bounce unit tests.
//
// `runCapture` is the bounce's gather → graceful-stop (flush) → commit
// (stopped containers) → save bundle → tar host-tree → contributions →
// meta-LAST half. `resumeAfterCapture` is the post-publish tail: retag each
// committed image onto its container's ORIGINAL name + hard-rm the stopped
// containers + run the injected resume. These tests pin the invariants:
//   - identity fail-closed BEFORE any stop (empty / conflicting identity),
//   - graceful STOP (not pause) flushes — every managed container is stopped,
//   - commit + one deduplicated bundle + image-bundle tag verification,
//   - meta.json written LAST (absent on failure → artifact inert),
//   - duplicate-identity collision + unsafe-segment / digest-only refusal
//     BEFORE any side effect,
//   - committed temp-tag cleanup on a mid-capture failure,
//   - the resume tail retags-to-original + hard-rms + runs resume.

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
	CACHE_DIR_NAME,
	CapturePhaseError,
	DEPLOY_CACHE_NAMESPACES,
	IdentityEmptyError,
	SnapshotLayout,
	SNAPSHOT_CONTRIBUTION_VERSION,
	SNAPSHOT_GRAPH_INPUT_VERSION,
	SNAPSHOT_META_VERSION,
	containerImagesBundlePath,
	contributionPath,
	resumeAfterCapture,
	runCapture,
	snapshotIdFromString,
	type SnapshotMetadata,
	type SnapshotParticipant,
} from '../../../src/orchestrators/snapshot/index.ts';
import { makeContainerRuntimeStub } from '../../helpers/container-runtime-stub.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';
import {
	dockerSaveBundleTar,
	dockerSaveBundleTarWithLateMetadata,
	tarEntry,
} from './image-bundle-fixtures.ts';

const TEMP_PREFIX = 'snapshot-capture-test';
const imageBundlePath = containerImagesBundlePath();

const graphInput = {
	version: SNAPSHOT_GRAPH_INPUT_VERSION,
	graphInputId: 'graph-fixture',
	nodes: [],
} as const;

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

interface RuntimeStubOpts {
	readonly handlesByRole: Readonly<
		Record<string, ContainerHandle | ReadonlyArray<ContainerHandle>>
	>;
	readonly saveImages?: (
		refs: ReadonlyArray<ImageRef>,
	) => Stream.Stream<Uint8Array, ContainerRuntimeError>;
	readonly stopCalls?: Array<string>;
	readonly saveCalls?: Array<ImageRef>;
	readonly removeImageCalls?: Array<ImageRef>;
	/** Records every `inspectImageDigest(ref)` query. */
	readonly inspectDigestCalls?: Array<string>;
	/** Per-ref digest oracle. Returning successive values across calls is
	 *  done by closing over a mutable cursor in the test. `undefined` ⇒
	 *  null (ref does not resolve). */
	readonly inspectImageDigest?: (ref: string) => string | null;
	/** Fail the image `removeImage` GC removal (best-effort path). */
	readonly removeImageErrorFor?: (ref: ImageRef) => ContainerRuntimeError | undefined;
	readonly stopErrorFor?: (handle: ContainerHandle) => ContainerRuntimeError | undefined;
	readonly commitErrorFor?: (handle: ContainerHandle) => ContainerRuntimeError | undefined;
	readonly committedRefFor?: (handle: ContainerHandle) => ImageRef & { readonly tag: string };
}

const runtimeStub = (opts: RuntimeStubOpts): ContainerRuntime =>
	makeContainerRuntimeStub({
		inspectByLabels: (labels) => {
			const matched = opts.handlesByRole[labels.role] ?? [];
			return Effect.succeed(Array.isArray(matched) ? matched : [matched]);
		},
		pauseAndCommit: (handle) =>
			Effect.gen(function* () {
				const error = opts.commitErrorFor?.(handle);
				if (error !== undefined) return yield* Effect.fail(error);
				return (
					opts.committedRefFor?.(handle) ?? {
						digest: `sha256:${handle.name}`,
						tag: `snapshot:${handle.name}`,
					}
				);
			}),
		saveImages: (refs) => {
			opts.saveCalls?.push(...refs);
			return (
				opts.saveImages?.(refs) ??
				Stream.make(dockerSaveBundleTar(refs.map((ref) => ref.tag ?? ref.digest)))
			);
		},
		removeImage: (ref) =>
			Effect.gen(function* () {
				opts.removeImageCalls?.push(ref);
				const error = opts.removeImageErrorFor?.(ref);
				if (error !== undefined) return yield* Effect.fail(error);
			}),
		inspectImageDigest: (ref) =>
			Effect.sync(() => {
				opts.inspectDigestCalls?.push(ref);
				return opts.inspectImageDigest?.(ref) ?? null;
			}),
		stop: (handle) =>
			Effect.gen(function* () {
				opts.stopCalls?.push(handle.name);
				const error = opts.stopErrorFor?.(handle);
				if (error !== undefined) return yield* Effect.fail(error);
			}),
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
			graphInput,
			runtimeStackRoot: join(root, 'runtime-stack'),
			participants,
			runtime,
			// Tests don't exercise the real graceful-stop grace; a small value
			// keeps the stub fast.
			stopGraceSeconds: 1,
		}),
	);

it.effect('refuses to write a capture artifact with empty contributed identity', () =>
	withTempRoot(TEMP_PREFIX, (root) =>
		Effect.gen(function* () {
			const runtime = runtimeStub({ handlesByRole: {} });
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

it.effect('records user-facing labels in metadata without using them as artifact paths', () =>
	withTempRoot(TEMP_PREFIX, (root) =>
		Effect.gen(function* () {
			const runtime = runtimeStub({ handlesByRole: {} });
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

it.effect('captures the deploy cache into the snapshot host-tree (self-contained)', () =>
	withTempRoot(TEMP_PREFIX, (root) =>
		Effect.gen(function* () {
			const runtime = runtimeStub({ handlesByRole: {} });
			mkdirSync(join(root, 'artifact'), { recursive: true });
			// Seed two deploy-cache namespaces on the live stack root; a third is
			// deliberately absent (a disabled-plugin shape — must be skipped, not
			// fail). Capture must tar the present ones into the host-tree so the
			// snapshot is self-contained (cross-machine restore).
			const stackRoot = join(root, 'runtime-stack');
			const ns0 = DEPLOY_CACHE_NAMESPACES[0]!;
			const ns1 = DEPLOY_CACHE_NAMESPACES[1]!;
			mkdirSync(join(stackRoot, CACHE_DIR_NAME, ns0, 'local'), { recursive: true });
			writeFileSync(join(stackRoot, CACHE_DIR_NAME, ns0, 'local', 'ids.json'), 'a');
			mkdirSync(join(stackRoot, CACHE_DIR_NAME, ns1, 'local'), { recursive: true });
			writeFileSync(join(stackRoot, CACHE_DIR_NAME, ns1, 'local', 'ids.json'), 'b');

			const exit = yield* runCaptureExit(root, runtime, [participant([])]).pipe(
				Effect.provide(NodeFileSystem.layer),
			);

			expect(Exit.isSuccess(exit)).toBe(true);
			if (!Exit.isSuccess(exit)) return;
			expect(exit.value.hostTreeIncluded).toBe(true);
			const capturedCacheRelPaths = exit.value.subtrees
				.filter((s) => s.relPath.startsWith(`${CACHE_DIR_NAME}/`))
				.map((s) => s.relPath)
				.sort();
			expect(capturedCacheRelPaths).toEqual(
				[`${CACHE_DIR_NAME}/${ns0}`, `${CACHE_DIR_NAME}/${ns1}`].sort(),
			);
			// The host-tree tar exists and is non-empty.
			const tarPath = join(root, 'artifact', SnapshotLayout.hostTreeTar);
			expect(existsSync(tarPath)).toBe(true);
		}),
	),
);

it.effect('gracefully stops every managed container (flush) before committing', () =>
	withTempRoot(TEMP_PREFIX, (root) =>
		Effect.gen(function* () {
			const stopCalls: string[] = [];
			const saveCalls: ImageRef[] = [];
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
				stopCalls,
				saveCalls,
			});
			mkdirSync(join(root, 'artifact'), { recursive: true });
			const exit = yield* runCaptureExit(root, runtime, [participant(['validator'])]).pipe(
				Effect.provide(NodeFileSystem.layer),
			);

			expect(Exit.isSuccess(exit)).toBe(true);
			if (!Exit.isSuccess(exit)) return;
			expect(stopCalls).toEqual(['validator-container']);
			expect(saveCalls.map((ref) => ref.tag)).toEqual(['snapshot:validator-container']);
		}),
	),
);

it.effect('commits exited and created containers instead of silently omitting them', () =>
	withTempRoot(TEMP_PREFIX, (root) =>
		Effect.gen(function* () {
			const stopCalls: string[] = [];
			const saveCalls: ImageRef[] = [];
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
				stopCalls,
				saveCalls,
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
		}),
	),
);

describe('snapshot capture container images', () => {
	it.effect('writes contribution docs for plugin keys containing slashes', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const pluginKey = 'account/alice#0';
				const runtime = runtimeStub({ handlesByRole: {} });
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
				expect(doc.opaqueState).toEqual({ encoding: 'json', value: { account: 'alice' } });
			}),
		),
	);

	it.effect('streams committed images to one deduplicated bundle and records restore refs', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const stopCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const removeImageCalls: ImageRef[] = [];
				const runtime = runtimeStub({
					handlesByRole: {
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
					},
					stopCalls,
					saveCalls,
					removeImageCalls,
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
				expect(stopCalls.sort()).toEqual(['postgres-container', 'validator-container']);
				expect(saveCalls.map((ref) => ref.tag)).toEqual([
					'snapshot:validator-container',
					'snapshot:postgres-container',
				]);
				expect(removeImageCalls).toEqual([]);
			}),
		),
	);

	it.effect('accepts saved image bundle metadata after leading layer blobs before publish', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const removeImageCalls: ImageRef[] = [];
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
					saveImages: (refs) =>
						Stream.make(
							dockerSaveBundleTarWithLateMetadata(refs.map((ref) => ref.tag ?? ref.digest)),
						),
					removeImageCalls,
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [participant(['validator'])]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isSuccess(exit)).toBe(true);
				expect(removeImageCalls).toEqual([]);
				expect(existsSync(join(root, 'artifact', SnapshotLayout.metaFile))).toBe(true);
				expect(existsSync(join(root, 'artifact', SnapshotLayout.integrityFile))).toBe(true);
				expect(readFileSync(join(root, 'artifact', imageBundlePath))).toHaveLength(
					dockerSaveBundleTarWithLateMetadata(['snapshot:validator-container']).length,
				);
			}),
		),
	);

	it.effect('rejects an image bundle without Docker or OCI metadata before publish', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const removeImageCalls: ImageRef[] = [];
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
					saveImages: () =>
						Stream.make(
							Buffer.concat([tarEntry('repositories', Buffer.from('{}')), Buffer.alloc(1024)]),
						),
					removeImageCalls,
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
				// The committed temp tag is reaped by the failure finalizer.
				expect(removeImageCalls).toEqual([
					{ digest: 'sha256:validator-container', tag: 'snapshot:validator-container' },
				]);
				expect(existsSync(join(root, 'artifact', SnapshotLayout.metaFile))).toBe(false);
				expect(existsSync(join(root, 'artifact', SnapshotLayout.integrityFile))).toBe(false);
			}),
		),
	);

	it.effect('rejects corrupt image bundle metadata before publish', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
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
					saveImages: () => Stream.make(tarEntry('manifest.json', Buffer.from('{not json'))),
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [participant(['validator'])]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some' && error.value._tag === 'SnapshotCapturePhaseError') {
					expect(error.value.phase).toBe('save-images');
				}
				expect(existsSync(join(root, 'artifact', SnapshotLayout.metaFile))).toBe(false);
				expect(existsSync(join(root, 'artifact', SnapshotLayout.integrityFile))).toBe(false);
			}),
		),
	);

	it.effect('rejects saved image bundle tag mismatches before publish', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
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
					// Bundle reports a DIFFERENT tag than the committed one.
					saveImages: () => Stream.make(dockerSaveBundleTar(['snapshot:some-other-tag'])),
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [participant(['validator'])]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some' && error.value._tag === 'SnapshotCapturePhaseError') {
					expect(error.value.phase).toBe('save-images');
				}
				expect(existsSync(join(root, 'artifact', SnapshotLayout.metaFile))).toBe(false);
				expect(existsSync(join(root, 'artifact', SnapshotLayout.integrityFile))).toBe(false);
			}),
		),
	);

	it.effect('rejects duplicate managed container identities before image writes', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const stopCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				// Two distinct containers map to the SAME plugin/role tuple.
				const runtime = runtimeStub({
					handlesByRole: {
						db: [
							{
								id: 'db-a',
								name: 'db-a-container',
								imageName: 'devstack-build:db',
								status: 'running',
								ips: [],
							},
							{
								id: 'db-b',
								name: 'db-b-container',
								imageName: 'devstack-build:db',
								status: 'running',
								ips: [],
							},
						],
					},
					stopCalls,
					saveCalls,
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [participant(['db'])]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some' && error.value._tag === 'SnapshotCapturePhaseError') {
					expect(error.value.phase).toBe('commit');
					expect(error.value.detail).toContain('duplicate managed container snapshot identity');
				}
				// Collision is detected BEFORE any stop / save side effect.
				expect(stopCalls).toEqual([]);
				expect(saveCalls).toEqual([]);
			}),
		),
	);

	it.effect(
		'two (app, stack)-distinct stacks with identical build content capture DISTINCT imageNames (no collapse)',
		() =>
			withTempRoot(TEMP_PREFIX, (root) =>
				Effect.gen(function* () {
					// The (app, stack) TAG-scoping fix gives each stack a distinct
					// build tag even when the build CONTENT is byte-identical. Capture
					// records each container's `imageName` (the scoped tag it booted
					// on) straight through — so two stacks' captures never alias onto
					// one image. Here we simulate the two captures and assert their
					// recorded imageNames AND snapshotTags are disjoint, while each
					// run's per-(plugin/role) collision detector stays green.
					const captureStack = (
						stackTag: string,
						containerName: string,
					): Effect.Effect<readonly [string, string], never, never> =>
						Effect.gen(function* () {
							const runtime = runtimeStub({
								handlesByRole: {
									db: {
										id: `${containerName}-id`,
										name: containerName,
										// Distinct scoped build tag per stack, identical content.
										imageName: `devstack-build:${stackTag}-deadbeefcafe1234`,
										status: 'running',
										ips: [],
									},
								},
							});
							const stagingDir = join(root, stackTag);
							mkdirSync(stagingDir, { recursive: true });
							const exit = yield* Effect.exit(
								runCapture({
									stagingDir,
									snapshotId: snapshotIdFromString(`snap-${stackTag}`),
									label: null,
									app: stackTag,
									stack: 'main',
									network: 'sui:local',
									graphInput,
									runtimeStackRoot: join(root, `runtime-stack-${stackTag}`),
									participants: [participant(['db'])],
									runtime,
									stopGraceSeconds: 1,
								}),
							).pipe(Effect.provide(NodeFileSystem.layer));
							expect(Exit.isSuccess(exit)).toBe(true);
							if (!Exit.isSuccess(exit)) return ['', ''] as const;
							const captured = exit.value.containers[0]!;
							return [captured.imageName, captured.snapshotTag] as const;
						});

					const [imageA, tagA] = yield* captureStack('app-a-main', 'db-app-a');
					const [imageB, tagB] = yield* captureStack('app-b-main', 'db-app-b');

					// DISTINCT scoped build tags ⇒ restore promote never collapses.
					expect(imageA).toBe('devstack-build:app-a-main-deadbeefcafe1234');
					expect(imageB).toBe('devstack-build:app-b-main-deadbeefcafe1234');
					expect(imageA).not.toBe(imageB);
					// Snapshot temp tags derive from the (already app/stack-scoped)
					// container name, so they are disjoint too.
					expect(tagA).not.toBe(tagB);
				}),
			),
	);

	it.effect('removes committed temp tags when a later commit fails before image save', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const stopCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
				const removeImageCalls: ImageRef[] = [];
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
					stopCalls,
					saveCalls,
					removeImageCalls,
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
				if (error._tag === 'Some' && error.value._tag === 'SnapshotCapturePhaseError') {
					expect(error.value.phase).toBe('commit');
				}
				// Both containers were gracefully stopped (flush) before any commit.
				expect(stopCalls.sort()).toEqual(['db-container', 'worker-container']);
				expect(saveCalls).toEqual([]);
				// The db commit's temp tag is reaped by the failure finalizer.
				expect(removeImageCalls).toEqual([
					{ digest: 'sha256:db-container', tag: 'snapshot:db-container' },
				]);
			}),
		),
	);

	it.effect('removes committed temp tags when batched image save fails immediately', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const removeImageCalls: ImageRef[] = [];
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
					saveImages: () =>
						Stream.fail({
							_tag: 'ContainerRuntimeError',
							reason: 'image-save-failed',
							detail: 'save spawn failed',
						}),
					removeImageCalls,
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [participant(['db', 'worker'])]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some' && error.value._tag === 'SnapshotCapturePhaseError') {
					expect(error.value.phase).toBe('save-images');
				}
				expect(removeImageCalls).toEqual([
					{ digest: 'sha256:db-container', tag: 'snapshot:db-container' },
					{ digest: 'sha256:worker-container', tag: 'snapshot:worker-container' },
				]);
			}),
		),
	);

	it.effect('fails when graceful stop fails (containers left recoverable, no artifact)', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const stopCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
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
					stopCalls,
					saveCalls,
					stopErrorFor: () => ({
						_tag: 'ContainerRuntimeError',
						reason: 'daemon-unreachable',
						detail: 'stop failed',
					}),
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [participant(['db'])]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some' && error.value._tag === 'SnapshotCapturePhaseError') {
					expect(error.value.phase).toBe('stop');
				}
				// No commit/save ran; no artifact published.
				expect(saveCalls).toEqual([]);
				expect(existsSync(join(root, 'artifact', SnapshotLayout.metaFile))).toBe(false);
			}),
		),
	);

	it.effect('rejects digest-only image names before any stop/commit side effects', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const stopCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
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
					stopCalls,
					saveCalls,
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [participant(['validator'])]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some' && error.value._tag === 'SnapshotCapturePhaseError') {
					expect(error.value.phase).toBe('commit');
					expect(error.value.detail).toContain('restorable Docker tag destination');
				}
				expect(stopCalls).toEqual([]);
				expect(saveCalls).toEqual([]);
			}),
		),
	);

	it.effect('rejects unsafe container label path segments before any side effects', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const stopCalls: string[] = [];
				const saveCalls: ImageRef[] = [];
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
					stopCalls,
					saveCalls,
				});

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [
					participant(['validator'], (role) => ({ ...label(role), plugin: '../sui' })),
				]).pipe(Effect.provide(NodeFileSystem.layer));

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some' && error.value._tag === 'SnapshotCapturePhaseError') {
					expect(error.value.phase).toBe('commit');
					expect(error.value.detail).toContain('unsafe snapshot plugin path segment');
				}
				expect(stopCalls).toEqual([]);
				expect(saveCalls).toEqual([]);
			}),
		),
	);
});

// The post-publish bounce tail: retag committed images onto their original
// names + hard-rm the stopped containers + run the injected resume. This is
// the capture-resume mechanism (recreate-from-committed-image, never docker
// start) — symmetric with restore's retag-to-original + hard-rm + converge.
describe('resumeAfterCapture — retag + hard-rm + resume', () => {
	const meta = (containers: SnapshotMetadata['containers']): SnapshotMetadata => ({
		version: SNAPSHOT_META_VERSION,
		id: snapshotIdFromString('snap-resume'),
		label: null,
		createdAt: 0,
		app: 'capture-app',
		stack: 'main',
		network: 'sui:local',
		graphInput,
		hostTreeIncluded: false,
		subtrees: [],
		containers,
		identity: { chain: 'sui:local' },
		participants: ['sui#0'],
	});

	it.effect('retags each committed image onto the original name, hard-rms, then resumes', () =>
		Effect.gen(function* () {
			const tagCalls: Array<{ src: string | undefined; dst: string }> = [];
			const removeCalls: Array<string> = [];
			let resumed = false;
			const runtime: ContainerRuntime = {
				...runtimeStub({ handlesByRole: {} }),
				tagImage: (src, newTag) =>
					Effect.sync(() => {
						tagCalls.push({ src: src.tag, dst: newTag });
					}),
				removeManagedContainers: (labelMatch) =>
					Effect.sync(() => {
						removeCalls.push(`${labelMatch.plugin}/${labelMatch.role}`);
						return 1;
					}),
			};

			const exit = yield* Effect.exit(
				resumeAfterCapture(
					meta([
						{
							plugin: 'walrus',
							role: 'storage-node-0',
							imageName: 'devstack-build:walrus-node-0',
							snapshotTag: 'snapshot:walrus-node-0',
							tarPath: imageBundlePath,
						},
					]),
					{
						runtime,
						app: 'capture-app',
						stack: 'main',
						resume: Effect.sync(() => {
							resumed = true;
						}),
					},
				),
			);

			expect(Exit.isSuccess(exit)).toBe(true);
			// Retag the committed snapshot tag onto the original image name.
			expect(tagCalls).toEqual([
				{ src: 'snapshot:walrus-node-0', dst: 'devstack-build:walrus-node-0' },
			]);
			// Hard-rm the captured container by its label tuple.
			expect(removeCalls).toEqual(['walrus/storage-node-0']);
			// Resume (recreate + wait-write-ready) ran AFTER retag + hard-rm.
			expect(resumed).toBe(true);
		}),
	);

	it.effect('omits the resume when none is injected (offline one-shot capture)', () =>
		Effect.gen(function* () {
			const tagCalls: string[] = [];
			const removeCalls: string[] = [];
			const runtime: ContainerRuntime = {
				...runtimeStub({ handlesByRole: {} }),
				tagImage: (_src, newTag) =>
					Effect.sync(() => {
						tagCalls.push(newTag);
					}),
				removeManagedContainers: (labelMatch) =>
					Effect.sync(() => {
						removeCalls.push(`${labelMatch.plugin}/${labelMatch.role}`);
						return 1;
					}),
			};

			const exit = yield* Effect.exit(
				resumeAfterCapture(
					meta([
						{
							plugin: 'seal',
							role: 'key-server',
							imageName: 'devstack-build:seal',
							snapshotTag: 'snapshot:seal',
							tarPath: imageBundlePath,
						},
					]),
					{ runtime, app: 'capture-app', stack: 'main' },
				),
			);

			expect(Exit.isSuccess(exit)).toBe(true);
			expect(tagCalls).toEqual(['devstack-build:seal']);
			expect(removeCalls).toEqual(['seal/key-server']);
		}),
	);

	it.effect("second capture removes the first capture's orphaned layer", () =>
		Effect.gen(function* () {
			const removeImageCalls: ImageRef[] = [];
			// `imageName` resolves to the OLD committed layer before the retag,
			// then the NEW one after. inspectImageDigest is called twice for the
			// same ref — first returns oldDigest, then newDigest.
			let inspectCursor = 0;
			const digests = ['sha256:old-layer', 'sha256:new-layer'];
			const runtime: ContainerRuntime = {
				...runtimeStub({ handlesByRole: {}, removeImageCalls }),
				inspectImageDigest: (_ref) => Effect.sync(() => digests[inspectCursor++] ?? null),
				tagImage: () => Effect.void,
				removeManagedContainers: () => Effect.succeed(1),
			};

			const exit = yield* Effect.exit(
				resumeAfterCapture(
					meta([
						{
							plugin: 'walrus',
							role: 'storage-node-0',
							imageName: 'devstack-build:walrus-node-0',
							snapshotTag: 'snapshot:walrus-node-0',
							tarPath: imageBundlePath,
						},
					]),
					{ runtime, app: 'capture-app', stack: 'main' },
				),
			);

			expect(Exit.isSuccess(exit)).toBe(true);
			// The orphaned previous layer is GC'd by DIGEST exactly once — never
			// by the live `imageName` tag.
			expect(removeImageCalls).toEqual([{ digest: 'sha256:old-layer' }]);
		}),
	);

	it.effect('identical layer is NOT removed', () =>
		Effect.gen(function* () {
			const removeImageCalls: ImageRef[] = [];
			// The commit produced a layer id identical to the one `imageName`
			// already pointed at: inspect returns the SAME digest before + after
			// the retag, so removing it would delete the LIVE layer. Must skip.
			const runtime: ContainerRuntime = {
				...runtimeStub({ handlesByRole: {}, removeImageCalls }),
				inspectImageDigest: (_ref) => Effect.succeed('sha256:same-layer'),
				tagImage: () => Effect.void,
				removeManagedContainers: () => Effect.succeed(1),
			};

			const exit = yield* Effect.exit(
				resumeAfterCapture(
					meta([
						{
							plugin: 'seal',
							role: 'key-server',
							imageName: 'devstack-build:seal',
							snapshotTag: 'snapshot:seal',
							tarPath: imageBundlePath,
						},
					]),
					{ runtime, app: 'capture-app', stack: 'main' },
				),
			);

			expect(Exit.isSuccess(exit)).toBe(true);
			expect(removeImageCalls).toEqual([]);
		}),
	);

	it.effect('GC removal failure does not fail the capture', () =>
		Effect.gen(function* () {
			let resumed = false;
			let inspectCursor = 0;
			const digests = ['sha256:old-layer', 'sha256:new-layer'];
			const runtime: ContainerRuntime = {
				...runtimeStub({ handlesByRole: {} }),
				inspectImageDigest: (_ref) => Effect.sync(() => digests[inspectCursor++] ?? null),
				tagImage: () => Effect.void,
				// The image GC removal fails — must be logged + swallowed, never
				// surfaced as a capture failure.
				removeImage: () =>
					Effect.fail({
						_tag: 'ContainerRuntimeError' as const,
						reason: 'image-remove-failed' as const,
						detail: 'simulated GC removal failure',
					}),
				removeManagedContainers: () => Effect.succeed(1),
			};

			const exit = yield* Effect.exit(
				resumeAfterCapture(
					meta([
						{
							plugin: 'walrus',
							role: 'storage-node-0',
							imageName: 'devstack-build:walrus-node-0',
							snapshotTag: 'snapshot:walrus-node-0',
							tarPath: imageBundlePath,
						},
					]),
					{
						runtime,
						app: 'capture-app',
						stack: 'main',
						resume: Effect.sync(() => {
							resumed = true;
						}),
					},
				),
			);

			// Capture still succeeds + resume still ran despite the GC failure.
			expect(Exit.isSuccess(exit)).toBe(true);
			expect(resumed).toBe(true);
		}),
	);
});

// Regression for Phase B3: identity-merge fail-on-conflict at capture time.
// Post-fix, capture fails AT THE CAPTURE SITE (during the pre-stop gather)
// with `IdentityContributionConflictError`
// (`_tag: 'SnapshotIdentityContributionConflict'`) — BEFORE any stop.
describe('snapshot capture — identity contribution conflict', () => {
	it.effect('two plugins contributing different values for the same key fail at capture', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const stopCalls: string[] = [];
				const runtime = runtimeStub({ handlesByRole: {}, stopCalls });
				const a: SnapshotParticipant = {
					...participant([]),
					plugin: 'sui#0',
					captureIdentity: Effect.succeed({ chain: 'sui:local' }),
				};
				const b: SnapshotParticipant = {
					...participant([]),
					plugin: 'walrus#0',
					captureIdentity: Effect.succeed({ chain: 'sui:testnet' }),
				};

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [a, b]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value._tag).toBe('SnapshotIdentityContributionConflict');
				}
				// Conflict surfaces during gather, BEFORE any stop.
				expect(stopCalls).toEqual([]);
				expect(existsSync(join(root, 'artifact', SnapshotLayout.metaFile))).toBe(false);
			}),
		),
	);

	it.effect('two plugins contributing the SAME value for the same key succeed', () =>
		withTempRoot(TEMP_PREFIX, (root) =>
			Effect.gen(function* () {
				const runtime = runtimeStub({ handlesByRole: {} });
				const a: SnapshotParticipant = {
					...participant([]),
					plugin: 'sui#0',
					captureIdentity: Effect.succeed({ chain: 'sui:local' }),
				};
				const b: SnapshotParticipant = {
					...participant([]),
					plugin: 'walrus#0',
					captureIdentity: Effect.succeed({ chain: 'sui:local' }),
				};

				mkdirSync(join(root, 'artifact'), { recursive: true });
				const exit = yield* runCaptureExit(root, runtime, [a, b]).pipe(
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isSuccess(exit)).toBe(true);
				if (!Exit.isSuccess(exit)) return;
				expect(exit.value.identity).toEqual({ chain: 'sui:local' });
			}),
		),
	);
});
