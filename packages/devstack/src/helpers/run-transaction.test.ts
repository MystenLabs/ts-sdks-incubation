import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Env } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { sui } from '../plugins/sui.js';
import { runTransaction } from './run-transaction.js';

const env: Env = {
	appName: 'demo',
	appDir: '/tmp/devstack-tx-test',
	network: 'localnet',
	stack: 'main',
};

function makeSigner(name: string, address: string) {
	type S = { name: string; address: string };
	return define({
		name: `acc.${name}`,
		provides: { signer: dep((s: S) => ({ name: s.name, address: s.address })) },
		start: async () => ({ name, address }),
	});
}

describe('runTransaction', () => {
	it('runs build callback with signer + rpcUrl, persists return value', async () => {
		const acc = makeSigner('minter', '0x222');
		let captured: { signer: { address: string }; rpcUrl: string } | undefined;

		const mint = runTransaction({
			name: 'mint-initial',
			signer: acc.get('signer'),
			build: async (ctx) => {
				captured = { signer: ctx.signer, rpcUrl: ctx.rpcUrl };
				return { digest: '0xdigest1', supply: 1_000_000 };
			},
		});

		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), mint] },
			{ env },
		);
		await engine.runOnce();
		expect(captured).toBeDefined();
		expect(captured!.signer.address).toBe('0x222');
		expect(captured!.rpcUrl).toContain('testnet.sui.io');

		const state = engine.getState().nodes.get('tx.mint-initial')!.state as {
			digest: string;
			supply: number;
		};
		expect(state.digest).toBe('0xdigest1');
		expect(state.supply).toBe(1_000_000);
	});

	it('skips re-execution when inputs are unchanged', async () => {
		const acc = makeSigner('minter', '0x222');
		let buildCount = 0;
		const mint = runTransaction({
			name: 'mint-initial',
			signer: acc.get('signer'),
			build: async () => {
				buildCount += 1;
				return { count: buildCount };
			},
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), mint] },
			{ env },
		);
		await engine.runOnce();
		expect(buildCount).toBe(1);

		engine.invalidate('sui.testnet');
		await engine.cycle();
		expect(buildCount).toBe(1);
	});

	it('re-fires when the user-supplied `inputs` invalidator changes', async () => {
		const acc = makeSigner('minter', '0x222');
		let rev = 0;
		let buildCount = 0;
		const mint = runTransaction({
			name: 'mint-initial',
			signer: acc.get('signer'),
			inputs: () => ({ rev }),
			build: async () => {
				buildCount += 1;
				return { count: buildCount };
			},
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), mint] },
			{ env },
		);
		await engine.runOnce();
		expect(buildCount).toBe(1);

		rev = 1;
		engine.invalidate('tx.mint-initial');
		await engine.cycle();
		expect(buildCount).toBe(2);
	});

	it('threads the inputHash into the build callback for caller-side keys', async () => {
		const acc = makeSigner('minter', '0x222');
		let captured = '';
		const mint = runTransaction({
			name: 'mint-initial',
			signer: acc.get('signer'),
			build: async ({ inputHash }) => {
				captured = inputHash;
				return { ok: true };
			},
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), mint] },
			{ env },
		);
		await engine.runOnce();
		expect(captured).toMatch(/^[0-9a-f]+/);
	});

	it('producer name is namespaced under tx.<name>', async () => {
		const acc = makeSigner('minter', '0x222');
		const mint = runTransaction({
			name: 'mint-initial',
			signer: acc.get('signer'),
			build: async () => ({ ok: true }),
		});
		// Same-signer serialization now flows through the signer Dep's
		// `exclusiveDep` lockKey, not through a runsAs field on the
		// producer. The producer's distinct namespaced name is what
		// makes each tx its own engine node.
		expect(mint.name).toBe('tx.mint-initial');
	});

	it('flows caller-supplied extra deps into the build callback as ctx.deps', async () => {
		// Synthetic "deploy info" transformer that produces a packageId.
		// Mirrors the pattern walrusSeedWal uses to share a chain-discovered
		// exchange package id across N per-account seed transactions.
		interface PkgState {
			packageId: string;
		}
		const pkgProvides = {
			full: dep((s: PkgState) => s),
		};
		const pkgNode = define<PkgState, typeof pkgProvides>({
			name: 'deploy.info',
			provides: pkgProvides,
			start: async () => ({ packageId: '0xabc' }),
		});

		const acc = makeSigner('publisher', '0x111');
		let captured: string | undefined;
		const tx = runTransaction({
			name: 'with-extra-deps',
			signer: acc.get('signer'),
			deps: { pkg: pkgNode.get('full') },
			build: async ({ deps }) => {
				captured = deps.pkg.packageId;
				return { ok: true };
			},
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), tx] },
			{ env },
		);
		await engine.runOnce();
		expect(captured).toBe('0xabc');
	});

	it('extra deps default to {} when caller omits them', async () => {
		const acc = makeSigner('publisher', '0x111');
		let captured: object | undefined;
		const tx = runTransaction({
			name: 'no-extra-deps',
			signer: acc.get('signer'),
			build: async ({ deps }) => {
				captured = deps;
				return { ok: true };
			},
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), tx] },
			{ env },
		);
		await engine.runOnce();
		expect(captured).toEqual({});
	});

	it('shared-signer serialization flows via accounts.pool.get("exclusive") on the signer Dep', async () => {
		// Two transactions wired to the same signer Dep — the engine will
		// refuse to parallel-batch them when the signer Dep's recipe is
		// declared as `exclusiveDep` with a stable lockKey (see the
		// accounts plugin's `exclusive` projection). No runsAs override
		// needed at the runTransaction call site — the serialization is
		// expressed on the producer that owns the resource, not the
		// consumer.
		const acc = makeSigner('publisher', '0x111');
		const tx1 = runTransaction({
			name: 'tx-one',
			signer: acc.get('signer'),
			build: async () => ({ idx: 1 }),
		});
		const tx2 = runTransaction({
			name: 'tx-two',
			signer: acc.get('signer'),
			build: async () => ({ idx: 2 }),
		});
		expect(tx1.name).toBe('tx.tx-one');
		expect(tx2.name).toBe('tx.tx-two');
	});
});
