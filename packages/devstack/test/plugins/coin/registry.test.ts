// Coin plugin — CoinRegistry tests.
//
// Covers the L2 `CoinRegistry` and its self-contained last-write-wins
// `CoinKey -> CoinRecord` backing (formerly the substrate
// `defineScopedRefMap` single mode, strangled into the plugin):
// register, lookup-by-witness (package-scoped), lookup-by-type
// (exact full-coin-type), list, LWW + one-entry-per-key + insertion
// order across many writes, and scope-bound lifecycle (each Layer
// build materializes an independent registry).

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import {
	CoinRegistryService,
	layerCoinRegistry,
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
		}).pipe(Effect.provide(layerCoinRegistry)),
	);

	it.effect('byType returns null for unknown coin', () =>
		Effect.gen(function* () {
			const registry = yield* CoinRegistryService;
			const found = yield* registry.byType('0xnope::foo::FOO');
			expect(found).toBeNull();
		}).pipe(Effect.provide(layerCoinRegistry)),
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
		}).pipe(Effect.provide(layerCoinRegistry)),
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
		}).pipe(Effect.provide(layerCoinRegistry)),
	);

	it.effect('list returns every registered record', () =>
		Effect.gen(function* () {
			const registry = yield* CoinRegistryService;
			yield* registry.register(makeRecord({ type: '0xabc::a::A' }));
			yield* registry.register(makeRecord({ type: '0xabc::b::B' }));
			yield* registry.register(makeRecord({ type: '0xabc::c::C' }));
			const all = yield* registry.list();
			expect(all.map((r) => r.type).sort()).toEqual(['0xabc::a::A', '0xabc::b::B', '0xabc::c::C']);
		}).pipe(Effect.provide(layerCoinRegistry)),
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
		}).pipe(Effect.provide(layerCoinRegistry)),
	);

	// Migrated from the substrate single-mode suite (`setSingleEntry` /
	// "repeated set keeps LWW + insertion order across many writes"):
	// re-registering a key must keep exactly one entry for it (no history
	// leak) AND advance its position to the END of `list` (its seq
	// overtook the sibling registered after it).
	it.effect('re-register keeps one entry per key and re-sorts it to the end of list', () =>
		Effect.gen(function* () {
			const registry = yield* CoinRegistryService;
			yield* registry.register(makeRecord({ type: '0xabc::x::X', decimals: 0 }));
			yield* registry.register(makeRecord({ type: '0xabc::y::Y', decimals: 0 }));
			// Hammer 'x' 50 times — the backing store must stay at one entry
			// per key, and the final list orders by latest seq: y, then x.
			for (let i = 1; i <= 50; i++) {
				yield* registry.register(makeRecord({ type: '0xabc::x::X', decimals: i }));
			}
			const all = yield* registry.list();
			expect(all).toHaveLength(2);
			expect(all.map((r) => r.type)).toEqual(['0xabc::y::Y', '0xabc::x::X']);
			expect(all[1]?.decimals).toBe(50);
		}).pipe(Effect.provide(layerCoinRegistry)),
	);

	it.effect('scope-bound lifecycle — independent scopes do not share state', () => {
		const runInFreshScope = (record: CoinRecord) =>
			Effect.gen(function* () {
				const registry = yield* CoinRegistryService;
				yield* registry.register(record);
				return yield* registry.list();
			}).pipe(Effect.provide(layerCoinRegistry));

		return Effect.gen(function* () {
			const first = yield* runInFreshScope(makeRecord({ type: '0xabc::a::A', decimals: 1 }));
			const second = yield* runInFreshScope(makeRecord({ type: '0xdef::b::B', decimals: 2 }));
			expect(first.map((r) => r.type)).toEqual(['0xabc::a::A']);
			expect(second.map((r) => r.type)).toEqual(['0xdef::b::B']);
		});
	});
});
