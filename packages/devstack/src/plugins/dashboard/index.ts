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
import { ControlPlaneService } from '../../substrate/runtime/control-plane/service.ts';
import { PortBrokerService } from '../../substrate/runtime/port-broker/index.ts';
import { listenScopedHttpServer } from '../../substrate/runtime/scoped-http-server.ts';
import { makeDashboardRoutable } from './routable.ts';
import { makeDashboardListener } from './server.ts';

export interface DashboardOptions {
	/** Preferred loopback port; the broker forward-scans if it's busy. */
	readonly port?: number;
	/** Bind address for the loopback listener. Defaults to `127.0.0.1`. */
	readonly bindAddress?: string;
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
