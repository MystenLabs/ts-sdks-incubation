import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { coin, coinFundingCapabilityKey, type CoinValue } from '../../../src/plugins/coin/index.ts';
import { appName, chainId, stackName } from '../../../src/substrate/brand.ts';
import type { AcquireContext } from '../../../src/substrate/plugin.ts';

const fakeAcquireContext: AcquireContext = {
	identity: {
		app: appName('coin-test'),
		stack: stackName('main'),
		chain: chainId('sui:localnet'),
	},
	chain: chainId('sui:localnet'),
	runtimeRoot: '/tmp/devstack-coin-test',
};

describe('coin funding strategy contribution', () => {
	it('registers local package coin funding by full coin type', () => {
		const pkg = { id: 'package:deep' } as never;
		const member = coin.fromPackage(pkg, 'DEEP');
		const fullCoinType = '0xabc::deep::DEEP';
		const fundingStrategy = { request: () => Effect.void };
		const value = {
			fullCoinType,
			decimals: 6,
			source: 'registry',
			symbol: 'DEEP',
			treasuryCapId: '0xcap',
			mint: () => Effect.die('not used'),
			fundingStrategy,
		} satisfies CoinValue;

		if (typeof member.capabilities !== 'function') {
			throw new Error('expected coin capabilities factory');
		}
		const capabilities = member.capabilities(value, fakeAcquireContext);
		const contribution = capabilities.find(
			(cap) =>
				cap.kind === 'strategy-contributor' &&
				cap.capabilityKey === coinFundingCapabilityKey(fullCoinType),
		);

		expect(contribution).toMatchObject({
			kind: 'strategy-contributor',
			capabilityKey: 'coinType:0xabc::deep::DEEP',
			strategy: fundingStrategy,
			autoMounted: true,
		});
	});
});
