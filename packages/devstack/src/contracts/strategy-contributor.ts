// StrategyContributor capability contract (architecture §7).
//
// The faucet pattern generalized. Plugins contribute to a sibling's
// capability-keyed registry without an explicit dep-graph edge.
//
// Capability keys are strings of the form `<domain>:<discriminator>`
// (e.g. `coinType:WAL`, `chain-probe:sui:mainnet`). The substrate
// treats them opaquely; orchestrators dispatch on them by string
// equality.

import type { Effect, Scope } from 'effect';

import type { StrategyNotFoundError } from '../substrate/runtime/errors.ts';

/**
 * Contribution declaration. `Key` is the literal capability key
 * (preserved as a string-literal type so consumers picking by key
 * recover the strategy's value shape). `Strategy` is the closed-over
 * value (already-bound dependencies; dispatch site is
 * context-free).
 */
export interface StrategyContributorDecl<Key extends string = string, Strategy = unknown> {
	readonly kind: 'strategy-contributor';
	readonly capabilityKey: Key;
	readonly strategy: Strategy;
	/** Auto-mounted contributors are hidden from renderer rows by
	 *  default. User-supplied contributors are visible. */
	readonly autoMounted: boolean;
	/** Optional priority — last-write-wins on tie. */
	readonly priority?: number;
}

/** Type-level extraction of strategy by capability key from a
 *  member's caps tuple. */
export type StrategyFor<Caps extends ReadonlyArray<unknown>, Key extends string> =
	Extract<Caps[number], StrategyContributorDecl<Key, unknown>> extends StrategyContributorDecl<
		Key,
		infer S
	>
		? S
		: never;

/**
 * Substrate-facing dispatcher view. Consumers ask the registry by
 * capability key; the substrate returns the registered strategy or
 * a structured error listing registered keys.
 */
export interface StrategyRegistry {
	readonly get: <Key extends string, S>(key: Key) => Effect.Effect<S, StrategyNotFoundError>;
	readonly list: () => Effect.Effect<ReadonlyArray<string>>;
	readonly register: <Key extends string, S>(
		key: Key,
		strategy: S,
		options?: { readonly autoMounted?: boolean; readonly priority?: number },
	) => Effect.Effect<void, never, Scope.Scope>;
}
