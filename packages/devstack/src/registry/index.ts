// In-memory typed registry. Plugins register items via `register()`; other
// plugins query via `list/find/require`. Plugin-namespaced kinds are
// accessed exclusively through `defineRegistryKind` accessors (the
// underlying lookup is internal to this module). Per-kind dirty tracking
// lets the reconciler dispatch Emit actions only when their
// `dependsOnKind` slice changed.
//
// Naming: `kindKey` is `'packages' | 'accounts' | 'services' |
// '<plugin>.<kind>'` — flat dotted string used throughout dirty tracking.
// The dotted form matches the `defineRegistryKind('namespace.kind')`
// surface so the same string flows through `dependsOnKind` consumers
// without translation.
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

/**
 * Typed accessor for a plugin-namespaced registry kind. Pin the kind
 * at module top-level once; use the returned function from any plugin
 * action to register/list/find without redeclaring the namespace shape.
 *
 * The typed kind name is a single source of truth (no risk of typo'ing
 * a new namespace by accident), and the `T` type stays attached to the
 * accessor so consumers don't redeclare it.
 *
 * @example
 * ```ts
 * import { defineRegistryKind } from '@mysten-incubation/devstack';
 *
 * interface ArenaSharedObject { name: string; objectId: string }
 *
 * const arenaSharedObjects = defineRegistryKind<ArenaSharedObject>(
 *   'arena.sharedObjects',
 * );
 *
 * // inside a plugin action:
 * arenaSharedObjects(ctx.registry).register({ name: 'lobby', objectId });
 * ```
 */
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

/**
 * Tracks the set of field names ever observed on items registered into a
 * given kind. Mismatch detection compares the incoming key-set against
 * this growing observed-set: an incoming register adds new keys to the
 * observed-set, but if NONE of its keys appear in the observed-set —
 * AND the observed-set wasn't empty — that's a genuine shape collision
 * (two plugins reusing the same kind name with structurally disjoint
 * `T` shapes). Optional fields naturally widen the observed-set without
 * triggering a false positive.
 */
function fieldKeys(item: { name: string }): string[] {
	return Object.keys(item).sort();
}

class RegistryQueryImpl<T extends { name: string }> implements RegistryQuery<T> {
	private readonly items = new Map<string, T>();

	constructor(
		private readonly kindKey: string,
		private readonly dirty: Set<string>,
		private readonly kindFieldsObserved: Map<string, Set<string>>,
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

	/**
	 * Register an item under this kind, with a structural-collision guard
	 * folded into the path.
	 *
	 * What the guard prevents:
	 *   Two plugins registering structurally-disjoint shapes under the
	 *   same `<ns>.<kind>` dotted key. Without it, the second plugin's
	 *   items silently coexist with the first's in `list()`, and consumers
	 *   that asked `find()` for a known name might get back an item with
	 *   an entirely unexpected shape — opaque downstream.
	 *
	 * Growing observed-set model:
	 *   The FIRST register's keys form the seed observed-set. Each
	 *   subsequent register can ADD optional fields (its keys are unioned
	 *   into the observed-set) without firing the guard. This matches the
	 *   real-world authoring pattern where a plugin's items grow optional
	 *   metadata over time.
	 *
	 * Threshold-of-2:
	 *   Every kind's `T extends { name: string }` so `name` is a universal
	 *   field — overlap on `name` alone tells us nothing. We require
	 *   overlap of 2 or more fields to consider this register a same-shape
	 *   continuation. A register that shares ONLY `name` with the prior
	 *   observed set is rejected when the observed-set has more than one
	 *   field (`observed.size > 1`) — i.e. only after we've seen enough
	 *   structure to spot the collision.
	 *
	 * Known limitation:
	 *   Kinds whose `T` has only `{name, x}` (one non-`name` field) can
	 *   slip through if the second plugin's `T = {name, x}` happens to
	 *   share the field name (`x`) by coincidence — overlap=2 passes, even
	 *   though the field's type/semantics differ between the two plugins.
	 *   The guard is structural-key-based; it doesn't and can't reason
	 *   about field types. Pick distinct kind names per plugin
	 *   (`<plugin>.<kind>`) to avoid the trap.
	 *
	 * Narrowing semantics:
	 *   The observed-set never shrinks. A register that DROPS a
	 *   previously-observed field passes silently — the registered item
	 *   simply lacks the field; consumers reading the kind get
	 *   `undefined` for that key. The collision guard catches
	 *   structurally-disjoint shapes (overlap < 2 with observed.size > 1),
	 *   not field-removals from the established schema. If a plugin
	 *   author needs to break the schema, use a fresh kind name (e.g.
	 *   bump `<plugin>.foo` → `<plugin>.foo-v2`).
	 */
	register(item: T): void {
		const incoming = fieldKeys(item as { name: string });
		const observed = this.kindFieldsObserved.get(this.kindKey);
		if (observed === undefined) {
			this.kindFieldsObserved.set(this.kindKey, new Set(incoming));
		} else {
			// Genuine collision detector: the incoming item's keys must
			// share at least the `name` field with what we've observed
			// (every kind has `name` by constraint). Beyond that, we
			// require non-trivial overlap — otherwise two plugins reusing
			// the same kind name with structurally disjoint shapes would
			// produce undefined behavior. Optional/added fields widen the
			// observed-set without firing.
			const incomingSet = new Set(incoming);
			let overlap = 0;
			for (const k of incomingSet) if (observed.has(k)) overlap++;
			if (overlap < 2 && observed.size > 1) {
				throw new Error(
					`Registry: kind '${this.kindKey}' was first registered with fields ` +
						`{${Array.from(observed).sort().join(',')}} but this register has ` +
						`{${incoming.join(',')}} — likely a shape collision between two ` +
						`plugins reusing the same kind name. Pick a different kind name ` +
						`(e.g. namespace it under your plugin).`,
				);
			}
			for (const k of incomingSet) observed.add(k);
		}
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

	/** Observed-fields set per `(ns.kind)` key. Used by
	 * `RegistryQueryImpl.register` to detect when two plugins try to
	 * register structurally different items into the same kind name —
	 * a typo or namespace collision that previously surfaced as opaque
	 * downstream behavior. Optional/added fields widen this set without
	 * triggering false positives; only a register whose keys barely
	 * overlap (≤1, just the inherited `name`) trips the collision check. */
	private readonly kindFieldsObserved = new Map<string, Set<string>>();

	readonly packages: RegistryQuery<Package>;
	readonly accounts: RegistryQuery<Account>;
	readonly services: RegistryQuery<Service>;

	private readonly namespaces = new Map<string, Map<string, RegistryQuery<{ name: string }>>>();

	constructor() {
		this.packages = new RegistryQueryImpl<Package>(
			'packages',
			this.dirtySet,
			this.kindFieldsObserved,
		);
		this.accounts = new RegistryQueryImpl<Account>(
			'accounts',
			this.dirtySet,
			this.kindFieldsObserved,
		);
		this.services = new RegistryQueryImpl<Service>(
			'services',
			this.dirtySet,
			this.kindFieldsObserved,
		);
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
			query = new RegistryQueryImpl<{ name: string }>(
				`${namespace}.${kind}`,
				this.dirtySet,
				this.kindFieldsObserved,
			);
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
