import { describe, expect, it, vi } from 'vitest';

import { buildGraph } from './build.js';
import { runCycle } from './cycle.js';
import { dep, mockProducer } from './test-utils.js';
import type { EngineEvent, NodeState } from './types.js';

const env = { appName: 'test', appDir: '/x', network: 'localnet', stack: 'main' };

const noEmit = (): void => {};

const collectEvents = (): {
	emit: (event: EngineEvent) => void;
	events: EngineEvent[];
} => {
	const events: EngineEvent[] = [];
	return { emit: (event) => events.push(event), events };
};

describe('runCycle — first cycle', () => {
	it('runs every node and persists returned state', async () => {
		const aStart = vi.fn(async () => 42);
		const bStart = vi.fn(async () => 'hello');
		const a = mockProducer({ name: 'a', start: aStart });
		const b = mockProducer({ name: 'b', start: bStart });
		const graph = buildGraph({ stack: [a, b] });
		const nodeStates = new Map<string, NodeState>();

		const { result } = await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});

		expect(result.ran.map((r) => r.name).sort()).toEqual(['a', 'b']);
		expect(nodeStates.get('a')?.state).toBe(42);
		expect(nodeStates.get('b')?.state).toBe('hello');
	});

	it('passes resolved deps to consumer.start in declaration shape', async () => {
		const upstream = mockProducer({
			name: 'up',
			start: async () => ({ rpc: 'http://localhost' }),
		});
		const consumerStart = vi.fn(async ({ deps }) => deps);
		const consumer = mockProducer({
			name: 'down',
			deps: { up: dep(upstream, 'rpc') },
			start: consumerStart,
		});
		const graph = buildGraph({ stack: [consumer] });
		const nodeStates = new Map<string, NodeState>();

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});

		expect(consumerStart).toHaveBeenCalledTimes(1);
		expect(nodeStates.get('down')?.state).toEqual({ up: { rpc: 'http://localhost' } });
	});

	it('aggregates request payloads into the producer args', async () => {
		const captured: { value?: unknown } = {};
		const producer = mockProducer({
			name: 'producer',
			start: async ({ requests }) => {
				captured.value = requests;
				return {};
			},
		});
		const a = mockProducer({
			name: 'a',
			deps: { p: dep(producer, 'allocate', { slot: 'x' }) },
		});
		const b = mockProducer({
			name: 'b',
			deps: { p: dep(producer, 'allocate', { slot: 'y' }) },
		});
		const graph = buildGraph({ stack: [a, b] });
		const nodeStates = new Map<string, NodeState>();

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});

		expect(captured.value).toEqual({ allocate: [{ slot: 'x' }, { slot: 'y' }] });
	});

	it('passes prior state from start into run', async () => {
		const startFn = vi.fn(async () => ({ s: 1 }));
		const runFn = vi.fn(async ({ prior }) => ({ ...(prior as { s: number }), r: 'done' }));
		const node = mockProducer({ name: 'node', start: startFn, run: runFn });
		const graph = buildGraph({ stack: [node] });
		const nodeStates = new Map<string, NodeState>();

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});

		expect(runFn).toHaveBeenCalledWith(expect.objectContaining({ prior: { s: 1 } }));
		expect(nodeStates.get('node')?.state).toEqual({ s: 1, r: 'done' });
	});

	it('runs represents callbacks and persists the projections', async () => {
		const node = mockProducer({
			name: 'node',
			start: async () => ({ packageId: '0xabc' }),
			represents: {
				packages: (state) => [{ name: 'token', id: (state as { packageId: string }).packageId }],
			},
		});
		const graph = buildGraph({ stack: [node] });
		const nodeStates = new Map<string, NodeState>();

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});

		expect(nodeStates.get('node')?.representations).toEqual({
			packages: [{ name: 'token', id: '0xabc' }],
		});
	});

	it('folds inputs() callback into the input hash', async () => {
		const startFn = vi.fn(async () => 1);
		let inputsValue = 'a';
		const node = mockProducer({
			name: 'node',
			start: startFn,
			inputs: () => inputsValue,
		});
		const graph = buildGraph({ stack: [node] });
		const nodeStates = new Map<string, NodeState>();

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});
		const firstHash = nodeStates.get('node')?.lastInputHash;

		inputsValue = 'b';
		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map([['node', 'rerun']]),
			isFirstCycle: false,
			emit: noEmit,
		});

		expect(nodeStates.get('node')?.lastInputHash).not.toBe(firstHash);
	});
});

describe('runCycle — skip semantics', () => {
	it('skips a downstream Action whose inputHash matches the prior cycle', async () => {
		const upstreamStart = vi.fn(async () => 'stable');
		const downstreamRun = vi.fn(async () => 'work');
		const upstream = mockProducer({ name: 'up', start: upstreamStart });
		const downstream = mockProducer({
			name: 'down',
			deps: { up: dep(upstream, 'value') },
			run: downstreamRun,
		});
		const graph = buildGraph({ stack: [downstream] });
		const nodeStates = new Map<string, NodeState>();

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});
		expect(downstreamRun).toHaveBeenCalledTimes(1);

		const second = await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map([['up', 'rerun']]),
			isFirstCycle: false,
			emit: noEmit,
		});

		expect(upstreamStart).toHaveBeenCalledTimes(2);
		expect(downstreamRun).toHaveBeenCalledTimes(1);
		expect(second.result.skipped.map((s) => s.name)).toContain('down');
	});

	it('always re-runs start (even when shouldRun is false) — process idempotence', async () => {
		const startFn = vi.fn(async () => 'state');
		const a = mockProducer({ name: 'a', start: startFn });
		const graph = buildGraph({ stack: [a] });
		const nodeStates = new Map<string, NodeState>();

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});
		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map([['a', 'rerun']]),
			isFirstCycle: false,
			emit: noEmit,
		});

		expect(startFn).toHaveBeenCalledTimes(2);
	});

	it('cascades a re-run when an upstream identity changes', async () => {
		let upstreamValue = 1;
		const upstream = mockProducer({ name: 'up', start: async () => upstreamValue });
		const downstreamRun = vi.fn(async ({ deps }) => ({ saw: (deps as { up: number }).up }));
		const downstream = mockProducer({
			name: 'down',
			deps: { up: dep(upstream, 'value') },
			run: downstreamRun,
		});
		const graph = buildGraph({ stack: [downstream] });
		const nodeStates = new Map<string, NodeState>();

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});
		expect(downstreamRun).toHaveBeenCalledTimes(1);

		upstreamValue = 2;
		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map([['up', 'rerun']]),
			isFirstCycle: false,
			emit: noEmit,
		});
		expect(downstreamRun).toHaveBeenCalledTimes(2);
		expect(nodeStates.get('down')?.state).toEqual({ saw: 2 });
	});

	it('honors getStatus.ok=true to skip run', async () => {
		const runFn = vi.fn(async () => 'fresh');
		const a = mockProducer({
			name: 'a',
			run: runFn,
			getStatus: () => ({ ok: true }),
		});
		const graph = buildGraph({ stack: [a] });
		const nodeStates = new Map<string, NodeState>();

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});

		expect(runFn).not.toHaveBeenCalled();
	});

	it('honors forceRun to bypass the input-hash skip', async () => {
		const runFn = vi.fn(async () => 'value');
		const a = mockProducer({ name: 'a', run: runFn });
		const graph = buildGraph({ stack: [a] });
		const nodeStates = new Map<string, NodeState>();

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});
		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map([['a', 'rerun']]),
			isFirstCycle: false,
			emit: noEmit,
		});
		expect(runFn).toHaveBeenCalledTimes(2);
	});
});

describe('runCycle — failure isolation', () => {
	it('skips a downstream node when its upstream errors this cycle', async () => {
		const a = mockProducer({
			name: 'a',
			start: async () => {
				throw new Error('boom');
			},
		});
		const downstreamStart = vi.fn(async () => 'ok');
		const b = mockProducer({
			name: 'b',
			deps: { a: dep(a, 'value') },
			start: downstreamStart,
		});
		const graph = buildGraph({ stack: [b] });
		const nodeStates = new Map<string, NodeState>();

		const { result } = await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});

		expect(result.errored.map((e) => e.name)).toEqual(['a']);
		expect(result.skipped.find((s) => s.name === 'b')?.reason).toBe('upstream_errored');
		expect(downstreamStart).not.toHaveBeenCalled();
	});

	it('continues sibling branches when one branch errors', async () => {
		const a = mockProducer({
			name: 'a',
			start: async () => {
				throw new Error('a-fail');
			},
		});
		const cStart = vi.fn(async () => 'c-ok');
		const c = mockProducer({ name: 'c', start: cStart });
		const graph = buildGraph({ stack: [a, c] });
		const nodeStates = new Map<string, NodeState>();

		const { result } = await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});

		expect(result.errored.map((e) => e.name)).toEqual(['a']);
		expect(result.ran.map((r) => r.name)).toContain('c');
		expect(cStart).toHaveBeenCalled();
	});

	it('records the error on the node state for inspection', async () => {
		const a = mockProducer({
			name: 'a',
			start: async () => {
				throw new Error('fail-msg');
			},
		});
		const graph = buildGraph({ stack: [a] });
		const nodeStates = new Map<string, NodeState>();

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});

		expect(nodeStates.get('a')?.error?.message).toBe('fail-msg');
	});
});

describe('runCycle — node-initiated invalidation', () => {
	it('batches requestRerun into pendingReruns for the next cycle', async () => {
		const a = mockProducer({
			name: 'a',
			start: async ({ requestRerun }) => {
				requestRerun('reason');
				return 1;
			},
		});
		const graph = buildGraph({ stack: [a] });
		const nodeStates = new Map<string, NodeState>();

		const { pendingReruns } = await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});

		expect(pendingReruns.get('a')).toBe('rerun');
	});

	it('batches requestRestart with restart intent', async () => {
		const a = mockProducer({
			name: 'a',
			start: async ({ requestRestart }) => {
				requestRestart('drift');
				return 1;
			},
		});
		const graph = buildGraph({ stack: [a] });
		const nodeStates = new Map<string, NodeState>();

		const { pendingReruns } = await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});

		expect(pendingReruns.get('a')).toBe('restart');
	});

	it('lets a node invalidate another node by name', async () => {
		const a = mockProducer({
			name: 'a',
			start: async ({ invalidate }) => {
				invalidate('b');
				return 1;
			},
		});
		const b = mockProducer({ name: 'b', start: async () => 2 });
		const graph = buildGraph({ stack: [a, b] });
		const nodeStates = new Map<string, NodeState>();

		const { pendingReruns } = await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
		});

		expect(pendingReruns.get('b')).toBe('rerun');
	});

	it('records watch paths via registerWatch callback', async () => {
		const a = mockProducer({
			name: 'a',
			start: async ({ watch }) => {
				watch(['./move/**/*.move']);
				return 1;
			},
		});
		const graph = buildGraph({ stack: [a] });
		const nodeStates = new Map<string, NodeState>();
		const captured: { name?: string; paths?: string[] } = {};

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit: noEmit,
			registerWatch: (name, paths) => {
				captured.name = name;
				captured.paths = paths;
			},
		});

		expect(captured).toEqual({ name: 'a', paths: ['./move/**/*.move'] });
	});
});

describe('runCycle — restart intent', () => {
	it('uses custom restart hook when provided', async () => {
		const restartFn = vi.fn(async () => 'restarted');
		const startFn = vi.fn(async () => 'started');
		const a = mockProducer({ name: 'a', start: startFn, restart: restartFn });
		const graph = buildGraph({ stack: [a] });
		const nodeStates = new Map<string, NodeState>([['a', { state: 'before' }]]);

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map([['a', 'restart']]),
			isFirstCycle: false,
			emit: noEmit,
		});

		expect(restartFn).toHaveBeenCalledTimes(1);
		expect(startFn).not.toHaveBeenCalled();
		expect(nodeStates.get('a')?.state).toBe('restarted');
	});

	it('falls back to stop+start when no restart hook is defined', async () => {
		const stopFn = vi.fn(async () => undefined);
		const startFn = vi.fn(async () => 'restarted');
		const a = mockProducer({ name: 'a', start: startFn, stop: stopFn });
		const graph = buildGraph({ stack: [a] });
		const nodeStates = new Map<string, NodeState>([['a', { state: 'before' }]]);

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map([['a', 'restart']]),
			isFirstCycle: false,
			emit: noEmit,
		});

		expect(stopFn).toHaveBeenCalledTimes(1);
		expect(startFn).toHaveBeenCalledTimes(1);
	});
});

describe('runCycle — events', () => {
	it('emits node:state-changed and node:status transitions on success', async () => {
		const a = mockProducer({ name: 'a', start: async () => 1 });
		const graph = buildGraph({ stack: [a] });
		const nodeStates = new Map<string, NodeState>();
		const { emit, events } = collectEvents();

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit,
		});

		const types = events.map((e) => e.type);
		expect(types).toContain('node:state-changed');
		expect(types).toContain('node:status');
	});

	it('emits engine:error for a failing node', async () => {
		const a = mockProducer({
			name: 'a',
			start: async () => {
				throw new Error('boom');
			},
		});
		const graph = buildGraph({ stack: [a] });
		const nodeStates = new Map<string, NodeState>();
		const { emit, events } = collectEvents();

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit,
		});

		expect(events.some((e) => e.type === 'engine:error')).toBe(true);
	});

	it('routes log() calls to node:log events', async () => {
		const a = mockProducer({
			name: 'a',
			start: async ({ log }) => {
				log('hello world');
				return 1;
			},
		});
		const graph = buildGraph({ stack: [a] });
		const nodeStates = new Map<string, NodeState>();
		const { emit, events } = collectEvents();

		await runCycle({
			graph,
			env,
			nodeStates,
			forceRun: new Map(),
			isFirstCycle: true,
			emit,
		});

		const logEvent = events.find(
			(e): e is { type: 'node:log'; name: string; line: string } => e.type === 'node:log',
		);
		expect(logEvent?.line).toBe('hello world');
	});
});
