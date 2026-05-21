// Entrypoint registry — a process-global allowlist of named host
// ports the Traefik container will listen on.
//
// Architecture invariants:
//   #6  — Routables select an entrypoint by *name* from a closed set
//          populated at module-load time. The set is read ONCE at
//          router launch.
//   #12 — Every entrypoint is plain HTTP / h2c / TCP; no TLS surface.
//          TCP entrypoints bind a host port and dispatch raw bytes to a
//          single backend (postgres, redis, …); they cannot share the
//          port across parallel stacks because TCP has no virtual-host
//          concept. HTTP/h2c entrypoints DO share ports via Host-header
//          dispatch.
//
// The registry is intentionally a typed Context service (Effect v4
// idiom) rather than a module-mutable map: that lets tests build a
// fresh registry per scenario, lets the orchestrator carry the
// registration set forward immutably, and removes the
// `ATTACHED_FOLLOWERS`-style hidden globals the architecture's
// "What's NOT in it" section forbids.
//
// Construction surface:
//   `makeEntrypointRegistry(...)` — pure constructor; throws synchronously
//   on conflict registration (architecture invariant #6 is "throw at
//   registration time", not at acquire time).
//
// Lookup surface:
//   `EntrypointRegistry.byName(name)` — typed yieldable that fails
//   `UnknownEntrypoint` if the caller spliced an unregistered name.

import { Context, Effect, Layer } from 'effect';

import { EntrypointConflict, UnknownEntrypoint } from './errors.ts';

/** A named entrypoint — a host port the Traefik container binds and
 *  listens on. `http`/`h2c` entrypoints support Host-header dispatch
 *  (one port → many backends). `tcp` entrypoints are point-to-point
 *  (one port → one backend) — siblings dial them directly. */
export interface Entrypoint {
	readonly name: string;
	readonly port: number;
	readonly protocol: 'http' | 'h2c' | 'tcp';
}

/** Registry shape. Closed map from name → entrypoint; the orchestrator
 *  freezes this at boot and reads it for the Traefik `--entrypoints.*`
 *  CLI flags. */
export interface EntrypointRegistryShape {
	readonly byName: (name: string) => Effect.Effect<Entrypoint, UnknownEntrypoint>;
	readonly all: () => ReadonlyArray<Entrypoint>;
}

export class EntrypointRegistry extends Context.Service<
	EntrypointRegistry,
	EntrypointRegistryShape
>()('@devstack-rewrite/orchestrators/router/EntrypointRegistry') {}

/** Build a registry from a literal seed. Idempotent on identical
 *  `(name, port, protocol)` triples; throws synchronously on conflict
 *  per architecture invariant #6. The reason this is synchronous
 *  rather than yielded: registration is module-load wiring, not a
 *  runtime effect — the failure mode is "two callers wired the same
 *  name to different ports", which is a build-time bug. */
export const makeEntrypointRegistry = (
	seed: ReadonlyArray<Entrypoint>,
): EntrypointRegistryShape => {
	const map = new Map<string, Entrypoint>();
	for (const e of seed) {
		const existing = map.get(e.name);
		if (existing) {
			if (existing.port === e.port && existing.protocol === e.protocol) continue;
			throw new EntrypointConflict({
				name: e.name,
				existing: { port: existing.port, protocol: existing.protocol },
				attempted: { port: e.port, protocol: e.protocol },
			});
		}
		map.set(e.name, e);
	}
	const frozen: ReadonlyArray<Entrypoint> = Array.from(map.values());
	return {
		byName: (name) => {
			const hit = map.get(name);
			if (hit) return Effect.succeed(hit);
			return Effect.fail(
				new UnknownEntrypoint({
					name,
					known: frozen.map((e) => e.name),
				}),
			);
		},
		all: () => frozen,
	};
};

/** Layer that pins the registry from a literal seed. The orchestrator
 *  takes this as a substrate dependency; plugins do NOT mutate the
 *  registry — they pick names from it via their Routable contributions. */
export const layerEntrypointRegistry = (
	seed: ReadonlyArray<Entrypoint>,
): Layer.Layer<EntrypointRegistry> =>
	Layer.succeed(EntrypointRegistry)(makeEntrypointRegistry(seed));

/** The default well-known entrypoint set. Names match the existing
 *  devstack convention so plugin Routables don't have to be rewritten
 *  when the file-provider router lands. Each entrypoint binds a fixed
 *  host port (`*.localhost` resolves to 127.0.0.1; Host: header
 *  dispatches per stack).
 *
 *  The port choices preserve the legacy assignments documented in the
 *  distilled component docs (walrus 9185, seal 2024, deepbook 9008,
 *  wallet 6173, etc). Renumbering is a follow-up. */
export const DEFAULT_ENTRYPOINTS: ReadonlyArray<Entrypoint> = [
	// Wallet host-process server.
	{ name: 'wallet-app', port: 6173, protocol: 'http' },
	// Walrus cluster — N node entrypoints plus aliases. The router
	// orchestrator iterates Routable decls; the entrypoints below
	// cover all-aliases (aggregator/publisher) which collapse onto a
	// shared host port. Per-node distinct hostnames mean a SINGLE host
	// port can serve N nodes via Host-header dispatch.
	{ name: 'walrus-node-0', port: 9185, protocol: 'http' },
	{ name: 'walrus-node-1', port: 9185, protocol: 'http' },
	{ name: 'walrus-node-2', port: 9185, protocol: 'http' },
	{ name: 'walrus-node-3', port: 9185, protocol: 'http' },
	{ name: 'walrus-aggregator', port: 9185, protocol: 'http' },
	{ name: 'walrus-publisher', port: 9185, protocol: 'http' },
	// Seal key-server (port shared across stacks; Host-header dispatch).
	{ name: 'seal-key-server', port: 2024, protocol: 'http' },
	// Deepbook server + metrics.
	{ name: 'deepbook-server', port: 9008, protocol: 'http' },
	{ name: 'deepbook-server-metrics', port: 9186, protocol: 'http' },
	{ name: 'deepbook-indexer-metrics', port: 9184, protocol: 'http' },
	// TCP backends. Each one binds a single host port — they cannot
	// share the port via Host-header dispatch (TCP has no Host concept).
	// The ports below match the upstream container's well-known port so
	// the in-network dial-string and the router-fronted dial-string
	// agree on `:<port>`; parallel stacks of postgres/redis are NOT
	// supported through these entrypoints (they'd collide on the host
	// port). Stacks that need parallel TCP backends should set
	// `opts.route: false` and dial the container in-network directly.
	{ name: 'postgres-tcp', port: 5432, protocol: 'tcp' },
	{ name: 'redis-tcp', port: 6379, protocol: 'tcp' },
];
