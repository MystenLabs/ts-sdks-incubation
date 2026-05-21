// Typed `StackContext` — the result of reading the manifest envelope
// from disk and projecting it for consumer code.
//
// Shape mirrors the envelope (`identity`, `services`, `endpoints`,
// `extras`) without re-exporting the substrate's writer-only types
// (`PluginManifestContribution`, etc). Consumers see:
//
//   - The identity tuple they keyed off (for assertions / display).
//   - A typed `EndpointRegistry` for `byName` / `byKind` lookups (the
//     load-bearing query the Vite alias + Playwright `baseURL`
//     resolvers run).
//   - The opaque `services` and `extras` records — each plugin's
//     Codegenable contribution emits a typed file for the per-service
//     slice; consumers reach for those, not the raw map.
//   - The absolute manifest path the projection came from (so error
//     messages and re-reads can name it).
//   - The `manifestVersion` (so consumers that gate on version can do
//     so explicitly rather than via a duplicate decoded copy).
//
// PLAIN TS shape — no `Schema`, no `Effect`. The read-path is a
// sync-blocking surface; apps and Playwright config-load both rely on
// not introducing Effect into their runtime.

import type { EndpointRegistry } from './endpoint-registry.ts';

/** Identity tuple — mirrors `ManifestEnvelope['identity']` from the
 *  substrate. Re-stated here so consumer code doesn't reach into the
 *  substrate package. */
export interface StackIdentity {
	readonly app: string;
	readonly stack: string;
	readonly chain: string;
}

/** Flat endpoint entry exposed to consumers. Mirrors the substrate's
 *  `EndpointEntry` but uses plain strings (no `Brand<>`) so callers
 *  don't need to import the substrate's branded types. */
export interface ResolvedEndpoint {
	readonly name: string;
	readonly url: string;
	readonly displayUrl: string | null;
	readonly wireProtocol: string;
	readonly pluginKey: string;
	readonly endpointKey: string;
}

/** Read-only projection of the manifest. Consumers — Vite preset
 *  alias, Playwright `baseURL` / `webServer`, codegen emitters that
 *  read their own slice, the CLI's `status` command — key off the
 *  fields here.
 *
 *  Field shape is deliberately a SUPER-SET of "what the substrate
 *  schema decoded": discovery surfaces add the resolved `manifestPath`
 *  and the typed `endpoints` registry that wraps the flat map. */
export interface StackContext {
	/** Stack identity — name / app / chain. */
	readonly identity: StackIdentity;
	/** Absolute path to the on-disk manifest the projection derives
	 *  from. Used by error messages and by callers that want to watch
	 *  the file. */
	readonly manifestPath: string;
	/** Envelope schema version pinned by the substrate. Consumers
	 *  forwarding to per-version migration paths gate on this. */
	readonly manifestVersion: number;
	/** Typed endpoint registry — `byName(name)` returns the
	 *  `ResolvedEndpoint` (or `undefined`); `all()` lists them; group
	 *  helpers (`byPluginKey`, `byKind`) live on the registry too. */
	readonly endpoints: EndpointRegistry;
	/** Per-plugin opaque service slices — keyed by `pluginKey`. The
	 *  typed per-service shape lives in each plugin's Codegenable
	 *  output, not here. */
	readonly services: Readonly<Record<string, unknown>>;
	/** Per-plugin opaque extras — keyed by `pluginKey`. */
	readonly extras: Readonly<Record<string, unknown>>;
}
