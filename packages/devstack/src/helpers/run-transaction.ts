import type { Dep, Provides, ResolvedDeps } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { sui } from '../plugins/sui.js';

export interface RunTransactionContext<TSigner, TDeps> {
	signer: TSigner;
	rpcUrl: string;
	inputHash: string;
	/** Caller-supplied extra deps, resolved. Empty object when the
	 * caller didn't pass `deps:`. Use for shared chain context the tx
	 * needs but doesn't directly produce — e.g. a package id captured
	 * from a sibling deploy step, or a token type queried out-of-band. */
	deps: ResolvedDeps<TDeps>;
}

export interface RunTransactionOptions<TSigner, TResult, TDeps> {
	/** Logical name. Engine node is `tx.<name>`. */
	name: string;
	/** Dep returning the signer — typically `accounts.get('signer', {name})`.
	 * `Dep<…>` lets callers pass either a no-data Dep
	 * (`acc.get('signer')`) or a parameterized one; TData is contravariant. */
	signer: Dep<TSigner>;
	/** Optional extra deps. Useful when the tx body needs shared chain
	 * context (a captured package id, a coin type discovered on-chain
	 * once and cached in a sibling transformer). The build callback
	 * receives them as `ctx.deps`. The engine pulls them into the graph
	 * transitively, so an upstream rebuild cascades into a re-run. */
	deps?: TDeps;
	/** Tx body. Called once per dirty cycle. Returns whatever shape the
	 * caller wants persisted into the action's state. */
	build: (ctx: RunTransactionContext<TSigner, TDeps>) => Promise<TResult>;
	/** Optional extra invalidator. Folded into the input hash so the caller
	 * can re-fire the action when external state (e.g., a config file)
	 * changes. */
	inputs?: () => unknown | Promise<unknown>;
}

// `runTransaction` encodes the "run a single transaction once" pattern.
// Less prescriptive than publishMove — the caller's `build` callback is
// the whole body. The helper:
//
//   - Auto-deps on `sui.get('rpc')` (ambient).
//   - Forwards caller-supplied extra deps into the build callback's
//     `ctx.deps`, so transactions that need shared chain context (a
//     captured package id, a token type) compose against existing
//     graph nodes without dropping to raw `define()`.
//   - Same-signer serialization flows through the caller's signer Dep:
//     `accounts.pool.get('exclusive', { name })` makes the engine
//     refuse to parallel-batch txs sharing that signer. Default `signer`
//     gives no serialization — the cycles are independent.
//   - Folds an optional `inputs` callback into the input hash so the
//     caller controls re-fire conditions.
//
//   const mintInitial = runTransaction({
//     name: 'mint-initial',
//     signer: accounts.get('signer', { name: 'minter' }),
//     deps: { token: tokenDeploy.get('full') },
//     build: async ({ signer, rpcUrl, deps }) => {
//       const tx = new Transaction();
//       tx.moveCall({ target: `${deps.token.packageId}::token::mint`, arguments: [...] });
//       const result = await mySdk.signAndExecute(tx, signer, rpcUrl);
//       return { digest: result.digest };
//     },
//   });
export function runTransaction<TSigner, TResult, TDeps = undefined>(
	opts: RunTransactionOptions<TSigner, TResult, TDeps>,
) {
	if (!opts.name) throw new Error('runTransaction: `name` is required');
	if (typeof opts.build !== 'function') {
		throw new Error(`runTransaction("${opts.name}"): \`build\` is required`);
	}

	// Internal deps wrapper — `signer` and `rpc` are baked-in; user deps
	// nest under `_user` so we can hand them back as `ctx.deps` typed as
	// `ResolvedDeps<TDeps>` without polluting the main resolved deps
	// shape that the engine traverses.
	const internalDeps = {
		signer: opts.signer,
		rpc: sui.get('rpc'),
		_user: opts.deps as TDeps,
	};

	const provides = {
		full: dep((s: TResult) => s),
	} satisfies Provides<TResult>;

	return define<TResult, typeof provides, typeof internalDeps>({
		name: `tx.${opts.name}`,
		deps: internalDeps,
		provides,
		inputs: async ({ deps: { rpc } }) => ({
			rpcUrl: rpc.url,
			extra: opts.inputs ? await opts.inputs() : undefined,
		}),
		run: async ({ deps, inputHash }) => {
			return await opts.build({
				signer: deps.signer,
				rpcUrl: deps.rpc.url,
				inputHash,
				// Coerce missing user deps to `{}` so the build callback
				// can do `deps.foo ?? defaultFoo` without first guarding
				// the whole `deps` object.
				deps: (deps._user ?? {}) as ResolvedDeps<TDeps>,
			});
		},
	});
}
