// Unit tests for the walrus storage-node helpers. These functions
// participate in both the on-chain Committee record (public_host /
// public_port) AND the per-stack Traefik router config — drift here
// is a load-bearing bug. Tests pin the shape.

import { describe, expect, it } from 'vitest';

import {
	deriveWalrusSubnetPrefix,
	walrusNetworkCreateSpec,
} from '../../../src/plugins/walrus/index.ts';
import { resolveLocalClusterOptions } from '../../../src/plugins/walrus/mode/local-cluster.ts';
import {
	DEFAULT_NODE_READY_TIMEOUT_MS,
	WALRUS_NODE_IP_BASE,
	WALRUS_ROUTER_PORT,
	buildWalrusNetworkName,
	computePublicHostname,
	storageNodeConfigHash,
} from '../../../src/plugins/walrus/storage-nodes.ts';

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
