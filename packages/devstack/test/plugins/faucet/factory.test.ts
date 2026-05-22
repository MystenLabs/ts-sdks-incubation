import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { defineFaucetStrategy } from '../../../src/plugins/faucet/index.ts';

describe('faucet strategy helper', () => {
	it('converts caller-supplied strategies into strategy contributions', () => {
		const strategy = {
			request: () => Effect.void,
		};
		const contribution = defineFaucetStrategy({
			chainId: 'sui:custom',
			strategy,
			priority: 10,
		});

		expect(contribution).toEqual({
			kind: 'strategy-contributor',
			capabilityKey: 'faucet:request:sui:custom',
			strategy,
			autoMounted: false,
			priority: 10,
		});
	});
});
