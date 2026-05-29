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

/** `listCoins` page size while scanning for a sufficient coin. */
const FORK_COIN_PAGE_SIZE = 50;

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
		readonly cursor?: string | null;
	}) => Promise<{
		readonly objects: ReadonlyArray<{
			readonly objectId: string;
			readonly version: string | number | bigint;
			readonly digest: string;
			readonly balance?: string | number | bigint;
		}>;
		readonly hasNextPage?: boolean;
		readonly cursor?: string | null;
	}>;
}

/** Paginate `owner`'s SUI coins and return the first whose balance covers
 *  `minBalanceMist` (with that balance), or `undefined` if none across all
 *  pages. `listCoins` is paginated and NOT balance-ordered, so a sufficient
 *  coin can sit behind dust on a later page — we must page, never sample
 *  page 1. Shared by gas selection and the fork faucet. */
const firstSufficientSuiCoin = async (
	client: ForkImpersonationGasClient,
	owner: string,
	minBalanceMist: bigint,
): Promise<{ readonly coin: ForkGasCoin; readonly balanceMist: bigint } | undefined> => {
	let cursor: string | null = null;
	do {
		const page = await client.listCoins({
			owner,
			coinType: SUI_GAS_COIN_TYPE,
			cursor,
			limit: FORK_COIN_PAGE_SIZE,
		});
		for (const candidate of page.objects) {
			if (candidate.balance === undefined) continue;
			const balanceMist = BigInt(candidate.balance);
			if (balanceMist >= minBalanceMist) {
				return {
					coin: {
						objectId: candidate.objectId,
						version: String(candidate.version),
						digest: candidate.digest,
					},
					balanceMist,
				};
			}
		}
		cursor = page.hasNextPage === true ? (page.cursor ?? null) : null;
	} while (cursor !== null);
	return undefined;
};

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
	 *  whale's gas coin via {@link selectSufficientForkCoin} so a
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
	// The gas coin must cover the impersonation gas budget. Pick the first SUI
	// coin that does (paginating past dust) — not blindly `objects[0]`, which on
	// an account holding change coins may be below the budget → InsufficientGas
	// even though a larger coin exists.
	const found = await firstSufficientSuiCoin(client, sender, FORK_IMPERSONATION_GAS_BUDGET);
	if (found === undefined) {
		throw suiPluginError(
			'fork-impersonate',
			`sui fork mode: no SUI coin >= ${FORK_IMPERSONATION_GAS_BUDGET} MIST (gas budget) found for ${sender}.`,
			{ sender, requiredMist: FORK_IMPERSONATION_GAS_BUDGET.toString() },
		);
	}
	return [found.coin];
};

/** Find a SUI coin owned by `owner` that covers `minBalanceMist`, for use as
 *  BOTH gas payment and the `splitCoins(tx.gas, …)` funding source in a fork
 *  faucet transfer. Paginates the coin set (a sufficient coin can sit behind
 *  dust on a later page) and returns the first that qualifies. Fails with an
 *  actionable `SuiPluginError` when none exists — reused at boot to validate a
 *  configured whale before any funding runs. */
export const selectSufficientForkCoin = (
	client: ForkImpersonationGasClient,
	owner: string,
	minBalanceMist: bigint,
): Effect.Effect<{ readonly coin: ForkGasCoin; readonly balanceMist: bigint }, SuiPluginError> =>
	Effect.tryPromise({
		try: async () => {
			const found = await firstSufficientSuiCoin(client, owner, minBalanceMist);
			if (found === undefined) {
				throw suiPluginError(
					'fork-impersonate',
					`sui fork mode: no SUI coin >= ${minBalanceMist} MIST (request + gas budget) found for ` +
						`${owner}. Use a fork faucet whale with a larger single coin, or fund a smaller amount.`,
					{ owner, requiredMist: minBalanceMist.toString() },
				);
			}
			return found;
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
