// Unit tests for the Walrus release publisher/aggregator/upload-relay container lifecycle.

import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import type {
	ContainerRuntime,
	EnsureContainerSpec,
} from '../../../src/contracts/container-runtime.ts';
import {
	DEFAULT_WALRUS_CLIENT_SERVICE_PORT,
	DEFAULT_WALRUS_UPLOAD_RELAY_SERVICE_PORT,
	WALRUS_CLIENT_CONFIG_FILE,
	WALRUS_CLIENT_KEYSTORE_FILE,
	WALRUS_CLIENT_SERVICE_STOP_SIGNAL,
	WALRUS_CLIENT_WALLET_FILE,
	startWalrusClientServices,
	walrusClientServiceConfigHash,
} from '../../../src/plugins/walrus/client-services.ts';
import { makeContainerRuntimeStub } from '../../helpers/container-runtime-stub.ts';

const runtimeCapturingServiceSpecs = (
	specs: EnsureContainerSpec[],
	execCommands: ReadonlyArray<string>[] = [],
): ContainerRuntime =>
	makeContainerRuntimeStub({
		ensureContainer: (spec) =>
			Effect.sync(() => {
				specs.push(spec);
				return {
					id: `container-${spec.name}`,
					name: spec.name,
					imageName: spec.image.tag ?? spec.image.digest,
					status: 'running' as const,
					ips: [],
					labels: spec.labels,
				};
			}),
		exec: (_handle, command) =>
			Effect.sync(() => {
				execCommands.push(command);
				return { exitCode: 0, stdout: '', stderr: '' };
			}),
	});

describe('walrus client services', () => {
	it('starts release aggregator, publisher, and upload-relay services in managed containers', async () => {
		const specs: EnsureContainerSpec[] = [];
		const execCommands: string[][] = [];
		const services = await Effect.runPromise(
			Effect.scoped(
				startWalrusClientServices(runtimeCapturingServiceSpecs(specs, execCommands), {
					app: 'private-content',
					stack: 'main',
					walrusName: 'walrus',
					images: {
						aggregator: { digest: 'sha256:walrus', tag: 'devstack-walrus:aggregator' },
						publisher: { digest: 'sha256:walrus', tag: 'devstack-walrus:publisher' },
						uploadRelay: { digest: 'sha256:walrus', tag: 'devstack-walrus:upload-relay' },
					},
					options: {
						aggregator: { port: DEFAULT_WALRUS_CLIENT_SERVICE_PORT },
						publisher: { port: DEFAULT_WALRUS_CLIENT_SERVICE_PORT },
						uploadRelay: { port: DEFAULT_WALRUS_UPLOAD_RELAY_SERVICE_PORT },
					},
					walrusNetworkName: 'walrus-net',
					suiNetworkName: 'sui-net',
					deployHostMountPath: '/tmp/devstack/walrus/walrus/deploy',
					stackRoot: '/tmp/devstack',
					deployConfigHash: 'deploy-hash',
					suiRpcUrlInNetwork: 'http://host.docker.internal:9123',
				}),
			),
		);

		expect(services.aggregator?.containerName).toBe(
			'devstack-private-content-main-walrus-walrus-aggregator',
		);
		expect(services.publisher?.containerName).toBe(
			'devstack-private-content-main-walrus-walrus-publisher',
		);
		expect(services.uploadRelay?.containerName).toBe(
			'devstack-private-content-main-walrus-walrus-upload-relay',
		);
		expect(specs.map((spec) => spec.command)).toEqual([
			['aggregator'],
			['publisher'],
			['upload-relay'],
		]);
		expect(specs.map((spec) => spec.labels.role)).toEqual([
			'aggregator',
			'publisher',
			'upload-relay',
		]);
		expect(specs.map((spec) => spec.networkAttach)).toEqual([
			['walrus-net', 'sui-net'],
			['walrus-net', 'sui-net'],
			['walrus-net', 'sui-net'],
		]);
		expect(specs.map((spec) => spec.env?.WALRUS_CLIENT_SERVICE_BIND_ADDRESS)).toEqual([
			'0.0.0.0:31415',
			'0.0.0.0:31415',
			'0.0.0.0:3000',
		]);
		expect(specs.map((spec) => spec.env?.SUI_RPC_URL)).toEqual([
			'http://host.docker.internal:9123',
			'http://host.docker.internal:9123',
			'http://host.docker.internal:9123',
		]);
		expect(specs.map((spec) => spec.stopSignal)).toEqual([
			WALRUS_CLIENT_SERVICE_STOP_SIGNAL,
			WALRUS_CLIENT_SERVICE_STOP_SIGNAL,
			WALRUS_CLIENT_SERVICE_STOP_SIGNAL,
		]);
		expect(specs.map((spec) => spec.extraHosts)).toEqual([
			{ 'host.docker.internal': 'host-gateway' },
			{ 'host.docker.internal': 'host-gateway' },
			{ 'host.docker.internal': 'host-gateway' },
		]);
		expect(specs.map((spec) => spec.mounts?.[0])).toEqual([
			{ source: '/tmp/devstack', target: '/opt/walrus/runtime', readonly: true },
			{ source: '/tmp/devstack', target: '/opt/walrus/runtime', readonly: true },
			{ source: '/tmp/devstack', target: '/opt/walrus/runtime', readonly: true },
		]);
		const probes = execCommands.map((command) => command.join(' '));
		expect(probes).toEqual(
			expect.arrayContaining([
				expect.stringContaining('http://127.0.0.1:31415/status'),
				expect.stringContaining('http://127.0.0.1:3000/v1/tip-config'),
			]),
		);
	});

	it('omits disabled services', async () => {
		const specs: EnsureContainerSpec[] = [];
		const services = await Effect.runPromise(
			Effect.scoped(
				startWalrusClientServices(runtimeCapturingServiceSpecs(specs), {
					app: 'private-content',
					stack: 'main',
					walrusName: 'walrus',
					images: {
						aggregator: null,
						publisher: { digest: 'sha256:walrus', tag: 'devstack-walrus:publisher' },
						uploadRelay: null,
					},
					options: {
						aggregator: null,
						publisher: { port: 40101 },
						uploadRelay: null,
					},
					walrusNetworkName: 'walrus-net',
					suiNetworkName: 'sui-net',
					deployHostMountPath: '/tmp/devstack/walrus/walrus/deploy',
					stackRoot: '/tmp/devstack',
					deployConfigHash: 'deploy-hash',
					suiRpcUrlInNetwork: 'http://host.docker.internal:9123',
				}),
			),
		);

		expect(services.aggregator).toBeNull();
		expect(services.publisher?.containerPort).toBe(40101);
		expect(services.uploadRelay).toBeNull();
		expect(specs).toHaveLength(1);
		expect(specs[0]?.command).toEqual(['publisher']);
	});

	it('folds role, port, deploy mount, networks, and RPC into config drift', () => {
		const base = {
			role: 'aggregator' as const,
			deployConfigHash: 'deploy-a',
			deploySourceHostPath: '/runtime-a',
			deployMountTarget: '/opt/walrus/runtime',
			containerPort: 31415,
			walrusNetworkName: 'walrus-net',
			suiNetworkName: 'sui-net',
			suiRpcUrlInNetwork: 'http://host.docker.internal:9123',
		};

		expect(walrusClientServiceConfigHash(base)).toContain(
			`client=${WALRUS_CLIENT_CONFIG_FILE},${WALRUS_CLIENT_WALLET_FILE},${WALRUS_CLIENT_KEYSTORE_FILE}`,
		);
		expect(walrusClientServiceConfigHash(base)).not.toBe(
			walrusClientServiceConfigHash({ ...base, role: 'publisher' }),
		);
		expect(walrusClientServiceConfigHash(base)).not.toBe(
			walrusClientServiceConfigHash({ ...base, role: 'upload-relay' }),
		);
		expect(walrusClientServiceConfigHash(base)).not.toBe(
			walrusClientServiceConfigHash({ ...base, containerPort: 40101 }),
		);
		expect(walrusClientServiceConfigHash(base)).not.toBe(
			walrusClientServiceConfigHash({
				...base,
				suiRpcUrlInNetwork: 'http://host.docker.internal:9124',
			}),
		);
	});
});
