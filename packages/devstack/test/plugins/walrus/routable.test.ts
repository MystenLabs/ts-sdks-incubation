// Unit tests for the walrus local-cluster Routable contributions.
//
// Each storage node carries one Traefik route; the aggregator and
// publisher and upload relay are release service containers fronted through
// the same Walrus router entrypoint. These tests pin the fan-out shape.

import { describe, expect, it } from 'vitest';

import { makeLocalRoutables } from '../../../src/plugins/walrus/routable.ts';

const makeRoutes = (nodeCount: number, serviceKey = 'walrus:walrus') =>
	makeLocalRoutables({
		app: 'app',
		stack: 'main',
		walrusName: 'walrus',
		serviceKey,
		nodeCount,
		aggregator: {
			role: 'aggregator',
			containerName: 'devstack-app-main-walrus-walrus-aggregator',
			containerPort: 31415,
		},
		publisher: {
			role: 'publisher',
			containerName: 'devstack-app-main-walrus-walrus-publisher',
			containerPort: 31415,
		},
		uploadRelay: {
			role: 'upload-relay',
			containerName: 'devstack-app-main-walrus-walrus-upload-relay',
			containerPort: 3000,
		},
	});

describe('walrus makeLocalRoutables', () => {
	it('emits N per-node routes + aggregator + publisher + upload-relay service routes', () => {
		const routes = makeRoutes(3);
		expect(routes).toHaveLength(6); // 3 + aggregator + publisher + upload relay
		const names = routes.map((r) => r.endpointName);
		expect(names).toEqual([
			'walrus-node-0',
			'walrus-node-1',
			'walrus-node-2',
			'walrus-aggregator',
			'walrus-publisher',
			'walrus-upload-relay',
		]);
	});

	it('aggregator + publisher + upload relay dispatch to service containers', () => {
		const routes = makeRoutes(2);
		const agg = routes.find((r) => r.endpointName === 'walrus-aggregator');
		const pub = routes.find((r) => r.endpointName === 'walrus-publisher');
		const relay = routes.find((r) => r.endpointName === 'walrus-upload-relay');
		expect(agg).toBeDefined();
		expect(pub).toBeDefined();
		expect(relay).toBeDefined();
		expect(agg!.upstream).toEqual({
			type: 'container',
			containerName: 'devstack-app-main-walrus-walrus-aggregator',
			containerPort: 31415,
		});
		expect(pub!.upstream).toEqual({
			type: 'container',
			containerName: 'devstack-app-main-walrus-walrus-publisher',
			containerPort: 31415,
		});
		expect(relay!.upstream).toEqual({
			type: 'container',
			containerName: 'devstack-app-main-walrus-walrus-upload-relay',
			containerPort: 3000,
		});
	});

	it('omits app-facing routes when their service ports are absent', () => {
		const routes = makeLocalRoutables({
			app: 'app',
			stack: 'main',
			walrusName: 'walrus',
			serviceKey: 'walrus:walrus',
			nodeCount: 2,
		});
		expect(routes.map((r) => r.endpointName)).toEqual(['walrus-node-0', 'walrus-node-1']);
	});

	it('uses HTTPS upstreams for storage nodes and HTTP upstreams for client services', () => {
		const routes = makeRoutes(4);
		for (const r of routes) {
			// walrus emits only the HTTP-family variant — narrow before reading cors,
			// which is absent on the TCP variant of RoutableDecl.
			if (r.wireProtocol !== 'tcp') {
				expect(r.cors).toBe(true);
			}
		}
		expect(
			routes.filter((r) => r.endpointName.startsWith('walrus-node-')).map((r) => r.wireProtocol),
		).toEqual(['https', 'https', 'https', 'https']);
		expect(routes.find((r) => r.endpointName === 'walrus-aggregator')?.wireProtocol).toBe('http');
		expect(routes.find((r) => r.endpointName === 'walrus-publisher')?.wireProtocol).toBe('http');
		expect(routes.find((r) => r.endpointName === 'walrus-upload-relay')?.wireProtocol).toBe('http');
	});

	it('per-node dispatchIds carry the service key + per-index role', () => {
		const routes = makeRoutes(2, 'walrus:other');
		const node0 = routes.find((r) => r.endpointName === 'walrus-node-0');
		const node1 = routes.find((r) => r.endpointName === 'walrus-node-1');
		expect(node0?.dispatchId).toEqual({ serviceKey: 'walrus:other', role: 'walrus-node-0' });
		expect(node1?.dispatchId).toEqual({ serviceKey: 'walrus:other', role: 'walrus-node-1' });
	});
});
