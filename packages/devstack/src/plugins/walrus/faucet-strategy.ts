// Walrus WAL faucet strategy.
//
// Distilled-doc reference (06-walrus.md §"Lifecycle phase 7a"):
// when the local cluster has a non-empty `exchange` AND at least one
// seed account, walrus registers a `walExchangeStrategy` on the
// global strategy registry so any
// `account('alice', { funding: [{ coin: wal, amount }] })` request
// gets satisfied via SUI → WAL swap on chain.
//
// Architecture (StrategyContributor §7): the faucet registry is
// `capabilityKey: 'coinType:<fullCoinType>'` (distilled-doc
// convention shared with the faucet plugin's domain:discriminator
// pattern). The dispatch site doesn't import this strategy — it
// looks it up by key.
//
// Local-cluster mode only: the known-deployment branch has no
// admin signer, so it cannot register a WAL strategy. (Architecture
// "asymmetric tag fanout" — the admin tag's absence is what
// type-narrows the strategy's availability.)

import { Effect } from 'effect';

import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import type { WalrusPluginError } from './errors.ts';
import {
	swapSuiForWal,
	type WalExchangeHandle,
	type WalSwapSdk,
	type WalSwapSigner,
} from './seed-wal.ts';

/** Full local WAL coin type derived from the deployed Walrus package. */
export const walCoinType = <PackageId extends string>(
	packageId: PackageId,
): `${PackageId}::wal::WAL` => `${packageId}::wal::WAL` as const;

/** Capability key for the WAL faucet strategy. */
export const walFaucetStrategyKey = <FullCoinType extends string>(
	fullCoinType: FullCoinType,
): `coinType:${FullCoinType}` => `coinType:${fullCoinType}` as const;

/** Per-request shape — uniform across faucet strategies. */
export interface WalFaucetRequest {
	readonly address: string;
	readonly amount: bigint; // MIST (1 SUI = 10^9 MIST)
}

/** Faucet strategy value — closed over the WAL exchange's object
 *  id + the admin signer at construction time. The dispatch site
 *  invokes `request(...)` and gets a typed `Effect<void, error>`. */
export interface WalFaucetStrategy {
	readonly request: (req: WalFaucetRequest) => Effect.Effect<void, WalrusPluginError>;
}

/** Inputs the local-cluster mode passes when constructing this. */
export interface WalFaucetStrategyOptions {
	readonly exchange: WalExchangeHandle;
	readonly sdk: WalSwapSdk;
	/** Admin signer — the first seed account doubles as the swap
	 *  signer (distilled-doc §"Configuration"). The strategy closes
	 *  over the signer at construction so the dispatch site sees a
	 *  context-free `(req) => Effect.Effect<...>` shape. */
	readonly signer: WalSwapSigner;
	readonly defaultPaymentMist: bigint;
}

/** Build the strategy value.
 *
 *  The request amount is SUI MIST to spend on the exchange; `0n`
 *  falls back to the local walrus `seedPaymentMist` default. */
export const makeWalFaucetStrategy = (opts: WalFaucetStrategyOptions): WalFaucetStrategy => ({
	request: (req) =>
		Effect.scoped(
			swapSuiForWal({
				signer: opts.signer,
				sdk: opts.sdk,
				exchange: opts.exchange,
				recipientAddress: req.address,
				paymentMist: req.amount > 0n ? req.amount : opts.defaultPaymentMist,
			}),
		).pipe(Effect.asVoid),
});

/** Build the StrategyContributor decl. The faucet plugin's
 *  dispatcher reads this key off the registry and dispatches WAL
 *  funding requests through it. */
export const makeWalFaucetContribution = (
	fullCoinType: string,
	opts: WalFaucetStrategyOptions,
): StrategyContributorDecl<ReturnType<typeof walFaucetStrategyKey>, WalFaucetStrategy> => ({
	kind: 'strategy-contributor',
	capabilityKey: walFaucetStrategyKey(fullCoinType),
	strategy: makeWalFaucetStrategy(opts),
	autoMounted: true,
});
