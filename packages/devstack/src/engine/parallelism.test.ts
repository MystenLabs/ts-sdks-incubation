import { describe, expect, it } from 'vitest';
import { define } from '../factories/define.js';
import { dep, exclusiveDep } from '../factories/dep.js';
import { Engine } from './class.js';
import type { Provides } from './types.js';

// Engine-level concurrency: rank-by-rank + color-by-color execution.
// These tests use deliberately-slow start callbacks to observe whether
// two nodes ran concurrently (their slow windows overlap) or
// sequentially (windows are disjoint).

const env = { appName: 'test', appDir: '/tmp/parallel-test', network: 'localnet', stack: 'main' };

interface Window {
	name: string;
	startedAt: number;
	endedAt: number;
}

function slowProducer(name: string, holdMs: number, windows: Window[]) {
	return define({
		name,
		start: async () => {
			const startedAt = Date.now();
			await new Promise((r) => setTimeout(r, holdMs));
			const endedAt = Date.now();
			windows.push({ name, startedAt, endedAt });
			return null;
		},
	});
}

function overlaps(a: Window, b: Window): boolean {
	return a.startedAt < b.endedAt && b.startedAt < a.endedAt;
}

describe('Engine parallelism — within a rank', () => {
	it('two sibling nodes with no exclusive deps run concurrently', async () => {
		const windows: Window[] = [];
		const a = slowProducer('a', 80, windows);
		const b = slowProducer('b', 80, windows);
		const engine = new Engine({ stack: [a, b] }, { env });
		await engine.runOnce();
		expect(windows).toHaveLength(2);
		const [wa, wb] = windows.sort((x, y) => x.name.localeCompare(y.name)) as [Window, Window];
		expect(overlaps(wa, wb)).toBe(true);
	});

	it('three independent sibling nodes all overlap', async () => {
		const windows: Window[] = [];
		const a = slowProducer('a', 60, windows);
		const b = slowProducer('b', 60, windows);
		const c = slowProducer('c', 60, windows);
		const engine = new Engine({ stack: [a, b, c] }, { env });
		await engine.runOnce();
		const total = Math.max(...windows.map((w) => w.endedAt)) - Math.min(...windows.map((w) => w.startedAt));
		// Three 60ms producers running sequentially would take ~180ms.
		// Running in parallel they finish in ~60ms. 120ms gives generous
		// headroom for CI scheduler jitter while still proving parallelism.
		expect(total).toBeLessThan(120);
	});
});

describe('Engine parallelism — exclusiveDep serializes shared lockKeys', () => {
	it('two consumers of the same exclusive Dep run sequentially', async () => {
		interface PoolState {
			value: string;
		}
		const poolProvides = {
			exclusive: exclusiveDep({
				get: (s: PoolState, d: { name: string }) => `${s.value}:${d.name}`,
				lockKey: (_s, d) => `lock:${d.name}`,
			}),
		} satisfies Provides<PoolState>;

		const pool = define<PoolState, typeof poolProvides>({
			name: 'pool',
			provides: poolProvides,
			start: async () => ({ value: 'v' }),
		});

		const windows: Window[] = [];
		const slowDepFn = (name: string, holdMs: number) =>
			define({
				name,
				deps: { val: pool.get('exclusive', { name: 'publisher' }) },
				start: async () => {
					const startedAt = Date.now();
					await new Promise((r) => setTimeout(r, holdMs));
					const endedAt = Date.now();
					windows.push({ name, startedAt, endedAt });
					return null;
				},
			});

		const a = slowDepFn('a', 60);
		const b = slowDepFn('b', 60);
		const engine = new Engine({ stack: [a, b] }, { env });
		await engine.runOnce();
		expect(windows).toHaveLength(2);
		const [wa, wb] = windows.sort((x, y) => x.startedAt - y.startedAt) as [Window, Window];
		// Same lockKey → different colors → sequential. Second start
		// must come after first end.
		expect(wb.startedAt).toBeGreaterThanOrEqual(wa.endedAt);
	});

	it('two consumers of distinct exclusive lockKeys run concurrently', async () => {
		interface PoolState {
			value: string;
		}
		const poolProvides = {
			exclusive: exclusiveDep({
				get: (s: PoolState, d: { name: string }) => `${s.value}:${d.name}`,
				lockKey: (_s, d) => `lock:${d.name}`,
			}),
		} satisfies Provides<PoolState>;

		const pool = define<PoolState, typeof poolProvides>({
			name: 'pool',
			provides: poolProvides,
			start: async () => ({ value: 'v' }),
		});

		const windows: Window[] = [];
		const slowDepFn = (name: string, holderName: string, holdMs: number) =>
			define({
				name,
				deps: { val: pool.get('exclusive', { name: holderName }) },
				start: async () => {
					const startedAt = Date.now();
					await new Promise((r) => setTimeout(r, holdMs));
					const endedAt = Date.now();
					windows.push({ name, startedAt, endedAt });
					return null;
				},
			});

		const a = slowDepFn('a', 'alice', 60);
		const b = slowDepFn('b', 'bob', 60);
		const engine = new Engine({ stack: [a, b] }, { env });
		await engine.runOnce();
		expect(windows).toHaveLength(2);
		const [wa, wb] = windows.sort((x, y) => x.name.localeCompare(y.name)) as [Window, Window];
		// Distinct lockKeys → same color → parallel.
		expect(overlaps(wa, wb)).toBe(true);
	});

	it('a non-exclusive consumer parallels with an exclusive one even when they share a sibling rank', async () => {
		interface PoolState {
			value: string;
		}
		const poolProvides = {
			signer: dep((s: PoolState, d: { name: string }) => `${s.value}:${d.name}`),
			exclusive: exclusiveDep({
				get: (s: PoolState, d: { name: string }) => `${s.value}:${d.name}`,
				lockKey: (_s, d) => `lock:${d.name}`,
			}),
		} satisfies Provides<PoolState>;

		const pool = define<PoolState, typeof poolProvides>({
			name: 'pool',
			provides: poolProvides,
			start: async () => ({ value: 'v' }),
		});

		const windows: Window[] = [];
		const a = define({
			name: 'a-exclusive',
			deps: { val: pool.get('exclusive', { name: 'shared' }) },
			start: async () => {
				const startedAt = Date.now();
				await new Promise((r) => setTimeout(r, 60));
				const endedAt = Date.now();
				windows.push({ name: 'a-exclusive', startedAt, endedAt });
				return null;
			},
		});
		const b = define({
			name: 'b-plain',
			deps: { val: pool.get('signer', { name: 'shared' }) },
			start: async () => {
				const startedAt = Date.now();
				await new Promise((r) => setTimeout(r, 60));
				const endedAt = Date.now();
				windows.push({ name: 'b-plain', startedAt, endedAt });
				return null;
			},
		});
		const engine = new Engine({ stack: [a, b] }, { env });
		await engine.runOnce();
		const [wa, wb] = windows.sort((x, y) => x.name.localeCompare(y.name)) as [Window, Window];
		// b-plain has no lockKey (empty set). a-exclusive has a lockKey.
		// Greedy coloring assigns each color 0 (no conflict). They
		// parallelize.
		expect(overlaps(wa, wb)).toBe(true);
	});
});

describe('Engine parallelism — error isolation', () => {
	it('one sibling erroring does not break the other in the same color', async () => {
		const completed: string[] = [];
		const erroring = define({
			name: 'erroring',
			start: async () => {
				throw new Error('intentional');
			},
		});
		const surviving = define({
			name: 'surviving',
			start: async () => {
				await new Promise((r) => setTimeout(r, 20));
				completed.push('surviving');
				return null;
			},
		});
		const engine = new Engine({ stack: [erroring, surviving] }, { env });
		const result = await engine.runOnce();
		expect(completed).toEqual(['surviving']);
		expect(result.errored.map((e) => e.name)).toEqual(['erroring']);
		expect(result.ran.map((r) => r.name)).toEqual(['surviving']);
	});
});
