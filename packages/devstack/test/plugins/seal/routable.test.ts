import { describe, expect, it } from 'vitest';

import { buildSealKeyServerPublicRoute } from '../../../src/plugins/seal/routable.ts';

describe('buildSealKeyServerPublicRoute', () => {
	it('matches router hostname order for non-default stacks', () => {
		expect(
			buildSealKeyServerPublicRoute({
				app: 'private-content',
				stack: 'private-content',
				port: 2024,
			}),
		).toEqual({
			hostname: 'key-server.private-content.private-content.localhost',
			url: 'http://key-server.private-content.private-content.localhost:2024',
		});
	});

	it('omits the main stack segment like routerHostname', () => {
		expect(
			buildSealKeyServerPublicRoute({
				app: 'private-content',
				stack: 'main',
				port: 2024,
			}),
		).toEqual({
			hostname: 'key-server.private-content.localhost',
			url: 'http://key-server.private-content.localhost:2024',
		});
	});
});
