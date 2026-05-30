// Regression coverage for the WAL-swap on-chain-failure dispatch.
//
// `swapAccountSuiForWal` drives `signAndDispatch`; the account bus's
// `signAndExecute` returns a `$kind: 'FailedTransaction'` RETURN-channel
// variant when the validator executed the tx but the Move call aborted.
// The `onFailed` callback MUST re-raise this as a plugin-shaped
// `WalrusPluginError(phase: 'fund-wal')` carrying the digest + the
// validator error (via `formatExecutedFailure`), NOT swallow it. The
// sibling sign-side failure must instead route through `mapSignError`.
//
// This is the branch the wal-swap.test.ts happy/pre-flight cases never
// reach: there `withTransactionSigner` short-circuits before the
// dispatch, so a regression that dropped the `onFailed` re-raise (or
// mis-tagged it) stayed green. These cases drive the real production
// `swapAccountSuiForWal` → `signAndDispatch` → `onFailed` / `mapSignError`
// path to a deterministic FailedTransaction / sign-failure outcome.
//
// `@mysten/sui/transactions` is mocked here (in a DEDICATED file so the
// real-`Transaction` assertions in wal-swap.test.ts are unaffected) so
// `buildWalSwapTransaction` + `tx.build({ client })` resolve without RPC.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Option } from 'effect';
import { vi } from 'vitest';

const harness = vi.hoisted(() => ({
	builtBytes: new Uint8Array([0x01, 0x02, 0x03]),
}));

vi.mock('@mysten/sui/transactions', () => ({
	Transaction: class {
		setSender(_address: string): void {}
		coin(_input: unknown): unknown {
			return { kind: 'coin' };
		}
		// `buildWalSwapTransaction` references the exchange via
		// `tx.object(args.exchange.objectId)` when assembling the
		// `exchange_all_for_wal` arguments. Omitting this method made the
		// build throw `tx.object is not a function` synchronously inside
		// `buildTxBytes`, so the effect died BEFORE `signAndExecute` ran
		// and the `onFailed` / `mapSignError` dispatch under test was
		// never reached (the die carries no typed error, so
		// `Exit.findErrorOption` was `None`).
		object(_id: unknown): unknown {
			return { kind: 'object' };
		}
		moveCall(_input: unknown): unknown {
			return { kind: 'movecall' };
		}
		transferObjects(_objects: ReadonlyArray<unknown>, _recipient: unknown): void {}
		readonly pure = {
			address: (value: string) => ({ kind: 'address', value }),
		};
		build(): Promise<Uint8Array> {
			return Promise.resolve(harness.builtBytes);
		}
	},
}));

import { swapAccountSuiForWal, type WalSwapSdk } from '../../../src/plugins/walrus/wal-swap.ts';
import type {
	AccountValue,
	SignAndExecuteResult,
	AccountSignError,
} from '../../../src/plugins/account/index.ts';

// SUI balance the pre-flight reads: comfortably above `paymentMist +
// WAL_SWAP_GAS_RESERVE_MIST` so the best-effort refusal passes and
// control reaches the wire (the dispatch under test).
const PLENTIFUL_BALANCE = '100000000000';
const PAYMENT_MIST = 500_000_000n;

const stubSdk: WalSwapSdk = {
	client: {} as never,
	core: {
		getBalance: async () => ({ balance: { balance: PLENTIFUL_BALANCE } }),
	},
};

/** Build an `AccountValue` whose locked signer returns `result` from
 *  `signAndExecute` (or fails with `signError` when supplied), so the
 *  real `signAndDispatch` dispatches on the resulting `$kind`. */
const stubAccount = (opts: {
	readonly result?: SignAndExecuteResult;
	readonly signError?: AccountSignError;
}): AccountValue => ({
	name: 'alice',
	address: '0xalice',
	scheme: 'ed25519',
	publicKey: new Uint8Array(32),
	source: 'real',
	funding: { requested: [], applied: [] },
	signAndExecute: () => Effect.die('unused — drive via withTransactionSigner'),
	signTransaction: () => Effect.die('unused'),
	signPersonalMessage: () => Effect.die('unused'),
	withTransactionSigner: (body) =>
		body({
			signTransaction: () => Effect.succeed({ bytes: 'aa', signature: 'sig' }),
			signAndExecute: () =>
				opts.signError !== undefined ? Effect.fail(opts.signError) : Effect.succeed(opts.result!),
		}),
});

describe('walrus WAL swap — FailedTransaction return dispatch', () => {
	it.effect(
		'maps $kind:"FailedTransaction" to WalrusPluginError(fund-wal) with digest + validator error',
		() =>
			Effect.gen(function* () {
				const account = stubAccount({
					result: {
						$kind: 'FailedTransaction',
						FailedTransaction: {
							digest: '0xbad-swap',
							executionError: 'MoveAbort(wal_exchange::EInsufficientFunds, 3)',
						},
					},
				});
				const exit = yield* Effect.exit(
					swapAccountSuiForWal({
						account,
						sdk: stubSdk,
						exchange: { objectId: '0xexchange', packageId: '0xpkg' },
						recipientAddress: '0xalice',
						paymentMist: PAYMENT_MIST,
					}),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				const err = Exit.findErrorOption(exit);
				expect(Option.isSome(err)).toBe(true);
				if (Option.isSome(err)) {
					expect(err.value._tag).toBe('WalrusPluginError');
					expect(err.value.phase).toBe('fund-wal');
					// `onFailed` wording + `formatExecutedFailure(failure)` tail.
					expect(err.value.message).toContain('on-chain');
					expect(err.value.message).toContain('0xexchange');
					expect(err.value.message).toContain('0xbad-swap');
					expect(err.value.message).toContain('MoveAbort(wal_exchange::EInsufficientFunds, 3)');
					// On-chain FailedTransaction is a return value, not an upstream
					// error — the re-raised plugin error carries no `cause`.
					expect(err.value.cause).toBeUndefined();
				}
			}),
	);

	it.effect(
		'FailedTransaction with no validator error still re-raises with the noted-absent tail',
		() =>
			Effect.gen(function* () {
				const account = stubAccount({
					result: {
						$kind: 'FailedTransaction',
						FailedTransaction: { digest: '0xno-detail' },
					},
				});
				const exit = yield* Effect.exit(
					swapAccountSuiForWal({
						account,
						sdk: stubSdk,
						exchange: { objectId: '0xexchange', packageId: '0xpkg' },
						recipientAddress: '0xalice',
						paymentMist: PAYMENT_MIST,
					}),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				const err = Exit.findErrorOption(exit);
				expect(Option.isSome(err)).toBe(true);
				if (Option.isSome(err)) {
					expect(err.value._tag).toBe('WalrusPluginError');
					expect(err.value.phase).toBe('fund-wal');
					expect(err.value.message).toContain('0xno-detail');
					expect(err.value.message).toContain('no validator error attached');
				}
			}),
	);

	it.effect(
		'sign-side failure routes through mapSignError (distinct from the on-chain branch)',
		() =>
			Effect.gen(function* () {
				const account = stubAccount({
					signError: {
						_tag: 'AccountSignError',
						phase: 'submit',
						accountName: 'alice',
						address: '0xalice',
						message: 'executeTransaction rejected: rpc unreachable',
					} satisfies AccountSignError,
				});
				const exit = yield* Effect.exit(
					swapAccountSuiForWal({
						account,
						sdk: stubSdk,
						exchange: { objectId: '0xexchange', packageId: '0xpkg' },
						recipientAddress: '0xrecipient',
						paymentMist: PAYMENT_MIST,
					}),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				const err = Exit.findErrorOption(exit);
				expect(Option.isSome(err)).toBe(true);
				if (Option.isSome(err)) {
					expect(err.value._tag).toBe('WalrusPluginError');
					expect(err.value.phase).toBe('fund-wal');
					// `mapSignError` wording — NOT the `onFailed` "on-chain" tail.
					expect(err.value.message).toContain('SUI -> WAL swap failed');
					expect(err.value.message).not.toContain('on-chain');
					expect(err.value.message).toContain('0xrecipient');
					// The raw sign error is preserved as `cause`.
					expect(err.value.cause).toBeDefined();
				}
			}),
	);
});
