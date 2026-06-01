// Factory-shape tests for the deepbook plugin. Pin the public
// surface (`deepbook(...)`, `deepbookFor(...)`) so regressions
// surface here, not in the e2e harness.

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { account } from '../../../src/plugins/account/index.ts';
import { coin } from '../../../src/plugins/coin/index.ts';
import {
	DEEPBOOK_DEEP_FAUCET_STRATEGY_KEY,
	DEEPBOOK_TESTNET_DEEP_COIN_TYPE,
	deepbook,
	deepbookFor,
	type DeepbookResolved,
} from '../../../src/plugins/deepbook/index.ts';
import { localPackage } from '../../../src/plugins/package/index.ts';
import { chainId } from '../../../src/substrate/brand.ts';
import * as publicRoot from '../../../src/index.ts';
import { isPlugin } from '../../../src/substrate/plugin.ts';
import type { CodegenEmitContext, CodegenEmitDone } from '../../../src/contracts/codegenable.ts';

const TESTNET_PYTH = {
	packageId: null,
	stateId: '0x243759059f4c3111179da5878c12f68d612c21a8d54d85edc86164bb18be1c7c',
	wormholeStateId: '0x31358d198147da50db32eda2562951d53973a0c0ad5ed738e9b17d88b213d790',
	feeds: [],
};
const OVERRIDE_IDS = {
	packageId: '0xoverride-pkg',
	registryId: '0xoverride-reg',
	adminCapId: '0xoverride-admin',
} as const;

const deepbookPackageFor = (publisher: ReturnType<typeof account>) =>
	localPackage('deepbook_pkg', {
		sourcePath: 'move/deepbook',
		publisher,
		capture: {
			registryId: '::registry::Registry',
			adminCapId: '::registry::DeepbookAdminCap',
		},
	});

describe('deepbook(opts) — primary factory', () => {
	it('refuses override mode without explicit deployment ids', () => {
		expect(() => deepbook({ mode: 'override' } as never)).toThrow(/packageId/);
	});

	it('produces a branded plugin for override mode', () => {
		const member = deepbook({ mode: 'override', ...OVERRIDE_IDS });
		expect(isPlugin(member)).toBe(true);
		expect(member.id).toMatch(/^deepbook\//);
		expect(member.role).toBe('task');
	});

	it('produces a branded plugin for local mode', () => {
		const publisher = account('publisher');
		const deepbookPackage = deepbookPackageFor(publisher);
		const member = deepbook({
			mode: 'local',
			publisher,
			package: deepbookPackage,
			pools: [] as const,
		});
		expect(isPlugin(member)).toBe(true);
		expect(member.id).toMatch(/^deepbook\//);
		expect(member.role).toBe('task');
	});

	it('depends only on Sui for override mode', () => {
		const member = deepbook({ mode: 'override', ...OVERRIDE_IDS });
		expect(member.dependsOn.map((resource) => resource.id)).toEqual(['sui']);
	});

	it('represents the publisher direct-value ref in dependencies', () => {
		const publisher = account('publisher');
		const deepbookPackage = deepbookPackageFor(publisher);
		const member = deepbook({
			mode: 'local',
			publisher,
			package: deepbookPackage,
			pools: [] as const,
		});
		expect(member.dependsOn.map((resource) => resource.id)).toEqual([
			'sui',
			'account/publisher',
			'package:deepbook_pkg',
		]);
	});

	it('threads local pool coin refs through dependencies', () => {
		const publisher = account('publisher');
		const deepbookPackage = deepbookPackageFor(publisher);
		const suiCoin = coin.builtin('sui');
		const member = deepbook({
			mode: 'local',
			publisher,
			package: deepbookPackage,
			pools: [
				{
					name: 'SUI_SUI',
					base: { key: 'SUI', coin: suiCoin },
					quote: { key: 'SUI_QUOTE', coin: suiCoin },
					tickSize: 1_000n,
					lotSize: 1_000n,
					minSize: 1_000n,
				},
			],
		});
		expect(member.dependsOn.map((resource) => resource.id)).toEqual([
			'sui',
			'account/publisher',
			'package:deepbook_pkg',
			'coin:sui',
		]);
	});

	it('produces a task for known mode', () => {
		const member = deepbook({
			mode: 'known',
			packageId: '0xpkg',
			registryId: '0xreg',
			chain: 'sui:testnet',
		});
		expect(member.role).toBe('task');
		expect(member.id).toMatch(/^deepbook\//);
	});

	it('uses built-in known deployment ids when network is supplied', () => {
		const member = deepbook({
			mode: 'known',
			network: 'testnet',
		});
		expect(member.role).toBe('task');
		expect(member.id).toBe('deepbook/deepbook');
	});

	it('refuses known mode without explicit ids or a known network', () => {
		expect(() => deepbook({ mode: 'known' } as never)).toThrow(/packageId and registryId/);
	});

	it('resolves built-in testnet known deployment ids', () => {
		const member = deepbook({
			mode: 'known',
			network: 'testnet',
		});
		const resolved = Effect.runSync(
			member.start([{ chain: chainId('sui:local') } as never]) as Effect.Effect<
				DeepbookResolved,
				unknown,
				never
			>,
		);

		expect(resolved).toMatchObject({
			mode: 'known',
			chain: 'sui:testnet',
			packageId: '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
			registryId: '0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1',
			adminCapId: null,
			pyth: TESTNET_PYTH,
		});
	});

	it('emits known Pyth state ids through generated bindings', () => {
		const member = deepbook({
			mode: 'known',
			network: 'testnet',
		});
		const resolved = Effect.runSync(
			member.start([{ chain: chainId('sui:local') } as never]) as Effect.Effect<
				DeepbookResolved,
				unknown,
				never
			>,
		);
		const caps =
			typeof member.capabilities === 'function'
				? member.capabilities(resolved, {} as never)
				: member.capabilities;
		expect(caps).toBeDefined();
		// Name-keyed sibling aggregate: emitter is `deepbook/<name>`
		// (default name `deepbook`); the export key is the instance name.
		const codegen = caps?.find(
			(cap) => cap.kind === 'codegenable' && cap.emitterName === 'deepbook/deepbook',
		) as
			| {
					readonly emit: (ctx: CodegenEmitContext) => Effect.Effect<CodegenEmitDone>;
			  }
			| undefined;
		expect(codegen).toBeDefined();

		const emitted: {
			deepbook?: {
				readonly pyth: {
					readonly packageId: string | null;
					readonly stateId: string | null;
					readonly wormholeStateId: string | null;
					readonly feeds: ReadonlyArray<unknown>;
				} | null;
			};
		} = {};
		Effect.runSync(
			codegen!.emit({
				exportConst: (name, value) => {
					// Export key == instance name (`deepbook`).
					if (name === 'deepbook') {
						emitted.deepbook = value as typeof emitted.deepbook;
					}
				},
				importStatement: () => {},
				done: () => ({ _tag: 'CodegenEmitDone' }),
			}),
		);
		expect(emitted.deepbook?.pyth).toEqual({
			packageId: TESTNET_PYTH.packageId,
			stateId: TESTNET_PYTH.stateId,
			wormholeStateId: TESTNET_PYTH.wormholeStateId,
			feeds: [],
		});
	});

	it('contributes a testnet DEEP funding strategy for account funding', () => {
		const member = deepbook({
			mode: 'known',
			network: 'testnet',
		});
		const resolved = Effect.runSync(
			member.start([
				{ chain: chainId('sui:testnet'), sdk: { client: {} } } as never,
			]) as Effect.Effect<DeepbookResolved, unknown, never>,
		);
		const caps =
			typeof member.capabilities === 'function'
				? member.capabilities(resolved, {} as never)
				: member.capabilities;
		const strategy = caps?.find(
			(cap) =>
				cap.kind === 'strategy-contributor' &&
				cap.capabilityKey === DEEPBOOK_DEEP_FAUCET_STRATEGY_KEY,
		);

		expect(DEEPBOOK_DEEP_FAUCET_STRATEGY_KEY).toBe(`coinType:${DEEPBOOK_TESTNET_DEEP_COIN_TYPE}`);
		expect(strategy).toBeDefined();
		expect(strategy?.kind).toBe('strategy-contributor');
		if (strategy?.kind === 'strategy-contributor') {
			expect(strategy.strategy.usesAccountSigner).toBe(true);
		}
	});

	it('folds the instance name into the resource id', () => {
		const member = deepbook({
			mode: 'known',
			packageId: '0xpkg',
			registryId: '0xreg',
			chain: 'sui:testnet',
			name: 'arena',
		});
		expect(member.id).toBe('deepbook/arena');
	});
});

describe('deepbookFor(network) — mode-narrowed namespace', () => {
	it('exposes `.local`, `.override`, and `.known` on a local network', () => {
		const network = { mode: 'local' as const, chain: chainId('sui:localnet') };
		const factories = deepbookFor(network);
		expect(typeof factories.local).toBe('function');
		expect(typeof factories.override).toBe('function');
		expect(typeof factories.known).toBe('function');
	});

	it('exposes `.known` only on a live network', () => {
		const network = { mode: 'live' as const, chain: chainId('sui:testnet') };
		const factories = deepbookFor(network);
		expect(typeof factories.known).toBe('function');
		expect((factories as { local?: unknown }).local).toBeUndefined();
		expect((factories as { override?: unknown }).override).toBeUndefined();
	});

	it('exposes `.known` only on a fork network', () => {
		const network = {
			mode: 'fork' as const,
			chain: chainId('sui:mainnet-fork'),
			upstream: 'mainnet' as const,
		};
		const factories = deepbookFor(network);
		expect(typeof factories.known).toBe('function');
		expect((factories as { local?: unknown }).local).toBeUndefined();
		expect((factories as { override?: unknown }).override).toBeUndefined();
	});
});

describe('deepbook unsupported convenience factories', () => {
	it('does not expose dotted helpers that cannot acquire real release behavior', () => {
		const surface = deepbook as {
			readonly indexer?: unknown;
			readonly server?: unknown;
			readonly marketMaker?: unknown;
			readonly mintDEEP?: unknown;
			readonly mintUSDC?: unknown;
		};
		expect(surface.indexer).toBeUndefined();
		expect(surface.server).toBeUndefined();
		expect(surface.marketMaker).toBeUndefined();
		expect(surface.mintDEEP).toBeUndefined();
		expect(surface.mintUSDC).toBeUndefined();
	});

	it('keeps unsupported helper values out of the package root barrel', () => {
		for (const name of [
			'USDC_MARGIN_DEFAULTS',
			'SUI_MARGIN_DEFAULTS',
			'DEFAULT_POOL_RISK_CONFIG',
		]) {
			expect(Object.hasOwn(publicRoot, name)).toBe(false);
		}
	});
});
