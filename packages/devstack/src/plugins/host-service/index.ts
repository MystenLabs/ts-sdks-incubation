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
import { Logger } from '../../substrate/runtime/observability/index.ts';
import { CurrentPluginKey } from '../../substrate/runtime/current-plugin.ts';

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
import { HOST_SERVICE_DEFAULT_ENDPOINT_NAME, makeHostServiceRoutable } from './routable.ts';

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
		start: () =>
			Effect.gen(function* () {
				const portBroker = yield* PortBrokerService;
				const logger = yield* Logger;
				const currentPlugin = yield* CurrentPluginKey;
				const acquireContext = {
					allocatePort: (preferredPort) =>
						portBroker
							.allocate({
								kind: 'http',
								probeHost: HOST_SERVICE_PORT_PROBE_HOST,
								...(preferredPort === undefined ? {} : { preferredPort }),
							})
							.pipe(Effect.map((allocation) => allocation.port)),
					logger,
					pluginKey: currentPlugin.key,
				} satisfies HostServiceAcquireContext;
				const prepared = yield* prepareHostService(normalized, acquireContext);
				yield* prepared.start;
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
	HOST_SERVICE_ERROR_TAGS,
	HOST_SERVICE_PORT_TOKEN,
	HostServiceAcquireError,
	makeHostServiceRoutable,
	normalizeHostServiceOptions,
};
