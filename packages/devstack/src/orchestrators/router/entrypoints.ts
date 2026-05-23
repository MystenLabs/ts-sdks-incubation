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

import type { EntrypointDecl } from '../../contracts/routable.ts';
import { EntrypointConflict, UnknownEntrypoint } from './errors.ts';

/** A named entrypoint — a host port the Traefik container binds and
 *  listens on. `http`/`h2c` entrypoints support Host-header dispatch
 *  (one port → many backends). `tcp` entrypoints are point-to-point
 *  (one port → one backend) — siblings dial them directly. */
export type Entrypoint = EntrypointDecl;

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
