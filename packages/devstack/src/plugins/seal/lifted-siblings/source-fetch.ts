// Seal lifted sibling — git-fetched seal source tree.
//
// Lifted-sibling key conventions (architecture §CompositePrimitive):
//
//   - `plugin`     — neutral namespace `'mysten-source-fetch'`. Chosen
//                    to allow walrus + seal + deepbook + sui-fork to
//                    DEDUP an identical-ref clone of the same upstream
//                    repo. The substrate's dedup contract is
//                    "first-wins on identical `(plugin, kind, scope,
//                    inputHash)`; refuse on different inputHash for
//                    the same `(plugin, kind, scope)`."
//
//                    Distilled-doc opportunity (notes/_GOALS.md +
//                    07-seal.md §"Lifted siblings"): keeping the
//                    plugin namespace neutral is what allows two
//                    composites in the same stack to share the
//                    fetch — putting it under `'seal'` would forbid
//                    a sibling walrus's clone from deduping with
//                    seal's, even if both target the same repo
//                    at the same ref.
//
//   - `kind`       — `'git-source'` — the cargo binary build is a
//                    DIFFERENT sibling (`cargo-image.ts`).
//
//   - `scope`      — `'per-process'` — the source tree is a content-
//                    addressed clone of an upstream repo; ALL stacks
//                    of the same process share it. Distilled-doc
//                    §"Lifted siblings" — sourceFetch can be shared
//                    because its inputs are pinned (`git ref`).
//
//   - `inputHash`  — `litHash(`${repo}@${ref}@${subdir}`)`. The
//                    literal-hash form preserves the hash at the
//                    type level so the substrate's compile-time
//                    dedup conflict check can fire if a sibling
//                    composite declares a different ref for the
//                    same repo/subdir.
//
// Resolution paths (mirror walrus's three-stage dispatch):
//
//   (a) Caller-pinned `movePackagePath` opt — barrel short-circuits
//        the sibling from `liftedSiblings:` entirely (see
//        `index.ts:buildLocalKeygenPlugin`). This resolver is only
//        called when path (a) is absent.
//
//   (b) `SEAL_MOVE_SOURCE_OVERRIDE` env var — points at a pre-fetched
//        on-disk path. Trust-the-path; no I/O. Useful in CI where the
//        repo is checked out once and reused.
//
//   (c) Real git fetch via `runtime.runOneShot({ image: 'alpine/git:2.52.0',
//        mounts: [stagingDir→/out], argv: ['clone',...] })`, staged
//        into the per-host source cache before returning the host
//        `move/seal` subdir.

import { Effect, FileSystem, Path, type Scope } from 'effect';

import type { ContainerRuntime } from '../../../contracts/container-runtime.ts';
import { litSiblingKey, type LitSiblingKey } from '../../../substrate/lifted-sibling.ts';
import { stageAndSwap } from '../../../substrate/runtime/stage-and-swap/index.ts';
import { sealError, type SealError } from '../errors.ts';

// ---------------------------------------------------------------------------
// Constants — distilled-doc §"External / upstream sources"
// ---------------------------------------------------------------------------

/** Default upstream repo URL — distilled doc §"External" reference. */
export const DEFAULT_SEAL_REPO = 'https://github.com/MystenLabs/seal' as const;

/** Pinned default ref. Distilled-doc invariant #11: this MUST match
 *  the cargo binary's version (the Dockerfile's `SEAL_VERSION` build
 *  arg). They move in lockstep. */
export const DEFAULT_SEAL_VERSION = 'seal-v0.6.6' as const;

/** Subdirectory containing the Move package. */
export const DEFAULT_SEAL_MOVE_SUBDIR = 'move/seal' as const;

/** Pinned helper image for the git clone one-shot. `alpine/git`
 *  uses `git` as its entrypoint, so the clone argv starts at
 *  `clone`. */
export const SEAL_SOURCE_FETCH_IMAGE = 'alpine/git:2.52.0' as const;

const SEAL_SOURCE_FETCH_TIMEOUT_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Sibling key constructor
// ---------------------------------------------------------------------------

/** Neutral plugin namespace — shared with walrus / deepbook / sui-fork.
 *  See file header for the dedup-discipline rationale. */
export const SEAL_SOURCE_FETCH_PLUGIN = 'mysten-source-fetch' as const;
export const SEAL_SOURCE_FETCH_KIND = 'git-source' as const;

export type SealSourceFetchKey<Hash extends string> = LitSiblingKey<
	typeof SEAL_SOURCE_FETCH_PLUGIN,
	typeof SEAL_SOURCE_FETCH_KIND,
	'per-process',
	Hash
>;

/** Construct the lifted-sibling key for a seal source clone. Pass a
 *  literal hash so the type-level dedup conflict check can fire. */
export const sealSourceFetchKey = <Hash extends string>(
	inputHash: Hash,
): SealSourceFetchKey<Hash> =>
	litSiblingKey(SEAL_SOURCE_FETCH_PLUGIN, SEAL_SOURCE_FETCH_KIND, 'per-process', inputHash);

/** Compute the sibling key from `(ref, subdir)`. Mirrors walrus's
 *  `walrusSourceSiblingKey` shape so two composites with the same ref
 *  hit type-level dedup. */
export const sealSourceSiblingKey = <Ref extends string>(
	ref: Ref,
): SealSourceFetchKey<`${typeof DEFAULT_SEAL_REPO}@${Ref}/${typeof DEFAULT_SEAL_MOVE_SUBDIR}`> =>
	sealSourceFetchKey(`${DEFAULT_SEAL_REPO}@${ref}/${DEFAULT_SEAL_MOVE_SUBDIR}` as const);

/** Construct the sibling key for the default `(repo, ref, subdir)`. */
export const defaultSealSourceSiblingKey = () => sealSourceSiblingKey(DEFAULT_SEAL_VERSION);

// ---------------------------------------------------------------------------
// Resolved value
// ---------------------------------------------------------------------------

/** Resolved value the sibling produces — an absolute filesystem
 *  path to the cloned `move/seal` subdir. The local-keygen mode's
 *  acquire body threads this into `publishSealPackage(...)`. */
export interface SealSourceFetchResolved {
	readonly repo: string;
	readonly ref: string;
	readonly subdir: string;
	readonly path: string;
}

// ---------------------------------------------------------------------------
// Runtime resolver
// ---------------------------------------------------------------------------

/** Inputs to the source-fetch sibling. */
export interface SealSourceFetchInputs<Ref extends string = string> {
	readonly repo: typeof DEFAULT_SEAL_REPO;
	readonly ref: Ref;
	readonly subdir: typeof DEFAULT_SEAL_MOVE_SUBDIR;
}

const env = (): Record<string, string | undefined> =>
	(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

const processId = (): string =>
	String((globalThis as { process?: { pid?: number } }).process?.pid ?? 'unknown');

let scratchCounter = 0;

const nextScratchPaths = (
	cacheDir: string,
): { readonly stagingPath: string; readonly backupPath: string } => {
	scratchCounter = scratchCounter + 1;
	const suffix = `${processId()}.${scratchCounter}`;
	return {
		stagingPath: `${cacheDir}.staging.${suffix}`,
		backupPath: `${cacheDir}.backup.${suffix}`,
	};
};

export const sealSourceCacheDir = (ref: string): string => {
	const home = env().HOME ?? '/tmp';
	return `${home}/.cache/devstack-rewrite/seal-src/${encodeURIComponent(ref)}`;
};

export const sealSourcePublishLockPath = (ref: string): string =>
	`${sealSourceCacheDir(ref)}.publish.lock`;

const sourceImageRef = { digest: SEAL_SOURCE_FETCH_IMAGE, tag: SEAL_SOURCE_FETCH_IMAGE } as const;

const outputTail = (value: string): string => value.slice(-1000);

const hostCloneUser = (): string | undefined => {
	const process = (
		globalThis as {
			process?: { getuid?: () => number; getgid?: () => number };
		}
	).process;
	if (typeof process?.getuid !== 'function' || typeof process.getgid !== 'function') {
		return undefined;
	}
	return `${process.getuid()}:${process.getgid()}`;
};

export const resolveSealSource = (
	runtime: ContainerRuntime,
	inputs: SealSourceFetchInputs,
): Effect.Effect<
	SealSourceFetchResolved,
	SealError,
	Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const override = env().SEAL_MOVE_SOURCE_OVERRIDE;
		if (override && override.length > 0) {
			return {
				repo: inputs.repo,
				ref: inputs.ref,
				subdir: inputs.subdir,
				path: override,
			} satisfies SealSourceFetchResolved;
		}

		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const cacheDir = sealSourceCacheDir(inputs.ref);
		const subdirPath = path.join(cacheDir, inputs.subdir);
		const cached = yield* fs.exists(subdirPath).pipe(Effect.catch(() => Effect.succeed(false)));
		if (cached) {
			return {
				repo: inputs.repo,
				ref: inputs.ref,
				subdir: inputs.subdir,
				path: subdirPath,
			} satisfies SealSourceFetchResolved;
		}

		const { stagingPath, backupPath } = nextScratchPaths(cacheDir);
		yield* stageAndSwap({
			targetPath: cacheDir,
			stagingPath,
			backupPath,
			build: Effect.gen(function* () {
				const result = yield* Effect.scoped(
					runtime
						.runOneShot({
							image: sourceImageRef,
							entrypoint: 'git',
							user: hostCloneUser(),
							argv: ['clone', '--depth', '1', '--branch', inputs.ref, inputs.repo, '/out'],
							mounts: [{ source: stagingPath, target: '/out' }],
							timeoutMillis: SEAL_SOURCE_FETCH_TIMEOUT_MS,
						})
						.pipe(
							Effect.mapError((cause) =>
								sealError('image', {
									name: 'seal',
									message:
										`seal move-source: git clone one-shot failed: ${cause.reason}: ${cause.detail}. ` +
										`Set SEAL_MOVE_SOURCE_OVERRIDE=<path> or pass movePackagePath to bypass.`,
									cause,
								}),
							),
						),
				);

				if (result.exitCode !== 0) {
					return yield* Effect.fail(
						sealError('image', {
							name: 'seal',
							message:
								`seal move-source: git clone exited ${result.exitCode}. ` +
								`Set SEAL_MOVE_SOURCE_OVERRIDE=<path> or pass movePackagePath to bypass.`,
							exitCode: result.exitCode,
							stdout: outputTail(result.stdout),
							stderr: outputTail(result.stderr),
						}),
					);
				}

				const stagedSubdir = path.join(stagingPath, inputs.subdir);
				const stagedSubdirExists = yield* fs
					.exists(stagedSubdir)
					.pipe(Effect.catch(() => Effect.succeed(false)));
				if (!stagedSubdirExists) {
					return yield* Effect.fail(
						sealError('image', {
							name: 'seal',
							message: `seal move-source: clone completed but ${inputs.subdir} was missing from ${inputs.repo}@${inputs.ref}.`,
						}),
					);
				}
			}),
			publishLockPath: sealSourcePublishLockPath(inputs.ref),
		}).pipe(
			Effect.mapError((cause): SealError => {
				if (cause._tag === 'SealError') return cause;
				return sealError('image', {
					name: 'seal',
					message: `seal move-source: cache publish failed at ${cause.stage}`,
					cause,
				});
			}),
		);

		return {
			repo: inputs.repo,
			ref: inputs.ref,
			subdir: inputs.subdir,
			path: subdirPath,
		} satisfies SealSourceFetchResolved;
	}).pipe(
		Effect.withSpan('devstack.plugin.seal.moveSource.resolve', {
			attributes: {
				'seal.repo': inputs.repo,
				'seal.ref': inputs.ref,
				'seal.subdir': inputs.subdir,
			},
		}),
	);

/** Convenience: resolve via the default inputs. */
export const resolveDefaultSealSource = (
	runtime: ContainerRuntime,
): Effect.Effect<
	SealSourceFetchResolved,
	SealError,
	Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
	resolveSealSource(runtime, {
		repo: DEFAULT_SEAL_REPO,
		ref: DEFAULT_SEAL_VERSION,
		subdir: DEFAULT_SEAL_MOVE_SUBDIR,
	});
