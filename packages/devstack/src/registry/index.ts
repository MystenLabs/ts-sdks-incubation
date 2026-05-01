// In-memory typed registry. Plugins register items via `register()`; other
// plugins query via `list/find/require`. Namespaced kinds (per Q1) live
// under `registry.ns('<plugin>')`. Per-kind dirty tracking (Q11) lets the
// reconciler dispatch Emit actions only when their `dependsOnKind` slice
// actually changed.
//
// Naming: `kindKey` is `'tokens' | 'packages' | 'accounts' | 'services' |
// '<plugin>/<kind>'` — flat string used throughout dirty tracking.

import type { Account, Package, Registry, RegistryQuery, Service, Token } from '../core/types.js';

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
}

export class RegistryImpl implements Registry {
	private readonly dirtySet = new Set<string>();

	readonly tokens: RegistryQuery<Token>;
	readonly packages: RegistryQuery<Package>;
	readonly accounts: RegistryQuery<Account>;
	readonly services: RegistryQuery<Service>;

	private readonly namespaces = new Map<string, Record<string, RegistryQuery<unknown>>>();

	constructor() {
		this.tokens = new RegistryQueryImpl<Token>('tokens', this.dirtySet);
		this.packages = new RegistryQueryImpl<Package>('packages', this.dirtySet);
		this.accounts = new RegistryQueryImpl<Account>('accounts', this.dirtySet);
		this.services = new RegistryQueryImpl<Service>('services', this.dirtySet);
	}

	ns<T>(name: string): T {
		let bag = this.namespaces.get(name);
		if (!bag) {
			bag = {};
			this.namespaces.set(name, bag);
		}
		const dirty = this.dirtySet;
		// Lazy proxy: kind queries are created on first access.
		return new Proxy(bag, {
			get(target, prop: string) {
				if (typeof prop !== 'string') return undefined;
				if (!(prop in target)) {
					target[prop] = new RegistryQueryImpl<{ name: string }>(`${name}/${prop}`, dirty);
				}
				return target[prop];
			},
		}) as T;
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
}
