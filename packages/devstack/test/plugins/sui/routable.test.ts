import { describe, expect, it } from 'vitest';

import {
	SUI_FAUCET_ENDPOINT_NAME,
	SUI_FAUCET_ENTRYPOINT_PORT,
	SUI_GRAPHQL_ENDPOINT_NAME,
	SUI_GRAPHQL_ENTRYPOINT_PORT,
	SUI_RPC_ENDPOINT_NAME,
	SUI_RPC_ENTRYPOINT_PORT,
	makeSuiForkRoutables,
	makeSuiLocalRoutables,
} from '../../../src/plugins/sui/routable.ts';

describe('makeSuiLocalRoutables', () => {
	it('routes local Sui RPC, faucet, and GraphQL through named entrypoints', () => {
		const routes = makeSuiLocalRoutables({
			containerName: 'devstack-arena-arena-sui-validator',
			includeGraphql: true,
		});

		expect(routes.map((route) => route.endpointName)).toEqual([
			SUI_RPC_ENDPOINT_NAME,
			SUI_FAUCET_ENDPOINT_NAME,
			SUI_GRAPHQL_ENDPOINT_NAME,
		]);
		expect(routes.map((route) => route.upstream)).toEqual([
			{
				type: 'container',
				containerName: 'devstack-arena-arena-sui-validator',
				containerPort: SUI_RPC_ENTRYPOINT_PORT,
			},
			{
				type: 'container',
				containerName: 'devstack-arena-arena-sui-validator',
				containerPort: SUI_FAUCET_ENTRYPOINT_PORT,
			},
			{
				type: 'container',
				containerName: 'devstack-arena-arena-sui-validator',
				containerPort: SUI_GRAPHQL_ENTRYPOINT_PORT,
			},
		]);
		expect(routes.every((route) => route.wireProtocol === 'http')).toBe(true);
	});

	it('can omit GraphQL for callers that have not enabled it', () => {
		const routes = makeSuiLocalRoutables({
			containerName: 'devstack-arena-arena-sui-validator',
			includeGraphql: false,
		});

		expect(routes.map((route) => route.endpointName)).toEqual([
			SUI_RPC_ENDPOINT_NAME,
			SUI_FAUCET_ENDPOINT_NAME,
		]);
	});
});

describe('makeSuiForkRoutables', () => {
	it('routes only fork RPC through the standard Sui RPC entrypoint', () => {
		const routes = makeSuiForkRoutables({
			containerName: 'devstack-arena-arena-sui-fork',
		});

		expect(routes).toEqual([
			{
				kind: 'routable',
				endpointName: SUI_RPC_ENDPOINT_NAME,
				dispatchId: {
					serviceKey: 'sui.fork',
					role: SUI_RPC_ENDPOINT_NAME,
				},
				upstream: {
					type: 'container',
					containerName: 'devstack-arena-arena-sui-fork',
					containerPort: SUI_RPC_ENTRYPOINT_PORT,
				},
				wireProtocol: 'http',
				cors: true,
			},
		]);
	});
});
