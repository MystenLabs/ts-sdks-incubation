// Per-network options: the plugin-aware interpretation of the opaque
// `DevstackOptions.networkOptions` the name-blind substrate forwards
// verbatim. This module lives OUTSIDE substrate precisely because it
// names dev conveniences (dev wallet, faucet, signing) — substrate stays
// name-blind; the orchestrator reads the policy.

/**
 * Per-network dev-convenience toggles. All optional — an unset field
 * defers to the default policy (on for every network EXCEPT live
 * `mainnet`). A CONSISTENT mechanism: declare these once per network in
 * the config instead of scattering one-off flags. `devWallet` is the
 * load-bearing consumer today (gates the dev-wallet `generated-extras`
 * flush at boot, which the Vite plugin injects); `faucet` /
 * `autoApproveSigning` round out the initial set.
 */
export interface NetworkScopedOptions {
	/** Mount the test-only dev wallet and flush its `generated-extras`
	 *  tree (`dev-wallet.ts` + `accounts.ts`) at boot so the Vite plugin's
	 *  `@devstack-dev` injection has files to load. Off → no flush, and
	 *  the Vite `load` hook gracefully no-ops. */
	readonly devWallet?: boolean;
	/** Run a funding faucet for this network (a local faucet container in
	 *  local mode; the network's real faucet endpoint in live mode). */
	readonly faucet?: boolean;
	/** Auto-approve dev-wallet signing requests (browser-test ergonomics). */
	readonly autoApproveSigning?: boolean;
}

/** Every field resolved to a concrete boolean (no `undefined`). */
export type ResolvedNetworkOptions = Required<NetworkScopedOptions>;

/**
 * The default per-network policy: dev conveniences are ON for every
 * network EXCEPT live `mainnet`. Fork networks (`mainnet-fork`, …) are
 * local dev stacks, so they stay ON — only the real `mainnet` name opts
 * out.
 */
export const defaultNetworkOptions = (network: string): ResolvedNetworkOptions => {
	const on = network !== 'mainnet';
	return { devWallet: on, faucet: on, autoApproveSigning: on };
};

const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/**
 * Resolve the effective options for the active network: the default
 * policy ({@link defaultNetworkOptions}) with the author's per-network
 * overrides merged on top, field by field (an unset/non-boolean override
 * field keeps the policy default). `overrides` is the opaque
 * substrate-forwarded record — fields are read defensively.
 */
export const resolveNetworkOptions = (
	network: string,
	overrides?: Readonly<Record<string, unknown>>,
): ResolvedNetworkOptions => {
	const base = defaultNetworkOptions(network);
	const raw = overrides?.[network];
	if (raw === null || typeof raw !== 'object') return base;
	const o = raw as Record<string, unknown>;
	return {
		devWallet: asBool(o['devWallet']) ?? base.devWallet,
		faucet: asBool(o['faucet']) ?? base.faucet,
		autoApproveSigning: asBool(o['autoApproveSigning']) ?? base.autoApproveSigning,
	};
};
