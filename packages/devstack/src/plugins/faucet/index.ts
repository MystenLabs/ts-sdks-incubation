// Faucet plugin-author helpers.
//
// Author-side helper: `defineFaucetStrategy(...)` packages a
// `{ chainId, strategy }` pair into a `StrategyContributorDecl` so
// third-party plugins can contribute strategies declaratively. The
// helper threads the literal `chainId` through the type so the
// downstream consumer's `StrategyFor<...>` lookup recovers the
// strategy's shape. Built-in account funding reads the strategy
// registry directly; there is no public `faucet()` stack member.

import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import { FAUCET_CAPABILITY_KEY_PREFIX, faucetCapabilityKey } from './dispatcher.ts';
import type { FaucetStrategy } from './strategies/sui-local.ts';

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
 *   role: 'service',
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
// Public types
// ---------------------------------------------------------------------------

/** A registered strategy contribution. Plugin authors that batch
 *  multiple per-chain strategies (custom fork admins, alt-network
 *  faucets) shape their config arrays around this; the underlying
 *  registration mechanic is `defineFaucetStrategy`. */
export interface FaucetStrategyContribution {
	/** Capability-key chain id (`'sui:localnet'`, `'sui:testnet'`, etc.). */
	readonly chainId: string;
	/** The strategy value — closes over its own dependencies. */
	readonly strategy: FaucetStrategy;
	/** Optional priority. Defaults to `1` so user strategies win over
	 *  the built-in's `0`. */
	readonly priority?: number;
}

export type {
	FaucetError,
	FaucetUnreachable,
	FaucetExhausted,
	FaucetBodyError,
	FaucetConfigError,
} from './errors.ts';
export type { FaucetStrategy } from './strategies/sui-local.ts';
