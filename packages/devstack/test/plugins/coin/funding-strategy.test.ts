import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	coinFundingCapabilityKey,
	emitCapabilities,
	type CoinValue,
} from '../../../src/plugins/coin/index.ts';
import type { AccountFundingStrategy } from '../../../src/contracts/funding-strategy.ts';
import { makeTestPluginCtx } from '../../helpers/test-plugin-ctx.ts';

// Stage B: the coin plugin emits its contributions INLINE from `start`
// via the typed `ctx.*` verbs (see `src/substrate/plugin-ctx.ts`) instead
// of the legacy `capabilities` second-closure. Each coin `start` resolves
// a `CoinValue` (via `acquireCoin`) and then calls
// `emitCapabilities(ctx, symbol, value)` — the exported emit seam. These
// tests previously drove the now-removed public `capabilities(value, …)`
// factory and inspected the returned decls; the equivalent is to feed a
// hand-built resolved `CoinValue` into `emitCapabilities` against a
// decl-capturing fake `ctx` and assert the captured `provides`. Input
// (`value`) and output (the strategy-contributor decl) are unchanged — only
// the call shape moved from "return" to "emit + capture".
//
// `symbol` matches what `coin.fromPackage(pkg, 'DEEP').start` passes:
// the lower-cased witness symbol.
const coinSymbol = 'deep';

describe('coin funding strategy contribution', () => {
	it('registers local package coin funding by full coin type', () => {
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

		const { ctx, captured } = makeTestPluginCtx();
		emitCapabilities(ctx, coinSymbol, value);
		const contribution = captured.provides.find(
			(cap) => cap.capabilityKey === coinFundingCapabilityKey(fullCoinType),
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
		if (contribution === undefined) {
			throw new Error('expected strategy-contributor contribution');
		}
		expect(typeof (contribution.strategy as { readonly request: unknown }).request).toBe(
			'function',
		);
	});

	it('marks the coin funding strategy as usesAccountSigner so the dispatcher does not double-acquire the lease', () => {
		// Regression (self-funding deadlock): the coin strategy mints via
		// the publisher account's own `withTransactionSigner`, which
		// acquires the per-address lease `account:<publisherAddress>`
		// internally. The account funding dispatcher reads
		// `strategy.usesAccountSigner` and, when true, does NOT wrap the
		// request in its own `account:<fundedAddress>` lease. Without this
		// flag the dispatcher held `account:<fundedAddress>` while the mint
		// re-acquired `account:<publisherAddress>`; when funded ==
		// publisher both keys collapse to the same non-reentrant key and
		// the inner acquire blocks forever. Pin the flag here — the
		// dispatcher-side behavior is asserted in the account funding test.
		const fullCoinType = '0xabc::deep::DEEP';
		const value = {
			fullCoinType,
			decimals: 6,
			source: 'registry',
			symbol: 'DEEP',
			treasuryCapId: '0xcap',
			mint: () => Effect.die('not used'),
			fundingStrategy: { request: () => Effect.void },
		} satisfies CoinValue;

		const { ctx, captured } = makeTestPluginCtx();
		emitCapabilities(ctx, coinSymbol, value);
		const contribution = captured.provides.find(
			(cap) => cap.capabilityKey === coinFundingCapabilityKey(fullCoinType),
		);
		if (contribution === undefined) {
			throw new Error('expected strategy-contributor contribution');
		}
		expect((contribution.strategy as AccountFundingStrategy).usesAccountSigner).toBe(true);
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

		const { ctx, captured } = makeTestPluginCtx();
		emitCapabilities(ctx, coinSymbol, value);
		const contribution = captured.provides.find(
			(cap) => cap.capabilityKey === coinFundingCapabilityKey(fullCoinType),
		);
		if (contribution === undefined) {
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
