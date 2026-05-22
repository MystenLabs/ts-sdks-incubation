// Walrus WAL faucet strategy.
//
// Distilled-doc reference (06-walrus.md §"Lifecycle phase 7a"):
// when the local cluster has a non-empty `exchange`, walrus registers
// a WAL exchange strategy on the global strategy registry so any
// `account('alice', { funding: [{ coin: wal, amount }] })` request
// gets satisfied via SUI → WAL swap on chain.
//
// Architecture (StrategyContributor §7): the faucet registry is
// `capabilityKey: 'coinType:<fullCoinType>'` (distilled-doc
// convention shared with the faucet plugin's domain:discriminator
// pattern). The dispatch site doesn't import this strategy — it
// looks it up by key.
//
import { Effect } from 'effect';

import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import type { AccountFundingRequest, AccountFundingStrategy } from '../account/index.ts';
import type { WalrusPluginError } from './errors.ts';
import { swapAccountSuiForWal, type WalExchangeHandle, type WalSwapSdk } from './wal-swap.ts';

/** Full local WAL coin type derived from the deployed Walrus package. */
export const walCoinType = <PackageId extends string>(
	packageId: PackageId,
): `${PackageId}::wal::WAL` => `${packageId}::wal::WAL` as const;

/** Capability key for the WAL faucet strategy. */
export const walFaucetStrategyKey = <FullCoinType extends string>(
	fullCoinType: FullCoinType,
): `coinType:${FullCoinType}` => `coinType:${fullCoinType}` as const;

/** Per-request shape — the shared account funding request. */
export type WalFaucetRequest = AccountFundingRequest;

/** Faucet strategy value — closed over the WAL exchange's object id.
 *  The requesting account signs the swap through the shared account
 *  funding pipeline. */
export type WalFaucetStrategy = AccountFundingStrategy<WalrusPluginError>;

/** Inputs the local-cluster mode passes when constructing this. */
export interface WalFaucetStrategyOptions {
	readonly exchange: WalExchangeHandle;
	readonly sdk: WalSwapSdk;
}

/** Build the strategy value.
 *
 *  The request amount is the SUI MIST amount to spend on the local
 *  exchange for WAL. Account funding skips zero amounts before the
 *  strategy is invoked; the guard here keeps direct calls no-op. */
export const makeWalFaucetStrategy = (opts: WalFaucetStrategyOptions): WalFaucetStrategy => ({
	usesAccountSigner: true,
	request: (req) =>
		req.amount <= 0n
			? Effect.void
			: swapAccountSuiForWal({
					account: req.account,
					sdk: opts.sdk,
					exchange: opts.exchange,
					recipientAddress: req.address,
					paymentMist: req.amount,
				}).pipe(Effect.asVoid),
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
