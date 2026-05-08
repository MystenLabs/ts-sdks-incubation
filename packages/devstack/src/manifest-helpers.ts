// App-side accessor for the serialized `Manifest` shape that codegen
// emits. Mirrors the runtime-side `defineRegistryKind` from
// `src/registry/`: at runtime, plugin authors register/list against a
// `Registry`; in app code, callers read from a `Manifest`.
//
// The four core kinds (`packages`, `accounts`, `services`, plus any
// plugin-namespaced kinds) are accessible directly off
// `manifest.registry.*`. `defineManifestKind` provides typed access to
// plugin-namespaced kinds (e.g. `arena.sharedObjects`,
// `deepbook.pools`).

import type { Manifest } from './runtime/manifest-types.js';

/** Query shape returned by `defineManifestKind`. Symmetric to
 * `RegistryQuery` on the runtime side: read-only `list`/`find`/`require`
 * (no `register`/`unregister` — the manifest is frozen at codegen time).
 *
 * `TName` mirrors the runtime-side `RegistryQuery<T, TName>` parameter
 * — passing a literal-string union autocompletes known names + flags
 * typos at compile time. Defaults to `string` so untyped callers work
 * unchanged. */
export interface ManifestQuery<T, TName extends string = string> {
	list(): T[];
	find(name: TName | (string & {})): T | undefined;
	require(name: TName | (string & {})): T;
}

/**
 * Typed accessor for a plugin-namespaced registry kind on the
 * serialized `Manifest`. Symmetric to `defineRegistryKind` (which works
 * against a runtime `Registry`).
 *
 * The `T` type is unconstrained beyond `{ name: string }` (every
 * registered item has a name); cast at the consuming call site if your
 * kind carries additional required fields.
 *
 * @example
 * ```ts
 * import { defineManifestKind } from '@mysten-incubation/devstack';
 * import { manifest } from './generated/manifest';
 *
 * interface ArenaSharedObject { name: string; objectId: string }
 *
 * const arenaSharedObjects = defineManifestKind<ArenaSharedObject>(
 *   'arena.sharedObjects',
 * );
 *
 * const lobby = arenaSharedObjects(manifest).require('openLobby');
 * ```
 */
export function defineManifestKind<T extends { name: string }, TName extends string = string>(
	dottedKey: string,
): (manifest: Manifest) => ManifestQuery<T, TName> {
	const dot = dottedKey.indexOf('.');
	if (dot <= 0 || dot === dottedKey.length - 1) {
		throw new Error(
			`defineManifestKind: '${dottedKey}' must be 'namespace.kind' (non-empty on both sides of the dot).`,
		);
	}
	const ns = dottedKey.slice(0, dot);
	const kind = dottedKey.slice(dot + 1);
	return (manifest) => {
		const namespace = manifest.registry[ns] as Record<string, unknown> | undefined;
		const items: T[] =
			namespace !== undefined && Array.isArray(namespace[kind])
				? (namespace[kind] as T[])
				: [];
		return {
			list: () => items,
			find: (name) => items.find((item) => item.name === name),
			require: (name) => {
				const found = items.find((item) => item.name === name);
				if (found === undefined) {
					throw new Error(`manifest: '${dottedKey}' has no entry named '${name}'`);
				}
				return found;
			},
		};
	};
}
