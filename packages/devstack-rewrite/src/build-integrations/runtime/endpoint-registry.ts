// Typed endpoint lookup.
//
// `EndpointRegistry` wraps the manifest's flat `endpoints` map with
// the small set of queries every consumer asks of it:
//
//   - `byName(name)`: the load-bearing lookup. Vite alias, Playwright
//     `baseURL`, codegen emitters all key off endpoint name.
//   - `byPluginKey(key)`: group endpoints by the plugin that emitted
//     them. The CLI `status` command uses this to print one block
//     per plugin.
//   - `byKind(kind)`: kind is currently `wireProtocol` (`http` vs
//     `h2c`). Cheap projection; lets callers filter the gRPC endpoints
//     out of an HTTP-only health check.
//   - `all()`: stable-ordered iteration. Order is alphabetical by
//     endpoint name — the manifest writer emits in input-order, but
//     consumer iteration shouldn't depend on plugin registration
//     order.
//
// Plain class — no Effect, no Schema. Callable from any consumer
// runtime (Node, browser bundle that imported the manifest via the
// build-integration alias).

import type { ResolvedEndpoint } from './stack-context.ts';

/** Read-only registry over the manifest's `endpoints` map. */
export class EndpointRegistry {
	private readonly entries: ReadonlyArray<ResolvedEndpoint>;
	private readonly byNameIndex: ReadonlyMap<string, ResolvedEndpoint>;

	constructor(entries: ReadonlyArray<ResolvedEndpoint>) {
		// Defensive: sort by name so iteration is stable across
		// supervisor runs even if the writer hashed plugins in a
		// different order this time.
		const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		this.entries = sorted;
		const map = new Map<string, ResolvedEndpoint>();
		for (const entry of sorted) map.set(entry.name, entry);
		this.byNameIndex = map;
	}

	/** Look up an endpoint by its declared name. Returns `undefined`
	 *  when the name isn't in the manifest — callers that want a hard
	 *  fail should `??` to a thrown error. */
	byName(name: string): ResolvedEndpoint | undefined {
		return this.byNameIndex.get(name);
	}

	/** Group endpoints by the plugin that emitted them. Used by the
	 *  CLI status output. */
	byPluginKey(pluginKey: string): ReadonlyArray<ResolvedEndpoint> {
		return this.entries.filter((e) => e.pluginKey === pluginKey);
	}

	/** Filter endpoints by wire protocol (`http`, `h2c`). */
	byKind(wireProtocol: string): ReadonlyArray<ResolvedEndpoint> {
		return this.entries.filter((e) => e.wireProtocol === wireProtocol);
	}

	/** All endpoints, alphabetical by name. */
	all(): ReadonlyArray<ResolvedEndpoint> {
		return this.entries;
	}

	/** Names of every endpoint, alphabetical. Convenience for error
	 *  messages that want to list "the supported names are: ...". */
	names(): ReadonlyArray<string> {
		return this.entries.map((e) => e.name);
	}
}
