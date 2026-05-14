import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Env } from '../engine/types.js';
import { defineDevstackConfig } from '../config.js';
import { sui } from '../plugins/sui.js';
import { createStore } from './store.js';

const env: Env = { appName: 'test', appDir: '/tmp/tui-store-test', network: 'testnet' };

function buildEngine(): Engine {
	const config = defineDevstackConfig({ stack: [sui.create({ network: 'testnet' })] });
	return new Engine(config, { env });
}

describe('tui store', () => {
	it('returns the engine state and a starting version', () => {
		const engine = buildEngine();
		const { store, detach } = createStore(engine);
		const snap = store.getSnapshot();
		expect(snap.version).toBe(0);
		expect(snap.state.cycle.id).toBe(0);
		expect(snap.tail).toEqual([]);
		detach();
	});

	it('bumps version + refreshes engine state on cycle:end', async () => {
		const engine = buildEngine();
		const { store, detach } = createStore(engine);
		const before = store.getSnapshot().version;
		await engine.runOnce();
		const after = store.getSnapshot();
		expect(after.version).toBeGreaterThan(before);
		expect(after.state.cycle.id).toBe(1);
		expect(after.state.nodes.has('sui.testnet')).toBe(true);
		expect(after.tail.some((l) => l.includes('cycle 1 end'))).toBe(true);
		detach();
		await engine.stop();
	});

	it('notifies subscribers on each engine event', async () => {
		const engine = buildEngine();
		const { store, detach } = createStore(engine);
		let calls = 0;
		const unsub = store.subscribe(() => {
			calls++;
		});
		await engine.runOnce();
		expect(calls).toBeGreaterThan(0);
		unsub();
		detach();
		await engine.stop();
	});

	it('caps the tail at a fixed window', async () => {
		const engine = buildEngine();
		const { store, detach } = createStore(engine);
		// Run several cycles to push more than TAIL_SIZE entries.
		for (let i = 0; i < 12; i++) {
			engine.invalidate('sui.testnet');
			await engine.runOnce();
		}
		const snap = store.getSnapshot();
		// TAIL_SIZE in store.ts is 8; with start+end per cycle the buffer
		// should never exceed that ceiling.
		expect(snap.tail.length).toBeLessThanOrEqual(8);
		detach();
		await engine.stop();
	});

	it('detach() unsubscribes from the engine', async () => {
		const engine = buildEngine();
		const { store, detach } = createStore(engine);
		detach();
		const before = store.getSnapshot().version;
		await engine.runOnce();
		expect(store.getSnapshot().version).toBe(before);
		await engine.stop();
	});
});
