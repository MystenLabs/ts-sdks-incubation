import { Effect, Schema } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import type { ClientWithCoreApi } from '@mysten/sui/client';

import type { ChainProbe } from '../../contracts/chain-probe.ts';
import { formatExecutedFailure } from '../../substrate/runtime/sui-execute/index.ts';
import { signAndDispatch } from '../../substrate/runtime/sui-execute/sign-and-dispatch.ts';
import type { AccountValue } from '../account/index.ts';
import { walrusPluginError, type WalrusPluginError } from './errors.ts';
import { WalrusSpans } from './spans.ts';

export interface WalExchangeHandle {
	readonly objectId: string;
	readonly packageId: string;
}

export type WalExchangeProbeKey = { readonly kind: 'object'; readonly objectId: string };

export interface WalSwapSdk {
	readonly client: ClientWithCoreApi;
}

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
	signAndDispatch({
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
	}).pipe(
		Effect.withSpan('devstack.plugin.walrus.fundWal', {
			attributes: {
				[WalrusSpans.fundAccount]: args.account.name,
				[WalrusSpans.fundAddress]: args.recipientAddress,
				[WalrusSpans.fundExchange]: args.exchange.objectId,
			},
		}),
	);
