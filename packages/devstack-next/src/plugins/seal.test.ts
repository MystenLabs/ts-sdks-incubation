import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Env } from '../engine/types.js';
import { define } from '../factories/define.js';
import { seal, type SealState } from './seal.js';

const env: Env = { appName: 'demo', appDir: '/tmp/seal-test', network: 'localnet', stack: 'main' };

describe('seal (url override — no Docker)', () => {
	it('publishes the supplied url and marks state as unmanaged', async () => {
		const node = seal.create({ url: 'https://my-key-server.example/seal' });
		const engine = new Engine({ stack: [node] }, { env });
		const result = await engine.runOnce();
		expect(result.errored).toEqual([]);
		const state = engine.getState().nodes.get('seal.key-server')!.state as SealState;
		expect(state.url).toBe('https://my-key-server.example/seal');
		expect(state.managed).toBe(false);
	});

	it('skips the dockerContainer node when url is set', () => {
		const node = seal.create({ url: 'https://x/' });
		const engine = new Engine({ stack: [node] }, { env });
		const state = engine.getState();
		expect(state.nodes.has('seal.key-server')).toBe(true);
		expect(state.nodes.has('seal.key-server.container')).toBe(false);
		expect(state.nodes.has('ports')).toBe(false);
	});

	it('represents.endpoints projects an Endpoint', async () => {
		const node = seal.create({ url: 'https://x/' });
		const engine = new Engine({ stack: [node] }, { env });
		await engine.runOnce();
		const view = engine.getState().nodes.get('seal.key-server')!;
		const endpoints = view.representations?.endpoints as { name: string; url: string }[];
		expect(endpoints[0]?.name).toBe('seal-key-server');
		expect(endpoints[0]?.url).toBe('https://x/');
	});
});

describe('seal (graph composition — managed mode, no real Docker)', () => {
	it('builds graph with seal.key-server + seal.key-server.container + ports', () => {
		const node = seal.create({});
		const engine = new Engine({ stack: [node] }, { env });
		const state = engine.getState();
		expect(state.nodes.has('seal.key-server')).toBe(true);
		expect(state.nodes.has('seal.key-server.container')).toBe(true);
		expect(state.nodes.has('ports')).toBe(true);
	});
});

describe('seal (static get accessors via __pluginId)', () => {
	it('seal.get("keyServer") resolves the running instance and projects { url }', async () => {
		const consumer = define({
			name: 'consumer',
			deps: { ks: seal.get('keyServer') },
			start: async ({ deps: { ks } }) => ({ url: ks.url }),
		});
		const engine = new Engine(
			{ stack: [seal.create({ url: 'https://k/' }), consumer] },
			{ env },
		);
		await engine.runOnce();
		const state = engine.getState().nodes.get('consumer')!.state as { url: string };
		expect(state.url).toBe('https://k/');
	});

	it('seal.get("url") projects the bare URL string', async () => {
		const consumer = define({
			name: 'consumer',
			deps: { url: seal.get('url') },
			start: async ({ deps: { url } }) => ({ raw: url }),
		});
		const engine = new Engine(
			{ stack: [seal.create({ url: 'https://k/' }), consumer] },
			{ env },
		);
		await engine.runOnce();
		const state = engine.getState().nodes.get('consumer')!.state as { raw: string };
		expect(state.raw).toBe('https://k/');
	});

	it('rejects two `create` instances of the same schema in one stack', () => {
		const a = seal.create({ url: 'https://a/' });
		const b = seal.create({ url: 'https://b/' });
		expect(() => new Engine({ stack: [a, b] }, { env })).toThrow(/two instances/);
	});

	it('errors when a static get is used without a create() in the stack', () => {
		const consumer = define({
			name: 'consumer',
			deps: { ks: seal.get('keyServer') },
			start: async ({ deps: { ks } }) => ({ url: ks.url }),
		});
		expect(() => new Engine({ stack: [consumer] }, { env })).toThrow(/no instance/);
	});
});

describe('seal (provides.full)', () => {
	it('exposes the full state for "I depend on this being up" patterns', async () => {
		const consumer = define({
			name: 'consumer',
			deps: { s: seal.get('full') },
			start: async ({ deps: { s } }) => ({
				ok: typeof (s as SealState).url === 'string' && (s as SealState).url.length > 0,
			}),
		});
		const engine = new Engine(
			{ stack: [seal.create({ url: 'https://x/' }), consumer] },
			{ env },
		);
		await engine.runOnce();
		const state = engine.getState().nodes.get('consumer')!.state as { ok: boolean };
		expect(state.ok).toBe(true);
	});
});
