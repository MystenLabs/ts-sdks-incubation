// `defineDevstackWith` — callback form.
//
// Architecture § Programmable API: the canonical surface when one or
// more plugin factories need mode-narrowing. The callback receives a
// `BuildCtx` whose `network` is the resolved-narrow `NetworkConfig`;
// plugin-author factories that take `(network)` recover the mode
// discriminator structurally, and the compiler refuses illegal-mode
// factory access at the call site.

import { isPlugin, type AnyPlugin } from '../substrate/plugin.ts';
import type { DevstackOptions } from '../substrate/options.ts';
import type { NetworkScopedOptions } from '../orchestrators/network-options.ts';
import type { DevstackNetworkName } from './inference-network.ts';
import type { NetworkConfig, NetworkMode } from '../plugins/sui/network-config.ts';
import type { __MissingProvidersError, MissingProviders } from '../substrate/plugin.ts';
import { defineDevstack, type ComposedMembers, type Stack } from './define-devstack.ts';

// --- Callback context ---------------------------------------------------

/**
 * Build context handed to the callback. The `network` field carries
 * the resolved-narrow `NetworkConfig`; mode-narrowed factories that
 * take `(network)` recover the discriminator at the type level.
 */
export interface BuildCtx<Mode extends NetworkMode> {
	readonly network: NetworkConfig<Mode>;
}

/** Options bag for the callback form. `network` MUST be present so the
 *  callback's `BuildCtx` is typed. */
export interface DevstackOptionsWith<Mode extends NetworkMode> extends DevstackOptions {
	readonly network: NetworkConfig<Mode>;
	/** Per-network feature toggles, with keys narrowed to the canonical
	 *  `DevstackNetworkName`s (autocomplete + typo-catching). Same shape as
	 *  the flat-form `DevstackOptions.networkOptions`. */
	readonly networkOptions?: Partial<Record<DevstackNetworkName, NetworkScopedOptions>>;
}

/** Validation gate. Mirrors the flat-form rule: resolves to the
 *  caller's `Members` tuple on a clean check, branded error
 *  otherwise.
 *
 *  Validation runs against the recursively expanded tuple
 *  (`ComposedMembers<Members>`) so plugin-valued dependencies are
 *  included before missing-provider checks. Bare resource dependencies
 *  still require an explicit provider in the returned member tuple. */
type ValidateBuild<Members> =
	Members extends ReadonlyArray<AnyPlugin>
		? ComposedMembers<Members> extends infer M
			? M extends ReadonlyArray<unknown>
				? [MissingProviders<M>] extends [never]
					? Members
					: __MissingProvidersError<MissingProviders<M>>
				: never
			: never
		: never;

// --- Public surface -----------------------------------------------------

/**
 * Callback-form devstack composer. The first arg is the options bag
 * (including the mode-narrow `network`); the second is a builder that
 * receives a `BuildCtx<Mode>` and returns the member tuple.
 *
 * The `Mode` generic is inferred from `options.network.mode`; the
 * callback's `BuildCtx` carries it, and plugin factories that accept
 * the narrowed network see the matching branch only.
 */
export function defineDevstackWith<
	Mode extends NetworkMode,
	Members extends ReadonlyArray<AnyPlugin>,
>(
	options: DevstackOptionsWith<Mode>,
	build: (ctx: BuildCtx<Mode>) => ValidateBuild<Members>,
): Stack<ComposedMembers<Members>> {
	const rawMembers = build({ network: options.network }) as ReadonlyArray<AnyPlugin>;

	// Defensive runtime check: every element returned by the builder
	// must be a plugin resource. Type system enforces this, but a
	// runtime check guards against `as unknown as AnyPlugin` casts.
	for (const m of rawMembers) {
		if (!isPlugin(m)) {
			throw new Error(
				'defineDevstackWith: builder returned a value that is not a plugin member ' +
					'(missing plugin brand). Did you forget to wrap it with definePlugin?',
			);
		}
	}

	return defineDevstack({ ...options, members: rawMembers }) as unknown as Stack<
		ComposedMembers<Members>
	>;
}
