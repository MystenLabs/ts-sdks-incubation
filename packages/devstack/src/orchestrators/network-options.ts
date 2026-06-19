// Per-network options: the plugin-aware interpretation of the opaque
// `DevstackOptions.networkOptions` the name-blind substrate forwards
// verbatim. This module lives OUTSIDE substrate precisely because it
// names dev conveniences (dev wallet, signing) — substrate stays
// name-blind; the orchestrator reads the policy.

/**
 * Per-network dev-convenience toggles. All optional — an unset field
 * defers to the default policy: the dev wallet is on for every network
 * EXCEPT live `mainnet`, while `autoApproveSigning` defaults off everywhere
 * (opt in for headless tests / fast local iteration). A CONSISTENT
 * mechanism: declare these once per network in the config instead of
 * scattering one-off flags.
 *
 *   - `devWallet` — documents per-network intent to mount the dev wallet.
 *     The dev-wallet connection now rides the deployment envelope's
 *     `values['dev-wallet']` channel unconditionally (when `wallet()` is
 *     mounted); the Vite plugin gates injection on a live stack's token
 *     file existing, and a prod `build` never injects regardless. So this
 *     flag carries no active boot gate today — it remains as the documented
 *     per-network knob.
 *   - `autoApproveSigning` — per-network override is FORWARDED. Gates the
 *     dev-wallet auto-approve policy the Vite plugin emits into the
 *     injected dev-wallet (`build-integrations/vite/index.ts`) — on
 *     `mainnet` signing is never silently auto-approved.
 *
 * NOTE — there is deliberately NO per-network `faucet` toggle here. The
 * funding-faucet strategy gate (`faucet:request:<chainId>`) lives in the
 * sui plugin and follows a fixed policy: ON for every non-`mainnet`
 * network, hard-clamped OFF on live `mainnet`. The name-blind substrate
 * does not thread `networkOptions` into plugins (the sui plugin only
 * receives the closed `IdentityContext` tuple), so a per-network `faucet`
 * override could never reach the gate — exposing the field would advertise
 * a silent no-op. If a per-network faucet override is ever genuinely
 * needed it must first be threaded into plugin scope (grow `Identity` or
 * stamp it onto the resolved mode opts in the orchestrator that builds
 * them), THEN re-added here.
 */
export interface NetworkScopedOptions {
	/** Documents per-network intent to mount the test-only dev wallet. The
	 *  dev-wallet connection rides the deployment envelope's
	 *  `values['dev-wallet']` channel (folded by `assembleDeployment` when
	 *  `wallet()` is mounted), and the Vite plugin gates injection on a live
	 *  stack's `0o600` token file existing — a prod `build` injects nothing
	 *  regardless. No active boot gate consumes this today. */
	readonly devWallet?: boolean;
	/** ENFORCED. Default the injected dev-wallet's auto-approve policy for
	 *  this network (`build-integrations/vite/index.ts`). Defaults OFF on every
	 *  network so a normal `pnpm dev` exercises the real connect + approve UX;
	 *  set `true` to auto-approve signing requests for this network (headless
	 *  Playwright / in-app "Open as" ergonomics). An explicit `autoApprove` /
	 *  `DEVSTACK_AUTO_APPROVE` in the Vite plugin overrides this either way.
	 *  Hard-clamped off on live `mainnet`, so a real-funds signature is never
	 *  granted without a human in the loop. */
	readonly autoApproveSigning?: boolean;
}

/** Every field resolved to a concrete boolean (no `undefined`). */
export type ResolvedNetworkOptions = Required<NetworkScopedOptions>;

/**
 * The default per-network policy: the dev wallet is ON for every network
 * EXCEPT live `mainnet`. Fork networks (`mainnet-fork`, …) are local dev
 * stacks, so they stay ON — only the real `mainnet` name opts out.
 *
 * `autoApproveSigning` defaults OFF on every network. A real app should
 * exercise the actual connect + approve UX, so `pnpm dev` shows the wallet
 * prompts rather than silently signing. Headless e2e opts back in via
 * `DEVSTACK_AUTO_APPROVE=1` (read in the Vite plugin ahead of this policy), and
 * an author can re-enable it for a specific network with a per-network
 * `autoApproveSigning: true` override. Live `mainnet` stays hard-clamped off in
 * {@link resolveNetworkOptions} regardless.
 */
export const defaultNetworkOptions = (network: string): ResolvedNetworkOptions => {
	const on = network !== 'mainnet';
	return { devWallet: on, autoApproveSigning: false };
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
	//   - `devWallet` — documenting intent to inject a test-only signer
	//     against a real network.
	//   - `autoApproveSigning` — auto-approving a real-funds signature with
	//     no human in the loop.
	// (The funding-faucet gate is NOT routed through here — it is a fixed
	// `network !== 'mainnet'` policy in the sui plugin, with no per-network
	// override surface; see the {@link NetworkScopedOptions} note.)
	if (network === 'mainnet') {
		return { devWallet: false, autoApproveSigning: false };
	}
	return {
		devWallet: asBool(o['devWallet']) ?? base.devWallet,
		autoApproveSigning: asBool(o['autoApproveSigning']) ?? base.autoApproveSigning,
	};
};
