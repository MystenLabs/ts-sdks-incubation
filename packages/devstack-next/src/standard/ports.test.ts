import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import { define } from '../factories/define.js';
import { ports } from './ports.js';

describe('ports standard node', () => {
	const env = { appName: 'test', appDir: '/tmp/ports-test', network: 'localnet' };

	it('allocates a port per slot and projects it into consumer deps', async () => {
		let observed = 0;
		const consumer = define({
			name: 'consumer',
			deps: { port: ports.get('allocate', { slot: 'a' }) },
			run: async ({ deps: { port } }) => {
				observed = port;
				return undefined;
			},
		});

		const engine = new Engine({ stack: [consumer] }, { env });
		await engine.runOnce();

		expect(observed).toBeGreaterThan(0);
		expect(observed).toBeLessThan(65536);
	});

	it('returns distinct ports for distinct slots', async () => {
		const observed: Record<string, number> = {};
		const c1 = define({
			name: 'c1',
			deps: { port: ports.get('allocate', { slot: 'sui.rpc' }) },
			run: async ({ deps: { port } }) => {
				observed.suiRpc = port;
				return undefined;
			},
		});
		const c2 = define({
			name: 'c2',
			deps: { port: ports.get('allocate', { slot: 'sui.faucet' }) },
			run: async ({ deps: { port } }) => {
				observed.suiFaucet = port;
				return undefined;
			},
		});

		const engine = new Engine({ stack: [c1, c2] }, { env });
		await engine.runOnce();

		expect(observed.suiRpc).toBeGreaterThan(0);
		expect(observed.suiFaucet).toBeGreaterThan(0);
		expect(observed.suiRpc).not.toBe(observed.suiFaucet);
	});

	it('returns the same port across cycles for the same slot (snapshot stability)', async () => {
		const observed: number[] = [];
		const consumer = define({
			name: 'stable',
			deps: { port: ports.get('allocate', { slot: 'stable' }) },
			run: async ({ deps: { port } }) => {
				observed.push(port);
				return undefined;
			},
		});

		const engine = new Engine({ stack: [consumer] }, { env });
		await engine.runOnce();
		// Force consumer to re-run.
		engine.invalidate('stable');
		await engine.runOnce();

		expect(observed).toHaveLength(2);
		expect(observed[0]).toBe(observed[1]);
	});

	it('shares a single port when multiple consumers request the same slot', async () => {
		const observed: number[] = [];
		const c1 = define({
			name: 'shared-1',
			deps: { port: ports.get('allocate', { slot: 'shared' }) },
			run: async ({ deps: { port } }) => {
				observed.push(port);
				return undefined;
			},
		});
		const c2 = define({
			name: 'shared-2',
			deps: { port: ports.get('allocate', { slot: 'shared' }) },
			run: async ({ deps: { port } }) => {
				observed.push(port);
				return undefined;
			},
		});

		const engine = new Engine({ stack: [c1, c2] }, { env });
		await engine.runOnce();

		expect(observed).toHaveLength(2);
		expect(observed[0]).toBe(observed[1]);
	});

	it('persists allocations across engine restarts via SnapshotRecord', async () => {
		const consumer = define({
			name: 'persisted',
			deps: { port: ports.get('allocate', { slot: 'persisted' }) },
			run: async () => undefined,
		});

		const e1 = new Engine({ stack: [consumer] }, { env });
		await e1.runOnce();
		const snapshot = await e1.saveSnapshot();
		const firstPort = snapshot.nodeStates['ports']?.state as
			| { map: Record<string, number> }
			| undefined;
		expect(firstPort?.map['persisted']).toBeGreaterThan(0);

		// Hydrate a fresh engine from the snapshot. The port should round-trip.
		const e2 = new Engine({ stack: [consumer] }, { env, initialSnapshot: snapshot });
		await e2.runOnce();
		const snapshot2 = await e2.saveSnapshot();
		const secondPort = (snapshot2.nodeStates['ports']?.state as { map: Record<string, number> })
			.map['persisted'];
		expect(secondPort).toBe(firstPort?.map['persisted']);
	});
});
