// Pure-function tests for the traefik hostname helper. The router
// itself (boot, docker side-effects) lives in
// `internal/docker/router.test.ts`; this file covers only the naming
// convention and the per-stack omission of the `<stack>` segment for
// `'main'`.

import { describe, expect, it } from 'vitest';
import { routerHostname, routerId } from './router-hostname.js';
import type { IdentityShape } from './identity.js';

const id = (app: string, stack: string): IdentityShape => ({
	app,
	stack,
	network: 'localnet',
});

describe('routerHostname', () => {
	it('omits the <stack> segment when stack is "main"', () => {
		expect(routerHostname(id('arena', 'main'), 'sui')).toBe('sui.arena.localhost');
		expect(routerHostname(id('private-content', 'main'), 'walrus-node-0')).toBe(
			'walrus-node-0.private-content.localhost',
		);
	});

	it('prepends the <stack> segment for non-main stacks', () => {
		expect(routerHostname(id('arena', 'test'), 'sui')).toBe('test.sui.arena.localhost');
		expect(routerHostname(id('arena', 'worker-3'), 'wallet')).toBe(
			'worker-3.wallet.arena.localhost',
		);
	});

	it('routerId composes <app>-<stack>-<service> and folds dots in service', () => {
		expect(routerId(id('arena', 'main'), 'sui.localnet')).toBe('arena-main-sui-localnet');
		expect(routerId(id('arena', 'test'), 'walrus-node-0')).toBe('arena-test-walrus-node-0');
	});
});
