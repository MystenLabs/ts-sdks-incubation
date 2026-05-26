// Conventional-routes table — substrate-owned defaults.
//
// Pins the lifted route table from backlog #30. Playwright (and any
// future build integration) consume `builtInConventionalRoutes(port)`
// rather than each carrying their own copy. The L5 Playwright preset
// stays plugin-name-blind.

import { describe, expect, it } from 'vitest';

import {
	BUILT_IN_CONVENTIONAL_HINTS,
	BUILT_IN_ENDPOINT_ALIASES,
	DEFAULT_ROUTER_ENTRYPOINT_PORT,
	builtInConventionalRoutes,
	resolveBuiltInEndpointAlias,
} from '../../../src/build-integrations/runtime/conventional-routes.ts';

describe('built-in conventional routes', () => {
	it('publishes every hint at the requested port', () => {
		const routes = builtInConventionalRoutes(9000);
		for (const hint of BUILT_IN_CONVENTIONAL_HINTS) {
			const row = routes.get(hint.endpoint);
			expect(row).toBeDefined();
			expect(row!.port).toBe(9000);
			expect(row!.service).toBe(hint.service);
		}
	});

	it('defaults to DEFAULT_ROUTER_ENTRYPOINT_PORT', () => {
		const routes = builtInConventionalRoutes();
		expect(routes.get('app')?.port).toBe(DEFAULT_ROUTER_ENTRYPOINT_PORT);
	});

	it('aliases app→dev and wallet→wallet-app', () => {
		expect(BUILT_IN_ENDPOINT_ALIASES.app).toBe('dev');
		expect(BUILT_IN_ENDPOINT_ALIASES.wallet).toBe('wallet-app');
	});

	it('resolveBuiltInEndpointAlias returns the canonical name or the input verbatim', () => {
		expect(resolveBuiltInEndpointAlias('app')).toBe('dev');
		expect(resolveBuiltInEndpointAlias('wallet')).toBe('wallet-app');
		expect(resolveBuiltInEndpointAlias('sui-rpc')).toBe('sui-rpc');
		expect(resolveBuiltInEndpointAlias('user-defined')).toBe('user-defined');
	});

	it('every built-in plugin Routable maps onto a hint', () => {
		// Sanity sweep — the route table should at least cover the L5
		// endpoints in-spec helpers reach for.
		const keys = BUILT_IN_CONVENTIONAL_HINTS.map((h) => h.endpoint);
		expect(keys).toEqual(
			expect.arrayContaining([
				'app',
				'dev',
				'sui-rpc',
				'sui-faucet',
				'walrus-aggregator',
				'walrus-publisher',
				'seal',
				'wallet',
				'wallet-app',
			]),
		);
	});
});
