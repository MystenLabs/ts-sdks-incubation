// In-memory typed registry. Plugins register items via `register()`; other
// plugins query via `list/find/require`. Plugin-namespaced kinds are
// accessed exclusively through `defineRegistryKind` accessors (the
// underlying lookup is internal to this module). Per-kind dirty tracking
// lets the reconciler dispatch Emit actions only when their
// `dependsOnKind` slice changed.
//
// Naming: `kindKey` is `'packages' | 'accounts' | 'services' |
// '<plugin>/<kind>'` — flat string used throughout dirty tracking.
//
// The dirty-tracking surface (`isDirty`, `flushDirty`, `consumeDirty`)
// and the namespace lookup (`getOrCreateKind`) are **not** on the public
// `Registry` interface — only the reconciler and `defineRegistryKind`
// reach them. The `snapshot()` accessor is similarly internal: the
// runtime's manifest writer + the first-party `codegen` plugin reach
// for it via `as InternalRegistry`. Third-party plugins should not
// consult any of these surfaces.

import type { Account, Package, Registry, RegistryQuery, Service } from '../core/types.js';
import type { SerializedRegistry } from '../runtime/manifest-types.js';

/**
 * Internal registry surface: adds the dirty-tracking + serialization
 * methods that the reconciler, manifest writer/reader, and codegen plugin
 * use, plus `getOrCreateKind` used by `defineRegistryKind` to resolve a
 * dotted-key kind reference. Not exposed on the public `Registry`
 * interface — plugin authors shouldn't reach for `flushDirty` /
 * `consumeDirty` directly. The runtime casts `Registry → InternalRegistry`
 * once at the boundary instead of casting to the concrete `RegistryImpl`
 * class everywhere.
 */
export interface InternalRegistry extends Registry {
	isDirty(kindKey: string): boolean;
	flushDirty(): Set<string>;
	consumeDirty(kinds: string[]): void;
	snapshot(): SerializedRegistry;
	/**
	 * Resolve a plugin-namespaced kind, creating the underlying
	 * `RegistryQuery` on first access. Used by `defineRegistryKind` and
	 * `manifest-reader` when round-tripping serialized registries.
	 */
	getOrCreateKind<T extends { name: string }>(
		namespace: string,
		kind: string,
	): RegistryQuery<T>;
}

/** Typed accessor for a plugin-namespaced registry kind. Pin the kind
 * at module top-level once; use the returned function from any plugin
 * action to register/list/find without redeclaring the namespace shape:
 *
 *   const arenaSharedObjects = defineRegistryKind<ArenaSharedObject>(
 *     'arena.sharedObjects',
 *   );
 *   arenaSharedObjects(ctx.registry).register({ name, ... });
 *
 * The typed kind name is a single source of truth (no risk of typo'ing
 * a new namespace by accident), and the `T` type stays attached to the
 * accessor so consumers don't redeclare it. */
export function defineRegistryKind<T extends { name: string }>(
	dottedKey: string,
): (registry: Registry) => RegistryQuery<T> {
	const dot = dottedKey.indexOf('.');
	if (dot <= 0 || dot === dottedKey.length - 1) {
		throw new Error(
			`defineRegistryKind: '${dottedKey}' must be 'namespace.kind' (non-empty on both sides of the dot).`,
		);
	}
	const ns = dottedKey.slice(0, dot);
	const kind = dottedKey.slice(dot + 1);
	return (registry) => (registry as InternalRegistry).getOrCreateKind<T>(ns, kind);
}

class RegistryQueryImpl<T extends { name: string }> implements RegistryQuery<T> {
	private readonly items = new Map<string, T>();

	constructor(
		private readonly kindKey: string,
		private readonly dirty: Set<string>,
	) {}

	list(): T[] {
		return Array.from(this.items.values());
	}

	find(name: string): T | undefined {
		return this.items.get(name);
	}

	require(name: string): T {
		const item = this.items.get(name);
		if (!item) {
			throw new Error(`Registry: ${this.kindKey} has no entry named '${name}'`);
		}
		return item;
	}

	register(item: T): void {
		this.items.set(item.name, item);
		this.dirty.add(this.kindKey);
	}

	unregister(name: string): boolean {
		const removed = this.items.delete(name);
		if (removed) this.dirty.add(this.kindKey);
		return removed;
	}
}

export class RegistryImpl implements InternalRegistry {
	private readonly dirtySet = new Set<string>();

	readonly packages: RegistryQuery<Package>;
	readonly accounts: RegistryQuery<Account>;
	readonly services: RegistryQuery<Service>;

	private readonly namespaces = new Map<string, Map<string, RegistryQuery<{ name: string }>>>();

	constructor() {
		this.packages = new RegistryQueryImpl<Package>('packages', this.dirtySet);
		this.accounts = new RegistryQueryImpl<Account>('accounts', this.dirtySet);
		this.services = new RegistryQueryImpl<Service>('services', this.dirtySet);
	}

	getOrCreateKind<T extends { name: string }>(
		namespace: string,
		kind: string,
	): RegistryQuery<T> {
		let bag = this.namespaces.get(namespace);
		if (!bag) {
			bag = new Map();
			this.namespaces.set(namespace, bag);
		}
		let query = bag.get(kind);
		if (!query) {
			query = new RegistryQueryImpl<{ name: string }>(`${namespace}/${kind}`, this.dirtySet);
			bag.set(kind, query);
		}
		return query as RegistryQuery<T>;
	}

	isDirty(kindKey: string): boolean {
		return this.dirtySet.has(kindKey);
	}

	flushDirty(): Set<string> {
		const flushed = new Set(this.dirtySet);
		this.dirtySet.clear();
		return flushed;
	}

	consumeDirty(kinds: string[]): void {
		for (const k of kinds) this.dirtySet.delete(k);
	}

	/**
	 * Serialize the entire registry to a `SerializedRegistry` snapshot
	 * suitable for `Manifest.registry`. Used by manifest-writer (no
	 * longer reaches into the private namespaces map). Pure read — does
	 * NOT touch the dirty set.
	 */
	snapshot(): SerializedRegistry {
		const out: SerializedRegistry = {
			packages: this.packages.list(),
			accounts: this.accounts.list(),
			services: this.services.list(),
		};
		for (const [name, kinds] of this.namespaces) {
			const bag: Record<string, unknown[]> = {};
			for (const [kindName, query] of kinds) {
				bag[kindName] = query.list();
			}
			out[name] = bag;
		}
		return out;
	}
}
