import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Env } from '../engine/types.js';
import { define } from '../factories/define.js';
import { deepbook, type DeepbookState } from './deepbook.js';
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
