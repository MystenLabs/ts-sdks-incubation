// Shared Traefik v3 router — idempotent boot of the cross-stack
// reverse-proxy infrastructure.
//
// One Traefik container lives across stacks, attached to the
// `devstack-router` network. Every primitive that wants HTTP exposure
// joins the same network and the supervisor writes one file-provider
// YAML per (id, hostname, entrypoint, upstream URL) tuple. Traefik is
// **file-provider only** — every backend (docker or host) flows
// through the same path:
//
//   - File provider: YAMLs under `~/.devstack/traefik/dynamic/`.
//     Used for host processes (vite dev-server, wallet-app) AND for
//     docker containers. Traefik watches the directory and reloads
//     on change.
//
// Why no docker-provider:
//   Containers attach to two networks: a per-stack one (the `--network`
//   on `docker run`) and `devstack-router` (added via `docker network
//   connect` AFTER `docker run` completes). The docker-provider's
//   container-events listener fires on the FIRST event — at which
//   point the container has only its per-stack IP, not the router IP.
//   Traefik captures the wrong URL and never re-fetches, so every
//   request hangs/404s until somebody manually `docker restart`s the
//   router. The fix: supervisor knows the router-network IP AFTER
//   `docker network connect` returns, so it writes a deterministic
//   file-provider YAML with the resolved upstream URL. Same code path
//   for docker and host backends; no race window.
//
// Lifecycle:
//   - First `pnpm dev` checks for an existing `devstack-traefik`
//     container; if absent, creates the network + container. The
//     network is shared across the host's apps/stacks; the container
//     is a singleton.
//   - The finalizer is a `docker stop` (NOT rm) so the next `pnpm
//     dev` resumes it in ~1s. `docker stop` runs only when the
//     outer launch scope tears down (Ctrl-C / signal), and even
//     then is a no-op-on-already-stopped — so the router survives
//     across multiple supervisors and across `r` hot-restart cycles.
//   - Full teardown is the job of `devstack prune --include-router`.

import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import * as nodeFs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';
import { writeFileAtomic } from '../../engine/atomic-write.js';
import { DockerError } from '../../engine/errors.js';
import { runCapturing, runCapturingOrFail, inspectContainerIp, type Spawner } from './core.js';

// Single shared docker network for every container that wants to be
// addressable by hostname. Traefik attaches here; every other
// container that opts in (via the `traefik` option on `Docker.run`)
// gets a second attachment to this network alongside its per-stack
// network.
export const ROUTER_NETWORK = 'devstack-router';

// Singleton traefik container name. Lives across stacks/apps; no per-
// stack composition because the router itself is the cross-stack
// glue.
export const ROUTER_CONTAINER = 'devstack-traefik';

// Pinned upstream traefik tag. v3.x is the supported major; lock to a
// specific minor so reproducibility across hosts is stable. Bump in
// lockstep with any changes to label semantics below.
export const ROUTER_IMAGE = 'traefik:v3.6';

// Host directory backing the file provider. Traefik watches it on a
// poll; primitives (vite, wallet-app) drop YAML into it at boot and
// remove on scope close.
export const routerDynamicDir = (): string =>
	process.env.DEVSTACK_ROUTER_DYNAMIC_DIR ?? joinPath(homedir(), '.devstack', 'traefik', 'dynamic');

// Fixed well-known host ports the traefik entrypoints bind. Every
// primitive that opts in lands on one of these ports; the hostname
// (Host header) disambiguates which backend gets the request. Two
// stacks of the same app coexist by mounting different hostnames on
// the same port:
//
//   port 9000 → `sui.arena.localhost`            (arena/main)
//   port 9000 → `test.sui.arena.localhost`       (arena/test)
//
// Keep the port→service mapping in lockstep with each primitive's
// `traefik.entrypoints=<name>` label below.
export interface RouterEntrypoint {
	readonly name: string;
	readonly port: number;
	/**
	 * Default wire protocol Traefik uses when dialing upstreams attached
	 * to this entrypoint. `RouterLabel.protocol` / `FileProviderEntry.protocol`
	 * can override per-route; this is what the materializer falls back to
	 * when the route doesn't specify one. Today every in-tree entrypoint
	 * defaults `'http'` except `sui-grpc` (h2c); the field is included so
	 * `dockerContainer` plugin authors registering a gRPC entrypoint can
	 * make every consumer dial h2c without each one having to remember.
	 */
	readonly defaultProtocol?: 'http' | 'h2c';
}

// -----------------------------------------------------------------------------
// Entrypoint registry — pluggable via `defineEntrypoint`
// -----------------------------------------------------------------------------
//
// In-tree services pre-register their entrypoints at module init via the
// `defineEntrypoint` calls below; out-of-tree plugin authors using
// `dockerContainer` call `defineEntrypoint` from
// their own module top-level so their entrypoint is present before
// `ensureRouter` runs.
//
// NOTE: these are traefik entrypoint names — a separate contract from
// `runtime/endpoint-names.ts`'s `EndpointName` registry. Three values
// (`sui-rpc`, `sui-faucet`, `sui-graphql`) coincidentally match because
// the supervisor uses the same string for both labels; the rest
// (`walrus`, `seal`, `wallet`, `vite`, …) intentionally differ. Don't
// import `EndpointName` here — the registries serve different audiences.
//
// Consumed at:
//   - `routerEntrypoint` — lookup by name for label validation.
//   - `runRouterFresh` port-publish loop — generates `-p` flags.
//   - `runRouterFresh` entrypoint-address loop — generates
//     `--entrypoints.<name>.address=:<port>` traefik flags.
//
// Registration races: callers must register BEFORE `ensureRouter` runs.
// `ensureRouter` reads the registry once at boot — if a plugin adds an
// entrypoint after the router is already started, the traefik container
// won't know about it and the route will 404 until a recreate. We
// don't enforce this at the type level (module load order is naturally
// before supervisor boot); a `defineEntrypoint` after `ensureRouter`'s
// runRouterFresh is a programming error the plugin author needs to fix.

const entrypoints = new Map<string, RouterEntrypoint>();

/**
 * Register a new router entrypoint. Plugin-author primitive surfaced
 * through `@mysten-incubation/devstack/advanced` so `dockerContainer`
 * users can add their own traefik entrypoint without editing the closed
 * array that used to live here.
 *
 * Idempotent on `(name, port)`: re-registering the same entry is a
 * no-op so module reloads under `pnpm dev` don't throw. Conflicting
 * registration (same name, different port) throws synchronously — the
 * registry is single source of truth, silently overwriting would let
 * two callers fight over the same name and both lose.
 */
export const defineEntrypoint = (entry: RouterEntrypoint): void => {
	const existing = entrypoints.get(entry.name);
	if (existing !== undefined) {
		if (existing.port !== entry.port || existing.defaultProtocol !== entry.defaultProtocol) {
			throw new Error(
				`router: defineEntrypoint('${entry.name}') conflicts with prior registration ` +
					`(have port=${existing.port} defaultProtocol=${existing.defaultProtocol ?? 'http'}, ` +
					`new port=${entry.port} defaultProtocol=${entry.defaultProtocol ?? 'http'})`,
			);
		}
		return;
	}
	entrypoints.set(entry.name, entry);
};

/**
 * Lookup the registered entrypoint for `name`. Returns `undefined` if no
 * entrypoint matches — primitives that depend on a known entrypoint
 * should treat undefined as a hard error and fail with a typed
 * `*Error({phase: 'router-entrypoint'})`, not silently fall through.
 */
export const routerEntrypoint = (name: string): RouterEntrypoint | undefined =>
	entrypoints.get(name);

/**
 * Snapshot of all currently-registered entrypoints. Read by
 * `runRouterFresh` to compose the router `docker run` flags. Returned
 * as a fresh array so the caller can't mutate the registry by
 * accident.
 */
export const listEntrypoints = (): ReadonlyArray<RouterEntrypoint> =>
	Array.from(entrypoints.values());

// In-tree entrypoint registrations. Each call is the canonical place to
// declare a port that's bound by the shared traefik container. Plugin
// authors call `defineEntrypoint` from their own module so their
// registration lands at module load time (before `ensureRouter`).
defineEntrypoint({ name: 'sui-rpc', port: 9000 });
defineEntrypoint({ name: 'sui-faucet', port: 9123 });
defineEntrypoint({ name: 'sui-graphql', port: 9125 });
// `sui-grpc` is the data-plane + admin port for `sui-fork` (the
// `sui-rpc-api` tonic server registers BOTH `sui.rpc.v2.*` and
// `sui.forking.v1alpha.ForkingService` on the same listener — see
// `crates/sui-fork/src/startup.rs:192-198`). Picked 50051 to align
// with the canonical gRPC well-known port (and because it's free
// in the existing port map). Routes default to `protocol: 'h2c'` so
// Traefik forwards HTTP/2 cleartext through to the fork container;
// every other entrypoint inherits the `'http'` default.
defineEntrypoint({ name: 'sui-grpc', port: 50051, defaultProtocol: 'h2c' });
defineEntrypoint({ name: 'walrus', port: 9185 });
defineEntrypoint({ name: 'seal', port: 2024 });
defineEntrypoint({ name: 'wallet', port: 5180 });
defineEntrypoint({ name: 'vite', port: 5175 });
// DeepBook indexer Prometheus metrics endpoint. The Rust indexer
// binary exposes /metrics on port 9184.
defineEntrypoint({ name: 'deepbook-indexer-metrics', port: 9184 });
// DeepBook server REST API + Prometheus metrics. The Rust server
// binary exposes the REST API on 9008 and
// /metrics on 9186 — picked because 9184 is owned by the indexer's
// metrics and 9185 is owned by walrus's storage REST. (The plan
// originally proposed 9185 for the server metrics, but walrus already
// holds that port; 9186 keeps the metrics flowing without collision.)
defineEntrypoint({ name: 'deepbook-server', port: 9008 });
defineEntrypoint({ name: 'deepbook-server-metrics', port: 9186 });

// Idempotent: probe for the router container; if running, return.
// Otherwise ensure the network exists, then create + start the
// container. Best-effort across the entire flow — a failure here is
// surfaced as a typed `DockerError` so callers can choose to abort
// boot OR continue (today we abort; the router is on the critical
// path for endpoint resolution).
//
// Idempotency model mirrors `Docker.run`'s reuse-if-healthy:
//   - existing && running && same image → no-op
//   - existing && stopped                → `docker start`
//   - missing                            → create network + run
//   - existing && different image        → `docker rm -f` + recreate
//
// We DON'T go through `Docker.run` because the router has no
// `Identity` (it's cross-stack) and the labels we want differ:
// `devstack.router=true` rather than `devstack.app/.stack/.action`.

export const ensureRouter: Effect.Effect<
	void,
	DockerError,
	ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

	// 1. Network — idempotent. Don't fail if it exists; just
	//    surface other docker errors so the caller can decide.
	yield* ensureRouterNetwork(spawner);

	// 2. File-provider dynamic dir — must exist before traefik
	//    starts or it logs noisily about a missing watch target.
	yield* ensureDynamicDir();

	// 2a. Singleton CORS middleware — load before any backend that
	//     references it. Walrus storage nodes don't emit CORS headers
	//     themselves, so browser-side fetches get blocked by same-
	//     origin without this middleware.
	yield* writeCorsMiddleware();

	// 3. Container — probe → adopt|resume|recreate|fresh.
	const inspected = yield* inspectRouter(spawner);
	if (inspected === null) {
		yield* runRouterFresh(spawner);
		return;
	}
	if (inspected.image !== ROUTER_IMAGE) {
		yield* Effect.logInfo(
			`devstack: traefik router image mismatch (have=${inspected.image}, want=${ROUTER_IMAGE}); recreating`,
		);
		yield* runCapturing(
			spawner,
			ChildProcess.make('docker', ['rm', '-f', ROUTER_CONTAINER]),
			'docker rm router',
		).pipe(Effect.ignore);
		yield* runRouterFresh(spawner);
		return;
	}
	if (inspected.running) {
		yield* Effect.annotateCurrentSpan({ 'router.action': 'adopt' });
		return;
	}
	yield* Effect.annotateCurrentSpan({ 'router.action': 'resume' });
	const startResult = yield* runCapturing(
		spawner,
		ChildProcess.make('docker', ['start', ROUTER_CONTAINER]),
		'docker start router',
	).pipe(Effect.catchTag('DockerError', () => Effect.succeed(null)));
	if (startResult === null || startResult.exitCode !== 0) {
		yield* Effect.logWarning(`devstack: router 'docker start' failed; recreating from scratch`);
		yield* runCapturing(
			spawner,
			ChildProcess.make('docker', ['rm', '-f', ROUTER_CONTAINER]),
			'docker rm router',
		).pipe(Effect.ignore);
		yield* runRouterFresh(spawner);
	}
}).pipe(Effect.withSpan('Docker.ensureRouter'));

// Best-effort directory creation. Uses node:fs/promises directly so we
// don't drag a `FileSystem.FileSystem` dep through the router boot
// (which runs before the rest of the layer is built). Any error
// surfaces as a `DockerError` for uniformity with the rest of the
// router path.
const ensureDynamicDir = (): Effect.Effect<void, DockerError> =>
	Effect.tryPromise({
		try: () => nodeFs.mkdir(routerDynamicDir(), { recursive: true }),
		catch: (cause) =>
			new DockerError({
				phase: 'router.dynamic-dir',
				message: `failed to ensure traefik dynamic dir at ${routerDynamicDir()}`,
				cause,
			}),
	}).pipe(Effect.asVoid);

const ensureRouterNetwork = (spawner: Spawner): Effect.Effect<void, DockerError> =>
	Effect.gen(function* () {
		const existing = yield* runCapturing(
			spawner,
			ChildProcess.make('docker', ['network', 'ls', '-q', '--filter', `name=^${ROUTER_NETWORK}$`]),
			'docker network ls router',
		);
		if (existing.stdout.trim().length > 0) return;
		yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', [
				'network',
				'create',
				'--label',
				'devstack.router=true',
				ROUTER_NETWORK,
			]),
			'docker network create router',
		);
	});

const inspectRouter = (
	spawner: Spawner,
): Effect.Effect<{ readonly running: boolean; readonly image: string } | null, never> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('docker', [
			'inspect',
			'--format',
			'{{.State.Running}}|{{.Config.Image}}',
			ROUTER_CONTAINER,
		]);
		const captured = yield* runCapturing(spawner, cmd, 'docker inspect router').pipe(
			Effect.catchTag('DockerError', () => Effect.succeed(null)),
		);
		if (captured === null || captured.exitCode !== 0) return null;
		const line = captured.stdout.trim();
		const parts = line.split('|');
		if (parts.length !== 2) return null;
		const [runningStr, image] = parts as [string, string];
		if (image.length === 0) return null;
		return { running: runningStr === 'true', image };
	});

const runRouterFresh = (spawner: Spawner): Effect.Effect<void, DockerError> =>
	Effect.gen(function* () {
		const dynDir = routerDynamicDir();
		const eps = listEntrypoints();
		const portFlags: Array<string> = [];
		for (const ep of eps) {
			portFlags.push('-p', `127.0.0.1:${ep.port}:${ep.port}`);
		}
		// Traefik dashboard on 8080 — local debug surface; off-host
		// not exposed. No auth (local dev only).
		portFlags.push('-p', '127.0.0.1:8080:8080');

		// File-provider only — no docker.sock mount, no `--providers.docker`.
		// See the architecture comment at the top of this file for why
		// the docker provider was removed (IP race with two-network
		// container attachment).
		const args: Array<string> = [
			'run',
			'-d',
			'--name',
			ROUTER_CONTAINER,
			'--restart',
			'unless-stopped',
			'--label',
			'devstack.router=true',
			'--network',
			ROUTER_NETWORK,
			...portFlags,
			'-v',
			`${dynDir}:/etc/traefik/dynamic:ro`,
			ROUTER_IMAGE,
			'--api.insecure=true',
			'--providers.file.directory=/etc/traefik/dynamic',
			'--providers.file.watch=true',
		];
		for (const ep of eps) {
			args.push(`--entrypoints.${ep.name}.address=:${ep.port}`);
		}

		yield* runCapturingOrFail(spawner, ChildProcess.make('docker', args), 'docker run router');
	});

// Per-backend router entry. The caller (`Docker.run` for docker
// containers, host-process / wallet-app for host backends) supplies
// one `RouterLabel` per service; the supervisor materializes each as
// a file-provider YAML. Multi-port primitives (e.g. sui-localnet
// exposing rpc/faucet/graphql) pass one entry per service.
//
// Naming kept as `RouterLabel` for API stability — the type predates
// the file-provider pivot when these used to be stamped as
// `traefik.*` labels on the container. The shape (id, hostname,
// entrypoint, servicePort) is unchanged.
export interface RouterLabel {
	/** Unique router/service id (e.g. `arena-main-sui-rpc`). */
	readonly id: string;
	/** Hostname that should match (e.g. `sui.arena.localhost`). */
	readonly hostname: string;
	/** Entrypoint name (must match a name registered via
	 *  `defineEntrypoint`). */
	readonly entrypoint: string;
	/** Internal container port the upstream service is bound to. */
	readonly servicePort: number;
	/**
	 * Inject the global `devstack-cors` middleware (permissive CORS
	 * headers) into this route. Set for upstream services that don't
	 * emit CORS themselves and are dialed cross-origin from a vite
	 * dev-server — walrus storage nodes, primarily. Default `false`.
	 */
	readonly cors?: boolean;
	/**
	 * Wire-level protocol Traefik should speak to the upstream. Defaults
	 * to `'http'` (HTTP/1.1 + opportunistic HTTP/2 over TLS upgrade —
	 * what every JSON/REST backend wants). Set `'h2c'` for gRPC
	 * upstreams that serve HTTP/2 cleartext on a bare TCP port (no TLS,
	 * no Upgrade header). `sui-fork` is the primary consumer — its
	 * gRPC server speaks h2c so Traefik must dial it as `h2c://…`
	 * instead of plain `http://…`. Other entrypoints unchanged.
	 */
	readonly protocol?: 'http' | 'h2c';
}

// File-provider YAML body for host processes (vite, wallet-app) that
// can't be discovered via the docker provider. Caller writes this to
// `~/.devstack/traefik/dynamic/<id>.yml` on boot and removes on scope
// close.
export interface FileProviderEntry {
	readonly id: string;
	readonly hostname: string;
	readonly entrypoint: string;
	/** Loopback URL of the host process (e.g. `http://host.docker.internal:5175`). */
	readonly upstreamUrl: string;
	/**
	 * When true, inject the `devstack-cors` middleware into this
	 * router. The middleware is defined globally by `writeCorsMiddleware`
	 * (called once at router boot) and adds permissive CORS headers
	 * (`Access-Control-Allow-Origin: *`, etc.) to upstream responses.
	 *
	 * Walrus storage nodes need this: their REST API doesn't emit CORS
	 * headers, so browser-side fetches to
	 * `walrus-node-N.<app>.localhost:9185/v1/blobs/…` get blocked by
	 * the browser's same-origin policy without this.
	 *
	 * Sui RPC + faucet + GraphQL emit their own CORS headers; vite +
	 * wallet-app are loopback dev servers that don't need cross-origin
	 * access. Default `false`.
	 */
	readonly cors?: boolean;
	/**
	 * Wire-level protocol Traefik should speak to the upstream service.
	 * Default `'http'` (HTTP/1.1, the existing behavior). Set `'h2c'`
	 * when the backend is an HTTP/2 cleartext server (no TLS, no
	 * Upgrade header) — Traefik needs the `h2c://` URL scheme to
	 * negotiate HTTP/2 directly with the upstream. `sui-fork`'s gRPC
	 * server is the only `'h2c'` consumer in-tree today; other
	 * entrypoints inherit the `'http'` default. Set on the matching
	 * `RouterLabel`; `materializeRouterEntries` in `docker/core.ts`
	 * threads it through to this struct.
	 */
	readonly protocol?: 'http' | 'h2c';
}

// Middleware reference list for a router. When `cors === true`, point
// at the singleton `devstack-cors@file` middleware. Traefik discovers
// the middleware via the static YAML written by `writeCorsMiddleware`
// at router boot.
const routerMiddlewares = (entry: FileProviderEntry): string =>
	entry.cors === true ? '      middlewares: ["devstack-cors@file"]\n' : '';

// FileProviderEntry fields land inside backtick-quoted Host() rules and
// double-quoted YAML strings. Reject any character that could break out
// of those quotings before we splice them in. Hostnames, ids, and
// entrypoints are all controlled by upstream factories; any failure here
// is a programming error in the caller, not a transient.
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;
const SAFE_HOSTNAME_RE = /^[A-Za-z0-9.-]+$/;
const SAFE_ENTRYPOINT_RE = /^[A-Za-z0-9_-]+$/;
// `upstreamUrl` lands inside a double-quoted YAML scalar; reject `"` /
// backslash / control chars that would break the quoting. Other URL
// special chars (`:`, `/`, `?`, `=`, `&`) are fine.
const validateUpstreamUrl = (url: string): void => {
	if (url.length === 0) throw new Error('router: upstreamUrl must not be empty');
	for (const ch of url) {
		const code = ch.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) {
			throw new Error(`router: upstreamUrl contains control char (U+${code.toString(16)})`);
		}
		if (ch === '"' || ch === '\\') {
			throw new Error(`router: upstreamUrl contains forbidden char ${ch}`);
		}
	}
};

const validateEntry = (entry: FileProviderEntry): void => {
	if (!SAFE_ID_RE.test(entry.id)) {
		throw new Error(`router: id '${entry.id}' contains forbidden chars`);
	}
	if (!SAFE_HOSTNAME_RE.test(entry.hostname)) {
		throw new Error(`router: hostname '${entry.hostname}' contains forbidden chars`);
	}
	if (!SAFE_ENTRYPOINT_RE.test(entry.entrypoint)) {
		throw new Error(`router: entrypoint '${entry.entrypoint}' contains forbidden chars`);
	}
	validateUpstreamUrl(entry.upstreamUrl);
};

export const renderFileProvider = (entry: FileProviderEntry): string => {
	validateEntry(entry);
	return [
		'http:',
		'  routers:',
		`    ${entry.id}:`,
		`      rule: "Host(\`${entry.hostname}\`)"`,
		`      entrypoints: ["${entry.entrypoint}"]`,
		`      service: ${entry.id}`,
		routerMiddlewares(entry).trimEnd(),
		'  services:',
		`    ${entry.id}:`,
		'      loadBalancer:',
		'        servers:',
		`          - url: "${entry.upstreamUrl}"`,
		'',
	]
		.filter((line) => line !== '')
		.join('\n');
};

// Singleton CORS middleware YAML. Written to `~/.devstack/traefik/dynamic/_devstack-cors.yml`
// once at router boot — the leading underscore sorts it ahead of
// per-stack entries (alphabetical) so traefik picks the middleware up
// before any router that references it.
const CORS_MIDDLEWARE_YAML = `http:
  middlewares:
    devstack-cors:
      headers:
        accessControlAllowOriginList:
          - "*"
        accessControlAllowMethods:
          - "GET"
          - "POST"
          - "PUT"
          - "DELETE"
          - "OPTIONS"
        accessControlAllowHeaders:
          - "*"
        accessControlExposeHeaders:
          - "*"
        accessControlMaxAge: 86400
`;

const writeCorsMiddleware = (): Effect.Effect<void, DockerError> =>
	Effect.gen(function* () {
		yield* ensureDynamicDir();
		const path = joinPath(routerDynamicDir(), '_devstack-cors.yml');
		yield* Effect.tryPromise({
			// Atomic via tmp + rename so traefik's file-provider watcher
			// never observes a half-written YAML body. A torn read on
			// startup makes traefik refuse to load any subsequent updates
			// from the same file until something else mutates it.
			try: () => writeFileAtomic(path, CORS_MIDDLEWARE_YAML),
			catch: (cause) =>
				new DockerError({
					phase: 'router.file-provider',
					message: `failed to write cors middleware YAML at ${path}`,
					cause,
				}),
		});
	});

export const writeFileProvider = (entry: FileProviderEntry): Effect.Effect<string, DockerError> =>
	Effect.gen(function* () {
		yield* ensureDynamicDir();
		const path = joinPath(routerDynamicDir(), `${entry.id}.yml`);
		yield* Effect.tryPromise({
			// Atomic write — see writeCorsMiddleware. `renderFileProvider`
			// validates `entry` and throws synchronously if any field
			// contains a YAML-breaking character, so a programming error
			// in the caller surfaces as a tagged DockerError instead of
			// an unparseable YAML body landing on disk.
			try: () => writeFileAtomic(path, renderFileProvider(entry)),
			catch: (cause) =>
				new DockerError({
					phase: 'router.file-provider',
					message: `failed to write file-provider YAML at ${path}`,
					cause,
				}),
		});
		return path;
	});

export const removeFileProvider = (id: string): Effect.Effect<void, never> =>
	Effect.tryPromise({
		try: () => nodeFs.unlink(joinPath(routerDynamicDir(), `${id}.yml`)),
		catch: () => undefined,
	}).pipe(Effect.ignore);

// -----------------------------------------------------------------------------
// Memoized traefik IP — used by host-side diagnostics / debug surfaces
// -----------------------------------------------------------------------------
//
// The traefik container's IP on `devstack-router` doesn't change during
// its lifetime, so we resolve it once per process. Callers (the file-
// provider materializer; ad-hoc tooling) can reuse the cached IP across
// repeated inspects. A plain mutable cell is sufficient: writes are
// idempotent (same IP every time docker assigns one), concurrent first-
// callers do at most a few redundant inspects before one wins, and the
// in-memory cache dies with the supervisor process — well before any
// scenario that would invalidate the IP (router container recreated via
// `devstack prune --include-router` requires `pnpm dev` restart).

let traefikRouterIpCache: string | null = null;

/**
 * Resolve traefik's IP on the `devstack-router` network. Memoized for
 * the lifetime of the process — once docker has assigned the
 * `devstack-traefik` container an IP, that IP is stable until the
 * container is recreated (which happens on `devstack prune
 * --include-router`, by which point the supervisor has torn down and
 * the in-memory cache is gone too). Fails with `DockerError` if the
 * inspect retries are exhausted (e.g. traefik isn't attached to the
 * router network yet — the supervisor calls `ensureRouter` before any
 * primitive that would consume this, so the failure mode is a bug
 * upstream, not a transient).
 */
export const getTraefikRouterIp = (spawner: Spawner): Effect.Effect<string, DockerError> =>
	Effect.gen(function* () {
		if (traefikRouterIpCache !== null) return traefikRouterIpCache;
		const ip = yield* inspectContainerIp(spawner, ROUTER_CONTAINER, ROUTER_NETWORK);
		traefikRouterIpCache = ip;
		return ip;
	});

// Test-only reset of the memoization cell. Lets the spawner-recorder
// tests assert that `getTraefikRouterIp` only docker-inspects once
// across N consecutive calls without leaking memoized state across
// unrelated test cases. Not exported from the docker barrel.
export const resetTraefikRouterIpCacheForTesting = (): void => {
	traefikRouterIpCache = null;
};
