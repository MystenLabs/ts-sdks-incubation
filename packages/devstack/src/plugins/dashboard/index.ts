// Dashboard plugin.
//
// Runs an in-process GraphQL server (Pothos schema + graphql-yoga) that
// exposes the live projection, control commands, and the projection
// subscription. Modeled on the `wallet` plugin: allocate a loopback port
// from the port broker, start a scoped HTTP server, and contribute a
// Routable so the router fronts it under `dashboard.<app>.<stack>.localhost`.
//
// Data access is pure control plane: the projection (`state`) and command
// publisher (`publishCommand`) come from `ControlPlaneService`, handed to
// the server as the GraphQL context.

import { Effect } from 'effect';
import { type AnyPlugin, definePlugin, resource } from '../../api/define-plugin.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import type { ContainerRuntime } from '../../contracts/container-runtime.ts';
import { ControlPlaneService } from '../../substrate/runtime/control-plane/service.ts';
import { IdentityContext } from '../../substrate/runtime/paths.ts';
import { PortBrokerService } from '../../substrate/runtime/port-broker/index.ts';
import { renderUrl, routedHostname } from '../../substrate/runtime/routed-url.ts';
import { listenScopedHttpServer } from '../../substrate/runtime/scoped-http-server.ts';
import { buildDashboardDomain } from './domain.ts';
import { resolveOriginPolicy } from './origin-policy.ts';
import {
	DASHBOARD_ENTRYPOINT_PORT,
	DASHBOARD_ROUTE_ROLE,
	makeDashboardRoutable,
} from './routable.ts';
import { makeDashboardListener } from './server.ts';

export interface DashboardOptions {
	/** Preferred loopback port; the broker forward-scans if it's busy. */
	readonly port?: number;
	/** NIC the HTTP server binds. Defaults to `'0.0.0.0'` because the router
	 *  runs in Docker and must reach this host process through the host-gateway
	 *  address on native Linux (a `127.0.0.1`-only listener is unreachable from
	 *  the host-gateway IP). The public dashboard URL stays router-fronted and
	 *  stack-scoped. */
	readonly bindAddress?: string;
	/** Extra origins merged on top of the dashboard's own router-fronted origin
	 *  for this stack (and the direct loopback origins). Useful for headless
	 *  test runners and custom dev hosts. The dashboard does NOT auto-allowlist
	 *  a bare `*.localhost` form — that is not stack-scoped, so a sibling stack
	 *  could drive the destructive control-plane mutations cross-origin. */
	readonly allowedOrigins?: ReadonlyArray<string>;
	// Note on log retention: the queryable cross-service log store the
	// dashboard reads is process-scoped and owned by the SUPERVISOR (not this
	// plugin), so its capacity is configured there. Tune it with the
	// `DEVSTACK_DASHBOARD_LOG_CAPACITY` (per-service record cap, default 2000)
	// and `DEVSTACK_DASHBOARD_LOG_MAX_SERVICES` (distinct-ring cap, default
	// 256) env vars, or programmatically via `SupervisorStartupOptions.logStore`.
	// See substrate/runtime/observability/log-store.ts.
}

export interface DashboardValue {
	/** Loopback URL of the dashboard server. */
	readonly url: string;
	/** The allocated loopback port. */
	readonly localPort: number;
}

const dashboardResource = resource<'dashboard', DashboardValue>('dashboard');
// `0.0.0.0`: the router runs in Docker, so on native Linux it reaches this
// host process through the Docker host-gateway address instead of host
// loopback — a `127.0.0.1`-only listener is unreachable from that IP, which
// produced a 502 from Traefik and the `RouteReadinessProbeFailed` WARN. The
// published dashboard URL remains stack-scoped through the router. Mirrors
// `WALLET_DEFAULT_BIND_ADDRESS`.
const DASHBOARD_DEFAULT_BIND = '0.0.0.0';

/** Construct the devstack dashboard plugin. */
export function dashboard(opts: DashboardOptions = {}): AnyPlugin {
	return definePlugin({
		id: dashboardResource.id,
		role: 'service',
		section: 'service',
		start: () =>
			Effect.gen(function* () {
				const portBroker = yield* PortBrokerService;
				const control = yield* ControlPlaneService;
				const identity = yield* IdentityContext;
				// The ContainerRuntime drives the Postgres `psql` exec-probe.
				// It is in the base substrate plugin context in production
				// wiring; read it optionally so bare smoke-test paths that
				// don't layer it degrade `postgresStats` to unavailable
				// rather than failing acquisition.
				const containerRuntimeOpt = yield* Effect.serviceOption(ContainerRuntimeService);
				const containerRuntime: ContainerRuntime | null =
					containerRuntimeOpt._tag === 'Some' ? containerRuntimeOpt.value : null;

				// Plugin-name-aware shaping lives HERE (the plugin layer is
				// allowed to name plugins), built off the generic, name-blind
				// control-plane `resolvedValues` seam + the container runtime.
				const pluginDomain = buildDashboardDomain({
					control: control.domain,
					identity,
					containerRuntime,
				});

				const bindAddress = opts.bindAddress ?? DASHBOARD_DEFAULT_BIND;
				const allocated = yield* portBroker.allocate({
					owner: 'dashboard',
					windowHint: { start: 39300, size: 1000 },
					probeHost: bindAddress === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
					...(opts.port === undefined ? {} : { preferredPort: opts.port }),
				});

				// Derive the dashboard's OWN router-fronted origin for this stack.
				// The bundled SPA is served same-origin from this hostname, so the
				// browser's `Origin` on `/graphql` is exactly this value — it MUST
				// be in the allowlist. Host = `<role:api>.<app>.<stack>.localhost`
				// (per `routedHostname`), port = the router entrypoint port (9810),
				// which is the port the browser actually uses, NOT the broker
				// loopback port. Router-derivation failure → `null` (allowlist still
				// includes the direct loopback + caller origins).
				const routedDashboardOrigin = yield* routedHostname(identity, DASHBOARD_ROUTE_ROLE).pipe(
					Effect.map((hostname) =>
						renderUrl({ protocol: 'http', hostname, port: DASHBOARD_ENTRYPOINT_PORT }),
					),
					Effect.orElseSucceed(() => null),
				);

				// Direct loopback origins: when the dashboard is reached on the raw
				// broker port (host-loopback fallback / direct tooling) the SPA's
				// same-origin `Origin` is the loopback form. Both 127.0.0.1 and
				// localhost name the same listener; allow both for this stack's port.
				const directOrigins = [
					`http://127.0.0.1:${allocated.port}`,
					`http://localhost:${allocated.port}`,
				];

				const originPolicy = yield* resolveOriginPolicy({
					app: identity.app,
					stack: identity.stack,
					routedDashboardOrigin,
					directOrigins,
					extraOrigins: opts.allowedOrigins ?? [],
				});

				const server = yield* listenScopedHttpServer({
					bindAddress,
					port: allocated.port,
					listener: makeDashboardListener({
						originPolicy,
						context: {
							state: control.state,
							publishCommand: control.publishCommand,
							domain: control.domain,
							pluginDomain,
						},
					}),
					onListenError: (cause) =>
						new Error(
							`dashboard HTTP server listen failed on ${bindAddress}:${allocated.port}: ${String(cause)}`,
						),
				});

				return { url: server.url, localPort: allocated.port } satisfies DashboardValue;
			}),
		capabilities: ({ value, runtime }) => [
			makeDashboardRoutable({
				app: runtime.identity.app,
				stack: runtime.identity.stack,
				port: value.localPort,
			}),
		],
	});
}
