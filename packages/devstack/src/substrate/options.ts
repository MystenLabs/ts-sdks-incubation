// `defineDevstack({ members, ...options })` options bag.

import type { ManifestExtrasInput } from './manifest.ts';

/** Options shape — all fields optional. Renderer choice
 *  defaults to `tui`; missing fields fall through to substrate
 *  defaults. */
export interface DevstackOptions {
	readonly stackName?: string;
	/** Substrate-opaque network pass-through. The substrate is name-blind
	 *  and never reads `.mode`/`.chain` off this — it forwards the value to
	 *  `engine.options.network` verbatim. The sui-plugin authoring surface
	 *  (`DevstackOptionsWith<Mode>` in `api/define-devstack-with.ts`)
	 *  narrows this to the sui-plugin `NetworkConfig<Mode>` for typed
	 *  mode-narrowing; the flat form accepts any value. */
	readonly network?: unknown;
	readonly stateDir?: string;
	readonly codegen?: {
		readonly outputDir?: string;
		readonly stackSubdir?: string | null;
	};
	readonly renderer?: 'tui' | 'plain' | 'silent';
	/** Reuse a fingerprinted baseline snapshot when config + inputs are
	 *  unchanged (warm boot); a change re-captures. */
	readonly warm?: boolean;
	readonly extras?: ManifestExtrasInput;
}
