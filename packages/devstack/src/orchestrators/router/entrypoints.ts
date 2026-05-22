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

import {
	SUI_FAUCET_ENDPOINT_NAME,
	SUI_FAUCET_ENTRYPOINT_PORT,
	SUI_GRAPHQL_ENDPOINT_NAME,
	SUI_GRAPHQL_ENTRYPOINT_PORT,
	SUI_RPC_ENDPOINT_NAME,
	SUI_RPC_ENTRYPOINT_PORT,
} from '../../plugins/sui/routable.ts';
import { WALLET_ENDPOINT_NAME, WALLET_ENTRYPOINT_PORT } from '../../plugins/wallet/routable.ts';
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

/** Registry shape. Closed map from declared name → canonical listener.
 *  HTTP-family declarations may share a port; Traefik still needs one
 *  listener name for that port, so aliases resolve to the first
 *  registered listener. */
export interface EntrypointRegistryShape {
	readonly byName: (name: string) => Effect.Effect<Entrypoint, UnknownEntrypoint>;
	readonly all: () => ReadonlyArray<Entrypoint>;
}

export class EntrypointRegistry extends Context.Service<
	EntrypointRegistry,
	EntrypointRegistryShape
>()('@devstack-rewrite/orchestrators/router/EntrypointRegistry') {}

const entrypointFamily = (protocol: Entrypoint['protocol']): 'http' | 'tcp' =>
	protocol === 'tcp' ? 'tcp' : 'http';

/** Build a registry from a literal seed. Idempotent on identical
 *  `(name, port, protocol)` triples; throws synchronously on conflict
 *  per architecture invariant #6. The reason this is synchronous
 *  rather than yielded: registration is module-load wiring, not a
 *  runtime effect — the failure mode is "two callers wired the same
 *  name to different ports", which is a build-time bug.
 *
 *  Traefik cannot bind multiple entrypoints to the same container port.
 *  For HTTP-family aliases on one port, keep every declared name
 *  lookupable but resolve those aliases to the first listener registered
 *  for the port. */
export const makeEntrypointRegistry = (
	seed: ReadonlyArray<Entrypoint>,
): EntrypointRegistryShape => {
	const declaredByName = new Map<string, Entrypoint>();
	const lookupByName = new Map<string, Entrypoint>();
	const listenerByPort = new Map<number, Entrypoint>();
	for (const e of seed) {
		const existing = declaredByName.get(e.name);
		if (existing) {
			if (existing.port === e.port && existing.protocol === e.protocol) continue;
			throw new EntrypointConflict({
				name: e.name,
				existing: { port: existing.port, protocol: existing.protocol },
				attempted: { port: e.port, protocol: e.protocol },
			});
		}
		declaredByName.set(e.name, e);

		const listener = listenerByPort.get(e.port);
		if (listener) {
			const listenerFamily = entrypointFamily(listener.protocol);
			const attemptedFamily = entrypointFamily(e.protocol);
			if (listenerFamily === 'tcp' || listenerFamily !== attemptedFamily) {
				throw new EntrypointConflict({
					name: e.name,
					existing: { port: listener.port, protocol: listener.protocol },
					attempted: { port: e.port, protocol: e.protocol },
				});
			}
			lookupByName.set(e.name, listener);
			continue;
		}

		listenerByPort.set(e.port, e);
		lookupByName.set(e.name, e);
	}
	const frozenListeners: ReadonlyArray<Entrypoint> = Array.from(listenerByPort.values());
	const knownNames = Array.from(declaredByName.keys());
	return {
		byName: (name) => {
			const hit = lookupByName.get(name);
			if (hit) return Effect.succeed(hit);
			return Effect.fail(
				new UnknownEntrypoint({
					name,
					known: knownNames,
				}),
			);
		},
		all: () => frozenListeners,
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
 *  distilled component docs and build integrations (app dev 5175,
 *  walrus 9185, seal 2024, deepbook 9008, wallet 6173, etc).
 *  Renumbering is a follow-up. */
export const DEFAULT_ENTRYPOINTS: ReadonlyArray<Entrypoint> = [
	// Sui local mode — router-fronted RPC/faucet/GraphQL endpoints.
	// The validator container still publishes private host ports for
	// boot probes and container-to-host gateway calls; these entrypoints
	// are the user-facing URLs exposed in manifests, codegen, and TUI.
	{ name: SUI_RPC_ENDPOINT_NAME, port: SUI_RPC_ENTRYPOINT_PORT, protocol: 'http' },
	{ name: SUI_FAUCET_ENDPOINT_NAME, port: SUI_FAUCET_ENTRYPOINT_PORT, protocol: 'http' },
	{ name: SUI_GRAPHQL_ENDPOINT_NAME, port: SUI_GRAPHQL_ENTRYPOINT_PORT, protocol: 'http' },
	// Browser app dev server. Matches the Vite cold-start URL:
	// `dev.<app>.localhost:5175` for the main stack and
	// `dev.<stack>.<app>.localhost:5175` for named stacks.
	{ name: 'dev', port: 5175, protocol: 'http' },
	// Wallet host-process server.
	{ name: WALLET_ENDPOINT_NAME, port: WALLET_ENTRYPOINT_PORT, protocol: 'http' },
	// Walrus cluster — N node entrypoint aliases plus aggregator/publisher.
	// The registry canonicalizes these to one Traefik listener on 9185;
	// per-node distinct hostnames let that single listener fan out via
	// Host-header dispatch.
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
