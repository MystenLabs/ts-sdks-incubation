// Router orchestrator end-to-end coverage against the stub Traefik
// container layer.
//
// Architecture invariants under test:
//   - boot() is idempotent (subsequent calls return the same report;
//     architecture invariant #11 — once per supervisor lifetime).
//   - contributeRoute() writes a per-backend dispatch file atomically
//     into the dispatch directory and removes it on scope close.
//   - The shared CORS middleware file lands at `00-shared-middlewares.yml`
//     (lexicographic ordering invariant #9).
//   - Per-backend files start with the `10-` prefix.
//   - The orchestrator does NOT name services anywhere; the test fixture
//     wires arbitrary Routables and the orchestrator handles them
//     uniformly.

// Subpath import — the barrel re-exports `NodeRedis` which transitively
// requires `ioredis`, an optional peer not installed in this package.
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Cause, Effect, Layer, Logger, SubscriptionRef } from 'effect';
import { afterAll, describe, expect, it } from '@effect/vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CORS_MIDDLEWARE_FILENAME } from '../../../src/orchestrators/router/cors.ts';
import { layerEntrypointRegistry } from '../../../src/orchestrators/router/entrypoints.ts';
import {
	dispatchFilename,
	renderRouteYaml,
	ROUTE_READINESS_HEADER,
	ROUTER_ROUTE_LEASE_VERSION,
	type RouteLeaseMetadata,
	type ResolvedRoute,
} from '../../../src/orchestrators/router/file-provider.ts';
import { dispatchFileId } from '../../../src/orchestrators/router/hostname.ts';
import type { RouterProfile } from '../../../src/orchestrators/router/profile.ts';
import {
	DEFAULT_ROUTE_READINESS_TIMEOUT_MS,
	layerRouterConfigLiteral,
	layerRouterService,
	RouterService,
	UpstreamResolverService,
} from '../../../src/orchestrators/router/service.ts';
import {
	layerTraefikContainerOpsStub,
	TraefikContainerOpsService,
	type TraefikContainerOps,
} from '../../../src/orchestrators/router/traefik-container.ts';
import { appName, chainId, stackName } from '../../../src/substrate/brand.ts';
import { ownHolder } from '../../../src/substrate/runtime/cross-process/liveness.ts';
import type { HttpProbeFetch } from '../../../src/substrate/runtime/http-probe.ts';
import { layerIdentity } from '../../../src/substrate/runtime/paths.ts';

// Per-test temp dirs (~24 callers below). Each is captured here so a
// single `afterAll` can remove them at the end of the file — the
// router service tests pass these dirs deep into Effect-driven code
// where wrapping each `it.effect` body with `withTempRoot` would
// require restructuring every test, so we use the same array-and-
// sweep pattern as the other large `makeTmpDir`-style test files.
const allocatedTmpDirs: string[] = [];
afterAll(() => {
	for (const dir of allocatedTmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const makeTmpDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-router-test-'));
	allocatedTmpDirs.push(dir);
	return dir;
};

// `contributeRoute` now returns the `ResolvedRoute` (the single source of
// truth); the public endpoint URL is derived from it the same way the boot
// adapter (`endpointSinksFromRoutable`) does — `tcp://127.0.0.1:port` for
// tcp routes, `http://hostname:port` otherwise.
const publicRouteUrl = (resolved: ResolvedRoute): string =>
	resolved.wireProtocol === 'tcp'
		? `tcp://127.0.0.1:${resolved.entrypointPort}`
		: `http://${resolved.hostname}:${resolved.entrypointPort}`;

const upstreamsLayer = Layer.succeed(UpstreamResolverService)({
	resolveContainer: (target) => Effect.succeed({ host: '172.20.0.5', port: target.containerPort }),
	resolveHostLoopback: (target) => Effect.succeed({ host: '127.0.0.1', port: target.port }),
});

const unusedUpstreamsLayer = Layer.succeed(UpstreamResolverService)({
	resolveContainer: () => Effect.die('disabled router direct mode must not resolve containers'),
	resolveHostLoopback: () =>
		Effect.die('disabled router direct mode must not resolve host-loopback'),
});

const identity = {
	app: appName('my-app'),
	stack: stackName('main'),
	chain: chainId('sui:localnet'),
};

const identityLayer = layerIdentity(identity);

const walletApiDispatch = { serviceKey: 'wallet.my-app.main', role: 'api' };

const registryLayer = layerEntrypointRegistry([
	{ name: 'wallet-app', port: 6173, protocol: 'http' },
	{ name: 'walrus-node-0', port: 9185, protocol: 'http' },
	{ name: 'walrus-aggregator', port: 9185, protocol: 'http' },
	{ name: 'postgres-tcp', port: 5432, protocol: 'tcp' },
]);

const makeTestProfile = (dispatchDir: string): RouterProfile => ({
	version: 1,
	id: 'test-profile',
	userId: 'test-user',
	dockerContextId: 'test-docker',
	stateDir: join(dispatchDir, '..'),
	dispatchDir,
	containerName: 'devstack-router-test',
	networkName: 'devstack-router-test',
	bootstrapLockFile: join(dispatchDir, 'locks', 'bootstrap.lock'),
	dispatchLockFile: join(dispatchDir, 'locks', 'dispatch.lock'),
});

const makeLease = (profile: RouterProfile): RouteLeaseMetadata => ({
	version: ROUTER_ROUTE_LEASE_VERSION,
	routerProfileId: profile.id,
	app: String(identity.app),
	stack: String(identity.stack),
	owner: ownHolder(),
});

const makeStackLayer = (profile: RouterProfile) =>
	layerRouterService.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				identityLayer,
				registryLayer,
				layerTraefikContainerOpsStub,
				upstreamsLayer,
				NodeFileSystem.layer,
				layerRouterConfigLiteral({
					disabled: false,
					profile,
					image: 'traefik:v3.5',
				}),
			),
		),
	);

const makeStackLayerWithRouteReadinessProbe = (
	profile: RouterProfile,
	fetch: HttpProbeFetch,
	options: {
		readonly timeoutMs?: number;
		readonly intervalMs?: number;
		readonly requestTimeoutMs?: number;
	} = {},
) =>
	layerRouterService.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				identityLayer,
				registryLayer,
				layerTraefikContainerOpsStub,
				upstreamsLayer,
				NodeFileSystem.layer,
				layerRouterConfigLiteral({
					disabled: false,
					profile,
					image: 'traefik:v3.5',
					routeReadinessProbe: {
						enabled: true,
						timeoutMs: options.timeoutMs ?? 200,
						intervalMs: options.intervalMs ?? 5,
						requestTimeoutMs: options.requestTimeoutMs ?? 50,
						fetch,
					},
				}),
			),
		),
	);

const makeDisabledStackLayer = (profile: RouterProfile) =>
	layerRouterService.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				identityLayer,
				registryLayer,
				layerTraefikContainerOpsStub,
				unusedUpstreamsLayer,
				NodeFileSystem.layer,
				layerRouterConfigLiteral({
					disabled: true,
					profile,
					image: 'traefik:v3.5',
				}),
			),
		),
	);

const makeMismatchedTraefikLayer = (profile: RouterProfile) => {
	const calls: string[] = [];
	const ops: TraefikContainerOps = {
		ensureNetwork: (name) => {
			calls.push(`ensureNetwork:${name}`);
			return Effect.succeed({ id: 'network-id' });
		},
		inspectContainer: (name) => {
			calls.push(`inspect:${name}`);
			return Effect.succeed({
				id: 'existing-router',
				running: true,
				image: 'traefik:v3.5',
				dispatchMount: null,
				portBindings: [],
				command: [],
				networks: [],
				labels: {},
			});
		},
		createFresh: (args) => {
			calls.push(`createFresh:${args.name}`);
			return Effect.succeed({ id: 'created-router' });
		},
		resume: (name) => {
			calls.push(`resume:${name}`);
			return Effect.succeed({ id: 'resumed-router' });
		},
		forceRemove: (name) => {
			calls.push(`forceRemove:${name}`);
			return Effect.void;
		},
	};
	const layer = layerRouterService.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				identityLayer,
				registryLayer,
				Layer.succeed(TraefikContainerOpsService)(ops),
				upstreamsLayer,
				NodeFileSystem.layer,
				layerRouterConfigLiteral({
					disabled: false,
					profile,
					image: 'traefik:v3.5',
				}),
			),
		),
	);
	return { calls, layer };
};

describe('RouterService.boot', () => {
	it.effect('writes the shared CORS middleware before container start (invariant #9)', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					const report = yield* router.boot();
					expect(report.decision).toBe('recreate-fresh'); // stub: inspect returns null
					const files = readdirSync(dir);
					expect(files).toContain(CORS_MIDDLEWARE_FILENAME);
					const body = readFileSync(join(dir, CORS_MIDDLEWARE_FILENAME), 'utf8');
					expect(body).toContain('devstack-cors');
				}).pipe(Effect.provide(makeStackLayer(profile))),
			);
		}),
	);

	it.effect('boot() is idempotent — second call returns the cached report', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					const first = yield* router.boot();
					const second = yield* router.boot();
					expect(second).toBe(first);
				}).pipe(Effect.provide(makeStackLayer(profile))),
			);
		}),
	);

	it.effect('disabled config short-circuits to opt-out without touching the filesystem', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			const layer = layerRouterService.pipe(
				Layer.provideMerge(
					Layer.mergeAll(
						identityLayer,
						registryLayer,
						layerTraefikContainerOpsStub,
						upstreamsLayer,
						NodeFileSystem.layer,
						layerRouterConfigLiteral({ disabled: true, profile, image: 'x' }),
					),
				),
			);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					const report = yield* router.boot();
					expect(report.decision).toBe('opt-out');
					expect(readdirSync(dir).length).toBe(0);
				}).pipe(Effect.provide(layer)),
			);
		}),
	);

	it.effect(
		'treats malformed dispatch files as protected leases before destructive bootstrap',
		() =>
			Effect.gen(function* () {
				const dir = makeTmpDir();
				const profile = makeTestProfile(dir);
				writeFileSync(join(dir, dispatchFilename('malformed-live-route')), 'not a route');
				const { calls, layer } = makeMismatchedTraefikLayer(profile);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const router = yield* RouterService;
						const err = yield* router.boot().pipe(Effect.flip);
						expect(err._tag).toBe('RouterBootFailed');
						if (err._tag !== 'RouterBootFailed') throw new Error(`unexpected error: ${err._tag}`);
						expect(err.detail).toContain('malformed-live-route');
						expect(calls).toEqual([
							`ensureNetwork:${profile.networkName}`,
							`inspect:${profile.containerName}`,
						]);
					}).pipe(Effect.provide(layer)),
				);
			}),
	);

	it.effect('keeps valid dispatch files in destructive-bootstrap protection', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			const route: ResolvedRoute = {
				dispatchFileId: 'valid-live-route',
				hostname: 'api.other-app.localhost',
				entrypointName: 'wallet-app',
				entrypointPort: 6173,
				upstreamUrl: 'http://127.0.0.1:6173',
				cors: false,
				wireProtocol: 'http',
			};
			writeFileSync(
				join(dir, dispatchFilename(route.dispatchFileId)),
				renderRouteYaml(route, makeLease(profile)),
			);
			const { calls, layer } = makeMismatchedTraefikLayer(profile);

			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					const err = yield* router.boot().pipe(Effect.flip);
					expect(err._tag).toBe('RouterBootFailed');
					if (err._tag !== 'RouterBootFailed') throw new Error(`unexpected error: ${err._tag}`);
					expect(err.detail).toContain(route.dispatchFileId);
					expect(calls).toEqual([
						`ensureNetwork:${profile.networkName}`,
						`inspect:${profile.containerName}`,
					]);
				}).pipe(Effect.provide(layer)),
			);
		}),
	);

	it.effect('treats unknown lease-version route files as protected unknown-owner leases', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			const route: ResolvedRoute = {
				dispatchFileId: 'unknown-version-route',
				hostname: 'api.other-app.localhost',
				entrypointName: 'wallet-app',
				entrypointPort: 6173,
				upstreamUrl: 'http://127.0.0.1:6173',
				cors: false,
				wireProtocol: 'http',
			};
			const body = renderRouteYaml(route, makeLease(profile)).replace(
				'# routeLeaseVersion: 1',
				'# routeLeaseVersion: 999',
			);
			writeFileSync(join(dir, dispatchFilename(route.dispatchFileId)), body);
			const { calls, layer } = makeMismatchedTraefikLayer(profile);

			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					const err = yield* router.boot().pipe(Effect.flip);
					expect(err._tag).toBe('RouterBootFailed');
					if (err._tag !== 'RouterBootFailed') throw new Error(`unexpected error: ${err._tag}`);
					expect(err.detail).toContain(route.dispatchFileId);
					expect(calls).toEqual([
						`ensureNetwork:${profile.networkName}`,
						`inspect:${profile.containerName}`,
					]);
				}).pipe(Effect.provide(layer)),
			);
		}),
	);
});

describe('RouterService.contributeRoute', () => {
	it('keeps the default route-readiness budget tolerant of shared-router contention', () => {
		expect(DEFAULT_ROUTE_READINESS_TIMEOUT_MS).toBe(60_000);
	});

	it.effect('disabled router rejects container upstreams instead of fabricating direct ports', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					const err = yield* router
						.contributeRoute({
							kind: 'routable',
							endpointName: 'walrus-aggregator',
							dispatchId: { serviceKey: 'walrus.my-app.main', role: 'aggregator' },
							upstream: {
								type: 'container',
								containerName: 'walrus-c1',
								containerPort: 8080,
							},
							cors: false,
							wireProtocol: 'http',
						})
						.pipe(Effect.flip);
					expect(err._tag).toBe('RouterDisabledRouteUnsupported');
					if (err._tag !== 'RouterDisabledRouteUnsupported') {
						throw new Error(`unexpected error: ${err._tag}`);
					}
					expect(err.endpointName).toBe('walrus-aggregator');
					expect(err.upstreamKind).toBe('container');
					expect(readdirSync(dir)).toEqual([]);
				}).pipe(Effect.provide(makeDisabledStackLayer(profile))),
			);
		}),
	);

	it.effect('disabled router returns direct loopback URLs only for host-loopback upstreams', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					const endpoint = yield* router.contributeRoute({
						kind: 'routable',
						endpointName: 'wallet-app',
						dispatchId: { serviceKey: 'wallet.my-app.main', role: 'api' },
						upstream: { type: 'host-loopback', port: 49152 },
						cors: true,
						wireProtocol: 'http',
					});

					expect(publicRouteUrl(endpoint)).toBe('http://127.0.0.1:49152');
					expect(endpoint.hostname).toBe('127.0.0.1');
					expect(endpoint.entrypointPort).toBe(49152);
					expect(readdirSync(dir)).toEqual([]);
					const applied = yield* SubscriptionRef.get(router.applied);
					expect(applied).toHaveLength(1);
					expect(applied[0]?.upstreamUrl).toBe('http://127.0.0.1:49152');
				}).pipe(Effect.provide(makeDisabledStackLayer(profile))),
			);
		}),
	);

	it.effect('writes a per-backend `10-…yml` file on contribution', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					yield* router.boot();
					const resolved = yield* router.contributeRoute({
						kind: 'routable',
						endpointName: 'wallet-app',
						dispatchId: { serviceKey: 'wallet.my-app.main', role: 'api' },
						upstream: { type: 'host-loopback', port: 6173 },
						cors: true,
						wireProtocol: 'http',
					});
					expect(publicRouteUrl(resolved)).toBe('http://api.my-app.localhost:6173');
					const fileId = yield* dispatchFileId({ identity, dispatch: walletApiDispatch });
					const fname = dispatchFilename(fileId);
					const body = readFileSync(join(dir, fname), 'utf8');
					expect(body).toContain('Host(`api.my-app.localhost`)');
				}).pipe(Effect.provide(makeStackLayer(profile))),
			);
		}),
	);

	it.effect('router-enabled container routes write dispatch files and return router URLs', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					yield* router.boot();
					const endpoint = yield* router.contributeRoute({
						kind: 'routable',
						endpointName: 'walrus-aggregator',
						dispatchId: { serviceKey: 'walrus.my-app.main', role: 'aggregator' },
						upstream: {
							type: 'container',
							containerName: 'walrus-c1',
							containerPort: 8080,
						},
						cors: false,
						wireProtocol: 'http',
					});
					expect(publicRouteUrl(endpoint)).toBe('http://aggregator.my-app.localhost:9185');
					// `ResolvedRoute` reports the resolved router entrypoint (not the
					// decl's endpointName, which the boot adapter recovers separately).
					expect(endpoint.entrypointName).toBe('walrus-node-0');
					const files = readdirSync(dir).filter((name) => name.startsWith('10-'));
					expect(files).toHaveLength(1);
					const body = readFileSync(join(dir, files[0]!), 'utf8');
					expect(body).toContain('Host(`aggregator.my-app.localhost`)');
					expect(body).toContain('entryPoints: ["walrus-node-0"]');
					expect(body).toContain('- url: "http://172.20.0.5:8080"');
				}).pipe(Effect.provide(makeStackLayer(profile))),
			);
		}),
	);

	it.effect('reuses a live dispatch file for the same route without taking its lease', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			const fileId = yield* dispatchFileId({ identity, dispatch: walletApiDispatch });
			const existingRoute: ResolvedRoute = {
				dispatchFileId: fileId,
				hostname: 'api.my-app.localhost',
				entrypointName: 'wallet-app',
				entrypointPort: 6173,
				upstreamUrl: 'http://127.0.0.1:6173',
				cors: true,
				wireProtocol: 'http',
			};
			const body = renderRouteYaml(existingRoute, makeLease(profile));
			writeFileSync(join(dir, dispatchFilename(fileId)), body);

			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					yield* router.boot();
					const endpoint = yield* Effect.scoped(
						router.contributeRoute({
							kind: 'routable',
							endpointName: 'wallet-app',
							dispatchId: walletApiDispatch,
							upstream: { type: 'host-loopback', port: 6173 },
							cors: true,
							wireProtocol: 'http',
						}),
					);

					expect(publicRouteUrl(endpoint)).toBe('http://api.my-app.localhost:6173');
					expect(readFileSync(join(dir, dispatchFilename(fileId)), 'utf8')).toBe(body);
					const applied = yield* SubscriptionRef.get(router.applied);
					expect(applied).toHaveLength(0);
				}).pipe(Effect.provide(makeStackLayer(profile))),
			);
			expect(readFileSync(join(dir, dispatchFilename(fileId)), 'utf8')).toBe(body);
		}),
	);

	it.effect('checks current-process collisions before reusing a live dispatch file', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			const fileId = yield* dispatchFileId({ identity, dispatch: walletApiDispatch });
			const existingRoute: ResolvedRoute = {
				dispatchFileId: fileId,
				hostname: 'api.my-app.localhost',
				entrypointName: 'wallet-app',
				entrypointPort: 6173,
				upstreamUrl: 'http://127.0.0.1:6173',
				cors: true,
				wireProtocol: 'http',
			};

			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					yield* router.boot();
					yield* router.contributeRoute({
						kind: 'routable',
						endpointName: 'wallet-app',
						dispatchId: { serviceKey: 'already-applied', role: 'api' },
						upstream: { type: 'host-loopback', port: 6174 },
						cors: true,
						wireProtocol: 'http',
					});
					writeFileSync(
						join(dir, dispatchFilename(fileId)),
						renderRouteYaml(existingRoute, makeLease(profile)),
					);

					const err = yield* router
						.contributeRoute({
							kind: 'routable',
							endpointName: 'wallet-app',
							dispatchId: walletApiDispatch,
							upstream: { type: 'host-loopback', port: 6173 },
							cors: true,
							wireProtocol: 'http',
						})
						.pipe(Effect.flip);

					expect(err._tag).toBe('RouteCollision');
				}).pipe(Effect.provide(makeStackLayer(profile))),
			);
		}),
	);

	it.live('waits for the public route readiness header before returning an HTTP endpoint', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			const calls: Array<{ readonly url: string; readonly host: string | null }> = [];
			let readyHeader = '';
			const fetch: HttpProbeFetch = async (input, init) => {
				calls.push({
					url: String(input),
					host: new Headers(init?.headers).get('host'),
				});
				if (calls.length === 1) return new Response('gateway timeout', { status: 504 });
				return new Response('not found from backend', {
					status: 404,
					headers: { [ROUTE_READINESS_HEADER]: readyHeader },
				});
			};

			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					yield* router.boot();
					readyHeader = yield* dispatchFileId({ identity, dispatch: walletApiDispatch });
					const endpoint = yield* router.contributeRoute({
						kind: 'routable',
						endpointName: 'wallet-app',
						dispatchId: walletApiDispatch,
						upstream: { type: 'host-loopback', port: 6173 },
						cors: true,
						wireProtocol: 'http',
					});

					expect(publicRouteUrl(endpoint)).toBe('http://api.my-app.localhost:6173');
					expect(calls).toEqual([
						{ url: 'http://127.0.0.1:6173', host: 'api.my-app.localhost' },
						{ url: 'http://127.0.0.1:6173', host: 'api.my-app.localhost' },
					]);
					const applied = yield* SubscriptionRef.get(router.applied);
					expect(applied).toHaveLength(1);
				}).pipe(
					Effect.provide(
						makeStackLayerWithRouteReadinessProbe(profile, fetch, { timeoutMs: 2_000 }),
					),
				),
			);
		}),
	);

	it.live('keeps probing when Traefik serves a gateway response with the route header', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			const calls: number[] = [];
			let readyHeader = '';
			const fetch: HttpProbeFetch = async () => {
				calls.push(calls.length + 1);
				if (calls.length === 1) {
					return new Response('bad gateway', {
						status: 502,
						headers: { [ROUTE_READINESS_HEADER]: readyHeader },
					});
				}
				return new Response('ok', {
					status: 200,
					headers: { [ROUTE_READINESS_HEADER]: readyHeader },
				});
			};

			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					yield* router.boot();
					readyHeader = yield* dispatchFileId({ identity, dispatch: walletApiDispatch });
					const endpoint = yield* router.contributeRoute({
						kind: 'routable',
						endpointName: 'wallet-app',
						dispatchId: walletApiDispatch,
						upstream: { type: 'host-loopback', port: 6173 },
						cors: true,
						wireProtocol: 'http',
					});

					expect(publicRouteUrl(endpoint)).toBe('http://api.my-app.localhost:6173');
					expect(calls).toEqual([1, 2]);
				}).pipe(
					Effect.provide(
						makeStackLayerWithRouteReadinessProbe(profile, fetch, { timeoutMs: 2_000 }),
					),
				),
			);
		}),
	);

	it.live(
		'publishes deferred-readiness routes without probing the upstream during contribution',
		() =>
			Effect.gen(function* () {
				const dir = makeTmpDir();
				const profile = makeTestProfile(dir);
				let calls = 0;
				const fetch: HttpProbeFetch = async () => {
					calls += 1;
					return new Response('not ready', { status: 503 });
				};

				yield* Effect.scoped(
					Effect.gen(function* () {
						const router = yield* RouterService;
						yield* router.boot();
						const endpoint = yield* router.contributeRoute({
							kind: 'routable',
							endpointName: 'wallet-app',
							dispatchId: walletApiDispatch,
							upstream: { type: 'host-loopback', port: 6173 },
							cors: true,
							wireProtocol: 'http',
							readiness: 'deferred',
						});

						expect(publicRouteUrl(endpoint)).toBe('http://api.my-app.localhost:6173');
						expect(calls).toBe(0);
						expect(readdirSync(dir).filter((name) => name.startsWith('10-'))).toHaveLength(1);
						const applied = yield* SubscriptionRef.get(router.applied);
						expect(applied).toHaveLength(1);
					}).pipe(
						Effect.provide(
							makeStackLayerWithRouteReadinessProbe(profile, fetch, {
								timeoutMs: 20,
								intervalMs: 5,
								requestTimeoutMs: 5,
							}),
						),
					),
				);
			}),
	);

	it.live('removes the dispatch file when public route readiness never arrives', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			const fetch: HttpProbeFetch = async () => new Response('not routed', { status: 404 });

			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					yield* router.boot();
					const err = yield* router
						.contributeRoute({
							kind: 'routable',
							endpointName: 'wallet-app',
							dispatchId: { serviceKey: 'wallet.my-app.main', role: 'api' },
							upstream: { type: 'host-loopback', port: 6173 },
							cors: true,
							wireProtocol: 'http',
						})
						.pipe(Effect.flip);

					expect(err._tag).toBe('RouteReadinessProbeFailed');
					expect(readdirSync(dir).filter((name) => name.startsWith('10-'))).toEqual([]);
					const applied = yield* SubscriptionRef.get(router.applied);
					expect(applied).toHaveLength(0);
				}).pipe(
					Effect.provide(
						makeStackLayerWithRouteReadinessProbe(profile, fetch, {
							timeoutMs: 20,
							intervalMs: 5,
							requestTimeoutMs: 5,
						}),
					),
				),
			);
		}),
	);

	it.effect('removes the dispatch file when the contributor scope closes', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			const fileId = yield* dispatchFileId({ identity, dispatch: walletApiDispatch });
			const fname = dispatchFilename(fileId);

			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					yield* router.boot();
					// Inner scope: contribute, observe the file lands, then
					// close the scope and confirm cleanup.
					yield* Effect.scoped(
						Effect.gen(function* () {
							yield* router.contributeRoute({
								kind: 'routable',
								endpointName: 'wallet-app',
								dispatchId: { serviceKey: 'wallet.my-app.main', role: 'api' },
								upstream: { type: 'host-loopback', port: 6173 },
								cors: true,
								wireProtocol: 'http',
							});
							expect(readdirSync(dir)).toContain(fname);
						}),
					);
					// After inner scope close.
					expect(readdirSync(dir)).not.toContain(fname);
				}).pipe(Effect.provide(makeStackLayer(profile))),
			);
		}),
	);

	// Phase A of commit 12ecae8d added `tapCause + logWarning` BEFORE
	// `Effect.ignore` on the scope-close cleanup pipeline so leaked
	// dispatch files surface in logs instead of getting silently
	// swallowed. This test pins that contract: when the cleanup's
	// `acquireStackLock` fails (we simulate this by replacing the lock
	// file's parent directory with a regular file after a successful
	// contribute), the scope-close still succeeds (Effect.ignore
	// swallows the failure) AND a Warn-level log entry is emitted
	// carrying the dispatchFileId + the underlying cause.
	//
	// Captured-logger Layer per Effect v4 `Logger.layer([…])` —
	// REPLACES the default logger with a recording one so the
	// finalizer's `Effect.logWarning(...)` lands in `captured` and the
	// test's stdout stays quiet.
	it.effect('scope-close cleanup failure surfaces via logWarning before Effect.ignore', () => {
		// `Logger.layer([...])` requires `Logger<unknown, unknown>` (Message is
		// contravariant; loggers must accept any input shape). But Effect's
		// runtime contract delivers `message` as `ReadonlyArray<unknown>` for
		// multi-arg log calls — `logWarning('text', annotations)` arrives as
		// `[text, annotations]`. Project that contract once at the recording
		// boundary so downstream reads stay typed instead of casting at every
		// access site.
		interface CapturedLog {
			readonly logLevel: string;
			readonly message: ReadonlyArray<unknown>;
			readonly cause: Cause.Cause<unknown>;
		}
		const captured: CapturedLog[] = [];
		const captureLogger = Logger.make<unknown, void>((options) => {
			captured.push({
				logLevel: options.logLevel as unknown as string,
				message: options.message as ReadonlyArray<unknown>,
				cause: options.cause,
			});
		});
		const captureLayer = Logger.layer([captureLogger]);

		return Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			const fileId = yield* dispatchFileId({ identity, dispatch: walletApiDispatch });
			const fname = dispatchFilename(fileId);

			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					yield* router.boot();
					// Successful contribute — uses the working lock path.
					// The inner scope holds the contributor scope so the
					// scope-close finalizer runs on inner-scope close.
					yield* Effect.scoped(
						Effect.gen(function* () {
							yield* router.contributeRoute({
								kind: 'routable',
								endpointName: 'wallet-app',
								dispatchId: { serviceKey: 'wallet.my-app.main', role: 'api' },
								upstream: { type: 'host-loopback', port: 6173 },
								cors: true,
								wireProtocol: 'http',
							});
							expect(readdirSync(dir)).toContain(fname);
							// Sabotage the lock path: replace the locks/
							// directory with a regular file. The finalizer's
							// acquireStackLock(profile.dispatchLockFile)
							// internally calls mkdirSync(dirname(lockfile), …)
							// which fails ENOTDIR — surfacing as
							// StackLockIoError. removeDispatchFile is wrapped
							// in `Effect.ignore` internally, so the ONLY
							// failure path through the cleanup `Effect.scoped`
							// block is the lock acquisition.
							const locksDir = dirname(profile.dispatchLockFile);
							rmSync(locksDir, { recursive: true, force: true });
							writeFileSync(locksDir, 'sabotage');
							expect(statSync(locksDir).isFile()).toBe(true);
						}),
					);
					// Scope-close ran the finalizer; cleanup failed; the
					// failure was logged + swallowed by Effect.ignore.
					// The dispatch file is leaked on disk (we couldn't
					// acquire the lock to remove it), but the warning
					// surfaces that fact.
					expect(readdirSync(dir)).toContain(fname);
				}).pipe(Effect.provide(makeStackLayer(profile))),
			);

			// Assert: at least one Warn log fired carrying the cleanup
			// banner + the dispatchFileId. The annotations object
			// `{ dispatchFileId, cause }` is the second message arg
			// passed in service.ts:927-930.
			const cleanupWarns = captured.filter(
				(entry) =>
					entry.logLevel === 'Warn' &&
					Array.isArray(entry.message) &&
					typeof entry.message[0] === 'string' &&
					(entry.message[0] as string).includes('router scope-close cleanup failed'),
			);
			expect(cleanupWarns.length).toBeGreaterThan(0);
			const warn = cleanupWarns[0]!;
			const annotations = warn.message[1] as { dispatchFileId: string; cause: unknown };
			expect(annotations.dispatchFileId).toBe(fileId);
			// The cause is a Cause<StackLockError>; assert it has the
			// v4 `reasons` array shape so the underlying lock-
			// acquisition failure is genuinely surfaced (not an empty
			// cause). Per STYLE_GUIDE §1, walk reasons via
			// `Cause.isFailReason` rather than the v3 `_tag === 'Fail'`
			// brittleness.
			const cause = annotations.cause as Cause.Cause<unknown>;
			expect(Array.isArray(cause.reasons)).toBe(true);
			const failReasons = cause.reasons.filter(Cause.isFailReason);
			expect(failReasons.length).toBeGreaterThan(0);
		}).pipe(Effect.provide(captureLayer));
	});

	it.effect('applied SubscriptionRef tracks adds + removes', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					yield* router.boot();
					yield* Effect.scoped(
						Effect.gen(function* () {
							yield* router.contributeRoute({
								kind: 'routable',
								endpointName: 'wallet-app',
								dispatchId: { serviceKey: 'wallet.my-app.main', role: 'api' },
								upstream: { type: 'host-loopback', port: 6173 },
								cors: true,
								wireProtocol: 'http',
							});
							const snap = yield* SubscriptionRef.get(router.applied);
							expect(snap.length).toBe(1);
							expect(snap[0]?.hostname).toBe('api.my-app.localhost');
						}),
					);
					const after = yield* SubscriptionRef.get(router.applied);
					expect(after.length).toBe(0);
				}).pipe(Effect.provide(makeStackLayer(profile))),
			);
		}),
	);

	it.effect('rejects two contributions that collide on (entrypoint, hostname) (invariant #7)', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					yield* router.boot();
					yield* router.contributeRoute({
						kind: 'routable',
						endpointName: 'wallet-app',
						dispatchId: { serviceKey: 'k1', role: 'api' },
						upstream: { type: 'host-loopback', port: 6173 },
						wireProtocol: 'http',
						cors: false,
					});
					// Identical (entrypoint, role) under the same identity →
					// same hostname → collision; different serviceKey
					// means different dispatchFileId but the rule fires
					// on the (hostname, entrypoint) pair.
					const err = yield* router
						.contributeRoute({
							kind: 'routable',
							endpointName: 'wallet-app',
							dispatchId: { serviceKey: 'k2', role: 'api' },
							upstream: { type: 'host-loopback', port: 6174 },
							wireProtocol: 'http',
							cors: false,
						})
						.pipe(Effect.flip);
					expect(err._tag).toBe('RouteCollision');
				}).pipe(Effect.provide(makeStackLayer(profile))),
			);
		}),
	);

	it.effect('rejects a TCP route when a foreign dispatch file already owns the entrypoint', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			const foreignRoute: ResolvedRoute = {
				dispatchFileId: 'foreign-postgres',
				hostname: 'db.other-app.localhost',
				entrypointName: 'postgres-tcp',
				entrypointPort: 5432,
				upstreamUrl: 'tcp://172.20.0.9:5432',
				cors: false,
				wireProtocol: 'tcp',
			};
			writeFileSync(
				join(dir, dispatchFilename(foreignRoute.dispatchFileId)),
				renderRouteYaml(foreignRoute, makeLease(profile)),
			);

			yield* Effect.scoped(
				Effect.gen(function* () {
					const router = yield* RouterService;
					yield* router.boot();
					const err = yield* router
						.contributeRoute({
							kind: 'routable',
							endpointName: 'postgres-tcp',
							dispatchId: { serviceKey: 'postgres.my-app.main', role: 'db' },
							upstream: {
								type: 'container',
								containerName: 'postgres-c1',
								containerPort: 5432,
							},
							wireProtocol: 'tcp',
						})
						.pipe(Effect.flip);

					expect(err._tag).toBe('RouteCollision');
					if (err._tag !== 'RouteCollision') throw new Error(`unexpected error: ${err._tag}`);
					expect(err.entrypoint).toBe('postgres-tcp');
					expect(err.dispatchIds).toContain('foreign-postgres');
				}).pipe(Effect.provide(makeStackLayer(profile))),
			);
		}),
	);
});
