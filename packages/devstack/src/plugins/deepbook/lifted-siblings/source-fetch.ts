// Deepbook lifted sibling — git-fetched deepbook Move sources.
//
// Lifted-sibling key conventions:
//
//   - `plugin`     — neutral `'mysten-source-fetch'` namespace so a
//                    sibling walrus/seal/sui-fork can dedup an
//                    identical-ref clone of the same upstream repo.
//                    Substrate dedup is "first-wins on identical
//                    `(plugin, kind, scope, inputHash)`."
//   - `kind`       — `'git-source'`.
//   - `scope`      — `'per-process'`. Source clones are content-
//                    addressed by `(repo, ref)`; all stacks share.
//   - `inputHash`  — `litHash('${repo}@${ref}@${subdir}')` literal so
//                    the substrate's compile-time dedup conflict check
//                    can fire on different-ref siblings.
//
// This key is only a deterministic identity for source-fetch
// experiments. Release-facing local DeepBook publishing does not
// currently rely on this lifted sibling.

import { litSiblingKey, type LitSiblingKey } from '../../../substrate/lifted-sibling.ts';

export const DEEPBOOK_REPO = 'https://github.com/MystenLabs/deepbookv3' as const;
export const DEFAULT_DEEPBOOK_REF = 'main' as const;
export const DEFAULT_DEEPBOOK_MOVE_SUBDIR = 'packages/deepbook' as const;

export const DEEPBOOK_SOURCE_FETCH_PLUGIN = 'mysten-source-fetch' as const;
export const DEEPBOOK_SOURCE_FETCH_KIND = 'git-source' as const;

export type DeepbookSourceFetchKey<Hash extends string> = LitSiblingKey<
	typeof DEEPBOOK_SOURCE_FETCH_PLUGIN,
	typeof DEEPBOOK_SOURCE_FETCH_KIND,
	'per-process',
	Hash
>;

export const deepbookSourceFetchKey = <Hash extends string>(
	inputHash: Hash,
): DeepbookSourceFetchKey<Hash> =>
	litSiblingKey(DEEPBOOK_SOURCE_FETCH_PLUGIN, DEEPBOOK_SOURCE_FETCH_KIND, 'per-process', inputHash);

export const deepbookSourceSiblingKey = <Ref extends string>(
	ref: Ref,
): DeepbookSourceFetchKey<`${typeof DEEPBOOK_REPO}@${Ref}/${typeof DEFAULT_DEEPBOOK_MOVE_SUBDIR}`> =>
	deepbookSourceFetchKey(`${DEEPBOOK_REPO}@${ref}/${DEFAULT_DEEPBOOK_MOVE_SUBDIR}` as const);

export const defaultDeepbookSourceSiblingKey = () => deepbookSourceSiblingKey(DEFAULT_DEEPBOOK_REF);
