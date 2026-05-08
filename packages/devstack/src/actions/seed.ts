// `seed()` — Post-publish data write action factory.
//
// Localnet-only by default. Authors opt into other networks via the
// shared `Action.networks: Network[]` field — pass
// `networks: ['localnet', 'testnet']` to allow a seed on testnet too.

import type { ActionRunContext, Network, Provides, SeedAction } from '../core/types.js';
import type { WithNeeds } from './with-needs.js';

const DEFAULT_SEED_NETWORKS: ReadonlyArray<Network> = ['localnet'];

interface SeedOptions<
	TInputs extends Record<string, unknown>,
	TNeeds extends string,
	TRunsAs extends string,
> {
	name: string;
	/**
	 * Action references this seed depends on. Bare names (e.g.
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
	inputs: TInputs;
	/**
	 * Networks this seed runs on. Default: localnet only. Pass an
	 * explicit list (e.g. `['localnet', 'testnet']`) to opt into live
	 * networks; the supervisor's per-target action filter drops the seed
	 * on every other network.
	 */
	networks?: Network[];
	/**
	 * Account name this seed signs as. Set when the `run:` callback
	 * issues transactions through `ctx.accounts.get('<name>')` so the
	 * reconciler can serialize same-signer seeds (otherwise concurrent
	 * seeds on the same account equivocate on the gas object).
	 * Plain register-only seeds with no signing should leave it unset.
	 *
	 * The literal flows into `ctx.accounts` typing inside `run:` — so
	 * `ctx.accounts.get('publisher')` autocompletes when
	 * `runsAs: 'publisher'`. `defineDevstackConfig` also extracts this
	 * via a phantom marker and validates against the declared
	 * `accounts:` union (a typo surfaces at the
	 * `defineDevstackConfig({ use: [...] })` call site).
	 */
	runsAs?: TRunsAs;
	run: (ctx: ActionRunContext<TRunsAs, TNeeds>) => Promise<void>;
	getStatus?: (
		ctx: ActionRunContext<TRunsAs, TNeeds>,
	) => Promise<{ ok: boolean; detail?: string }>;
	identity?: (
		ctx: ActionRunContext<TRunsAs, TNeeds>,
	) => Promise<string | undefined>;
}

/**
 * Phantom marker on the returned action carrying the `runsAs` literal.
 * `defineDevstackConfig` extracts the union of these from `use:[]`
 * and validates against the declared `accounts:` so a typo
 * (`runsAs: 'publishr'` against `accounts: ['publisher']`) surfaces
 * at the `defineDevstackConfig` call site. Carries no runtime cost.
 */
type SignsAs<TRunsAs extends string, T> = T & { readonly __signsAs?: TRunsAs };

export function seed<
	TInputs extends Record<string, unknown>,
	const TNeeds extends string = never,
	const TRunsAs extends string = never,
>(
	opts: SeedOptions<TInputs, TNeeds, TRunsAs>,
): WithNeeds<TNeeds, SignsAs<TRunsAs, SeedAction<TInputs>>> {
	return {
		name: opts.name,
		type: 'Seed',
		needs: opts.needs as string[] | undefined,
		provides: opts.provides,
		inputs: opts.inputs,
		networks: opts.networks ?? [...DEFAULT_SEED_NETWORKS],
		runsAs: opts.runsAs,
		run: opts.run as (ctx: ActionRunContext) => Promise<void>,
		getStatus: opts.getStatus as
			| ((ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>)
			| undefined,
		identity: opts.identity as
			| ((ctx: ActionRunContext) => Promise<string | undefined>)
			| undefined,
	} as WithNeeds<TNeeds, SignsAs<TRunsAs, SeedAction<TInputs>>>;
}

/** Returns true if the seed action is allowed to run on the given network.
 * Reads `action.networks` (default `['localnet']`); plugin authors override
 * via `seed({ networks: ['localnet', 'testnet'] })`. */
export function seedRunsOn(action: SeedAction, network: Network): boolean {
	const networks = action.networks ?? DEFAULT_SEED_NETWORKS;
	return networks.includes(network);
}
