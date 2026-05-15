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
//     LongLivedScope tears down (Ctrl-C / signal), and even then is
//     a no-op-on-already-stopped — so the router survives across
//     multiple supervisors and across `r` hot-restart cycles.
//   - Full teardown is the job of `devstack prune --include-router`.

import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import * as nodeFs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';
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
}
export const ROUTER_ENTRYPOINTS: ReadonlyArray<RouterEntrypoint> = [
	{ name: 'sui-rpc', port: 9000 },
	{ name: 'sui-faucet', port: 9123 },
	{ name: 'sui-graphql', port: 9125 },
	{ name: 'walrus', port: 9185 },
	{ name: 'seal', port: 2024 },
	{ name: 'wallet', port: 5180 },
	{ name: 'vite', port: 5175 },
];

export const routerEntrypoint = (name: string): RouterEntrypoint | undefined =>
	ROUTER_ENTRYPOINTS.find((e) => e.name === name);

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
	//     themselves (v3 setup relied on an nginx walrus-proxy that
	//     we deleted in favor of traefik), so browser-side fetches
	//     get blocked by same-origin without this middleware.
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
				op: 'router.dynamic-dir',
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
		const portFlags: Array<string> = [];
		for (const ep of ROUTER_ENTRYPOINTS) {
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
		for (const ep of ROUTER_ENTRYPOINTS) {
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
	/** Entrypoint name (must match one in `ROUTER_ENTRYPOINTS`). */
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
	 * headers, and the v3 setup relied on the now-deleted nginx walrus-
	 * proxy to inject them. Browser-side fetches to
	 * `walrus-node-N.<app>.localhost:9185/v1/blobs/…` get blocked by
	 * the browser's same-origin policy without this.
	 *
	 * Sui RPC + faucet + GraphQL emit their own CORS headers; vite +
	 * wallet-app are loopback dev servers that don't need cross-origin
	 * access. Default `false`.
	 */
	readonly cors?: boolean;
}

// Middleware reference list for a router. When `cors === true`, point
// at the singleton `devstack-cors@file` middleware. Traefik discovers
// the middleware via the static YAML written by `writeCorsMiddleware`
// at router boot.
const routerMiddlewares = (entry: FileProviderEntry): string =>
	entry.cors === true ? '      middlewares: ["devstack-cors@file"]\n' : '';

export const renderFileProvider = (entry: FileProviderEntry): string =>
	[
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
			try: () => nodeFs.writeFile(path, CORS_MIDDLEWARE_YAML, 'utf8'),
			catch: (cause) =>
				new DockerError({
					op: 'router.file-provider',
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
			try: () => nodeFs.writeFile(path, renderFileProvider(entry), 'utf8'),
			catch: (cause) =>
				new DockerError({
					op: 'router.file-provider',
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
	}).pipe(Effect.catch(() => Effect.void));

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
export const getTraefikRouterIp = (
	spawner: Spawner,
): Effect.Effect<string, DockerError> =>
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

