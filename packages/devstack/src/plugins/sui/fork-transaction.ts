import { Effect } from 'effect';

import {
	Inputs,
	Transaction,
	TransactionDataBuilder,
	type CallArg,
} from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { suiPluginError, type SuiPluginError } from './errors.ts';
import { stringifyCause } from './stringify-cause.ts';

export const FORK_IMPERSONATION_GAS_BUDGET = 1_000_000_000n;
export const FORK_IMPERSONATION_GAS_PRICE = 1_000n;

interface ForkImpersonationGasClient {
	readonly getObject: (input: { readonly objectId: string }) => Promise<unknown>;
	readonly listCoins: (input: {
		readonly owner: string;
		readonly coinType?: string;
		readonly limit?: number;
	}) => Promise<{
		readonly objects: ReadonlyArray<{
			readonly objectId: string;
			readonly version: string | number | bigint;
			readonly digest: string;
			readonly balance?: string | number | bigint;
		}>;
	}>;
}

export const prepareForkImpersonationTransaction = (
	tx: Transaction,
	sender: string,
	gasPayment: ReadonlyArray<{
		readonly objectId: string;
		readonly version: string;
		readonly digest: string;
	}>,
): void => {
	tx.setSender(sender);

	tx.setGasBudget(FORK_IMPERSONATION_GAS_BUDGET);
	tx.setGasPrice(FORK_IMPERSONATION_GAS_PRICE);
	tx.setGasOwner(sender);
	tx.setGasPayment([...gasPayment]);

	const data = tx.getData();
	if (data.expiration == null) tx.setExpiration({ None: true });
};

export const buildForkImpersonationTransactionBytes = (
	tx: Transaction,
	sender: string,
	client: ForkImpersonationGasClient,
): Effect.Effect<Uint8Array, SuiPluginError> =>
	Effect.tryPromise({
		try: async () => {
			const gasPayment = await selectForkImpersonationGasPayment(client, sender);
			prepareForkImpersonationTransaction(tx, sender, gasPayment);
			await tx.prepareForSerialization({});
			const data = tx.getData();
			data.inputs = await Promise.all(data.inputs.map((input) => resolveForkInput(input, client)));
			return TransactionDataBuilder.restore(data).build();
		},
		catch: (cause) => {
			// Pass through pre-tagged SuiPluginError (thrown by inner
			// helpers with structured response fields) so we don't
			// double-wrap or stringify-leak the response payload.
			if (isSuiPluginError(cause)) return cause;
			return suiPluginError(
				'fork-impersonate',
				`sui fork mode: failed to build fork impersonation transaction for ${sender}: ${stringifyCause(cause)}`,
				cause,
			);
		},
	});

const isSuiPluginError = (value: unknown): value is SuiPluginError =>
	typeof value === 'object' &&
	value !== null &&
	(value as { _tag?: unknown })._tag === 'SuiPluginError';

const resolveForkInput = async (
	input: CallArg,
	client: ForkImpersonationGasClient,
): Promise<CallArg> => {
	if (input.UnresolvedObject === undefined) return input;
	const unresolved = input.UnresolvedObject;
	if (unresolved.initialSharedVersion != null) {
		return Inputs.SharedObjectRef({
			objectId: unresolved.objectId,
			initialSharedVersion: unresolved.initialSharedVersion,
			mutable: unresolved.mutable ?? true,
		});
	}
	if (unresolved.version != null && unresolved.digest != null) {
		return Inputs.ObjectRef({
			objectId: unresolved.objectId,
			version: unresolved.version,
			digest: unresolved.digest,
		});
	}

	const object = objectFromGetObjectResponse(
		await client.getObject({ objectId: unresolved.objectId }),
	);
	const owner = object.owner;
	if (owner?.$kind === 'Shared' && owner.Shared !== undefined) {
		return Inputs.SharedObjectRef({
			objectId: object.objectId,
			initialSharedVersion: owner.Shared.initialSharedVersion,
			mutable: unresolved.mutable ?? true,
		});
	}
	return Inputs.ObjectRef({
		objectId: object.objectId,
		version: object.version,
		digest: object.digest,
	});
};

const objectFromGetObjectResponse = (
	response: unknown,
): {
	readonly objectId: string;
	readonly version: string;
	readonly digest: string;
	readonly owner?: {
		readonly $kind?: string;
		readonly Shared?: { readonly initialSharedVersion: string };
	};
} => {
	const object = (response as { readonly object?: unknown }).object;
	if (typeof object !== 'object' || object === null) {
		throw suiPluginError('fork-impersonate', 'sui fork mode: getObject returned no object', {
			responseKeys: describeKeys(response),
		});
	}
	const candidate = object as {
		readonly objectId?: unknown;
		readonly version?: unknown;
		readonly digest?: unknown;
		readonly owner?: {
			readonly $kind?: string;
			readonly Shared?: { readonly initialSharedVersion: string };
		};
	};
	if (
		typeof candidate.objectId !== 'string' ||
		typeof candidate.version !== 'string' ||
		typeof candidate.digest !== 'string'
	) {
		throw suiPluginError(
			'fork-impersonate',
			'sui fork mode: getObject returned incomplete object ref',
			{
				objectKeys: describeKeys(object),
				missing: {
					objectId: typeof candidate.objectId !== 'string',
					version: typeof candidate.version !== 'string',
					digest: typeof candidate.digest !== 'string',
				},
			},
		);
	}
	return {
		objectId: candidate.objectId,
		version: candidate.version,
		digest: candidate.digest,
		owner: candidate.owner,
	};
};

const selectForkImpersonationGasPayment = async (
	client: ForkImpersonationGasClient,
	sender: string,
): Promise<
	ReadonlyArray<{ readonly objectId: string; readonly version: string; readonly digest: string }>
> => {
	const response = await client.listCoins({ owner: sender, limit: 1 });
	const coin = response.objects[0];
	if (coin === undefined) {
		throw suiPluginError(
			'fork-impersonate',
			`sui fork mode: no SUI gas coins found for ${sender}`,
			{ sender, objectCount: response.objects.length },
		);
	}
	return [
		{
			objectId: coin.objectId,
			version: String(coin.version),
			digest: coin.digest,
		},
	];
};

export const verifyForkImpersonationSender = (
	sender: string,
	txBytes: Uint8Array,
): Effect.Effect<void, SuiPluginError> =>
	Effect.try({
		try: () => {
			const actual = TransactionDataBuilder.fromBytes(txBytes).snapshot().sender;
			if (actual == null) {
				throw suiPluginError(
					'fork-impersonate',
					'sui fork mode: refused impersonation transaction — transaction has no sender',
					{ expectedSender: sender },
				);
			}
			if (normalizeSuiAddress(actual) !== normalizeSuiAddress(sender)) {
				throw suiPluginError(
					'fork-impersonate',
					'sui fork mode: refused impersonation transaction — sender mismatch',
					{ expectedSender: sender, actualSender: actual },
				);
			}
		},
		catch: (cause) => {
			if (isSuiPluginError(cause)) return cause;
			return suiPluginError(
				'fork-impersonate',
				`sui fork mode: refused impersonation transaction: ${stringifyCause(cause)}`,
				cause,
			);
		},
	});

const describeKeys = (value: unknown): ReadonlyArray<string> => {
	if (typeof value !== 'object' || value === null) return [];
	return Object.keys(value);
};
