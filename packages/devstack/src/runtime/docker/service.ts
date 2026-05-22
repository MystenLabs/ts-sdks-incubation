// `ContainerRuntime` capability — Docker reference implementation.
//
// Composes the subsystems in this directory into the contract surface
// declared in `contracts/container-runtime.ts`. Plugins consume the
// `ContainerRuntime` interface through this service; the typed
// docker-specific error variants are accessible to advanced consumers
// via the underlying subsystems but the public surface projects to
// the contract's narrow `ContainerRuntimeError`.

import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { Context, Duration, Effect, Layer, Ref, Stream } from 'effect';

import type {
	ContainerBuildContext,
	ContainerHandle,
	ContainerRuntime,
	ContainerRuntimeError,
	EnsureContainerSpec,
	EnsureNetworkSpec,
	ExecOptions,
	ExecResult,
	ImageRef,
	LoadedImageBundle,
	OneShotSpec,
	SaveImageOptions,
	TagImageOptions,
	TaggedImageRef,
} from '../../contracts/container-runtime.ts';
import type { ContainerLabelTuple } from '../../contracts/snapshotable.ts';
import { chainId, contentHash } from '../../substrate/brand.ts';
import { CacheService } from '../../substrate/runtime/cache/index.ts';
import { StackPathsService } from '../../substrate/runtime/paths.ts';
import { DockerHost, DockerSpawner } from './client.ts';
import {
	assertContainerHandleOwned,
	commit,
	ensureContainer,
	inspectContainer,
	pause,
	type PerNameLockState,
	stop as stopContainer,
	unpause,
} from './container.ts';
import { toContractError } from './errors.ts';
import { dockerExec, dockerRunOneShot } from './exec.ts';
import {
	ensureImageCached,
	loadImage as loadImageImpl,
	pull as pullImageImpl,
	refOf,
	removeImage as removeImageImpl,
	saveImage as saveImageStream,
	saveImages as saveImagesStream,
	tagImage as tagImageImpl,
} from './image.ts';
import { listContainers } from './inventory.ts';
import { followLogs as followLogsStream } from './logs.ts';
import { ensureNetwork as ensureNetworkImpl } from './network.ts';
import {
	removeManagedContainers,
	removeManagedImages,
	removeManagedNetworks,
	removeManagedVolumes,
	sweepOrphans,
} from './sweep.ts';

// -----------------------------------------------------------------------------
// Service tag — `Context.Service` per Effect-v4 idioms
// -----------------------------------------------------------------------------

export class ContainerRuntimeService extends Context.Service<
	ContainerRuntimeService,
	ContainerRuntime
>()('@devstack-rewrite/runtime-docker/ContainerRuntime') {}

// -----------------------------------------------------------------------------
// Cycle counter — stamped on container labels at create time
// -----------------------------------------------------------------------------

export class DockerCycle extends Context.Service<DockerCycle, Ref.Ref<number>>()(
	'@devstack-rewrite/runtime-docker/Cycle',
) {}

export const layerDockerCycleInitial: Layer.Layer<DockerCycle> = Layer.effect(
	DockerCycle,
	Effect.gen(function* () {
		const ref = yield* Ref.make(0);
		return ref;
	}),
);

// -----------------------------------------------------------------------------
// Layer — wire the subsystems into the contract interface
// -----------------------------------------------------------------------------

const mapToContractError = <R, A>(
	eff: Effect.Effect<A, import('./errors.ts').DockerRuntimeError, R>,
): Effect.Effect<A, ContainerRuntimeError, R> => eff.pipe(Effect.mapError(toContractError));

const snapshotTempTag = (containerName: string): string => {
	const safeName = containerName.replace(/[^A-Za-z0-9_.-]/g, '-');
	const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
	return `devstack-snapshot:${safeName}-${suffix}`;
};

const stableRelativePath = (root: string, path: string): string => {
	const rel = relative(root, path);
	return rel.length === 0 ? '.' : rel.split(sep).join('/');
};

const updateContextEntryHash = (
	hash: ReturnType<typeof createHash>,
	root: string,
	path: string,
): void => {
	const stat = lstatSync(path);
	const rel = stableRelativePath(root, path);

	if (stat.isDirectory()) {
		hash.update('dir\0');
		hash.update(rel);
		hash.update('\0');
		for (const child of readdirSync(path).sort((a, b) => a.localeCompare(b))) {
			updateContextEntryHash(hash, root, join(path, child));
		}
		return;
	}

	if (stat.isFile()) {
		hash.update('file\0');
		hash.update(rel);
		hash.update('\0');
		hash.update(String(stat.mode));
		hash.update('\0');
		hash.update(readFileSync(path));
		hash.update('\0');
		return;
	}

	if (stat.isSymbolicLink()) {
		hash.update('symlink\0');
		hash.update(rel);
		hash.update('\0');
		hash.update(readlinkSync(path));
		hash.update('\0');
		return;
	}

	hash.update('other\0');
	hash.update(rel);
	hash.update('\0');
	hash.update(String(stat.mode));
	hash.update('\0');
};

const buildContextFingerprint = (contextPath: string): string => {
	const hash = createHash('sha256');
	try {
		updateContextEntryHash(hash, contextPath, contextPath);
	} catch (err) {
		hash.update('unreadable\0');
		hash.update(String(err));
		hash.update('\0');
	}
	return hash.digest('hex');
};

/** Stable content hash for the build context. Sorts build args so two
 *  equivalent specs whose key insertion order differs produce the same
 *  hash. The Docker build context's files are part of the key: changing
 *  a vendored entrypoint script must force a new managed image tag. */
export const buildContentHash = (ctx: ContainerBuildContext): string => {
	const dockerfile = ctx.dockerfile ?? 'Dockerfile';
	const sortedArgs = Object.entries(ctx.buildArgs ?? {}).sort(([a], [b]) => a.localeCompare(b));
	const argsKey = sortedArgs.map(([k, v]) => `${k}=${v}`).join('\x00');
	const platform = ctx.platform ?? '';
	return createHash('sha256')
		.update(ctx.contextPath)
		.update('\x00')
		.update(dockerfile)
		.update('\x00')
		.update(platform)
		.update('\x00')
		.update(argsKey)
		.update('\x00')
		.update(buildContextFingerprint(ctx.contextPath))
		.digest('hex');
};

export const layerContainerRuntimeDocker: Layer.Layer<
	ContainerRuntimeService,
	never,
	CacheService | DockerHost | DockerSpawner | DockerCycle | StackPathsService
> = Layer.effect(
	ContainerRuntimeService,
	Effect.gen(function* () {
		const cycleRef = yield* DockerCycle;
		// Snapshot the substrate services so we can provide them to the
		// closures that implement the contract's R=never surface.
		const dockerHost = yield* DockerHost;
		const dockerSpawner = yield* DockerSpawner;
		const stackPaths = yield* StackPathsService;
		const cache = yield* CacheService;
		const baseCtx = Context.empty().pipe(
			Context.add(DockerHost, dockerHost),
			Context.add(DockerSpawner, dockerSpawner),
			Context.add(StackPathsService, stackPaths),
			Context.add(CacheService, cache),
		);
		// Per-name in-process serialization. Architecture invariant:
		// two concurrent ensureContainer calls for the same name must
		// not interleave docker inspect/create/start. The cross-process
		// safety is the daemon's `--name` atomicity (see container.ts
		// collision recovery). The in-process side is this ref.
		const perNameLock = yield* Ref.make<PerNameLockState>(new Map());

		const ensureImage = (
			ctx: ContainerBuildContext,
			expected?: ImageRef,
		): Effect.Effect<ImageRef, ContainerRuntimeError> => {
			// Architecture §8: bring-your-own-image vs build is a closed sum.
			// The contract accepts `ContainerBuildContext` (build path);
			// pull is exposed via `image.ts::pull` directly to plugins
			// that need it (not through this contract entry point).
			//
			// Content-addressed cache: namespace is the constant
			// `runtime-docker-build` (one substrate-owned namespace);
			// chain is `n/a` (build artifacts are chain-independent);
			// contentHash is a hash of the build context's identifying
			// fields. The caller-supplied `expected.tag`, when present,
			// is honoured as the on-host tag; absent, we derive a tag
			// from the content hash so two unrelated contexts cannot
			// collide on the sanitized contextPath form.
			const hash = buildContentHash(ctx);
			const tag = expected?.tag ?? `devstack-build:${hash.slice(0, 16)}`;
			return ensureImageCached(
				{
					contextPath: ctx.contextPath,
					dockerfile: ctx.dockerfile,
					platform: ctx.platform,
					buildArgs: ctx.buildArgs,
					tag,
				},
				{
					namespace: 'runtime-docker-build',
					chain: chainId('n/a'),
					contentHash: contentHash(hash),
				},
			).pipe(
				Effect.map((digest) => refOf(digest, tag)),
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.ensureImage'),
			);
		};

		const ensureNetworkContractImpl = (
			spec: EnsureNetworkSpec,
		): Effect.Effect<string, ContainerRuntimeError> =>
			ensureNetworkImpl(spec.name, {
				app: spec.app,
				stack: spec.stack,
				...(spec.subnet === undefined ? {} : { subnet: spec.subnet }),
				...(spec.gateway === undefined ? {} : { gateway: spec.gateway }),
			}).pipe(
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.ensureNetwork'),
			);

		const pullImageContractImpl = (ref: string): Effect.Effect<ImageRef, ContainerRuntimeError> =>
			pullImageImpl(ref).pipe(
				Effect.map((digest) => refOf(digest, ref)),
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.pullImage'),
			);

		const ensureContainerImpl = (
			spec: EnsureContainerSpec,
		): Effect.Effect<ContainerHandle, ContainerRuntimeError, import('effect').Scope.Scope> =>
			Effect.gen(function* () {
				const cycle = yield* Ref.get(cycleRef);
				return yield* ensureContainer(spec, { cycle, perNameLock });
			}).pipe(
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.ensureContainer'),
			);

		const inspectByLabels = (
			labels: ContainerLabelTuple,
		): Effect.Effect<ReadonlyArray<ContainerHandle>, ContainerRuntimeError> =>
			Effect.gen(function* () {
				const summaries = yield* listContainers(labels);
				return yield* Effect.forEach(
					summaries,
					(s) =>
						inspectContainer(s.name).pipe(
							Effect.map(
								(facts): ContainerHandle => ({
									id: facts?.id ?? s.id,
									name: s.name,
									labels,
									imageName: facts?.image ?? s.image,
									status: (facts?.paused
										? 'paused'
										: (facts?.running ?? s.state === 'running')
											? 'running'
											: s.state === 'paused'
												? 'paused'
												: s.state === 'created'
													? 'created'
													: 'exited') as ContainerHandle['status'],
									ips: [],
									...(facts?.ports !== undefined ? { ports: facts.ports } : {}),
								}),
							),
						),
					{ concurrency: 'unbounded' },
				);
			}).pipe(
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.inspectByLabels'),
			);

		const followLogsImpl = (
			handle: ContainerHandle,
		): Stream.Stream<string, ContainerRuntimeError> =>
			followLogsStream(handle.name).pipe(
				Stream.mapError(toContractError),
				// R-channel: the underlying stream needs DockerHost +
				// DockerSpawner from the spawn step. Provide the
				// snapshotted base context so the contract surface is
				// `R = never`. `Stream.mapError` does NOT drop R; the
				// `as`-cast in the previous shape was a release-blocker
				// per runtime-docker review issue #3.
				Stream.provideContext(baseCtx),
			);

		const pauseAndCommitImpl = (
			handle: ContainerHandle,
		): Effect.Effect<TaggedImageRef, ContainerRuntimeError> =>
			Effect.gen(function* () {
				yield* assertContainerHandleOwned(handle);
				if (handle.status === 'running') {
					yield* pause(handle.name);
					yield* assertContainerHandleOwned(handle);
				}
				const tag = snapshotTempTag(handle.name);
				const digest = yield* commit(handle.name, tag);
				return { digest, tag };
			}).pipe(
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.pauseAndCommit'),
			);

		const pauseImpl = (handle: ContainerHandle): Effect.Effect<void, ContainerRuntimeError> =>
			Effect.gen(function* () {
				yield* assertContainerHandleOwned(handle);
				yield* pause(handle.name);
			}).pipe(
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.pause'),
			);

		const unpauseImpl = (handle: ContainerHandle): Effect.Effect<void, ContainerRuntimeError> =>
			Effect.gen(function* () {
				yield* assertContainerHandleOwned(handle);
				yield* unpause(handle.name);
			}).pipe(
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.unpause'),
			);

		const stopImpl = (
			handle: ContainerHandle,
			grace: Duration.Duration,
		): Effect.Effect<void, ContainerRuntimeError> => {
			const seconds = Math.max(0, Math.ceil(Duration.toMillis(grace) / 1000));
			return Effect.gen(function* () {
				yield* assertContainerHandleOwned(handle);
				yield* stopContainer(handle.name, seconds);
			}).pipe(
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.stop'),
			);
		};

		const sweepOrphansImpl = (
			labelMatch: Partial<ContainerLabelTuple>,
		): Effect.Effect<number, ContainerRuntimeError> =>
			sweepOrphans(labelMatch).pipe(
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.sweepOrphans'),
			);

		const removeManagedContainersImpl = (
			labelMatch: Partial<ContainerLabelTuple>,
		): Effect.Effect<number, ContainerRuntimeError> =>
			removeManagedContainers(labelMatch).pipe(
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.removeManagedContainers'),
			);

		const removeManagedImagesImpl = (
			labelMatch: Partial<ContainerLabelTuple>,
		): Effect.Effect<number, ContainerRuntimeError> =>
			removeManagedImages(labelMatch).pipe(
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.removeManagedImages'),
			);

		const removeManagedNetworksImpl = (
			labelMatch: Partial<ContainerLabelTuple>,
		): Effect.Effect<number, ContainerRuntimeError> =>
			removeManagedNetworks(labelMatch).pipe(
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.removeManagedNetworks'),
			);

		const removeManagedVolumesImpl = (
			labelMatch: Partial<ContainerLabelTuple>,
		): Effect.Effect<number, ContainerRuntimeError> =>
			removeManagedVolumes(labelMatch).pipe(
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.removeManagedVolumes'),
			);

		const execImpl = (
			handle: ContainerHandle,
			argv: ReadonlyArray<string>,
			opts?: ExecOptions,
		): Effect.Effect<ExecResult, ContainerRuntimeError> =>
			Effect.gen(function* () {
				yield* assertContainerHandleOwned(handle);
				return yield* dockerExec(handle.name, argv, {
					user: opts?.user,
					env: opts?.env,
					workdir: opts?.workdir,
				});
			}).pipe(
				// Contract surface: NEVER promote non-zero exit to failure
				// here. The caller is the policy holder.
				Effect.map(
					(r): ExecResult => ({
						exitCode: r.exitCode,
						stdout: r.stdout,
						stderr: r.stderr,
					}),
				),
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.exec'),
			);

		const saveImageImpl = (
			ref: ImageRef,
			opts?: SaveImageOptions,
		): Stream.Stream<Uint8Array, ContainerRuntimeError> => {
			const resolved = ref.tag ?? ref.digest;
			return saveImageStream(resolved, opts).pipe(
				Stream.mapError(toContractError),
				Stream.provideContext(baseCtx),
			);
		};
		const saveImagesImpl = (
			refs: ReadonlyArray<ImageRef>,
			opts?: SaveImageOptions,
		): Stream.Stream<Uint8Array, ContainerRuntimeError> => {
			const resolved = refs.map((ref) => ref.tag ?? ref.digest);
			return saveImagesStream(resolved, opts).pipe(
				Stream.mapError(toContractError),
				Stream.provideContext(baseCtx),
			);
		};

		const loadImageContractImpl = (
			tar: Stream.Stream<Uint8Array, unknown>,
		): Effect.Effect<LoadedImageBundle, ContainerRuntimeError> =>
			loadImageImpl(tar).pipe(
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.loadImage'),
			);

		const tagImageContractImpl = (
			src: ImageRef,
			newTag: string,
			opts?: TagImageOptions,
		): Effect.Effect<void, ContainerRuntimeError> => {
			const resolved = src.tag ?? src.digest;
			return tagImageImpl(resolved, newTag, opts).pipe(
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.tagImage'),
			);
		};

		const removeImageContractImpl = (ref: ImageRef): Effect.Effect<void, ContainerRuntimeError> => {
			const resolved = ref.tag ?? ref.digest;
			return removeImageImpl(resolved).pipe(
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.removeImage'),
			);
		};

		const runOneShotImpl = (
			spec: OneShotSpec,
		): Effect.Effect<ExecResult, ContainerRuntimeError, import('effect').Scope.Scope> =>
			dockerRunOneShot({
				image: spec.image.tag ?? spec.image.digest,
				argv: spec.argv,
				env: spec.env,
				mounts: spec.mounts,
				network: spec.network,
				entrypoint: spec.entrypoint,
				user: spec.user,
				timeoutMillis: spec.timeoutMillis,
				extraHosts: spec.extraHosts,
			}).pipe(
				// Same contract: never promote non-zero exit to failure.
				Effect.map(
					(r): ExecResult => ({
						exitCode: r.exitCode,
						stdout: r.stdout,
						stderr: r.stderr,
					}),
				),
				mapToContractError,
				Effect.provide(baseCtx),
				Effect.withSpan('runtime.docker.contract.runOneShot'),
			);

		return ContainerRuntimeService.of({
			ensureImage,
			pullImage: pullImageContractImpl,
			ensureNetwork: ensureNetworkContractImpl,
			ensureContainer: ensureContainerImpl,
			exec: execImpl,
			runOneShot: runOneShotImpl,
			inspectByLabels,
			followLogs: followLogsImpl,
			pause: pauseImpl,
			pauseAndCommit: pauseAndCommitImpl,
			saveImage: saveImageImpl,
			saveImages: saveImagesImpl,
			loadImage: loadImageContractImpl,
			tagImage: tagImageContractImpl,
			removeImage: removeImageContractImpl,
			unpause: unpauseImpl,
			stop: stopImpl,
			sweepOrphans: sweepOrphansImpl,
			removeManagedContainers: removeManagedContainersImpl,
			removeManagedImages: removeManagedImagesImpl,
			removeManagedNetworks: removeManagedNetworksImpl,
			removeManagedVolumes: removeManagedVolumesImpl,
		});
	}),
);
