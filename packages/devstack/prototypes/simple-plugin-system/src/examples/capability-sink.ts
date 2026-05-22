import { routeCapabilities, type RuntimeContext } from '../core.ts';
import { healthCheckSink } from './health-check-capability.ts';

const runtime = {
	identity: { app: 'prototype', stack: 'capabilities' },
	chain: 'localnet',
	runtimeRoot: '/tmp/devstack-prototype',
} satisfies RuntimeContext;

const routedCapabilities = [
	{
		kind: 'health-check',
		url: 'redis://127.0.0.1:6379/cache',
		intervalMs: 1000,
	},
	{
		kind: 'third-party-observer',
	},
];

export const capabilityRouting = routeCapabilities(routedCapabilities, [healthCheckSink], runtime);
