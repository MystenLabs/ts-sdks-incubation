// Static-type assertions for the deepbook mode-narrowed refusal.
//
// These declarations exercise the TS compiler — they must
// type-check (positive cases) OR carry a `@ts-expect-error` to pin
// the type-level refusal (negative cases). The compiler runs this
// file as part of `pnpm typecheck`; vitest does not execute it.
//
// Lives under `test/plugins/deepbook/` per the mirror-src/ rule
// (STYLE_GUIDE §3 / §9).

import { deepbookFor } from '../../../src/plugins/deepbook/index.ts';
import { chainId } from '../../../src/substrate/brand.ts';
import type * as DB from '../../../src/plugins/deepbook/index.ts';
import type { NetworkConfig } from '../../../src/substrate/network.ts';

// --- Negative: unsupported helpers are not public DeepBook API -----------
type DPV = typeof import('../../../src/plugins/deepbook/index.ts');

// @ts-expect-error — local pool configuration is not public until it acquires real behavior
export type _NoDeepbookPoolSpecOnDeepbookBarrel = DB.DeepbookPoolSpec;

// @ts-expect-error — margin configuration/default helpers have no acquire path in this release
export type _NoDeepbookMarginOptionsOnDeepbookBarrel = DB.DeepbookMarginOptions;

// @ts-expect-error — market-maker configuration has no acquire path in this release
export type _NoDeepbookMarketMakerOptionsOnDeepbookBarrel = DB.DeepbookMarketMakerOptions;

// @ts-expect-error — Pyth configuration is internal to DeepBook until it has real acquire behavior
export type _NoPythOptionsOnDeepbookBarrel = DB.PythOptions;

// @ts-expect-error — margin defaults are not exported without margin behavior
export type _NoUsdcMarginDefaultsOnDeepbookBarrel = DPV['USDC_MARGIN_DEFAULTS'];

// @ts-expect-error — margin defaults are not exported without margin behavior
export type _NoDefaultPoolRiskConfigOnDeepbookBarrel = DPV['DEFAULT_POOL_RISK_CONFIG'];

const localNet: NetworkConfig<'local'> = { mode: 'local', chain: chainId('sui:localnet') };
const liveNet: NetworkConfig<'live'> = { mode: 'live', chain: chainId('sui:testnet') };
const forkNet: NetworkConfig<'fork'> = {
	mode: 'fork',
	chain: chainId('sui:mainnet-fork'),
	checkpoint: '1',
};

declare const publisher: never;

// --- Positive: local mode allows .local + .known ------------------------
export const _localLocal = deepbookFor(localNet).local({ publisher });
export const _localKnown = deepbookFor(localNet).known({
	packageId: '0xpkg',
	registryId: '0xreg',
});
export const _localKnownByNetwork = deepbookFor(localNet).known({
	network: 'testnet',
});

// --- Negative: local mode does not expose unsupported feature options ----
// @ts-expect-error — local pools are not a public option until they acquire real behavior
export const _localPoolsRefused = deepbookFor(localNet).local({ publisher, pools: [] });

export const _localMarketMakerRefused = deepbookFor(localNet).local({
	publisher,
	// @ts-expect-error — market-maker cannot be configured while it has no real acquire path
	marketMaker: {
		signer: publisher,
		strategy: { kind: 'bps', spreadBps: 10, levelSpacingBps: 100, levels: 3 },
	},
});

// --- Positive: live mode allows .known -----------------------------------
export const _liveKnown = deepbookFor(liveNet).known({
	packageId: '0xpkg',
	registryId: '0xreg',
});
export const _liveKnownByNetwork = deepbookFor(liveNet).known({
	network: 'mainnet',
});

// --- Negative: live mode has no .local -----------------------------------
// @ts-expect-error — `.local` doesn't exist on the live branch
export const _liveLocalRefused = deepbookFor(liveNet).local({ publisher });

// --- Positive: fork mode allows .known ----------------------------------
export const _forkKnown = deepbookFor(forkNet).known({
	packageId: '0xpkg',
	registryId: '0xreg',
});
export const _forkKnownByNetwork = deepbookFor(forkNet).known({
	network: 'mainnet',
});

// --- Negative: fork mode has no .local ----------------------------------
// @ts-expect-error — `.local` doesn't exist on the fork branch (mode refusal)
export const _forkLocalRefused = deepbookFor(forkNet).local({ publisher });
