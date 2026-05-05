// `seed()` — Post-publish data write action factory.
//
// Localnet-only by default. Authors opt into live networks explicitly via
// `liveNetworks: true` (any) or `liveNetworks: ['testnet']` (specific).

import type {
	ActionRunContext,
	Network,
	Provides,
	SeedAction,
	SetupActionScope,
} from '../core/types.js';

interface SeedOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides;
	inputs: TInputs;
	/**
	 * Networks this seed runs on. Default: localnet only.
	 * - `true` → all networks (use sparingly).
	 * - `Network[]` → explicit allow-list.
	 */
	liveNetworks?: boolean | Network[];
	/**
	 * Account name this seed signs as. Set when the `run:` callback
	 * issues transactions through `ctx.accounts.get('<name>')` so the
	 * reconciler can serialize same-signer seeds (otherwise concurrent
	 * seeds on the same account equivocate on the gas object).
	 * Plain register-only seeds with no signing should leave it unset.
	 */
	runsAs?: string;
	/** Setup-action scope. See `SetupActionScope`. Default: 'always'.
	 * Use `'test-only'` for fixtures that should run in the `test` stack
	 * but not in `main`; `'localnet-only'` to skip on testnet/mainnet
	 * even when `liveNetworks` would otherwise allow them. */
	scope?: SetupActionScope;
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
		provides: opts.provides,
		inputs: opts.inputs,
		liveNetworks: opts.liveNetworks,
		runsAs: opts.runsAs,
		...(opts.scope !== undefined ? { scope: opts.scope } : {}),
		run: opts.run,
		getStatus: opts.getStatus,
		identity: opts.identity,
	};
}

/** Returns true if the seed action is allowed to run on the given network. */
export function seedRunsOn(action: SeedAction, network: Network): boolean {
	if (network === 'localnet') return true;
	const live = action.liveNetworks;
	if (live === true) return true;
	if (Array.isArray(live)) return live.includes(network);
	return false;
}
