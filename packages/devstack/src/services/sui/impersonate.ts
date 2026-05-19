// Empty-signature impersonation helper for fork mode.
//
// `sui-fork`'s `ForkedTransactionExecutor::execute_transaction`
// (`crates/sui-fork/src/rpc/executor.rs:70`) routes any tx whose
// `signatures` array is empty through
// `simulacrum::execute_transaction_impersonating`, executing it AS the
// declared sender without that sender's private key. This is the
// canonical funding mechanism for fork-mode accounts — the alternative
// is generating a real keypair and asking the upstream faucet to fund
// it, which doesn't exist for `mainnet-fork`.
//
// The SDK's high-level signing path (`Transaction.sign(...)`,
// `signer.signAndExecuteTransaction(...)`) ALWAYS produces a real
// signature; there's no escape hatch. This module reaches one level
// lower: build `TransactionData` with the declared sender, BCS-encode
// it, and call `client.core.executeTransaction({transaction: bytes,
// signatures: []})` directly. The fork's executor recognizes the
// empty-signatures sentinel and runs the impersonation branch.
//
// Phase 2 of the sui-fork integration plan plumbs this through:
//   - `Account({kind: 'impersonate', sender})` → returns a no-op signer
//     whose `address` is `sender`; the account's `signAndExecute`
//     branches into `executeImpersonated`.
//   - `sui.fork.impersonate(sender, tx, opts?)` exposes the helper
//     ergonomically for ad-hoc callers (one-off scripts, plugin authors
//     who don't want to provision an Account).
//
// Gas budget: `sui-fork`'s `simulate_transaction` is unsupported
// (R3 in the integration plan), so the SDK's auto-gas-budget path
// can't run. Callers must pass `gasBudget` OR set it on the
// Transaction before handing it to us. We default to 100_000_000n
// (0.1 SUI) when the Transaction object has none — that's enough
// for any realistic dev-mode tx and the cost is fictional anyway
// (the fork's gas pool is bottomless).

import { Effect } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiError } from '../../engine/errors.js';
import { stringifyCause } from '../../engine/stringify-cause.js';

/** Default gas budget for impersonated txs that don't set one
 *  explicitly. 0.1 SUI — comfortable for any dev-mode call; the
 *  fork's gas pool is unbounded so this number is fictional. */
export const DEFAULT_FORK_GAS_BUDGET = 100_000_000n;

export interface ImpersonateOptions {
	/** Override the default gas budget for this tx. */
	readonly gasBudget?: bigint;
}

/**
 * Shape of the parsed tx response surfaced to callers. Minimal —
 * `executeImpersonated` callers are typically funding flows that just
 * need to know "did the tx succeed" + the digest for follow-up
 * `waitForTransaction` polling.
 *
 * The full `Transaction` / `FailedTransaction` envelope from gRPC is
 * available on `raw` for callers that need the structured form.
 */
export interface ImpersonatedTxResponse {
	readonly digest: string;
	readonly success: boolean;
	readonly errorMessage?: string;
	readonly raw: unknown;
}

/**
 * Build a Transaction with `sender` set, ensure a gas budget is in
 * place, BCS-serialize, and submit with empty signatures.
 *
 * Fails with `SuiError({phase: 'fork-impersonate'})` if:
 *   - The BCS build fails (invalid moveCall args, missing object
 *     refs, etc.).
 *   - The gRPC call fails (network, container down, fork's
 *     impersonation branch rejected the tx — e.g. sender not in seed
 *     manifest's owned-object index).
 *
 * The function does NOT wait for the tx to be indexed — call
 * `client.waitForTransaction({digest})` after if you need follow-up
 * effects to be readable.
 */
export const executeImpersonated = (
	client: SuiGrpcClient,
	sender: string,
	tx: Transaction,
	opts?: ImpersonateOptions,
): Effect.Effect<ImpersonatedTxResponse, SuiError> =>
	Effect.gen(function* () {
		// Stamp sender + (default-if-missing) gas budget on the
		// Transaction object. `Transaction.setSender` / `setGasBudget`
		// are idempotent (overwrite if previously set) — we trust the
		// caller's choices when provided, fill in defaults otherwise.
		tx.setSender(sender);
		const gasBudget = opts?.gasBudget ?? DEFAULT_FORK_GAS_BUDGET;
		try {
			const txData = (
				tx as unknown as { getData?: () => { gasData?: { budget?: unknown } } }
			).getData?.();
			const budgetAlreadySet =
				txData?.gasData?.budget !== undefined && txData.gasData.budget !== null;
			if (!budgetAlreadySet) {
				tx.setGasBudget(gasBudget);
			}
		} catch {
			// `getData` is internal; if the SDK version doesn't expose
			// it, fall back to always-set (idempotent if the caller
			// already set one, since `setGasBudget` is a setter).
			tx.setGasBudget(gasBudget);
		}

		// Build to BCS. `Transaction.build({client})` resolves moveCall
		// type args, gas coin selection, etc. against the chain — for a
		// fork that's the impersonated sender's seeded objects.
		const bytes = yield* Effect.tryPromise({
			try: () => tx.build({ client }),
			catch: (cause) =>
				new SuiError({
					phase: 'fork-impersonate',
					message:
						`executeImpersonated: Transaction.build failed for sender ${sender}: ` +
						stringifyCause(cause),
					cause,
				}),
		});

		// Submit with empty signatures. The fork's executor routes this
		// through the impersonation branch automatically.
		const response = yield* Effect.tryPromise({
			try: () =>
				client.core.executeTransaction({
					transaction: bytes,
					signatures: [],
				}),
			catch: (cause) =>
				new SuiError({
					phase: 'fork-impersonate',
					message:
						`executeImpersonated: executeTransaction failed for sender ${sender}: ` +
						stringifyCause(cause),
					cause,
				}),
		});

		// `executeTransaction` returns either `{Transaction}` or
		// `{FailedTransaction}` — surface success/failure uniformly.
		const env = response as unknown as {
			Transaction?: {
				digest?: string;
				status?: { success?: boolean; error?: { message?: string } };
			};
			FailedTransaction?: {
				digest?: string;
				status?: { success?: boolean; error?: { message?: string } };
			};
		};
		const inner = env.Transaction ?? env.FailedTransaction;
		if (inner === undefined) {
			return yield* Effect.fail(
				new SuiError({
					phase: 'fork-impersonate',
					message:
						`executeImpersonated: tx response had neither Transaction nor FailedTransaction ` +
						`(sender=${sender})`,
				}),
			);
		}
		const digest = inner.digest ?? '';
		const success = inner.status?.success === true;
		const result: ImpersonatedTxResponse = {
			digest,
			success,
			...(inner.status?.error?.message !== undefined
				? { errorMessage: inner.status.error.message }
				: {}),
			raw: response,
		};
		if (!success) {
			return yield* Effect.fail(
				new SuiError({
					phase: 'fork-impersonate',
					message:
						`executeImpersonated: tx failed for sender ${sender}: ` +
						(result.errorMessage ?? 'no error message in response'),
				}),
			);
		}
		return result;
	}).pipe(
		Effect.withSpan('SuiForkImpersonate', {
			attributes: {
				'fork.sender': sender,
				'fork.gasBudget': String(opts?.gasBudget ?? DEFAULT_FORK_GAS_BUDGET),
			},
		}),
	);
