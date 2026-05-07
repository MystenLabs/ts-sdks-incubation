// `seed()` — Post-publish data write action factory.
//
// Localnet-only by default. Authors opt into other networks via the
// shared `Action.networks: Network[]` field — pass
// `networks: ['localnet', 'testnet']` to allow a seed on testnet too.

import type { ActionRunContext, Network, Provides, SeedAction } from '../core/types.js';
import { mergeRegistryShortcut } from '../core/types.js';

const DEFAULT_SEED_NETWORKS: ReadonlyArray<Network> = ['localnet'];

interface SeedOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides;
	/** Sugar for `provides: { registry }`. */
	registry?: (ctx: ActionRunContext) => Promise<void> | void;
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
	 */
	runsAs?: string;
	run: (ctx: ActionRunContext) => Promise<void>;
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
	identity?: (ctx: ActionRunContext) => Promise<string | undefined>;
}

export function seed<TInputs extends Record<string, unknown>>(
	opts: SeedOptions<TInputs>,
): SeedAction<TInputs> {
	return {
		name: opts.name,
		type: 'Seed',
		needs: opts.needs,
		provides: mergeRegistryShortcut(opts.provides, opts.registry),
		inputs: opts.inputs,
		networks: opts.networks ?? [...DEFAULT_SEED_NETWORKS],
		runsAs: opts.runsAs,
		run: opts.run,
		getStatus: opts.getStatus,
		identity: opts.identity,
	};
}

/** Returns true if the seed action is allowed to run on the given network.
 * Reads `action.networks` (default `['localnet']`); plugin authors override
 * via `seed({ networks: ['localnet', 'testnet'] })`. */
export function seedRunsOn(action: SeedAction, network: Network): boolean {
	const networks = action.networks ?? DEFAULT_SEED_NETWORKS;
	return networks.includes(network);
}
