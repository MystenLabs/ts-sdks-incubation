import { Effect, Schema } from 'effect';
import { Transaction } from '@mysten/sui/transactions';

import type { ChainProbe } from '../../contracts/chain-probe.ts';
import type { AccountValue } from '../account/index.ts';
import { formatExecutedFailure, signAndDispatch, type SuiSdkShim } from '../sui/index.ts';
import { SUI_FULL_COIN_TYPE } from '../account/index.ts';
import { walrusPluginError, type WalrusPluginError } from './errors.ts';
import { WalrusSpans } from './spans.ts';

/** Conservative reserve held back from the gas coin for transaction
 *  gas itself. The swap call splits `paymentMist` off the gas coin
 *  via `tx.coin({ useGasCoin: true })`, so the on-chain balance must
 *  cover BOTH the payment AND a gas budget reserve. The exact gas
 *  budget is set by the SDK at build time; this reserve is a coarse
 *  upper bound used only by the pre-flight refusal — if the wire
 *  call proves the reserve is too small the SDK still surfaces the
 *  native `InsufficientGas` cause with the real numbers. */
const WAL_SWAP_GAS_RESERVE_MIST = 50_000_000n;

export interface WalExchangeHandle {
	readonly objectId: string;
	readonly packageId: string;
}

export type WalExchangeProbeKey = { readonly kind: 'object'; readonly objectId: string };

export type WalSwapSdk = Pick<SuiSdkShim, 'client'> & {
	readonly core: Pick<SuiSdkShim['core'], 'getBalance'>;
};

/** Read the account's SUI balance (best-effort). Returns `null` if the
 *  RPC throws or the response shape is unexpected — the pre-flight is
 *  a hint, not a hard gate. */
const readSuiBalance = (sdk: WalSwapSdk, owner: string): Effect.Effect<bigint | null, never> =>
	Effect.promise(async () => {
		try {
			const response = await sdk.core.getBalance({ owner, coinType: SUI_FULL_COIN_TYPE });
			const outer =
				typeof response === 'object' && response !== null && 'balance' in response
					? (response as { readonly balance?: unknown }).balance
					: response;
			const value =
				typeof outer === 'object' && outer !== null && 'balance' in outer
					? (outer as { readonly balance?: unknown }).balance
					: outer;
			if (typeof value === 'bigint') return value;
			if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
				return BigInt(value);
			if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
			return null;
		} catch {
			return null;
		}
	});

export interface WalAccountSwapRequest {
	readonly account: AccountValue;
	readonly sdk: WalSwapSdk;
	readonly exchange: WalExchangeHandle;
	readonly recipientAddress: string;
	readonly paymentMist: bigint;
}

const WalExchangeObjectShape = Schema.Struct({
	objectId: Schema.String,
	type: Schema.String,
});

export const resolveWalExchange = (
	probe: ChainProbe<WalExchangeProbeKey>,
	exchangeObjectId: string | undefined,
): Effect.Effect<WalExchangeHandle | null, WalrusPluginError> =>
	Effect.gen(function* () {
		if (exchangeObjectId === undefined) return null;
		const found = yield* probe
			.get({ kind: 'object', objectId: exchangeObjectId }, WalExchangeObjectShape, 'lenient')
			.pipe(
				Effect.mapError((cause) =>
					walrusPluginError(
						'exchange',
						`walrus.exchange: failed to resolve exchange object ${exchangeObjectId}: ${cause.reason}: ${cause.detail}`,
						{ cause },
					),
				),
			);
		if (found === null) return null;
		const packageId = found.type.split('::')[0];
		if (packageId === undefined || !packageId.startsWith('0x')) {
			return yield* Effect.fail(
				walrusPluginError(
					'exchange',
					`walrus.exchange: unexpected exchange object type "${found.type}" — expected "<pkg>::wal_exchange::Exchange"`,
				),
			);
		}
		return { objectId: exchangeObjectId, packageId };
	});

export const buildWalSwapTransaction = (args: {
	readonly signerAddress: string;
	readonly recipientAddress: string;
	readonly exchange: WalExchangeHandle;
	readonly paymentMist: bigint;
}): Transaction => {
	const tx = new Transaction();
	tx.setSender(args.signerAddress);
	const paymentCoin = tx.coin({
		balance: args.paymentMist,
		type: '0x2::sui::SUI',
		useGasCoin: true,
	});
	const walCoin = tx.moveCall({
		target: `${args.exchange.packageId}::wal_exchange::exchange_all_for_wal`,
		arguments: [tx.object(args.exchange.objectId), paymentCoin],
	});
	tx.transferObjects([walCoin], tx.pure.address(args.recipientAddress));
	return tx;
};

export const swapAccountSuiForWal = (
	args: WalAccountSwapRequest,
): Effect.Effect<{ readonly digest: string }, WalrusPluginError> =>
	Effect.gen(function* () {
		// Pre-flight gas-budget refusal — the swap splits `paymentMist`
		// off the gas coin via `tx.coin({ useGasCoin: true })`, so the
		// on-chain SUI balance must cover BOTH the payment AND a gas
		// reserve. Without this check the failure surfaces as an opaque
		// `Transaction.build` / chain-side `InsufficientGas` after the
		// wire call has already been attempted; the typed refusal here
		// names the numbers so the caller sees the real cause. The
		// balance read is best-effort — a `null` from the SDK falls
		// through to the wire call (the existing `mapSignError` /
		// `onFailed` paths still catch the chain-side failure).
		const suiBalance = yield* readSuiBalance(args.sdk, args.account.address);
		const required = args.paymentMist + WAL_SWAP_GAS_RESERVE_MIST;
		if (suiBalance !== null && suiBalance < required) {
			return yield* Effect.fail(
				walrusPluginError(
					'fund-wal',
					`walrus.fundWal: account '${args.account.name}' (address=${args.account.address}) ` +
						`has insufficient SUI to swap ${args.paymentMist} for WAL — ` +
						`balance=${suiBalance} mist, required≥${required} mist ` +
						`(payment=${args.paymentMist} + gas reserve=${WAL_SWAP_GAS_RESERVE_MIST}). ` +
						`Top up the account's SUI funding before declaring the WAL funding entry.`,
				),
			);
		}
		return yield* signAndDispatch({
			signerSource: args.account,
			buildTxBytes: () =>
				Effect.gen(function* () {
					const tx = buildWalSwapTransaction({
						signerAddress: args.account.address,
						recipientAddress: args.recipientAddress,
						exchange: args.exchange,
						paymentMist: args.paymentMist,
					});
					return yield* Effect.tryPromise({
						try: () => tx.build({ client: args.sdk.client }),
						catch: (cause): WalrusPluginError =>
							walrusPluginError(
								'fund-wal',
								`walrus.fundWal: transaction serialization failed for account '${args.account.name}'.`,
								{ cause },
							),
					});
				}),
			mapSignError: (cause): WalrusPluginError =>
				walrusPluginError(
					'fund-wal',
					`walrus.fundWal: SUI -> WAL swap failed for ${args.recipientAddress} ` +
						`using account '${args.account.name}' (address=${args.account.address}) ` +
						`against exchange ${args.exchange.objectId}.`,
					{ cause },
				),
			onFailed: (failure) =>
				Effect.fail(
					walrusPluginError(
						'fund-wal',
						`walrus.fundWal: SUI -> WAL swap failed on-chain ` +
							`(exchange=${args.exchange.objectId}) ` +
							formatExecutedFailure(failure),
					),
				),
			onSuccess: (ok) => Effect.succeed({ digest: ok.digest }),
		});
	}).pipe(
		Effect.withSpan('devstack.plugin.walrus.fundWal', {
			attributes: {
				[WalrusSpans.fundAccount]: args.account.name,
				[WalrusSpans.fundAddress]: args.recipientAddress,
				[WalrusSpans.fundExchange]: args.exchange.objectId,
			},
		}),
	);
