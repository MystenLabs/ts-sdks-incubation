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
				const suggestion = suggestNearMatch(dep, Array.from(byName.keys()));
				const hint = suggestion !== undefined ? ` (did you mean: '${suggestion}'?)` : '';
				throw new Error(`topoSortActions: action '${a.name}' needs unknown '${dep}'${hint}`);
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
		const remainingSet = new Set(remaining);
		const cycle = reconstructCycle(remaining[0] ?? '', remainingSet, effectiveDeps);
		const detail =
			cycle.length > 0
				? cycle.join(' → ')
				: `[${remaining.join(', ')}]`;
		throw new Error(`topoSortActions: cycle detected: ${detail}`);
	}
	return result.map((a) => {
		const deps = effectiveDeps.get(a.name) ?? [];
		const original = a.needs ?? [];
		const same = deps.length === original.length && deps.every((d, i) => d === original[i]);
		if (same) return a;
		return { ...a, needs: deps } as Action;
	});
}

/** Standard iterative Levenshtein distance with a single-row rolling
 * buffer. Used by the unknown-dep error formatter to surface
 * "did you mean" suggestions for typos in `needs:` references. */
function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	const prev = Array<number>(n + 1).fill(0).map((_, i) => i);
	const curr = Array<number>(n + 1).fill(0);
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(
				(curr[j - 1] ?? 0) + 1,
				(prev[j] ?? 0) + 1,
				(prev[j - 1] ?? 0) + cost,
			);
		}
		for (let j = 0; j <= n; j++) prev[j] = curr[j] ?? 0;
	}
	return curr[n] ?? 0;
}

/** Find the closest action name within an edit-distance budget proportional
 * to the length of the unknown reference. Returns undefined when no
 * candidate is close enough, so the caller can omit the hint clause
 * entirely (avoiding noisy suggestions on entirely-different names). */
function suggestNearMatch(unknown: string, candidates: readonly string[]): string | undefined {
	const limit = Math.max(2, Math.floor(unknown.length * 0.3));
	let best: { name: string; dist: number } | undefined;
	for (const c of candidates) {
		const d = levenshtein(unknown, c);
		if (d > limit) continue;
		if (best === undefined || d < best.dist) best = { name: c, dist: d };
	}
	return best?.name;
}

/** From a node known to participate in a cycle, walk needs-edges through
 * the unsettled set until we revisit a node — that closes the cycle.
 * Returns the cycle path with the start node repeated at the end so the
 * loop is visible in error output (e.g. `a → b → c → a`). The walk is
 * bounded by `unsettled.size` since each step either visits a new node
 * or closes the cycle. */
function reconstructCycle(
	start: string,
	unsettled: Set<string>,
	effectiveDeps: Map<string, string[]>,
): string[] {
	if (start === '' || !unsettled.has(start)) return [];
	const path: string[] = [start];
	const visitedAt = new Map<string, number>();
	visitedAt.set(start, 0);
	let current = start;
	while (path.length <= unsettled.size + 1) {
		const next = (effectiveDeps.get(current) ?? []).find((dep) => unsettled.has(dep));
		if (next === undefined) return path; // shouldn't happen for a real cycle
		const seenAt = visitedAt.get(next);
		if (seenAt !== undefined) {
			// Close the cycle: trim leading nodes that aren't part of the
			// loop, then append the revisited node so the round-trip is
			// visible.
			path.push(next);
			return path.slice(seenAt);
		}
		visitedAt.set(next, path.length);
		path.push(next);
		current = next;
	}
	return path;
}
