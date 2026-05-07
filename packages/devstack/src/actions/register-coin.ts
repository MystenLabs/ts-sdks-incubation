// `registerCoin()` — Follow-on action that registers a coin token in
// the `coin.tokens` registry namespace after its Move package is
// published. Replaces the per-package `onPublished` callbacks that
// every example app duplicated (token-studio, wallet × 2).
//
// The factory needs the publish action's name (to wire `needs:` and to
// look up the package in the registry) plus the Move module + type
// path that hosts the `Coin<T>` type — exactly what an `onPublished`
// callback computed inline.

import type { Provides, SeedAction } from '../core/types.js';
import { coinTokens } from '../coin.js';
import { seed } from './seed.js';

interface RegisterCoinOptions<TFrom extends string, TName extends string> {
	/** Name to register under in the `coin.tokens` namespace (used by
	 * `coinTokens(registry).find(name)` and by the codegen-emitted
	 * manifest). Defaults to the package name (`from`). */
	name?: TName;
	/** Name of the upstream `publishMove({ name })` action that publishes
	 * the package containing the coin. Used as the `needs:` reference and
	 * to look up the `packageId` at run time. */
	from: TFrom;
	/** Move module name within the package (e.g. `'managed_coin'`). */
	module: string;
	/** Coin type symbol within the module (e.g. `'MANAGED_COIN'`). */
	type: string;
	/** Coin decimals (e.g. 6 for USDC-shaped, 9 for SUI-shaped). */
	decimals: number;
	/** Optional capabilities to advertise. Most callers leave undefined. */
	provides?: Provides;
}

/** Phantom-typed return shape: see `publish-move.ts` `WithNeeds`. */
type WithNeeds<TNeeds extends string, T> = T & { readonly __needs?: TNeeds };

/**
 * Register a published Move coin in the `coin.tokens` registry kind.
 * Runs as a Seed action — completes on cache hit when the registered
 * `type` matches the upstream package's current `packageId`. Apps
 * place this in their `use:` array right after the matching
 * `publishMove({...})`.
 */
export function registerCoin<const TFrom extends string, const TName extends string = TFrom>(
	opts: RegisterCoinOptions<TFrom, TName>,
): WithNeeds<TFrom, SeedAction<{ from: TFrom; module: string; type: string; decimals: number }>> {
	const registryName = opts.name ?? opts.from;
	const action = seed({
		name: `register-${opts.from}`,
		needs: [opts.from],
		provides: {
			...(opts.provides ?? {}),
			registry: (ctx) => {
				const pkg = ctx.registry.packages.find(opts.from);
				if (pkg === undefined) return;
				const existing = coinTokens(ctx.registry).find(registryName);
				if (existing !== undefined) coinTokens(ctx.registry).register(existing);
			},
		},
		inputs: {
			from: opts.from,
			module: opts.module,
			type: opts.type,
			decimals: opts.decimals,
		},
		run: async (ctx) => {
			const pkg = ctx.registry.packages.require(opts.from);
			coinTokens(ctx.registry).register({
				name: registryName,
				type: `${pkg.packageId}::${opts.module}::${opts.type}`,
				decimals: opts.decimals,
			});
		},
	});
	return action as WithNeeds<
		TFrom,
		SeedAction<{ from: TFrom; module: string; type: string; decimals: number }>
	>;
}
