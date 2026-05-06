// App-side accessors for the serialized `Manifest` shape that codegen
// emits and `<DevstackProvider>` carries through React. Mirror the
// runtime-side `defineRegistryKind` from `src/registry/`: at runtime,
// plugin authors register/list against a `Registry`; in app code,
// callers read from a `Manifest`.
//
// These exist to absorb the byte-identical projection logic that was
// duplicated across every example's `lib/deployment.ts` (four
// re-derivations of "find sui-rpc URL", "find package by name", "build
// account map") with subtly different fallback semantics. App code
// keeps its app-specific projection but threads it through these.

import type { Package, Service } from './core/types.js';
import type { Manifest } from './runtime/manifest-types.js';

/** Look up a service by registry name. Returns `undefined` if absent —
 * caller picks the fallback (`''` for URL fields, `null` for "not deployed
 * yet" gates, etc.). */
export function selectService(manifest: Manifest, name: string): Service | undefined {
	return manifest.registry.services.find((s) => s.name === name);
}

/** Look up a package by registry name. Captured object IDs land on
 * `result.captured` keyed by the `capture: { ... }` config the publish
 * action declared. */
export function selectPackage(manifest: Manifest, name: string): Package | undefined {
	return manifest.registry.packages.find((p) => p.name === name);
}

/** Project the accounts list into a `name → address` map. Useful for
 * `'publisher' as keyof typeof accountMap`-style typing in app code. */
export function selectAccountMap(manifest: Manifest): Record<string, string> {
	return Object.fromEntries(manifest.registry.accounts.map((a) => [a.name, a.address]));
}

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
