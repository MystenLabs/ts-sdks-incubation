// Generic host-process service plugin.
//
// Use this for browser dev servers and other local host processes that
// should be supervised by devstack rather than launched manually in a
// sibling terminal.

import { Effect, Option } from 'effect';

import { capabilities } from '../../api/define-capabilities.ts';
import { consumeMembers, type ConsumesTagsOf } from '../../api/consume-members.ts';
import { defineNodePlugin } from '../../api/define-plugin.ts';
import { pluginErrorContributions } from '../../api/plugin-authoring.ts';
import { defineTag } from '../../api/tag.ts';
import type { AnyMember } from '../../substrate/plugin.ts';
import { PortBrokerService } from '../../substrate/runtime/port-broker/index.ts';
import { Logger } from '../../substrate/runtime/observability/index.ts';
import { CurrentPluginKey } from '../../substrate/runtime/current-plugin.ts';
import { PostAcquireTasksService } from '../../substrate/runtime/post-acquire-tasks.ts';

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

export const hostServiceTagId = <Name extends string>(name: Name): `host-service/${Name}` =>
	`host-service/${name}`;

export const hostServiceTag = <Name extends string>(name: Name) =>
	defineTag<`host-service/${Name}`, HostServiceValue>(
		hostServiceTagId(name),
		hostServiceTagId(name),
	);

const hostServiceErrorContributions = pluginErrorContributions(HOST_SERVICE_ERROR_TAGS);

export type HostServiceNeeds = ReadonlyArray<AnyMember>;
export type HostServiceConsumes<Needs extends HostServiceNeeds> = ConsumesTagsOf<Needs>;

export const hostService = <const Needs extends HostServiceNeeds = readonly []>(
	options: HostServiceOptions<Needs>,
) => {
	const normalized = normalizeHostServiceOptions(options);
	const tag = hostServiceTag(normalized.serviceName);
	const needs = options.needs ?? ([] as unknown as Needs);
	const consumedNeeds = consumeMembers(needs);
	const consumes = consumedNeeds.consumesTags as HostServiceConsumes<Needs>;

	return defineNodePlugin({
		provides: tag,
		consumes,
		kind: 'leaf-long-running',
		rebootCost: 'cheap',
		acquire: () =>
			Effect.gen(function* () {
				const portBroker = yield* PortBrokerService;
				const logger = yield* Logger;
				const currentPlugin = yield* CurrentPluginKey;
				const acquireContext = {
					allocatePort: (preferredPort) =>
						portBroker
							.allocate({
								kind: 'http',
								...(preferredPort === undefined ? {} : { preferredPort }),
							})
							.pipe(Effect.map((allocation) => allocation.port)),
					logger,
					pluginKey: currentPlugin.key,
				} satisfies HostServiceAcquireContext;
				const prepared = yield* prepareHostService(normalized, acquireContext);
				const postAcquireTasks = yield* Effect.serviceOption(PostAcquireTasksService);
				if (Option.isSome(postAcquireTasks)) {
					yield* postAcquireTasks.value.register({
						pluginKey: currentPlugin.key,
						label: `host-service/${normalized.serviceName}`,
						run: prepared.start,
					});
					return prepared.value;
				}
				yield* prepared.start;
				return prepared.value;
			}),
		errorContributions: hostServiceErrorContributions,
		capabilities: (resolved) =>
			capabilities(
				makeHostServiceRoutable({
					endpointName: resolved.endpointName,
					serviceName: resolved.name,
					port: resolved.port,
				}),
			),
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
