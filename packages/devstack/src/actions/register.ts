// `register()` — One-shot on-chain bootstrap action factory.
//
// Distinct from `Publish` (which compiles + publishes Move bytecode):
// `Register` is for arbitrary on-chain transactions like registering a
// seal `KeyServer` object, walrus's deploy script, or similar bootstraps.
// Plugin authors typically also override `getStatus` for richer "is my
// registered thing still live on-chain?" checks.
//
// Localnet-only by default (matches `seed()`). Plugin authors who need a
// `Register` to run on testnet/mainnet pass an explicit
// `networks: ['localnet', 'testnet', 'mainnet']` (or any subset). Most
// register flows wire dev-only bootstraps (key-server registration, walrus
// deploy, faucet-fund follow-ons), so the safe default is `['localnet']`
// — silent live-net fan-out is rarely intended.

import type { ActionRunContext, Network, Provides, RegisterAction } from '../core/types.js';
import type { WithNeeds } from './with-needs.js';

const DEFAULT_REGISTER_NETWORKS: ReadonlyArray<Network> = ['localnet'];

export interface RegisterOptions<
	TInputs extends Record<string, unknown>,
	TNeeds extends string,
	TRunsAs extends string,
> {
	name: string;
	/**
	 * Action references this register depends on. Bare names resolve
	 * against sibling setup actions in the same synthetic `<app>-setup`
	 * plugin; dotted names reference plugin actions in the surrounding
	 * `defineDevstackConfig({ use: [...] })` array. Dotted references
	 * are validated at compile time against the union of every
	 * `Plugin<TProvides>` in `use:` — typos surface at the
	 * `defineDevstackConfig({ use: [...] })` call site.
	 */
	needs?: readonly TNeeds[];
	provides?: Provides;
	inputs: TInputs;
	/** Account this register signs as. Set when the `run:` callback issues
	 * transactions through `ctx.accounts.get('<name>')` — engages the
	 * reconciler's same-signer serialization.
	 *
	 * The literal flows into `ctx.accounts` typing inside `run:` — so
	 * `ctx.accounts.get('publisher')` autocompletes when
	 * `runsAs: 'publisher'`. `defineDevstackConfig` also extracts this
	 * via a phantom marker and validates against the declared `accounts:`
	 * union (a typo surfaces at the `defineDevstackConfig({ use: [...] })`
	 * call site). */
	runsAs?: TRunsAs;
	/**
	 * Networks the action runs on. Default: `['localnet']` (matches
	 * `seed()`). Pass an explicit list (e.g. `['localnet', 'testnet']`)
	 * to opt into live networks — most registers only make sense against
	 * a localnet service so the default is conservative.
	 */
	networks?: Network[];
	run: (ctx: ActionRunContext<TRunsAs, TNeeds>) => Promise<void>;
	getStatus?: (
		ctx: ActionRunContext<TRunsAs, TNeeds>,
	) => Promise<{ ok: boolean; detail?: string }>;
	identity?: (ctx: ActionRunContext<TRunsAs, TNeeds>) => Promise<string | undefined>;
}

/**
 * Phantom marker on the returned action carrying the `runsAs` literal.
 * `defineDevstackConfig` extracts the union of these from `use:[]` and
 * validates against the declared `accounts:` so a typo (`runsAs: 'alic'`
 * against `accounts: ['alice']`) surfaces at the `defineDevstackConfig`
 * call site rather than at runtime. Carries no runtime cost.
 */
type SignsAs<TRunsAs extends string, T> = T & { readonly __signsAs?: TRunsAs };

export function register<
	TInputs extends Record<string, unknown>,
	const TNeeds extends string = never,
	const TRunsAs extends string = never,
>(
	opts: RegisterOptions<TInputs, TNeeds, TRunsAs>,
): WithNeeds<TNeeds, SignsAs<TRunsAs, RegisterAction<TInputs>>> {
	return {
		name: opts.name,
		type: 'Register',
		needs: opts.needs as string[] | undefined,
		provides: opts.provides,
		inputs: opts.inputs,
		runsAs: opts.runsAs,
		networks: opts.networks ?? [...DEFAULT_REGISTER_NETWORKS],
		run: opts.run as (ctx: ActionRunContext) => Promise<void>,
		getStatus: opts.getStatus as
			| ((ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>)
			| undefined,
		identity: opts.identity as
			| ((ctx: ActionRunContext) => Promise<string | undefined>)
			| undefined,
	} as WithNeeds<TNeeds, SignsAs<TRunsAs, RegisterAction<TInputs>>>;
}
