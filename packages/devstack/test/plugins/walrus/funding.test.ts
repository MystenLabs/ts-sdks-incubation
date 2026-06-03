import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import { account } from '../../../src/plugins/account/index.ts';
import { appName, chainId, stackName } from '../../../src/substrate/brand.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import {
	emitLocalCapabilities,
	walCoin,
	walrus,
	walFaucetStrategyKey,
	type WalrusResolved,
} from '../../../src/plugins/walrus/index.ts';
import { makeTestPluginCtx } from '../../helpers/test-plugin-ctx.ts';

const fakeIdentity: Identity = {
	app: appName('walrus-test'),
	stack: stackName('main'),
	chain: chainId('sui:localnet'),
};

const fakeWalrusResolved: WalrusResolved = {
	mode: 'local',
	chain: 'sui:localnet',
	walrusPackageId: '0xwalrus',
	walPackageId: '0xfeed',
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
		// Stage B: the legacy `plugin.capabilities` second-closure is gone —
		// `start` now emits contributions inline via the typed `ctx` verbs.
		// Drive the exported `emitLocalCapabilities` seam (the contribution
		// half of `start`) with a decl-capturing fake ctx and read the WAL
		// strategy from `captured.provides` (was the returned decl array).
		const { ctx, captured } = makeTestPluginCtx();
		emitLocalCapabilities(ctx, {
			name: 'walrus',
			nodeCount: 0,
			containerApiPort: 9000,
			serviceKey: 'walrus.walrus',
			resolved: fakeWalrusResolved,
			identity: fakeIdentity,
		});

		const walStrategy = captured.provides.find(
			(capability) => capability.capabilityKey === walFaucetStrategyKey('0xfeed::wal::WAL'),
		);

		expect(walStrategy).toBeDefined();
	});
});
