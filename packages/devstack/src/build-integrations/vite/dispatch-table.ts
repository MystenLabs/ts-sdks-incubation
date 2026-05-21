// Endpoint / reverse-proxy dispatch projection.
//
// Reads the canonical `StackContext` (`runtime/`'s plain projection of
// the L0 envelope) and re-projects the endpoint list into the shapes
// the Vite plugin grafts onto Vite's config:
//   - A flat name → URL lookup (the `endpoints` map the browser sees
//     via `define`).
//   - A `proxy` mapping ready to drop into Vite's `server.proxy` so
//     the app can issue same-origin requests during dev and Vite
//     routes them to the right service over the router.
//   - A `define` mapping that bakes endpoint URLs into the bundle for
//     the codegen-emitted `endpoints.ts` module.

import type { StackContext } from '../runtime/index.ts';

/** A single entry projected for downstream Vite wiring. */
export interface DispatchEntry {
	readonly name: string;
	readonly url: string;
	readonly wireProtocol: string;
	readonly pluginKey: string;
	readonly endpointKey: string;
}

/** Full projection — endpoints + the derived `server.proxy` mapping
 *  + the `define` mapping the plugin injects into the bundle. */
export interface DispatchTable {
	readonly entries: ReadonlyArray<DispatchEntry>;
	/** Path-prefix → target mapping for Vite's `server.proxy`. Path
	 *  prefix is `/__devstack/endpoint/<name>`; target is the
	 *  endpoint's URL. */
	readonly proxy: Readonly<
		Record<string, { readonly target: string; readonly changeOrigin: true }>
	>;
	/** Define entries injected via Vite's `define` option. Keys are
	 *  `__DEVSTACK_ENDPOINT_<NAME>__`; values are JSON-stringified URLs. */
	readonly define: Readonly<Record<string, string>>;
}

/**
 * Build the dispatch table from a stack context. Returns an empty
 * table when no context exists (cold-start) — the plugin still wires
 * its config; the proxy + define mappings just light up once the
 * manifest is on disk.
 */
export const buildDispatchTable = (context: StackContext | null): DispatchTable => {
	if (context === null) {
		return { entries: [], proxy: {}, define: {} };
	}

	const entries: DispatchEntry[] = [];
	const proxy: Record<string, { readonly target: string; readonly changeOrigin: true }> = {};
	const define: Record<string, string> = {};

	for (const ep of context.endpoints.all()) {
		entries.push({
			name: ep.name,
			url: ep.url,
			wireProtocol: ep.wireProtocol,
			pluginKey: ep.pluginKey,
			endpointKey: ep.endpointKey,
		});

		// Reverse-proxy path. `__devstack` prefix mirrors the
		// codegen-emitted endpoint constants so apps can pivot between
		// same-origin (dev) and direct-origin (prod) without changing
		// their fetch URLs.
		proxy[`/__devstack/endpoint/${ep.name}`] = {
			target: ep.url,
			changeOrigin: true,
		};

		const constantName = `__DEVSTACK_ENDPOINT_${endpointNameToConstant(ep.name)}__`;
		define[constantName] = JSON.stringify(ep.url);
	}

	return { entries, proxy, define };
};

/** Normalize an endpoint name into the `define` constant suffix.
 *  Endpoint names are kebab-case (`sui-rpc`); constants are
 *  uppercase-snake (`SUI_RPC`). */
const endpointNameToConstant = (name: string): string =>
	name.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
