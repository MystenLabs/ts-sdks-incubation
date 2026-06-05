// Sui local-mode port resolution.
//
// Defaults are brokered preferences so parallel stacks can reassign
// away from 9000/9123. Explicit `opts.ports` remains an exact static
// mapping, including the historical partial-override fallback.

import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type {
	ContainerRuntime,
	ContainerRuntimeError,
	EnsureContainerSpec,
} from '../../../src/contracts/container-runtime.ts';
import { makeContainerRuntimeStub } from '../../helpers/container-runtime-stub.ts';
import type {
	AllocateOptions,
	AllocatedPort,
	PortBroker,
} from '../../../src/substrate/runtime/port-broker/index.ts';
import { PortBrokerError } from '../../../src/substrate/runtime/port-broker/index.ts';
import { appName, stackName } from '../../../src/substrate/brand.ts';
import {
	DEFAULT_HOST_FAUCET_PORT,
	DEFAULT_HOST_GRAPHQL_PORT,
	DEFAULT_HOST_RPC_PORT,
	ensureLocalValidatorContainer,
	LOCAL_VALIDATOR_STOP_GRACE_SECONDS,
	MAX_DOCKER_PUBLISH_PORT_RETRIES,
	resolvePublishedPortMapping,
	resolvePortMapping,
	selectReusablePortMapping,
} from '../../../src/plugins/sui/mode/local.ts';

// Resolved indexer wiring — the sui-owned sidecar shape: DSN dials the
// in-network alias `sui-indexer-db`, network is the per-stack sui-indexer net.
const TEST_INDEXER = {
	url: 'postgres://devstack:pw@sui-indexer-db:5432/sui_indexer',
	network: 'devstack-wallet-wallet-sui-indexer',
} as const;

const fakeBroker = (allocate: (opts: AllocateOptions) => number): PortBroker => ({
	allocate: (opts = {}) =>
		Effect.succeed({
			port: allocate(opts),
			release: Effect.void,
		} satisfies AllocatedPort),
});

const strictStatefulBroker = (): PortBroker => {
	const held = new Set<number>();
	return {
		allocate: (opts = {}) => {
			const port = opts.preferredPort ?? (opts.owner === 'sui:faucet' ? 50000 : 51000);
			if (held.has(port)) {
				return Effect.fail(
					new PortBrokerError({
						reason: 'preferred-busy',
						detail: `preferred port ${port} (owner=${opts.owner ?? 'unknown'}) is already held by another allocation in this stack`,
					}),
				);
			}
			held.add(port);
			return Effect.succeed({
				port,
				release: Effect.sync(() => {
					held.delete(port);
				}),
			} satisfies AllocatedPort);
		},
	};
};

const publishPortConflict = (port: number): ContainerRuntimeError => ({
	_tag: 'ContainerRuntimeError',
	reason: 'publish-port-conflict',
	detail: `docker publish failed: Bind for 0.0.0.0:${port} failed: port is already allocated`,
});

const unusedRuntime = (
	ensureContainer: ContainerRuntime['ensureContainer'],
	inspectByLabels: ContainerRuntime['inspectByLabels'] = () => Effect.succeed([]),
): ContainerRuntime => makeContainerRuntimeStub({ ensureContainer, inspectByLabels });

describe('Sui local port mapping', () => {
	it.effect('brokered defaults allocate replacements for other-stack collisions', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const calls: AllocateOptions[] = [];
				const broker = fakeBroker((opts) => {
					calls.push(opts);
					return opts.preferredPort ?? (opts.owner === 'sui:faucet' ? 50000 : 51000);
				});

				const ports = yield* resolvePortMapping(broker, undefined);

				expect(calls).toEqual([
					{
						owner: 'sui:rpc',
						preferredPort: DEFAULT_HOST_RPC_PORT,
						probeHost: '0.0.0.0',
					},
					{
						owner: 'sui:faucet',
						preferredPort: DEFAULT_HOST_FAUCET_PORT,
						probeHost: '0.0.0.0',
					},
					{
						owner: 'sui:graphql',
						preferredPort: DEFAULT_HOST_GRAPHQL_PORT,
						probeHost: '0.0.0.0',
					},
				]);
				expect(ports).toEqual([
					{ containerPort: 9000, hostPort: DEFAULT_HOST_RPC_PORT, hostIp: '0.0.0.0' },
					{ containerPort: 9123, hostPort: DEFAULT_HOST_FAUCET_PORT, hostIp: '0.0.0.0' },
					{ containerPort: 9125, hostPort: DEFAULT_HOST_GRAPHQL_PORT, hostIp: '0.0.0.0' },
				]);
			}),
		),
	);

	it.effect('lets GraphQL scan when RPC fallback consumes the GraphQL default', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const calls: AllocateOptions[] = [];
				const broker: PortBroker = {
					allocate: (opts = {}) => {
						calls.push(opts);
						if (opts.preferredPort === DEFAULT_HOST_RPC_PORT) {
							return Effect.succeed({
								port: DEFAULT_HOST_GRAPHQL_PORT,
								release: Effect.void,
							} satisfies AllocatedPort);
						}
						if (opts.preferredPort === DEFAULT_HOST_GRAPHQL_PORT) {
							return Effect.fail(
								new PortBrokerError({
									reason: 'preferred-busy',
									detail: `preferred port ${DEFAULT_HOST_GRAPHQL_PORT} (owner=${opts.owner ?? 'unknown'}) is already held by another allocation in this stack`,
								}),
							);
						}
						return Effect.succeed({
							port:
								opts.preferredPort ??
								(opts.owner === 'sui:faucet' ? DEFAULT_HOST_FAUCET_PORT : 51002),
							release: Effect.void,
						} satisfies AllocatedPort);
					},
				};

				const ports = yield* resolvePortMapping(broker, undefined);

				expect(calls).toEqual([
					{
						owner: 'sui:rpc',
						preferredPort: DEFAULT_HOST_RPC_PORT,
						probeHost: '0.0.0.0',
					},
					{
						owner: 'sui:faucet',
						preferredPort: DEFAULT_HOST_FAUCET_PORT,
						probeHost: '0.0.0.0',
					},
					{
						owner: 'sui:graphql',
						preferredPort: DEFAULT_HOST_GRAPHQL_PORT,
						probeHost: '0.0.0.0',
					},
					{
						owner: 'sui:graphql',
						probeHost: '0.0.0.0',
					},
				]);
				expect(ports).toEqual([
					{ containerPort: 9000, hostPort: DEFAULT_HOST_GRAPHQL_PORT, hostIp: '0.0.0.0' },
					{ containerPort: 9123, hostPort: DEFAULT_HOST_FAUCET_PORT, hostIp: '0.0.0.0' },
					{ containerPort: 9125, hostPort: 51002, hostIp: '0.0.0.0' },
				]);
			}),
		),
	);

	it('adopted same-stack container ports override brokered replacements', () => {
		const requestedAfterBrokerCollision = [
			{ containerPort: 9000, hostPort: 51000, hostIp: '0.0.0.0' },
			{ containerPort: 9123, hostPort: 51230, hostIp: '0.0.0.0' },
			{ containerPort: 9125, hostPort: 51001, hostIp: '0.0.0.0' },
		];
		const actualFromAdoptedContainer = [
			{ containerPort: 9000, hostPort: DEFAULT_HOST_RPC_PORT, hostIp: '0.0.0.0' },
			{ containerPort: 9123, hostPort: DEFAULT_HOST_FAUCET_PORT, hostIp: '0.0.0.0' },
			{ containerPort: 9125, hostPort: DEFAULT_HOST_GRAPHQL_PORT, hostIp: '0.0.0.0' },
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
					{ containerPort: 9125, hostPort: DEFAULT_HOST_GRAPHQL_PORT, hostIp: '0.0.0.0' },
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
					{ containerPort: 9125, hostPort: 51001, hostIp: '0.0.0.0' },
				],
			},
		] as const;

		expect(selectReusablePortMapping(existing, 'devstack-app-main-sui-validator')).toEqual(
			existing[0]!.ports,
		);
	});

	it('does not reuse old local containers that lack GraphQL port publishing', () => {
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
		] as const;

		expect(selectReusablePortMapping(existing, 'devstack-app-main-sui-validator')).toBeUndefined();
	});

	it.effect('keeps clean validator state but recreates after unclean shutdowns', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const specs: EnsureContainerSpec[] = [];
				const broker = fakeBroker(
					(opts) => opts.preferredPort ?? (opts.owner === 'sui:faucet' ? 50000 : 51000),
				);
				const runtime = unusedRuntime((spec) => {
					specs.push(spec);
					return Effect.succeed({
						id: 'container-id',
						name: spec.name,
						imageName: spec.image.tag ?? spec.image.digest,
						status: 'running',
						ips: [],
						ports: spec.ports,
					});
				});

				yield* ensureLocalValidatorContainer(
					runtime,
					broker,
					{ digest: 'sha256:sui', tag: 'sui:local' },
					{ app: appName('wallet'), stack: stackName('wallet'), plugin: 'sui', role: 'validator' },
					'devstack-wallet-wallet-sui-validator',
					{ mode: 'local' },
					TEST_INDEXER,
				);

				expect(specs).toHaveLength(1);
				expect(specs[0]?.recreate).toBe('on-failure');
				expect(specs[0]?.stopGraceSeconds).toBe(LOCAL_VALIDATOR_STOP_GRACE_SECONDS);
				expect(specs[0]?.stopSignal).toBe('SIGINT');
				// External indexer: join the postgres network + hand the DSN
				// to the entrypoint.
				expect(specs[0]?.networkAttach).toEqual([TEST_INDEXER.network]);
				expect(specs[0]?.env).toEqual({ DEVSTACK_SUI_INDEXER_URL: TEST_INDEXER.url });
			}),
		),
	);

	it.effect('omits the indexer network + env when no indexer is supplied', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const specs: EnsureContainerSpec[] = [];
				const broker = fakeBroker(
					(opts) => opts.preferredPort ?? (opts.owner === 'sui:faucet' ? 50000 : 51000),
				);
				const runtime = unusedRuntime((spec) => {
					specs.push(spec);
					return Effect.succeed({
						id: 'container-id',
						name: spec.name,
						imageName: spec.image.tag ?? spec.image.digest,
						status: 'running',
						ips: [],
						ports: spec.ports,
					});
				});

				yield* ensureLocalValidatorContainer(
					runtime,
					broker,
					{ digest: 'sha256:sui', tag: 'sui:local' },
					{ app: appName('wallet'), stack: stackName('wallet'), plugin: 'sui', role: 'validator' },
					'devstack-wallet-wallet-sui-validator',
					{ mode: 'local' },
					undefined,
				);

				expect(specs).toHaveLength(1);
				expect(specs[0]?.networkAttach).toBeUndefined();
				expect(specs[0]?.env).toBeUndefined();
			}),
		),
	);

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
					{
						containerPort: 9125,
						hostPort: DEFAULT_HOST_GRAPHQL_PORT,
						hostIp: '0.0.0.0',
					},
				]);
			}),
		),
	);

	it.effect('retries Docker publish conflicts with fresh exact port bindings', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const allocationPorts = [51001, 50001, 51002, 51003, 50002, 51004];
				const calls: AllocateOptions[] = [];
				const specs: EnsureContainerSpec[] = [];
				const broker = fakeBroker((opts) => {
					calls.push(opts);
					const port = allocationPorts.shift();
					if (port === undefined) throw new Error('unexpected extra allocation');
					return port;
				});
				const runtime = unusedRuntime((spec) => {
					specs.push(spec);
					if (specs.length === 1) return Effect.fail(publishPortConflict(51001));
					return Effect.succeed({
						id: 'container-id',
						name: spec.name,
						imageName: spec.image.tag ?? spec.image.digest,
						status: 'running',
						ips: [],
						ports: spec.ports,
					});
				});

				const result = yield* ensureLocalValidatorContainer(
					runtime,
					broker,
					{ digest: 'sha256:sui', tag: 'sui:local' },
					{ app: appName('wallet'), stack: stackName('wallet'), plugin: 'sui', role: 'validator' },
					'devstack-wallet-wallet-sui-validator',
					{ mode: 'local' },
					TEST_INDEXER,
				);

				expect(result.ports).toEqual([
					{ containerPort: 9000, hostPort: 51003, hostIp: '0.0.0.0' },
					{ containerPort: 9123, hostPort: 50002, hostIp: '0.0.0.0' },
					{ containerPort: 9125, hostPort: 51004, hostIp: '0.0.0.0' },
				]);
				expect(calls).toHaveLength(6);
				expect(specs).toHaveLength(2);
				expect(specs[0]?.ports).toEqual([
					{ containerPort: 9000, hostPort: 51001, hostIp: '0.0.0.0' },
					{ containerPort: 9123, hostPort: 50001, hostIp: '0.0.0.0' },
					{ containerPort: 9125, hostPort: 51002, hostIp: '0.0.0.0' },
				]);
				expect(specs[0]?.portBindingReconciliation).toBe('adopt-existing');
				expect(specs[1]?.ports).toEqual(result.ports);
				expect(specs[1]?.portBindingReconciliation).toBe('exact');
			}),
		),
	);

	it.effect('releases abandoned default allocations before publish-conflict retry', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const calls: Array<AllocateOptions | undefined> = [];
				const specs: EnsureContainerSpec[] = [];
				const broker = strictStatefulBroker();
				const recordingBroker: PortBroker = {
					allocate: (opts) => {
						calls.push(opts);
						return broker.allocate(opts);
					},
				};
				const runtime = unusedRuntime((spec) => {
					specs.push(spec);
					if (specs.length === 1) return Effect.fail(publishPortConflict(DEFAULT_HOST_RPC_PORT));
					return Effect.succeed({
						id: 'container-id',
						name: spec.name,
						imageName: spec.image.tag ?? spec.image.digest,
						status: 'running',
						ips: [],
						ports: spec.ports,
					});
				});

				const result = yield* ensureLocalValidatorContainer(
					runtime,
					recordingBroker,
					{ digest: 'sha256:sui', tag: 'sui:local' },
					{ app: appName('wallet'), stack: stackName('wallet'), plugin: 'sui', role: 'validator' },
					'devstack-wallet-wallet-sui-validator',
					{ mode: 'local' },
					TEST_INDEXER,
				);

				expect(result.ports).toEqual([
					{ containerPort: 9000, hostPort: DEFAULT_HOST_RPC_PORT, hostIp: '0.0.0.0' },
					{ containerPort: 9123, hostPort: DEFAULT_HOST_FAUCET_PORT, hostIp: '0.0.0.0' },
					{ containerPort: 9125, hostPort: DEFAULT_HOST_GRAPHQL_PORT, hostIp: '0.0.0.0' },
				]);
				expect(calls).toHaveLength(6);
				expect(specs).toHaveLength(2);
				expect(specs[0]?.ports).toEqual(result.ports);
				expect(specs[1]?.ports).toEqual(result.ports);
				expect(specs[1]?.portBindingReconciliation).toBe('exact');
			}),
		),
	);

	it.effect('surfaces publish-port-conflict after the bounded retry budget', () =>
		Effect.scoped(
			Effect.gen(function* () {
				let nextPort = 51000;
				const broker = fakeBroker(() => nextPort++);
				const runtime = unusedRuntime((spec) =>
					Effect.fail(publishPortConflict(spec.ports?.[0]?.hostPort ?? 0)),
				);

				const exit = yield* ensureLocalValidatorContainer(
					runtime,
					broker,
					{ digest: 'sha256:sui', tag: 'sui:local' },
					{ app: appName('wallet'), stack: stackName('wallet'), plugin: 'sui', role: 'validator' },
					'devstack-wallet-wallet-sui-validator',
					{ mode: 'local' },
					TEST_INDEXER,
				).pipe(Effect.exit);

				expect(Exit.isFailure(exit)).toBe(true);
				const errOpt = Exit.findErrorOption(exit);
				expect(errOpt._tag).toBe('Some');
				const error = errOpt._tag === 'Some' ? errOpt.value : undefined;
				expect(error).toMatchObject({
					_tag: 'SuiPluginError',
					phase: 'container-start',
				});
				expect(error?.message).toContain('publish-port-conflict');
				expect(nextPort).toBe(51000 + (MAX_DOCKER_PUBLISH_PORT_RETRIES + 1) * 3);
			}),
		),
	);
});
