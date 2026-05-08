import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';

export interface AccountPoolState<TSigner> {
	signers: Record<string, TSigner>;
}

export interface AccountPoolMaterializeArgs<TSigner, TSpec> {
	specs: Record<string, TSpec>;
	prior: Record<string, TSigner> | undefined;
	// Names that any consumer asked for via `pool.get('signer', { name })`,
	// or all spec names if any consumer asked for `pool.get('all')`. The
	// caller can short-circuit and only materialize what's needed.
	needed: ReadonlySet<string>;
}

export interface AccountPoolOptions<TSigner, TSpec = unknown> {
	name?: string;
	specs: Record<string, TSpec>;
	materialize: (
		args: AccountPoolMaterializeArgs<TSigner, TSpec>,
	) => Promise<Record<string, TSigner>>;
	// Optional projection used for the `represents.accounts` view (TUI / observability).
	addressOf?: (signer: TSigner) => string;
}

// `accountPool` is the standard "name → signer" graph node. Plugin
// authors supply a `materialize` callback that turns specs into signers
// (the devstack-next layer is signer-type agnostic). Two query shapes
// are exposed:
//
//   pool.get('signer', { name: 'publisher' })   // Dep<{name}, TSigner>
//   pool.get('all')                              // Dep<void, Record<string, TSigner>>
//
// The pool merges prior (last cycle's signers) with the materialize
// result, so warm-restarts retain previously-generated key material.
//
// Return type is left to TS inference — naming a TProvides interface
// breaks the `Record<string, DepRecipe>` index-signature constraint that
// the engine's Provides<TState> requires.
export function accountPool<TSigner, TSpec = unknown>(opts: AccountPoolOptions<TSigner, TSpec>) {
	const buildProvides = () => ({
		signer: dep((state: AccountPoolState<TSigner>, d: { name: string }): TSigner => {
			const sig = state.signers[d.name];
			if (sig === undefined) {
				throw new Error(`accountPool: signer "${d.name}" not in pool`);
			}
			return sig;
		}),
		all: dep((state: AccountPoolState<TSigner>) => state.signers),
	});

	return define<AccountPoolState<TSigner>>({
		name: opts.name ?? 'accounts.pool',
		provides: buildProvides(),
		start: async ({ prior, requests }) => {
			const needed = new Set<string>();
			for (const req of requests.signer ?? []) needed.add(req.name);
			if ((requests.all?.length ?? 0) > 0) {
				for (const name of Object.keys(opts.specs)) needed.add(name);
			}
			const signers = await opts.materialize({
				specs: opts.specs,
				prior: prior?.signers,
				needed,
			});
			return { signers };
		},
		...(opts.addressOf
			? {
					represents: {
						accounts: (s: AccountPoolState<TSigner>) =>
							Object.entries(s.signers).map(([name, sig]) => ({
								name,
								address: opts.addressOf!(sig),
							})),
					},
				}
			: {}),
	});
}
