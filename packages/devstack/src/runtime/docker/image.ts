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

import { Effect, Fiber, Schema, Stream } from 'effect';

import type { ContentHash } from '../../substrate/brand.ts';
import { CacheService } from '../../substrate/runtime/cache/index.ts';
import { recordRuntimeInvalidation } from '../../substrate/runtime/invalidation-tracker.ts';
import { decodeJsonTextSync } from '../../substrate/runtime/runtime-decode.ts';
import type { ImageRef, LoadedImageBundle } from '../../contracts/container-runtime.ts';
import { DockerHost, DockerSpawner, dockerCommand, dockerRun, dockerRunOk } from './client.ts';
import type { DockerRuntimeError } from './errors.ts';
import {
	ImageLoadFailed,
	ImageNotFound,
	ImageRemoveFailed,
	ImageSaveFailed,
	ImageTagFailed,
} from './errors.ts';
import {
	isImageNotFoundStderr,
	isMissingImageStderr,
	wrapBuildError,
	wrapGeneric,
	wrapPullError,
} from './wrap.ts';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const SNAPSHOT_TEMP_TAG_PREFIX = 'devstack-snapshot:';

const isSnapshotTempTag = (ref: string): boolean => ref.startsWith(SNAPSHOT_TEMP_TAG_PREFIX);

/** Return the trailing `max` chars of `text`, prefixed with an ellipsis
 *  when truncation occurred. Used to surface the actual stdout shape in
 *  parse-failure errors without ballooning the error message. */
const tailBytes = (text: string, max: number): string => {
	if (text.length <= max) return text;
	return `…${text.slice(-max)}`;
};

const cleanupSnapshotTempTag = (
	ref: string,
): Effect.Effect<void, never, DockerHost | DockerSpawner> => {
	if (!isSnapshotTempTag(ref)) return Effect.void;
	return dockerRunOk('image', ['rm', ref]).pipe(
		Effect.tapCause((cause) =>
			Effect.logDebug('docker image rm (snapshot temp tag) failed', { ref, cause }),
		),
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

const DigestDoc = Schema.Struct({ digest: Schema.String });

const decodeDigest = (bytes: Uint8Array): string | null => {
	try {
		return decodeJsonTextSync(DigestDoc, new TextDecoder().decode(bytes), {
			source: 'docker image digest cache',
			mkError: (issue) => issue,
		}).digest;
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
	});

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
	});

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
		const digest = yield* inspectDigest(ref);
		yield* recordRuntimeInvalidation({ kind: 'docker-image-pulled', ref, digest });
		return digest;
	});

// -----------------------------------------------------------------------------
// Build (content-addressed)
// -----------------------------------------------------------------------------

export interface BuildOptions {
	readonly contextPath: string;
	readonly dockerfile?: string;
	readonly platform?: string;
	readonly buildArgs?: Readonly<Record<string, string>>;
	readonly tag: string;
	/** Image labels rendered as `--label key=value` flags. Stamped onto
	 *  the resulting image so label-driven prune can find it. */
	readonly labels?: Readonly<Record<string, string>>;
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
		if (opts.platform !== undefined) {
			args.push('--platform', opts.platform);
		}
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
		if (opts.labels) {
			for (const [k, v] of Object.entries(opts.labels)) {
				args.push('--label', `${k}=${v}`);
			}
		}
		args.push(opts.contextPath);
		yield* dockerRun('build', args, {
			onStdoutLine: opts.onLine,
			onStderrLine: opts.onLine,
		}).pipe(Effect.mapError(wrapBuildError(opts.contextPath, opts.dockerfile)));
		return yield* inspectDigest(opts.tag);
	});

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
	});

export const removeImage = (
	ref: string,
): Effect.Effect<void, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('image', ['rm', '-f', ref]).pipe(
			Effect.mapError(wrapGeneric('docker.image.rm')),
		);
		if (res.exitCode === 0 || isMissingImageStderr(res.stderr)) return;
		return yield* Effect.fail(
			new ImageRemoveFailed({
				ref,
				stderr: res.stderr,
				exitCode: res.exitCode,
			}),
		);
	});

// -----------------------------------------------------------------------------
// Save (image → tar stream)
// -----------------------------------------------------------------------------

/** Stream the bytes of `docker save <ref>` to the consumer. Stdout
 *  stays streaming so large images never materialise in memory; stderr
 *  and exit are drained concurrently so a missing image cannot look
 *  like a successful empty tar. */
export const saveImages = (
	refs: ReadonlyArray<string>,
	opts: SaveImageOptions = {},
): Stream.Stream<Uint8Array, DockerRuntimeError, DockerHost | DockerSpawner> => {
	const mapSpawnError = (cause: unknown): DockerRuntimeError =>
		new ImageSaveFailed({
			ref: refs.join(' '),
			detail:
				refs.length === 0 ? 'docker save called with no image refs' : 'docker save spawn failed',
			cause,
		});
	if (refs.length === 0) {
		return Stream.fail(mapSpawnError(new Error('empty docker save ref list')));
	}
	return Stream.unwrap(
		Effect.gen(function* () {
			const host = yield* DockerHost;
			const spawner = yield* DockerSpawner;
			const cmd = dockerCommand(host, 'save', refs);
			const handle = yield* spawner.spawn(cmd).pipe(Effect.mapError(mapSpawnError));
			// `Stream.unwrap` IS scope-binding in v4 (STYLE_GUIDE §1): the
			// surrounding Effect.gen runs under the consuming stream's
			// scope, so `forkScoped` ties these helper fibers to that
			// scope. With `forkChild` (unscoped) a caller that errors
			// before draining the returned stream would leak the
			// stderr/exit fibers — `Stream.ensuring(cleanup)` only runs
			// once the stream is actually consumed.
			const stderrFiber = yield* Effect.forkScoped(
				Stream.mkString(Stream.decodeText(handle.stderr)).pipe(
					Effect.mapError(
						(cause): DockerRuntimeError =>
							new ImageSaveFailed({
								ref: refs.join(' '),
								detail: 'docker save stderr drain failed',
								cause,
							}),
					),
				),
			);
			const exitFiber = yield* Effect.forkScoped(
				handle.exitCode.pipe(
					Effect.mapError(
						(cause): DockerRuntimeError =>
							new ImageSaveFailed({
								ref: refs.join(' '),
								detail: 'docker save exit failed',
								cause,
							}),
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
							ref: refs.join(' '),
							detail: `docker save exited ${exitCode}${
								stderrText.length > 0 ? `: ${stderrText}` : ''
							}`,
						}),
					);
				}
			});
			const cleanupTag =
				opts.removeAfterSave === true
					? Effect.forEach(refs, cleanupSnapshotTempTag, { concurrency: 'unbounded' }).pipe(
							Effect.asVoid,
						)
					: Effect.void;
			const cleanup = Effect.all(
				[cleanupTag, Fiber.interrupt(stderrFiber), Fiber.interrupt(exitFiber)],
				{ concurrency: 'unbounded' },
			).pipe(Effect.asVoid);
			return handle.stdout.pipe(
				Stream.mapError(
					(cause): DockerRuntimeError =>
						new ImageSaveFailed({
							ref: refs.join(' '),
							detail: 'docker save stdout pipe failed',
							cause,
						}),
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

/** Parse `docker load` stdout lines to extract the loaded image refs.
 *  Docker's output is one of:
 *   - `Loaded image: <tag>`
 *   - `Loaded image ID: sha256:<digest>`
 *  Exported for direct testing without a docker dependency. */
export const parseLoadedRefs = (
	stdout: string,
): ReadonlyArray<{ readonly tag?: string; readonly digest?: string }> => {
	const refs: Array<{ tag?: string; digest?: string }> = [];
	for (const rawLine of stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		const taggedMatch = /^Loaded image: (\S+)$/.exec(line);
		if (taggedMatch?.[1]) {
			refs.push({ tag: taggedMatch[1] });
			continue;
		}
		const digestMatch = /^Loaded image ID: (sha256:\S+)$/.exec(line);
		if (digestMatch?.[1]) {
			refs.push({ digest: digestMatch[1] });
		}
	}
	return refs;
};

/** `docker load < <tar-stream>`. Returns every freshly-loaded ref
 *  Docker reported on stdout. Symmetric with `saveImages`.
 *  Upstream stream errors (e.g. file-read failures from a snapshot
 *  tar) are projected to `ImageLoadFailed` so callers see one shape.
 *
 *  Stdin lifetime: the supplied stream is fed in via the spawner's
 *  `stdin` sink under the same scope as the spawn itself; both close
 *  when the child exits. */
export const loadImage = (
	tar: Stream.Stream<Uint8Array, unknown>,
): Effect.Effect<LoadedImageBundle, DockerRuntimeError, DockerHost | DockerSpawner> =>
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
				//  - drain stdout (the "Loaded image: …" lines)
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
				const parsed = parseLoadedRefs(stdoutText);
				if (parsed.length === 0) {
					// Include the trailing ~500 bytes of stdout so newer
					// Docker variants that interleave progress markers
					// (e.g. JSON status lines) surface the actual output
					// shape instead of an opaque "no Loaded image lines
					// found". The full stderr text is still carried for
					// the rare case docker emitted a diagnostic there.
					const stdoutTail = tailBytes(stdoutText, 500);
					return yield* Effect.fail(
						new ImageLoadFailed({
							detail: `docker load succeeded but no Loaded image lines found; stdout tail: ${stdoutTail}`,
							stderr: stderrText,
						}),
					);
				}
				const refs = yield* Effect.forEach(
					parsed,
					(ref) =>
						Effect.gen(function* () {
							if (ref.digest !== undefined) {
								return refOf(ref.digest, ref.tag);
							}
							const digest = yield* imageExists(ref.tag!);
							if (digest === null) {
								return yield* Effect.fail(
									new ImageLoadFailed({
										detail: `loaded image '${ref.tag}' not visible to inspect`,
									}),
								);
							}
							return refOf(digest, ref.tag);
						}),
					{ concurrency: 'unbounded' },
				);
				return { refs };
			}),
		);
	});

// -----------------------------------------------------------------------------
// Cache integration
// -----------------------------------------------------------------------------

export interface CachedBuildKey {
	readonly namespace: string;
	readonly chain: string;
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
				// best-effort. We still build, but logDebug so the rare
				// cache-read failure is visible.
				Effect.tapCause((cause) =>
					Effect.logDebug('image cache lookup failed; rebuilding', { key, cause }),
				),
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
				.pipe(
					Effect.tapCause((cause) =>
						Effect.logDebug('image cache write (on-host hit) failed', { key, cause }),
					),
					Effect.catch(() => Effect.void),
				);
			return onHost;
		}
		const digest = yield* build(opts);
		yield* recordRuntimeInvalidation({ kind: 'docker-image-built', tag: opts.tag });
		yield* cache
			.write(
				{ namespace: key.namespace, chain: key.chain, contentHash: key.contentHash },
				encodeDigest(digest),
			)
			.pipe(
				Effect.tapCause((cause) =>
					Effect.logDebug('image cache write (post-build) failed', { key, cause }),
				),
				Effect.catch(() => Effect.void),
			);
		return digest;
	});

// -----------------------------------------------------------------------------
// Contract-shaped ImageRef helpers
// -----------------------------------------------------------------------------

export const refOf = (digest: string, tag?: string): ImageRef =>
	tag !== undefined ? { digest, tag } : { digest };
