// Per-network options: the plugin-aware interpretation of the opaque
// `DevstackOptions.networkOptions` the name-blind substrate forwards
// verbatim. This module lives OUTSIDE substrate precisely because it
// names dev conveniences (dev wallet, faucet, signing) — substrate stays
// name-blind; the orchestrator reads the policy.

/**
 * Per-network dev-convenience toggles. All optional — an unset field
 * defers to the default policy (on for every network EXCEPT live
 * `mainnet`). A CONSISTENT mechanism: declare these once per network in
 * the config instead of scattering one-off flags. All three fields are
 * enforced:
 *
 *   - `devWallet` gates the dev-wallet `generated-extras` flush at boot
 *     (`orchestrators/boot.ts`), which the Vite plugin injects.
 *   - `faucet` gates the funding-faucet strategy contribution in the sui
 *     plugin (`plugins/sui/index.ts`) — a non-faucet network never
 *     registers `faucet:request:<chainId>`, so on `mainnet` the faucet
 *     never runs.
 *   - `autoApproveSigning` gates the dev-wallet auto-approve policy the
 *     Vite plugin emits into the injected dev-wallet
 *     (`build-integrations/vite/index.ts`) — on `mainnet` signing is
 *     never silently auto-approved.
 */
export interface NetworkScopedOptions {
	/** ENFORCED. Mount the test-only dev wallet and flush its
	 *  `generated-extras` tree (`dev-wallet.ts` + `accounts.ts`) at boot so
	 *  the Vite plugin's `@devstack-dev` injection has files to load. Off →
	 *  no flush, and the Vite `load` hook gracefully no-ops. */
	readonly devWallet?: boolean;
	/** ENFORCED. Register this network's funding-faucet strategy
	 *  (`faucet:request:<chainId>`) in the sui plugin so account funding can
	 *  dispatch through it. Off → the strategy is suppressed and account
	 *  funding surfaces the actionable "no faucet strategy" error instead of
	 *  faucet-funding. Hard-clamped off on live `mainnet`. The sui mode still
	 *  decides HOW a faucet is provisioned (local container / fork whale /
	 *  live endpoint); this flag decides WHETHER the resolved strategy is
	 *  exposed at all. */
	readonly faucet?: boolean;
	/** ENFORCED. Default the injected dev-wallet's auto-approve policy for
	 *  this network (`build-integrations/vite/index.ts`). On → dev-wallet
	 *  signing requests auto-approve (headless Playwright / in-app "Open as"
	 *  ergonomics) unless an explicit `autoApprove` / `DEVSTACK_AUTO_APPROVE`
	 *  overrides. Hard-clamped off on live `mainnet`, so a real-funds
	 *  signature is never granted without a human in the loop. */
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
	// HARD-CLAMP: every dev convenience is forced OFF on real `mainnet`,
	// regardless of an explicit `{ mainnet: { … : true } }` override. The
	// default policy is already off for `mainnet`; the clamp ALSO blocks a
	// silent explicit opt-in. Each clamp guards a distinct production-safety
	// failure mode:
	//   - `devWallet` — flushing the secret `generated-extras` tree and
	//     injecting a test-only signer into a production build.
	//   - `faucet` — exposing a funding-faucet strategy against a real
	//     network (there is no mainnet faucet to begin with).
	//   - `autoApproveSigning` — auto-approving a real-funds signature with
	//     no human in the loop.
	if (network === 'mainnet') {
		return { devWallet: false, faucet: false, autoApproveSigning: false };
	}
	return {
		devWallet: asBool(o['devWallet']) ?? base.devWallet,
		faucet: asBool(o['faucet']) ?? base.faucet,
		autoApproveSigning: asBool(o['autoApproveSigning']) ?? base.autoApproveSigning,
	};
};
