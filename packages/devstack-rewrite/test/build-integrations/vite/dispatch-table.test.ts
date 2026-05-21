// Unit tests for the dispatch-table projection.

import { describe, expect, it } from '@effect/vitest';

import { buildDispatchTable } from '../../../src/build-integrations/vite/dispatch-table.ts';
import {
	EndpointRegistry,
	type ResolvedEndpoint,
	type StackContext,
} from '../../../src/build-integrations/runtime/index.ts';

const ctx = (entries: ReadonlyArray<ResolvedEndpoint>): StackContext => ({
	identity: { app: 'demo', stack: 'main', chain: 'sui:local' },
	manifestVersion: 1,
	endpoints: new EndpointRegistry(entries),
	services: {},
	extras: {},
	manifestPath: '/tmp/manifest.json',
});

describe('buildDispatchTable', () => {
	it('returns an empty table for a null stack context', () => {
		const out = buildDispatchTable(null);
		expect(out.entries).toEqual([]);
		expect(out.proxy).toEqual({});
		expect(out.define).toEqual({});
	});

	it('projects each endpoint into entries + proxy + define', () => {
		const out = buildDispatchTable(
			ctx([
				{
					name: 'sui-rpc',
					url: 'http://sui.localhost:5175/',
					displayUrl: null,
					wireProtocol: 'http',
					pluginKey: 'plugin:sui',
					endpointKey: 'ep:sui-rpc',
				},
			]),
		);
		expect(out.entries).toHaveLength(1);
		expect(out.entries[0]?.url).toBe('http://sui.localhost:5175/');
		expect(out.proxy['/__devstack/endpoint/sui-rpc']).toEqual({
			target: 'http://sui.localhost:5175/',
			changeOrigin: true,
		});
		expect(out.define['__DEVSTACK_ENDPOINT_SUI_RPC__']).toBe(
			JSON.stringify('http://sui.localhost:5175/'),
		);
	});

	it('uppercases + underscore-normalizes endpoint names for define keys', () => {
		const out = buildDispatchTable(
			ctx([
				{
					name: 'walrus.aggregator-1',
					url: 'http://walrus.localhost:5175/',
					displayUrl: null,
					wireProtocol: 'http',
					pluginKey: 'plugin:walrus',
					endpointKey: 'ep:agg',
				},
			]),
		);
		expect(Object.keys(out.define)).toContain('__DEVSTACK_ENDPOINT_WALRUS_AGGREGATOR_1__');
	});
});
