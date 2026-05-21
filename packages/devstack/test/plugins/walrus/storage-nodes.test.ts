// Unit tests for the walrus storage-node helpers. These functions
// participate in both the on-chain Committee record (public_host /
// public_port) AND the per-stack Traefik router config — drift here
// is a load-bearing bug. Tests pin the shape.

import { describe, expect, it } from 'vitest';

import {
	WALRUS_NODE_IP_BASE,
	WALRUS_ROUTER_PORT,
	buildWalrusNetworkName,
	computePublicHostname,
} from '../../../src/plugins/walrus/storage-nodes.ts';

describe('computePublicHostname', () => {
	it('main stack omits the stack prefix', () => {
		expect(computePublicHostname('app', 'main', 0)).toBe('walrus-node-0.app.localhost');
		expect(computePublicHostname('app', 'main', 7)).toBe('walrus-node-7.app.localhost');
	});

	it('non-main stack prepends the stack prefix', () => {
		expect(computePublicHostname('app', 'feature-x', 0)).toBe(
			'feature-x.walrus-node-0.app.localhost',
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

describe('walrus storage-node constants', () => {
	it('WALRUS_ROUTER_PORT is the canonical 9185 (distilled-doc invariant 9)', () => {
		expect(WALRUS_ROUTER_PORT).toBe(9185);
	});

	it('WALRUS_NODE_IP_BASE is 10 (pinned IPs start at <prefix>.10)', () => {
		expect(WALRUS_NODE_IP_BASE).toBe(10);
	});
});
