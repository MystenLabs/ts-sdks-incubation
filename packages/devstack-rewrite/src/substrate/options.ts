// Trailing-options bag for the variadic `defineDevstack` form.
//
// Structurally distinguished from a member by NOT carrying the
// MEMBER_BRAND (architecture § "Programmable API"). The user can
// pass a trailing object literal as the last positional argument
// without a delimiter — the type-level `Last<Args>` peel and the
// runtime `MEMBER_BRAND` check both find it.

import type { NetworkConfig } from './network.ts';
import type { MemberBrand } from './plugin.ts';

/** Trailing-options shape — all fields optional. Renderer choice
 *  defaults to `tui`; missing fields fall through to substrate
 *  defaults. */
export interface DevstackOptions {
	readonly stackName?: string;
	readonly network?: NetworkConfig;
	readonly watchPaths?: ReadonlyArray<string>;
	readonly stateDir?: string;
	readonly codegen?: {
		readonly outputDir?: string;
		readonly stackSubdir?: string | null;
	};
	readonly hotRestart?: boolean;
	readonly renderer?: 'tui' | 'plain' | 'silent';
}

/** A type that excludes the member brand — only "pure options"
 *  satisfy it. The runtime check is `!(MEMBER_BRAND in last)`. */
export type OptionsLike = DevstackOptions & { readonly [k in MemberBrand]?: never };
