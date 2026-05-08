// `registerCoin()` — Follow-on action that registers a coin token in
// the `coin.tokens` registry namespace after its Move package is
// published. Consolidates per-package coin-registration logic that
// would otherwise be duplicated across every example (token-studio,
// wallet × 2).
//
// The factory needs two references to the upstream publish:
//
//   - `from:`     — the `publishMove({ name })` action name. Used to
//                   wire the `needs:` edge (so this Seed runs after
//                   the publish has succeeded).
//   - `package?:` — the registry key the publish registered under
//                   (`registryAs ?? name` on `publishMove`). Used to
//                   look up the `packageId` at run time. Defaults to
//                   `from` for the common case where the publish
//                   doesn't override `registryAs`.
//
// Plus the Move module + type path that hosts the `Coin<T>` type.

import type { Package, Provides, SeedAction } from '../core/types.js';
import { coinTokens } from '../registry/coin.js';
import { seed } from './seed.js';
import type { WithNeeds } from './with-needs.js';

interface RegisterCoinOptions<
	TFrom extends string,
	TName extends string,
	TPackage extends string,
> {
	/** Name to register under in the `coin.tokens` namespace (used by
	 * `coinTokens(registry).find(name)` and by the codegen-emitted
	 * manifest). Defaults to the upstream publish action's name (`from`). */
	name?: TName;
	/**
	 * `publishMove({ name })` action name to depend on. Wires the
	 * `needs:` edge and is the default for `package` (when the publish
	 * doesn't set `registryAs`). Use `package` to override the
	 * registry-lookup key without changing the dependency edge.
	 */
	from: TFrom;
	/**
	 * Registry key the upstream publish registered the package under.
	 * Defaults to `from`. Override when the upstream `publishMove` sets
	 * `registryAs` to a value different from `name` — without this
	 * override, the run callback's `ctx.registry.packages.require(...)`
	 * would search for the wrong key and throw at run time.
	 *
	 *   publishMove({ name: 'usdc', registryAs: 'mock_usdc', ... })
	 *   registerCoin({ from: 'usdc', package: 'mock_usdc', ... })
	 *
	 * `defineDevstackConfig` cross-validates this literal against the
	 * union of `__publishesRegistryAs` literals on sibling
	 * `publishMove` returns — a typo (`package: 'mock_typo'` against
	 * `publishMove({ registryAs: 'mock_usdc' })`) surfaces at the
	 * `defineDevstackConfig({ use: [...] })` call site.
	 */
	package?: TPackage;
	/** Move module name within the package (e.g. `'managed_coin'`). */
	module: string;
	/** Coin type symbol within the module (e.g. `'MANAGED_COIN'`). */
	type: string;
	/** Coin decimals (e.g. 6 for USDC-shaped, 9 for SUI-shaped). */
	decimals: number;
	/** Optional capabilities to advertise. Most callers leave undefined. */
	provides?: Provides;
}

/**
 * Phantom marker on the returned action carrying the `from:` literal.
 * `defineDevstackConfig` extracts the union of these from `use:[]` and
 * validates against the union of `__publishesPackage` literals (set by
 * `publishMove({ name, registryAs })`); a typo on the `from:` field
 * surfaces at the `defineDevstackConfig` call site rather than at
 * runtime as a "no entry named 'usd'"-style error after the cycle
 * has already started running. Carries no runtime cost.
 */
type RegistersFrom<TFrom extends string, T> = T & { readonly __registerCoinFrom?: TFrom };

/**
 * Phantom marker on the returned action carrying the `package:` literal
 * (the registry key the upstream publish registered under, equivalent
 * to `publishMove({ registryAs })`). `defineDevstackConfig` extracts
 * the union of these from `use:[]` and validates against the union of
 * `__publishesRegistryAs` literals on sibling `publishMove` returns —
 * a typo (`package: 'mock_typo'`) surfaces at the
 * `defineDevstackConfig({ use: [...] })` call site rather than at
 * runtime as a "no entry named 'mock_typo'"-style error from
 * `ctx.registry.packages.require`. Carries no runtime cost.
 *
 * `never` (the `TPackage extends never` case — i.e. the user didn't
 * pass `package:` and the seed defaults to `from`) drops out of the
 * extracted union and contributes no constraint.
 */
type RegistersPackage<TPackage extends string, T> = T & {
	readonly __registerCoinPackage?: TPackage;
};

/**
 * Register a published Move coin in the `coin.tokens` registry kind.
 * Runs as a Seed action — completes on cache hit when the registered
 * `type` matches the upstream package's current `packageId`. Apps
 * place this in their `use:` array right after the matching
 * `publishMove({...})`.
 */
export function registerCoin<
	const TFrom extends string,
	const TName extends string = TFrom,
	const TPackage extends string = never,
>(
	opts: RegisterCoinOptions<TFrom, TName, TPackage>,
): WithNeeds<
	TFrom,
	RegistersFrom<
		TFrom,
		RegistersPackage<
			TPackage,
			SeedAction<{ from: TFrom; module: string; type: string; decimals: number }>
		>
	>
> {
	const registryName = opts.name ?? opts.from;
	const packageKey = opts.package ?? opts.from;
	const action = seed({
		name: `register-${opts.from}`,
		needs: [opts.from],
		provides: {
			...(opts.provides ?? {}),
			registry: (ctx) => {
				const pkg = ctx.registry.packages.find(packageKey);
				if (pkg === undefined) return;
				const existing = coinTokens(ctx.registry).find(registryName);
				if (existing !== undefined) coinTokens(ctx.registry).register(existing);
			},
		},
		inputs: {
			from: opts.from,
			package: packageKey,
			module: opts.module,
			type: opts.type,
			decimals: opts.decimals,
		},
		run: async (ctx) => {
			// `packageKey` is a string (`opts.package ?? opts.from`); when
			// `opts.package` is set it's a free-form name from a user
			// `publishMove({ registryAs })` and need not be a member of
			// the local `TFrom` literal union. The seed's typed-ctx
			// `require` is constrained to `TFrom`; cast at the boundary
			// (find/require on a missing key still throws clearly at
			// runtime, and the type-safety target here is sibling
			// `runTransaction`/`seed` callbacks, not internal plumbing).
			//
			// Wrap require in try/catch so a missing entry surfaces with
			// the originating action context — without this, the bare
			// `Registry: packages has no entry named 'X'` error gives no
			// hint that the upstream `publishMove` is the thing that
			// needs wiring into `use:[]`.
			let pkg: Package;
			try {
				pkg = ctx.registry.packages.require(packageKey as TFrom);
			} catch (err) {
				throw new Error(
					`registerCoin('${opts.from}'): looking up registered package '${packageKey}' but not found — ` +
						`is the upstream publishMove({ name: '${opts.from}'${packageKey !== opts.from ? `, registryAs: '${packageKey}'` : ''} }) wired into use:[]?`,
					{ cause: err },
				);
			}
			coinTokens(ctx.registry).register({
				name: registryName,
				type: `${pkg.packageId}::${opts.module}::${opts.type}`,
				decimals: opts.decimals,
			});
		},
	});
	return action as WithNeeds<
		TFrom,
		RegistersFrom<
			TFrom,
			RegistersPackage<
				TPackage,
				SeedAction<{ from: TFrom; module: string; type: string; decimals: number }>
			>
		>
	>;
}
