import { describe, expect, it } from 'vitest';

import { pluginKey } from '../../../../src/substrate/brand.ts';
import { operationalEndpointEventsFromResolvedValue } from '../../../../src/substrate/runtime/projection/operational-endpoints.ts';

describe('operationalEndpointEventsFromResolvedValue', () => {
	it('projects safe top-level operational URLs from resolved plugin values', () => {
		const events = operationalEndpointEventsFromResolvedValue(
			pluginKey('sui#0'),
			{
				rpcUrl: 'http://127.0.0.1:51001',
				faucetUrl: 'http://127.0.0.1:50001',
				graphqlUrl: null,
			},
			123,
		);

		expect(events).toEqual([
			{
				tag: 'endpoint.registered',
				endpoint: {
					endpointKey: 'sui#0:rpcUrl',
					pluginKey: 'sui#0',
					name: 'rpc',
					url: 'http://127.0.0.1:51001',
					displayUrl: null,
					wireProtocol: 'http',
					registeredAt: 123,
				},
			},
			{
				tag: 'endpoint.registered',
				endpoint: {
					endpointKey: 'sui#0:faucetUrl',
					pluginKey: 'sui#0',
					name: 'faucet',
					url: 'http://127.0.0.1:50001',
					displayUrl: null,
					wireProtocol: 'http',
					registeredAt: 123,
				},
			},
		]);
	});

	it('projects wallet url without leaking pairUrl token fragments', () => {
		const events = operationalEndpointEventsFromResolvedValue(
			pluginKey('wallet#6'),
			{
				url: 'http://127.0.0.1:39200',
				pairUrl: 'http://127.0.0.1:39200/#token=secret',
			},
			456,
		);

		expect(events).toHaveLength(1);
		expect(events[0]?.endpoint).toMatchObject({
			endpointKey: 'wallet#6:url',
			pluginKey: 'wallet#6',
			name: 'http',
			url: 'http://127.0.0.1:39200',
		});
		expect(JSON.stringify(events)).not.toContain('secret');
		expect(JSON.stringify(events)).not.toContain('pairUrl');
	});

	it('does not infer resolved-value endpoints when routables are present', () => {
		const events = operationalEndpointEventsFromResolvedValue(
			pluginKey('host-service/frontend#0'),
			{
				url: 'http://127.0.0.1:6173',
			},
			456,
			{ routablesPresent: true },
		);

		expect(events).toEqual([]);
	});

	it('ignores invalid and non-http values', () => {
		expect(
			operationalEndpointEventsFromResolvedValue(
				pluginKey('demo#0'),
				{
					url: 'not a url',
					rpcUrl: 'file:///tmp/socket',
				},
				789,
			),
		).toEqual([]);
	});
});
