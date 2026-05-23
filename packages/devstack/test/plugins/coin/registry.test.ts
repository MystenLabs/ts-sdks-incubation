// Coin plugin — CoinRegistry tests.
//
// Covers the L2 `CoinRegistry` wrapper that sits on top of the
// generic `ScopedRefMap<CoinKey, CoinRecord>` substrate primitive:
// register, lookup-by-symbol (case-insensitive), lookup-by-witness
// (package-scoped), lookup-by-type (exact full-coin-type), list, and
// scope-bound lifecycle (each Layer build materializes an
// independent registry).

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import {
	CoinRegistryService,
	coinRegistryLayer,
	type CoinRecord,
} from '../../../src/plugins/coin/registry.ts';

const makeRecord = (overrides: Partial<CoinRecord> & Pick<CoinRecord, 'type'>): CoinRecord => ({
	key: overrides.witness ?? 'witness',
	witness: 'witness',
	moduleName: 'module',
	decimals: 0,
	packageId: '0xpkg',
	publishingPackageName: 'pkg',
	...overrides,
});

describe('plugins/coin/registry', () => {
	it.effect('register + byType round-trips', () =>
		Effect.gen(function* () {
			const registry = yield* CoinRegistryService;
			const record = makeRecord({
				type: '0xabc::usdc::USDC',
				key: 'usdc',
				witness: 'usdc',
				moduleName: 'usdc',
				symbol: 'USDC',
				decimals: 6,
			});
			yield* registry.register(record);
			const found = yield* registry.byType('0xabc::usdc::USDC');
			expect(found).not.toBeNull();
			expect(found?.symbol).toBe('USDC');
			expect(found?.decimals).toBe(6);
		}).pipe(Effect.provide(coinRegistryLayer)),
	);

	it.effect('byType returns null for unknown coin', () =>
		Effect.gen(function* () {
			const registry = yield* CoinRegistryService;
			const found = yield* registry.byType('0xnope::foo::FOO');
			expect(found).toBeNull();
		}).pipe(Effect.provide(coinRegistryLayer)),
	);

	it.effect('bySymbol finds matches case-insensitively', () =>
		Effect.gen(function* () {
			const registry = yield* CoinRegistryService;
			yield* registry.register(
				makeRecord({
					type: '0xabc::usdc::USDC',
					key: 'usdc',
					witness: 'usdc',
					moduleName: 'usdc',
					symbol: 'USDC',
				}),
			);
			yield* registry.register(
				makeRecord({
					type: '0xdef::weth::WETH',
					key: 'weth',
					witness: 'weth',
					moduleName: 'weth',
					symbol: 'WETH',
				}),
			);
			const upper = yield* registry.bySymbol('USDC');
			const lower = yield* registry.bySymbol('usdc');
			const mixed = yield* registry.bySymbol('UsDc');
			expect(upper.map((r) => r.type)).toEqual(['0xabc::usdc::USDC']);
			expect(lower.map((r) => r.type)).toEqual(['0xabc::usdc::USDC']);
			expect(mixed.map((r) => r.type)).toEqual(['0xabc::usdc::USDC']);
		}).pipe(Effect.provide(coinRegistryLayer)),
	);

	it.effect('bySymbol matches either the registry key or the display symbol', () =>
		Effect.gen(function* () {
			const registry = yield* CoinRegistryService;
			// Two records: one indexed by witness (`mock_usdc`), one by a
			// distinct display symbol (`MOCK_USDC`). bySymbol must find
			// the record under either form.
			yield* registry.register(
				makeRecord({
					type: '0xabc::mock_usdc::MOCK_USDC',
					key: 'mock_usdc',
					witness: 'mock_usdc',
					moduleName: 'mock_usdc',
					symbol: 'MOCK_USDC',
				}),
			);
			const byWitness = yield* registry.bySymbol('mock_usdc');
			const bySymbolForm = yield* registry.bySymbol('mock_usdc');
			expect(byWitness.map((r) => r.type)).toEqual(['0xabc::mock_usdc::MOCK_USDC']);
			expect(bySymbolForm.map((r) => r.type)).toEqual(['0xabc::mock_usdc::MOCK_USDC']);
		}).pipe(Effect.provide(coinRegistryLayer)),
	);

	it.effect('bySymbol returns empty when no record matches', () =>
		Effect.gen(function* () {
			const registry = yield* CoinRegistryService;
			yield* registry.register(
				makeRecord({
					type: '0xabc::usdc::USDC',
					key: 'usdc',
					witness: 'usdc',
					symbol: 'USDC',
				}),
			);
			const none = yield* registry.bySymbol('ghost');
			expect(none).toEqual([]);
		}).pipe(Effect.provide(coinRegistryLayer)),
	);

	it.effect('byWitness scopes the lookup by publishing package', () =>
		Effect.gen(function* () {
			const registry = yield* CoinRegistryService;
			yield* registry.register(
				makeRecord({
					type: '0xabc::mock_usdc::MOCK_USDC',
					key: 'mock_usdc',
					witness: 'mock_usdc',
					moduleName: 'mock_usdc',
					publishingPackageName: 'mock_usdc',
					packageId: '0xabc',
				}),
			);
			yield* registry.register(
				makeRecord({
					type: '0xdef::other_usdc::MOCK_USDC',
					key: 'mock_usdc',
					witness: 'mock_usdc',
					moduleName: 'other_usdc',
					publishingPackageName: 'other_usdc',
					packageId: '0xdef',
				}),
			);
			const inMockUsdc = yield* registry.byWitness('mock_usdc', 'MOCK_USDC');
			const inOther = yield* registry.byWitness('other_usdc', 'MOCK_USDC');
			expect(inMockUsdc?.type).toBe('0xabc::mock_usdc::MOCK_USDC');
			expect(inOther?.type).toBe('0xdef::other_usdc::MOCK_USDC');
		}).pipe(Effect.provide(coinRegistryLayer)),
	);

	it.effect('byWitness returns null when the witness is absent in the package', () =>
		Effect.gen(function* () {
			const registry = yield* CoinRegistryService;
			yield* registry.register(
				makeRecord({
					type: '0xabc::mock_usdc::MOCK_USDC',
					witness: 'mock_usdc',
					publishingPackageName: 'mock_usdc',
				}),
			);
			const miss = yield* registry.byWitness('mock_usdc', 'NOT_THERE');
			const wrongPkg = yield* registry.byWitness('elsewhere', 'MOCK_USDC');
			expect(miss).toBeNull();
			expect(wrongPkg).toBeNull();
		}).pipe(Effect.provide(coinRegistryLayer)),
	);

	it.effect('list returns every registered record', () =>
		Effect.gen(function* () {
			const registry = yield* CoinRegistryService;
			yield* registry.register(makeRecord({ type: '0xabc::a::A' }));
			yield* registry.register(makeRecord({ type: '0xabc::b::B' }));
			yield* registry.register(makeRecord({ type: '0xabc::c::C' }));
			const all = yield* registry.list();
			expect(all.map((r) => r.type).sort()).toEqual(['0xabc::a::A', '0xabc::b::B', '0xabc::c::C']);
		}).pipe(Effect.provide(coinRegistryLayer)),
	);

	it.effect('register is last-write-wins on fullCoinType', () =>
		Effect.gen(function* () {
			const registry = yield* CoinRegistryService;
			yield* registry.register(
				makeRecord({
					type: '0xabc::usdc::USDC',
					decimals: 0,
					symbol: 'USDC',
				}),
			);
			yield* registry.register(
				makeRecord({
					type: '0xabc::usdc::USDC',
					decimals: 6,
					symbol: 'USDC-v2',
				}),
			);
			const all = yield* registry.list();
			expect(all).toHaveLength(1);
			expect(all[0]?.decimals).toBe(6);
			expect(all[0]?.symbol).toBe('USDC-v2');
		}).pipe(Effect.provide(coinRegistryLayer)),
	);

	it.effect('scope-bound lifecycle — independent scopes do not share state', () => {
		const runInFreshScope = (record: CoinRecord) =>
			Effect.gen(function* () {
				const registry = yield* CoinRegistryService;
				yield* registry.register(record);
				return yield* registry.list();
			}).pipe(Effect.provide(coinRegistryLayer));

		return Effect.gen(function* () {
			const first = yield* runInFreshScope(makeRecord({ type: '0xabc::a::A', decimals: 1 }));
			const second = yield* runInFreshScope(makeRecord({ type: '0xdef::b::B', decimals: 2 }));
			expect(first.map((r) => r.type)).toEqual(['0xabc::a::A']);
			expect(second.map((r) => r.type)).toEqual(['0xdef::b::B']);
		});
	});
});
