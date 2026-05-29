// SUI fork-faucet strategy — impersonation-based funding.
//
// Fork networks have no real faucet. This strategy funds a recipient by
// IMPERSONATING a large-reserve "whale" address on the forked upstream
// and transferring SUI from it: it builds `splitCoins(tx.gas, [amount])`
// + `transferObjects([coin], recipient)` with the whale as sender, runs
// it through the SAME impersonation path the package/action plugins use
// (`buildForkImpersonationTransactionBytes` -> `fork.impersonate`, with
// empty signatures), and waits for finality.
//
// It is registered into the `faucet:request:<chainId>` strategy registry
// from `sui/index.ts` exactly like the local-faucet HTTP strategy, so
// ephemeral-account auto-funding and cross-cutting SUI funding "just
// work" in fork mode. (Dependency direction faucet <- sui: the sui
// plugin imports the faucet contract/error types, never the reverse.)
//
// Error channel: account funding only catches FaucetUnreachable |
// FaucetExhausted | FaucetBodyError (see account/funding.ts). The
// impersonation path fails with SuiPluginError, so every internal
// failure is mapped to FaucetBodyError here — otherwise it would escape
// funding's `catchTags` and surface as an unhandled error.
//
// Concurrency: every request selects the whale's largest SUI coin as
// both gas payment and split source. Concurrent requests would race the
// same coin version, so requests serialize on a chain-scoped lease.

import { Effect } from 'effect';

import { Transaction } from '@mysten/sui/transactions';

import { formatUnknownError } from '../../substrate/runtime/format-unknown-error.ts';
import { leaseKey, type LeaseBroker } from '../../substrate/runtime/lease-broker/index.ts';
import { faucetBodyError, type FaucetBodyError, type FaucetStrategy } from '../faucet/index.ts';

import type { SuiSdkShim } from './chain-probe.ts';
import type { SuiPluginError } from './errors.ts';
import {
	FORK_IMPERSONATION_GAS_BUDGET,
	buildForkImpersonationTransactionBytes,
	selectLargestForkCoin,
	type ForkImpersonationGasClient,
} from './fork-transaction.ts';
import type { ForkAdminSurface } from './mode/shared.ts';
import { SuiSpans } from './spans.ts';

/** Serialization for the shared whale funding coin (mirrors
 *  `SuiLocalFaucetSerialization` in `local-faucet-strategy.ts`). */
export interface SuiForkFaucetSerialization {
	readonly broker: LeaseBroker;
	readonly key: string;
	readonly owner: string;
}

export interface SuiForkFaucetStrategyOptions {
	/** Address impersonated as the funding source. Must hold a large SUI
	 *  coin in the fork (auto-seeded + validated at boot). */
	readonly whale: string;
	/** Fork admin surface (`client.fork`) — submits the impersonation tx. */
	readonly fork: ForkAdminSurface;
	/** SDK shim (`client.sdk`) — `.core` selects the whale gas coin and
	 *  waits for finality. */
	readonly sdk: SuiSdkShim;
	/** Upper bound per request (MIST). Requests above this are rejected. */
	readonly perRequestCapMist: bigint;
	/** Serialize requests so concurrent funds don't race the whale coin. */
	readonly serialization?: SuiForkFaucetSerialization;
}

const sentinelUrl = (whale: string): string => `fork-impersonation://${whale}`;

const bodyError = (
	whale: string,
	address: string,
	amount: bigint,
	message: string,
): FaucetBodyError =>
	faucetBodyError({
		url: sentinelUrl(whale),
		address,
		amount,
		status: 0,
		reason: 'failure-status',
		message,
	});

const withSerialization = (
	serialization: SuiForkFaucetSerialization | undefined,
	effect: Effect.Effect<void, FaucetBodyError>,
): Effect.Effect<void, FaucetBodyError> => {
	if (serialization === undefined) {
		return effect;
	}
	return Effect.scoped(
		Effect.gen(function* () {
			yield* serialization.broker.acquire(leaseKey(serialization.key), serialization.owner);
			yield* effect;
		}),
	).pipe(
		Effect.withSpan('devstack.plugin.sui.forkFaucet.serializedRequest', {
			attributes: {
				[SuiSpans.localFaucetLeaseKey]: serialization.key,
				[SuiSpans.localFaucetLeaseOwner]: serialization.owner,
			},
		}),
	);
};

/** Build a SUI fork-faucet strategy that funds via whale impersonation. */
export const suiForkFaucetStrategy = (opts: SuiForkFaucetStrategyOptions): FaucetStrategy => ({
	request: ({ address, amount }) => {
		const gasClient: ForkImpersonationGasClient = opts.sdk.core;
		// Internal SuiPluginError -> FaucetBodyError so account funding's
		// catchTags handle it; carry the actionable root message through.
		const mapErr = (cause: SuiPluginError): FaucetBodyError =>
			bodyError(opts.whale, address, amount, `sui fork faucet: ${cause.message}`);

		const transfer = Effect.gen(function* () {
			if (amount <= 0n) {
				return;
			}
			if (amount > opts.perRequestCapMist) {
				return yield* Effect.fail(
					bodyError(
						opts.whale,
						address,
						amount,
						`sui fork faucet: requested ${amount} MIST exceeds the per-request cap ` +
							`${opts.perRequestCapMist} MIST (whale ${opts.whale}).`,
					),
				);
			}

			// The whale's largest SUI coin pays gas AND sources the split, so
			// it must cover amount + the impersonation gas budget.
			const { coin } = yield* selectLargestForkCoin(
				gasClient,
				opts.whale,
				amount + FORK_IMPERSONATION_GAS_BUDGET,
			).pipe(Effect.mapError(mapErr));

			const tx = new Transaction();
			tx.setSender(opts.whale);
			const [funded] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
			tx.transferObjects([funded], address);

			const bytes = yield* buildForkImpersonationTransactionBytes(
				tx,
				opts.whale,
				gasClient,
				coin,
			).pipe(Effect.mapError(mapErr));

			const submitted = yield* opts.fork
				.impersonate(opts.whale, bytes)
				.pipe(Effect.mapError(mapErr));
			if (!submitted.success) {
				return yield* Effect.fail(
					bodyError(
						opts.whale,
						address,
						amount,
						`sui fork faucet: impersonation tx ${submitted.digest} failed on-chain.`,
					),
				);
			}

			yield* Effect.tryPromise({
				try: () => opts.sdk.core.waitForTransaction({ digest: submitted.digest }),
				catch: (cause): FaucetBodyError =>
					bodyError(
						opts.whale,
						address,
						amount,
						`sui fork faucet: waitForTransaction(${submitted.digest}) failed: ${formatUnknownError(cause)}`,
					),
			});
		});

		return withSerialization(opts.serialization, transfer).pipe(
			Effect.withSpan('devstack.plugin.sui.forkFaucet.request', {
				attributes: { [SuiSpans.forkFaucetWhale]: opts.whale },
			}),
		);
	},
});
