import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Dep, Env, Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { deepbook, deepbookLocalnet, type DeepbookState } from './deepbook.js';
import { sui } from './sui.js';
import type { Package } from '../shapes/index.js';

const baseEnv = (network: string): Env => ({
	appName: 'demo',
	appDir: '/tmp/deepbook-test',
	network,
});

describe('deepbook', () => {
	it('publishes testnet ids when network=testnet', async () => {
		const node = deepbook();
		const engine = new Engine({ stack: [node] }, { env: baseEnv('testnet') });
		const result = await engine.runOnce();
		expect(result.errored).toEqual([]);
		const state = engine.getState().nodes.get('deepbook')!.state as DeepbookState;
		expect(state.network).toBe('testnet');
		expect(state.packageId).toBe(
			'0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
		);
		expect(state.registryId).toMatch(/^0x[0-9a-f]{64}$/);
	});

	it('publishes mainnet ids when network=mainnet', async () => {
		const node = deepbook();
		const engine = new Engine({ stack: [node] }, { env: baseEnv('mainnet') });
		await engine.runOnce();
		const state = engine.getState().nodes.get('deepbook')!.state as DeepbookState;
		expect(state.network).toBe('mainnet');
		expect(state.packageId).toBe(
			'0xf48222c4e057fa468baf136bff8e12504209d43850c5778f76159292a96f621e',
		);
	});

	it('honors an explicit opts.network override', async () => {
		const node = deepbook({ network: 'mainnet' });
		const engine = new Engine({ stack: [node] }, { env: baseEnv('testnet') });
		await engine.runOnce();
		const state = engine.getState().nodes.get('deepbook')!.state as DeepbookState;
		expect(state.network).toBe('mainnet');
	});

	it('errors when env.network is localnet and no override is given', async () => {
		const node = deepbook();
		const engine = new Engine({ stack: [node] }, { env: baseEnv('localnet') });
		const result = await engine.runOnce();
		expect(result.errored).toHaveLength(1);
		expect(result.errored[0]?.error.message).toMatch(/no canonical deployment/);
	});

	it('exposes provides.package as a Package shape', async () => {
		const node = deepbook({ network: 'testnet' });
		const consumer = define({
			name: 'consumer',
			deps: { pkg: node.get('package') },
			start: async ({ deps: { pkg } }): Promise<{ pkg: Package }> => ({ pkg }),
		});
		const engine = new Engine({ stack: [node, consumer] }, { env: baseEnv('testnet') });
		await engine.runOnce();
		const state = engine.getState().nodes.get('consumer')!.state as { pkg: Package };
		expect(state.pkg.name).toBe('deepbook');
		expect(state.pkg.packageId).toMatch(/^0x[0-9a-f]{64}$/);
	});

	it('exposes provides.marginPackage as a separate Package', async () => {
		const node = deepbook({ network: 'testnet' });
		const consumer = define({
			name: 'consumer',
			deps: { pkg: node.get('marginPackage') },
			start: async ({ deps: { pkg } }): Promise<{ pkg: Package }> => ({ pkg }),
		});
		const engine = new Engine({ stack: [node, consumer] }, { env: baseEnv('testnet') });
		await engine.runOnce();
		const state = engine.getState().nodes.get('consumer')!.state as { pkg: Package };
		expect(state.pkg.name).toBe('deepbook-margin');
		expect(state.pkg.packageId).toMatch(/^0x[0-9a-f]{64}$/);
	});

	it('exposes scalar id Deps for direct consumption', async () => {
		const node = deepbook({ network: 'mainnet' });
		const consumer = define({
			name: 'consumer',
			deps: {
				registryId: node.get('registryId'),
				deepTreasuryId: node.get('deepTreasuryId'),
			},
			start: async ({ deps }) => ({
				registryId: deps.registryId,
				deepTreasuryId: deps.deepTreasuryId,
			}),
		});
		const engine = new Engine({ stack: [node, consumer] }, { env: baseEnv('mainnet') });
		await engine.runOnce();
		const state = engine.getState().nodes.get('consumer')!.state as {
			registryId: string;
			deepTreasuryId: string;
		};
		expect(state.registryId).toMatch(/^0x[0-9a-f]{64}$/);
		expect(state.deepTreasuryId).toMatch(/^0x[0-9a-f]{64}$/);
	});

	it('represents.packages projects both deepbook + margin packages', async () => {
		const node = deepbook({ network: 'testnet' });
		const engine = new Engine({ stack: [node] }, { env: baseEnv('testnet') });
		await engine.runOnce();
		const view = engine.getState().nodes.get('deepbook')!;
		const packages = view.representations?.packages as Package[];
		expect(packages).toHaveLength(2);
		expect(packages.map((p) => p.name).sort()).toEqual(['deepbook', 'deepbook-margin']);
	});
});

describe('deepbookLocalnet (graph composition — no real chain)', () => {
	function makeOps(opts: { pools?: boolean } = {}) {
		interface SignerState {
			keypair: Ed25519Keypair;
		}
		const signerProvides = {
			signer: dep((s: SignerState) => s.keypair),
		} satisfies Provides<SignerState>;
		const signerNode = define<SignerState, typeof signerProvides>({
			name: 'test.signer',
			provides: signerProvides,
			start: async () => ({ keypair: Ed25519Keypair.generate() }),
		});
		const signerDep = signerNode.get('signer') as unknown as Dep<Ed25519Keypair>;
		const ops = deepbookLocalnet({
			signer: signerDep,
			...(opts.pools
				? {
						pools: [
							{
								name: 'sui-usdc',
								base: '0x2::sui::SUI',
								quote: '0xusdc::usdc::USDC',
								tickSize: 1n,
								lotSize: 1n,
								minSize: 1n,
							},
						],
					}
				: {}),
		});
		return { signerNode, ops };
	}

	it('publish + source siblings appear with sui pulled in', () => {
		const { signerNode, ops } = makeOps();
		const engine = new Engine(
			{
				stack: [
					sui.create({ network: 'localnet', rpcUrl: 'http://stub/' }),
					signerNode,
					ops.publish,
				],
			},
			{ env: baseEnv('localnet') },
		);
		const state = engine.getState();
		expect(state.nodes.has('publish.deepbook')).toBe(true);
		expect(state.nodes.has('deepbook.source')).toBe(true);
		expect(state.nodes.has('sui.localnet')).toBe(true);
		expect(state.nodes.has('deepbook.pools')).toBe(false);
	});

	it('pools step is created when pool specs are supplied', () => {
		const { signerNode, ops } = makeOps({ pools: true });
		expect(ops.pools).toBeDefined();
		const engine = new Engine(
			{
				stack: [
					sui.create({ network: 'localnet', rpcUrl: 'http://stub/' }),
					signerNode,
					ops.pools!,
				],
			},
			{ env: baseEnv('localnet') },
		);
		const state = engine.getState();
		expect(state.nodes.has('deepbook.pools')).toBe(true);
		expect(state.nodes.has('publish.deepbook')).toBe(true);
		expect(state.nodes.has('deepbook.source')).toBe(true);
	});

	it('pools step is omitted when no pool specs are supplied', () => {
		const { ops } = makeOps();
		expect(ops.pools).toBeUndefined();
	});
});
