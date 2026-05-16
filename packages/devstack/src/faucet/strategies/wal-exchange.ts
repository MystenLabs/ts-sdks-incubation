// WAL faucet strategy. Wraps the walrus exchange `exchange_all_for_wal`
// Move call so any account can ask for WAL via
// `Account({ funding: { WAL: ... } })` without being listed on
// `Walrus({ local: { seedAccounts } })`.
//
// `walrusLocalCluster` registers an instance of this strategy after the
// exchange object resolves; the SUI side is paid by `signer` (typically
// `seedAccounts[0]`, the same account that pays for the deploy phase),
// the WAL output is transferred to the requested destination address.
// On testnet/mainnet the local-cluster body never runs, so no strategy
// is registered there — funding `WAL` on a live network surfaces a
// clean "no strategy registered for 'WAL'" error.
//
// The `amount` argument is interpreted as SUI MIST to spend on the swap
// (matching `Walrus({ local: { seedPaymentMist } })`'s semantics): a
// caller of `Account({ funding: { WAL: 500_000_000n } })` is saying
// "spend 0.5 SUI on WAL", not "give me exactly 500_000_000 frost". The
// resulting WAL is whatever `exchange_all_for_wal` returns at the
// current rate. `amount === 0n` falls back to `defaultPaymentMist`
// (the same value the seed-accounts loop uses for explicit listings).

import { Effect } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { FaucetRequestError } from '../errors.js';
import { defineStrategy } from './internal.js';
import type { FaucetStrategy } from '../service.js';
import type { Account } from '../../engine/shared.js';

/** Resolved walrus-exchange handle. Mirrors the internal `ExchangeState`
 *  shape from `services/walrus/internal.ts` — repeated here to avoid
 *  cross-importing from a higher-level module. */
export interface WalExchangeHandle {
	readonly objectId: string;
	readonly packageId: string;
}

export interface WalExchangeStrategyOptions {
	/** The walrus exchange the swap targets. Resolved by walrusLocalCluster
	 *  after the deploy step finds the exchange object's id + package id. */
	readonly exchange: WalExchangeHandle;
	/** SUI-funded account that pays for the swap. WAL output is transferred
	 *  to the destination address requested by the caller. */
	readonly signer: Account;
	/** SUI MIST to spend when the caller passes `amount === 0n`. */
	readonly defaultPaymentMist: bigint;
}

/**
 * Build a WAL faucet strategy. Drop into
 * `Faucet.register(walExchangeStrategy({ exchange, signer, defaultPaymentMist }))`
 * — `walrusLocalCluster` registers an instance automatically when at
 * least one `seedAccounts` is declared.
 */
export const walExchangeStrategy = (
	opts: WalExchangeStrategyOptions,
): FaucetStrategy =>
	defineStrategy({
		coinType: 'WAL',
		request: ({ address, amount }) =>
			Effect.gen(function* () {
				const paymentMist = amount > 0n ? amount : opts.defaultPaymentMist;
				const tx = new Transaction();
				const paymentCoin = tx.coin({
					balance: paymentMist,
					type: '0x2::sui::SUI',
					useGasCoin: true,
				});
				const walCoin = tx.moveCall({
					target: `${opts.exchange.packageId}::wal_exchange::exchange_all_for_wal`,
					arguments: [tx.object(opts.exchange.objectId), paymentCoin],
				});
				tx.transferObjects([walCoin], tx.pure.address(address));
				yield* opts.signer.signAndExecute(tx).pipe(
					Effect.mapError(
						(cause) =>
							new FaucetRequestError({
								coinType: 'WAL',
								address,
								amount,
								message: `WAL exchange swap failed for ${address}: ${cause.message}`,
								cause,
							}),
					),
				);
			}),
	});
