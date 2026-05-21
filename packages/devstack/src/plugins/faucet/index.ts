// Faucet plugin — barrel + factories + author-side helpers.
//
// Architecture (distilled doc §Outputs):
//   - The plugin's identity tag's resolved value is the dispatcher.
//   - The plugin emits ONE capability decl — a
//     `StrategyContributor` for `faucet:dispatch`, marking this
//     plugin as the dispatch facade. Other plugins' faucet-strategy
//     contributions register against the same registry; they target
//     `faucet:request:<chainId>` capability keys, NOT this one.
//   - No Codegenable contribution: the dispatcher is dev-only
//     plumbing; user app code reads dispatcher via the plugin's tag.
//     (Open question §Open questions #1 in the distilled doc — if a
//     codegen helper lands later, this is the seam.)
//
// Tag value: the resolved value of `FaucetTag` is `FaucetService`
// (carries `dispatcher`). Consumers (Account, Coin, Wallet) yield
// the tag and call `service.dispatcher.request(...)`.
//
// Author-side helper: `defineFaucetStrategy(...)` packages a
// `{ chainId, strategy }` pair into a `StrategyContributorDecl` so
// third-party plugins can contribute strategies declaratively. The
// helper threads the literal `chainId` through the type so the
// downstream consumer's `StrategyFor<...>` lookup recovers the
// strategy's shape.

import { Effect } from 'effect';

import { capabilities } from '../../api/define-capabilities.ts';
import { defineNodePlugin } from '../../api/define-plugin.ts';
import { defineTag } from '../../api/tag.ts';
import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import {
	FAUCET_CAPABILITY_KEY_PREFIX,
	faucetCapabilityKey,
	type FaucetDispatcher,
} from './dispatcher.ts';
import { FAUCET_ERROR_TAGS } from './errors.ts';
import { acquireFaucetService, type FaucetService, type FaucetServiceOptions } from './service.ts';
import type { FaucetStrategy } from './strategies/sui-local.ts';

// ---------------------------------------------------------------------------
// Tag — the resolved value consumers read
// ---------------------------------------------------------------------------

/** The faucet plugin's identity tag. */
export const FaucetTag = defineTag<'faucet', FaucetService>('faucet', 'faucet');

// ---------------------------------------------------------------------------
// Capability-key constant — the dispatcher-marker key.
// ---------------------------------------------------------------------------

/** Plugin-level capability key marking this plugin as the dispatcher
 *  facade. NOT the same as the per-chain `faucet:request:<chainId>`
 *  keys strategies register under. */
export const FAUCET_DISPATCH_KEY = 'faucet:dispatch' as const;

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Construct the faucet plugin. Auto-mounted by the orchestrator on
 * every stack (architecture: hidden when auto-mounted, visible when
 * user-supplied).
 *
 * Architecture: the Sui→Faucet built-in auto-registration runs on
 * the SUI side — Sui's acquire body yields the
 * `StrategyRegistryService` and registers its own
 * `faucet:request:<chainId>` strategy at acquire time, keyed by the
 * resolved chain id. The faucet plugin itself only knows about the
 * dispatcher facade + the caller-supplied contributions.
 */
export const faucet = (opts: FaucetServiceOptions = {}) => {
	// The capability decl is a single dispatcher-marker — useful for
	// renderers that want to enumerate "this stack has a faucet
	// dispatcher" without inspecting every per-chain key. The
	// strategy value is the dispatcher itself, closed over the
	// resolved service.
	const dispatchContribution: StrategyContributorDecl<
		typeof FAUCET_DISPATCH_KEY,
		// Phantom: actual dispatcher comes from `acquire`'s resolved
		// value; this decl is a marker only.
		{ readonly _kind: 'dispatcher' }
	> = {
		kind: 'strategy-contributor',
		capabilityKey: FAUCET_DISPATCH_KEY,
		strategy: { _kind: 'dispatcher' as const },
		autoMounted: true,
	};

	return defineNodePlugin({
		provides: FaucetTag,
		// Architecture: faucet is a LEAF — it declares NO upstream
		// dep on Sui. Sui-strategy auto-registration runs OUT-OF-BAND
		// (Sui contributes its own `faucet:request:<chainId>` strategy
		// via the StrategyContributor capability mechanism when its
		// mode has a faucet URL). The faucet plugin's body therefore
		// just builds the dispatcher closure over the registry.
		consumes: [] as const,
		kind: 'leaf-long-running',
		rebootCost: 'cheap',
		acquire: () =>
			Effect.gen(function* () {
				return yield* acquireFaucetService(opts);
			}),
		errorContributions: [{ _tag: 'PluginErrorContribution', errorTags: FAUCET_ERROR_TAGS }],
		capabilities: capabilities(dispatchContribution),
	});
};

// ---------------------------------------------------------------------------
// Author-side: helper for third-party strategy contributions.
// ---------------------------------------------------------------------------

/**
 * Build a `StrategyContributorDecl` for a faucet request strategy.
 * Use from a sibling plugin's `capabilities(...)` tuple so the
 * substrate auto-registers the strategy as the plugin acquires:
 *
 * ```ts
 * defineNodePlugin({
 *   ...,
 *   capabilities: capabilities(
 *     defineFaucetStrategy({
 *       chainId: 'sui:my-net',
 *       strategy: makeMyFaucetStrategy(opts),
 *     }),
 *   ),
 * });
 * ```
 *
 * The capability key is computed from the chain id so the dispatcher
 * picks the contribution up automatically — no extra wiring on the
 * faucet-plugin side.
 *
 * `autoMounted` defaults to `false` (third-party contributions show
 * up in the dashboard). Pass `autoMounted: true` for built-ins that
 * the orchestrator includes automatically.
 */
export function defineFaucetStrategy<ChainId extends string>(decl: {
	readonly chainId: ChainId;
	readonly strategy: FaucetStrategy;
	readonly autoMounted?: boolean;
	readonly priority?: number;
}): StrategyContributorDecl<`${typeof FAUCET_CAPABILITY_KEY_PREFIX}:${ChainId}`, FaucetStrategy> {
	return {
		kind: 'strategy-contributor',
		capabilityKey: faucetCapabilityKey(decl.chainId),
		strategy: decl.strategy,
		autoMounted: decl.autoMounted ?? false,
		...(decl.priority !== undefined ? { priority: decl.priority } : {}),
	};
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { FaucetService, FaucetServiceOptions, FaucetStrategyContribution } from './service.ts';
export type { FaucetRequest } from './dispatcher.ts';
export { FAUCET_CAPABILITY_KEY_PREFIX, faucetCapabilityKey };
export type { FaucetDispatcher };
export type {
	FaucetError,
	FaucetUnreachable,
	FaucetExhausted,
	FaucetBodyError,
	FaucetStrategyMissing,
} from './errors.ts';
export { FAUCET_ERROR_TAGS } from './errors.ts';
export type { FaucetStrategy, SuiLocalStrategyOptions } from './strategies/sui-local.ts';
export { suiLocalStrategy } from './strategies/sui-local.ts';
export type { SuiLiveStrategyOptions, SuiLiveNetwork } from './strategies/sui-live.ts';
export { suiLiveStrategy, LIVE_FAUCET_URLS } from './strategies/sui-live.ts';
export {
	requestFundsOnce,
	requestFundsWithRetry,
	DEFAULT_FETCH_DEADLINE_MS,
	DEFAULT_INITIAL_DELAY_MS,
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_TIMEOUT_MS,
	BACKOFF_FACTOR,
	type FaucetPostOptions,
	type RetryOptions,
} from './http.ts';
