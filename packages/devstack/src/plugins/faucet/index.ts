// Faucet plugin — barrel + factories + author-side helpers.
//
// Architecture (distilled doc §Outputs):
//   - The plugin's resource's resolved value is the dispatcher.
//   - The plugin emits one `StrategyContributor` per caller-supplied
//     faucet strategy. Built-in strategies are emitted by the plugin
//     that owns the discovered endpoint, such as Sui local mode.
//   - No Codegenable contribution: the dispatcher is dev-only
//     plumbing; user app code reads dispatcher via the plugin resource.
//     (Open question §Open questions #1 in the distilled doc — if a
//     codegen helper lands later, this is the seam.)
//
// Resource value: the resolved value of the faucet plugin is
// `FaucetService` (carries `dispatcher`).
//
// Author-side helper: `defineFaucetStrategy(...)` packages a
// `{ chainId, strategy }` pair into a `StrategyContributorDecl` so
// third-party plugins can contribute strategies declaratively. The
// helper threads the literal `chainId` through the type so the
// downstream consumer's `StrategyFor<...>` lookup recovers the
// strategy's shape.

import { Effect } from 'effect';

import { definePlugin, resource } from '../../api/define-plugin.ts';
import { pluginErrorContributions } from '../../api/plugin-errors.ts';
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
// Resource identity
// ---------------------------------------------------------------------------

/** The faucet plugin's resource identity. */
const faucetResource = resource<'faucet', FaucetService>('faucet');
const faucetErrorContributions = pluginErrorContributions(FAUCET_ERROR_TAGS);

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Construct the faucet plugin. Compose `faucet()` when you need the
 * dispatcher facade or caller-supplied strategy contributions.
 */
export const faucet = (opts: FaucetServiceOptions = {}) => {
	const strategyContributions = (opts.strategies ?? []).map((contribution) =>
		defineFaucetStrategy({
			chainId: contribution.chainId,
			strategy: contribution.strategy,
			priority: contribution.priority ?? 1,
		}),
	);

	return definePlugin({
		id: faucetResource.id,
		// Faucet is a leaf: it has no Sui dependency. Sui contributes
		// its own `faucet:request:<chainId>` strategy when its resolved
		// mode exposes a faucet URL.
		kind: 'leaf-long-running',
		rebootCost: 'cheap',
		start: () =>
			Effect.gen(function* () {
				return yield* acquireFaucetService(opts);
			}),
		errorContributions: faucetErrorContributions,
		capabilities: strategyContributions,
	});
};

// ---------------------------------------------------------------------------
// Author-side: helper for third-party strategy contributions.
// ---------------------------------------------------------------------------

/**
 * Build a `StrategyContributorDecl` for a faucet request strategy.
 * Use from a sibling plugin's `capabilities` array so the
 * substrate auto-registers the strategy as the plugin acquires:
 *
 * ```ts
 * definePlugin({
 *   id: 'my-faucet-strategy',
 *   kind: 'leaf-long-running',
 *   start: () => Effect.succeed({}),
 *   capabilities: [
 *     defineFaucetStrategy({
 *       chainId: 'sui:my-net',
 *       strategy: makeMyFaucetStrategy(opts),
 *     }),
 *   ],
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
	FaucetConfigError,
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
