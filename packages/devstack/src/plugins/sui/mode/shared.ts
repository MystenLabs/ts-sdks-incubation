// Shared shapes across mode builders.
//
// `SuiClient` is the resolved-value the plugin's `provides` tag
// publishes — every consumer (Account, Coin, Wallet, Faucet,
// Package, Codegen, Walrus/Seal/Deepbook fork variants) reads
// THIS shape.
//
// Why one shape: distilled-doc finding — Sui's factory + builder
// file is ~2000 LOC because the four per-network builders share
// boilerplate (publish endpoints + fetch chain id + publish state)
// but their bodies diverge in mode-specific ways. The redesign
// bakes the seam in: the resolved value is uniform, the boot path
// is mode-specific, and the admin surfaces narrow at the type
// level (fork has `Sui.fork.advanceClock`; live does not).

import { Effect } from 'effect';

import type { SuiPluginError } from '../errors.ts';
import type { SuiSdkShim } from '../chain-probe.ts';
import type { ChainProbe } from '../../../contracts/chain-probe.ts';
import type { ImageRef } from '../../../contracts/container-runtime.ts';
import type { SuiProbeKey } from '../chain-probe.ts';
import type { ChainId } from '../../../substrate/brand.ts';

/** Funds-ready strategy contributed by Sui. Mode-aware:
 *
 *   - local container — first call POSTs a real funding tx against
 *     the faucet, retrying on body-level {Failure} during the
 *     post-RPC / pre-fund window. Memoised after first success.
 *   - external w/ faucet — same as local container.
 *   - live testnet — same, but no retry needed (the public faucet
 *     is rate-limited differently).
 *   - live mainnet / faucet-less — trivially-succeeding no-op.
 *     (Architecture: "no-faucet network has a trivially-succeeding
 *     funds-ready gate" is a first-class property of the mode.)
 *   - fork — trivially-succeeding (impersonation funds, not
 *     faucet).
 *
 *  Distilled-doc opportunity: `Effect.cached` caches the first-call
 *  failure for the whole scope; add a manual-invalidation surface
 *  so a fork restart can re-probe. The shape below leaves room for
 *  that knob. */
export interface WaitForTransactionsReady {
	readonly wait: Effect.Effect<void, SuiPluginError>;
	/** Manual invalidation — clears the memoised result. The default
	 *  built-in invalidates on plugin restart; this surface lets
	 *  long-running supervisors invalidate without a full restart. */
	readonly invalidate: Effect.Effect<void>;
}

/** Fork admin surface — mode-narrowed. Only the fork-mode factory's
 *  resolved value carries this; local/local-rpc/live values have a
 *  type-level `null`.
 *
 *  Distilled-doc opportunity: today's `Fiber` handle is discarded
 *  at the auto-tick call site; the `autoTickHandle` field below
 *  preserves it for a future cadence-change surface. */
export interface ForkAdminSurface {
	readonly status: Effect.Effect<
		{ readonly checkpoint: string; readonly clock: number },
		SuiPluginError
	>;
	readonly advanceClock: (intervalMs: number) => Effect.Effect<void, SuiPluginError>;
	readonly advanceCheckpoint: Effect.Effect<void, SuiPluginError>;
	readonly impersonate: (
		sender: string,
		tx: unknown,
		opts?: { readonly gasBudget?: bigint },
	) => Effect.Effect<{ readonly digest: string; readonly success: boolean }, SuiPluginError>;
}

/** The resolved value Sui publishes via its resource id. */
export interface SuiClient {
	/** The SDK shim. Fork mode wraps this with the property-access
	 *  blocklist (`fork-orchestration.wrapWithForkGuard`). */
	readonly sdk: SuiSdkShim;
	/** Host-reachable RPC URL for this resolved network. Local mode
	 *  surfaces the router-fronted URL; direct boot/probe ports are
	 *  available through `hostGateway` for sibling containers. */
	readonly rpcUrl: string;
	/** Host-reachable faucet base URL when this network has a faucet. */
	readonly faucetUrl: string | null;
	/** Faucet URL used by account funding strategies. Local mode keeps
	 *  this on the direct validator port used by the funds-ready gate. */
	readonly fundingFaucetUrl: string | null;
	/** Host-reachable GraphQL URL when the mode exposes one. */
	readonly graphqlUrl: string | null;
	/** Container-reachable mirrors of the host URLs. Loopback hosts are
	 *  rewritten to `host.docker.internal`; public URLs pass through. */
	readonly hostGateway: {
		readonly rpcUrl: string;
		readonly faucetUrl: string | null;
		readonly graphqlUrl: string | null;
	};
	/** Chain identity — downstream cache primitives fold this into
	 *  their state-store keys so on-chain artifacts re-derive when
	 *  the chain is wiped. Branded so consumers can hand it directly
	 *  to `chainProbeCapabilityKey(chain)` / `faucetCapabilityKey(chain)`
	 *  without a cast. */
	readonly chain: ChainId;
	/** Mode-aware funds-transferable gate; trivially-succeeding on
	 *  faucet-less networks. */
	readonly waitForTransactionsReady: WaitForTransactionsReady;
	/** Schema-validated read surface. Folded into every consumer's
	 *  context via `chain-probe:<chainId>` strategy lookup. */
	readonly chainProbe: ChainProbe<SuiProbeKey>;
	/** Fork-mode-only admin sub-surface. `null` for non-fork
	 *  modes; the mode-narrowed factory namespace narrows this at
	 *  the type level so consumers don't have to nullcheck. */
	readonly fork: ForkAdminSurface | null;
	/** Container image ref the Sui plugin built/pulled for its
	 *  validator. Surfaced so cross-service consumers (Package's
	 *  Move build, codegen's `summary` invocation) can spawn a
	 *  one-shot container running the SAME sui binary without
	 *  re-resolving the image. `null` for modes that have no
	 *  in-stack container (external + live). */
	readonly buildImage: ImageRef | null;
}

export const toDockerHostGatewayUrl = (url: string): string => {
	const parsed = new URL(url);
	if (
		parsed.hostname === '127.0.0.1' ||
		parsed.hostname === 'localhost' ||
		parsed.hostname === '0.0.0.0' ||
		parsed.hostname === '::1' ||
		parsed.hostname === '[::1]'
	) {
		parsed.hostname = 'host.docker.internal';
	}
	const rendered = parsed.toString();
	return parsed.pathname === '/' && parsed.search === '' && parsed.hash === ''
		? rendered.slice(0, -1)
		: rendered;
};
