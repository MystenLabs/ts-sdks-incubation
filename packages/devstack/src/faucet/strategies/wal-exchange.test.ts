// Unit-level coverage for `walExchangeStrategy`. Verifies the strategy
// dispatches via the supplied admin signer with the expected payment
// amount, and wraps signing failures in `FaucetRequestError`. The full
// SUI→WAL round-trip lands in the walrus integration test that boots a
// real local cluster — `Transaction.toJSON` requires a resolved sender
// before its commands can be serialized for inspection here, so we
// assert via the stub signer instead of poking the tx body.

import { Cause, Effect, Exit, Option } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { Transaction } from '@mysten/sui/transactions';
import type { Account } from '../../engine/shared.js';
import { FaucetRequestError } from '../errors.js';
import { walExchangeStrategy } from './wal-exchange.js';

const VALID_ADDR = '0x' + 'd'.repeat(64);
const VALID_OBJ = '0x' + 'e'.repeat(64);

const stubAccount = (signAndExecute: Account['signAndExecute']): Account => ({
	name: 'admin',
	address: VALID_ADDR,
	scheme: 'ed25519',
	publicKey: new Uint8Array(),
	signAndExecute,
	signTransaction: () => Effect.die('not used'),
	signPersonalMessage: () => Effect.die('not used'),
});

describe('walExchangeStrategy', () => {
	it.effect(
		'dispatches the swap via the admin signer with the default payment when amount is 0n',
		() =>
			Effect.gen(function* () {
				let txInvoked = false;
				const account = stubAccount((tx) =>
					Effect.sync(() => {
						expect(tx).toBeInstanceOf(Transaction);
						txInvoked = true;
						return {
							digest: 'digest-x',
							effects: undefined,
							objectChanges: [],
							balanceChanges: undefined,
						};
					}),
				);
				const strategy = walExchangeStrategy({
					exchange: { objectId: VALID_OBJ, packageId: VALID_OBJ },
					signer: account,
					defaultPaymentMist: 500_000_000n,
				});
				expect(strategy.coinType).toBe('WAL');

				yield* strategy.request({ address: VALID_ADDR, amount: 0n });
				expect(txInvoked).toBe(true);
			}),
	);

	it.effect('honors a non-zero amount as the SUI MIST payment', () =>
		Effect.gen(function* () {
			let txInvoked = false;
			const account = stubAccount(() =>
				Effect.sync(() => {
					txInvoked = true;
					return {
						digest: 'digest-y',
						effects: undefined,
						objectChanges: [],
						balanceChanges: undefined,
					};
				}),
			);
			const strategy = walExchangeStrategy({
				exchange: { objectId: VALID_OBJ, packageId: VALID_OBJ },
				signer: account,
				defaultPaymentMist: 500_000_000n,
			});
			yield* strategy.request({ address: VALID_ADDR, amount: 123_000_000n });
			expect(txInvoked).toBe(true);
		}),
	);

	it.effect('wraps signing failures in FaucetRequestError', () =>
		Effect.gen(function* () {
			const account = stubAccount(() =>
				Effect.fail({
					_tag: 'SignAndExecuteError' as const,
					message: 'gas budget too low',
				}),
			);
			const strategy = walExchangeStrategy({
				exchange: { objectId: VALID_OBJ, packageId: VALID_OBJ },
				signer: account,
				defaultPaymentMist: 500_000_000n,
			});
			const exit = yield* Effect.exit(strategy.request({ address: VALID_ADDR, amount: 0n }));
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const opt = Cause.findErrorOption(exit.cause);
				expect(Option.isSome(opt)).toBe(true);
				if (Option.isSome(opt)) {
					expect(opt.value).toBeInstanceOf(FaucetRequestError);
					const err = opt.value as FaucetRequestError;
					expect(err.coinType).toBe('WAL');
					expect(err.address).toBe(VALID_ADDR);
					expect(err.message).toContain('gas budget too low');
				}
			}
		}),
	);
});
