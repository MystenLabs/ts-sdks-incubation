// Seal git-fetched source tree.
//
// Resolution paths (mirror walrus's three-stage dispatch):
//
//   (a) Caller-pinned `movePackagePath` opt — local-keygen mode
//        short-circuits before calling this resolver.
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
import { hostBindMountOwner } from '../../../substrate/runtime/host-bind-mount-owner.ts';
import { tailOutput } from '../../../substrate/runtime/observability/index.ts';
import { stageAndSwap } from '../../../substrate/runtime/stage-and-swap/index.ts';
import { readEnv } from '../../../substrate/runtime/typed-env.ts';
import { sealError, type SealError } from '../errors.ts';
import { SealSpans } from '../spans.ts';

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
// Resolved value
// ---------------------------------------------------------------------------

/** Resolved value for the cloned `move/seal` subdir. The local-keygen
 *  mode's acquire body threads this into `publishSealPackage(...)`. */
export interface SealSourceFetchResolved {
	readonly repo: string;
	readonly ref: string;
	readonly subdir: string;
	readonly path: string;
}

// ---------------------------------------------------------------------------
// Runtime resolver
// ---------------------------------------------------------------------------

/** Inputs to the source resolver. */
export interface SealSourceFetchInputs<Ref extends string = string> {
	readonly repo: typeof DEFAULT_SEAL_REPO;
	readonly ref: Ref;
	readonly subdir: typeof DEFAULT_SEAL_MOVE_SUBDIR;
}

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
	const home = readEnv('HOME') ?? '/tmp';
	return `${home}/.cache/devstack/seal-src/${encodeURIComponent(ref)}`;
};

export const sealSourcePublishLockPath = (ref: string): string =>
	`${sealSourceCacheDir(ref)}.publish.lock`;

const sourceImageRef = { digest: SEAL_SOURCE_FETCH_IMAGE, tag: SEAL_SOURCE_FETCH_IMAGE } as const;

export const resolveSealSource = (
	runtime: ContainerRuntime,
	inputs: SealSourceFetchInputs,
): Effect.Effect<
	SealSourceFetchResolved,
	SealError,
	Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const override = readEnv('SEAL_MOVE_SOURCE_OVERRIDE');
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
							user: hostBindMountOwner(),
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
							stdout: tailOutput(result.stdout),
							stderr: tailOutput(result.stderr),
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
				[SealSpans.repo]: inputs.repo,
				[SealSpans.ref]: inputs.ref,
				[SealSpans.subdir]: inputs.subdir,
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
