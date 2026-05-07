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

interface PublishMoveOptions<TNeeds extends string> {
	name: string;
	needs?: readonly TNeeds[];
	provides?: Provides;
	/** Move package source directory (relative to the app's `devstack.config.ts`). */
	path: string;
	/** Object-type filters to capture by name. See `publish()`'s `capture`
	 * for the filter syntax (suffix match; trailing `<` for generic types). */
	capture?: Record<string, string>;
	/** Account name that signs the publish. Defaults to `'publisher'`. */
	publisher?: string;
	/** Registry entry name. Defaults to `name`. */
	registryAs?: string;
}

/** The phantom-typed return shape: PublishAction plus a `__needs` carrier
 * so `defineDevstackConfig`'s mapped-type validator can see what this
 * action's needs are at compile time. The phantom has no runtime
 * presence. */
type WithNeeds<TNeeds extends string, T> = T & { readonly __needs?: TNeeds };

export function publishMove<const TNeeds extends string = never>(
	opts: PublishMoveOptions<TNeeds>,
): WithNeeds<TNeeds, PublishAction<PublishInputs>> {
	return publish({
		name: opts.name,
		needs: opts.needs as string[] | undefined,
		provides: opts.provides,
		path: opts.path,
		capture: opts.capture,
		publisher: opts.publisher,
		registryAs: opts.registryAs,
	}) as WithNeeds<TNeeds, PublishAction<PublishInputs>>;
}
