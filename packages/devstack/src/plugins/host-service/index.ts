// Generic host-process service plugin.
//
// Use this for browser dev servers and other local host processes that
// should be supervised by devstack rather than launched manually in a
// sibling terminal.

import { Effect } from 'effect';

import { definePlugin, resource, type AnyResourceRef } from '../../api/define-plugin.ts';
import { pluginErrorContributions } from '../../api/plugin-errors.ts';
import {
	PortBrokerService,
	type PortProbeHost,
} from '../../substrate/runtime/port-broker/index.ts';
import { PostAcquireTasksService } from '../../substrate/runtime/post-acquire-tasks.ts';
import { Logger } from '../../substrate/runtime/observability/index.ts';
import { CurrentPluginKey } from '../../substrate/runtime/current-plugin.ts';
import { IdentityContext, RuntimeRoot } from '../../substrate/runtime/paths.ts';

import {
	HOST_SERVICE_ERROR_TAGS,
	HostServiceAcquireError,
	type HostServiceConfigError,
	type HostServiceError,
} from './errors.ts';
import {
	acquireHostService,
	normalizeHostServiceOptions,
	prepareHostService,
	HOST_SERVICE_PORT_TOKEN,
	type HostServiceOptions,
	type PreparedHostService,
	type HostServiceResolvedOptions,
	type HostServiceValue,
	type HostServiceReadyProbe,
	type HostProcessChild,
	type HostProcessSpawner,
	type HostProcessSpawnOptions,
	type HostServiceAcquireContext,
} from './service.ts';
import {
	HOST_SERVICE_DEFAULT_ENDPOINT_NAME,
	HOST_SERVICE_DEFAULT_ENTRYPOINT_PORT,
	makeHostServiceRoutable,
} from './routable.ts';

export const hostServiceResourceId = <Name extends string>(name: Name): `host-service/${Name}` =>
	`host-service/${name}`;

export const hostServiceResource = <Name extends string>(name: Name) =>
	resource<`host-service/${Name}`, HostServiceValue>(hostServiceResourceId(name));

const hostServiceErrorContributions = pluginErrorContributions(HOST_SERVICE_ERROR_TAGS);
const HOST_SERVICE_PORT_PROBE_HOST: PortProbeHost = '0.0.0.0';

export type HostServiceAfter = ReadonlyArray<AnyResourceRef>;

export const hostService = <const After extends HostServiceAfter = readonly []>(
	options: HostServiceOptions<After>,
) => {
	const normalized = normalizeHostServiceOptions(options);
	const serviceResource = hostServiceResource(normalized.serviceName);
	const after = options.after ?? ([] as unknown as After);

	return definePlugin({
		id: serviceResource.id,
		dependsOn: after,
		role: 'service',
		section: 'service',
		start: () =>
			Effect.gen(function* () {
				const portBroker = yield* PortBrokerService;
				const logger = yield* Logger;
				const currentPlugin = yield* CurrentPluginKey;
				const postAcquireTasks = yield* PostAcquireTasksService;
				// Effective stack + runtime root for this supervised run, so
				// the host-service can publish them into the spawned child's
				// env. The Vite plugin runs IN that child and re-discovers the
				// manifest via `resolveDiscoveryEnv(process.env)`; `--stack` is
				// a CLI flag that never reaches the child otherwise. Sourced
				// from the same boot-wired `Identity` / `RuntimeRoot` the rest
				// of the run uses, so the values point at the real manifest at
				// `<root>/stacks/<stack>/manifest.json`.
				const identity = yield* IdentityContext;
				const { root: runtimeRoot } = yield* RuntimeRoot;
				const acquireContext = {
					allocatePort: (preferredPort) =>
						portBroker
							.allocate({
								owner: `host-service:${normalized.serviceName}`,
								probeHost: HOST_SERVICE_PORT_PROBE_HOST,
								...(preferredPort === undefined ? {} : { preferredPort }),
							})
							.pipe(Effect.map((allocation) => allocation.port)),
					logger,
					pluginKey: currentPlugin.key,
					discoveryIdentity: { stack: identity.stack, runtimeRoot },
				} satisfies HostServiceAcquireContext;
				const prepared = yield* prepareHostService(normalized, acquireContext);
				yield* postAcquireTasks.register({
					pluginKey: currentPlugin.key,
					label: `host-service:${normalized.serviceName}.start`,
					run: prepared.start,
				});
				return prepared.value;
			}),
		errorContributions: hostServiceErrorContributions,
		capabilities: ({ value }) =>
			[
				makeHostServiceRoutable({
					endpointName: value.endpointName,
					serviceName: value.name,
					port: value.port,
				}),
			] as const,
	});
};

export type {
	HostServiceAcquireContext,
	HostServiceError,
	HostServiceOptions,
	PreparedHostService,
	HostServiceReadyProbe,
	HostServiceResolvedOptions,
	HostServiceValue,
	HostProcessChild,
	HostProcessSpawner,
	HostProcessSpawnOptions,
	HostServiceConfigError,
};
export {
	acquireHostService,
	prepareHostService,
	HOST_SERVICE_DEFAULT_ENDPOINT_NAME,
	HOST_SERVICE_DEFAULT_ENTRYPOINT_PORT,
	HOST_SERVICE_ERROR_TAGS,
	HOST_SERVICE_PORT_TOKEN,
	HostServiceAcquireError,
	makeHostServiceRoutable,
	normalizeHostServiceOptions,
};
