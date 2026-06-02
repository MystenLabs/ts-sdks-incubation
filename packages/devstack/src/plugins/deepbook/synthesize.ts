// Synthesize a fully working local DeepBook from the bundled Move sources.
//
// `deepbook({ mode: 'local' })` with no explicit `package`/`pyth`/`pools`
// should yield a tradeable local DeX. The publish itself is delegated to the
// generic `localPackage(...)` (deepbook does NOT own the publish path), so this
// module constructs the member refs deepbook's local plugin already consumes:
//
//   - an ephemeral funded publisher account (when the caller gave none),
//   - a `localPackage('deepbook', …)` pointed at the bundled DeepBook tree,
//     capturing registry / admin-cap / DEEP-treasury ids,
//   - a `localPackage('pyth', …)` pointed at the bundled sandbox-Pyth tree,
//   - a default DEEP/SUI pool (base = package DEEP, quote = builtin SUI) with
//     seed liquidity, plus DEEP + SUI Pyth feeds.
//
// Every synthesized member is a real plugin ref: deepbook's `localDependsOn`
// lists them, so `defineDevstack`'s dependency-closure pulls them into the
// stack automatically — the app never declares them.

import { account } from '../account/index.ts';
import { coin } from '../coin/index.ts';
import { localPackage } from '../package/index.ts';

import {
	bundledDeepbookSource,
	bundledPythSource,
} from './bootstrap-assets/index.ts';
import {
	DEEP_PRICE_FEED_ID,
	SUI_PRICE_FEED_ID,
	type DeepbookPoolSpec,
	type PythOptions,
} from './types.ts';
import type { AccountMemberAlias, DeepbookPackageMember } from './types.ts';

/** Funding for a synthesized publisher: enough SUI to publish two packages,
 *  pay gas, and seed the quote (SUI) side of the default pool. */
const SYNTH_PUBLISHER_SUI = 1_000_000_000_000n;

/** Default DEEP/SUI pool — DeepBook's reference whitelisted pool. Base DEEP
 *  comes from the published DeepBook package (mintable witness coin); quote SUI
 *  is the builtin. Tick / lot / min / seed values are the deepbook-trader
 *  reference values reduced to a single pool. */
const DEFAULT_DEEP_SUI_POOL = {
	name: 'DEEP_SUI',
	tickSize: 1_000_000n,
	lotSize: 1_000_000n,
	minSize: 10_000_000n,
	seedPrice: 6_000_000n,
	seedBidPrice: 5_000_000n,
	seedBaseAmount: 1_000_000_000n,
	seedQuoteAmount: 10_000_000_000n,
	whitelisted: true,
	stablePool: false,
} as const;

export interface SynthesizedLocalDeepbook {
	readonly publisher: AccountMemberAlias;
	readonly package: DeepbookPackageMember;
	readonly pools: readonly [DeepbookPoolSpec];
	readonly pyth: PythOptions;
	readonly deepTreasuryIdKey: 'deepTreasuryId';
}

/** Build the publisher + bundled-package members + default pool/feed presets
 *  for a no-arg local DeepBook. `name` scopes the synthesized member ids so
 *  multiple `deepbook({name})` instances don't collide. `publisher` overrides
 *  the synthesized account when the caller supplies one. */
export const synthesizeLocalDeepbook = (
	name: string,
	publisherOverride?: AccountMemberAlias,
): SynthesizedLocalDeepbook => {
	// Account names: `^[A-Za-z][A-Za-z0-9_]{0,63}$` — underscores, no hyphens.
	const suffix = name === 'deepbook' ? '' : `_${name.replace(/[^A-Za-z0-9_]/g, '_')}`;

	const publisher =
		publisherOverride ??
		(account(`deepbook${suffix}_publisher`, {
			kind: 'ephemeral',
			funding: [{ coin: 'sui', amount: SYNTH_PUBLISHER_SUI }],
		}) as AccountMemberAlias);

	const pythPublisher = account(`deepbook${suffix}_pyth_publisher`, {
		kind: 'ephemeral',
		funding: [{ coin: 'sui', amount: SYNTH_PUBLISHER_SUI }],
	}) as AccountMemberAlias;

	// Unique package member ids per deepbook instance.
	const deepbookPackageName = name === 'deepbook' ? 'deepbook' : `deepbook_${name}`;
	const pythPackageName = name === 'deepbook' ? 'pyth' : `pyth_${name}`;

	const deepbookPackage = localPackage(deepbookPackageName, {
		sourcePath: bundledDeepbookSource(),
		publisher,
		capture: {
			registryId: '::registry::Registry',
			adminCapId: '::registry::DeepbookAdminCap',
			deepTreasuryId: '::deep::ProtectedTreasury',
		},
	}) as unknown as DeepbookPackageMember;

	const pythPackage = localPackage(pythPackageName, {
		sourcePath: bundledPythSource(),
		publisher: pythPublisher,
	});

	const deep = coin.fromPackage(
		deepbookPackage as unknown as Parameters<typeof coin.fromPackage>[0],
		'DEEP',
	);
	const suiCoin = coin.builtin('sui');

	const pool: DeepbookPoolSpec = {
		name: DEFAULT_DEEP_SUI_POOL.name,
		tickSize: DEFAULT_DEEP_SUI_POOL.tickSize,
		lotSize: DEFAULT_DEEP_SUI_POOL.lotSize,
		minSize: DEFAULT_DEEP_SUI_POOL.minSize,
		whitelisted: DEFAULT_DEEP_SUI_POOL.whitelisted,
		stablePool: DEFAULT_DEEP_SUI_POOL.stablePool,
		base: { key: 'DEEP', coin: deep },
		quote: { key: 'SUI', coin: suiCoin },
		seed: {
			baseAmount: DEFAULT_DEEP_SUI_POOL.seedBaseAmount,
			quoteAmount: DEFAULT_DEEP_SUI_POOL.seedQuoteAmount,
			orders: [
				{
					side: 'ask',
					price: DEFAULT_DEEP_SUI_POOL.seedPrice,
					quantity: DEFAULT_DEEP_SUI_POOL.seedBaseAmount,
				},
				{
					side: 'bid',
					price: DEFAULT_DEEP_SUI_POOL.seedBidPrice,
					quantity: DEFAULT_DEEP_SUI_POOL.seedBaseAmount,
				},
			],
		},
	};

	const pyth: PythOptions = {
		package: pythPackage,
		pusher: pythPublisher,
		feeds: [
			{ symbol: 'DEEP', feedId: DEEP_PRICE_FEED_ID, initialPrice: 2_000_000n, expo: -8 },
			{ symbol: 'SUI', feedId: SUI_PRICE_FEED_ID, initialPrice: 345_000_000n, expo: -8 },
		],
	};

	return {
		publisher,
		package: deepbookPackage,
		pools: [pool],
		pyth,
		deepTreasuryIdKey: 'deepTreasuryId',
	};
};
