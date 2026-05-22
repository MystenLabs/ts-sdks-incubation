// File-provider config generator.
//
// Architecture invariant #1: file-provider ONLY, never docker-provider.
// We materialize per-backend dispatch entries as YAML files in a
// watched directory; Traefik's file-provider polls + reloads on
// change. The docker-provider was rejected because the container IP
// we need is the *shared-network* IP that lands AFTER `network connect`,
// and the docker-provider captures the per-stack IP at first event
// and never refreshes.
//
// One file per canonical route identity. Each file carries exactly
// one router + one service (and references the shared CORS middleware
// when `cors: true`). This layout means atomic add/remove of a route
// is one file create/unlink — no merge step, no race.
//
// Two YAML shapes live under this renderer, discriminated by the
// resolved route's `wireProtocol`:
//
//   HTTP / h2c (Host-header dispatch on a shared port):
//
//     http:
//       routers:
//         <id>-router:
//           rule: "Host(`<hostname>`)"
//           entryPoints: ["<entrypointName>"]
//           service: "<id>-svc"
//           middlewares: ["devstack-cors"]  # when cors: true
//       services:
//         <id>-svc:
//           loadBalancer:
//             servers:
//               - url: "http://<upstream-host>:<upstream-port>"
//
//   TCP (per-entrypoint-port dispatch; ONE backend per entrypoint):
//
//     tcp:
//       routers:
//         <id>-router:
//           rule: "HostSNI(`*`)"
//           entryPoints: ["<entrypointName>"]
//           service: "<id>-svc"
//       services:
//         <id>-svc:
//           loadBalancer:
//             servers:
//               - address: "<upstream-host>:<upstream-port>"
//
// HostSNI(`*`) matches any incoming TCP connection on the entrypoint
// (Traefik requires every TCP router to have a rule; `*` is the wildcard
// that means "any client"). No CORS section — TCP isn't HTTP and the
// shared CORS middleware lives under `http.middlewares`.

import { Effect } from 'effect';

import type { RoutableDecl } from '../../contracts/routable.ts';
import type { RosterHolder } from '../../substrate/cross-process.ts';
import type { Identity } from '../../substrate/identity.ts';
import { CORS_MIDDLEWARE_NAME } from './cors.ts';
import type { EntrypointRegistryShape } from './entrypoints.ts';
import { RouteCollision, RouterValidationError, type UnknownEntrypoint } from './errors.ts';
import { dispatchFileId, renderUrl, routerHostname } from './hostname.ts';

export const ROUTE_READINESS_HEADER = 'X-Devstack-Route-Id';

// ---------------------------------------------------------------------------
// Resolved-route data structure
// ---------------------------------------------------------------------------

/** Resolved wire-protocol. `'tcp'` carries no hostname matcher and no
 *  CORS. The router orchestrator's renderer + collision-detector branch
 *  on this. */
export type ResolvedWireProtocol = 'http' | 'h2c' | 'tcp';

/** A `RoutableDecl` resolved by the orchestrator: hostname minted,
 *  dispatch-id stringified, entrypoint port resolved, upstream URL
 *  resolved. This is the shape the file-provider renderer consumes —
 *  decoupled from the resolution path so testing the renderer is
 *  pure. */
export interface ResolvedRoute {
	readonly dispatchFileId: string;
	/** Minted hostname for HTTP routes. For TCP routes this is still
	 *  computed (it's the host string the URL surfaces to consumers),
	 *  but the Traefik router rule is `HostSNI(\`*\`)` — TCP dispatches
	 *  by entrypoint port, not Host. */
	readonly hostname: string;
	readonly entrypointName: string;
	readonly entrypointPort: number;
	/** Upstream URL string. For HTTP this is `http://<host>:<port>`; for
	 *  TCP it's still rendered as `tcp://<host>:<port>` so the renderer
	 *  can pull host+port back out for the `address:` field. */
	readonly upstreamUrl: string;
	readonly cors: boolean;
	readonly wireProtocol: ResolvedWireProtocol;
}

export interface RouteCollisionMetadata {
	readonly dispatchFileId: string;
	readonly hostname: string;
	readonly entrypointName: string;
	readonly entrypointPort: number | null;
	readonly wireProtocol: ResolvedWireProtocol;
}

export const ROUTER_ROUTE_LEASE_VERSION = 1;

export interface RouteLeaseMetadata {
	readonly version: typeof ROUTER_ROUTE_LEASE_VERSION;
	readonly routerProfileId: string;
	readonly app: string;
	readonly stack: string;
	readonly owner: RosterHolder;
}

export interface DispatchRouteMetadata extends RouteCollisionMetadata {
	readonly lease: RouteLeaseMetadata | null;
}

export type DispatchRouteDecodeReason =
	| 'missing-required-route-metadata'
	| 'unknown-route-lease-version'
	| 'invalid-route-lease-metadata';

export interface DispatchRouteDecodeDiagnostic {
	readonly _tag: 'DispatchRouteDecodeDiagnostic';
	readonly dispatchFileId: string;
	readonly reason: DispatchRouteDecodeReason;
	readonly detail: string;
}

export type DispatchRouteParseResult =
	| {
			readonly _tag: 'valid';
			readonly route: DispatchRouteMetadata;
			readonly diagnostics: ReadonlyArray<DispatchRouteDecodeDiagnostic>;
	  }
	| {
			readonly _tag: 'invalid';
			readonly dispatchFileId: string;
			readonly diagnostics: ReadonlyArray<DispatchRouteDecodeDiagnostic>;
	  };

/** Filename within the dispatch directory for a given file-id. The
 *  `10-` prefix sorts behind the shared CORS middleware (`00-`) so
 *  Traefik picks up the middleware before any router referencing it. */
export const dispatchFilename = (fileId: string): string => `10-${fileId}.yml`;

// ---------------------------------------------------------------------------
// Resolution — Routable + Identity + EntrypointRegistry + upstream → ResolvedRoute
// ---------------------------------------------------------------------------

/** Upstream-resolution interface the file-provider needs. The
 *  orchestrator threads in concrete resolvers (`runtime/docker` for
 *  containers, the port broker for host-loopback) without leaking
 *  service knowledge. Architecture: "router has no compiled-in
 *  awareness of which services exist." */
export interface UpstreamResolver {
	/** For a container-kind upstream, return `(host, port)` where host
	 *  is the container's shared-network IP and port is the container
	 *  port from the plugin. Bounded retry lives inside the resolver
	 *  (architecture invariant #3). */
	readonly resolveContainer: (target: {
		readonly containerName: string;
		readonly containerPort: number;
	}) => Effect.Effect<{ readonly host: string; readonly port: number }, RouterValidationError>;
	/** For a host-loopback-kind upstream, return the bound loopback
	 *  port. The plugin owns port allocation and stamps the resolved
	 *  port into its Routable decl after acquire. */
	readonly resolveHostLoopback: (target: {
		readonly port: number;
	}) => Effect.Effect<{ readonly host: string; readonly port: number }, RouterValidationError>;
}

/** Resolve a single Routable into a ResolvedRoute. Pure-ish: the only
 *  effectful bit is the upstream resolver (which talks to docker /
 *  the port broker) and the entrypoint lookup.
 *
 *  Takes the registry as a parameter rather than yielding the service
 *  tag so the calling orchestrator can pre-bind it once at layer-
 *  construction time, keeping the per-Routable hot path free of
 *  Context lookups. */
export const resolveRoute = (
	identity: Identity,
	decl: RoutableDecl,
	registry: EntrypointRegistryShape,
	upstreams: UpstreamResolver,
): Effect.Effect<ResolvedRoute, RouterValidationError | UnknownEntrypoint> =>
	Effect.gen(function* () {
		const entrypoint = yield* registry.byName(decl.endpointName);
		const hostname = yield* routerHostname(identity, decl.dispatchId.role);
		const fileId = yield* dispatchFileId({ identity, dispatch: decl.dispatchId });
		const upstream =
			decl.upstream.type === 'container'
				? yield* upstreams.resolveContainer({
						containerName: decl.upstream.containerName,
						containerPort: decl.upstream.containerPort,
					})
				: yield* upstreams.resolveHostLoopback({ port: decl.upstream.port });
		const wireProtocol: ResolvedWireProtocol =
			decl.wireProtocol === 'tcp' ? 'tcp' : decl.wireProtocol === 'h2c' ? 'h2c' : 'http';
		// The router contract says: a `wireProtocol: 'tcp'` decl MUST
		// reference an entrypoint whose protocol is also `'tcp'`. The
		// converse holds — HTTP/h2c decls must reference HTTP-family
		// entrypoints. Mismatch is a programming error in the plugin
		// author (caught here once, not at every render).
		const expectFamily: 'tcp' | 'http' = wireProtocol === 'tcp' ? 'tcp' : 'http';
		const entrypointFamily: 'tcp' | 'http' = entrypoint.protocol === 'tcp' ? 'tcp' : 'http';
		if (expectFamily !== entrypointFamily) {
			return yield* Effect.fail(
				new RouterValidationError({
					field: 'entrypointName',
					value: entrypoint.name,
					detail:
						`wireProtocol family mismatch: decl is '${wireProtocol}' but ` +
						`entrypoint '${entrypoint.name}' is '${entrypoint.protocol}'`,
				}),
			);
		}
		// Validate the upstream URL — defense in depth (the resolvers
		// already produce safe values, but this stops a future resolver
		// that returns junk from corrupting the YAML). TCP carries the
		// `tcp://` scheme so we differentiate from the HTTP path; the
		// renderer pulls host+port back out either way.
		const upstreamUrl = renderUrl({
			protocol: wireProtocol === 'tcp' ? 'tcp' : 'http',
			hostname: upstream.host,
			port: upstream.port,
		});
		if (!/^(?:http|tcp):\/\/[A-Za-z0-9_.:-]+:\d+$/.test(upstreamUrl)) {
			return yield* Effect.fail(
				new RouterValidationError({
					field: 'upstreamUrl',
					value: upstreamUrl,
					detail: 'expected http://<host>:<port> or tcp://<host>:<port>',
				}),
			);
		}
		// CORS is HTTP-only — TCP decls don't carry the field. Render
		// uses this; the resolved shape carries `false` for TCP.
		const cors = decl.wireProtocol === 'tcp' ? false : decl.cors;
		return {
			dispatchFileId: fileId,
			hostname,
			entrypointName: entrypoint.name,
			entrypointPort: entrypoint.port,
			upstreamUrl,
			cors,
			wireProtocol,
		};
	});

// ---------------------------------------------------------------------------
// Render — ResolvedRoute → YAML body
// ---------------------------------------------------------------------------

/** Pull host+port out of an `<scheme>://<host>:<port>` URL. Used by the
 *  TCP renderer to write the `address:` field. Safe because
 *  `resolveRoute` validates the URL shape before we get here. */
const splitUpstream = (url: string): { host: string; port: string } => {
	const stripped = url.replace(/^(?:http|tcp):\/\//, '');
	const lastColon = stripped.lastIndexOf(':');
	return {
		host: stripped.slice(0, lastColon),
		port: stripped.slice(lastColon + 1),
	};
};

const renderLeaseHeader = (lease: RouteLeaseMetadata): ReadonlyArray<string> => [
	`# routeLeaseVersion: ${lease.version}`,
	`# routerProfileId: ${lease.routerProfileId}`,
	`# ownerApp: ${lease.app}`,
	`# ownerStack: ${lease.stack}`,
	`# ownerPid: ${lease.owner.pid}`,
	`# ownerStartTime: ${lease.owner.startTime}`,
	`# ownerHostname: ${lease.owner.hostname}`,
	`# ownerClaimedAt: ${lease.owner.claimedAt}`,
	`# ownerHeartbeatAt: ${lease.owner.heartbeatAt}`,
	`# ownerIntent: ${lease.owner.intent}`,
];

/** Render the YAML body for a single resolved route. Hand-rolled
 *  (same rationale as `cors.ts`): static, controlled, byte-stable so
 *  no-op rewrites don't wake the watcher. */
export const renderRouteYaml = (route: ResolvedRoute, lease: RouteLeaseMetadata): string => {
	if (route.wireProtocol === 'tcp') return renderTcpRouteYaml(route, lease);
	return renderHttpRouteYaml(route, lease);
};

const routeReadinessMiddlewareName = (route: ResolvedRoute): string =>
	`${route.dispatchFileId}-route-ready`;

const renderHttpRouteYaml = (route: ResolvedRoute, lease: RouteLeaseMetadata): string => {
	const middlewares = [
		routeReadinessMiddlewareName(route),
		...(route.cors ? [CORS_MIDDLEWARE_NAME] : []),
	];
	const schemeHint =
		route.wireProtocol === 'h2c'
			? `        # h2c upstream — gRPC-friendly cleartext HTTP/2.\n`
			: '';
	return [
		`# Auto-generated by devstack router orchestrator. Do not edit by hand.`,
		`# dispatchFileId: ${route.dispatchFileId}`,
		`# wireProtocol: ${route.wireProtocol}`,
		`# entrypointName: ${route.entrypointName}`,
		`# entrypointPort: ${route.entrypointPort}`,
		`# hostname: ${route.hostname}`,
		...renderLeaseHeader(lease),
		`http:`,
		`  routers:`,
		`    ${route.dispatchFileId}-router:`,
		`      rule: "Host(\`${route.hostname}\`)"`,
		`      entryPoints: ["${route.entrypointName}"]`,
		`      service: "${route.dispatchFileId}-svc"`,
		`      middlewares: [${middlewares.map((name) => `"${name}"`).join(', ')}]`,
		`  middlewares:`,
		`    ${routeReadinessMiddlewareName(route)}:`,
		`      headers:`,
		`        customResponseHeaders:`,
		`          ${ROUTE_READINESS_HEADER}: "${route.dispatchFileId}"`,
		`  services:`,
		`    ${route.dispatchFileId}-svc:`,
		`      loadBalancer:`,
		schemeHint.length > 0 ? schemeHint.trimEnd() : null,
		`        servers:`,
		`          - url: "${route.upstreamUrl}"`,
		``,
	]
		.filter((line): line is string => line !== null)
		.join('\n');
};

const renderTcpRouteYaml = (route: ResolvedRoute, lease: RouteLeaseMetadata): string => {
	const { host, port } = splitUpstream(route.upstreamUrl);
	return [
		`# Auto-generated by devstack router orchestrator. Do not edit by hand.`,
		`# dispatchFileId: ${route.dispatchFileId}`,
		`# wireProtocol: tcp`,
		`# entrypointName: ${route.entrypointName}`,
		`# entrypointPort: ${route.entrypointPort}`,
		`# hostname: ${route.hostname}`,
		`# tcpDispatch: entrypoint-port dispatch; HostSNI wildcard`,
		...renderLeaseHeader(lease),
		`tcp:`,
		`  routers:`,
		`    ${route.dispatchFileId}-router:`,
		`      rule: "HostSNI(\`*\`)"`,
		`      entryPoints: ["${route.entrypointName}"]`,
		`      service: "${route.dispatchFileId}-svc"`,
		`  services:`,
		`    ${route.dispatchFileId}-svc:`,
		`      loadBalancer:`,
		`        servers:`,
		`          - address: "${host}:${port}"`,
		``,
	].join('\n');
};

export const dispatchFileIdFromFilename = (filename: string): string | null => {
	const match = /^10-(.+)\.yml$/.exec(filename);
	return match?.[1] ?? null;
};

const commentValue = (body: string, key: string): string | null => {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = new RegExp(`^# ${escaped}: (.*)$`, 'm').exec(body);
	return match?.[1]?.trim() ?? null;
};

const matchValue = (body: string, pattern: RegExp): string | null =>
	pattern.exec(body)?.[1]?.trim() ?? null;

const commentNumber = (body: string, key: string): number | null => {
	const raw = commentValue(body, key);
	if (raw === null || !/^\d+$/.test(raw)) return null;
	return Number.parseInt(raw, 10);
};

const parseWireProtocol = (body: string): ResolvedWireProtocol | null => {
	const fromComment = commentValue(body, 'wireProtocol');
	if (fromComment === 'http' || fromComment === 'h2c' || fromComment === 'tcp') {
		return fromComment;
	}
	if (/^tcp:/m.test(body)) return 'tcp';
	if (/^http:/m.test(body)) return 'http';
	return null;
};

const hasRouteLeaseMetadata = (body: string): boolean =>
	[
		'routeLeaseVersion',
		'routerProfileId',
		'ownerApp',
		'ownerStack',
		'ownerPid',
		'ownerStartTime',
		'ownerHostname',
		'ownerClaimedAt',
		'ownerHeartbeatAt',
		'ownerIntent',
	].some((key) => commentValue(body, key) !== null);

const parseRouteLeaseMetadata = (
	body: string,
	dispatchFileId: string,
): {
	readonly lease: RouteLeaseMetadata | null;
	readonly diagnostic: DispatchRouteDecodeDiagnostic | null;
} => {
	if (!hasRouteLeaseMetadata(body)) return { lease: null, diagnostic: null };
	const rawVersion = commentValue(body, 'routeLeaseVersion');
	const version = commentNumber(body, 'routeLeaseVersion');
	const routerProfileId = commentValue(body, 'routerProfileId');
	const app = commentValue(body, 'ownerApp');
	const stack = commentValue(body, 'ownerStack');
	const pid = commentNumber(body, 'ownerPid');
	const startTime = commentNumber(body, 'ownerStartTime');
	const hostname = commentValue(body, 'ownerHostname');
	const claimedAt = commentNumber(body, 'ownerClaimedAt');
	const heartbeatAt = commentNumber(body, 'ownerHeartbeatAt');
	const intent = commentValue(body, 'ownerIntent');
	if (version !== ROUTER_ROUTE_LEASE_VERSION) {
		return {
			lease: null,
			diagnostic: {
				_tag: 'DispatchRouteDecodeDiagnostic',
				dispatchFileId,
				reason: 'unknown-route-lease-version',
				detail: `expected routeLeaseVersion ${ROUTER_ROUTE_LEASE_VERSION}, got ${rawVersion ?? '<missing>'}`,
			},
		};
	}
	if (
		routerProfileId === null ||
		app === null ||
		stack === null ||
		pid === null ||
		startTime === null ||
		hostname === null ||
		claimedAt === null ||
		heartbeatAt === null ||
		(intent !== 'normal' && intent !== 'snapshot')
	) {
		return {
			lease: null,
			diagnostic: {
				_tag: 'DispatchRouteDecodeDiagnostic',
				dispatchFileId,
				reason: 'invalid-route-lease-metadata',
				detail: 'route lease metadata is incomplete or malformed',
			},
		};
	}
	return {
		lease: {
			version: ROUTER_ROUTE_LEASE_VERSION,
			routerProfileId,
			app,
			stack,
			owner: {
				pid,
				startTime,
				hostname,
				claimedAt,
				heartbeatAt,
				intent,
			},
		},
		diagnostic: null,
	};
};

export const parseDispatchRouteFile = (
	body: string,
	fallbackDispatchFileId: string | null = null,
): DispatchRouteParseResult => {
	const dispatchFileId = commentValue(body, 'dispatchFileId') ?? fallbackDispatchFileId;
	const wireProtocol = parseWireProtocol(body);
	const entrypointName =
		commentValue(body, 'entrypointName') ?? matchValue(body, /entryPoints: \["([^"]+)"\]/);
	const hostname =
		commentValue(body, 'hostname') ??
		matchValue(body, /Host\(`([^`]+)`\)/) ??
		(wireProtocol === 'tcp' ? '' : null);
	const portRaw = commentValue(body, 'entrypointPort');
	const entrypointPort =
		portRaw === null || !/^\d+$/.test(portRaw) ? null : Number.parseInt(portRaw, 10);

	if (
		dispatchFileId === null ||
		wireProtocol === null ||
		entrypointName === null ||
		hostname === null
	) {
		const protectedDispatchFileId = dispatchFileId ?? '<unknown>';
		return {
			_tag: 'invalid',
			dispatchFileId: protectedDispatchFileId,
			diagnostics: [
				{
					_tag: 'DispatchRouteDecodeDiagnostic',
					dispatchFileId: protectedDispatchFileId,
					reason: 'missing-required-route-metadata',
					detail:
						'route file is missing dispatchFileId, wireProtocol/http|tcp block, entrypointName, or hostname metadata',
				},
			],
		};
	}
	const leaseResult = parseRouteLeaseMetadata(body, dispatchFileId);

	return {
		_tag: 'valid',
		route: {
			dispatchFileId,
			hostname,
			entrypointName,
			entrypointPort,
			wireProtocol,
			lease: leaseResult.lease,
		},
		diagnostics: leaseResult.diagnostic === null ? [] : [leaseResult.diagnostic],
	};
};

export const parseDispatchRouteMetadata = (
	body: string,
	fallbackDispatchFileId: string | null = null,
): DispatchRouteMetadata | null => {
	const parsed = parseDispatchRouteFile(body, fallbackDispatchFileId);
	return parsed._tag === 'valid' ? parsed.route : null;
};

// ---------------------------------------------------------------------------
// Collision detection
// ---------------------------------------------------------------------------

/** Assert no two resolved routes share dispatch keys.
 *
 *  - HTTP routes collide on `(entrypoint, hostname)` — two HTTP backends
 *    on the same entrypoint port can coexist via different Host headers,
 *    so the Host *is* part of the key.
 *  - TCP routes collide on `entrypoint` alone — TCP has no Host header,
 *    so an entrypoint can serve exactly ONE backend. Two TCP decls on
 *    the same entrypoint are an unambiguous error (parallel stacks of
 *    a TCP service share the host port and would clobber each other).
 *
 *  Architecture invariant #7 — distinct identity → distinct dispatch
 *  URL. The TCP arm is the new clause; HTTP arm unchanged. */
export const detectCollisions = (
	routes: ReadonlyArray<RouteCollisionMetadata>,
): RouteCollision | null => {
	const seen = new Map<string, Array<RouteCollisionMetadata>>();
	for (const r of routes) {
		const portKey =
			r.entrypointPort === null ? `entrypoint:${r.entrypointName}` : `port:${r.entrypointPort}`;
		const key = r.wireProtocol === 'tcp' ? `tcp@${portKey}` : `http@${portKey}@${r.hostname}`;
		const acc = seen.get(key);
		if (acc) acc.push(r);
		else seen.set(key, [r]);
	}
	for (const [key, colliding] of seen) {
		if (colliding.length > 1) {
			const ids = colliding.map((route) => route.dispatchFileId);
			const first = colliding[0];
			if (key.startsWith('tcp@')) {
				return new RouteCollision({
					message: routeCollisionMessage({
						hostname: '',
						entrypoint: first?.entrypointName ?? '',
						dispatchIds: ids,
						wireProtocol: 'tcp',
					}),
					hostname: '',
					entrypoint: first?.entrypointName ?? '',
					dispatchIds: ids,
				});
			}
			return new RouteCollision({
				message: routeCollisionMessage({
					hostname: first?.hostname ?? '',
					entrypoint: first?.entrypointName ?? '',
					dispatchIds: ids,
					wireProtocol: 'http',
				}),
				hostname: first?.hostname ?? '',
				entrypoint: first?.entrypointName ?? '',
				dispatchIds: ids,
			});
		}
	}
	return null;
};

const routeCollisionMessage = (collision: {
	readonly hostname: string;
	readonly entrypoint: string;
	readonly dispatchIds: ReadonlyArray<string>;
	readonly wireProtocol: ResolvedWireProtocol;
}): string => {
	const ids = collision.dispatchIds.join(', ');
	if (collision.wireProtocol === 'tcp') {
		return `router TCP route collision on entrypoint '${collision.entrypoint}' for dispatch ids: ${ids}`;
	}
	return (
		`router route collision on entrypoint '${collision.entrypoint}' ` +
		`and hostname '${collision.hostname}' for dispatch ids: ${ids}`
	);
};

// ---------------------------------------------------------------------------
// Static base file — Traefik provider directive
// ---------------------------------------------------------------------------

/** Filename for the file-provider static config. Traefik is launched
 *  with `--providers.file.directory=/etc/traefik/dispatch` so it
 *  reads from there directly; this static file is OPTIONAL polish
 *  and currently unused. Reserved for future provider tuning. */
export const STATIC_PROVIDER_FILENAME = '00-providers.yml';
