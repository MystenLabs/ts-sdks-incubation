import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import { account } from '../../../src/plugins/account/index.ts';
import { appName, chainId, stackName } from '../../../src/substrate/brand.ts';
import type { AcquireContext } from '../../../src/substrate/plugin.ts';
import {
	walCoin,
	walrus,
	walFaucetStrategyKey,
	type WalrusResolved,
} from '../../../src/plugins/walrus/index.ts';

const fakeAcquireContext: AcquireContext = {
	identity: {
		app: appName('walrus-test'),
		stack: stackName('main'),
		chain: chainId('sui:localnet'),
	},
	chain: chainId('sui:localnet'),
	runtimeRoot: '/tmp/devstack-walrus-test',
};

const fakeWalrusResolved: WalrusResolved = {
	mode: 'local',
	chain: 'sui:localnet',
	packageConfig: {
		systemObjectId: '0xsystem',
		stakingPoolId: '0xstaking',
		exchangeIds: ['0xexchange'],
	},
	nodes: [],
	proxyUrl: 'http://walrus.localhost',
	aggregatorUrl: 'http://walrus.localhost',
	publisherUrl: 'http://walrus.localhost',
	walFaucetStrategy: { usesAccountSigner: true, request: () => Effect.void },
	walCoinType: '0xfeed::wal::WAL',
};

describe('walrus WAL funding integration', () => {
	it('local walrus depends only on Sui; accounts opt into WAL separately', () => {
		const plugin = walrus({ local: {} });

		expect(plugin.id).toBe('walrus');
		expect(plugin.dependsOn.map((resource) => resource.id)).toEqual(['sui']);
	});

	it('resolves a WAL coin member from a local walrus deployment', async () => {
		const localWalrus = walrus({ local: {} });
		const wal = walCoin(localWalrus);

		expect(wal.id).toBe('coin:wal');
		expect(wal.dependsOn.map((dependency) => dependency.id)).toEqual(['walrus']);

		const start = wal.start as unknown as (
			resolved: WalrusResolved,
		) => Effect.Effect<unknown, unknown, never>;
		const value = await Effect.runPromise(start(fakeWalrusResolved));
		expect(value).toEqual({
			symbol: 'WAL',
			fullCoinType: '0xfeed::wal::WAL',
			decimals: 9,
			source: 'walrus',
		});
	});

	it('threads the WAL coin through account funding dependencies', () => {
		const localWalrus = walrus({ local: {} });
		const wal = walCoin(localWalrus);
		const alice = account('alice', {
			kind: 'ephemeral',
			funding: [
				{ coin: 'sui', amount: 1_000_000_000n },
				{ coin: wal, amount: 500_000_000n },
			],
		});

		expect(alice.dependsOn.map((dependency) => dependency.id)).toEqual(['sui', 'coin:wal']);
	});

	it('registers the WAL faucet strategy under the resolved full coin type', () => {
		const plugin = walrus({ local: {} });
		if (typeof plugin.capabilities !== 'function') {
			throw new Error('expected walrus capabilities factory');
		}

		const capabilitiesFactory = plugin.capabilities as unknown as (
			value: WalrusResolved,
			runtime: AcquireContext,
		) => ReadonlyArray<{ readonly kind: string; readonly capabilityKey?: string }>;
		const capabilities = capabilitiesFactory(fakeWalrusResolved, fakeAcquireContext);
		const walStrategy = capabilities.find(
			(capability) =>
				capability.kind === 'strategy-contributor' &&
				capability.capabilityKey === walFaucetStrategyKey('0xfeed::wal::WAL'),
		);

		expect(walStrategy).toBeDefined();
	});
});
