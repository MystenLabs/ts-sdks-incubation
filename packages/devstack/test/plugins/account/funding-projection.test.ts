import { describe, expect, it } from '@effect/vitest';

import { fundingProjectionForResult } from '../../../src/plugins/account/index.ts';
import { SUI_FULL_COIN_TYPE } from '../../../src/plugins/account/funding.ts';
import type {
	AccountFundingResult,
	AppliedFundingEntry,
	ProjectedFundingEntry,
} from '../../../src/plugins/account/funding.ts';

const requested = (over: Partial<ProjectedFundingEntry> = {}): ProjectedFundingEntry => ({
	coin: 'WAL',
	fullCoinType: '0xfeed::wal::WAL',
	amount: 123n,
	...over,
});

const applied = (
	outcome: AppliedFundingEntry['outcome'],
	over: Partial<ProjectedFundingEntry> = {},
): AppliedFundingEntry => ({ ...requested(over), outcome });

// `fundingProjectionForResult` is the runtime → registry projection in
// `account/index.ts`. These tests drive the REAL exported function (not
// an inline copy) so a regression in the projection logic is caught.
describe('fundingProjectionForResult', () => {
	it('projects an empty request as skipped', () => {
		const out = fundingProjectionForResult({ requested: [], applied: [] });
		expect(out).toEqual({ status: 'skipped', balanceMist: null, requestedMist: null, entries: [] });
	});

	it('maps funded vs already-satisfied per row', () => {
		const sui = requested({ coin: 'SUI', fullCoinType: SUI_FULL_COIN_TYPE, amount: 1_000_000n });
		const wal = requested();
		const result: AccountFundingResult = {
			requested: [sui, wal],
			applied: [applied('funded', { coin: 'SUI', fullCoinType: SUI_FULL_COIN_TYPE, amount: 1_000_000n }), applied('already-satisfied')],
		};

		const out = fundingProjectionForResult(result);

		expect(out.status).toBe('funded');
		// SUI is the requested-amount column.
		expect(out.requestedMist).toBe('1000000');
		expect(out.entries).toEqual([
			{ coin: 'SUI', fullCoinType: SUI_FULL_COIN_TYPE, amount: '1000000', status: 'funded' },
			{ coin: 'WAL', fullCoinType: '0xfeed::wal::WAL', amount: '123', status: 'already-satisfied' },
		]);
	});

	it('labels a requested entry absent from `applied` as skipped (zero-amount / no-strategy drop)', () => {
		// `applied` is a subsequence: the second requested entry was
		// dropped at the funding-pass boundary (e.g. zero amount or no
		// registered strategy), so only the first entry settled.
		const a = requested({ coin: 'A', fullCoinType: '0xa::a::A', amount: 10n });
		const dropped = requested({ coin: 'B', fullCoinType: '0xb::b::B', amount: 20n });
		const c = requested({ coin: 'C', fullCoinType: '0xc::c::C', amount: 30n });
		const out = fundingProjectionForResult({
			requested: [a, dropped, c],
			applied: [applied('funded', a), applied('funded', c)],
		});

		expect(out.entries?.map((e) => e.status)).toEqual(['funded', 'skipped', 'funded']);
		// Mixed-but-no-failure: two of three settled → `unknown`.
		expect(out.status).toBe('unknown');
	});

	// Regression for the outcome-keyed-projection mislabel: two requested
	// entries that resolve to the SAME (fullCoinType, amount). The funding
	// pass processes them serially — the first moves funds (`funded`), the
	// second sees the just-funded balance (`already-satisfied`). The old
	// Map-keyed projection collapsed both onto one key and mislabeled BOTH
	// rows as `already-satisfied` (whatever `applied` listed last), hiding
	// the genuinely-funded first row. The positional consume must preserve
	// the per-row outcome in order.
	it('does not mislabel duplicate (fullCoinType, amount) entries', () => {
		const dup = requested({ coin: 'WAL', fullCoinType: '0xfeed::wal::WAL', amount: 123n });
		const out = fundingProjectionForResult({
			requested: [dup, dup],
			applied: [applied('funded'), applied('already-satisfied')],
		});

		expect(out.entries?.map((e) => e.status)).toEqual(['funded', 'already-satisfied']);
		// Both settled → top-level `funded`.
		expect(out.status).toBe('funded');
	});

	it('keeps order when the funded duplicate is listed second in `applied`', () => {
		// Symmetric guard: if the serial pass settles the first row as
		// already-satisfied and funds the second, the projection must
		// follow `applied` order positionally — not bucket by key.
		const dup = requested({ coin: 'WAL', fullCoinType: '0xfeed::wal::WAL', amount: 123n });
		const out = fundingProjectionForResult({
			requested: [dup, dup],
			applied: [applied('already-satisfied'), applied('funded')],
		});

		expect(out.entries?.map((e) => e.status)).toEqual(['already-satisfied', 'funded']);
	});
});
