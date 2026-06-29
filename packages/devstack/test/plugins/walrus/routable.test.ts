// Unit tests for the walrus local-cluster Routable contributions.
//
// Each storage node carries one Traefik route; the aggregator and
// publisher are host-process HTTP services fronted through the same
// Walrus router entrypoint. These tests pin the fan-out shape.

import { describe, expect, it } from 'vitest';

import { makeLocalRoutables } from '../../../src/plugins/walrus/routable.ts';

const makeRoutes = (nodeCount: number, serviceKey = 'walrus:walrus') =>
	makeLocalRoutables({
		app: 'app',
		stack: 'main',
		walrusName: 'walrus',
		serviceKey,
		nodeCount,
		aggregatorPort: 40100,
		publisherPort: 40101,
	});

describe('walrus makeLocalRoutables', () => {
	it('emits N per-node routes + aggregator + publisher service routes', () => {
		const routes = makeRoutes(3);
		expect(routes).toHaveLength(5); // 3 + aggregator + publisher
		const names = routes.map((r) => r.endpointName);
		expect(names).toEqual([
			'walrus-node-0',
			'walrus-node-1',
			'walrus-node-2',
			'walrus-aggregator',
			'walrus-publisher',
		]);
	});

	it('aggregator + publisher dispatch to host-loopback service ports', () => {
		const routes = makeRoutes(2);
		const agg = routes.find((r) => r.endpointName === 'walrus-aggregator');
		const pub = routes.find((r) => r.endpointName === 'walrus-publisher');
		expect(agg).toBeDefined();
		expect(pub).toBeDefined();
		expect(agg!.upstream).toEqual({ type: 'host-loopback', port: 40100 });
		expect(pub!.upstream).toEqual({ type: 'host-loopback', port: 40101 });
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

	it('every route flips cors:true (walrus storage REST lacks CORS headers)', () => {
		const routes = makeRoutes(4);
		for (const r of routes) {
			// walrus emits only the HTTP variant — narrow before reading cors,
			// which is absent on the TCP variant of RoutableDecl.
			expect(r.wireProtocol).toBe('http');
			if (r.wireProtocol !== 'tcp') {
				expect(r.cors).toBe(true);
			}
		}
	});

	it('per-node dispatchIds carry the service key + per-index role', () => {
		const routes = makeRoutes(2, 'walrus:other');
		const node0 = routes.find((r) => r.endpointName === 'walrus-node-0');
		const node1 = routes.find((r) => r.endpointName === 'walrus-node-1');
		expect(node0?.dispatchId).toEqual({ serviceKey: 'walrus:other', role: 'walrus-node-0' });
		expect(node1?.dispatchId).toEqual({ serviceKey: 'walrus:other', role: 'walrus-node-1' });
	});
});
