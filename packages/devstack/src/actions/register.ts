// `register()` — One-shot on-chain bootstrap action factory.
//
// Distinct from `Publish` (which compiles + publishes Move bytecode):
// `Register` is for arbitrary on-chain transactions like registering a
// seal `KeyServer` object, walrus's deploy script, or similar bootstraps.
// Plugin authors typically also override `getStatus` for richer "is my
// registered thing still live on-chain?" checks.

import type { ActionRunContext, Network, Provides, RegisterAction } from '../core/types.js';

interface RegisterOptions<TInputs extends Record<string, unknown>> {
	name: string;
	needs?: string[];
	provides?: Provides;
	inputs: TInputs;
	/** Account this register signs as. Set when the `run:` callback issues
	 * transactions through `ctx.accounts.get('<name>')` — engages the
	 * reconciler's same-signer serialization. */
	runsAs?: string;
	/** Networks the action runs on. Defaults to all networks. Set to e.g.
	 * `['localnet']` for actions that only make sense against a localnet
	 * service (faucet flows, dev-only bootstraps). */
	networks?: Network[];
	run: (ctx: ActionRunContext) => Promise<void>;
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
	identity?: (ctx: ActionRunContext) => Promise<string | undefined>;
}

export function register<TInputs extends Record<string, unknown>>(
	opts: RegisterOptions<TInputs>,
): RegisterAction<TInputs> {
	return {
		name: opts.name,
		type: 'Register',
		needs: opts.needs,
		provides: opts.provides,
		inputs: opts.inputs,
		runsAs: opts.runsAs,
		networks: opts.networks,
		run: opts.run,
		getStatus: opts.getStatus,
		identity: opts.identity,
	};
}
