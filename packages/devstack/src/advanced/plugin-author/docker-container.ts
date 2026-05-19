// `dockerContainer(name, options)` — plugin-author primitive for a
// long-lived container backed by `Docker.run`.
//
// What it unifies: in-tree services (sui-localnet, sui-fork, postgres,
// walrus storage nodes, seal key-server, deepbook indexer/server) all
// hand-rolled a `Docker.run` invocation, a finalizer attachment, an
// endpoint publish, and a router-label dance. Out-of-tree plugin
// authors had no way to do the same without reaching into
// `engine/docker/core.ts` directly.
//
// One call now does it all:
//
//   - Resolves the image source (`{pull: 'postgres:15'}` or
//     `{build: {context, dockerfile, buildArgs}}`) via the shared
//     `dockerImage` helper — content-addressed build, cache hit on warm
//     restart.
//   - Starts the container via `Docker.run`, which already handles
//     name-collision sweeping, reuse-if-image-matches probing, the
//     `docker stop` finalizer on the calling primitive's layer scope,
//     and traefik label materialization.
//   - Optionally attaches one or more secondary docker networks via
//     `docker network connect` after `docker run` returns — used by
//     primitives that need their container reachable from sibling
//     services living on a different per-stack network (postgres'
//     `extraNetworks`, walrus storage nodes joining the sui per-stack
//     network for docker-DNS faucet lookups).
//   - Awaits a ready probe (HTTP, TCP, or log-match) before the tag
//     resolves so downstream services that yield this tag don't race
//     the container's HTTP server binding. When `awaitExit` is true
//     the ready probe races against `docker wait` so a container that
//     crashes during boot surfaces its log tail instead of timing out
//     blind.
//   - Optionally publishes one `EndpointName` via the EndpointRegistry
//     so the manifest / codegen / TUI see the container's URL.
//     Multi-endpoint primitives (sui-localnet's rpc/faucet/graphql,
//     deepbook-server's rest/metrics) keep publishing endpoints
//     themselves after the tag resolves — `dockerContainer` only
//     publishes when the canonical URL is unambiguous.
//
// Lifecycle: every container's `docker stop` finalizer attaches to
// the calling primitive's own layer scope. `r` (full rebuild) cascades
// finalize through every primitive in dep order; selective watch-fires
// (Phase 3 of selective-restart) release ONLY the affected primitives
// via `engine.invalidateSubset`.

import { Effect } from 'effect';
import * as Docker from '../../engine/docker.js';
import { DockerError } from '../../engine/errors.js';
import { routerEntrypoint, type RouterLabel } from '../../engine/docker/router.js';
import { Identity, type IdentityShape } from '../../engine/identity.js';
import { publishEndpoint } from '../../engine/registries.js';
import { routerHostname, routerId } from '../../engine/router-hostname.js';
import { awaitContainerReady } from '../../engine/docker/logs.js';
import { awaitReady, ReadyProbeError, type ReadyProbe } from '../../engine/ready-probe.js';
import type { OutputLineCallback } from '../../engine/docker/core.js';
import { tag, setPhase, CurrentTagKey, type LayeredTag } from '../tag.js';
import { dockerImage, type DockerImage } from './docker-image.js';

// -----------------------------------------------------------------------------
// Image source — unified union, no bare-string accepted at type level
// -----------------------------------------------------------------------------

/**
 * Image source for `dockerContainer`. Either pull a tagged image
 * (`{pull: 'postgres:15'}`) or build one from a local context
 * (`{build: {context, dockerfile?, buildArgs?, platform?}}`). The
 * `build` form is content-addressed via `dockerImage` so identical
 * inputs hit the docker cache.
 *
 * Bare-string `'postgres:15'` is INTENTIONALLY not a member of this
 * union. Plugin authors must spell out the intent — pull vs build —
 * so the same option doesn't mean both "GHCR tag" and "local image
 * built earlier" at different callsites. Phase 3.8 of the
 * api-simplification plan made this break-and-replace across every
 * in-tree image consumer.
 */
export type DockerContainerImage =
	| { readonly pull: string }
	| {
			readonly build: {
				readonly context: string;
				readonly dockerfile?: string;
				readonly buildArgs?: Record<string, string>;
				readonly platform?: string;
			};
	  };

/**
 * Extension of `DockerContainerImage` used by in-tree callsites that
 * have already materialized the image via a sibling `dockerImage(...)`
 * tag and want to consume the resolved tag without re-running the
 * image build. The `{tag: <pre-resolved tag>}` branch skips the
 * `runDockerContainer` internal image-build layer entirely — the
 * caller is responsible for surfacing the sibling image's
 * `__layers` via the surrounding composite's `extraLayers`.
 *
 * Not exposed on the user-facing `DockerContainerImage` union so a
 * plugin author can't accidentally pass a non-existent tag and
 * trigger a confusing `Docker.run` error far from the typo.
 */
export type DockerContainerImageInternal =
	| DockerContainerImage
	| { readonly tag: string };

// -----------------------------------------------------------------------------
// Mount + routing shapes
// -----------------------------------------------------------------------------

export interface DockerContainerMount {
	/**
	 * Source — either a host filesystem path (must start with `/`) or
	 * a named docker volume. Named volumes get `devstack.app` /
	 * `devstack.stack` labels stamped on first create so `devstack
	 * wipe` can find them.
	 */
	readonly source: string;
	/** Container-side absolute path the mount lands at. */
	readonly target: string;
	/**
	 * Reserved for future use. `Docker.run` does not yet plumb a
	 * `readonly` flag through to `docker run -v`; including this
	 * field on the public surface keeps callsites stable when that
	 * flag lands.
	 */
	readonly readonly?: boolean;
}

export interface DockerContainerRouting {
	/**
	 * Entrypoint name registered via `defineEntrypoint`. Picks the
	 * well-known traefik port (e.g. `'walrus'` → 9185) the public URL
	 * will land on.
	 */
	readonly entrypoint: string;
	/**
	 * In-container port the upstream service binds. Required because
	 * the container port is the address Traefik dials INSIDE the
	 * router-network, not the entrypoint's well-known host port.
	 */
	readonly servicePort: number;
	/**
	 * Optional router-id / hostname segment. Defaults to the outer
	 * `dockerContainer(name, …)` argument. Multi-route primitives
	 * (sui-localnet's rpc + faucet + graphql; deepbook-server's rest +
	 * metrics) pass distinct names per entry so each entrypoint lands
	 * on a separate stack-scoped hostname.
	 *
	 * Folded through `routerId(identity, name)` /
	 * `routerHostname(identity, name)` so the router id collision-free
	 * shape stays consistent with engine-internal callers.
	 */
	readonly name?: string;
	/**
	 * Optional hostname segment override — folded through
	 * `routerHostname(identity, hostnameName)`. Defaults to `name`
	 * (or the outer container name). Used by callsites whose router
	 * id segment differs from the hostname segment (deepbook-indexer
	 * publishes `deepbook-indexer.<app>.localhost/metrics` but keys
	 * the file-provider router on id `<app>-<stack>-deepbook-
	 * indexer-metrics` so the metrics route is uniquely identified
	 * even when sibling deepbook routes share the same hostname).
	 */
	readonly hostnameName?: string;
	/**
	 * Override the per-entrypoint default protocol. `'h2c'` for HTTP/2
	 * cleartext gRPC upstreams; `'http'` for everything else (the
	 * default). Falls back to `routerEntrypoint(entrypoint).defaultProtocol`
	 * when unset.
	 */
	readonly protocol?: 'http' | 'h2c';
	/**
	 * When true, inject the singleton `devstack-cors` middleware so
	 * the container's responses get permissive CORS headers. Walrus
	 * storage nodes are the canonical consumer.
	 */
	readonly cors?: boolean;
}

export interface DockerContainerEndpoint {
	/**
	 * Endpoint name to publish — usually one of the `EndpointName`
	 * literals from `runtime/endpoint-names.ts`. The supervisor uses
	 * this to surface the URL in the manifest, codegen, and TUI.
	 *
	 * `kind` follows the `EndpointRegistry`'s `kind` field (free-form
	 * string; common values are `'rpc'`, `'faucet'`, `'graphql'`,
	 * `'internal'`). The default is `'rpc'` — override when the
	 * container exposes a different semantic surface.
	 */
	readonly name: string;
	readonly kind?: string;
	/**
	 * When multiple `routing` entries are declared, selects which
	 * route's URL is the canonical endpoint URL. Matches the
	 * `routing[].name` field (or, when absent on the route, the outer
	 * container name). Defaults to the first routing entry.
	 */
	readonly routingName?: string;
}

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

export interface DockerContainerOptions {
	/**
	 * Image source — see `DockerContainerImage`. Plugin authors pass
	 * `{pull: 'postgres:15'}` for a registry image or
	 * `{build: {context: <abs path>}}` for a local Dockerfile build.
	 *
	 * In-tree callsites that already materialized the image via a
	 * sibling `dockerImage(...)` tag may pass `{tag: <resolved>}` so
	 * the primitive skips its internal image-build layer. Out-of-tree
	 * plugin authors stick with the `{pull}` / `{build}` shapes — the
	 * `{tag}` form requires the caller to surface the sibling image
	 * layers themselves, which is fiddly enough that the public
	 * `DockerContainerImage` type doesn't list it.
	 */
	readonly image: DockerContainerImageInternal;
	/**
	 * Argv passed to the image's entrypoint. Equivalent to the
	 * argument tail of `docker run <image> arg1 arg2 …`.
	 */
	readonly args?: ReadonlyArray<string>;
	/**
	 * Host port → container port map, `{ [hostPort]: containerPort }`.
	 * Direct host-port publishing — most plugin authors omit this and
	 * rely on `routing` for `<service>.<app>.localhost` URLs through
	 * the shared traefik router.
	 */
	readonly ports?: Readonly<Record<number, number>>;
	/**
	 * Host interface to bind published ports to. Defaults to
	 * `'127.0.0.1'`. Pass `'0.0.0.0'` when the container needs to be
	 * reachable from another host (devcontainers / WSL).
	 */
	readonly bindAddress?: string;
	/**
	 * Bind mounts and named volumes. Source paths starting with `/`
	 * are bind mounts; everything else is treated as a named volume
	 * and pre-created with devstack labels for `wipe`'s label-based
	 * sweep.
	 */
	readonly mounts?: ReadonlyArray<DockerContainerMount>;
	/**
	 * Per-stack docker network the container joins as its primary
	 * attachment. Optional — when omitted the container uses docker's
	 * default bridge. Pass an explicit name when sibling containers
	 * need to resolve this one via docker DNS (`<networkAlias>`).
	 */
	readonly network?: string;
	/**
	 * DNS alias on `network`. Requires `network` to be set. Used by
	 * sibling containers that need to dial this one by name (e.g.
	 * `postgres://my-app:5432` from a peer in the same network).
	 */
	readonly networkAlias?: string;
	/**
	 * Static IP within `network`. Requires `network` to be set —
	 * `--ip` is meaningless without `--network`. Walrus storage nodes
	 * use this to claim deterministic pinned IPs so the chain-
	 * registered committee record matches what each node actually
	 * binds to.
	 */
	readonly ip?: string;
	/**
	 * Container hostname (`--hostname`). Sets the value reported by
	 * `hostname` inside the container; useful when the workload reads
	 * its own hostname to register itself with a peer.
	 */
	readonly hostname?: string;
	/**
	 * Additional `--add-host=<host>:<ip>` entries. Defaults to
	 * `['host.docker.internal:host-gateway']` so containers on Linux
	 * can dial the host loopback the way Docker Desktop wires it on
	 * Mac/Windows. Pass `[]` to opt out entirely.
	 */
	readonly addHosts?: ReadonlyArray<string>;
	/**
	 * Secondary docker networks the container joins via
	 * `docker network connect` AFTER `docker run` returns. Use for
	 * primitives whose container has to dial siblings on a different
	 * per-stack network (postgres surfacing to deepbook's network;
	 * walrus storage nodes joining the sui per-stack network for
	 * docker-DNS faucet lookups). Attach is idempotent — the engine
	 * swallows the `endpoint already exists` failure mode.
	 */
	readonly extraNetworks?: ReadonlyArray<string>;
	/**
	 * Plaintext environment variables. Plumbed through `-e KEY=VALUE`
	 * so they surface in `docker inspect` — DO NOT use for secrets.
	 */
	readonly env?: Record<string, string>;
	/**
	 * Pre-written env files (`--env-file <path>`). Each file contains
	 * `KEY=value` lines and is read by docker without exposing the
	 * values via process env / `inspect` the way `-e KEY=value` does.
	 * Use for high-sensitivity values (master signing keys, JWT
	 * secrets) the caller has already staged to disk under 0o600
	 * perms. Files are passed to docker in the given order; later
	 * entries override earlier ones, and inline `env` entries override
	 * env-files.
	 */
	readonly envFiles?: ReadonlyArray<string>;
	/**
	 * Optional ready probe — gates the tag's resolution until the
	 * container's actual service is reachable. Without this the tag
	 * resolves as soon as `docker run` returns, which races the
	 * in-container HTTP server's `listen()`.
	 *
	 * When `awaitExit` is the default (`true`), the probe is raced
	 * against `docker wait <name>` so a container that crashes during
	 * boot surfaces its log tail in the resulting `ReadyProbeError`
	 * rather than blocking until the probe's wall-clock timeout fires.
	 * Pass `awaitExit: false` to opt out (rare — useful when the ready
	 * probe is itself expected to race the container's startup
	 * lifecycle).
	 */
	readonly ready?: ReadyProbe;
	/**
	 * When `true` (the default when `ready` is supplied), the ready
	 * probe is raced against `docker wait`. See `ready` for the
	 * rationale.
	 */
	readonly awaitExit?: boolean;
	/**
	 * Per-line output sink. When set, after the container is up
	 * `Docker.run` spawns a `docker logs --follow <id>` child whose
	 * stdout/stderr lines flow through `onOutputLine`. stdout lines
	 * arrive as `'info'`, stderr lines as `'warn'`. The follower's
	 * lifetime is bound to the container's reuseScope so it stops
	 * automatically at teardown.
	 */
	readonly onOutputLine?: OutputLineCallback;
	/**
	 * Caller-supplied docker labels. The supervisor stamps its own
	 * `devstack.app` / `devstack.stack` / compose-project labels
	 * regardless of this — these are additive metadata for the user's
	 * own filtering / tooling.
	 *
	 * Reserved knob: `Docker.run` does not yet plumb arbitrary
	 * caller labels; the field is on the public surface for forward
	 * compatibility.
	 */
	readonly labels?: Record<string, string>;
	/**
	 * Grace period in seconds for the cycle-teardown `docker stop` finalizer
	 * (maps to `docker stop --time <N>`). Containers running stateful
	 * workloads — validators, databases, indexers — should bump this above
	 * docker's default 10s so they flush state cleanly instead of getting
	 * SIGKILL'd (exit 137), which degrades the next warm-resume time.
	 */
	readonly stopGraceSeconds?: number;
	/**
	 * Engine tag-key the stop finalizer should update during teardown.
	 * Plumbed into `Docker.run` so the per-row TUI status flips
	 * `ready → stopping → stopped` as docker confirms each container
	 * exit. When omitted, defaults to the outer `name` (`runDockerContainer`'s
	 * first arg) — most primitives expose their tag key as the container
	 * name. Set explicitly when the tag key differs from the container name
	 * (e.g. composite primitives whose tag key is the aggregate but the
	 * docker name is a per-node suffix).
	 */
	readonly engineTagKey?: string;
	/**
	 * Traefik routing — single route or array of routes. When set,
	 * joins the container to the shared `devstack-router` network and
	 * writes one file-provider YAML per route so each entrypoint's
	 * host port routes to this container by Host header
	 * (`<route-name>.<app>.localhost`).
	 *
	 * Multi-route primitives pass an array so a single container
	 * surfaces several entrypoints (sui-localnet's rpc + faucet +
	 * graphql; deepbook-server's REST + metrics). Each entry's
	 * `name` segment drives the per-route hostname / id; when omitted,
	 * the outer container name is used.
	 */
	readonly routing?: DockerContainerRouting | ReadonlyArray<DockerContainerRouting>;
	/**
	 * Endpoint to publish into the EndpointRegistry. The URL is
	 * derived from `routing` (the public traefik URL for the matching
	 * route — by `routingName`, or the first route by default) or,
	 * when `routing` is unset, the first published host port from
	 * `ports`. Set this to surface the container in the manifest +
	 * codegen outputs. Multi-endpoint primitives that surface several
	 * URLs continue to call `publishEndpoint` themselves after the
	 * tag resolves.
	 */
	readonly endpoint?: DockerContainerEndpoint;
}

// -----------------------------------------------------------------------------
// Result shape
// -----------------------------------------------------------------------------

export interface DockerContainerHandle {
	/** Container id assigned by docker. */
	readonly containerId: string;
	/** Container name `<app>-<stack>-<service>`. */
	readonly name: string;
	/**
	 * The image tag the container was started with. For pull-mode
	 * this is the user-supplied tag verbatim; for build-mode this is
	 * the content-addressed `devstack-<name>:<hash>` tag.
	 */
	readonly image: string;
	/**
	 * Host-side URL when `routing` was supplied — the traefik URL
	 * `<protocol>://<service>.<app>.localhost:<entrypointPort>`. For
	 * multi-route primitives this is the URL of the first route (or
	 * the route matched by `endpoint.routingName`). `undefined` when
	 * no routing was configured.
	 */
	readonly url?: string;
	/**
	 * Per-route URL map, keyed by routing entry name (`routing[].name`
	 * — or the outer container name when omitted). Empty when no
	 * routing was configured. Multi-route primitives read this to
	 * publish per-route endpoints after the tag resolves.
	 */
	readonly urls: Readonly<Record<string, string>>;
	/**
	 * Host-port → container-port map as reported by docker. Matches
	 * `opts.ports` on a fresh spawn; on resume reflects the actual
	 * binding docker remembered.
	 */
	readonly hostPorts: Record<number, number>;
	/** `true` when `Docker.run` adopted an already-running container. */
	readonly reused: boolean;
}

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

const normalizeRouting = (
	routing: DockerContainerRouting | ReadonlyArray<DockerContainerRouting> | undefined,
): ReadonlyArray<DockerContainerRouting> => {
	if (routing === undefined) return [];
	// `ReadonlyArray<T>` doesn't satisfy TS's `Array.isArray` narrowing
	// against its element type at the call site (the union doesn't
	// distribute cleanly), so we widen the predicate to `unknown` and
	// re-narrow the two branches explicitly.
	return Array.isArray(routing)
		? (routing as ReadonlyArray<DockerContainerRouting>)
		: [routing as DockerContainerRouting];
};

/**
 * Builder form of `DockerContainerOptions`. Plugin authors that need
 * identity-derived option values (per-stack network names, identity-
 * keyed passwords, container hostnames keyed on `<app>-<stack>`) pass
 * a function so `dockerContainer` resolves `Identity` once at acquire
 * time and hands the shape to the builder. Static option objects work
 * unchanged — the union accepts both.
 */
export type DockerContainerOptionsInput =
	| DockerContainerOptions
	| ((identity: IdentityShape) => DockerContainerOptions);

/**
 * Image source variant of `DockerContainerOptions['image']`. The image
 * field has to resolve at FACTORY time (the image build layer wraps
 * the container tag and runs first), so it doesn't accept the builder-
 * form `(identity) => …` — only the static union, including the
 * in-tree `{tag}` shortcut.
 */
type StaticImage = DockerContainerImageInternal;

/**
 * Long-lived container plugin primitive. See module-level docstring
 * for the architectural rationale.
 *
 * Example:
 *
 * ```ts
 * const postgres = dockerContainer('app.postgres', {
 *   image: { pull: 'postgres:15' },
 *   env: { POSTGRES_PASSWORD: 'devstack', POSTGRES_DB: 'app' },
 *   ports: { 5432: 5432 },
 *   ready: { kind: 'tcp', port: 5432 },
 *   endpoint: { name: 'POSTGRES', kind: 'internal' },
 * });
 * ```
 *
 * Builder form for identity-keyed options:
 *
 * ```ts
 * const postgres = dockerContainer('postgres', (id) => ({
 *   image: { build: {...} },                // image MUST be static
 *   network: `devstack-${id.app}-${id.stack}-postgres`,
 *   env: { POSTGRES_PASSWORD: derive(id.stack) },
 *   ready: { kind: 'tcp', port: 5432 },
 * }));
 * ```
 */
export const dockerContainer = <const Name extends string>(
	name: Name,
	optionsInput: DockerContainerOptionsInput,
	/**
	 * Required when `optionsInput` is a builder function: the static
	 * image source that lifts the image-build layer out of identity-
	 * resolved options. Plugin authors that pass a static options
	 * object leave this undefined — the image flows in via `options.image`.
	 */
	staticImage?: StaticImage,
): LayeredTag<Name, DockerContainerHandle, any, DockerError | ReadyProbeError> => {
	const { imageTag, build } = buildContainerInternals(name, optionsInput, staticImage);

	// Surface the image sub-tag alongside this tag's own layer so
	// `composeStackLayer` builds the image before the container tag.
	// `extraLayers` does the same job as `composeLayers` would for a
	// single inner tag.
	return tag(name, build, {
		kind: 'service',
		displayTitle: name,
		// `imageTag` is undefined when the caller passed `{tag}` — the
		// image came from a sibling `dockerImage(...)` they composed
		// themselves; `dockerContainer` doesn't double-stamp the build
		// layer in that case.
		extraLayers: imageTag !== undefined ? imageTag.__layers : [],
		display: (s) => ({
			title: name,
			...(s.url !== undefined ? { primary: s.url } : { primary: s.image }),
		}),
	}) as unknown as LayeredTag<
		Name,
		DockerContainerHandle,
		any,
		DockerError | ReadyProbeError
	>;
};

/**
 * Inline Effect-only flavor of `dockerContainer` — same machinery, but
 * the caller invokes it from inside an existing `Effect.gen` body
 * rather than as a top-level `tag()`. Returns an Effect that resolves
 * to a `DockerContainerHandle` once the container is up and (if
 * configured) ready-probed.
 *
 * Use this when the surrounding factory tag (e.g. `PostgresTag`) wants
 * to translate `DockerError` / `ReadyProbeError` into a domain-specific
 * tagged error (`PostgresError`) before propagating — the tag form's
 * error union surfaces only via Layer construction, where `catchTag`
 * inside the consumer's build body can't observe it.
 *
 * The returned Effect requires `Identity` and the same
 * `ChildProcessSpawner` / `ClaimedContainers` / `EndpointRegistry`
 * services as `Docker.run` itself — all satisfied by `InfraLive`
 * in the supervisor runtime.
 *
 * The static image-build layer is NOT exposed — callers must surface
 * it themselves via the returned `imageLayers` array so the supervisor
 * builds the image before the container.
 */
export const runDockerContainer = <const Name extends string>(
	name: Name,
	optionsInput: DockerContainerOptionsInput,
	staticImage?: StaticImage,
): {
	readonly imageLayers: ReadonlyArray<import('effect').Layer.Layer<any, any, any>>;
	readonly effect: Effect.Effect<DockerContainerHandle, DockerError | ReadyProbeError, any>;
} => {
	const { imageTag, build } = buildContainerInternals(name, optionsInput, staticImage);
	return {
		imageLayers: imageTag !== undefined ? imageTag.__layers : [],
		effect: build,
	};
};

const buildContainerInternals = <Name extends string>(
	name: Name,
	optionsInput: DockerContainerOptionsInput,
	staticImage: StaticImage | undefined,
): {
	readonly imageTag: LayeredTag<string, DockerImage, any, DockerError> | undefined;
	readonly build: Effect.Effect<DockerContainerHandle, DockerError | ReadyProbeError, any>;
} => {
	// Resolve the image source for the factory-time image-build layer.
	// When the caller passes a static options object we read `options.image`
	// directly. When they pass a builder, they MUST also pass `staticImage`
	// (the image must resolve at factory time so the build layer can
	// wrap the container tag's layer).
	const optsIsBuilder = typeof optionsInput === 'function';
	const imageSource: StaticImage = optsIsBuilder
		? (staticImage ??
			(() => {
				throw new TypeError(
					`dockerContainer('${name}'): builder-form options require staticImage`,
				);
			})())
		: optionsInput.image;

	// `dockerImage` is the canonical content-addressed image builder.
	// Even for `{pull: ...}` we go through it so cache-hit metrics +
	// docker `image inspect` short-circuits flow through the same
	// path; pull-mode lands as a tagged image regardless. The `{tag}`
	// branch skips the image build entirely — the caller surfaces the
	// image via a sibling `dockerImage(...)` tag at factory time and
	// hands the resolved string through; `dockerContainer` does NOT
	// re-add an image-build layer (the sibling's `__layers` is the
	// authoritative provider).
	//
	// For `pull`-mode we hand the upstream tag through unchanged so a
	// later snapshot/restore retag finds the expected name.
	const imageTag =
		'tag' in imageSource
			? undefined
			: 'pull' in imageSource
				? dockerImage({ name: `${name}.image`, pull: imageSource.pull })
				: dockerImage({
						name: `${name}.image`,
						build: imageSource.build,
					});

	const build = Effect.gen(function* () {
		// Ambient engine tag key — set by `withEngineLifecycle` to the
		// enclosing LayeredTag's key. Plumbed into Docker.run's
		// `engineTagKey` below so the per-container stop finalizer updates
		// the right row in the TUI (and aggregate primitives like
		// walrus-cluster, which spawn N container builds under one tag,
		// converge on the same row). `CurrentTagKey`'s default value when
		// unset is the empty string; we normalize to `undefined` so
		// Docker.run treats it as "no engine update".
		const ambientTagKeyRaw = yield* CurrentTagKey;
		const ambientTagKey = ambientTagKeyRaw.length > 0 ? ambientTagKeyRaw : undefined;
		// Resolve the image — either yield the sibling `dockerImage` tag
		// (pull/build branches) or pick up the pre-resolved tag string
		// from the `{tag}` branch.
		yield* setPhase('resolving image');
		const resolved: DockerImage =
			imageTag !== undefined
				? yield* imageTag
				: ({
						tag: (imageSource as { tag: string }).tag,
						digest: '',
					} satisfies DockerImage);

		const identity = yield* Identity;

		// Resolve options. Builder-form options get the freshly-resolved
		// identity; static options are returned verbatim. The builder is
		// invoked once per acquire — values inside the returned object
		// are taken at that moment.
		const options = optsIsBuilder ? optionsInput(identity) : optionsInput;

		// Build the traefik routing entries — one `RouterLabel` per
		// declared route. Each route's `name` segment defaults to the
		// outer container `name` when omitted, matching the single-route
		// shape this primitive had originally. The per-route URL is
		// recorded in `urls[routeName]` for multi-endpoint primitives
		// that publish additional `EndpointRegistry` entries after the
		// tag resolves.
		const routes = normalizeRouting(options.routing);
		const routingLabels: Array<RouterLabel> = [];
		const urls: Record<string, string> = {};
		for (const route of routes) {
			const entrypointInfo = routerEntrypoint(route.entrypoint);
			if (entrypointInfo === undefined) {
				return yield* Effect.fail(
					new DockerError({
						phase: 'router-entrypoint',
						message:
							`dockerContainer '${name}': entrypoint '${route.entrypoint}' ` +
							`is not registered. Call defineEntrypoint(...) before composing the stack.`,
					}),
				);
			}
			const routeName = route.name ?? name;
			const hostnameName = route.hostnameName ?? routeName;
			const hostname = routerHostname(identity, hostnameName);
			const protocol =
				route.protocol ?? entrypointInfo.defaultProtocol ?? 'http';
			routingLabels.push({
				id: routerId(identity, routeName),
				hostname,
				entrypoint: route.entrypoint,
				servicePort: route.servicePort,
				...(route.cors === true ? { cors: true } : {}),
				...(route.protocol !== undefined
					? { protocol: route.protocol }
					: entrypointInfo.defaultProtocol !== undefined
						? { protocol: entrypointInfo.defaultProtocol }
						: {}),
			});
			urls[routeName] = `${protocol}://${hostname}:${entrypointInfo.port}`;
		}

		// Pick the canonical URL surfaced through `handle.url`. The
		// first declared route by default; overridden via
		// `endpoint.routingName` when the caller wants a non-first
		// route to be the canonical surface (rare — most multi-route
		// callers publish their endpoints explicitly post-acquire).
		let url: string | undefined;
		if (routes.length > 0) {
			const preferred = options.endpoint?.routingName;
			if (preferred !== undefined) {
				url = urls[preferred];
				if (url === undefined) {
					return yield* Effect.fail(
						new DockerError({
							phase: 'router-entrypoint',
							message:
								`dockerContainer '${name}': endpoint.routingName='${preferred}' ` +
								`doesn't match any routing[].name (have: ${Object.keys(urls).join(', ')})`,
						}),
					);
				}
			} else {
				const first = routes[0]!;
				url = urls[first.name ?? name];
			}
		}

		// Translate the user-facing mount shape to the engine's
		// `{host, container}` shape `Docker.run` expects. The `readonly`
		// flag is accepted on the public surface for forward
		// compatibility but not currently plumbed.
		const mounts =
			options.mounts !== undefined
				? options.mounts.map((m) => ({ host: m.source, container: m.target }))
				: undefined;

		yield* setPhase('starting container');
		const runResult = yield* Docker.run({
			name,
			image: resolved.tag,
			...(options.args !== undefined ? { args: options.args } : {}),
			...(options.env !== undefined ? { env: options.env } : {}),
			...(options.envFiles !== undefined ? { envFiles: options.envFiles } : {}),
			...(options.ports !== undefined ? { ports: options.ports } : {}),
			...(options.bindAddress !== undefined ? { bindAddress: options.bindAddress } : {}),
			...(options.network !== undefined ? { network: options.network } : {}),
			...(options.networkAlias !== undefined
				? { networkAlias: options.networkAlias }
				: {}),
			...(options.ip !== undefined ? { ip: options.ip } : {}),
			...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
			...(options.addHosts !== undefined ? { addHosts: options.addHosts } : {}),
			...(mounts !== undefined ? { mounts } : {}),
			...(routingLabels.length > 0 ? { traefik: routingLabels } : {}),
			...(options.onOutputLine !== undefined
				? { onOutputLine: options.onOutputLine }
				: {}),
			...(options.stopGraceSeconds !== undefined
				? { stopGraceSeconds: options.stopGraceSeconds }
				: {}),
			// engineTagKey for per-row teardown progress. Default to the
			// ambient `CurrentTagKey` (set by `withEngineLifecycle` when
			// the enclosing LayeredTag's build runs) so multi-container
			// primitives (walrus's 4 nodes, sui's localnet + indexer-db)
			// all converge on the SAME engine row — the last container's
			// stop marks the row as "stopped". Falls back to the outer
			// `name` when no engine tag is in scope (e.g. ad-hoc tests).
			engineTagKey: options.engineTagKey ?? ambientTagKey ?? name,
			detach: true,
		});

		// Secondary docker networks. Each `extraNetworks` entry is
		// joined via `docker network connect` AFTER `docker run`
		// returns. `Docker.networkConnect` is idempotent (silently
		// succeeds when the container is already attached) so warm-
		// restart resumes don't fail here on second-and-later cycles.
		for (const extra of options.extraNetworks ?? []) {
			yield* Docker.networkConnect(extra, runResult.containerId);
		}

		// Ready probe — gate the tag's resolution on actual readiness.
		// `awaitContainerReady` races the probe against `docker wait`
		// so a container that crashes during boot surfaces its log
		// tail in the `ReadyProbeError` instead of timing out blind.
		// Callers can opt out of the race with `awaitExit: false`
		// when the probe itself is expected to overlap container
		// startup (rare).
		if (options.ready !== undefined) {
			yield* setPhase('awaiting ready');
			const awaitExit = options.awaitExit ?? true;
			if (awaitExit) {
				yield* awaitContainerReady({
					containerName: runResult.name,
					probe: options.ready,
				});
			} else {
				yield* awaitReady(options.ready);
			}
		}

		// Endpoint publish — surface the URL in the manifest + codegen
		// + TUI. Only meaningful when we have a URL to publish; when
		// neither `routing` nor a single `ports` entry is set, skip.
		if (options.endpoint !== undefined) {
			const endpointUrl =
				url ??
				(() => {
					const entries = Object.entries(runResult.hostPorts);
					if (entries.length !== 1) return undefined;
					const [hostPort] = entries[0]!;
					return `http://127.0.0.1:${hostPort}`;
				})();
			if (endpointUrl !== undefined) {
				yield* publishEndpoint({
					name: options.endpoint.name,
					url: endpointUrl,
					kind: options.endpoint.kind ?? 'rpc',
				});
			}
		}

		return {
			containerId: runResult.containerId,
			name: runResult.name,
			image: resolved.tag,
			...(url !== undefined ? { url } : {}),
			urls,
			hostPorts: { ...runResult.hostPorts },
			reused: runResult.reused,
		} satisfies DockerContainerHandle;
	}).pipe(Effect.withSpan(`dockerContainer(${name})`));

	return {
		imageTag: imageTag as unknown as
			| LayeredTag<string, DockerImage, any, DockerError>
			| undefined,
		build,
	};
};
