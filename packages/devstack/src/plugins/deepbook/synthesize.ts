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

import { createHash } from 'node:crypto';

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

/** Explicit pieces the caller already supplied. Synthesis fills ONLY the gaps,
 *  building the defaults RELATIVE to these so a partial override
 *  (e.g. explicit `package` + `publisher`, omitted `pools`) does not fabricate
 *  a hidden duplicate package / pyth and does not seed the default pool with a
 *  phantom DEEP coin type. */
export interface SynthesisOverrides {
	readonly publisher?: AccountMemberAlias;
	readonly package?: DeepbookPackageMember;
	readonly pyth?: PythOptions;
}

/** Collision-resistant member-id segment for a named instance.
 *
 *  Account names allow `^[A-Za-z][A-Za-z0-9_]{0,63}$` (underscores, no
 *  hyphens), so a bare `name.replace(/[^A-Za-z0-9_]/g, '_')` collapses distinct
 *  instance names that differ only by a sanitized char (`foo-bar` vs
 *  `foo_bar`) onto the same suffix — tripping a duplicate-account-provider
 *  error in `defineDevstack`. Append a short stable hash of the ORIGINAL name
 *  whenever sanitation changed anything, so distinct names map to distinct
 *  ids. */
const synthSuffix = (name: string): string => {
	if (name === 'deepbook') {
		return '';
	}
	const sanitized = name.replace(/[^A-Za-z0-9_]/g, '_');
	if (sanitized === name) {
		return `_${sanitized}`;
	}
	const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
	return `_${sanitized}_${hash}`;
};

/** Build the publisher + bundled-package members + default pool/feed presets
 *  for a local DeepBook. `name` scopes the synthesized member ids so multiple
 *  `deepbook({name})` instances don't collide. `overrides` carries any caller-
 *  supplied `publisher` / `package` / `pyth`; synthesis fills only the missing
 *  pieces and builds the default pool RELATIVE to the explicit package's DEEP
 *  coin when one was given. */
export const synthesizeLocalDeepbook = (
	name: string,
	overrides: SynthesisOverrides = {},
): SynthesizedLocalDeepbook => {
	const suffix = synthSuffix(name);

	const publisher =
		overrides.publisher ??
		(account(`deepbook${suffix}_publisher`, {
			kind: 'ephemeral',
			funding: [{ coin: 'sui', amount: SYNTH_PUBLISHER_SUI }],
		}) as AccountMemberAlias);

	// Unique package member id per deepbook instance. Only synthesized when the
	// caller omitted `package`; otherwise the explicit member is reused so the
	// default pool's DEEP coin and the registry/admin-cap all come from ONE
	// package (no hidden duplicate `package:deepbook` provider).
	const deepbookPackageName = name === 'deepbook' ? 'deepbook' : `deepbook${suffix}`;

	const deepbookPackage =
		overrides.package ??
		(localPackage(deepbookPackageName, {
			sourcePath: bundledDeepbookSource(),
			publisher,
			capture: {
				registryId: '::registry::Registry',
				adminCapId: '::registry::DeepbookAdminCap',
				deepTreasuryId: '::deep::ProtectedTreasury',
			},
		}) as unknown as DeepbookPackageMember);

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

	// Pyth is an independent sandbox package, synthesized ONLY when the caller
	// gave none. When the caller supplied their own `pyth`, reuse it verbatim —
	// otherwise `localDependsOn` (which runs on the RESOLVED options) would pull
	// BOTH the caller's pyth and a fabricated one into the closure.
	const pyth: PythOptions =
		overrides.pyth ??
		(() => {
			const pythPublisher = account(`deepbook${suffix}_pyth_publisher`, {
				kind: 'ephemeral',
				funding: [{ coin: 'sui', amount: SYNTH_PUBLISHER_SUI }],
			}) as AccountMemberAlias;
			const pythPackageName = name === 'deepbook' ? 'pyth' : `pyth${suffix}`;
			const pythPackage = localPackage(pythPackageName, {
				sourcePath: bundledPythSource(),
				publisher: pythPublisher,
			});
			return {
				package: pythPackage,
				pusher: pythPublisher,
				feeds: [
					{ symbol: 'DEEP', feedId: DEEP_PRICE_FEED_ID, initialPrice: 2_000_000n, expo: -8 },
					{ symbol: 'SUI', feedId: SUI_PRICE_FEED_ID, initialPrice: 345_000_000n, expo: -8 },
				],
			};
		})();

	return {
		publisher,
		package: deepbookPackage,
		pools: [pool],
		pyth,
		deepTreasuryIdKey: 'deepTreasuryId',
	};
};
