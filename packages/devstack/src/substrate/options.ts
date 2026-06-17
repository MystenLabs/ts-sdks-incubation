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
		/** Forwarded verbatim to `@mysten/codegen`'s
		 *  `generateFromPackageSummary({ includePhantomTypeParameters })`.
		 *  Default `false` — `@mysten/codegen`'s own default.
		 *
		 *  Off, a struct whose type parameters are ALL phantom renders as a
		 *  plain `const X = new MoveStruct({ name: '...::X<phantom T>' })` —
		 *  the phantom placeholder is baked into `.name`, so the instance is
		 *  unusable as a concrete type tag. On, such structs render as
		 *  factory functions
		 *  (`export function X<T extends BcsType<any>>(...typeParameters: [T])`)
		 *  whose returned MoveStruct's `.name` interpolates the arguments'
		 *  names — phantom parameters become REQUIRED, and the instance's
		 *  `.name` is a fully-qualified, composable type tag
		 *  (`Pool(DBTC, DUSDC).name`).
		 *
		 *  NOTE: flipping this reshapes the generated code for phantom-only
		 *  structs from consts to factories, so call sites consuming those
		 *  bindings change. */
		readonly includePhantomTypeParameters?: boolean;
	};
	readonly renderer?: 'tui' | 'plain' | 'silent';
	readonly extras?: ManifestExtrasInput;
	/** Per-network options, keyed by the resolved network name. The
	 *  name-blind substrate forwards this verbatim — it never reads the
	 *  shape. The authoring surface (`api/define-devstack-with.ts`) narrows
	 *  it to typed per-network toggles, and the plugin-aware orchestrator
	 *  interprets it (`orchestrators/network-options.ts`
	 *  `resolveNetworkOptions`). Mirrors the opaque `network` field. */
	readonly networkOptions?: Readonly<Record<string, unknown>>;
}
