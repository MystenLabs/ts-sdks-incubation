import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { coin, coinFundingCapabilityKey, type CoinValue } from '../../../src/plugins/coin/index.ts';
import type { AccountFundingStrategy } from '../../../src/contracts/funding-strategy.ts';
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
			autoMounted: true,
		});
		// The contribution's `strategy` is the wide
		// `AccountFundingStrategy` wrapper — not the inner narrow
		// strategy reference. See the regression test below for why
		// the barrel projects rather than re-exposing the literal.
		if (contribution?.kind !== 'strategy-contributor') {
			throw new Error('expected strategy-contributor contribution');
		}
		expect(typeof (contribution.strategy as { readonly request: unknown }).request).toBe(
			'function',
		);
	});

	it('barrel projects the narrow coin strategy to the wide AccountFundingStrategy at the capability boundary', async () => {
		// Regression: previously the coin barrel built the contribution
		// with `strategy: resolved.fundingStrategy` (narrow
		// `{address, amount}` request) and tagged the literal
		// `satisfies StrategyContributorDecl<…, AccountFundingStrategy>`
		// where `AccountFundingStrategy.request` requires
		// `{address, amount, account}`. The `satisfies` only held
		// because TS treats extra fields as ignored — the contract
		// that `account` would be passed through to the coin strategy
		// was silently violated.
		//
		// The barrel now wraps the narrow coin strategy in a wide
		// `AccountFundingStrategy` at the capability boundary,
		// dropping `account` explicitly. This pins:
		//   1. The contribution is invokable with the wide call shape
		//      (`{address, amount, account}`).
		//   2. The underlying narrow coin strategy receives ONLY
		//      `{address, amount}` — `account` was dropped honestly.
		const pkg = { id: 'package:deep' } as never;
		const member = coin.fromPackage(pkg, 'DEEP');
		const fullCoinType = '0xabc::deep::DEEP';
		const received: Array<{ readonly address: string; readonly amount: bigint }> = [];
		const narrowStrategy = {
			request: (req: { readonly address: string; readonly amount: bigint }) =>
				Effect.sync(() => {
					received.push(req);
				}),
		};
		const value = {
			fullCoinType,
			decimals: 6,
			source: 'registry',
			symbol: 'DEEP',
			treasuryCapId: '0xcap',
			mint: () => Effect.die('not used'),
			fundingStrategy: narrowStrategy,
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
		if (contribution === undefined || contribution.kind !== 'strategy-contributor') {
			throw new Error('expected strategy-contributor contribution');
		}
		// Type-level contract: the contribution's `Strategy` slot is
		// `AccountFundingStrategy` (from the `satisfies …<…,
		// AccountFundingStrategy>` tag in the barrel). The compile
		// passes only because the wrapping is structurally honest —
		// otherwise the inner `request` would be assignable to the
		// wider call shape only via an `as` cast, which the source
		// avoids.
		const strategy = contribution.strategy as AccountFundingStrategy;
		// The wide call shape MUST work — this is the regression: the
		// coin's underlying narrow strategy didn't accept `account` at
		// all; the barrel's projection now drops it before delegating.
		await Effect.runPromise(
			strategy.request({
				address: '0xrecipient',
				amount: 42n,
				account: { sentinel: 'account-handle' },
			}),
		);
		expect(received).toEqual([{ address: '0xrecipient', amount: 42n }]);
		// And critically: `account` was NOT forwarded to the narrow
		// strategy — the barrel dropped it honestly at the boundary.
		expect(received[0]).not.toHaveProperty('account');
	});
});
