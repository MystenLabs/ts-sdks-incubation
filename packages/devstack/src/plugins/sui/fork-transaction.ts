import { Effect } from 'effect';

import {
	Inputs,
	Transaction,
	TransactionDataBuilder,
	type CallArg,
} from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { suiPluginError, type SuiPluginError } from './errors.ts';
import { formatUnknownError } from '../../substrate/runtime/format-unknown-error.ts';

// 0.1 SUI. Deliberately well below the faucet's default per-account fund
// (1 SUI) so a faucet-funded account keeps headroom to move value:
// `setGasBudget` reserves the whole gas coin, so a budget equal to the
// coin balance leaves nothing for `splitCoins(tx.gas, …)` / transfers
// (InsufficientCoinBalance). 0.1 SUI still covers package publishes.
export const FORK_IMPERSONATION_GAS_BUDGET = 100_000_000n;
export const FORK_IMPERSONATION_GAS_PRICE = 1_000n;

/** Canonical SUI gas coin type used to filter `listCoins` when picking
 *  a gas/funding coin. Kept local so the sui plugin needn't depend on
 *  the account plugin's `SUI_FULL_COIN_TYPE`. */
const SUI_GAS_COIN_TYPE = '0x2::sui::SUI';

/** Bounds the `listCoins` page scanned by {@link selectLargestForkCoin}.
 *  A treasury/whale with one giant coin lands on the first page; we don't
 *  paginate the whole (possibly huge) coin set just to rank balances. */
const FORK_COIN_SCAN_LIMIT = 50;

/** An object ref usable as gas payment for an impersonation transaction. */
export interface ForkGasCoin {
	readonly objectId: string;
	readonly version: string;
	readonly digest: string;
}

export interface ForkImpersonationGasClient {
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
	/** Pre-selected gas coin. When omitted, the first coin owned by
	 *  `sender` is used (legacy behaviour). The fork faucet passes the
	 *  whale's largest SUI coin via {@link selectLargestForkCoin} so a
	 *  `splitCoins(tx.gas, …)` funding transfer has enough balance. */
	gasCoin?: ForkGasCoin,
): Effect.Effect<Uint8Array, SuiPluginError> =>
	Effect.tryPromise({
		try: async () => {
			const gasPayment =
				gasCoin !== undefined ? [gasCoin] : await selectForkImpersonationGasPayment(client, sender);
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
				`sui fork mode: failed to build fork impersonation transaction for ${sender}: ${formatUnknownError(cause)}`,
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

/** Pick the largest SUI coin owned by `owner` that covers
 *  `minBalanceMist`, for use as BOTH gas payment and the
 *  `splitCoins(tx.gas, …)` funding source in a fork faucet transfer.
 *  Scans a bounded page (treasury whales keep one giant coin up front).
 *  Fails with an actionable `SuiPluginError` when no coin is large enough —
 *  reused at boot to validate a configured whale before any funding runs. */
export const selectLargestForkCoin = (
	client: ForkImpersonationGasClient,
	owner: string,
	minBalanceMist: bigint,
): Effect.Effect<{ readonly coin: ForkGasCoin; readonly balanceMist: bigint }, SuiPluginError> =>
	Effect.tryPromise({
		try: async () => {
			const response = await client.listCoins({
				owner,
				coinType: SUI_GAS_COIN_TYPE,
				limit: FORK_COIN_SCAN_LIMIT,
			});
			let best: { coin: ForkGasCoin; balanceMist: bigint } | undefined;
			for (const candidate of response.objects) {
				if (candidate.balance === undefined) continue;
				const balanceMist = BigInt(candidate.balance);
				if (best === undefined || balanceMist > best.balanceMist) {
					best = {
						coin: {
							objectId: candidate.objectId,
							version: String(candidate.version),
							digest: candidate.digest,
						},
						balanceMist,
					};
				}
			}
			if (best === undefined) {
				throw suiPluginError(
					'fork-impersonate',
					`sui fork mode: no SUI coins found for ${owner} (scanned up to ${FORK_COIN_SCAN_LIMIT}). ` +
						`Seed an address holding a large SUI balance, or set a different fork faucet whale.`,
					{ owner, scanned: response.objects.length },
				);
			}
			if (best.balanceMist < minBalanceMist) {
				throw suiPluginError(
					'fork-impersonate',
					`sui fork mode: largest SUI coin for ${owner} is ${best.balanceMist} MIST, below the ` +
						`required ${minBalanceMist} MIST (request + gas budget). Use a fork faucet whale with a ` +
						`larger single coin, or fund a smaller amount.`,
					{
						owner,
						largestCoinMist: best.balanceMist.toString(),
						requiredMist: minBalanceMist.toString(),
					},
				);
			}
			return best;
		},
		catch: (cause) => {
			if (isSuiPluginError(cause)) return cause;
			return suiPluginError(
				'fork-impersonate',
				`sui fork mode: failed to select a SUI coin for ${owner}: ${formatUnknownError(cause)}`,
				cause,
			);
		},
	});

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
				`sui fork mode: refused impersonation transaction: ${formatUnknownError(cause)}`,
				cause,
			);
		},
	});

const describeKeys = (value: unknown): ReadonlyArray<string> => {
	if (typeof value !== 'object' || value === null) return [];
	return Object.keys(value);
};
