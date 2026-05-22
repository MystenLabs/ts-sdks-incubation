import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { faucet } from '../../../src/plugins/faucet/index.ts';

describe('faucet factory', () => {
	it('converts caller-supplied strategies into strategy contributions', () => {
		const strategy = {
			request: () => Effect.void,
		};
		const plugin = faucet({
			strategies: [{ chainId: 'sui:custom', strategy, priority: 10 }],
		});

		expect(plugin.capabilities).toEqual([
			{
				kind: 'strategy-contributor',
				capabilityKey: 'faucet:request:sui:custom',
				strategy,
				autoMounted: false,
				priority: 10,
			},
		]);
	});
});
