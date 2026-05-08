import { describe, expect, it } from 'vitest';

import { buildGraph } from './build.js';
import { createSnapshot, hydrateNodeStates } from './snapshot.js';
import { mockProducer } from './test-utils.js';
import type { NodeState } from './types.js';

const env = { appName: 'test-app', appDir: '/tmp/x', network: 'localnet', stack: 'main' };

describe('createSnapshot', () => {
	it('captures node states by name', async () => {
		const a = mockProducer({ name: 'a' });
		const graph = buildGraph({ stack: [a] });
		const states = new Map<string, NodeState>([
			['a', { state: { value: 1 }, lastInputHash: 'h1', identity: 'id1', lastRunAt: 100 }],
		]);
		const snapshot = await createSnapshot({ env, graph, nodeStates: states, now: () => 500 });
		expect(snapshot.createdAt).toBe(500);
		expect(snapshot.env).toEqual({ appName: 'test-app', network: 'localnet', stack: 'main' });
		expect(snapshot.nodeStates['a']).toEqual(states.get('a'));
	});

	it('calls a node-supplied snapshot hook to augment state', async () => {
		const a = mockProducer({
			name: 'a',
			start: async () => ({ live: 'handle', containerId: 'abc' }),
		});
		a.snapshot = async ({ state }) => ({
			containerId: (state as { containerId: string }).containerId,
		});
		const graph = buildGraph({ stack: [a] });
		const states = new Map<string, NodeState>([
			['a', { state: { live: 'handle', containerId: 'abc' } }],
		]);
		const snapshot = await createSnapshot({ env, graph, nodeStates: states });
		expect(snapshot.nodeStates['a']?.state).toEqual({ containerId: 'abc' });
	});

	it('emits version metadata', async () => {
		const graph = buildGraph({ stack: [mockProducer({ name: 'a' })] });
		const snapshot = await createSnapshot({ env, graph, nodeStates: new Map() });
		expect(snapshot.meta.devstackVersion).toBeTypeOf('string');
	});
});

describe('hydrateNodeStates', () => {
	it('rebuilds the in-memory map from a snapshot', () => {
		const snapshot = {
			createdAt: 1,
			env: { appName: 'test-app', network: 'localnet' },
			nodeStates: {
				a: { state: 1, lastInputHash: 'h' } as NodeState,
				b: { state: 2 } as NodeState,
			},
			meta: { devstackVersion: '0.0.0-dev' },
		};
		const map = hydrateNodeStates(snapshot);
		expect(map.get('a')).toEqual({ state: 1, lastInputHash: 'h' });
		expect(map.get('b')).toEqual({ state: 2 });
	});

	it('returns an empty map when given undefined', () => {
		expect(hydrateNodeStates(undefined).size).toBe(0);
	});
});
