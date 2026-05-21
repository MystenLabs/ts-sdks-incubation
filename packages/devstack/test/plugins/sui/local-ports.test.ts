// Sui local-mode port resolution.
//
// Defaults are brokered preferences so parallel stacks can reassign
// away from 9000/9123. Explicit `opts.ports` remains an exact static
// mapping, including the historical partial-override fallback.

import { Effect, Exit, Stream } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type {
	ContainerRuntime,
	ContainerRuntimeError,
	EnsureContainerSpec,
} from '../../../src/contracts/container-runtime.ts';
import type {
	AllocateOptions,
	AllocatedPort,
	PortBroker,
} from '../../../src/substrate/runtime/port-broker/index.ts';
import { PortBrokerError } from '../../../src/substrate/runtime/port-broker/index.ts';
import { appName, stackName } from '../../../src/substrate/brand.ts';
import {
	DEFAULT_HOST_FAUCET_PORT,
	DEFAULT_HOST_RPC_PORT,
	ensureLocalValidatorContainer,
	MAX_DOCKER_PUBLISH_PORT_RETRIES,
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

const strictStatefulBroker = (): PortBroker => {
	const held = new Set<number>();
	return {
		allocate: (opts) => {
			const port = opts.preferredPort ?? (opts.kind === 'rpc' ? 51000 : 50000);
			if (held.has(port)) {
				return Effect.fail(
					new PortBrokerError({
						reason: 'preferred-busy',
						detail: `preferred port ${port} (${opts.kind}) is already held by another allocation in this stack`,
					}),
				);
			}
			held.add(port);
			return Effect.succeed({
				port,
				kind: opts.kind,
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
): ContainerRuntime => ({
	ensureImage: () => Effect.die('ensureImage not used'),
	ensureNetwork: () => Effect.die('ensureNetwork not used'),
	ensureContainer,
	inspectByLabels,
	exec: () => Effect.die('exec not used'),
	runOneShot: () => Effect.die('runOneShot not used'),
	followLogs: () => Stream.die('followLogs not used'),
	pauseAndCommit: () => Effect.die('pauseAndCommit not used'),
	saveImage: () => Stream.die('saveImage not used'),
	loadImage: () => Effect.die('loadImage not used'),
	tagImage: () => Effect.die('tagImage not used'),
	unpause: () => Effect.die('unpause not used'),
	stop: () => Effect.die('stop not used'),
	sweepOrphans: () => Effect.die('sweepOrphans not used'),
	removeManagedContainers: () => Effect.die('removeManagedContainers not used'),
	removeManagedNetworks: () => Effect.die('removeManagedNetworks not used'),
	removeManagedVolumes: () => Effect.die('removeManagedVolumes not used'),
	removeManagedImages: () => Effect.die('removeManagedImages not used'),
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

	it.effect('retries Docker publish conflicts with fresh exact port bindings', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const allocationPorts = [51001, 50001, 51002, 50002];
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
				);

				expect(result.ports).toEqual([
					{ containerPort: 9000, hostPort: 51002, hostIp: '0.0.0.0' },
					{ containerPort: 9123, hostPort: 50002, hostIp: '0.0.0.0' },
				]);
				expect(calls).toHaveLength(4);
				expect(specs).toHaveLength(2);
				expect(specs[0]?.ports).toEqual([
					{ containerPort: 9000, hostPort: 51001, hostIp: '0.0.0.0' },
					{ containerPort: 9123, hostPort: 50001, hostIp: '0.0.0.0' },
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
				const calls: AllocateOptions[] = [];
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
				);

				expect(result.ports).toEqual([
					{ containerPort: 9000, hostPort: DEFAULT_HOST_RPC_PORT, hostIp: '0.0.0.0' },
					{ containerPort: 9123, hostPort: DEFAULT_HOST_FAUCET_PORT, hostIp: '0.0.0.0' },
				]);
				expect(calls).toHaveLength(4);
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
				expect(nextPort).toBe(51000 + (MAX_DOCKER_PUBLISH_PORT_RETRIES + 1) * 2);
			}),
		),
	);
});
