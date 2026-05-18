// TreasuryCap mint faucet strategy. Wraps `0x2::coin::mint_and_transfer`
// against a held TreasuryCap so any coin declared via
// `Package({ coins: [...] })` becomes mintable through
// `Account({ funding: { '<pkgId>::module::TYPE': amount } })` — no
// hand-rolled strategy literal per coin.
//
// `publishMove` registers an instance of this strategy after capturing
// the TreasuryCap from `objectChanges`; the signer is the same account
// that signed the publish (and therefore holds the cap). On
// testnet/mainnet the publish path runs against a live network and
// still ends up holding the cap, but auto-faucet for live networks
// isn't a thing devstack tries to do — `Account({ funding })` on live
// nets is the user's responsibility.
//
// The `amount` argument is the target balance in the coin's smallest
// unit (`u64`), matching the `mint_and_transfer` Move signature
// directly. `amount === 0n` is treated as a no-op since minting zero
// units is meaningless.

import { Effect } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { FaucetRequestError, type FaucetStrategy } from '../index.js';
import type { Account } from '../../../engine/shared.js';

export interface TreasuryCapMintStrategyOptions {
	/** Fully-qualified Move type, e.g. `'0xabc::usdc::USDC'`. Used as
	 *  both the strategy's dispatch key and the `mint_and_transfer`
	 *  type argument. */
	readonly coinType: string;
	/** TreasuryCap object id captured from the publish's `objectChanges`. */
	readonly treasuryCapId: string;
	/** Account that holds the cap. Typically the same account that
	 *  signed the original publish. */
	readonly signer: Account;
}

/**
 * Build a TreasuryCap mint faucet strategy. Drop into
 * `Faucet.register(treasuryCapMintStrategy({...}))` — `publishMove`
 * registers an instance automatically for each coin in
 * `Package({ coins })`.
 */
export const treasuryCapMintStrategy = (opts: TreasuryCapMintStrategyOptions): FaucetStrategy => ({
	coinType: opts.coinType,
	request: ({ address, amount }) =>
		Effect.gen(function* () {
			if (amount <= 0n) {
				return;
			}
			const tx = new Transaction();
			tx.moveCall({
				target: '0x2::coin::mint_and_transfer',
				typeArguments: [opts.coinType],
				arguments: [tx.object(opts.treasuryCapId), tx.pure.u64(amount), tx.pure.address(address)],
			});
			yield* opts.signer.signAndExecute(tx).pipe(
				Effect.mapError(
					(cause) =>
						new FaucetRequestError({
							coinType: opts.coinType,
							address,
							amount,
							message:
								`TreasuryCap mint failed for ${address} (cap=${opts.treasuryCapId}): ` +
								cause.message,
							cause,
						}),
				),
			);
		}),
});
