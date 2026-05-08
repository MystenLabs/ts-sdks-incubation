import type { Dep, Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { sui } from '../plugins/sui.js';

export interface RunTransactionContext<TSigner> {
	signer: TSigner;
	rpcUrl: string;
	inputHash: string;
}

export interface RunTransactionOptions<TSigner, TResult> {
	/** Logical name. Engine node is `tx.<name>`. */
	name: string;
	/** Dep returning the signer — typically `accounts.get('signer', {name})`.
	 * `Dep<any, …>` lets callers pass either a no-data Dep
	 * (`acc.get('signer')`) or a parameterized one; TData is contravariant. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	signer: Dep<any, TSigner>;
	/** Tx body. Called once per dirty cycle. Returns whatever shape the
	 * caller wants persisted into the action's state. */
	build: (ctx: RunTransactionContext<TSigner>) => Promise<TResult>;
	/** Optional extra invalidator. Folded into the input hash so the caller
	 * can re-fire the action when external state (e.g., a config file)
	 * changes. */
	inputs?: () => unknown | Promise<unknown>;
	/** Override the runsAs lock key. Default: `'<name>'` so distinct
	 * transactions don't collide; pass the signer's name to serialize
	 * with sibling actions sharing the same signer. */
	runsAs?: string;
}

// `runTransaction` encodes the "run a single transaction once" pattern.
// Less prescriptive than publishMove — the caller's `build` callback is
// the whole body. The helper:
//
//   - Auto-deps on `sui.get('rpc')` (ambient).
//   - Defaults runsAs to the action name (each tx has its own lock key).
//   - Folds an optional `inputs` callback into the input hash so the
//     caller controls re-fire conditions.
//
//   const mintInitial = runTransaction({
//     name: 'mint-initial',
//     signer: accounts.get('signer', { name: 'minter' }),
//     build: async ({ signer, rpcUrl }) => {
//       const tx = new Transaction();
//       tx.moveCall({ target: `${tokenPkg}::token::mint`, arguments: [...] });
//       const result = await mySdk.signAndExecute(tx, signer, rpcUrl);
//       return { digest: result.digest };
//     },
//   });
export function runTransaction<TSigner, TResult>(
	opts: RunTransactionOptions<TSigner, TResult>,
) {
	if (!opts.name) throw new Error('runTransaction: `name` is required');
	if (typeof opts.build !== 'function') {
		throw new Error(`runTransaction("${opts.name}"): \`build\` is required`);
	}

	const deps = { signer: opts.signer, rpc: sui.get('rpc') };

	const provides = {
		full: dep((s: TResult) => s),
	} satisfies Provides<TResult>;

	return define<TResult, typeof provides, typeof deps>({
		name: `tx.${opts.name}`,
		runsAs: opts.runsAs ?? opts.name,
		deps,
		provides,
		inputs: async ({ deps: { rpc } }) => ({
			rpcUrl: rpc.url,
			extra: opts.inputs ? await opts.inputs() : undefined,
		}),
		run: async ({ deps: { signer, rpc }, inputHash }) => {
			return await opts.build({ signer, rpcUrl: rpc.url, inputHash });
		},
	});
}
