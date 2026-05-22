// File-provider config renderer + resolver coverage.
//
// Architecture invariants under test:
//   #1  — file-provider config layout (http.routers + http.services).
//   #5  — atomic-write happens elsewhere; here we cover the pure
//          renderer output is byte-stable.
//   #7  — collision detection rejects two routes on the same
//          (entrypoint, hostname) pair.
//   #9  — `cors: true` references the shared middleware by name.

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { CORS_MIDDLEWARE_NAME } from '../../../src/orchestrators/router/cors.ts';
import { makeEntrypointRegistry } from '../../../src/orchestrators/router/entrypoints.ts';
import {
	detectCollisions,
	dispatchFilename,
	parseDispatchRouteFile,
	parseDispatchRouteMetadata,
	renderRouteYaml,
	ROUTER_ROUTE_LEASE_VERSION,
	resolveRoute,
	type RouteLeaseMetadata,
	type ResolvedRoute,
	type UpstreamResolver,
} from '../../../src/orchestrators/router/file-provider.ts';
import { appName, chainId, stackName } from '../../../src/substrate/brand.ts';

const identity = {
	app: appName('my-app'),
	stack: stackName('main'),
	chain: chainId('sui:localnet'),
};

const stubUpstreams: UpstreamResolver = {
	resolveContainer: (target) =>
		Effect.succeed({ host: '172.20.0.5', port: target.containerPort }).pipe(
			Effect.tap(() => Effect.sync(() => target.containerName)), // touch for coverage
		),
	resolveHostLoopback: (target) => Effect.succeed({ host: '127.0.0.1', port: target.port }),
};

const registry = makeEntrypointRegistry([
	{ name: 'wallet-app', port: 6173, protocol: 'http' },
	{ name: 'walrus-aggregator', port: 9185, protocol: 'http' },
	{ name: 'postgres-tcp', port: 5432, protocol: 'tcp' },
]);

const lease: RouteLeaseMetadata = {
	version: ROUTER_ROUTE_LEASE_VERSION,
	routerProfileId: 'test-profile',
	app: 'my-app',
	stack: 'main',
	owner: {
		pid: 123,
		startTime: 456,
		hostname: 'test-host',
		claimedAt: 789,
		heartbeatAt: 789,
		intent: 'normal',
	},
};

describe('resolveRoute', () => {
	it.effect('resolves a host-loopback Routable into a complete ResolvedRoute', () =>
		Effect.gen(function* () {
			const r = yield* resolveRoute(
				identity,
				{
					kind: 'routable',
					endpointName: 'wallet-app',
					dispatchId: { compositeKey: 'wallet.my-app.main', role: 'api' },
					upstream: { type: 'host-loopback', port: 6173 },
					cors: true,
					wireProtocol: 'http',
				},
				registry,
				stubUpstreams,
			);
			expect(r.hostname).toBe('api.my-app.localhost');
			expect(r.entrypointPort).toBe(6173);
			expect(r.upstreamUrl).toBe('http://127.0.0.1:6173');
			expect(r.cors).toBe(true);
			expect(r.dispatchFileId).toMatch(/^r1-my-app-main-wallet-my-app-main-api-[a-f0-9]{64}$/);
		}),
	);

	it.effect('resolves a container Routable using the shared-network IP', () =>
		Effect.gen(function* () {
			const r = yield* resolveRoute(
				identity,
				{
					kind: 'routable',
					endpointName: 'walrus-aggregator',
					dispatchId: { compositeKey: 'walrus.local', role: 'walrus-aggregator' },
					upstream: {
						type: 'container',
						containerName: 'walrus-node-0',
						containerPort: 8080,
					},
					wireProtocol: 'http',
					cors: true,
				},
				registry,
				stubUpstreams,
			);
			expect(r.upstreamUrl).toBe('http://172.20.0.5:8080');
			expect(r.hostname).toBe('walrus-aggregator.my-app.localhost');
		}),
	);

	it.effect('resolves a TCP Routable (postgres) — no Host rule, address-style upstream', () =>
		Effect.gen(function* () {
			const r = yield* resolveRoute(
				identity,
				{
					kind: 'routable',
					endpointName: 'postgres-tcp',
					dispatchId: { compositeKey: 'postgres.my-app.main', role: 'db' },
					upstream: {
						type: 'container',
						containerName: 'postgres-c1',
						containerPort: 8080,
					},
					wireProtocol: 'tcp',
				},
				registry,
				stubUpstreams,
			);
			expect(r.wireProtocol).toBe('tcp');
			expect(r.entrypointPort).toBe(5432);
			expect(r.upstreamUrl).toBe('tcp://172.20.0.5:8080');
			expect(r.cors).toBe(false);
		}),
	);

	it.effect('fails RouterValidationError when TCP decl targets an HTTP entrypoint', () =>
		Effect.gen(function* () {
			const err = yield* resolveRoute(
				identity,
				{
					kind: 'routable',
					endpointName: 'wallet-app',
					dispatchId: { compositeKey: 'mismatch', role: 'db' },
					upstream: { type: 'container', containerName: 'c', containerPort: 8080 },
					wireProtocol: 'tcp',
				},
				registry,
				stubUpstreams,
			).pipe(Effect.flip);
			expect(err._tag).toBe('RouterValidationError');
		}),
	);

	it.effect('fails RouterValidationError when HTTP decl targets a TCP entrypoint', () =>
		Effect.gen(function* () {
			const err = yield* resolveRoute(
				identity,
				{
					kind: 'routable',
					endpointName: 'postgres-tcp',
					dispatchId: { compositeKey: 'mismatch', role: 'api' },
					upstream: { type: 'container', containerName: 'c', containerPort: 8080 },
					cors: false,
					wireProtocol: 'http',
				},
				registry,
				stubUpstreams,
			).pipe(Effect.flip);
			expect(err._tag).toBe('RouterValidationError');
		}),
	);

	it.effect('fails UnknownEntrypoint when the endpointName is not registered', () =>
		Effect.gen(function* () {
			const err = yield* resolveRoute(
				identity,
				{
					kind: 'routable',
					endpointName: 'nope',
					dispatchId: { compositeKey: 'k', role: 'r' },
					upstream: { type: 'host-loopback', port: 6173 },
					wireProtocol: 'http',
					cors: false,
				},
				registry,
				stubUpstreams,
			).pipe(Effect.flip);
			expect(err._tag).toBe('UnknownEntrypoint');
		}),
	);
});

describe('renderRouteYaml', () => {
	const route: ResolvedRoute = {
		dispatchFileId: 'wallet-my-app-main--api',
		hostname: 'api.my-app.localhost',
		entrypointName: 'wallet-app',
		entrypointPort: 6173,
		upstreamUrl: 'http://127.0.0.1:6173',
		cors: true,
		wireProtocol: 'http',
	};

	it('emits http.routers + http.services with Host rule', () => {
		const yaml = renderRouteYaml(route, lease);
		expect(yaml).toContain('routers:');
		expect(yaml).toContain('services:');
		expect(yaml).toContain('Host(`api.my-app.localhost`)');
		expect(yaml).toContain('entryPoints: ["wallet-app"]');
		expect(yaml).toContain('url: "http://127.0.0.1:6173"');
	});

	it('emits parseable dispatch metadata for cross-process collision checks', () => {
		const yaml = renderRouteYaml(route, lease);
		expect(parseDispatchRouteMetadata(yaml)).toEqual({
			dispatchFileId: route.dispatchFileId,
			hostname: route.hostname,
			entrypointName: route.entrypointName,
			entrypointPort: route.entrypointPort,
			wireProtocol: route.wireProtocol,
			lease,
		});
	});

	it('keeps route metadata when the lease version is unknown and emits a diagnostic', () => {
		const yaml = renderRouteYaml(route, lease).replace(
			'# routeLeaseVersion: 1',
			'# routeLeaseVersion: 999',
		);
		const parsed = parseDispatchRouteFile(yaml);
		expect(parsed._tag).toBe('valid');
		if (parsed._tag !== 'valid') throw new Error('expected valid route metadata');
		expect(parsed.route).toMatchObject({
			dispatchFileId: route.dispatchFileId,
			hostname: route.hostname,
			entrypointName: route.entrypointName,
			entrypointPort: route.entrypointPort,
			wireProtocol: route.wireProtocol,
			lease: null,
		});
		expect(parsed.diagnostics).toEqual([
			expect.objectContaining({
				_tag: 'DispatchRouteDecodeDiagnostic',
				dispatchFileId: route.dispatchFileId,
				reason: 'unknown-route-lease-version',
			}),
		]);
	});

	it('keeps the dispatch file id for unparseable route files', () => {
		const parsed = parseDispatchRouteFile('not a traefik route', 'broken-route');
		expect(parsed).toEqual({
			_tag: 'invalid',
			dispatchFileId: 'broken-route',
			diagnostics: [
				expect.objectContaining({
					dispatchFileId: 'broken-route',
					reason: 'missing-required-route-metadata',
				}),
			],
		});
	});

	it('references the shared CORS middleware when cors:true (invariant #9)', () => {
		const yaml = renderRouteYaml(route, lease);
		expect(yaml).toContain(CORS_MIDDLEWARE_NAME);
		expect(yaml).toContain(
			[
				`      service: "${route.dispatchFileId}-svc"`,
				`      middlewares: ["${CORS_MIDDLEWARE_NAME}"]`,
				`  services:`,
			].join('\n'),
		);
	});

	it('omits the middleware reference when cors:false', () => {
		const yaml = renderRouteYaml({ ...route, cors: false }, lease);
		expect(yaml).not.toContain(CORS_MIDDLEWARE_NAME);
	});

	it('is byte-stable on identical inputs (no-op rewrite friendly)', () => {
		expect(renderRouteYaml(route, lease)).toBe(renderRouteYaml(route, lease));
	});

	it('emits a tcp.routers + tcp.services block for wireProtocol=tcp', () => {
		const tcp: ResolvedRoute = {
			dispatchFileId: 'postgres-my-app-main--db',
			hostname: 'db.my-app.localhost',
			entrypointName: 'postgres-tcp',
			entrypointPort: 5432,
			upstreamUrl: 'tcp://172.20.0.5:5432',
			cors: false,
			wireProtocol: 'tcp',
		};
		const yaml = renderRouteYaml(tcp, lease);
		expect(yaml).toContain('tcp:');
		expect(yaml).toContain('HostSNI(`*`)');
		expect(yaml).toContain('entryPoints: ["postgres-tcp"]');
		expect(yaml).toContain('address: "172.20.0.5:5432"');
		// TCP must NOT carry the HTTP/CORS surface.
		expect(yaml).not.toContain(CORS_MIDDLEWARE_NAME);
		expect(yaml).not.toContain('Host(`');
		expect(yaml).not.toMatch(/^http:/m);
		expect(parseDispatchRouteMetadata(yaml)).toMatchObject({
			dispatchFileId: tcp.dispatchFileId,
			entrypointName: 'postgres-tcp',
			entrypointPort: 5432,
			wireProtocol: 'tcp',
		});
	});
});

describe('detectCollisions', () => {
	const base: ResolvedRoute = {
		dispatchFileId: 'a',
		hostname: 'api.my-app.localhost',
		entrypointName: 'wallet-app',
		entrypointPort: 6173,
		upstreamUrl: 'http://127.0.0.1:6173',
		cors: true,
		wireProtocol: 'http',
	};

	it('returns null on a unique set', () => {
		expect(
			detectCollisions([base, { ...base, dispatchFileId: 'b', hostname: 'other.host' }]),
		).toBeNull();
	});

	it('detects two routes on the same (entrypoint, hostname)', () => {
		const collision = detectCollisions([base, { ...base, dispatchFileId: 'b' }]);
		expect(collision).not.toBeNull();
		expect(collision?._tag).toBe('RouteCollision');
		expect(collision?.message).toContain("entrypoint 'wallet-app'");
		expect(collision?.message).toContain("hostname 'api.my-app.localhost'");
		expect(collision?.dispatchIds.length).toBe(2);
	});

	it('detects two TCP routes on the same entrypoint (port-exclusive)', () => {
		const tcpA: ResolvedRoute = {
			dispatchFileId: 'pg-stack-a',
			hostname: 'a.localhost',
			entrypointName: 'postgres-tcp',
			entrypointPort: 5432,
			upstreamUrl: 'tcp://172.20.0.5:5432',
			cors: false,
			wireProtocol: 'tcp',
		};
		const tcpB: ResolvedRoute = { ...tcpA, dispatchFileId: 'pg-stack-b', hostname: 'b.localhost' };
		const collision = detectCollisions([tcpA, tcpB]);
		expect(collision).not.toBeNull();
		expect(collision?._tag).toBe('RouteCollision');
		expect(collision?.message).toContain("TCP route collision on entrypoint 'postgres-tcp'");
	});

	it('detects two TCP routes on different entrypoint names backed by the same host port', () => {
		const tcpA: ResolvedRoute = {
			dispatchFileId: 'tcp-a',
			hostname: 'a.localhost',
			entrypointName: 'postgres-tcp',
			entrypointPort: 5432,
			upstreamUrl: 'tcp://172.20.0.5:5432',
			cors: false,
			wireProtocol: 'tcp',
		};
		const tcpB: ResolvedRoute = {
			...tcpA,
			dispatchFileId: 'tcp-b',
			entrypointName: 'postgres-readonly-tcp',
		};
		const collision = detectCollisions([tcpA, tcpB]);
		expect(collision).not.toBeNull();
		expect(collision?.entrypoint).toBe('postgres-tcp');
	});

	it('detects HTTP routes with the same Host rule on the same host port', () => {
		const collision = detectCollisions([
			base,
			{ ...base, dispatchFileId: 'b', entrypointName: 'wallet-alias' },
		]);
		expect(collision).not.toBeNull();
		expect(collision?.hostname).toBe(base.hostname);
	});

	it('allows a TCP and HTTP route on different entrypoints', () => {
		const tcp: ResolvedRoute = {
			dispatchFileId: 'pg',
			hostname: 'db.localhost',
			entrypointName: 'postgres-tcp',
			entrypointPort: 5432,
			upstreamUrl: 'tcp://172.20.0.5:5432',
			cors: false,
			wireProtocol: 'tcp',
		};
		expect(detectCollisions([base, tcp])).toBeNull();
	});
});

describe('dispatchFilename', () => {
	it('prefixes per-backend files with `10-` (sorts after CORS `00-`)', () => {
		expect(dispatchFilename('wallet-my-app-main--api')).toBe('10-wallet-my-app-main--api.yml');
	});
});
