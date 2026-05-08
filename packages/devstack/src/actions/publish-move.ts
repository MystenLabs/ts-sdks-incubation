// `publishMove()` — ergonomic factory for app-level Move package publishes.
//
// Thin wrapper over `publish()`. Use inside `DevstackConfig.use: [...]`:
//
//   use: [
//     sui(),
//     accounts(),
//     publishMove({
//       name: 'token-studio',
//       path: './move/token-studio',
//       capture: { admin: '::admin::AdminCap' },
//     }),
//   ],
//
// On `devstack up`, the package builds inside the sui localnet container
// (no host sui CLI required), publishes via the registered publisher
// account, and registers the result in `ctx.registry.packages` under the
// action name. Captured object IDs land in `pkg.captured`. Snapshots
// capture the published package via sui's container-layer commit;
// restore brings the package back at its same address.

import type { Provides, PublishAction } from '../core/types.js';
import { publish, type PublishInputs } from './publish.js';
import type { WithNeeds } from './with-needs.js';

interface PublishMoveOptions<
	TName extends string,
	TNeeds extends string,
	TPublisher extends string,
	TRegistryAs extends string,
> {
	name: TName;
	needs?: readonly TNeeds[];
	provides?: Provides;
	/** Move package source directory (relative to the app's `devstack.config.ts`). */
	path: string;
	/** Object-type filters to capture by name. See `publish()`'s `capture`
	 * for the filter syntax (suffix match; trailing `<` for generic types). */
	capture?: Record<string, string>;
	/** Account name that signs the publish. Defaults to `'publisher'`.
	 * `defineDevstackConfig` validates this against the declared
	 * `accounts:` union via a phantom marker on the returned action. */
	publisher?: TPublisher;
	/** Registry entry name. Defaults to `name`. The literal flows into
	 * downstream `ctx.registry.packages.find/require` typing via a
	 * phantom marker — sibling `runTransaction.build`/`seed.run`
	 * callbacks that name this `publishMove` (or its `registryAs`) in
	 * their `needs:` get autocomplete on the registry lookup name. */
	registryAs?: TRegistryAs;
}

/**
 * Phantom marker on the returned action carrying the `publisher`
 * literal. `defineDevstackConfig` extracts the union of these from
 * `use:[]` and validates against the declared `accounts:` so a typo
 * (`publisher: 'alic'` against `accounts: ['alice']`) surfaces at the
 * `defineDevstackConfig` call site. No runtime cost.
 */
type SignsAs<TPublisher extends string, T> = T & { readonly __signsAs?: TPublisher };

/**
 * Phantom marker on the returned action carrying the action's name
 * literal. Used by `registerCoin({ from })` validation in
 * `defineDevstackConfig` — `from` references the action by name (the
 * `publishMove({ name })` value), not the registry-key (`registryAs`).
 */
type PublishesPackage<TName extends string, T> = T & {
	readonly __publishesPackage?: TName;
};

/**
 * Phantom marker on the returned action carrying the registry-key
 * literal (`registryAs ?? name`). Used by `registerCoin({ package })`
 * validation in `defineDevstackConfig` — `package` references the
 * registry key the publish registered under, distinct from the
 * action-name carrier `__publishesPackage`. A typo on `package:`
 * surfaces at the `defineDevstackConfig` call site rather than at
 * runtime as a "no entry named '<typo>'"-style error from
 * `ctx.registry.packages.require`.
 */
type PublishesRegistryAs<TRegistryAs extends string, T> = T & {
	readonly __publishesRegistryAs?: TRegistryAs;
};

/**
 * Build, publish, and register a Move package. Sugar over the raw
 * `publish()` factory from `/authoring`. The published package lands
 * in `ctx.registry.packages` under `name` (or `registryAs`); captured
 * objects appear in `pkg.captured`.
 *
 * @example
 * ```ts
 * import { dirname, resolve } from 'node:path';
 * import { fileURLToPath } from 'node:url';
 * import { publishMove } from '@mysten-incubation/devstack';
 *
 * const HERE = dirname(fileURLToPath(import.meta.url));
 *
 * publishMove({
 *   name: 'hello',
 *   path: resolve(HERE, 'move/hello'),
 *   publisher: 'alice',
 * });
 * ```
 */
export function publishMove<
	const TName extends string,
	const TNeeds extends string = never,
	const TPublisher extends string = 'publisher',
	const TRegistryAs extends string = TName,
>(
	opts: PublishMoveOptions<TName, TNeeds, TPublisher, TRegistryAs>,
): WithNeeds<
	TNeeds,
	SignsAs<
		TPublisher,
		PublishesPackage<TName, PublishesRegistryAs<TRegistryAs, PublishAction<PublishInputs>>>
	>
> {
	return publish({
		name: opts.name,
		needs: opts.needs as string[] | undefined,
		provides: opts.provides,
		path: opts.path,
		capture: opts.capture,
		publisher: opts.publisher,
		registryAs: opts.registryAs,
	}) as WithNeeds<
		TNeeds,
		SignsAs<
			TPublisher,
			PublishesPackage<TName, PublishesRegistryAs<TRegistryAs, PublishAction<PublishInputs>>>
		>
	>;
}
