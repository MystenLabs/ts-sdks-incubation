import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Env } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import type { Package } from '../shapes/index.js';
import { manifest } from './manifest.js';
import { registerCoin } from './register-coin.js';

let appDir: string;

beforeEach(async () => {
	appDir = await mkdtemp(join(tmpdir(), 'devstack-registercoin-'));
});

afterEach(async () => {
	await rm(appDir, { recursive: true, force: true });
});

function envFor(stack = 'main'): Env {
	return { appName: 'demo', appDir, network: 'localnet', stack };
}

function fakePublish(name: string, packageId: string) {
	type S = { name: string; packageId: string };
	return define<S>({
		name: `publish.${name}`,
		provides: { package: dep((s: S): Package => ({ name: s.name, packageId: s.packageId })) },
		start: async () => ({ name, packageId }),
	});
}

describe('registerCoin', () => {
	it('projects packageId + module + type into a Coin shape', async () => {
		const publish = fakePublish('managed_coin', '0xabc');
		const coin = registerCoin({
			name: 'managed_coin',
			package: publish.get('package'),
			module: 'managed_coin',
			type: 'MANAGED_COIN',
			decimals: 6,
		});

		const engine = new Engine({ stack: [publish, coin] }, { env: envFor() });
		await engine.runOnce();

		const view = engine.getState().nodes.get('registerCoin.managed_coin');
		expect(view).toBeDefined();
		expect(view!.state).toEqual({
			name: 'managed_coin',
			type: '0xabc::managed_coin::MANAGED_COIN',
			decimals: 6,
		});
	});

	it('feeds the manifest coins: list', async () => {
		const publish = fakePublish('musdc', '0xdef');
		const coin = registerCoin({
			name: 'musdc',
			package: publish.get('package'),
			module: 'mock_usdc',
			type: 'MOCK_USDC',
			decimals: 6,
		});
		const m = manifest({
			packages: [publish.get('package')],
			coins: [coin.get('coin')],
		});

		const engine = new Engine({ stack: [publish, coin, m] }, { env: envFor() });
		await engine.runOnce();

		const body = await readFile(join(appDir, 'src/generated/manifest.ts'), 'utf8');
		expect(body).toContain('"name": "musdc"');
		expect(body).toContain('"type": "0xdef::mock_usdc::MOCK_USDC"');
		expect(body).toContain('"decimals": 6');
		// The Manifest type is imported from /shapes rather than inlined;
		// rendering the coin in the data section is the real assertion.
		expect(body).toContain('"coins":');
		expect(body).toContain("import type { Manifest } from '@mysten-incubation/devstack/shapes'");
	});

	it('throws on missing name/module/type', () => {
		const publish = fakePublish('p', '0x1');
		expect(() =>
			registerCoin({
				name: '',
				package: publish.get('package'),
				module: 'm',
				type: 'T',
				decimals: 6,
			}),
		).toThrow(/`name` is required/);
		expect(() =>
			registerCoin({
				name: 'x',
				package: publish.get('package'),
				module: '',
				type: 'T',
				decimals: 6,
			}),
		).toThrow(/`module` is required/);
		expect(() =>
			registerCoin({
				name: 'x',
				package: publish.get('package'),
				module: 'm',
				type: '',
				decimals: 6,
			}),
		).toThrow(/`type` is required/);
	});
});
