import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { defineFaucetStrategy } from '../../../src/plugins/faucet/index.ts';
import { faucetExhausted } from '../../../src/plugins/faucet/errors.ts';

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

describe('FaucetExhausted shape', () => {
	// Pinning the shape post-bug-4 fix: `kind: 'wall-clock' | 'attempts'`
	// was dropped. Wall-clock budget exhaustion is the only surface that
	// wraps the underlying cause as `FaucetExhausted` — attempt-cap
	// exhaustion lets `FaucetUnreachable | FaucetBodyError` propagate
	// verbatim (more informative than a wrapped budget message).
	it('does not carry a discriminating "kind" field anymore', () => {
		const exhausted = faucetExhausted({
			url: 'http://faucet:9123',
			address: '0xabc',
			amount: 1n,
			attempts: 3,
			message: 'budget exhausted after 3 attempts',
			lastCause: new Error('socket hang up'),
		});
		expect(exhausted._tag).toBe('FaucetExhausted');
		expect((exhausted as unknown as Record<string, unknown>).kind).toBeUndefined();
		expect(exhausted.attempts).toBe(3);
		expect(exhausted.message).toContain('budget exhausted');
	});
});
