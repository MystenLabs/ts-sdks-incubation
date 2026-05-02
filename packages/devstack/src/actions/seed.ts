// `seed()` — Post-publish data write action factory.
//
// Localnet-only by default (Q5). Authors opt into live networks explicitly
// via `liveNetworks: true` (any) or `liveNetworks: ['testnet']` (specific).

import type { ActionRunContext, Network, Provides, SeedAction } from '../core/types.js';

export interface SeedOptions<TInputs extends Record<string, unknown>> {
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
	run: (ctx: ActionRunContext) => Promise<void>;
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
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
		run: opts.run,
		getStatus: opts.getStatus,
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
