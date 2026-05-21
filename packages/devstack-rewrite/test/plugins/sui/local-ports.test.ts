// Sui local-mode port resolution.
//
// Defaults are brokered preferences so parallel stacks can reassign
// away from 9000/9123. Explicit `opts.ports` remains an exact static
// mapping, including the historical partial-override fallback.

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type {
	AllocateOptions,
	AllocatedPort,
	PortBroker,
} from '../../../src/substrate/runtime/port-broker/index.ts';
import {
	DEFAULT_HOST_FAUCET_PORT,
	DEFAULT_HOST_RPC_PORT,
	resolvePublishedPortMapping,
	resolvePortMapping,
	selectReusablePortMapping,
} from '../../../src/plugins/sui/mode/local.ts';

const fakeBroker = (allocate: (opts: AllocateOptions) => number): PortBroker => ({
	allocate: (opts) =>
		Effect.succeed({
			port: allocate(opts),
			kind: opts.kind,
			release: Effect.void,
		} satisfies AllocatedPort),
});

describe('Sui local port mapping', () => {
	it.effect('brokered defaults allocate replacements for other-stack collisions', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const calls: AllocateOptions[] = [];
				const broker = fakeBroker((opts) => {
					calls.push(opts);
					return opts.kind === 'rpc' ? 51000 : 50000;
				});

				const ports = yield* resolvePortMapping(broker, undefined);

				expect(calls).toEqual([
					{
						kind: 'rpc',
						preferredPort: DEFAULT_HOST_RPC_PORT,
						probeHost: '0.0.0.0',
					},
					{
						kind: 'http',
						preferredPort: DEFAULT_HOST_FAUCET_PORT,
						probeHost: '0.0.0.0',
					},
				]);
				expect(ports).toEqual([
					{ containerPort: 9000, hostPort: 51000, hostIp: '0.0.0.0' },
					{ containerPort: 9123, hostPort: 50000, hostIp: '0.0.0.0' },
				]);
			}),
		),
	);

	it('adopted same-stack container ports override brokered replacements', () => {
		const requestedAfterBrokerCollision = [
			{ containerPort: 9000, hostPort: 51000, hostIp: '0.0.0.0' },
			{ containerPort: 9123, hostPort: 51230, hostIp: '0.0.0.0' },
		];
		const actualFromAdoptedContainer = [
			{ containerPort: 9000, hostPort: DEFAULT_HOST_RPC_PORT, hostIp: '0.0.0.0' },
			{ containerPort: 9123, hostPort: DEFAULT_HOST_FAUCET_PORT, hostIp: '0.0.0.0' },
		];

		expect(
			resolvePublishedPortMapping(requestedAfterBrokerCollision, actualFromAdoptedContainer),
		).toEqual(actualFromAdoptedContainer);
	});

	it('same-stack inventory ports are reusable before broker allocation', () => {
		const existing = [
			{
				id: 'same-stack',
				name: 'devstack-app-main-sui-validator',
				imageName: 'sui:local',
				status: 'running',
				ips: [],
				ports: [
					{ containerPort: 9000, hostPort: DEFAULT_HOST_RPC_PORT, hostIp: '0.0.0.0' },
					{ containerPort: 9123, hostPort: DEFAULT_HOST_FAUCET_PORT, hostIp: '0.0.0.0' },
				],
			},
			{
				id: 'other',
				name: 'devstack-app-other-sui-validator',
				imageName: 'sui:local',
				status: 'running',
				ips: [],
				ports: [
					{ containerPort: 9000, hostPort: 51000, hostIp: '0.0.0.0' },
					{ containerPort: 9123, hostPort: 50000, hostIp: '0.0.0.0' },
				],
			},
		] as const;

		expect(selectReusablePortMapping(existing, 'devstack-app-main-sui-validator')).toEqual(
			existing[0]!.ports,
		);
	});

	it.effect('explicit opts.ports are exact and do not call the broker', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const broker = fakeBroker(() => {
					throw new Error('explicit ports should not allocate');
				});

				const ports = yield* resolvePortMapping(broker, { 9000: 19000 });

				expect(ports).toEqual([
					{ containerPort: 9000, hostPort: 19000, hostIp: '0.0.0.0' },
					{
						containerPort: 9123,
						hostPort: DEFAULT_HOST_FAUCET_PORT,
						hostIp: '0.0.0.0',
					},
				]);
			}),
		),
	);
});
