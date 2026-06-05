// Structural pins for the `RoutableDecl` capability contract.
//
// Two wire-protocol variants discriminated by `wireProtocol`:
//   - HTTP / h2c — `cors: boolean` required, Host-header dispatched.
//   - TCP        — `cors` MUST NOT be present, entrypoint-port dispatched.

import { describe, expect, it } from 'vitest';

import type {
	RoutableDecl,
	RoutableHttpDecl,
	RoutableTcpDecl,
} from '../../src/contracts/routable.ts';

describe('contracts/routable — structural pins', () => {
	it('discriminated-union `kind` is the literal `"routable"`', () => {
		const decl: RoutableDecl = {
			kind: 'routable',
			endpointName: 'demo',
			dispatchId: { serviceKey: 'demo', role: 'app' },
			upstream: { type: 'host-loopback', port: 8080 },
			wireProtocol: 'http',
			cors: false,
		};
		const tagged: 'routable' = decl.kind;
		expect(tagged).toBe('routable');
	});

	it('HTTP variant requires `cors`', () => {
		// @ts-expect-error -- `cors` is required for the HTTP variant.
		const _missingCors: RoutableHttpDecl = {
			kind: 'routable',
			endpointName: 'demo',
			dispatchId: { serviceKey: 'demo', role: 'app' },
			upstream: { type: 'host-loopback', port: 8080 },
			wireProtocol: 'http',
		};
		void _missingCors;
	});

	it('TCP variant must NOT carry a `cors` field', () => {
		const tcp: RoutableTcpDecl = {
			kind: 'routable',
			endpointName: 'pg',
			dispatchId: { serviceKey: 'postgres', role: 'db' },
			upstream: { type: 'host-loopback', port: 5432 },
			wireProtocol: 'tcp',
		};
		// Compile-time: TCP variant has no `cors` slot.
		// @ts-expect-error -- `cors` is HTTP-only.
		void tcp.cors;
	});

	it('rejects an unknown `wireProtocol` literal', () => {
		const _bad: RoutableDecl = {
			kind: 'routable',
			endpointName: 'demo',
			dispatchId: { serviceKey: 'demo', role: 'app' },
			upstream: { type: 'host-loopback', port: 8080 },
			// @ts-expect-error -- only 'http' | 'h2c' | 'tcp'.
			wireProtocol: 'ws',
			cors: false,
		};
		void _bad;
	});

	it('upstream registry: `container` requires containerName + containerPort', () => {
		const decl: RoutableDecl = {
			kind: 'routable',
			endpointName: 'demo',
			dispatchId: { serviceKey: 'demo', role: 'app' },
			upstream: { type: 'container', containerName: 'devstack-main-demo', containerPort: 80 },
			wireProtocol: 'http',
			cors: true,
		};
		expect(decl.upstream.type).toBe('container');
	});

	it('`readiness: "deferred"` is the only allowed readiness value', () => {
		const decl: RoutableDecl = {
			kind: 'routable',
			endpointName: 'demo',
			dispatchId: { serviceKey: 'demo', role: 'app' },
			upstream: { type: 'host-loopback', port: 8080 },
			wireProtocol: 'http',
			cors: false,
			readiness: 'deferred',
		};
		expect(decl.readiness).toBe('deferred');

		const _bad: RoutableDecl = {
			kind: 'routable',
			endpointName: 'demo',
			dispatchId: { serviceKey: 'demo', role: 'app' },
			upstream: { type: 'host-loopback', port: 8080 },
			wireProtocol: 'http',
			cors: false,
			// @ts-expect-error -- only `'deferred'` allowed.
			readiness: 'eager',
		};
		void _bad;
	});
});
