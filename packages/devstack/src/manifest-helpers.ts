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

/** Typed accessor for a plugin-namespaced registry kind on the
 * serialized `Manifest`. Symmetric to `defineRegistryKind` (which works
 * against a runtime `Registry`):
 *
 *   const arenaSharedObjects = defineManifestKind<ArenaSharedObject>(
 *     'arena.sharedObjects',
 *   );
 *   const lobby = arenaSharedObjects(manifest).find((o) => o.name === 'openLobby');
 *
 * The `T` type is unconstrained beyond `{ name: string }` (every registered
 * item has a name); cast at the consuming call site if your kind carries
 * additional required fields. */
export function defineManifestKind<T extends { name: string }>(
	dottedKey: string,
): (manifest: Manifest) => T[] {
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
		if (!namespace) return [];
		const items = namespace[kind];
		return Array.isArray(items) ? (items as T[]) : [];
	};
}
