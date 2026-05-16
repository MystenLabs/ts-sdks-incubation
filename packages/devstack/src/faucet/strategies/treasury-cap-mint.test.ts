// Unit-level coverage for `treasuryCapMintStrategy`. Verifies the
// strategy dispatches via the cap-holder signer for non-zero amounts,
// no-ops on `amount === 0n`, and wraps signing failures in
// `FaucetRequestError`. The full mint-and-transfer round-trip lands in
// the package integration test that publishes a coin against a real
// localnet.

import { Cause, Effect, Exit, Option } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { Transaction } from '@mysten/sui/transactions';
import type { Account } from '../../engine/shared.js';
import { FaucetRequestError } from '../errors.js';
import { treasuryCapMintStrategy } from './treasury-cap-mint.js';

const VALID_ADDR = '0x' + 'd'.repeat(64);
const VALID_OBJ = '0x' + 'e'.repeat(64);
const COIN_TYPE = `0x${'a'.repeat(64)}::usdc::USDC`;

const stubAccount = (
	signAndExecute: Account['signAndExecute'],
): Account => ({
	name: 'admin',
	address: VALID_ADDR,
	scheme: 'ED25519',
	publicKey: new Uint8Array(),
	signAndExecute,
	signTransaction: () => Effect.die('not used'),
	signPersonalMessage: () => Effect.die('not used'),
});

describe('treasuryCapMintStrategy', () => {
	it.effect('mints when amount > 0n via the cap-holder signer', () =>
		Effect.gen(function* () {
			let invoked = false;
			const signer = stubAccount((tx) =>
				Effect.sync(() => {
					expect(tx).toBeInstanceOf(Transaction);
					invoked = true;
					return { digest: 'd', effects: undefined, objectChanges: [], balanceChanges: undefined };
				}),
			);
			const strategy = treasuryCapMintStrategy({
				coinType: COIN_TYPE,
				treasuryCapId: VALID_OBJ,
				signer,
			});
			expect(strategy.coinType).toBe(COIN_TYPE);

			yield* strategy.request({ address: VALID_ADDR, amount: 1_000_000n });
			expect(invoked).toBe(true);
		}),
	);

	it.effect('no-ops on amount === 0n', () =>
		Effect.gen(function* () {
			let invoked = false;
			const signer = stubAccount(() =>
				Effect.sync(() => {
					invoked = true;
					return { digest: 'd', effects: undefined, objectChanges: [], balanceChanges: undefined };
				}),
			);
			const strategy = treasuryCapMintStrategy({
				coinType: COIN_TYPE,
				treasuryCapId: VALID_OBJ,
				signer,
			});
			yield* strategy.request({ address: VALID_ADDR, amount: 0n });
			expect(invoked).toBe(false);
		}),
	);

	it.effect('wraps signing failures in FaucetRequestError carrying coin type and address', () =>
		Effect.gen(function* () {
			const signer = stubAccount(() =>
				Effect.fail({
					_tag: 'SignAndExecuteError' as const,
					message: 'mint failed: cap object stale',
				}),
			);
			const strategy = treasuryCapMintStrategy({
				coinType: COIN_TYPE,
				treasuryCapId: VALID_OBJ,
				signer,
			});
			const exit = yield* Effect.exit(
				strategy.request({ address: VALID_ADDR, amount: 100n }),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const opt = Cause.findErrorOption(exit.cause);
				expect(Option.isSome(opt)).toBe(true);
				if (Option.isSome(opt)) {
					expect(opt.value).toBeInstanceOf(FaucetRequestError);
					const err = opt.value as FaucetRequestError;
					expect(err.coinType).toBe(COIN_TYPE);
					expect(err.address).toBe(VALID_ADDR);
					expect(err.message).toContain('cap object stale');
				}
			}
		}),
	);
});
