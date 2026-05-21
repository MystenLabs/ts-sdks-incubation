// Docker image lifecycle.
//
// Architecture § Docker backend § Images:
//   - Bring-your-own-image vs build is a CLOSED SUM (architecture §8):
//     either the caller supplies an image ref (`docker pull`) or a
//     `ContainerBuildContext` (`docker build`); no third option.
//   - Content-addressed build cache: the substrate's L0 cache holds
//     the `(namespace, chainId, contentHash) → imageDigest` mapping.
//     When the cache hits we short-circuit the build. The `docker
//     build` itself is then a no-op when the resulting tag already
//     exists on the host (defense-in-depth — cache miss but on-host
//     tag-exists still skips the build).
//   - Pull progress narration is wired through `onStdoutLine` /
//     `onStderrLine` per-line callbacks on the L0 capture; the L1
//     observability sink promotes WARN/ERROR markers.
//
// Surface:
//   - `imageExists(ref)` — `docker inspect` short-circuit
//   - `pull(ref)`        — `docker pull`; surfaces ImageNotFound /
//                          ImagePullFailed via wrap.ts
//   - `build(ctx, tag)`  — `docker build -t <tag> <ctx>`; surfaces
//                          BuildFailed via wrap.ts; integrates with
//                          the L0 cache
//   - `tag(src, dst)`    — `docker tag`
//   - `inspectDigest`    — read the on-host digest of a tag

import { Effect, Fiber, Stream } from 'effect';

import type { ChainId, ContentHash } from '../../substrate/brand.ts';
import { CacheService } from '../../substrate/runtime/cache/index.ts';
import type { ImageRef } from '../../contracts/container-runtime.ts';
import { DockerHost, DockerSpawner, dockerCommand, dockerRun, dockerRunOk } from './client.ts';
import type { DockerRuntimeError } from './errors.ts';
import { ImageLoadFailed, ImageNotFound, ImageSaveFailed, ImageTagFailed } from './errors.ts';
import { isImageNotFoundStderr, wrapBuildError, wrapGeneric, wrapPullError } from './wrap.ts';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const SNAPSHOT_TEMP_TAG_PREFIX = 'devstack-snapshot:';

const isSnapshotTempTag = (ref: string): boolean => ref.startsWith(SNAPSHOT_TEMP_TAG_PREFIX);

const cleanupSnapshotTempTag = (
	ref: string,
): Effect.Effect<void, never, DockerHost | DockerSpawner> => {
	if (!isSnapshotTempTag(ref)) return Effect.void;
	return dockerRunOk('image', ['rm', ref]).pipe(
		Effect.catch(() => Effect.void),
		Effect.asVoid,
	);
};

export interface SaveImageOptions {
	readonly removeAfterSave?: boolean;
}

export interface TagImageOptions {
	readonly removeSourceAfterTag?: boolean;
}

/** Encode/decode the cache entry — we store the resolved image digest
 *  as plain UTF-8 bytes so the cache primitive's byte shape works. */
const encodeDigest = (digest: string): Uint8Array =>
	new TextEncoder().encode(JSON.stringify({ digest } satisfies { digest: string }));

const decodeDigest = (bytes: Uint8Array): string | null => {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { digest?: unknown };
		return typeof parsed.digest === 'string' ? parsed.digest : null;
	} catch {
		return null;
	}
};

// -----------------------------------------------------------------------------
// Exists / inspect
// -----------------------------------------------------------------------------

/** `docker image inspect <ref>` — returns the digest, or null on miss. */
export const imageExists = (
	ref: string,
): Effect.Effect<string | null, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('image', ['inspect', '--format', '{{.Id}}', ref]).pipe(
			Effect.mapError(wrapGeneric('docker.image.inspect')),
		);
		if (res.exitCode !== 0) return null;
		const id = res.stdout.trim();
		return id.length > 0 ? id : null;
	}).pipe(Effect.withSpan('runtime.docker.image.exists'));

/** Strict variant — surfaces `ImageNotFound` if the inspect misses. */
export const inspectDigest = (
	ref: string,
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const id = yield* imageExists(ref);
		if (id === null) {
			return yield* Effect.fail(
				new ImageNotFound({ ref, detail: 'docker image inspect returned empty' }),
			);
		}
		return id;
	}).pipe(Effect.withSpan('runtime.docker.image.inspectDigest'));

// -----------------------------------------------------------------------------
// Pull
// -----------------------------------------------------------------------------

/** `docker pull <ref>` — surfaces ImageNotFound / ImagePullFailed.
 *  Per-line progress emission opt-in via `onLine`. */
export const pull = (
	ref: string,
	onLine?: (line: string) => Effect.Effect<void>,
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		yield* dockerRun('pull', [ref], { onStdoutLine: onLine }).pipe(
			Effect.mapError(wrapPullError(ref)),
		);
		return yield* inspectDigest(ref);
	}).pipe(Effect.withSpan('runtime.docker.image.pull'));

// -----------------------------------------------------------------------------
// Build (content-addressed)
// -----------------------------------------------------------------------------

export interface BuildOptions {
	readonly contextPath: string;
	readonly dockerfile?: string;
	readonly buildArgs?: Readonly<Record<string, string>>;
	readonly tag: string;
	readonly onLine?: (line: string) => Effect.Effect<void>;
}

/** `docker build -t <tag> [-f Dockerfile] <ctx>`. On exit-0 the
 *  resulting tag is on-host; we read its digest and return.
 *
 *  NOTE: the content-addressed cache integration is in `ensureImageCached`
 *  below — this verb is the unconditional build, used when the cache
 *  has missed AND the on-host tag-exists probe also missed. */
export const build = (
	opts: BuildOptions,
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const args: Array<string> = ['-t', opts.tag];
		// `-f` is resolved relative to the docker CLI's CWD, NOT the
		// context directory. Skip `-f` entirely when the dockerfile is
		// the canonical default name (`Dockerfile`) and the context is a
		// directory — docker buildx then auto-discovers `<ctx>/Dockerfile`.
		// When the user names a non-default dockerfile, resolve it against
		// the context so `docker build -f a/b/Dockerfile.x .` works
		// regardless of CWD.
		if (opts.dockerfile && opts.dockerfile !== 'Dockerfile') {
			const isAbs = opts.dockerfile.startsWith('/') || /^[A-Za-z]:/.test(opts.dockerfile);
			const resolved = isAbs
				? opts.dockerfile
				: `${opts.contextPath.replace(/\/$/, '')}/${opts.dockerfile}`;
			args.push('-f', resolved);
		}
		if (opts.buildArgs) {
			for (const [k, v] of Object.entries(opts.buildArgs)) {
				args.push('--build-arg', `${k}=${v}`);
			}
		}
		args.push(opts.contextPath);
		yield* dockerRun('build', args, {
			onStdoutLine: opts.onLine,
			onStderrLine: opts.onLine,
		}).pipe(Effect.mapError(wrapBuildError(opts.contextPath, opts.dockerfile)));
		return yield* inspectDigest(opts.tag);
	}).pipe(Effect.withSpan('runtime.docker.image.build'));

// -----------------------------------------------------------------------------
// Tag
// -----------------------------------------------------------------------------

/** `docker tag <src> <dst>` — used by snapshot restore to alias a
 *  loaded image back to its original tag. */
export const tagImage = (
	src: string,
	dst: string,
	opts: TagImageOptions = {},
): Effect.Effect<void, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('tag', [src, dst]).pipe(
			Effect.mapError(wrapGeneric('docker.tag')),
		);
		if (res.exitCode !== 0) {
			if (isImageNotFoundStderr(res.stderr)) {
				return yield* Effect.fail(
					new ImageNotFound({ ref: src, detail: `tag source missing: ${res.stderr}` }),
				);
			}
			return yield* Effect.fail(new ImageTagFailed({ src, dst, stderr: res.stderr }));
		}
		if (opts.removeSourceAfterTag === true && src !== dst) {
			yield* cleanupSnapshotTempTag(src);
		}
	}).pipe(Effect.withSpan('runtime.docker.image.tag'));

// -----------------------------------------------------------------------------
// Save (image → tar stream)
// -----------------------------------------------------------------------------

/** Stream the bytes of `docker save <ref>` to the consumer. Stdout
 *  stays streaming so large images never materialise in memory; stderr
 *  and exit are drained concurrently so a missing image cannot look
 *  like a successful empty tar. */
export const saveImage = (
	ref: string,
	opts: SaveImageOptions = {},
): Stream.Stream<Uint8Array, DockerRuntimeError, DockerHost | DockerSpawner> => {
	const mapSpawnError = (cause: unknown): DockerRuntimeError =>
		new ImageSaveFailed({ ref, detail: 'docker save spawn failed', cause });
	return Stream.unwrap(
		Effect.gen(function* () {
			const host = yield* DockerHost;
			const spawner = yield* DockerSpawner;
			const cmd = dockerCommand(host, 'save', [ref]);
			const handle = yield* spawner.spawn(cmd).pipe(Effect.mapError(mapSpawnError));
			const stderrFiber = yield* Effect.forkChild(
				Stream.mkString(Stream.decodeText(handle.stderr)).pipe(
					Effect.mapError(
						(cause): DockerRuntimeError =>
							new ImageSaveFailed({ ref, detail: 'docker save stderr drain failed', cause }),
					),
				),
			);
			const exitFiber = yield* Effect.forkChild(
				handle.exitCode.pipe(
					Effect.mapError(
						(cause): DockerRuntimeError =>
							new ImageSaveFailed({ ref, detail: 'docker save exit failed', cause }),
					),
				),
			);
			const checkExit = Effect.gen(function* () {
				const [stderrText, exitCode] = yield* Effect.all(
					[Fiber.join(stderrFiber), Fiber.join(exitFiber)] as const,
					{ concurrency: 'unbounded' },
				);
				if (exitCode !== 0) {
					return yield* Effect.fail(
						new ImageSaveFailed({
							ref,
							detail: `docker save exited ${exitCode}${
								stderrText.length > 0 ? `: ${stderrText}` : ''
							}`,
						}),
					);
				}
			});
			const cleanupTag = opts.removeAfterSave === true ? cleanupSnapshotTempTag(ref) : Effect.void;
			const cleanup = Effect.all(
				[cleanupTag, Fiber.interrupt(stderrFiber), Fiber.interrupt(exitFiber)],
				{ concurrency: 'unbounded' },
			).pipe(Effect.asVoid);
			return handle.stdout.pipe(
				Stream.mapError(
					(cause): DockerRuntimeError =>
						new ImageSaveFailed({ ref, detail: 'docker save stdout pipe failed', cause }),
				),
				Stream.onEnd(checkExit),
				Stream.ensuring(cleanup),
			);
		}),
	);
};

// -----------------------------------------------------------------------------
// Load (tar stream → image)
// -----------------------------------------------------------------------------

/** Parse a `docker load` stdout line to extract the loaded image ref.
 *  Docker's output is one of:
 *   - `Loaded image: <tag>`
 *   - `Loaded image ID: sha256:<digest>`
 *  We prefer a tagged form when present (the snapshot restore aliases
 *  the loaded image back to its original tag immediately after).
 *  Exported for direct testing without a docker dependency. */
export const parseLoadedRef = (stdout: string): { tag?: string; digest?: string } | null => {
	const taggedMatch = /Loaded image: (\S+)/.exec(stdout);
	if (taggedMatch && taggedMatch[1]) return { tag: taggedMatch[1] };
	const digestMatch = /Loaded image ID: (sha256:\S+)/.exec(stdout);
	if (digestMatch && digestMatch[1]) return { digest: digestMatch[1] };
	return null;
};

/** `docker load < <tar-stream>`. Returns the freshly-loaded image's
 *  ref (parsed from stdout). Symmetric with `saveImage`. Upstream
 *  stream errors (e.g. file-read failures from a snapshot tar) are
 *  projected to `ImageLoadFailed` so callers see one shape.
 *
 *  Stdin lifetime: the supplied stream is fed in via the spawner's
 *  `stdin` sink under the same scope as the spawn itself; both close
 *  when the child exits. */
export const loadImage = (
	tar: Stream.Stream<Uint8Array, unknown>,
): Effect.Effect<ImageRef, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const host = yield* DockerHost;
		const spawner = yield* DockerSpawner;
		const cmd = dockerCommand(host, 'load', []);
		const mapSpawnError = (cause: unknown): DockerRuntimeError =>
			new ImageLoadFailed({ detail: 'docker load spawn failed', cause });
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const handle = yield* spawner.spawn(cmd).pipe(Effect.mapError(mapSpawnError));
				// Concurrently:
				//  - pump the supplied tar into stdin
				//  - drain stdout (the "Loaded image: …" line)
				//  - drain stderr
				//  - wait for exit
				const writeStdin = Stream.run(tar, handle.stdin).pipe(
					Effect.mapError(
						(cause: unknown): DockerRuntimeError =>
							new ImageLoadFailed({ detail: 'docker load stdin pipe failed', cause }),
					),
				);
				const stdoutDrain = Stream.mkString(Stream.decodeText(handle.stdout)).pipe(
					Effect.mapError(
						(cause): DockerRuntimeError =>
							new ImageLoadFailed({ detail: 'docker load stdout drain failed', cause }),
					),
				);
				const stderrDrain = Stream.mkString(Stream.decodeText(handle.stderr)).pipe(
					Effect.mapError(
						(cause): DockerRuntimeError =>
							new ImageLoadFailed({ detail: 'docker load stderr drain failed', cause }),
					),
				);
				const exit = handle.exitCode.pipe(
					Effect.mapError(
						(cause): DockerRuntimeError =>
							new ImageLoadFailed({ detail: 'docker load exit failed', cause }),
					),
				);
				const [, stdoutText, stderrText, exitCode] = yield* Effect.all(
					[writeStdin, stdoutDrain, stderrDrain, exit] as const,
					{ concurrency: 'unbounded' },
				);
				if (exitCode !== 0) {
					return yield* Effect.fail(
						new ImageLoadFailed({
							detail: `docker load exited ${exitCode}`,
							stderr: stderrText,
						}),
					);
				}
				const parsed = parseLoadedRef(stdoutText);
				if (parsed === null) {
					return yield* Effect.fail(
						new ImageLoadFailed({
							detail: 'docker load succeeded but no Loaded image line found',
							stderr: stdoutText,
						}),
					);
				}
				// Resolve the on-host digest. If load reported a digest line
				// directly, accept it; otherwise inspect the tag.
				if (parsed.digest !== undefined) {
					return refOf(parsed.digest, parsed.tag);
				}
				const digest = yield* imageExists(parsed.tag!);
				if (digest === null) {
					return yield* Effect.fail(
						new ImageLoadFailed({
							detail: `loaded image '${parsed.tag}' not visible to inspect`,
						}),
					);
				}
				return refOf(digest, parsed.tag);
			}),
		);
	}).pipe(Effect.withSpan('runtime.docker.image.load'));

// -----------------------------------------------------------------------------
// Cache integration
// -----------------------------------------------------------------------------

export interface CachedBuildKey {
	readonly namespace: string;
	readonly chain: ChainId;
	readonly contentHash: ContentHash;
}

/** Content-addressed image build:
 *
 *    1. cache lookup keyed by (namespace, chainId, contentHash)
 *    2. on hit, verify the on-host tag still resolves; if so return
 *    3. on miss, run `docker build`, then write the resolved digest
 *       to the cache (best-effort — write failure does not roll back
 *       the on-host build).
 *
 *  Caller-supplied tag is the content-addressed name; the cache key
 *  is independent so an unrelated invalidation (e.g. base-image
 *  bump) can drop the cache without disturbing the tag scheme. */
export const ensureImageCached = (
	opts: BuildOptions,
	key: CachedBuildKey,
): Effect.Effect<string, DockerRuntimeError, CacheService | DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const cache = yield* CacheService;
		const hit = yield* cache
			.lookup({ namespace: key.namespace, chain: key.chain, contentHash: key.contentHash })
			.pipe(
				// Cache-side failures collapse to MISS — the contract is
				// best-effort. We still build.
				Effect.catch(() => Effect.succeed(null)),
			);
		if (hit !== null) {
			const cached = decodeDigest(hit.bytes);
			if (cached !== null) {
				// Verify the on-host tag still resolves to something —
				// the cached digest may have been pruned out from under us.
				const existing = yield* imageExists(opts.tag);
				if (existing !== null) {
					return existing;
				}
			}
		}
		// On-host tag-exists short-circuit (defence-in-depth).
		const onHost = yield* imageExists(opts.tag);
		if (onHost !== null) {
			yield* cache
				.write(
					{ namespace: key.namespace, chain: key.chain, contentHash: key.contentHash },
					encodeDigest(onHost),
				)
				.pipe(Effect.catch(() => Effect.void));
			return onHost;
		}
		const digest = yield* build(opts);
		yield* cache
			.write(
				{ namespace: key.namespace, chain: key.chain, contentHash: key.contentHash },
				encodeDigest(digest),
			)
			.pipe(Effect.catch(() => Effect.void));
		return digest;
	}).pipe(Effect.withSpan('runtime.docker.image.ensureCached'));

// -----------------------------------------------------------------------------
// Contract-shaped ImageRef helpers
// -----------------------------------------------------------------------------

export const refOf = (digest: string, tag?: string): ImageRef =>
	tag !== undefined ? { digest, tag } : { digest };
