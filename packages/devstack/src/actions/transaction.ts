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

import type { ActionRunContext, Provides, SeedAction } from '../core/types.js';
import { openSuiRpcClient } from '../helpers/sui-client.js';
import { stableHash } from '../runtime/hash.js';
import { Transaction as TransactionImpl } from '@mysten/sui/transactions';
import { seed } from './seed.js';
import type { WithNeeds } from './with-needs.js';

interface RunTransactionOptions<
	TNeeds extends string,
	TSigner extends string,
> {
	name: string;
	/**
	 * Action references this tx depends on. Bare names (e.g.
	 * `'usdc'`) resolve against sibling setup actions in the same
	 * synthetic `<app>-setup` plugin; dotted names
	 * (e.g. `'sui.localnet'`, `'walrus.register'`) reference plugin
	 * actions in the surrounding `defineDevstackConfig({ use: [...] })`
	 * array. Dotted references are validated at compile time against
	 * the union of every `Plugin<TProvides>` in `use:` — typos surface
	 * at the `defineDevstackConfig({ use: [...] })` call site.
	 */
	needs?: readonly TNeeds[];
	provides?: Provides;
	/** Account name that signs the tx. Resolved via `ctx.accounts.get`.
	 * The literal value flows into `ctx.accounts` typing inside `build`
	 * (so `ctx.accounts.get('alice')` autocompletes when
	 * `signer: 'alice'`). `defineDevstackConfig` also extracts the
	 * `signer` value via a phantom marker on the returned action and
	 * validates it against the declared `accounts:` union — a typo
	 * (e.g. `signer: 'alic'` with `accounts: ['alice', 'bob']`)
	 * surfaces at the `defineDevstackConfig({ use: [...] })` call
	 * site as `Type '"alic"' is not assignable to type ...`. */
	signer: TSigner;
	/** Build the transaction. The returned tx (or the mutated input) is
	 * signed by `signer` and executed. Throws on non-success effects.
	 *
	 * `ctx.accounts` is typed against `TSigner` so
	 * `ctx.accounts.get(opts.signer)` autocompletes. Other declared
	 * accounts are accessible via the `(string & {})` arm of
	 * `AccountsContext.get` — the autocomplete just doesn't know about
	 * them at this site. `ctx.registry.packages.find/require` is typed
	 * against the union of bare-name `needs:` (typically the related
	 * `publishMove` action names). */
	build: (
		ctx: ActionRunContext<TSigner, TNeeds>,
		tx: Transaction,
	) => void | Promise<void>;
	/** Optional on-chain probe. When set, the reconciler runs it on every
	 * cycle even when the input hash matches — useful for "did the
	 * downstream object I created get destroyed off-chain?" invariants.
	 * Most callers leave this undefined; hash match is sufficient. */
	getStatus?: (
		ctx: ActionRunContext<TSigner, TNeeds>,
	) => Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Phantom marker on the returned action carrying the `signer` literal.
 * `defineDevstackConfig` extracts the union of these from `use:[]` and
 * validates against the declared `accounts:` so a typo on the regular
 * array form (`use: [runTransaction({ signer: 'alic' }), ...]`)
 * surfaces at the `defineDevstackConfig` call site. Carries no
 * runtime cost.
 */
type SignsAs<TSigner extends string, T> = T & { readonly __signsAs?: TSigner };

/**
 * Fire a single setup transaction, idempotent via the reconciler's
 * input-hash skip. Editing the `build` callback invalidates the hash
 * and re-runs on the next cycle. Sugar over `seed()` from `/authoring`.
 *
 * @example
 * ```ts
 * import { runTransaction } from '@mysten-incubation/devstack';
 *
 * runTransaction({
 *   name: 'mint-greeting',
 *   needs: ['hello'],
 *   signer: 'alice',
 *   build: (ctx, tx) => {
 *     const pkg = ctx.registry.packages.require('hello');
 *     tx.moveCall({ target: `${pkg.packageId}::hello::mint`, arguments: [] });
 *   },
 * });
 * ```
 */
export function runTransaction<
	const TNeeds extends string = never,
	const TSigner extends string = string,
>(
	opts: RunTransactionOptions<TNeeds, TSigner>,
): WithNeeds<TNeeds, SignsAs<TSigner, SeedAction<Record<string, unknown>>>> {
	// `Function.toString()` is the cheapest way to make build-callback
	// edits invalidate the hash. Closure-captured constants don't appear
	// in toString output — users who want those to invalidate must
	// reference them in the build body so the source captures the
	// reference (or pass a custom `getStatus`).
	const buildHash = stableHash({
		signer: opts.signer,
		build: opts.build.toString(),
		needs: opts.needs ?? [],
	});
	const action = seed({
		name: opts.name,
		needs: opts.needs,
		provides: opts.provides,
		inputs: { signer: opts.signer, buildHash },
		runsAs: opts.signer,
		getStatus: opts.getStatus as
			| ((ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>)
			| undefined,
		run: async (ctx) => {
			const client = openSuiRpcClient(ctx);
			const signer = ctx.accounts.get(opts.signer);
			const tx = new TransactionImpl();
			await opts.build(ctx as ActionRunContext<TSigner, TNeeds>, tx);
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
	return action as WithNeeds<TNeeds, SignsAs<TSigner, SeedAction<Record<string, unknown>>>>;
}
