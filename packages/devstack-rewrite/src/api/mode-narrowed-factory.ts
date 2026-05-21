// Mode-narrowed factory helper.
//
// Architecture Tension 11 + type-prototype finding #4: a plugin's
// factories are exposed as an object indexed by `NetworkMode`. When a
// stack passes a typed-narrow network through `defineDevstackWith`, the
// callback receives a namespace whose accessible properties are exactly
// those present in the network's mode branch. Asking for the wrong
// branch is a compile error at the call site.
//
// Two surfaces:
//
//   - `forNetwork(network, factoriesPerMode)` — runtime returns the
//     full factories record; the type system narrows to the matching
//     branch via `as FactoriesFor<Mode>`.
//   - `defineModeNamespace({ local, live, fork })` — plugin authors
//     declare their per-mode factories once; the helper hands back a
//     `for(network)` accessor that does the narrowing.

import type { NetworkConfig, NetworkMode } from '../substrate/network.ts';

/** A factories record keyed by network mode. Each branch is an
 *  arbitrary record of factory functions. */
export type FactoriesByMode<F extends Partial<Record<NetworkMode, unknown>>> = F;

/** Project the factories record to the branch that matches a network's
 *  mode. Branches that aren't present collapse to `never`, which makes
 *  the property access fail at compile time. */
export type FactoriesFor<
	F extends Partial<Record<NetworkMode, unknown>>,
	Mode extends NetworkMode,
> = Mode extends keyof F ? F[Mode] : never;

/**
 * Plugin-author entry point. Pass a per-mode factories record; receive
 * a `for(network)` accessor. The returned accessor's value type is
 * narrowed to the matching mode branch — illegal-mode property access
 * is a compile error.
 *
 * Two casts here are the boundary between runtime breadth and type-level
 * narrowness (type-prototype results §"Where I had to use any/casts"):
 *  - The runtime returns the full factories record.
 *  - The type system projects it down to the matching branch.
 */
export interface ModeNamespace<F extends Partial<Record<NetworkMode, unknown>>> {
	readonly for: <N extends NetworkConfig>(network: N) => FactoriesFor<F, N['mode']>;
}

export function defineModeNamespace<F extends Partial<Record<NetworkMode, unknown>>>(
	factoriesPerMode: F,
): ModeNamespace<F> {
	return {
		for: <N extends NetworkConfig>(network: N) =>
			factoriesPerMode[network.mode as keyof F] as FactoriesFor<F, N['mode']>,
	};
}

/** Direct, single-call form. The callback form of `defineDevstack`
 *  passes the resolved network; this helper threads it into a
 *  per-mode factories record without the indirection of a namespace. */
export function forNetwork<
	F extends Partial<Record<NetworkMode, unknown>>,
	N extends NetworkConfig,
>(network: N, factoriesPerMode: F): FactoriesFor<F, N['mode']> {
	return factoriesPerMode[network.mode as keyof F] as FactoriesFor<F, N['mode']>;
}
