// `publishMove()` — ergonomic factory for app-level Move package publishes.
//
// Thin wrapper over `definePublishAction()` that uses the user-friendly
// `path` field instead of `sourcePath`, and threads the setup-action
// `scope` field. Use in `DevstackConfig.setup`:
//
//   setup: [
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

import type { ActionRunContext, Provides, PublishAction, SetupActionScope } from '../core/types.js';
import type { PublishMovePackageResult } from '../helpers/move-package.js';
import { definePublishAction, type PublishInputs } from './publish.js';

export interface PublishMoveOptions {
	name: string;
	needs?: string[];
	provides?: Provides;
	/** Move package source directory (relative to the app's `devstack.config.ts`). */
	path: string;
	/** Object-type filters to capture by name. See `definePublishAction`'s
	 * `capture` for the filter syntax (suffix match; trailing `<` for
	 * generic types). */
	capture?: Record<string, string>;
	/** Account name that signs the publish. Defaults to `'publisher'`. */
	publisher?: string;
	/** Registry entry name. Defaults to `name`. */
	registryAs?: string;
	/** Side-effect after a fresh publish (skipped on cache hit). Use for
	 * token registration, follow-up shared-object creation, etc. */
	onPublished?: (ctx: ActionRunContext, result: PublishMovePackageResult) => Promise<void> | void;
	/** Setup-action scope. See `SetupActionScope`. Default: 'always'. */
	scope?: SetupActionScope;
}

export function publishMove(opts: PublishMoveOptions): PublishAction<PublishInputs> {
	const action = definePublishAction({
		name: opts.name,
		needs: opts.needs,
		provides: opts.provides,
		sourcePath: opts.path,
		capture: opts.capture,
		publisher: opts.publisher,
		registryAs: opts.registryAs,
		onPublished: opts.onPublished,
	});
	if (opts.scope !== undefined) {
		action.scope = opts.scope;
	}
	return action;
}
