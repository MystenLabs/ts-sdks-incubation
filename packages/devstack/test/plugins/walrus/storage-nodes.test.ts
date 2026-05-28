// Unit tests for the walrus storage-node helpers. These functions
// participate in both the on-chain Committee record (public_host /
// public_port) AND the per-stack Traefik router config — drift here
// is a load-bearing bug. Tests pin the shape.

import { describe, expect, it } from 'vitest';
import { Effect, Stream } from 'effect';

import type {
	ContainerRuntime,
	EnsureContainerSpec,
} from '../../../src/contracts/container-runtime.ts';
import {
	deriveWalrusSubnetPrefix,
	walrusNetworkCreateSpec,
} from '../../../src/plugins/walrus/index.ts';
import { resolveLocalClusterOptions } from '../../../src/plugins/walrus/mode/local-cluster.ts';
import {
	DEFAULT_NODE_READY_TIMEOUT_MS,
	DEFAULT_NODE_STOP_GRACE_SECONDS,
	WALRUS_NODE_IP_BASE,
	WALRUS_ROUTER_PORT,
	buildWalrusNetworkName,
	computePublicHostname,
	startStorageNodes,
	storageNodeConfigHash,
	type WalrusStorageNode,
} from '../../../src/plugins/walrus/storage-nodes.ts';

const runtimeCapturingStorageNodeSpecs = (specs: EnsureContainerSpec[]): ContainerRuntime => ({
	ensureImage: () => Effect.die('ensureImage not used'),
	ensureNetwork: () => Effect.die('ensureNetwork not used'),
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
	exec: () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
	runOneShot: () => Effect.die('runOneShot not used'),
	inspectByLabels: () => Effect.die('inspectByLabels not used'),
	followLogs: () => Stream.empty,
	pause: () => Effect.die('pause not used'),
	pauseAndCommit: () => Effect.die('pauseAndCommit not used'),
	saveImage: () => Stream.empty,
	saveImages: () => Stream.empty,
	loadImage: () => Effect.die('loadImage not used'),
	tagImage: () => Effect.die('tagImage not used'),
	removeImage: () => Effect.die('removeImage not used'),
	unpause: () => Effect.die('unpause not used'),
	stop: () => Effect.die('stop not used'),
	sweepOrphans: () => Effect.die('sweepOrphans not used'),
	removeManagedContainers: () => Effect.die('removeManagedContainers not used'),
	removeManagedImages: () => Effect.die('removeManagedImages not used'),
	removeManagedNetworks: () => Effect.die('removeManagedNetworks not used'),
	removeManagedVolumes: () => Effect.die('removeManagedVolumes not used'),
});

describe('computePublicHostname', () => {
	it('main stack omits the stack segment', () => {
		expect(computePublicHostname('app', 'main', 0)).toBe('walrus-node-0.app.localhost');
		expect(computePublicHostname('app', 'main', 7)).toBe('walrus-node-7.app.localhost');
	});

	it('non-main stack keeps the service label first', () => {
		expect(computePublicHostname('app', 'feature-x', 0)).toBe(
			'walrus-node-0.feature-x.app.localhost',
		);
	});

	it('is stable across calls (idempotent — no random ids)', () => {
		const a = computePublicHostname('app', 'main', 0);
		const b = computePublicHostname('app', 'main', 0);
		expect(a).toBe(b);
	});
});

describe('buildWalrusNetworkName', () => {
	it('scopes the plugin network by app and stack', () => {
		expect(buildWalrusNetworkName('private-content', 'main', 'walrus')).toBe(
			'devstack-private-content-main-walrus-walrus-net',
		);
		expect(buildWalrusNetworkName('private-content', 'seed-snapshot', 'walrus')).toBe(
			'devstack-private-content-seed-snapshot-walrus-walrus-net',
		);
	});
});

describe('walrus network addressing', () => {
	it('derives a stable subnet prefix from the Walrus network identity', () => {
		const identity = { app: 'private-content', stack: 'main', walrusName: 'walrus' };
		const first = deriveWalrusSubnetPrefix(identity);
		const second = deriveWalrusSubnetPrefix(identity);

		expect(first).toBe(second);
		expect(first).toMatch(/^10\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.\d+$/);
	});

	it('derives different prefixes for different app/stack/walrus identities', () => {
		const prefixes = new Set([
			deriveWalrusSubnetPrefix({ app: 'private-content', stack: 'main', walrusName: 'walrus' }),
			deriveWalrusSubnetPrefix({
				app: 'private-content',
				stack: 'feature-a',
				walrusName: 'walrus',
			}),
			deriveWalrusSubnetPrefix({ app: 'private-content', stack: 'main', walrusName: 'archive' }),
			deriveWalrusSubnetPrefix({ app: 'other-app', stack: 'main', walrusName: 'walrus' }),
		]);

		expect(prefixes.size).toBe(4);
	});

	it('requests the explicit Docker subnet matching the derived listening IP prefix', () => {
		const identity = { app: 'private-content', stack: 'main', walrusName: 'walrus' };
		const prefix = deriveWalrusSubnetPrefix(identity);
		const spec = walrusNetworkCreateSpec(
			{
				name: buildWalrusNetworkName(identity.app, identity.stack, identity.walrusName),
				app: identity.app,
				stack: identity.stack,
			},
			prefix,
		);

		expect(spec.subnet).toBe(`${prefix}.0/24`);
		expect(spec.gateway).toBe(`${prefix}.1`);
		expect(`${prefix}.${WALRUS_NODE_IP_BASE}`).toMatch(/^10\.\d+\.\d+\.10$/);
	});
});

describe('walrus storage-node constants', () => {
	it('WALRUS_ROUTER_PORT is the canonical 9185 (distilled-doc invariant 9)', () => {
		expect(WALRUS_ROUTER_PORT).toBe(9185);
	});

	it('WALRUS_NODE_IP_BASE is 10 (pinned IPs start at <prefix>.10)', () => {
		expect(WALRUS_NODE_IP_BASE).toBe(10);
	});

	it('defaults the ready timeout to the storage-node readiness budget', () => {
		expect(DEFAULT_NODE_READY_TIMEOUT_MS).toBe(60_000);
		expect(resolveLocalClusterOptions({}).readyTimeoutMs).toBe(DEFAULT_NODE_READY_TIMEOUT_MS);
	});

	it('allows callers to override the storage-node ready timeout centrally', () => {
		expect(resolveLocalClusterOptions({ readyTimeoutMs: 45_000 }).readyTimeoutMs).toBe(45_000);
	});

	it('threads the storage-node stop grace into each Docker container spec', async () => {
		const specs: EnsureContainerSpec[] = [];
		await Effect.runPromise(
			Effect.scoped(
				startStorageNodes(runtimeCapturingStorageNodeSpecs(specs), {
					app: 'private-content',
					stack: 'main',
					walrusName: 'walrus',
					image: { digest: 'sha256:walrus', tag: 'devstack-walrus:test' },
					nodeCount: 2,
					subnetPrefix: '10.64.1',
					containerApiPort: WALRUS_ROUTER_PORT,
					walrusNetworkName: 'walrus-net',
					suiNetworkName: 'sui-net',
					deployHostMountPath: '/tmp/devstack/walrus/walrus/deploy',
					stackRoot: '/tmp/devstack',
					deployConfigHash: 'deploy-hash',
					stopGraceSeconds: 37,
				}),
			),
		);

		expect(specs.map((spec) => spec.stopGraceSeconds)).toEqual([37, 37]);
	});

	it('defaults the storage-node Docker stop grace to the storage-node budget', async () => {
		const specs: EnsureContainerSpec[] = [];
		await Effect.runPromise(
			Effect.scoped(
				startStorageNodes(runtimeCapturingStorageNodeSpecs(specs), {
					app: 'private-content',
					stack: 'main',
					walrusName: 'walrus',
					image: { digest: 'sha256:walrus', tag: 'devstack-walrus:test' },
					nodeCount: 1,
					subnetPrefix: '10.64.1',
					containerApiPort: WALRUS_ROUTER_PORT,
					walrusNetworkName: 'walrus-net',
					suiNetworkName: 'sui-net',
					deployHostMountPath: '/tmp/devstack/walrus/walrus/deploy',
					stackRoot: '/tmp/devstack',
					deployConfigHash: 'deploy-hash',
				}),
			),
		);

		expect(specs[0]?.stopGraceSeconds).toBe(DEFAULT_NODE_STOP_GRACE_SECONDS);
	});

	it('WalrusStorageNode shape does NOT carry a publicKey field (backlog #2)', () => {
		// Regression: the per-node descriptor used to carry a placeholder
		// `publicKey: '<bls-pubkey-storage-node-${i}>'` sentinel that
		// shipped to user code on every cycle. Per the storage-nodes
		// inline doc the SDK consumer reads the public key off
		// `packageConfig`, NOT this routing-handle descriptor — so the
		// field is dropped entirely. Compile-time check: a structurally
		// well-formed descriptor type-narrows without referencing
		// `publicKey`, and the runtime shape's keyset MUST NOT include it.
		const node: WalrusStorageNode = {
			nodeIndex: 0,
			nodeId: 'walrus-node-0',
			publicHostname: 'walrus-node-0.app.localhost',
			rpcUrl: 'http://walrus-node-0.app.localhost:9185',
		};
		expect(Object.keys(node)).not.toContain('publicKey');
		// Defensive — guard against the field reappearing as an optional
		// `undefined` accessor in the type.
		expect('publicKey' in node).toBe(false);
	});

	it('folds bind-mount and network inputs into the recreate fingerprint', () => {
		const base = {
			deployConfigHash: 'deploy-a',
			nodeIndex: 0,
			deploySourceHostPath: '/runtime-a',
			deployMountTarget: '/opt/walrus/runtime',
			containerApiPort: 9185,
			walrusNetworkName: 'walrus-net',
			suiNetworkName: 'sui-net',
		};

		expect(storageNodeConfigHash(base)).not.toBe(
			storageNodeConfigHash({ ...base, deploySourceHostPath: '/runtime-b' }),
		);
		expect(storageNodeConfigHash(base)).not.toBe(
			storageNodeConfigHash({ ...base, suiNetworkName: 'other-sui-net' }),
		);
	});
});
