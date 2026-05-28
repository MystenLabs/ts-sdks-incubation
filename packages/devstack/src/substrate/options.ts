// `defineDevstack({ members, ...options })` options bag.

import type { NetworkConfig } from './network.ts';
import type { ManifestExtrasInput } from './manifest.ts';

/** Options shape — all fields optional. Renderer choice
 *  defaults to `tui`; missing fields fall through to substrate
 *  defaults. */
export interface DevstackOptions {
	readonly stackName?: string;
	readonly network?: NetworkConfig;
	readonly stateDir?: string;
	readonly codegen?: {
		readonly outputDir?: string;
		readonly stackSubdir?: string | null;
	};
	readonly renderer?: 'tui' | 'plain' | 'silent';
	readonly extras?: ManifestExtrasInput;
}
