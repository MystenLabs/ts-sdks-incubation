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
import { listenScopedHttpServer } from '../../substrate/runtime/scoped-http-server.ts';
import { buildDashboardDomain } from './domain.ts';
import { makeDashboardRoutable } from './routable.ts';
import { makeDashboardListener } from './server.ts';

export interface DashboardOptions {
	/** Preferred loopback port; the broker forward-scans if it's busy. */
	readonly port?: number;
	/** Bind address for the loopback listener. Defaults to `127.0.0.1`. */
	readonly bindAddress?: string;
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
const DASHBOARD_DEFAULT_BIND = '127.0.0.1';

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

				const server = yield* listenScopedHttpServer({
					bindAddress,
					port: allocated.port,
					listener: makeDashboardListener({
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
