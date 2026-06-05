// DeepBook DEEP funding strategy.
//
// Testnet DEEP has no public mint faucet. The usable funding path is a
// real DeepBook swap from the requesting account's SUI balance into
// DEEP. This strategy is contributed by the known testnet DeepBook
// plugin under the standard `coinType:<fullCoinType>` key, so accounts
// can request DEEP through the same cross-cutting funding pipeline as
// SUI and WAL.

import { Effect } from 'effect';

import { DeepBookClient, type DeepBookCompatibleClient } from '@mysten/deepbook-v3';
import { Transaction } from '@mysten/sui/transactions';

import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import { type AccountFundingRequest, type AccountFundingStrategy } from '../account/index.ts';
import { formatExecutedFailure, signAndDispatch, type SuiSdkShim } from '../sui/index.ts';

import { deepbookPluginError, type DeepbookPluginError } from './errors.ts';

export const DEEPBOOK_TESTNET_DEEP_COIN_TYPE =
	'0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP' as const;
export const DEEPBOOK_DEEP_FAUCET_STRATEGY_KEY =
	`coinType:${DEEPBOOK_TESTNET_DEEP_COIN_TYPE}` as const;

const DEEPBOOK_DEEP_POOL_KEY = 'DEEP_SUI';
const DEEP_SCALAR = 1_000_000n;
const SUI_SCALAR = 1_000_000_000n;
const DEFAULT_INPUT_BUFFER_BPS = 500n;

export interface DeepbookDeepFundingStrategyOptions {
	readonly suiSdk: SuiSdkShim;
	/** Extra SUI input above the quote. 500 bps means 5%. */
	readonly inputBufferBps?: bigint;
}

export type DeepbookDeepFundingStrategy = AccountFundingStrategy<DeepbookPluginError>;

const decimalToRaw = (
	value: number,
	scalar: bigint,
	round: 'ceil' | 'floor',
): Effect.Effect<bigint, DeepbookPluginError> => {
	const scaled = value * Number(scalar);
	if (!Number.isFinite(scaled) || scaled < 0) {
		return Effect.fail(
			deepbookPluginError(
				'fund-deep',
				`DeepBook quote returned an invalid decimal amount: ${value}.`,
			),
		);
	}
	return Effect.succeed(BigInt(round === 'ceil' ? Math.ceil(scaled) : Math.floor(scaled)));
};

const applyInputBuffer = (raw: bigint, bufferBps: bigint): bigint =>
	(raw * (10_000n + bufferBps) + 9_999n) / 10_000n;

const buildDeepbookClient = (
	account: NonNullable<AccountFundingRequest['account']>,
	suiSdk: SuiSdkShim,
): DeepBookClient =>
	new DeepBookClient({
		address: account.address,
		client: suiSdk.client as DeepBookCompatibleClient,
		network: 'testnet',
	});

export const makeDeepbookDeepFundingStrategy = (
	opts: DeepbookDeepFundingStrategyOptions,
): DeepbookDeepFundingStrategy => ({
	usesAccountSigner: true,
	// The swap buys DEEP with the recipient account's own SUI, so the recipient
	// must be a resolved account with a signer — funding an arbitrary 0x address
	// is rejected by the dispatcher/dashboard on this flag.
	requiresRecipientAccount: true,
	request: (req) =>
		Effect.gen(function* () {
			if (req.amount <= 0n) return;

			const account = req.account;
			if (account === undefined) {
				return yield* Effect.fail(
					deepbookPluginError(
						'fund-deep',
						'DeepBook DEEP funding spends the recipient account’s own SUI, so it requires a resolved account signer.',
					),
				);
			}

			const deepBook = buildDeepbookClient(account, opts.suiSdk);
			const quote = yield* Effect.tryPromise({
				try: () => deepBook.getQuoteQuantityIn(DEEPBOOK_DEEP_POOL_KEY, req.amount, false),
				catch: (cause): DeepbookPluginError =>
					deepbookPluginError(
						'fund-deep',
						`DeepBook DEEP funding quote failed for ${req.amount} base units.`,
						{ cause },
					),
			});

			const baseOutRaw = yield* decimalToRaw(quote.baseOut, DEEP_SCALAR, 'floor');
			if (baseOutRaw < req.amount) {
				return yield* Effect.fail(
					deepbookPluginError(
						'fund-deep',
						`DeepBook DEEP funding quote cannot satisfy ${req.amount} base units; quoted ${baseOutRaw}.`,
					),
				);
			}

			const quoteInRaw = yield* decimalToRaw(quote.quoteIn, SUI_SCALAR, 'ceil');
			if (quoteInRaw <= 0n) {
				return yield* Effect.fail(
					deepbookPluginError(
						'fund-deep',
						`DeepBook DEEP funding quote returned zero SUI input for ${req.amount} base units.`,
					),
				);
			}
			const quoteAmountRaw = applyInputBuffer(
				quoteInRaw,
				opts.inputBufferBps ?? DEFAULT_INPUT_BUFFER_BPS,
			);
			const deepAmountRaw = yield* decimalToRaw(quote.deepRequired, DEEP_SCALAR, 'ceil');

			yield* signAndDispatch({
				signerSource: account,
				buildTxBytes: () =>
					Effect.gen(function* () {
						const tx = yield* Effect.try({
							try: () => {
								const transaction = new Transaction();
								transaction.setSender(account.address);
								const [baseCoin, quoteCoin, deepCoin] = transaction.add(
									deepBook.deepBook.swapExactQuantity({
										poolKey: DEEPBOOK_DEEP_POOL_KEY,
										amount: quoteAmountRaw,
										deepAmount: deepAmountRaw,
										minOut: req.amount,
										isBaseToCoin: false,
									}),
								);
								transaction.transferObjects([baseCoin, quoteCoin, deepCoin], req.address);
								return transaction;
							},
							catch: (cause): DeepbookPluginError =>
								deepbookPluginError(
									'fund-deep',
									'DeepBook DEEP funding transaction build failed.',
									{
										cause,
									},
								),
						});

						return yield* Effect.tryPromise({
							try: () => tx.build({ client: opts.suiSdk.client }),
							catch: (cause): DeepbookPluginError =>
								deepbookPluginError(
									'fund-deep',
									`DeepBook DEEP funding transaction serialization failed: ${
										cause instanceof Error ? cause.message : String(cause)
									}.`,
									{ cause },
								),
						});
					}),
				mapSignError: (cause): DeepbookPluginError =>
					deepbookPluginError(
						'fund-deep',
						`DeepBook DEEP funding transaction failed for account '${account.name}'.`,
						{ cause },
					),
				onFailed: (failure) =>
					Effect.fail(
						deepbookPluginError(
							'fund-deep',
							`DeepBook DEEP funding transaction failed on-chain ` +
								`for account '${account.name}' (address=${account.address}) ` +
								formatExecutedFailure(failure),
						),
					),
				onSuccess: () => Effect.void,
			});
		}),
});

export const makeDeepbookDeepFundingContribution = (
	strategy: DeepbookDeepFundingStrategy,
): StrategyContributorDecl<
	typeof DEEPBOOK_DEEP_FAUCET_STRATEGY_KEY,
	DeepbookDeepFundingStrategy
> => ({
	kind: 'strategy-contributor',
	capabilityKey: DEEPBOOK_DEEP_FAUCET_STRATEGY_KEY,
	strategy,
	autoMounted: true,
});
