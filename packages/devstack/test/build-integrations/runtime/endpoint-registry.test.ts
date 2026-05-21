// `EndpointRegistry` — typed lookup tests.

import { describe, expect, it } from '@effect/vitest';

import {
	EndpointRegistry,
	type ResolvedEndpoint,
} from '../../../src/build-integrations/runtime/index.ts';

const ep = (over: Partial<ResolvedEndpoint>): ResolvedEndpoint => ({
	name: 'name',
	url: 'http://localhost',
	displayUrl: 'http://localhost',
	wireProtocol: 'http',
	pluginKey: 'pk',
	endpointKey: 'ek',
	...over,
});

describe('EndpointRegistry', () => {
	it('byName resolves a known endpoint', () => {
		const reg = new EndpointRegistry([ep({ name: 'sui-rpc' }), ep({ name: 'wal-pub' })]);
		expect(reg.byName('sui-rpc')?.name).toBe('sui-rpc');
		expect(reg.byName('absent')).toBeUndefined();
	});

	it('all() returns endpoints alphabetically by name', () => {
		const reg = new EndpointRegistry([
			ep({ name: 'wal-pub' }),
			ep({ name: 'sui-rpc' }),
			ep({ name: 'aaa' }),
		]);
		expect(reg.all().map((e) => e.name)).toEqual(['aaa', 'sui-rpc', 'wal-pub']);
	});

	it('byPluginKey groups by plugin', () => {
		const reg = new EndpointRegistry([
			ep({ name: 'a', pluginKey: 'p1' }),
			ep({ name: 'b', pluginKey: 'p1' }),
			ep({ name: 'c', pluginKey: 'p2' }),
		]);
		expect(reg.byPluginKey('p1').map((e) => e.name)).toEqual(['a', 'b']);
		expect(reg.byPluginKey('p2').map((e) => e.name)).toEqual(['c']);
	});

	it('byKind filters by wireProtocol', () => {
		const reg = new EndpointRegistry([
			ep({ name: 'a', wireProtocol: 'http' }),
			ep({ name: 'b', wireProtocol: 'h2c' }),
			ep({ name: 'c', wireProtocol: 'http' }),
		]);
		expect(reg.byKind('http').map((e) => e.name)).toEqual(['a', 'c']);
		expect(reg.byKind('h2c').map((e) => e.name)).toEqual(['b']);
	});

	it('names() returns the alphabetical name list', () => {
		const reg = new EndpointRegistry([ep({ name: 'b' }), ep({ name: 'a' })]);
		expect(reg.names()).toEqual(['a', 'b']);
	});
});
