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
//   (c) Real git fetch via `runtime.runOneShot({ image: 'alpine/git',
//        mounts: [cacheDir→/out], argv: ['git','clone',...] })`.
//        STUBBED: emits a documented seam error pointing at the
//        override hatch.

import { Effect, type Scope } from 'effect';

import { litSiblingKey, type LitSiblingKey } from '../../../substrate/lifted-sibling.ts';
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

export const resolveSealSource = (
	inputs: SealSourceFetchInputs,
): Effect.Effect<SealSourceFetchResolved, SealError, Scope.Scope> =>
	Effect.gen(function* () {
		const override = (globalThis as { process?: { env?: Record<string, string | undefined> } })
			.process?.env?.SEAL_MOVE_SOURCE_OVERRIDE;
		if (override && override.length > 0) {
			return {
				repo: inputs.repo,
				ref: inputs.ref,
				subdir: inputs.subdir,
				path: override,
			} satisfies SealSourceFetchResolved;
		}
		return yield* Effect.fail(
			sealError('image', {
				name: 'seal',
				message:
					`seal move-source: git fetch not implemented. ` +
					`Set \`SEAL_MOVE_SOURCE_OVERRIDE\` to a pre-fetched checkout root, ` +
					`OR pass \`movePackagePath\` to \`seal({ mode: 'local-keygen', movePackagePath })\` ` +
					`to skip the git fetch. ` +
					`SEAM: real impl needs (1) ContainerRuntime.runOneShot({ image: 'alpine/git', ` +
					`mounts: [cache→/out], argv: ['git', 'clone', '--depth', '1', '--branch', '${inputs.ref}', ` +
					`'${inputs.repo}', '/out'] }), ` +
					`(2) return host path of \`/out/${inputs.subdir}\`. ` +
					`See lifted-siblings/source-fetch.ts header.`,
			}),
		);
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
export const resolveDefaultSealSource = (): Effect.Effect<
	SealSourceFetchResolved,
	SealError,
	Scope.Scope
> =>
	resolveSealSource({
		repo: DEFAULT_SEAL_REPO,
		ref: DEFAULT_SEAL_VERSION,
		subdir: DEFAULT_SEAL_MOVE_SUBDIR,
	});
