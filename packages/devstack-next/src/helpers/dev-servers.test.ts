import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Env } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import type { Endpoint } from '../shapes/index.js';
import { viteDevServer, type ViteDevServerState } from './dev-servers.js';

const env: Env = {
	appName: 'demo',
	appDir: '/tmp/devstack-next-vite-test',
	network: 'localnet',
	stack: 'main',
};

describe('viteDevServer (graph composition — no real Vite spawn)', () => {
	it('builds a graph with public + private nodes and the standard ports allocator', () => {
		const dev = viteDevServer({});
		const engine = new Engine({ stack: [dev] }, { env });
		const state = engine.getState();
		// The public transformer node...
		expect(state.nodes.has('frontend.dev-server')).toBe(true);
		// ...the private hostProcess that actually spawns Vite...
		expect(state.nodes.has('frontend.dev-server.process')).toBe(true);
		// ...and the auto-injected ports allocator.
		expect(state.nodes.has('ports')).toBe(true);
	});

	it('honors a custom name + slot', () => {
		const dev = viteDevServer({ name: 'app.frontend', slot: 'app.frontend.port' });
		const engine = new Engine({ stack: [dev] }, { env });
		const state = engine.getState();
		expect(state.nodes.has('app.frontend')).toBe(true);
		expect(state.nodes.has('app.frontend.process')).toBe(true);
	});

	it('exposes endpoint / url / port Deps', () => {
		const dev = viteDevServer({});
		// Type-only check that the get() shape is right; the engine wiring
		// is covered below.
		expect(typeof dev.get).toBe('function');
		expect(() => dev.get('endpoint')).not.toThrow();
		expect(() => dev.get('url')).not.toThrow();
		expect(() => dev.get('port')).not.toThrow();
	});

	it('exposes URL via represents.endpoints once the proc starts', async () => {
		// We can't actually spawn vite without a real Vite project. But we
		// CAN verify the public producer's projection works once the
		// engine has resolved a port. Replace the private hostProcess with
		// a synthetic stand-in by stubbing PATH so `pnpm` becomes a noop —
		// nope, simpler: skip the spawn by overriding `command`. With
		// `command: { command: 'true', args: [] }`, hostProcess invokes
		// `true` which exits immediately. The producer's state still gets
		// populated. (We only inspect what state is *expected* to look
		// like, not the long-running behavior.)
		const dev = viteDevServer({
			command: { command: 'true', args: [] },
			cwd: '/tmp',
		});
		const engine = new Engine({ stack: [dev] }, { env });
		const result = await engine.runOnce();
		expect(result.errored).toEqual([]);
		const view = engine.getState().nodes.get('frontend.dev-server')!;
		const state = view.state as ViteDevServerState;
		expect(state.url).toMatch(/^http:\/\/localhost:\d+$/);
		expect(state.port).toBeGreaterThan(0);
		const endpoints = view.representations?.endpoints as Endpoint[];
		expect(endpoints[0]?.name).toBe('dev-server');
		expect(endpoints[0]?.url).toBe(state.url);
		await engine.stop();
	});

	it('gates flow through the dep graph: gated producer pulls in gates transitively', () => {
		// Synthetic upstream the dev server gates on. Putting only `dev` in
		// the stack should still bring `gate` into the graph because
		// viteDevServer carries it as a Dep.
		const gate = define({
			name: 'codegen.fake',
			provides: { full: dep((s: { ok: boolean }) => s) },
			start: async () => ({ ok: true }),
		});
		const dev = viteDevServer({ gates: [gate.get('full')] });
		const engine = new Engine({ stack: [dev] }, { env });
		const state = engine.getState();
		expect(state.nodes.has('codegen.fake')).toBe(true);
		expect(state.nodes.has('frontend.dev-server.process')).toBe(true);
	});
});
