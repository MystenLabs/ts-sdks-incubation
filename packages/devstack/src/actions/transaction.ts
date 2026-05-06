// `runTransaction()` — ergonomic factory for app-level setup transactions.
// Wraps `seed()` with a tx-builder + signer-by-name. Idempotence comes
// from the reconciler's input-hash skip predicate: the action's `inputs`
// includes a stableHash of `{signer, build.toString(), scope, needs}`, so
// editing the build callback invalidates the hash and re-runs. Persisted
// state in the manifest carries that hash across processes.
//
// No marker file, no default `getStatus` — the reconciler's hash-match
// skip is sufficient. Callers who need an on-chain probe (e.g. confirm a
// shared object the tx created is still live) pass an explicit `getStatus`
// and treat it as a Verify-style invariant rather than an idempotence
// check.

import type { Transaction } from '@mysten/sui/transactions';

import type { ActionRunContext, Provides, SeedAction, SetupActionScope } from '../core/types.js';
import { openSuiRpcClient } from '../helpers/sui-client.js';
import { stableHash } from '../runtime/hash.js';
import { Transaction as TransactionImpl } from '@mysten/sui/transactions';
import { seed } from './seed.js';

interface RunTransactionOptions {
	name: string;
	needs?: string[];
	provides?: Provides;
	/** Account name that signs the tx. Resolved via `ctx.accounts.get`. */
	signer: string;
	/** Build the transaction. The returned tx (or the mutated input) is
	 * signed by `signer` and executed. Throws on non-success effects. */
	build: (ctx: ActionRunContext, tx: Transaction) => void | Promise<void>;
	/** Optional on-chain probe. When set, the reconciler runs it on every
	 * cycle even when the input hash matches — useful for "did the
	 * downstream object I created get destroyed off-chain?" invariants.
	 * Most callers leave this undefined; hash match is sufficient. */
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
	/** Setup-action scope. See `SetupActionScope`. Default: 'always'. */
	scope?: SetupActionScope;
}

export function runTransaction(opts: RunTransactionOptions): SeedAction<Record<string, unknown>> {
	// `Function.toString()` is the cheapest way to make build-callback
	// edits invalidate the hash. Closure-captured constants don't appear
	// in toString output — users who want those to invalidate must
	// reference them in the build body so the source captures the
	// reference (or pass a custom `getStatus`).
	const buildHash = stableHash({
		signer: opts.signer,
		build: opts.build.toString(),
		scope: opts.scope ?? 'always',
		needs: opts.needs ?? [],
	});
	return seed({
		name: opts.name,
		needs: opts.needs,
		provides: opts.provides,
		inputs: { signer: opts.signer, buildHash },
		runsAs: opts.signer,
		scope: opts.scope,
		getStatus: opts.getStatus,
		run: async (ctx) => {
			const client = openSuiRpcClient(ctx);
			const signer = ctx.accounts.get(opts.signer);
			const tx = new TransactionImpl();
			await opts.build(ctx, tx);
			const result = await client.signAndExecuteTransaction({
				signer,
				transaction: tx,
				options: { showEffects: true },
			});
			const status = result.effects?.status?.status;
			if (status !== 'success') {
				const err = result.effects?.status?.error ?? 'unknown';
				throw new Error(`runTransaction(${opts.name}): tx failed: ${err}`);
			}
			await client.waitForTransaction({ digest: result.digest });
		},
	});
}
