// `ContainerRuntime` capability — Docker reference implementation.
//
// Composes the subsystems in this directory into the contract surface
// declared in `contracts/container-runtime.ts`. Plugins consume the
// `ContainerRuntime` interface through this service; the typed
// docker-specific error variants are accessible to advanced consumers
// via the underlying subsystems but the public surface projects to
// the contract's narrow `ContainerRuntimeError`.

import { createHash } from 'node:crypto';
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
import { contentHash } from '../../substrate/brand.ts';
import { mintRandomSuffix } from '../../substrate/runtime/random-suffix.ts';
import { CacheService } from '../../substrate/runtime/cache/index.ts';
import { StackPathsService } from '../../substrate/runtime/paths.ts';
import { DockerHost, DockerSpawner, dockerRunOk } from './client.ts';
import {
	assertContainerHandleOwned,
	commit,
	ensureContainer,
	inspectContainer,
	pause,
	type PerNameLockState,
	stop as stopContainer,
} from './container.ts';
import { toContractError } from './errors.ts';
import { dockerExec, dockerRunOneShot } from './exec.ts';
import {
	ensureImageCached,
	imageExists,
	loadImage as loadImageImpl,
	pull as pullImageImpl,
	refOf,
	removeImage as removeImageImpl,
	saveImages as saveImagesStream,
	tagImage as tagImageImpl,
} from './image.ts';
import { listContainers } from './inventory.ts';
import { expectedImageOwnershipLabels, sanitizeTagSegment } from './labels.ts';
import { ensureNetwork as ensureNetworkImpl } from './network.ts';
import {
	removeManagedContainers,
	removeManagedImages,
	removeManagedNetworks,
	removeManagedVolumes,
} from './sweep.ts';

// -----------------------------------------------------------------------------
// Service tag — `Context.Service` per Effect-v4 idioms
// -----------------------------------------------------------------------------

export class ContainerRuntimeService extends Context.Service<
	ContainerRuntimeService,
	ContainerRuntime
>()('@devstack/runtime-docker/ContainerRuntime') {}

// -----------------------------------------------------------------------------
// Cycle counter — stamped on container labels at create time
// -----------------------------------------------------------------------------

export class DockerCycle extends Context.Service<DockerCycle, Ref.Ref<number>>()(
	'@devstack/runtime-docker/Cycle',
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
	const suffix = mintRandomSuffix(12);
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

const normalizeFingerprintPath = (path: string): string =>
	path
		.split(/[\\/]+/g)
		.filter((part) => part.length > 0)
		.join('/');

const normalizeFingerprintPaths = (
	paths: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> =>
	[...new Set((paths ?? []).map(normalizeFingerprintPath).filter((path) => path.length > 0))].sort(
		(a, b) => a.localeCompare(b),
	);

const buildContextFingerprint = (
	contextPath: string,
	fingerprintPaths?: ReadonlyArray<string>,
): string => {
	const hash = createHash('sha256');
	const requestedPaths = normalizeFingerprintPaths(fingerprintPaths);
	const paths = requestedPaths.length === 0 ? null : requestedPaths;
	try {
		if (paths === null) {
			updateContextEntryHash(hash, contextPath, contextPath);
		} else {
			for (const relPath of paths) {
				hash.update('fingerprint-path\0');
				hash.update(relPath);
				hash.update('\0');
				updateContextEntryHash(hash, contextPath, join(contextPath, relPath));
			}
		}
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
	const fingerprintPathsKey = normalizeFingerprintPaths(ctx.fingerprintPaths).join('\x00');
	return createHash('sha256')
		.update(ctx.contextPath)
		.update('\x00')
		.update(dockerfile)
		.update('\x00')
		.update(platform)
		.update('\x00')
		.update(argsKey)
		.update('\x00')
		.update(fingerprintPathsKey)
		.update('\x00')
		.update(buildContextFingerprint(ctx.contextPath, ctx.fingerprintPaths))
		.digest('hex');
};

const DOCKER_ARCH_ALIASES: Readonly<Record<string, string>> = {
	aarch64: 'arm64',
	arm64: 'arm64',
	x86_64: 'amd64',
	amd64: 'amd64',
};

export const normalizeDockerInfoPlatform = (raw: string): string | null => {
	const trimmed = raw.trim();
	const slash = trimmed.indexOf('/');
	if (slash <= 0 || slash === trimmed.length - 1) return null;
	const os = trimmed.slice(0, slash);
	const arch = trimmed.slice(slash + 1);
	const normalizedArch = DOCKER_ARCH_ALIASES[arch] ?? arch;
	return `${os}/${normalizedArch}`;
};

const inferDockerBuildPlatform = (): Effect.Effect<
	string | null,
	never,
	DockerHost | DockerSpawner
> =>
	dockerRunOk('info', ['--format', '{{.OSType}}/{{.Architecture}}']).pipe(
		Effect.map((result) =>
			result.exitCode === 0 ? normalizeDockerInfoPlatform(result.stdout) : null,
		),
		Effect.catch(() => Effect.succeed(null)),
	);

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
		): Effect.Effect<ImageRef, ContainerRuntimeError> =>
			Effect.gen(function* () {
				const inferredPlatform =
					ctx.platform === undefined
						? yield* inferDockerBuildPlatform().pipe(Effect.provide(baseCtx))
						: null;
				const effectiveCtx =
					ctx.platform === undefined && inferredPlatform !== null
						? { ...ctx, platform: inferredPlatform }
						: ctx;
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
				//
				// (app, stack) TAG SCOPING. The derived tag is scoped by the
				// owner's `(app, stack)` — `devstack-build:<app>-<stack>-<hash16>`.
				// The CACHE KEY below stays content-only (`{namespace, chain,
				// contentHash}`), so two stacks with identical build context
				// still SHARE the build (no redundant rebuild) — only the on-host
				// TAG differs. This is load-bearing for snapshot/restore: each
				// running container commits its writable layer onto its own
				// `imageName` (this tag). Without scoping, two stacks whose build
				// context is byte-identical share ONE tag, so capture/restore's
				// per-container image-promote collapses their committed layers
				// onto that single name (last-write-wins) — e.g. app A's sui
				// indexer-db PGDATA gets aliased under app B's container and the
				// db rejects auth ("FATAL: password authentication failed").
				// Stays aligned with #23's sidecar-password fix
				// (`deriveSidecarPassword(app, stack, role)`): both keyed on
				// (app, stack). Label-free builds (no owner — e.g.
				// `move-summary-runner`) stay UNSCOPED.
				//
				const hash = buildContentHash(effectiveCtx);
				const owner = effectiveCtx.owner;
				const scope =
					owner !== undefined
						? `${sanitizeTagSegment(owner.app)}-${sanitizeTagSegment(owner.stack)}-`
						: '';
				const tag = expected?.tag ?? `devstack-build:${scope}${hash.slice(0, 16)}`;
				// Owner identity flows through as `--label` flags on
				// `docker build`, making the resulting image visible to
				// label-driven prune. Labels are metadata, NOT part of
				// the cache key — an unlabelled cached image stays a cache
				// hit, and label-driven prune reaps it.
				const ownerLabels =
					effectiveCtx.owner !== undefined
						? expectedImageOwnershipLabels(effectiveCtx.owner)
						: undefined;
				return yield* ensureImageCached(
					{
						contextPath: effectiveCtx.contextPath,
						dockerfile: effectiveCtx.dockerfile,
						platform: effectiveCtx.platform,
						buildArgs: effectiveCtx.buildArgs,
						tag,
						...(ownerLabels !== undefined && { labels: ownerLabels }),
					},
					{
						namespace: 'runtime-docker-build',
						chain: 'n/a',
						contentHash: contentHash(hash),
					},
				).pipe(
					Effect.map((digest) => refOf(digest, tag)),
					mapToContractError,
					Effect.provide(baseCtx),
				);
			});

		const ensureNetworkContractImpl = (
			spec: EnsureNetworkSpec,
		): Effect.Effect<string, ContainerRuntimeError> =>
			ensureNetworkImpl(spec.name, {
				app: spec.app,
				stack: spec.stack,
				...(spec.subnet === undefined ? {} : { subnet: spec.subnet }),
				...(spec.gateway === undefined ? {} : { gateway: spec.gateway }),
			}).pipe(mapToContractError, Effect.provide(baseCtx));

		const pullImageContractImpl = (ref: string): Effect.Effect<ImageRef, ContainerRuntimeError> =>
			pullImageImpl(ref).pipe(
				Effect.map((digest) => refOf(digest, ref)),
				mapToContractError,
				Effect.provide(baseCtx),
			);

		const ensureContainerImpl = (
			spec: EnsureContainerSpec,
		): Effect.Effect<ContainerHandle, ContainerRuntimeError, import('effect').Scope.Scope> =>
			Effect.gen(function* () {
				const cycle = yield* Ref.get(cycleRef);
				return yield* ensureContainer(spec, { cycle, perNameLock });
			}).pipe(mapToContractError, Effect.provide(baseCtx));

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
									// Surface the inspected exit code whenever Docker
									// supplied a `State` (running / exited-0 → `0`; only an
									// omitted-`State` inspect leaves `exitCode` null →
									// `lastExitCode` absent) so callers can gate on a
									// SIGKILL/OOM `137` crash-recreate — the signal sui's
									// indexer-db sidecar resets on.
									...(facts?.exitCode != null ? { lastExitCode: facts.exitCode } : {}),
								}),
							),
						),
					{ concurrency: 'unbounded' },
				);
			}).pipe(mapToContractError, Effect.provide(baseCtx));

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
			}).pipe(mapToContractError, Effect.provide(baseCtx));

		const stopImpl = (
			handle: ContainerHandle,
			grace: Duration.Duration,
		): Effect.Effect<void, ContainerRuntimeError> => {
			const seconds = Math.max(0, Math.ceil(Duration.toMillis(grace) / 1000));
			return Effect.gen(function* () {
				yield* assertContainerHandleOwned(handle);
				yield* stopContainer(handle.name, seconds);
			}).pipe(mapToContractError, Effect.provide(baseCtx));
		};

		const removeManagedContainersImpl = (
			labelMatch: Partial<ContainerLabelTuple>,
		): Effect.Effect<number, ContainerRuntimeError> =>
			removeManagedContainers(labelMatch).pipe(mapToContractError, Effect.provide(baseCtx));

		const removeManagedImagesImpl = (
			labelMatch: Partial<ContainerLabelTuple>,
		): Effect.Effect<number, ContainerRuntimeError> =>
			removeManagedImages(labelMatch).pipe(mapToContractError, Effect.provide(baseCtx));

		const removeManagedNetworksImpl = (
			labelMatch: Partial<ContainerLabelTuple>,
		): Effect.Effect<number, ContainerRuntimeError> =>
			removeManagedNetworks(labelMatch).pipe(mapToContractError, Effect.provide(baseCtx));

		const removeManagedVolumesImpl = (
			labelMatch: Partial<ContainerLabelTuple>,
		): Effect.Effect<number, ContainerRuntimeError> =>
			removeManagedVolumes(labelMatch).pipe(mapToContractError, Effect.provide(baseCtx));

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
			);

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
			loadImageImpl(tar).pipe(mapToContractError, Effect.provide(baseCtx));

		const tagImageContractImpl = (
			src: ImageRef,
			newTag: string,
			opts?: TagImageOptions,
		): Effect.Effect<void, ContainerRuntimeError> => {
			const resolved = src.tag ?? src.digest;
			return tagImageImpl(resolved, newTag, opts).pipe(mapToContractError, Effect.provide(baseCtx));
		};

		const removeImageContractImpl = (ref: ImageRef): Effect.Effect<void, ContainerRuntimeError> => {
			const resolved = ref.tag ?? ref.digest;
			return removeImageImpl(resolved).pipe(mapToContractError, Effect.provide(baseCtx));
		};

		// Reuse `image.ts::imageExists` — `docker image inspect --format
		// {{.Id}}`, returning the resolved id or null. No new docker
		// invocation logic; the contract entry point just projects the
		// subsystem's narrow error to the contract error.
		const inspectImageDigestContractImpl = (
			ref: string,
		): Effect.Effect<string | null, ContainerRuntimeError> =>
			imageExists(ref).pipe(mapToContractError, Effect.provide(baseCtx));

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
			);

		return ContainerRuntimeService.of({
			ensureImage,
			pullImage: pullImageContractImpl,
			ensureNetwork: ensureNetworkContractImpl,
			ensureContainer: ensureContainerImpl,
			exec: execImpl,
			runOneShot: runOneShotImpl,
			inspectByLabels,
			pauseAndCommit: pauseAndCommitImpl,
			saveImages: saveImagesImpl,
			loadImage: loadImageContractImpl,
			tagImage: tagImageContractImpl,
			removeImage: removeImageContractImpl,
			inspectImageDigest: inspectImageDigestContractImpl,
			stop: stopImpl,
			removeManagedContainers: removeManagedContainersImpl,
			removeManagedImages: removeManagedImagesImpl,
			removeManagedNetworks: removeManagedNetworksImpl,
			removeManagedVolumes: removeManagedVolumesImpl,
		});
	}),
);
