import { describe, expect, it, vi } from 'vitest';

import { Engine } from './class.js';
import { dep, mockProducer } from './test-utils.js';
import type { EngineEvent } from './types.js';

const env = { appName: 'test', appDir: '/x', network: 'localnet', stack: 'main' };

describe('Engine — construction', () => {
	it('builds the graph from the config at construction', () => {
		const a = mockProducer({ name: 'a' });
		const engine = new Engine({ stack: [a] }, { env });
		const state = engine.getState();
		expect([...state.nodes.keys()]).toEqual(['a']);
		expect(state.cycle.id).toBe(0);
		expect(state.cycle.status).toBe('idle');
	});

	it('hydrates node state from initialSnapshot', () => {
		const a = mockProducer({ name: 'a' });
		const engine = new Engine(
			{ stack: [a] },
			{
				env,
				initialSnapshot: {
					createdAt: 0,
					env: { appName: 'test', network: 'localnet', stack: 'main' },
					nodeStates: {
						a: { state: 'restored', lastInputHash: 'h', identity: 'i' },
					},
					meta: { devstackVersion: '0.0.0-dev' },
				},
			},
		);
		const view = engine.getState().nodes.get('a');
		expect(view?.state).toBe('restored');
		expect(view?.status).toBe('satisfied');
	});
});

describe('Engine — runOnce', () => {
	it('executes one cycle and returns its result', async () => {
		const a = mockProducer({ name: 'a', start: async () => 1 });
		const engine = new Engine({ stack: [a] }, { env });
		const result = await engine.runOnce();
		expect(result.ran.map((r) => r.name)).toEqual(['a']);
		expect(engine.getState().nodes.get('a')?.state).toBe(1);
	});

	it('skips an idle graph entirely on a second runOnce (work set empty)', async () => {
		const startFn = vi.fn(async () => 'start-state');
		const runFn = vi.fn(async () => 'run-state');
		const a = mockProducer({ name: 'a', start: startFn, run: runFn });
		const engine = new Engine({ stack: [a] }, { env });
		await engine.runOnce();
		await engine.runOnce();
		expect(startFn).toHaveBeenCalledTimes(1);
		expect(runFn).toHaveBeenCalledTimes(1);
	});

	it('after invalidate(), start re-runs but run gates on hash equality', async () => {
		const startFn = vi.fn(async () => 'stable');
		const runFn = vi.fn(async () => 'work');
		const a = mockProducer({ name: 'a', start: startFn, run: runFn });
		const engine = new Engine({ stack: [a] }, { env });
		await engine.runOnce();
		engine.invalidate('a');
		await engine.runOnce();
		expect(startFn).toHaveBeenCalledTimes(2);
		expect(runFn).toHaveBeenCalledTimes(2);
	});

	it('coalesces concurrent cycle() calls into a single inflight cycle', async () => {
		const startFn = vi.fn(async () => {
			await new Promise((r) => setTimeout(r, 10));
			return 1;
		});
		const a = mockProducer({ name: 'a', start: startFn });
		const engine = new Engine({ stack: [a] }, { env });
		const [r1, r2] = await Promise.all([engine.cycle(), engine.cycle()]);
		expect(r1).toBe(r2);
		expect(startFn).toHaveBeenCalledTimes(1);
	});
});

describe('Engine — invalidate / restart / retry', () => {
	it('invalidate(name) forces a re-run of that node on the next cycle', async () => {
		const runFn = vi.fn(async () => 'value');
		const a = mockProducer({ name: 'a', run: runFn });
		const engine = new Engine({ stack: [a] }, { env });
		await engine.runOnce();
		expect(runFn).toHaveBeenCalledTimes(1);

		engine.invalidate('a');
		await engine.runOnce();
		expect(runFn).toHaveBeenCalledTimes(2);
	});

	it('restart(name) triggers the restart hook', async () => {
		const restartFn = vi.fn(async () => 'restarted');
		const a = mockProducer({
			name: 'a',
			start: async () => 'started',
			restart: restartFn,
		});
		const engine = new Engine({ stack: [a] }, { env });
		await engine.runOnce();
		expect(restartFn).not.toHaveBeenCalled();

		engine.restart('a');
		await engine.runOnce();
		expect(restartFn).toHaveBeenCalledTimes(1);
		expect(engine.getState().nodes.get('a')?.state).toBe('restarted');
	});

	it('ignores invalidate on unknown node names', async () => {
		const a = mockProducer({ name: 'a' });
		const engine = new Engine({ stack: [a] }, { env });
		await engine.runOnce();
		expect(() => engine.invalidate('does-not-exist')).not.toThrow();
	});

	it('rerun batched mid-cycle fires on the next cycle', async () => {
		let rerunOnce = true;
		const startFn = vi.fn(async ({ requestRerun }) => {
			if (rerunOnce) {
				rerunOnce = false;
				requestRerun('once');
			}
			return 'state';
		});
		const a = mockProducer({ name: 'a', start: startFn });
		const engine = new Engine({ stack: [a] }, { env });
		await engine.runOnce();
		expect(startFn).toHaveBeenCalledTimes(1);
		await engine.runOnce();
		expect(startFn).toHaveBeenCalledTimes(2);
	});
});

describe('Engine — events', () => {
	it('subscribers receive cycle:start and cycle:end with matching cycleId', async () => {
		const a = mockProducer({ name: 'a' });
		const engine = new Engine({ stack: [a] }, { env });
		const events: EngineEvent[] = [];
		engine.subscribe((event) => {
			events.push(event);
		});
		await engine.runOnce();
		const start = events.find((e) => e.type === 'cycle:start');
		const end = events.find((e) => e.type === 'cycle:end');
		expect(start && 'cycleId' in start ? start.cycleId : null).toBe(1);
		expect(end && 'cycleId' in end ? end.cycleId : null).toBe(1);
	});

	it('returns an unsubscribe function from subscribe', async () => {
		const a = mockProducer({ name: 'a' });
		const engine = new Engine({ stack: [a] }, { env });
		const events: EngineEvent[] = [];
		const unsubscribe = engine.subscribe((event) => events.push(event));
		await engine.runOnce();
		const before = events.length;
		unsubscribe();
		await engine.runOnce();
		expect(events.length).toBe(before);
	});

	it('a throwing subscriber does not break the engine', async () => {
		const a = mockProducer({ name: 'a' });
		const engine = new Engine({ stack: [a] }, { env });
		engine.subscribe(() => {
			throw new Error('subscriber boom');
		});
		await expect(engine.runOnce()).resolves.toBeDefined();
	});
});

describe('Engine — getState', () => {
	it('exposes node logs accumulated via log() calls', async () => {
		const a = mockProducer({
			name: 'a',
			start: async ({ log }) => {
				log('line one');
				log('line two');
				return 1;
			},
		});
		const engine = new Engine({ stack: [a] }, { env });
		await engine.runOnce();
		const view = engine.getState().nodes.get('a');
		expect(view?.logs).toEqual(['line one', 'line two']);
	});

	it('reports errored status with lastError', async () => {
		const a = mockProducer({
			name: 'a',
			start: async () => {
				throw new Error('failure');
			},
		});
		const engine = new Engine({ stack: [a] }, { env });
		await engine.runOnce();
		const view = engine.getState().nodes.get('a');
		expect(view?.status).toBe('errored');
		expect(view?.lastError?.message).toBe('failure');
	});
});

describe('Engine — saveSnapshot', () => {
	it('round-trips state through SnapshotRecord into a fresh Engine', async () => {
		const start = vi.fn(async () => ({ count: 7 }));
		const config = { stack: [mockProducer({ name: 'a', start })] };

		const first = new Engine(config, { env });
		await first.runOnce();
		const snapshot = await first.saveSnapshot();

		const second = new Engine(
			{ stack: [mockProducer({ name: 'a', start })] },
			{ env, initialSnapshot: snapshot },
		);
		const view = second.getState().nodes.get('a');
		expect(view?.state).toEqual({ count: 7 });
		expect(view?.status).toBe('satisfied');
	});
});

describe('Engine — pause / resume', () => {
	it('pause() blocks new cycle() calls until resume()', async () => {
		const a = mockProducer({ name: 'a' });
		const engine = new Engine({ stack: [a] }, { env });
		await engine.runOnce();
		await engine.pause();
		await expect(engine.cycle()).rejects.toThrow(/paused/);
		await engine.resume();
		await expect(engine.cycle()).resolves.toBeDefined();
	});
});

describe('Engine — stop', () => {
	it('runs registered onShutdown handlers and emits shutdown', async () => {
		const onShutdownFn = vi.fn(async () => undefined);
		const a = mockProducer({
			name: 'a',
			start: async ({ onShutdown }) => {
				onShutdown(onShutdownFn);
				return 1;
			},
		});
		const engine = new Engine({ stack: [a] }, { env });
		const events: EngineEvent[] = [];
		engine.subscribe((event) => events.push(event));
		await engine.runOnce();
		await engine.stop();
		expect(onShutdownFn).toHaveBeenCalledTimes(1);
		expect(events.some((e) => e.type === 'shutdown')).toBe(true);
	});

	it('cycle() rejects after stop()', async () => {
		const a = mockProducer({ name: 'a' });
		const engine = new Engine({ stack: [a] }, { env });
		await engine.runOnce();
		await engine.stop();
		await expect(engine.cycle()).rejects.toThrow(/stopped/);
	});
});

describe('Engine — multi-node graph', () => {
	it('processes a chain of producers in topo order', async () => {
		const order: string[] = [];
		const a = mockProducer({
			name: 'a',
			start: async () => {
				order.push('a');
				return 'a-state';
			},
		});
		const b = mockProducer({
			name: 'b',
			deps: { a: dep(a, 'value') },
			start: async () => {
				order.push('b');
				return 'b-state';
			},
		});
		const c = mockProducer({
			name: 'c',
			deps: { b: dep(b, 'value') },
			start: async () => {
				order.push('c');
				return 'c-state';
			},
		});
		const engine = new Engine({ stack: [c] }, { env });
		await engine.runOnce();
		expect(order).toEqual(['a', 'b', 'c']);
	});
});
