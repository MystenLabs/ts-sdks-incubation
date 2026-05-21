import { Effect, Schema, type Scope } from 'effect';
import { Transaction } from '@mysten/sui/transactions';

import type { ChainProbe } from '../../contracts/chain-probe.ts';
import {
	executeSuiTx,
	type ResolvedSigner,
	type SuiExecuteClient,
} from '../../substrate/runtime/sui-execute/index.ts';
import { walrusPluginError, type WalrusPluginError } from './errors.ts';

export interface WalExchangeHandle {
	readonly objectId: string;
	readonly packageId: string;
}

export type WalExchangeProbeKey = { readonly kind: 'object'; readonly objectId: string };

export interface WalSwapSdk {
	readonly client: unknown;
}

export type WalSwapSigner = ResolvedSigner;

export interface WalSwapRequest {
	readonly signer: WalSwapSigner;
	readonly sdk: WalSwapSdk;
	readonly exchange: WalExchangeHandle;
	readonly recipientAddress: string;
	readonly paymentMist: bigint;
}

const WalExchangeObjectShape = Schema.Struct({
	object: Schema.Struct({
		objectId: Schema.String,
		type: Schema.String,
	}),
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
		const packageId = found.object.type.split('::')[0];
		if (packageId === undefined || !packageId.startsWith('0x')) {
			return yield* Effect.fail(
				walrusPluginError(
					'exchange',
					`walrus.exchange: unexpected exchange object type "${found.object.type}" — expected "<pkg>::wal_exchange::Exchange"`,
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

export const swapSuiForWal = (
	args: WalSwapRequest,
): Effect.Effect<{ readonly digest: string }, WalrusPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		const tx = buildWalSwapTransaction({
			signerAddress: args.signer.address,
			recipientAddress: args.recipientAddress,
			exchange: args.exchange,
			paymentMist: args.paymentMist,
		});
		const client = args.sdk.client as SuiExecuteClient;
		const receipt = yield* executeSuiTx({
			client,
			signer: args.signer,
			build: () =>
				tx.build({
					client: args.sdk.client as Parameters<typeof tx.build>[0] extends
						| { client?: infer C }
						| undefined
						? C
						: never,
				}),
		}).pipe(
			Effect.mapError((cause) =>
				walrusPluginError(
					'seed-wal',
					`walrus.seedWal: SUI -> WAL swap failed for ${args.recipientAddress} ` +
						`using signer '${args.signer.name}' (address=${args.signer.address}) ` +
						`against exchange ${args.exchange.objectId}: ${cause.message}`,
					{ cause },
				),
			),
		);
		return { digest: receipt.digest };
	}).pipe(
		Effect.withSpan('devstack.plugin.walrus.seedWal', {
			attributes: {
				'walrus.seed.signer': args.signer.name,
				'walrus.seed.address': args.recipientAddress,
				'walrus.seed.exchange': args.exchange.objectId,
			},
		}),
	);
