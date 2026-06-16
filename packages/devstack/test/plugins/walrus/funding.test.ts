import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import { account } from '../../../src/plugins/account/index.ts';
import {
	walCoin,
	walrus,
	walFaucetStrategyKey,
	type WalrusResolved,
} from '../../../src/plugins/walrus/index.ts';
import { makeWalFaucetContribution } from '../../../src/plugins/walrus/faucet-strategy.ts';
import { emitContributions } from '../../../src/substrate/plugin-ctx.ts';
import { makeTestPluginCtx } from '../../helpers/test-plugin-ctx.ts';

const fakeWalrusResolved: WalrusResolved = {
	mode: 'local',
	network: 'localnet',
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
		// The local-mode walrus `start` emits the WAL faucet contribution
		// inline (only when both a faucet strategy + WAL coin type resolved)
		// via the shared `emitContributions` router. Drive that same
		// `makeWalFaucetContribution` decl (the contribution under test)
		// through `emitContributions` against a decl-capturing fake ctx and
		// read the WAL strategy from `captured.provides`.
		const { ctx, captured } = makeTestPluginCtx();
		const { walCoinType, walFaucetStrategy } = fakeWalrusResolved;
		if (walCoinType === null || walFaucetStrategy === null) {
			throw new Error('fixture must resolve a WAL coin type + faucet strategy');
		}
		emitContributions(ctx, [makeWalFaucetContribution(walFaucetStrategy, walCoinType)]);

		const walStrategy = captured.provides.find(
			(capability) => capability.capabilityKey === walFaucetStrategyKey('0xfeed::wal::WAL'),
		);

		expect(walStrategy).toBeDefined();
	});
});
