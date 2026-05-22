import { Effect } from 'effect';

import { capabilitySink, defineCapability } from '../core.ts';

export interface HealthCheckPayload {
	readonly url: string;
	readonly intervalMs: number;
}

declare module '../core.ts' {
	interface DevstackCapabilityRegistry {
		readonly 'health-check': HealthCheckPayload;
	}
}

export const healthCheck = defineCapability('health-check');

export const healthCheckSink = capabilitySink(
	'health-check',
	(capability) =>
		Effect.sync(() => {
			void capability.url;
			void capability.intervalMs;
		}),
);
