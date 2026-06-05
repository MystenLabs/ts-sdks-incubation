// Router orchestrator — the L3 service that walks `Routable`
// contributions, mints hostnames + ids, resolves upstream URLs, and
// writes file-provider config to a watched directory.
//
// Architecture distilled-doc §"Responsibilities":
//   1. Ensure exactly one Traefik container and one docker network
//      exist for the router profile. → `bootstrap()`
//   2. Maintain the profile dispatch directory mounted into that
//      singleton (one file per backend). → `contributeRoute()`
//   3. Mint per-backend hostnames + ids from `(app, stack, service)`. → `hostname.ts`
//   4. Provide a single shared, permissive CORS middleware. → `cors.ts`
//   5. Tear down per-backend dispatch entries when their owning scope
//      closes; leave the shared container running. → scope finalizers
//
// What this orchestrator DOES NOT do (architecture §"What's NOT in it"):
//   - Hardcode service names. The orchestrator iterates Routable decls,
//     resolves them by upstream-kind, and renders YAML — no `if (decl.endpointName === 'wallet')`
//     anywhere.
//   - Talk to docker directly. The Traefik container lives behind
//     `TraefikContainerOpsService`. Upstream IP resolution lives behind
//     `UpstreamResolver`. Production composition wires both seams.
//   - Hold module-level mutable state. Contribution state is a
//     `SubscriptionRef`; the shared-network-id and boot decision live
//     in fiber-scoped Refs.
//
// Hot-reload protocol:
//   - Contributions are exposed as a `SubscriptionRef<Map<dispatchFileId, RoutableDecl>>`.
//   - Each `contributeRoute(decl)` updates the ref and is paired with a
//     scope finalizer that removes the decl on scope close.
//   - A background fiber watches the ref's change stream; on each
//     emission it diffs against the last applied set and:
//       * for each ADD: resolves upstream + atomically writes the
//         dispatch file.
//       * for each REMOVE: best-effort unlinks the dispatch file.
//   - All writes go through `atomicWriteFile` (tmp + rename) per
//     architecture invariant #5.

import { Context, Effect, FileSystem, Layer, Ref, SubscriptionRef } from 'effect';
import { request as httpRequest } from 'node:http';
import * as path from 'node:path';

import type { RoutableDecl } from '../../contracts/routable.ts';
import { connect, DockerHost, DockerSpawner, waitForIp } from '../../runtime/docker/index.ts';
import { atomicWriteFile } from '../../substrate/runtime/atomic-write.ts';
import { logWarningAndIgnore } from '../../substrate/runtime/observability/index.ts';
import type { Identity } from '../../substrate/identity.ts';
import {
	checkHolderLiveness,
	layerLivenessProbeScope,
	LivenessProbeScope,
	ownHolder,
} from '../../substrate/runtime/cross-process/liveness.ts';
import { acquireStackLock } from '../../substrate/runtime/cross-process/stack-lock.ts';
import { waitForHttpEndpoint, type HttpProbeFetch } from '../../substrate/runtime/http-probe.ts';
import { IdentityContext } from '../../substrate/runtime/paths.ts';
import { CORS_MIDDLEWARE_FILENAME, renderCorsMiddlewareYaml } from './cors.ts';
import { EntrypointRegistry, type EntrypointRegistryShape } from './entrypoints.ts';
import {
	DispatchWriteFailed,
	RouteCollision,
	RouteReadinessProbeFailed,
	RouterBootFailed,
	RouterDisabledRouteUnsupported,
	RouterValidationError,
	type UnknownEntrypoint,
	type RouterError,
} from './errors.ts';
import {
	dispatchFilename,
	dispatchFileIdFromFilename,
	type DispatchRouteMetadata,
	type DispatchRouteDecodeDiagnostic,
	type ResolvedRoute,
	type ResolvedWireProtocol,
	type RouteLeaseMetadata,
	type UpstreamResolver,
	detectCollisions,
	parseDispatchRouteFile,
	renderRouteYaml,
	ROUTE_READINESS_HEADER,
	resolveRoute,
	ROUTER_ROUTE_LEASE_VERSION,
} from './file-provider.ts';
import { dispatchFileId } from './hostname.ts';
import type { RouterProfile } from './profile.ts';
import { bootstrap, type BootReport, TraefikContainerOpsService } from './traefik-container.ts';

// Router operations are shared across every stack using the same Docker
// context. The generic stack-lock default stays short for normal metadata
// mutations; router boot and dispatch can legitimately queue behind other
// devstack processes during multi-example CI or local parallel runs.
const ROUTER_LOCK_TIMEOUT_MILLIS = 120_000;

// ---------------------------------------------------------------------------
// RouterConfig — orchestrator-level knobs
// ---------------------------------------------------------------------------

/** Knobs surfaced through `defineDevstack({ router: {...} })` per
 *  distilled-doc open question #5. We model them as a typed Context
 *  service so the orchestrator reads from a single source and tests
 *  can override per scenario. */
export interface RouterConfigShape {
	/** Disable the router entirely. Only host-loopback Routables can
	 *  produce direct URLs in this mode; container upstreams require
	 *  the router's Docker network + proxy entrypoint and fail
	 *  explicitly. */
	readonly disabled: boolean;
	/** User + Docker-daemon scoped router profile. Runtime roots own
	 *  route leases; the profile owns the singleton proxy process,
	 *  dispatch directory, network name, and cross-process locks. */
	readonly profile: RouterProfile;
	/** Traefik image (tag or digest). */
	readonly image: string;
	/** Optional production gate that waits for Traefik to serve each
	 *  public HTTP route before the endpoint is published. Tests that
	 *  use the stub Traefik layer omit this. */
	readonly routeReadinessProbe?: RouteReadinessProbeConfig;
}

export interface RouteReadinessProbeConfig {
	readonly enabled: boolean;
	readonly timeoutMs?: number;
	readonly intervalMs?: number;
	readonly requestTimeoutMs?: number;
	readonly fetch?: HttpProbeFetch;
}

export class RouterConfig extends Context.Service<RouterConfig, RouterConfigShape>()(
	'@devstack/orchestrators/router/RouterConfig',
) {}

/** Default-config layer for tests. Production wires this from
 *  `orchestrators/boot.ts` at the engine boundary. */
export const layerRouterConfigLiteral = (cfg: RouterConfigShape): Layer.Layer<RouterConfig> =>
	Layer.succeed(RouterConfig)(cfg);

// ---------------------------------------------------------------------------
// UpstreamResolverService — Context wrapper around the seam
// ---------------------------------------------------------------------------

export class UpstreamResolverService extends Context.Service<
	UpstreamResolverService,
	UpstreamResolver
>()('@devstack/orchestrators/router/UpstreamResolver') {}

export const layerDockerUpstreamResolver = (
	profile: RouterProfile,
): Layer.Layer<UpstreamResolverService, never, DockerHost | DockerSpawner> =>
	Layer.effect(
		UpstreamResolverService,
		Effect.gen(function* () {
			const dockerHost = yield* DockerHost;
			const dockerSpawner = yield* DockerSpawner;
			const networkName = profile.networkName;
			const provideDocker = <A, E>(
				effect: Effect.Effect<A, E, DockerHost | DockerSpawner>,
			): Effect.Effect<A, E, never> =>
				effect.pipe(
					Effect.provideService(DockerHost, dockerHost),
					Effect.provideService(DockerSpawner, dockerSpawner),
				);

			return UpstreamResolverService.of({
				resolveContainer: (target) =>
					provideDocker(
						connect(target.containerName, networkName).pipe(
							Effect.andThen(waitForIp(target.containerName, networkName)),
						),
					).pipe(
						Effect.map((host) => ({ host, port: target.containerPort })),
						Effect.mapError(
							(cause) =>
								new RouterValidationError({
									field: 'upstreamUrl',
									value: target.containerName,
									detail: `failed to attach/read container upstream on router network: ${String(cause)}`,
								}),
						),
					),
				resolveHostLoopback: (target) =>
					Effect.succeed({ host: 'host.docker.internal', port: target.port }),
			});
		}),
	);

// ---------------------------------------------------------------------------
// Router service surface
// ---------------------------------------------------------------------------

export interface RouterServiceShape {
	/** Boot the Traefik container once per supervisor lifetime.
	 *  Idempotent. Architecture invariant #11 — caller mounts this on
	 *  the long-lived outer scope, NOT inside the hot-reload loop. */
	readonly boot: () => Effect.Effect<BootReport, RouterError>;

	/** Contribute a `RoutableDecl`. The orchestrator resolves the
	 *  upstream URL, renders the file-provider YAML, and writes it
	 *  atomically. The returned `ResolvedRoute` is the post-mint route —
	 *  the single source of truth the boot adapter (`endpointSinksFromRoute`)
	 *  derives both the manifest entry and the projection event from.
	 *
	 *  Scope-bound: when the caller's scope closes, the dispatch file
	 *  is removed (best-effort) and the contribution is dropped from the
	 *  subscribable map. */
	readonly contributeRoute: (
		decl: RoutableDecl,
	) => Effect.Effect<ResolvedRoute, RouterError, import('effect').Scope.Scope>;

	/** Subscribable view of currently-applied routes. Surfaces +
	 *  diagnostics consume this. */
	readonly applied: SubscriptionRef.SubscriptionRef<ReadonlyArray<ResolvedRoute>>;
}

export class RouterService extends Context.Service<RouterService, RouterServiceShape>()(
	'@devstack/orchestrators/router/Router',
) {}

interface DispatchRouteScanDiagnostic extends DispatchRouteDecodeDiagnostic {
	readonly path: string;
}

interface DispatchRouteScan {
	readonly routes: ReadonlyArray<DispatchRouteMetadata>;
	readonly unknownRouteFileIds: ReadonlyArray<string>;
	readonly diagnostics: ReadonlyArray<DispatchRouteScanDiagnostic>;
}

const warnDispatchDecodeDiagnostic = (
	diagnostic: DispatchRouteScanDiagnostic,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		yield* Effect.logWarning(
			`router dispatch route file ${diagnostic.path} could not be fully decoded; ` +
				`reason=${diagnostic.reason}; treating it as an unknown route lease where destructive bootstrap safety matters`,
		);
	});

const readDispatchRouteScan = (
	fs: FileSystem.FileSystem,
	dispatchDir: string,
	dispatchFileId: string,
	options: { readonly strict?: boolean } = {},
): Effect.Effect<DispatchRouteScan, DispatchWriteFailed> =>
	Effect.gen(function* () {
		const files = yield* fs.readDirectory(dispatchDir).pipe(
			Effect.mapError(
				(cause): DispatchWriteFailed =>
					new DispatchWriteFailed({
						dispatchFileId,
						path: dispatchDir,
						detail: `readDirectory(${dispatchDir}) failed`,
						cause,
					}),
			),
		);
		const routeFiles = files
			.map((filename) => ({ filename, fileId: dispatchFileIdFromFilename(filename) }))
			.filter(
				(entry): entry is { readonly filename: string; readonly fileId: string } =>
					entry.fileId !== null,
			);
		const parsed = yield* Effect.forEach(
			routeFiles,
			(entry) => {
				const filePath = path.join(dispatchDir, entry.filename);
				return fs.readFileString(filePath).pipe(
					Effect.map((body) => ({
						path: filePath,
						result: parseDispatchRouteFile(body, entry.fileId),
					})),
					Effect.mapError(
						(cause): DispatchWriteFailed =>
							new DispatchWriteFailed({
								dispatchFileId,
								path: filePath,
								detail: `readFileString(${filePath}) failed`,
								cause,
							}),
					),
				);
			},
			{ concurrency: 'unbounded' },
		);
		const routes: DispatchRouteMetadata[] = [];
		const unknownRouteFileIds: string[] = [];
		const diagnostics: DispatchRouteScanDiagnostic[] = [];
		for (const entry of parsed) {
			for (const diagnostic of entry.result.diagnostics) {
				const withPath = { ...diagnostic, path: entry.path };
				diagnostics.push(withPath);
				yield* warnDispatchDecodeDiagnostic(withPath);
			}
			if (entry.result._tag === 'valid') {
				routes.push(entry.result.route);
			} else {
				unknownRouteFileIds.push(entry.result.dispatchFileId);
			}
		}
		if (options.strict === true && diagnostics.length > 0) {
			const first = diagnostics[0];
			return yield* Effect.fail(
				new DispatchWriteFailed({
					dispatchFileId: first?.dispatchFileId ?? dispatchFileId,
					path: first?.path ?? dispatchDir,
					detail: first?.detail ?? 'dispatch route decode failed',
				}),
			);
		}
		return { routes, unknownRouteFileIds, diagnostics };
	});

type DispatchLeaseStatus = 'live' | 'stale' | 'unknown-owner';
type RoutePublishOwnership = 'direct' | 'owned' | 'reused-live';

const classifyDispatchLease = (
	route: DispatchRouteMetadata,
): Effect.Effect<DispatchLeaseStatus> => {
	if (route.lease === null) return Effect.succeed('unknown-owner');
	return checkHolderLiveness(route.lease.owner).pipe(
		Effect.map((status) => (status === 'dead' ? 'stale' : 'live')),
		Effect.catch(() => Effect.succeed('live' as const)),
	);
};

const sweepStaleDispatchRoutes = (
	fs: FileSystem.FileSystem,
	profile: RouterProfile,
	routes: ReadonlyArray<DispatchRouteMetadata>,
	dispatchFileId: string,
): Effect.Effect<ReadonlyArray<DispatchRouteMetadata>, DispatchWriteFailed> =>
	// Yield a fresh per-sweep `LivenessProbeScope` so a recycled lease
	// owner (multiple stale routes pointing at the same dead pid) forks
	// `ps`/`tasklist` AT MOST once across the loop — matches the roster
	// sweep migration in Phase 9A.
	Effect.gen(function* () {
		const probe = yield* LivenessProbeScope;
		const active: DispatchRouteMetadata[] = [];
		for (const route of routes) {
			const status: DispatchLeaseStatus =
				route.lease === null
					? 'unknown-owner'
					: yield* probe.probeHolderLiveness(route.lease.owner).pipe(
							Effect.map((s) => (s === 'dead' ? ('stale' as const) : ('live' as const))),
							Effect.catch(() => Effect.succeed('live' as const)),
						);
			if (status === 'stale') {
				const filePath = path.join(profile.dispatchDir, dispatchFilename(route.dispatchFileId));
				yield* fs.remove(filePath).pipe(
					Effect.mapError(
						(cause): DispatchWriteFailed =>
							new DispatchWriteFailed({
								dispatchFileId,
								path: filePath,
								detail: `failed to remove stale route lease ${route.dispatchFileId}`,
								cause,
							}),
					),
				);
				continue;
			}
			active.push(route);
		}
		return active;
	}).pipe(Effect.provide(layerLivenessProbeScope));

const makeRouteLease = (profile: RouterProfile, identity: Identity): RouteLeaseMetadata => ({
	version: ROUTER_ROUTE_LEASE_VERSION,
	routerProfileId: profile.id,
	app: String(identity.app),
	stack: String(identity.stack),
	owner: ownHolder(),
});

const sameRouteSurface = (
	a: Pick<DispatchRouteMetadata, 'hostname' | 'entrypointName' | 'entrypointPort' | 'wireProtocol'>,
	b: Pick<ResolvedRoute, 'hostname' | 'entrypointName' | 'entrypointPort' | 'wireProtocol'>,
): boolean =>
	a.hostname === b.hostname &&
	a.entrypointName === b.entrypointName &&
	a.entrypointPort === b.entrypointPort &&
	a.wireProtocol === b.wireProtocol;

const liveRouteLeaseMismatch = (
	existing: DispatchRouteMetadata,
	resolved: ResolvedRoute,
): RouteCollision =>
	new RouteCollision({
		message:
			`router route ${resolved.dispatchFileId} is already leased by a live process ` +
			`with a different public route (existing ${existing.entrypointName}/` +
			`${existing.hostname}, attempted ${resolved.entrypointName}/${resolved.hostname})`,
		hostname: resolved.hostname,
		entrypoint: resolved.entrypointName,
		dispatchIds: [existing.dispatchFileId, resolved.dispatchFileId],
	});

const resolvedWireProtocolFor = (decl: RoutableDecl): ResolvedWireProtocol =>
	decl.wireProtocol === 'tcp' ? 'tcp' : decl.wireProtocol === 'h2c' ? 'h2c' : 'http';

const validateWireProtocolFamily = (
	decl: RoutableDecl,
	entrypoint: { readonly name: string; readonly protocol: 'http' | 'h2c' | 'tcp' },
): Effect.Effect<ResolvedWireProtocol, RouterValidationError> => {
	const wireProtocol = resolvedWireProtocolFor(decl);
	const expectFamily: 'tcp' | 'http' = wireProtocol === 'tcp' ? 'tcp' : 'http';
	const entrypointFamily: 'tcp' | 'http' = entrypoint.protocol === 'tcp' ? 'tcp' : 'http';
	if (expectFamily === entrypointFamily) return Effect.succeed(wireProtocol);
	return Effect.fail(
		new RouterValidationError({
			field: 'entrypointName',
			value: entrypoint.name,
			detail:
				`wireProtocol family mismatch: decl is '${wireProtocol}' but ` +
				`entrypoint '${entrypoint.name}' is '${entrypoint.protocol}'`,
		}),
	);
};

const directLoopbackHost = '127.0.0.1';
export const DEFAULT_ROUTE_READINESS_TIMEOUT_MS = 60_000;
const DEFAULT_ROUTE_READINESS_INTERVAL_MS = 100;
const DEFAULT_ROUTE_READINESS_REQUEST_TIMEOUT_MS = 750;
const proxyGatewayStatuses = new Set([502, 503, 504]);

const responseHasReadyRoute = (response: Response, resolved: ResolvedRoute): boolean =>
	response.headers.get(ROUTE_READINESS_HEADER) === resolved.dispatchFileId &&
	!proxyGatewayStatuses.has(response.status);

const fetchHttpRouteViaLoopback: HttpProbeFetch = (input, init) =>
	new Promise<Response>((resolveResponse, rejectResponse) => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
		const signal = init?.signal ?? undefined;
		const hostHeader = headers.get('host') ?? headers.get('Host') ?? url.host;
		headers.delete('host');
		headers.delete('Host');
		const requestHeaders: Record<string, string> = {};
		headers.forEach((value, key) => {
			requestHeaders[key] = value;
		});
		requestHeaders.host = hostHeader;
		let settled = false;
		let req: ReturnType<typeof httpRequest> | null = null;
		function onAbort(): void {
			const cause = new Error('route readiness probe aborted');
			req?.destroy(cause);
			settle(rejectResponse, cause);
		}
		const settle = <T>(fn: (value: T) => void, value: T): void => {
			if (settled) return;
			settled = true;
			if (signal !== undefined) {
				signal.removeEventListener('abort', onAbort);
			}
			fn(value);
		};
		req = httpRequest(
			{
				hostname: directLoopbackHost,
				port: url.port === '' ? 80 : Number(url.port),
				path: `${url.pathname}${url.search}`,
				method: init?.method ?? 'GET',
				headers: requestHeaders,
			},
			(res) => {
				const chunks: Uint8Array[] = [];
				res.on('data', (chunk: Buffer | string) => {
					chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
				});
				res.on('end', () => {
					const responseHeaders = new Headers();
					for (const [key, value] of Object.entries(res.headers)) {
						if (value === undefined) continue;
						if (Array.isArray(value)) {
							for (const item of value) responseHeaders.append(key, item);
						} else {
							responseHeaders.set(key, value);
						}
					}
					settle(
						resolveResponse,
						new Response(new Uint8Array(Buffer.concat(chunks)), {
							status: res.statusCode ?? 599,
							statusText: res.statusMessage,
							headers: responseHeaders,
						}),
					);
				});
			},
		);
		if (signal?.aborted === true) {
			onAbort();
			return;
		}
		signal?.addEventListener('abort', onAbort, { once: true });
		req.on('error', (cause) => settle(rejectResponse, cause));
		req.end();
	});

const resolveDisabledDirectRoute = (
	identity: Identity,
	decl: RoutableDecl,
	registry: EntrypointRegistryShape,
): Effect.Effect<
	ResolvedRoute,
	UnknownEntrypoint | RouterDisabledRouteUnsupported | RouterValidationError
> =>
	Effect.gen(function* () {
		if (decl.upstream.type === 'container') {
			return yield* Effect.fail(
				new RouterDisabledRouteUnsupported({
					endpointName: decl.endpointName,
					upstreamKind: 'container',
					detail:
						'router is disabled, but container upstreams are only reachable through the router network/proxy; ' +
						'use a host-loopback upstream or publish an explicit direct endpoint instead',
				}),
			);
		}

		const port = decl.upstream.port;
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			return yield* Effect.fail(
				new RouterValidationError({
					field: 'upstreamUrl',
					value: `${directLoopbackHost}:${port}`,
					detail: 'disabled-router direct host-loopback routes require a concrete TCP port 1-65535',
				}),
			);
		}

		const entrypoint = yield* registry.byName(decl.endpointName);
		const wireProtocol = yield* validateWireProtocolFamily(decl, entrypoint);
		const fileId = yield* dispatchFileId({ identity, dispatch: decl.dispatchId });
		const scheme = wireProtocol === 'tcp' ? 'tcp' : 'http';
		return {
			dispatchFileId: fileId,
			hostname: directLoopbackHost,
			entrypointName: entrypoint.name,
			entrypointPort: port,
			upstreamUrl: `${scheme}://${directLoopbackHost}:${port}`,
			cors: decl.wireProtocol === 'tcp' ? false : decl.cors,
			wireProtocol,
		};
	});

const removeDispatchFile = (
	fs: FileSystem.FileSystem,
	profile: RouterProfile,
	resolved: ResolvedRoute,
): Effect.Effect<void> =>
	fs
		.remove(path.join(profile.dispatchDir, dispatchFilename(resolved.dispatchFileId)))
		.pipe(Effect.ignore);

const waitForPublicRouteReadiness = (
	cfg: RouterConfigShape,
	decl: RoutableDecl,
	resolved: ResolvedRoute,
): Effect.Effect<void, RouteReadinessProbeFailed> => {
	const options = cfg.routeReadinessProbe;
	if (
		options?.enabled !== true ||
		cfg.disabled ||
		resolved.wireProtocol === 'tcp' ||
		decl.readiness === 'deferred'
	) {
		return Effect.void;
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_ROUTE_READINESS_TIMEOUT_MS;
	const intervalMs = options.intervalMs ?? DEFAULT_ROUTE_READINESS_INTERVAL_MS;
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_ROUTE_READINESS_REQUEST_TIMEOUT_MS;
	const probeUrl = `http://${directLoopbackHost}:${resolved.entrypointPort}`;
	// The probe only runs for non-tcp routes, so the public endpoint URL is
	// the http form — same derivation the boot adapter surfaces.
	const publicUrl = `http://${resolved.hostname}:${resolved.entrypointPort}`;
	return waitForHttpEndpoint({
		endpoint: probeUrl,
		timeoutMs,
		intervalMs,
		requestTimeoutMs,
		requestInit: { headers: { host: resolved.hostname } },
		fetch: options.fetch ?? fetchHttpRouteViaLoopback,
		validate: (response) => responseHasReadyRoute(response, resolved),
	}).pipe(
		Effect.mapError(
			(cause): RouteReadinessProbeFailed =>
				new RouteReadinessProbeFailed({
					dispatchFileId: resolved.dispatchFileId,
					url: publicUrl,
					timeoutMs,
					detail:
						`public router endpoint ${publicUrl} did not serve route ` +
						`${resolved.dispatchFileId} within ${timeoutMs}ms ` +
						`(probeUrl=${probeUrl}, hostHeader=${resolved.hostname})`,
					cause,
				}),
		),
	);
};

// ---------------------------------------------------------------------------
// Layer — wire the orchestrator
// ---------------------------------------------------------------------------

export const layerRouterService: Layer.Layer<
	RouterService,
	never,
	| RouterConfig
	| IdentityContext
	| EntrypointRegistry
	| TraefikContainerOpsService
	| UpstreamResolverService
	| FileSystem.FileSystem
> = Layer.effect(
	RouterService,
	Effect.gen(function* () {
		const cfg = yield* RouterConfig;
		const identity = yield* IdentityContext;
		const registry = yield* EntrypointRegistry;
		const upstreams = yield* UpstreamResolverService;
		const fs = yield* FileSystem.FileSystem;
		// Capture the Traefik ops service in the layer's outer scope so
		// `bootstrap` (which reads it from Context) doesn't surface
		// requirements through `boot()`'s return type. Provided to
		// downstream calls via `Effect.provideService`.
		const traefikOps = yield* TraefikContainerOpsService;

		// Cached boot report — set on first `boot()` call.
		const bootRef = yield* Ref.make<BootReport | null>(null);

		// Applied routes — subscribable for diagnostics. Empty until the
		// first `contributeRoute()`. The orchestrator publishes the
		// *resolved* shape (post URL-resolution) rather than the raw
		// decls so downstream surfaces don't have to re-resolve.
		const applied = yield* SubscriptionRef.make<ReadonlyArray<ResolvedRoute>>([]);

		// ---------------------------------------------------------------
		// boot — adopt-or-create the Traefik container.
		// ---------------------------------------------------------------
		const boot: RouterServiceShape['boot'] = () =>
			Effect.gen(function* () {
				const profile = cfg.profile;
				if (cfg.disabled) {
					const report: BootReport = {
						decision: 'opt-out',
						containerId: null,
						networkId: null,
						imageMatches: true,
					};
					yield* Ref.set(bootRef, report);
					return report;
				}
				const cached = yield* Ref.get(bootRef);
				if (cached !== null) return cached;
				// Single outer scope holds BOTH locks for the entire boot duration.
				// Acquire dispatch lock first (outer), then bootstrap lock (inner) so
				// scope finalizers release in reverse order: bootstrap lock first, then
				// dispatch lock. `protectedRouteLeaseIds` is computed under the
				// dispatch lock and consumed by `bootstrap` while still under the same
				// lock — no peer-write window can publish a new dispatch route file
				// between the scan and the bootstrap-time forceRemove decision.
				// STYLE_GUIDE §18 cross-process protocol — router boot must hold the
				// dispatch lock across the scan + bootstrap critical section, exactly
				// the same way `contributeRoute` holds it across write + probe.
				const report = yield* Effect.scoped(
					Effect.gen(function* () {
						yield* acquireStackLock(profile.dispatchLockFile, ROUTER_LOCK_TIMEOUT_MILLIS).pipe(
							Effect.mapError(
								(cause): RouterBootFailed =>
									new RouterBootFailed({
										stage: 'ensure-container',
										detail: `failed to acquire router dispatch lock ${profile.dispatchLockFile}`,
										cause,
									}),
							),
						);
						// Re-check after acquiring the dispatch lock: a peer fiber
						// (parallel plugin acquire) may have finished boot while we
						// waited for this lock. The O_EXCL lock serializes in-process
						// fibers too, and the winner sets `bootRef` below while still
						// holding the lock — so a non-null read here means boot is
						// done; skip the redundant bootstrap (docker inspect + decision).
						const bootedByPeer = yield* Ref.get(bootRef);
						if (bootedByPeer !== null) return bootedByPeer;
						yield* fs.makeDirectory(profile.dispatchDir, { recursive: true }).pipe(
							Effect.mapError(
								(cause): RouterBootFailed =>
									new RouterBootFailed({
										stage: 'write-shared-config',
										detail: `makeDirectory(${profile.dispatchDir}) failed`,
										cause,
									}),
							),
						);
						yield* atomicWriteFile(
							path.join(profile.dispatchDir, CORS_MIDDLEWARE_FILENAME),
							new TextEncoder().encode(renderCorsMiddlewareYaml()),
							{ mode: 0o644 },
						).pipe(
							Effect.mapError(
								(cause): RouterBootFailed =>
									new RouterBootFailed({
										stage: 'write-shared-config',
										detail: `atomicWriteFile(${CORS_MIDDLEWARE_FILENAME}) failed at stage ${cause.stage}`,
										cause,
									}),
							),
							Effect.provideService(FileSystem.FileSystem, fs),
						);
						const existingDispatchScan = yield* readDispatchRouteScan(
							fs,
							profile.dispatchDir,
							'router-boot',
						).pipe(
							Effect.mapError(
								(cause): RouterBootFailed =>
									new RouterBootFailed({
										stage: 'inspect',
										detail: cause.detail,
										cause,
									}),
							),
						);
						const activeDispatchRoutes = yield* sweepStaleDispatchRoutes(
							fs,
							profile,
							existingDispatchScan.routes,
							'router-boot',
						).pipe(
							Effect.mapError(
								(cause): RouterBootFailed =>
									new RouterBootFailed({
										stage: 'write-shared-config',
										detail: cause.detail,
										cause,
									}),
							),
						);
						const protectedRouteLeaseIds = [
							...activeDispatchRoutes.map((route) => route.dispatchFileId),
							...existingDispatchScan.unknownRouteFileIds,
						];
						yield* acquireStackLock(profile.bootstrapLockFile, ROUTER_LOCK_TIMEOUT_MILLIS).pipe(
							Effect.mapError(
								(cause): RouterBootFailed =>
									new RouterBootFailed({
										stage: 'ensure-container',
										detail: `failed to acquire router bootstrap lock ${profile.bootstrapLockFile}`,
										cause,
									}),
							),
						);
						const booted = yield* bootstrap({
							image: cfg.image,
							entrypoints: registry.all(),
							profile,
							protectedRouteLeaseIds,
						}).pipe(Effect.provideService(TraefikContainerOpsService, traefikOps));
						// Publish the cached report WHILE still holding the locks so a
						// peer fiber's post-lock re-check (above) observes it — the
						// locks release at scope close, which is after this set. On
						// bootstrap failure we never reach here, so `bootRef` stays
						// null and a later boot() retries (retry-on-failure preserved).
						yield* Ref.set(bootRef, booted);
						return booted;
					}),
				);
				return report;
			});

		// ---------------------------------------------------------------
		// contributeRoute — resolve + write dispatch file + scope finalizer.
		// ---------------------------------------------------------------
		const contributeRoute: RouterServiceShape['contributeRoute'] = (decl) =>
			Effect.gen(function* () {
				const profile = cfg.profile;
				const resolved = cfg.disabled
					? yield* resolveDisabledDirectRoute(identity, decl, registry)
					: yield* resolveRoute(identity, decl, registry, upstreams);
				const lease = makeRouteLease(profile, identity);
				const publishRouteFile: Effect.Effect<
					RoutePublishOwnership,
					DispatchWriteFailed | RouteCollision
				> = Effect.gen(function* () {
					// Collision check against this process's applied set
					// plus files already present in the shared dispatch
					// directory. The dispatch lock makes the scan + write a
					// cross-process critical section.
					// WHY: disabled mode resolves direct-loopback routes with no
					// proxy dispatch file, so there is no shared resource a
					// duplicate could clobber — intentionally skip
					// `detectCollisions` and short-circuit before the
					// dispatch-dir scan/write below.
					if (cfg.disabled) return 'direct';
					if (!cfg.disabled) {
						yield* fs.makeDirectory(profile.dispatchDir, { recursive: true }).pipe(
							Effect.mapError(
								(cause): DispatchWriteFailed =>
									new DispatchWriteFailed({
										dispatchFileId: resolved.dispatchFileId,
										path: profile.dispatchDir,
										detail: `makeDirectory(${profile.dispatchDir}) failed`,
										cause,
									}),
							),
						);
					}
					const currentApplied = yield* SubscriptionRef.get(applied);
					const currentIds = new Set(currentApplied.map((route) => route.dispatchFileId));
					let reuseLiveRoute = false;
					const readScan = yield* readDispatchRouteScan(
						fs,
						profile.dispatchDir,
						resolved.dispatchFileId,
					);
					const activeDispatchRoutes = yield* sweepStaleDispatchRoutes(
						fs,
						profile,
						readScan.routes,
						resolved.dispatchFileId,
					);
					const existingSameDispatchRoute = activeDispatchRoutes.find(
						(route) => route.dispatchFileId === resolved.dispatchFileId,
					);
					if (
						existingSameDispatchRoute !== undefined &&
						!currentIds.has(existingSameDispatchRoute.dispatchFileId)
					) {
						const status = yield* classifyDispatchLease(existingSameDispatchRoute);
						if (status === 'live') {
							if (!sameRouteSurface(existingSameDispatchRoute, resolved)) {
								return yield* Effect.fail(
									liveRouteLeaseMismatch(existingSameDispatchRoute, resolved),
								);
							}
							reuseLiveRoute = true;
						}
					}
					const existingDispatchRoutes = activeDispatchRoutes.filter(
						(route) =>
							!currentIds.has(route.dispatchFileId) &&
							route.dispatchFileId !== resolved.dispatchFileId,
					);
					const collision = detectCollisions([
						...existingDispatchRoutes,
						...currentApplied,
						resolved,
					]);
					if (collision) return yield* Effect.fail(collision);
					if (reuseLiveRoute) return 'reused-live';

					// Atomic write — invariant #5. tmp + rename via the
					// substrate's `atomicWriteFile` helper; Traefik's
					// watcher tolerates rename atomically.
					const filePath = path.join(
						profile.dispatchDir,
						dispatchFilename(resolved.dispatchFileId),
					);
					yield* atomicWriteFile(
						filePath,
						new TextEncoder().encode(renderRouteYaml(resolved, lease)),
						{
							mode: 0o644,
						},
					).pipe(
						Effect.mapError(
							(cause): DispatchWriteFailed =>
								new DispatchWriteFailed({
									dispatchFileId: resolved.dispatchFileId,
									path: filePath,
									detail: `atomicWriteFile failed at stage ${cause.stage}`,
									cause,
								}),
						),
						Effect.provideService(FileSystem.FileSystem, fs),
					);
					return 'owned';
				});

				let publishOwnership: RoutePublishOwnership;
				if (cfg.disabled) {
					publishOwnership = yield* publishRouteFile;
					yield* waitForPublicRouteReadiness(cfg, decl, resolved);
					if (publishOwnership !== 'reused-live') {
						yield* SubscriptionRef.update(applied, (arr) => [...arr, resolved]);
					}
				} else {
					// The dispatch lock MUST be held across (a) the on-disk
					// scan + write inside `publishRouteFile`, (b) the
					// readiness probe, AND (c) the in-process
					// `SubscriptionRef.update(applied, …)` that publishes the
					// new route to peer fibers in this process. Releasing
					// the lock before the SubscriptionRef update would let a
					// concurrent in-process `contributeRoute` sample the
					// stale `applied` set at line 803 even though our
					// dispatch file is already on disk — the on-disk scan
					// covers cross-process visibility but the lock must also
					// gate the in-process publish so the two views agree.
					// See STYLE_GUIDE §18 cross-process protocol — router
					// contributeRoute serialization rule.
					publishOwnership = yield* Effect.scoped(
						Effect.gen(function* () {
							yield* acquireStackLock(profile.dispatchLockFile, ROUTER_LOCK_TIMEOUT_MILLIS).pipe(
								Effect.mapError(
									(cause): DispatchWriteFailed =>
										new DispatchWriteFailed({
											dispatchFileId: resolved.dispatchFileId,
											path: profile.dispatchLockFile,
											detail: `failed to acquire dispatch lock ${profile.dispatchLockFile}`,
											cause,
										}),
								),
							);
							const ownership = yield* publishRouteFile;
							yield* waitForPublicRouteReadiness(cfg, decl, resolved).pipe(
								Effect.onError(() =>
									ownership !== 'owned' ? Effect.void : removeDispatchFile(fs, profile, resolved),
								),
							);
							if (ownership !== 'reused-live') {
								yield* SubscriptionRef.update(applied, (arr) => [...arr, resolved]);
							}
							return ownership;
						}),
					);
				}
				if (publishOwnership !== 'reused-live') {
					// Scope finalizer — remove the file + drop from applied
					// when the caller's scope closes. Best-effort: "already
					// gone" is fine, but lock contention / IO failures surface
					// via logWarning so leaked dispatch files don't go silent
					// (STYLE_GUIDE §18 — `Effect.ignore` on `acquireStackLock`
					// without a tap is forbidden).
					yield* Effect.addFinalizer(() =>
						Effect.gen(function* () {
							if (publishOwnership === 'owned') {
								yield* Effect.scoped(
									Effect.gen(function* () {
										yield* acquireStackLock(profile.dispatchLockFile, ROUTER_LOCK_TIMEOUT_MILLIS);
										yield* removeDispatchFile(fs, profile, resolved);
									}),
								).pipe(
									logWarningAndIgnore('router scope-close cleanup failed', {
										dispatchFileId: resolved.dispatchFileId,
									}),
								);
							}
							yield* SubscriptionRef.update(applied, (arr) =>
								arr.filter((r) => r.dispatchFileId !== resolved.dispatchFileId),
							);
						}),
					);
				}

				return resolved;
			});

		return RouterService.of({ boot, contributeRoute, applied });
	}),
);

// ---------------------------------------------------------------------------
// Helpers for tests + composition
// ---------------------------------------------------------------------------

// Re-export for ergonomics — callers reach for the orchestrator
// without having to spell out the sibling module paths.
export { type ResolvedRoute, type UpstreamResolver } from './file-provider.ts';
export type { BootReport } from './traefik-container.ts';
export type { UpstreamResolveTimeout } from './errors.ts';
export type { Identity } from '../../substrate/identity.ts';
export type { RoutableDecl } from '../../contracts/routable.ts';
