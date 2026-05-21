// Unit tests for the walrus local-cluster Routable contributions.
//
// Each storage node carries one Traefik route; the aggregator and
// publisher are aliases collapsed onto node-0 (distilled-doc
// §"Routes registered"). These tests pin the fan-out shape.

import { describe, expect, it } from 'vitest';

import { makeLocalRoutables } from '../../../src/plugins/walrus/routable.ts';

const makeRoutes = (nodeCount: number, compositeKey = 'walrus:walrus') =>
	makeLocalRoutables({
		app: 'app',
		stack: 'main',
		walrusName: 'walrus',
		compositeKey,
		nodeCount,
	});

describe('walrus makeLocalRoutables', () => {
	it('emits N per-node routes + aggregator + publisher aliases', () => {
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

	it('aggregator + publisher dispatch to node-0', () => {
		const routes = makeRoutes(2);
		const agg = routes.find((r) => r.endpointName === 'walrus-aggregator');
		const pub = routes.find((r) => r.endpointName === 'walrus-publisher');
		expect(agg).toBeDefined();
		expect(pub).toBeDefined();
		// Both alias onto node-0's container.
		const aggUpstream = (agg!.upstream as { containerName: string }).containerName;
		const pubUpstream = (pub!.upstream as { containerName: string }).containerName;
		expect(aggUpstream).toBe('devstack-app-main-walrus-walrus-node-0');
		expect(pubUpstream).toBe('devstack-app-main-walrus-walrus-node-0');
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

	it('per-node dispatchIds carry the composite key + per-index role', () => {
		const routes = makeRoutes(2, 'walrus:other');
		const node0 = routes.find((r) => r.endpointName === 'walrus-node-0');
		const node1 = routes.find((r) => r.endpointName === 'walrus-node-1');
		expect(node0?.dispatchId).toEqual({ compositeKey: 'walrus:other', role: 'walrus-node-0' });
		expect(node1?.dispatchId).toEqual({ compositeKey: 'walrus:other', role: 'walrus-node-1' });
	});
});
