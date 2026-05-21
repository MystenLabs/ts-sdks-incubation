// Walrus lifted sibling — git-fetched walrus source.
//
// Architecture (composite-primitive §"Lifted-sibling key
// conventions"): siblings are declared at factory time so the topo
// scheduler places them at level 0 (parallel with sui's boot). The
// `(plugin, kind, scope, inputHash)` tuple drives:
//
//   - First-wins dedup across composites with the same key (two
//     `walrus()` instances pinned to the same version share ONE
//     `gitFetch`).
//   - Conflict refusal when `(plugin, kind, scope)` matches but
//     `inputHash` differs (two `walrus()` instances pinned to
//     different versions both want a `move-source` sibling — refused
//     at compose time with the conflicting group key in the error).
//
// SHARING WITH SEAL: the walrus and seal upstreams live in different
// repos today, so they don't share this exact sibling. If seal lifts
// the same `MystenLabs/walrus.git@<ref>` source (it doesn't), the
// dedup would kick in here.
//
// Key shape used here:
//   - plugin     = 'walrus'
//   - kind       = 'move-source'
//   - scope      = 'per-process' (the git checkout is content-
//                                 addressed; no per-app/-stack
//                                 separation needed)
//   - inputHash  = LitHash<`${owner}/${repo}@${ref}/${subdir}`>
//                  — preserved at the type level for compile-time
//                  conflict detection.

import { Effect, FileSystem, Path, type Scope } from 'effect';

import { litSiblingKey, type LitSiblingKey } from '../../../substrate/lifted-sibling.ts';
import { walrusPluginError, type WalrusPluginError } from '../errors.ts';

/** Default upstream repo + Move package subdirectory. Matches v3's
 *  `DEFAULT_WALRUS_REPO` / `DEFAULT_WALRUS_MOVE_SUBDIR`. */
export const DEFAULT_WALRUS_REPO = 'MystenLabs/walrus' as const;
export const DEFAULT_WALRUS_MOVE_SUBDIR = 'contracts/walrus' as const;
/** Distilled-doc invariant 23: `DEFAULT_WALRUS_REF` and
 *  `DEFAULT_WALRUS_MOVE_SUBDIR` MUST be bumped together (the cargo
 *  build and the Move package must agree on the on-chain types
 *  they emit). */
export const DEFAULT_WALRUS_REF = 'devnet-v1.49.0' as const;

/** Inputs to the source-fetch sibling. */
export interface WalrusSourceFetchInputs<Ref extends string = string> {
	readonly repo: typeof DEFAULT_WALRUS_REPO;
	readonly ref: Ref;
	readonly subdir: typeof DEFAULT_WALRUS_MOVE_SUBDIR;
}

/** Resolved value — the on-disk path to the checked-out walrus
 *  Move package subdirectory. Consumers (the deploy one-shot's
 *  wrapper image build, or a `movePackagePath`-bypass call) read
 *  this path. */
export interface WalrusSourceFetched {
	readonly hostPath: string;
	readonly ref: string;
	readonly subdir: string;
}

/** Compute the literal-typed sibling key. The literal-string hash
 *  preserves the `(repo, ref, subdir)` tuple at the type level so
 *  the compiler can dedup at compose time. */
export const walrusSourceSiblingKey = <Ref extends string>(
	ref: Ref,
): LitSiblingKey<
	'walrus',
	'move-source',
	'per-process',
	`${typeof DEFAULT_WALRUS_REPO}@${Ref}/${typeof DEFAULT_WALRUS_MOVE_SUBDIR}`
> =>
	litSiblingKey(
		'walrus',
		'move-source',
		'per-process',
		`${DEFAULT_WALRUS_REPO}@${ref}/${DEFAULT_WALRUS_MOVE_SUBDIR}` as const,
	);

/** Construct the sibling key for the default `(repo, ref, subdir)`. */
export const defaultWalrusSourceSiblingKey = () => walrusSourceSiblingKey(DEFAULT_WALRUS_REF);

// ---------------------------------------------------------------------------
// Runtime resolver
// ---------------------------------------------------------------------------

/** Resolve the walrus Move source checkout. Two staged paths:
 *
 *   (a) Caller-pinned `movePackagePath` — bypass entirely. The
 *        composite's local-cluster mode already short-circuits in
 *        `index.ts` (drops the sibling from `siblingKeys` when
 *        `opts.movePackagePath` is set); this resolver is therefore
 *        only called when path (a) is absent.
 *
 *   (b) `WALRUS_MOVE_SOURCE_OVERRIDE` env var — points at a pre-fetched
 *        on-disk path. Trust-the-path; no I/O. Useful in CI where the
 *        repo is checked out once and reused.
 *
 *   (c) Real git fetch via host-side `git clone` into the cache dir.
 */
/** Per-host cache root for cloned walrus sources. The lifted-sibling
 *  scope is `'per-process'`, so first-wins dedup within a process
 *  collapses concurrent calls; the on-disk cache adds cross-process
 *  reuse (a second devstack process pointing at the same ref skips
 *  the clone). Path is `~/.cache/devstack-rewrite/walrus-src/<ref>/`.
 *
 *  Resolved at call time off the user's HOME so the cache survives
 *  between sessions without polluting the repo's tmpdir. */
const cloneCacheDir = (ref: string): string => {
	const home =
		(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.HOME ??
		'/tmp';
	return `${home}/.cache/devstack-rewrite/walrus-src/${ref}`;
};

/** Resolve the walrus Move source checkout. Three staged paths:
 *
 *   (a) `WALRUS_MOVE_SOURCE_OVERRIDE` env var — points at a pre-fetched
 *        on-disk path. Trust-the-path; no I/O.
 *
 *   (b) On-disk cache hit at `~/.cache/devstack-rewrite/walrus-src/<ref>/`.
 *        Cross-process reuse without re-cloning.
 *
 *   (c) Real git clone via Node's `child_process`. We do this on the
 *        host (not inside a docker container) because the clone target
 *        is a host-side path, and the lifted-sibling resolver doesn't
 *        receive a ContainerRuntime by design (image-only siblings get
 *        runtime; source-only siblings stay on the host). The Move
 *        contracts the walrus team ships are public — no credential
 *        plumbing needed.
 */
export const resolveWalrusSource = (
	inputs: WalrusSourceFetchInputs,
): Effect.Effect<
	WalrusSourceFetched,
	WalrusPluginError,
	Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const override = (globalThis as { process?: { env?: Record<string, string | undefined> } })
			.process?.env?.WALRUS_MOVE_SOURCE_OVERRIDE;
		if (override && override.length > 0) {
			return {
				hostPath: override,
				ref: inputs.ref,
				subdir: inputs.subdir,
			};
		}

		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const cacheDir = cloneCacheDir(inputs.ref);
		const subdirPath = path.join(cacheDir, inputs.subdir);

		// (b) on-disk cache check.
		const subdirExists = yield* fs
			.exists(subdirPath)
			.pipe(Effect.catch(() => Effect.succeed(false)));
		if (subdirExists) {
			return {
				hostPath: subdirPath,
				ref: inputs.ref,
				subdir: inputs.subdir,
			};
		}

		// (c) real clone via host-side git. Use Node's child_process so
		// we don't need a docker round-trip for a 100MB shallow checkout.
		yield* fs
			.makeDirectory(cacheDir, { recursive: true })
			.pipe(
				Effect.catch((err) =>
					Effect.fail(
						walrusPluginError(
							'image-build',
							`walrus move-source: makeDirectory('${cacheDir}') failed: ${String(err)}`,
						),
					),
				),
			);

		// Clone into a temp scratch dir and then atomically rename to
		// `cacheDir` so we don't see partial state on interrupted clones.
		const scratch = `${cacheDir}.scratch.${Date.now()}`;
		const cloneUrl = `https://github.com/${inputs.repo}.git`;
		const cloneResult = yield* Effect.tryPromise({
			try: async () => {
				const { spawn } = await import('node:child_process');
				return await new Promise<{ exitCode: number; stderr: string }>((resolveP, rejectP) => {
					const proc = spawn(
						'git',
						['clone', '--depth', '1', '--branch', inputs.ref, cloneUrl, scratch],
						{ stdio: ['ignore', 'pipe', 'pipe'] },
					);
					let stderr = '';
					proc.stderr.on('data', (d: Buffer) => {
						stderr += d.toString('utf8');
					});
					proc.on('error', rejectP);
					proc.on('close', (code) => resolveP({ exitCode: code ?? -1, stderr }));
				});
			},
			catch: (err) =>
				walrusPluginError(
					'image-build',
					`walrus move-source: git clone (${cloneUrl}@${inputs.ref}) spawn failed: ${String(err)}`,
				),
		});

		if (cloneResult.exitCode !== 0) {
			return yield* Effect.fail(
				walrusPluginError(
					'image-build',
					`walrus move-source: git clone exited ${cloneResult.exitCode}. ` +
						`Try \`WALRUS_MOVE_SOURCE_OVERRIDE=<path>\` to bypass. stderr: ${cloneResult.stderr.slice(0, 1000)}`,
				),
			);
		}

		// Atomic rename — point at the final path. If a sibling concurrent
		// resolve raced us here, the second rename is a no-op (rename onto
		// an existing dir fails on POSIX); we tolerate it.
		yield* Effect.tryPromise({
			try: async () => {
				const fsp = await import('node:fs/promises');
				try {
					await fsp.rename(scratch, cacheDir);
				} catch (err: unknown) {
					// Already exists from a sibling — clean up scratch.
					await fsp.rm(scratch, { recursive: true, force: true });
					if (
						(err as { code?: string } | null)?.code !== 'ENOTEMPTY' &&
						(err as { code?: string } | null)?.code !== 'EEXIST'
					) {
						throw err;
					}
				}
			},
			catch: (err) =>
				walrusPluginError(
					'image-build',
					`walrus move-source: rename(${scratch} → ${cacheDir}) failed: ${String(err)}`,
				),
		});

		return {
			hostPath: subdirPath,
			ref: inputs.ref,
			subdir: inputs.subdir,
		};
	}).pipe(
		Effect.withSpan('devstack.plugin.walrus.moveSource.resolve', {
			attributes: {
				'walrus.repo': inputs.repo,
				'walrus.ref': inputs.ref,
				'walrus.subdir': inputs.subdir,
			},
		}),
	);

/** Convenience: resolve via the default inputs. */
export const resolveDefaultWalrusSource = (): Effect.Effect<
	WalrusSourceFetched,
	WalrusPluginError,
	Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
	resolveWalrusSource({
		repo: DEFAULT_WALRUS_REPO,
		ref: DEFAULT_WALRUS_REF,
		subdir: DEFAULT_WALRUS_MOVE_SUBDIR,
	});
