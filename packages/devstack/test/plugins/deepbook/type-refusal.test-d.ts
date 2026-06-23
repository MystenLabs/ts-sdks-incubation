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
import type * as DB from '../../../src/plugins/deepbook/index.ts';
import type { NetworkConfig } from '../../../src/plugins/sui/network-config.ts';

// --- Negative: unsupported helpers are not public DeepBook API -----------
type DPV = typeof import('../../../src/plugins/deepbook/index.ts');

export type _DeepbookPoolSpecOnDeepbookBarrel = DB.DeepbookPoolSpec;

// @ts-expect-error — margin configuration/default helpers have no acquire path in this release
export type _NoDeepbookMarginOptionsOnDeepbookBarrel = DB.DeepbookMarginOptions;

// @ts-expect-error — market-maker configuration has no acquire path in this release
export type _NoDeepbookMarketMakerOptionsOnDeepbookBarrel = DB.DeepbookMarketMakerOptions;

// @ts-expect-error — Pyth lives inside deepbook as an implementation detail; not exposed on the deepbook barrel
export type _NoPythOptionsOnDeepbookBarrel = DB.PythOptions;

// @ts-expect-error — margin defaults are not exported without margin behavior
export type _NoUsdcMarginDefaultsOnDeepbookBarrel = DPV['USDC_MARGIN_DEFAULTS'];

// @ts-expect-error — margin defaults are not exported without margin behavior
export type _NoDefaultPoolRiskConfigOnDeepbookBarrel = DPV['DEFAULT_POOL_RISK_CONFIG'];

const localNet: NetworkConfig<'local'> = { mode: 'local', chainId: 'sui:localnet' };
const liveNet: NetworkConfig<'live'> = { mode: 'live', chainId: 'sui:testnet' };
const forkNet: NetworkConfig<'fork'> = {
	mode: 'fork',
	chainId: 'sui:mainnet-fork',
	checkpoint: '1',
};

declare const publisher: never;
declare const deepbookPackage: never;

// --- Positive: local mode allows .local + .override + .known -------------
export const _localLocal = deepbookFor(localNet).local({
	publisher,
	package: deepbookPackage,
	pools: [] as const,
});
export const _localOverride = deepbookFor(localNet).override({
	packageId: '0xpkg',
	registryId: '0xreg',
	adminCapId: '0xadmin',
});
export const _localKnown = deepbookFor(localNet).known({
	packageId: '0xpkg',
	registryId: '0xreg',
});
// --- Positive: per-network methods replace the `network`-in-`.known()` path -
export const _localTestnet = deepbookFor(localNet).testnet();
export const _localMainnet = deepbookFor(localNet).mainnet();
export const _localTestnetOverride = deepbookFor(localNet).testnet({ name: 'arena' });

// --- Negative: `.known()` is raw-id override only — the network-keyed branch
// was hard cut, so `{ network }` ALONE (no ids) no longer satisfies `.known()`;
// it now requires explicit packageId + registryId. Use `.testnet()`/`.mainnet()`
// for the known-by-network path.
// @ts-expect-error — `.known()` requires packageId + registryId; the
// `network`-only branch was removed. Use `.testnet()`/`.mainnet()`.
export const _localKnownByNetworkRefused = deepbookFor(localNet).known({
	network: 'testnet',
});

// --- Positive: local mode exposes local pool configuration ---------------
export const _localPoolsAllowed = deepbookFor(localNet).local({
	publisher,
	package: deepbookPackage,
	pools: [],
});

// --- Negative: override mode does not expose managed-local options -------
export const _localPoolsRefused = deepbookFor(localNet).override({
	packageId: '0xpkg',
	registryId: '0xreg',
	adminCapId: '0xadmin',
	// @ts-expect-error — local pools belong to `.local`, not `.override`
	pools: [],
});

export const _localPythRefused = deepbookFor(localNet).override({
	packageId: '0xpkg',
	registryId: '0xreg',
	adminCapId: '0xadmin',
	// @ts-expect-error — local Pyth setup belongs to `.local`, not `.override`
	pyth: {},
});

export const _localMarketMakerRefused = deepbookFor(localNet).local({
	publisher,
	package: deepbookPackage,
	pools: [] as const,
	// @ts-expect-error — market-maker cannot be configured while it has no real acquire path
	marketMaker: {
		strategy: { kind: 'bps', spreadBps: 10, levelSpacingBps: 100, levels: 3 },
	},
});

// --- Positive: live mode allows .known + per-network methods -------------
export const _liveKnown = deepbookFor(liveNet).known({
	packageId: '0xpkg',
	registryId: '0xreg',
});
export const _liveTestnet = deepbookFor(liveNet).testnet();
export const _liveMainnet = deepbookFor(liveNet).mainnet();

// --- Negative: live mode has no .local or .override ----------------------
// @ts-expect-error — `.local` doesn't exist on the live branch
export const _liveLocalRefused = deepbookFor(liveNet).local({
	publisher,
	package: deepbookPackage,
	pools: [] as const,
});

// @ts-expect-error — `.override` doesn't exist on the live branch
export const _liveOverrideRefused = deepbookFor(liveNet).override({
	packageId: '0xpkg',
	registryId: '0xreg',
	adminCapId: '0xadmin',
});

// --- Positive: fork mode allows .known + per-network methods -------------
export const _forkKnown = deepbookFor(forkNet).known({
	packageId: '0xpkg',
	registryId: '0xreg',
});
export const _forkTestnet = deepbookFor(forkNet).testnet();
export const _forkMainnet = deepbookFor(forkNet).mainnet();

// --- Negative: fork mode has no .local or .override ----------------------
// @ts-expect-error — `.local` doesn't exist on the fork branch
export const _forkLocalRefused = deepbookFor(forkNet).local({
	publisher,
	package: deepbookPackage,
	pools: [] as const,
});

// @ts-expect-error — `.override` doesn't exist on the fork branch
export const _forkOverrideRefused = deepbookFor(forkNet).override({
	packageId: '0xpkg',
	registryId: '0xreg',
	adminCapId: '0xadmin',
});
