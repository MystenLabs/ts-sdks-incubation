// Unit tests for the synchronous factory-time validation in
// `resolveLocalClusterOptions`. The distilled-doc invariants 11+16
// require BOTH `nodeCount >= 1` AND `shards >= nodeCount` — and the
// failure mode must be a thrown `WalrusConfigError` at the
// `defineDevstack(...)` call site, NOT a deferred Effect failure.

import { describe, expect, it } from 'vitest';

import { resolveLocalClusterOptions } from '../../../src/plugins/walrus/mode/local-cluster.ts';

describe('resolveLocalClusterOptions', () => {
	it('applies defaults when called with the empty options bag', () => {
		const r = resolveLocalClusterOptions({});
		expect(r.name).toBe('walrus');
		expect(r.nodeCount).toBe(1);
		expect(r.shards).toBe(100);
		expect(r.epochDuration).toBe('24h');
	});

	it('throws synchronously on `nodeCount < 1` (distilled-doc invariant 11)', () => {
		expect(() => resolveLocalClusterOptions({ nodeCount: 0 })).toThrow(/nodeCount must be >= 1/);
	});

	it('throws synchronously on `shards < nodeCount`', () => {
		expect(() => resolveLocalClusterOptions({ nodeCount: 5, shards: 3 })).toThrow(
			/shards \(3\) must be >= nodeCount \(5\)/,
		);
	});

	it('passes through the user-supplied movePackagePath', () => {
		const r = resolveLocalClusterOptions({ movePackagePath: '/tmp/custom/contracts' });
		expect(r.movePackagePath).toBe('/tmp/custom/contracts');
	});

	it('coerces seedPaymentMist to bigint default when unset', () => {
		const r = resolveLocalClusterOptions({});
		expect(typeof r.seedPaymentMist).toBe('bigint');
		expect(r.seedPaymentMist).toBe(500_000_000n);
	});

	it('honors a user-supplied seedPaymentMist override', () => {
		const r = resolveLocalClusterOptions({ seedPaymentMist: 1_000_000_000n });
		expect(r.seedPaymentMist).toBe(1_000_000_000n);
	});

	it('records seedAccountCount=0 when seedAccounts is omitted', () => {
		const r = resolveLocalClusterOptions({});
		expect(r.seedAccountCount).toBe(0);
	});

	it('records seedAccountCount=0 when seedAccounts is an empty array', () => {
		const r = resolveLocalClusterOptions({ seedAccounts: [] });
		expect(r.seedAccountCount).toBe(0);
	});

	it('records the length of the supplied seedAccounts tuple', () => {
		// The member tuple is opaque at this level — `resolveLocalClusterOptions`
		// only counts. The barrel resolves each member via `ctx.use(...)`.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const fakeMembers: any = [
			{ provides: { id: 'account/alice' } },
			{ provides: { id: 'account/bob' } },
			{ provides: { id: 'account/carol' } },
		];
		const r = resolveLocalClusterOptions({ seedAccounts: fakeMembers });
		expect(r.seedAccountCount).toBe(3);
	});
});
