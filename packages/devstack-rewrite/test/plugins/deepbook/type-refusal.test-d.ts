// Static-type assertions for the deepbook mode-narrowed refusal.
//
// These declarations exercise the TS compiler — they must
// type-check (positive cases) OR carry a `@ts-expect-error` to pin
// the type-level refusal (negative cases). The compiler runs this
// file as part of `pnpm typecheck`; vitest does not execute it.
//
// Lives under `test/plugins/deepbook/` per the mirror-src/ rule
// (STYLE_GUIDE §3 / §9).

import { account } from '../../../src/plugins/account/index.ts';
import { deepbookFor } from '../../../src/plugins/deepbook/index.ts';
import { chainId } from '../../../src/substrate/brand.ts';
import type { NetworkConfig } from '../../../src/substrate/network.ts';

const localNet: NetworkConfig<'local'> = { mode: 'local', chain: chainId('sui:localnet') };
const liveNet: NetworkConfig<'live'> = { mode: 'live', chain: chainId('sui:testnet') };
const forkNet: NetworkConfig<'fork'> = {
	mode: 'fork',
	chain: chainId('sui:mainnet-fork'),
	checkpoint: '1',
};

const publisher = account('publisher');

// --- Positive: local mode allows .local + .known ------------------------
export const _localLocal = deepbookFor.for(localNet).local({ publisher });
export const _localKnown = deepbookFor.for(localNet).known({
	packageId: '0xpkg',
	registryId: '0xreg',
});

// --- Positive: live mode allows .known -----------------------------------
export const _liveKnown = deepbookFor.for(liveNet).known({
	packageId: '0xpkg',
	registryId: '0xreg',
});

// --- Negative: live mode has no .local -----------------------------------
// @ts-expect-error — `.local` doesn't exist on the live branch
export const _liveLocalRefused = deepbookFor.for(liveNet).local({ publisher });

// --- Positive: fork mode allows .known ----------------------------------
export const _forkKnown = deepbookFor.for(forkNet).known({
	packageId: '0xpkg',
	registryId: '0xreg',
});

// --- Negative: fork mode has no .local ----------------------------------
// @ts-expect-error — `.local` doesn't exist on the fork branch (composite refusal)
export const _forkLocalRefused = deepbookFor.for(forkNet).local({ publisher });
