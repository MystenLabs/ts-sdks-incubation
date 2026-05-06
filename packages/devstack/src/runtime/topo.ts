// Kahn-style topological sort over actions keyed by `name` with `needs`
// edges. Throws on cycles or unresolved deps. Ties broken by input order.

import type { Action } from '../core/types.js';

interface TopoSortOptions {
	/**
	 * Drop `needs` edges that point at actions absent from the input. When
	 * `false` (default), an action that needs an unknown name throws —
	 * this is the right behavior for the supervisor path, where the full
	 * action graph is always present and a missing need is a typo.
	 *
	 * Set `true` for the one-shot path (`runApply`/`runDeploy`/`runCodegen`),
	 * where an `ActionFilter` may have stripped Service/Build actions
	 * before topo runs. Their dependents (e.g. `accounts.fund` needing
	 * `sui.localnet`, `imports.deepbook` needing `imports.deepbook-source`)
	 * are still in the input — we just drop the now-orphaned edge so the
	 * remaining actions can run in their original relative order.
	 */
	lenient?: boolean;
}

/**
 * Topo-sort `actions` by their `needs` edges. Capabilities layer on top
 * of direct deps as soft cross-plugin ordering:
 *
 * An action's `provides: ['cap']` registers it as a provider of `cap`.
 * Other actions reference capabilities via suffixed queries in their own
 * `needs`:
 *   - `'cap:before'` → "providers of cap run before me" (provider→me
 *     edges, equivalent to a direct `needs` on each provider).
 *
 * Queries against capabilities with no providers are silently dropped —
 * the "optional ordering" pattern. The sui plugin's `walrus.app-network:
 * before` orders sui after walrus IF walrus is loaded; sui-only stacks
 * skip the edge.
 *
 * `:after` was the symmetric inverse ("providers run after me") but had
 * zero production callers across all 8 plugins + every example, so it's
 * been removed. Future need is satisfied by adding a `provides` to the
 * other side and a normal `:before` query.
 *
 * Returned actions are shallow-cloned with their `needs` rewritten to the
 * resolved effective deps (capability queries replaced by concrete
 * provider names). Callers should always walk the returned array, not
 * the input — synthesized edges are otherwise silently lost.
 */
export function topoSortActions(actions: Action[], options: TopoSortOptions = {}): Action[] {
	const byName = new Map<string, Action>();
	for (const a of actions) {
		if (byName.has(a.name)) {
			throw new Error(`topoSortActions: duplicate action name '${a.name}'`);
		}
		byName.set(a.name, a);
	}

	// Capability providers: capability name → action names that declare it.
	// Order matches input order; ordering between sibling providers of the
	// same capability is unspecified (callers shouldn't rely on it).
	const providers = new Map<string, string[]>();
	for (const a of actions) {
		for (const cap of a.provides?.capabilities ?? []) {
			const arr = providers.get(cap) ?? [];
			arr.push(a.name);
			providers.set(cap, arr);
		}
	}

	// Resolve each action's `needs`. `:before` queries fold into the
	// resolved deps (provider→me edges); raw names pass through.
	// Capability queries with no matching provider are silently dropped.
	const effectiveDeps = new Map<string, string[]>();
	for (const a of actions) {
		const resolved: string[] = [];
		for (const need of a.needs ?? []) {
			const m = need.match(/^(.+):before$/);
			if (m === null) {
				if (need.endsWith(':after')) {
					throw new Error(
						`topoSortActions: action '${a.name}' uses dropped \`:after\` capability ` +
							`suffix in '${need}'. Use \`:before\` from the other side instead.`,
					);
				}
				resolved.push(need);
				continue;
			}
			const cap = m[1] as string;
			for (const p of providers.get(cap) ?? []) {
				if (p !== a.name) resolved.push(p);
			}
		}
		effectiveDeps.set(a.name, resolved);
	}

	// Lenient mode: drop edges that point at actions absent from the
	// input (likely filtered out by an ActionFilter before topo runs).
	// Log to stderr at debug verbosity so a misconfigured filter doesn't
	// silently swallow ordering edges. DEVSTACK_DEBUG_TOPO=1 enables.
	if (options.lenient === true) {
		const debug = process.env.DEVSTACK_DEBUG_TOPO === '1';
		for (const [name, deps] of effectiveDeps) {
			const kept = deps.filter((d) => byName.has(d));
			if (debug && kept.length !== deps.length) {
				const dropped = deps.filter((d) => !byName.has(d));
				process.stderr.write(
					`[devstack/topo] lenient: '${name}' dropping edges to filtered actions: ` +
						`${dropped.join(', ')}\n`,
				);
			}
			effectiveDeps.set(name, kept);
		}
	}

	const indegree = new Map<string, number>();
	const order = new Map<string, number>();
	for (let i = 0; i < actions.length; i++) {
		const a = actions[i];
		if (a === undefined) continue;
		indegree.set(a.name, 0);
		order.set(a.name, i);
	}
	for (const a of actions) {
		for (const dep of effectiveDeps.get(a.name) ?? []) {
			if (!byName.has(dep)) {
				throw new Error(`topoSortActions: action '${a.name}' needs unknown '${dep}'`);
			}
			indegree.set(a.name, (indegree.get(a.name) ?? 0) + 1);
		}
	}

	const ready: Action[] = [];
	for (const a of actions) {
		if ((indegree.get(a.name) ?? 0) === 0) ready.push(a);
	}
	ready.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));

	const result: Action[] = [];
	const dependents = new Map<string, string[]>();
	for (const a of actions) {
		for (const dep of effectiveDeps.get(a.name) ?? []) {
			const arr = dependents.get(dep) ?? [];
			arr.push(a.name);
			dependents.set(dep, arr);
		}
	}

	while (ready.length > 0) {
		const next = ready.shift();
		if (next === undefined) break;
		result.push(next);
		for (const childName of dependents.get(next.name) ?? []) {
			const remaining = (indegree.get(childName) ?? 0) - 1;
			indegree.set(childName, remaining);
			if (remaining === 0) {
				const child = byName.get(childName);
				if (child !== undefined) ready.push(child);
			}
		}
		ready.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
	}

	if (result.length !== actions.length) {
		const remaining = actions.filter((a) => !result.includes(a)).map((a) => a.name);
		throw new Error(`topoSortActions: cycle detected involving [${remaining.join(', ')}]`);
	}
	return result.map((a) => {
		const deps = effectiveDeps.get(a.name) ?? [];
		const original = a.needs ?? [];
		const same = deps.length === original.length && deps.every((d, i) => d === original[i]);
		if (same) return a;
		return { ...a, needs: deps } as Action;
	});
}
