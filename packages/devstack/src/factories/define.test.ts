import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { AnyNodeImpl } from '../engine/types.js';
import { define } from './define.js';
import { dep } from './dep.js';

describe('define', () => {
	const env = { appName: 'test', appDir: '/tmp/define-test', network: 'localnet' };

	it('returns a Producer with __id, name, and a typed get accessor', () => {
		const node = define({
			name: 'leaf',
			provides: {
				value: dep((s: { n: number }) => s.n),
			},
			start: async () => ({ n: 42 }),
		});

		expect(node.name).toBe('leaf');
		expect(typeof node.__id).toBe('symbol');
		expect(node.__id.description).toBe('leaf');
		expect(typeof node.get).toBe('function');
	});

	it('produces consumer Deps that carry __producer back to the source', () => {
		const node = define({
			name: 'src',
			provides: { v: dep((s: { x: string }) => s.x) },
			start: async () => ({ x: 'hi' }),
		});

		const d = node.get('v');
		expect(d.__producer).toBe(node);
		expect(d.__pluginId).toBeUndefined();
		expect(d.type).toBe('v');
		expect(d.data).toBeUndefined();
	});

	it('attaches data when provides recipe takes a data argument', () => {
		const node = define({
			name: 'kv',
			provides: {
				lookup: dep((s: { map: Record<string, number> }, d: { key: string }) => s.map[d.key] ?? -1),
			},
			start: async () => ({ map: { a: 1 } }),
		});

		const d = node.get('lookup', { key: 'a' });
		expect(d.data).toEqual({ key: 'a' });
		expect(d.get({ map: { a: 99 } }, { key: 'a' })).toBe(99);
	});

	it('throws when get() is called with an undeclared key', () => {
		const node = define({
			name: 'tiny',
			provides: { only: dep((s: { v: number }) => s.v) },
			start: async () => ({ v: 1 }),
		});

		const get = node.get as unknown as (k: string) => unknown;
		expect(() => get('missing')).toThrow(/does not provide "missing"/);
	});

	it('rejects definitions with neither start nor run', () => {
		expect(() =>
			define({
				name: 'broken',
			} as never),
		).toThrow(/at least one of start, run/);
	});

	it('rejects definitions with no name', () => {
		expect(() => define({ start: async () => undefined } as never)).toThrow(/`name` is required/);
	});

	it('passes through start, run, stop, restart, getStatus, inputs, represents', () => {
		const start = async () => undefined;
		const run = async () => undefined;
		const stop = async () => undefined;
		const restart = async () => undefined;
		const getStatus = () => ({ ok: true });
		const inputs = () => ({ x: 1 });
		const represents = { items: () => [] };

		const node = define({
			name: 'all-hooks',
			start,
			run,
			stop,
			restart,
			getStatus,
			inputs,
			represents,
		}) as AnyNodeImpl;

		expect(node.start).toBe(start);
		expect(node.run).toBe(run);
		expect(node.stop).toBe(stop);
		expect(node.restart).toBe(restart);
		expect(node.getStatus).toBe(getStatus);
		expect(node.inputs).toBe(inputs);
		expect(node.represents).toBe(represents);
	});

	it('integrates with the Engine end-to-end (state flows producer → consumer via Dep.get)', async () => {
		const producer = define({
			name: 'producer',
			provides: { rpc: dep((s: { url: string }) => s.url) },
			start: async () => ({ url: 'http://localhost:9000' }),
		});

		let observed = '';
		const consumer = define({
			name: 'consumer',
			deps: { rpcUrl: producer.get('rpc') },
			run: async ({ deps: { rpcUrl } }) => {
				observed = rpcUrl;
				return undefined;
			},
		});

		const engine = new Engine({ stack: [consumer] }, { env });
		await engine.runOnce();
		expect(observed).toBe('http://localhost:9000');
	});

	it('pulls the producer into the graph transitively from a leaf consumer', async () => {
		const producer = define({
			name: 'pulled-in',
			provides: { v: dep((s: { n: number }) => s.n) },
			start: async () => ({ n: 5 }),
		});

		const consumer = define({
			name: 'leaf',
			deps: { val: producer.get('v') },
			run: async () => undefined,
		});

		// Stack only references the consumer; producer must be pulled in via the Dep back-ref.
		const engine = new Engine({ stack: [consumer] }, { env });
		await engine.runOnce();

		const state = engine.getState();
		expect(state.nodes.has('pulled-in')).toBe(true);
		expect(state.nodes.has('leaf')).toBe(true);
	});
});
