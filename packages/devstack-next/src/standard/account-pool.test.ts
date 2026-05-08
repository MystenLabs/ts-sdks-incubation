import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import { define } from '../factories/define.js';
import { accountPool } from './account-pool.js';

interface FakeSigner {
	address: string;
	priv: string;
}

const env = { appName: 'test', appDir: '/tmp/account-pool', network: 'localnet' };

function makeFakePool(opts?: { addressOf?: boolean }) {
	let materializeCalls = 0;
	const seenNeeded: ReadonlySet<string>[] = [];

	const pool = accountPool<FakeSigner, { kind: 'random' }>({
		specs: { publisher: { kind: 'random' }, minter: { kind: 'random' } },
		materialize: async ({ specs, prior, needed }) => {
			materializeCalls += 1;
			seenNeeded.push(new Set(needed));
			const out: Record<string, FakeSigner> = { ...(prior ?? {}) };
			for (const name of Object.keys(specs)) {
				if (out[name]) continue;
				out[name] = { address: `0x${name}`, priv: `priv-${name}` };
			}
			return out;
		},
		...(opts?.addressOf ? { addressOf: (sig: FakeSigner) => sig.address } : {}),
	});

	return { pool, getCalls: () => materializeCalls, seenNeeded };
}

describe('accountPool', () => {
	it('exposes a per-name signer Dep', async () => {
		const { pool } = makeFakePool();
		let publisher: FakeSigner | undefined;
		const consumer = define({
			name: 'consumer',
			deps: { sig: pool.get('signer', { name: 'publisher' }) },
			run: async ({ deps: { sig } }) => {
				publisher = sig;
				return undefined;
			},
		});

		const engine = new Engine({ stack: [consumer] }, { env });
		await engine.runOnce();

		expect(publisher).toEqual({ address: '0xpublisher', priv: 'priv-publisher' });
	});

	it('exposes the full signer map via the `all` Dep', async () => {
		const { pool } = makeFakePool();
		let allSigners: Record<string, FakeSigner> | undefined;
		const consumer = define({
			name: 'all-consumer',
			deps: { all: pool.get('all') },
			run: async ({ deps: { all } }) => {
				allSigners = all;
				return undefined;
			},
		});

		const engine = new Engine({ stack: [consumer] }, { env });
		await engine.runOnce();

		expect(allSigners).toEqual({
			publisher: { address: '0xpublisher', priv: 'priv-publisher' },
			minter: { address: '0xminter', priv: 'priv-minter' },
		});
	});

	it('aggregates per-consumer needs into the materialize callback', async () => {
		const { pool, seenNeeded } = makeFakePool();
		const consumerA = define({
			name: 'a',
			deps: { s: pool.get('signer', { name: 'publisher' }) },
			run: async () => undefined,
		});
		const consumerB = define({
			name: 'b',
			deps: { s: pool.get('signer', { name: 'minter' }) },
			run: async () => undefined,
		});

		const engine = new Engine({ stack: [consumerA, consumerB] }, { env });
		await engine.runOnce();

		expect(seenNeeded).toHaveLength(1);
		expect(seenNeeded[0]).toEqual(new Set(['publisher', 'minter']));
	});

	it('expands `all` to every spec name in the needed set', async () => {
		const { pool, seenNeeded } = makeFakePool();
		const consumer = define({
			name: 'all-consumer',
			deps: { all: pool.get('all') },
			run: async () => undefined,
		});

		const engine = new Engine({ stack: [consumer] }, { env });
		await engine.runOnce();

		expect(seenNeeded[0]).toEqual(new Set(['publisher', 'minter']));
	});

	it('throws when a consumer asks for a signer not in the pool', async () => {
		const { pool } = makeFakePool();
		const consumer = define({
			name: 'bad',
			deps: { s: pool.get('signer', { name: 'ghost' }) },
			run: async () => undefined,
		});

		const engine = new Engine({ stack: [consumer] }, { env });
		// Engine surfaces node errors via cycle result rather than throwing.
		const result = await engine.runOnce();
		const errored = result.errored.find((e) => e.name === 'bad');
		expect(errored).toBeDefined();
		expect(errored?.error.message).toMatch(/signer "ghost" not in pool/);
	});

	it('preserves prior signers across cycles (warm restart)', async () => {
		const { pool, getCalls } = makeFakePool();
		const observed: FakeSigner[] = [];
		const consumer = define({
			name: 'warm',
			deps: { s: pool.get('signer', { name: 'publisher' }) },
			run: async ({ deps: { s } }) => {
				observed.push(s);
				return undefined;
			},
		});

		const engine = new Engine({ stack: [consumer] }, { env });
		await engine.runOnce();
		engine.invalidate('warm');
		await engine.runOnce();

		expect(getCalls()).toBeGreaterThanOrEqual(1);
		expect(observed).toHaveLength(2);
		expect(observed[0]).toEqual(observed[1]);
	});

	it('emits an `accounts` representation when addressOf is provided', async () => {
		const { pool } = makeFakePool({ addressOf: true });
		const consumer = define({
			name: 'reads-all',
			deps: { all: pool.get('all') },
			run: async () => undefined,
		});

		const engine = new Engine({ stack: [consumer] }, { env });
		await engine.runOnce();

		const view = engine.getState().nodes.get('accounts.pool');
		expect(view?.representations?.accounts).toEqual([
			{ name: 'publisher', address: '0xpublisher' },
			{ name: 'minter', address: '0xminter' },
		]);
	});

	it('omits represents when addressOf is not provided', async () => {
		const { pool } = makeFakePool();
		const consumer = define({
			name: 'no-rep',
			deps: { all: pool.get('all') },
			run: async () => undefined,
		});

		const engine = new Engine({ stack: [consumer] }, { env });
		await engine.runOnce();

		const view = engine.getState().nodes.get('accounts.pool');
		expect(view?.representations?.accounts).toBeUndefined();
	});

	it('respects a custom name', async () => {
		const pool = accountPool<FakeSigner, { kind: string }>({
			name: 'my.custom.pool',
			specs: { x: { kind: 'random' } },
			materialize: async ({ specs }) => {
				const out: Record<string, FakeSigner> = {};
				for (const name of Object.keys(specs)) {
					out[name] = { address: `0x${name}`, priv: 'p' };
				}
				return out;
			},
		});

		expect(pool.name).toBe('my.custom.pool');
	});
});
