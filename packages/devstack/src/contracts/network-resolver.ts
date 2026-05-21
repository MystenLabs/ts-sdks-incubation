// NetworkResolver capability contract (architecture §5).
//
// Provides one consistent answer to "what network am I on?" for
// every plugin. The resolver is consulted once per acquire; the
// answer is threaded as Context.
//
// Funds-ready is NOT engine-generic. It's a typed StrategyContributor
// capability key (`gate:funds-ready`); plugins that need to wait on
// funds read from the strategy registry. Architecture explicitly
// removed the previous "L0 exposes awaitFunds" wording.

import type { Effect } from 'effect';

import type { NetworkConfig } from '../substrate/network.ts';

/** Capability-key constant for the funds-ready gate strategy. */
export const FUNDS_READY_GATE_KEY = 'gate:funds-ready' as const;

/** The funds-ready strategy shape. A trivially-succeeding default
 *  is registered when no contributor is present (e.g. live mode). */
export interface FundsReadyStrategy {
	readonly waitFundsReady: Effect.Effect<void, FundsReadyError>;
}

export interface FundsReadyError {
	readonly _tag: 'FundsReadyError';
	readonly reason: string;
}

/**
 * The substrate-facing resolver service. One resolution per
 * acquire; CLI > env > config > default precedence.
 */
export interface NetworkResolver {
	readonly resolve: Effect.Effect<NetworkConfig, NetworkResolutionError>;
}

export interface NetworkResolutionError {
	readonly _tag: 'NetworkResolutionError';
	readonly reason: 'invalid-mode' | 'unknown-chain' | 'rpc-unreachable';
	readonly detail: string;
}
