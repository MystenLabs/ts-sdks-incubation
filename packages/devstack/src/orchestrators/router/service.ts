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

import { Context, Effect, FileSystem, Layer, Ref, Stream, SubscriptionRef } from 'effect';
import * as path from 'node:path';

import type { RoutableDecl } from '../../contracts/routable.ts';
import { connect, DockerHost, DockerSpawner, waitForIp } from '../../runtime/docker/index.ts';
import { atomicWriteFile } from '../../substrate/runtime/atomic-write.ts';
import type { Identity } from '../../substrate/identity.ts';
import { checkHolderLiveness, ownHolder } from '../../substrate/runtime/cross-process/liveness.ts';
import { acquireStackLock } from '../../substrate/runtime/cross-process/stack-lock.ts';
import { waitForHttpEndpoint, type HttpProbeFetch } from '../../substrate/runtime/http-probe.ts';
import { IdentityContext } from '../../substrate/runtime/paths.ts';
import { CORS_MIDDLEWARE_FILENAME, renderCorsMiddlewareYaml } from './cors.ts';
import { EntrypointRegistry, type EntrypointRegistryShape } from './entrypoints.ts';
import {
	DispatchWriteFailed,
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
	'@devstack-rewrite/orchestrators/router/RouterConfig',
) {}

/** Default-config layer for tests. Production wires this from
 *  `runtime-composition.ts` at the engine boundary. */
export const layerRouterConfigLiteral = (cfg: RouterConfigShape): Layer.Layer<RouterConfig> =>
	Layer.succeed(RouterConfig)(cfg);

// ---------------------------------------------------------------------------
// UpstreamResolverService — Context wrapper around the seam
// ---------------------------------------------------------------------------

export class UpstreamResolverService extends Context.Service<
	UpstreamResolverService,
	UpstreamResolver
>()('@devstack-rewrite/orchestrators/router/UpstreamResolver') {}

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
	 *  atomically. The returned `EndpointUrl` is the dispatched URL the
	 *  manifest writer + codegen consume.
	 *
	 *  Scope-bound: when the caller's scope closes, the dispatch file
	 *  is removed (best-effort) and the contribution is dropped from the
	 *  subscribable map. */
	readonly contributeRoute: (
		decl: RoutableDecl,
	) => Effect.Effect<EndpointUrl, RouterError, import('effect').Scope.Scope>;

	/** Subscribable view of currently-applied routes. Surfaces +
	 *  diagnostics consume this. */
	readonly applied: SubscriptionRef.SubscriptionRef<ReadonlyArray<ResolvedRoute>>;
}

/** What `contributeRoute` returns — the post-mint URL and the metadata
 *  the manifest needs. `wireProtocol: 'tcp'` carries `tcp://` URLs;
 *  consumers (codegen, manifest) translate to their protocol-specific
 *  scheme (`postgres://`, `redis://`, …). */
export interface EndpointUrl {
	readonly endpointName: string;
	readonly hostname: string;
	readonly entrypointPort: number;
	readonly url: string;
	readonly wireProtocol: 'http' | 'h2c' | 'tcp';
}

export class RouterService extends Context.Service<RouterService, RouterServiceShape>()(
	'@devstack-rewrite/orchestrators/router/Router',
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
		yield* Effect.annotateCurrentSpan({
			'router.dispatch.path': diagnostic.path,
			'router.dispatch.file_id': diagnostic.dispatchFileId,
			'router.dispatch.decode_reason': diagnostic.reason,
		});
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
	Effect.gen(function* () {
		const active: DispatchRouteMetadata[] = [];
		for (const route of routes) {
			const status = yield* classifyDispatchLease(route);
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
	});

const makeRouteLease = (profile: RouterProfile, identity: Identity): RouteLeaseMetadata => ({
	version: ROUTER_ROUTE_LEASE_VERSION,
	routerProfileId: profile.id,
	app: String(identity.app),
	stack: String(identity.stack),
	owner: ownHolder(),
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
const DEFAULT_ROUTE_READINESS_TIMEOUT_MS = 5_000;
const DEFAULT_ROUTE_READINESS_INTERVAL_MS = 100;
const DEFAULT_ROUTE_READINESS_REQUEST_TIMEOUT_MS = 750;

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

const endpointFromResolvedRoute = (decl: RoutableDecl, resolved: ResolvedRoute): EndpointUrl => {
	const url =
		resolved.wireProtocol === 'tcp'
			? `tcp://127.0.0.1:${resolved.entrypointPort}`
			: `http://${resolved.hostname}:${resolved.entrypointPort}`;
	return {
		endpointName: decl.endpointName,
		hostname: resolved.hostname,
		entrypointPort: resolved.entrypointPort,
		url,
		wireProtocol: resolved.wireProtocol,
	};
};

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
	endpoint: EndpointUrl,
	resolved: ResolvedRoute,
): Effect.Effect<void, RouteReadinessProbeFailed> => {
	const options = cfg.routeReadinessProbe;
	if (options?.enabled !== true || cfg.disabled || resolved.wireProtocol === 'tcp') {
		return Effect.void;
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_ROUTE_READINESS_TIMEOUT_MS;
	const intervalMs = options.intervalMs ?? DEFAULT_ROUTE_READINESS_INTERVAL_MS;
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_ROUTE_READINESS_REQUEST_TIMEOUT_MS;
	return waitForHttpEndpoint({
		endpoint: endpoint.url,
		timeoutMs,
		intervalMs,
		requestTimeoutMs,
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		validate: (response) =>
			response.headers.get(ROUTE_READINESS_HEADER) === resolved.dispatchFileId,
	}).pipe(
		Effect.mapError(
			(cause): RouteReadinessProbeFailed =>
				new RouteReadinessProbeFailed({
					dispatchFileId: resolved.dispatchFileId,
					url: endpoint.url,
					timeoutMs,
					detail:
						`public router endpoint ${endpoint.url} did not serve route ` +
						`${resolved.dispatchFileId} within ${timeoutMs}ms`,
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
				const protectedRouteLeaseIds = yield* Effect.scoped(
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
						// Write the shared CORS middleware file before reading
						// active dispatch routes so the later bootstrap phase can
						// hold only the bootstrap lock.
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
						return [
							...activeDispatchRoutes.map((route) => route.dispatchFileId),
							...existingDispatchScan.unknownRouteFileIds,
						];
					}),
				);
				const report = yield* Effect.scoped(
					Effect.gen(function* () {
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
						return yield* bootstrap({
							image: cfg.image,
							entrypoints: registry.all(),
							profile,
							protectedRouteLeaseIds,
						}).pipe(Effect.provideService(TraefikContainerOpsService, traefikOps));
					}),
				);
				yield* Ref.set(bootRef, report);
				return report;
			}).pipe(Effect.withSpan('orchestrator.router.boot'));

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
				const endpoint = endpointFromResolvedRoute(decl, resolved);
				const publishRouteFile = Effect.gen(function* () {
					// Collision check against this process's applied set
					// plus files already present in the shared dispatch
					// directory. The dispatch lock makes the scan + write a
					// cross-process critical section.
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
					const readScan = cfg.disabled
						? { routes: [], unknownRouteFileIds: [], diagnostics: [] }
						: yield* readDispatchRouteScan(fs, profile.dispatchDir, resolved.dispatchFileId);
					const existingDispatchRoutes = cfg.disabled
						? []
						: (yield* sweepStaleDispatchRoutes(
								fs,
								profile,
								readScan.routes,
								resolved.dispatchFileId,
							)).filter((route) => !currentIds.has(route.dispatchFileId));
					const collision = detectCollisions([
						...existingDispatchRoutes,
						...currentApplied,
						resolved,
					]);
					if (collision) return yield* Effect.fail(collision);

					if (!cfg.disabled) {
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
					}
				});

				if (cfg.disabled) {
					yield* publishRouteFile;
				} else {
					yield* Effect.scoped(
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
							yield* publishRouteFile;
						}),
					);
				}

				yield* waitForPublicRouteReadiness(cfg, endpoint, resolved).pipe(
					Effect.onError(() =>
						cfg.disabled
							? Effect.void
							: Effect.scoped(
									Effect.gen(function* () {
										yield* acquireStackLock(
											profile.dispatchLockFile,
											ROUTER_LOCK_TIMEOUT_MILLIS,
										).pipe(Effect.ignore);
										yield* removeDispatchFile(fs, profile, resolved);
									}),
								),
					),
				);
				yield* SubscriptionRef.update(applied, (arr) => [...arr, resolved]);

				// Scope finalizer — remove the file + drop from applied
				// when the caller's scope closes. Best-effort: "already
				// gone" is fine per distilled-doc.
				yield* Effect.addFinalizer(() =>
					Effect.gen(function* () {
						if (!cfg.disabled) {
							yield* Effect.scoped(
								Effect.gen(function* () {
									yield* acquireStackLock(
										profile.dispatchLockFile,
										ROUTER_LOCK_TIMEOUT_MILLIS,
									);
									yield* removeDispatchFile(fs, profile, resolved);
								}),
							).pipe(Effect.ignore);
						}
						yield* SubscriptionRef.update(applied, (arr) =>
							arr.filter((r) => r.dispatchFileId !== resolved.dispatchFileId),
						);
					}),
				);

				return endpoint;
			}).pipe(Effect.withSpan('orchestrator.router.contributeRoute'));

		return RouterService.of({ boot, contributeRoute, applied });
	}),
);

// ---------------------------------------------------------------------------
// Helpers for tests + composition
// ---------------------------------------------------------------------------

/** Stream of the resolved-route set. Use from a renderer / inventory
 *  surface to react to route adds + removes. The supervisor's main
 *  loop subscribes through this stream. */
export const routesStream = (
	router: RouterServiceShape,
): Stream.Stream<ReadonlyArray<ResolvedRoute>> => SubscriptionRef.changes(router.applied);

// Re-export for ergonomics — callers reach for the orchestrator
// without having to spell out the sibling module paths.
export { type ResolvedRoute, type UpstreamResolver } from './file-provider.ts';
export type { BootReport } from './traefik-container.ts';
export type { UpstreamResolveTimeout } from './errors.ts';
export type { Identity } from '../../substrate/identity.ts';
export type { RoutableDecl } from '../../contracts/routable.ts';
