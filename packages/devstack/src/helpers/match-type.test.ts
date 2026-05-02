import { describe, expect, it } from 'vitest';

import { objectTypeMatchesFilter } from './match-type.js';

// `objectTypeMatchesFilter` is the shared rule used by `publishMovePackage`
// (and `seedSharedObject`, `importedPackage`) to map a user-declared
// `capture: { manifestKey: '<filter>' }` against the `objectType` strings the
// chain returns in `objectChanges`. Two regimes:
//
//   - filter has no `<` → endsWith(typeStr, filter)
//   - filter contains `<` → includes(typeStr, filter)
//
// The split exists because TreasuryCap-style captures need angle-bracket
// wildcards (`::coin::TreasuryCap<` matches any phantom-T) but plain captures
// like `::registry::Registry` must NOT swallow `Field<u64, ::registry::Registry>`.

describe('objectTypeMatchesFilter — canonical capture cases used by Publish', () => {
	it('matches a TreasuryCap capture across the phantom-T boundary', () => {
		const filter = '0x2::coin::TreasuryCap<';
		const objectType = '0x2::coin::TreasuryCap<0xabc::mock_usdc::MOCK_USDC>';
		expect(objectTypeMatchesFilter(objectType, filter)).toBe(true);
	});

	it('matches CoinMetadata via the angle-bracket trigger', () => {
		const filter = '0x2::coin::CoinMetadata<';
		const objectType = '0x2::coin::CoinMetadata<0xabc::mock_usdc::MOCK_USDC>';
		expect(objectTypeMatchesFilter(objectType, filter)).toBe(true);
	});

	it('matches a plain UpgradeCap (no generics) via endsWith', () => {
		const filter = '0x2::package::UpgradeCap';
		const objectType = '0x2::package::UpgradeCap';
		expect(objectTypeMatchesFilter(objectType, filter)).toBe(true);
	});

	it('matches a Lobby-style generic via the partial-suffix endsWith form', () => {
		// Lobby/Registry/etc are usually captured by their `::pkg::Module::Type` tail.
		const filter = '::lobby::Lobby';
		const objectType = '0xdeadbeef::lobby::Lobby';
		expect(objectTypeMatchesFilter(objectType, filter)).toBe(true);
	});
});

describe('objectTypeMatchesFilter — angle-bracket wildcard semantics', () => {
	it('a filter ending in `<` switches from endsWith to includes', () => {
		// Both contain the prefix; only the includes form matches the second.
		const filter = '0x1::option::Option<';
		expect(objectTypeMatchesFilter('0x1::option::Option<u64>', filter)).toBe(true);
		expect(objectTypeMatchesFilter('0x1::option::Option<0x1::string::String>', filter)).toBe(true);
	});

	it('a filter containing `<` anywhere uses includes (not just trailing)', () => {
		// The rule is "filter contains `<`", not "filter ends with `<`".
		const filter = 'Option<u64>';
		expect(objectTypeMatchesFilter('0x1::option::Option<u64>', filter)).toBe(true);
	});

	it('endsWith filter does NOT match when the type has trailing generics', () => {
		// The whole point of the `<` trigger: a non-`<` filter is anchored at
		// the END of the type string, so it can't accidentally match a wrapped form.
		const filter = '::registry::Registry';
		const wrappedType = '0xabc::registry::Registry<u64>';
		expect(objectTypeMatchesFilter(wrappedType, filter)).toBe(false);
	});
});

describe('objectTypeMatchesFilter — dynamic-field anti-example (review-flagged)', () => {
	it('a plain `::registry::Registry` capture does NOT match a Field<_, Registry> wrapper', () => {
		// This is the case the architecture review specifically called out:
		// dynamic_field::Field can wrap a Registry inner type, and we must
		// NOT capture the Field as if it were the Registry itself.
		const filter = '::registry::Registry';
		const dynamicFieldType =
			'0x2::dynamic_field::Field<u64, 0xabc::registry::RegistryInner>';
		expect(objectTypeMatchesFilter(dynamicFieldType, filter)).toBe(false);
	});

	it('a plain `Field` capture does NOT match a `dynamic_field::Field<...>` instance', () => {
		// Inverse of the above: a user trying to capture "Field" with no `<`
		// should not silently match the generic dynamic_field wrapper.
		const filter = 'Field';
		const dynamicFieldType = '0x2::dynamic_field::Field<u64, u64>';
		expect(objectTypeMatchesFilter(dynamicFieldType, filter)).toBe(false);
	});

	it('an explicit `0x2::dynamic_field::Field<` capture DOES match (opt-in)', () => {
		// Once the user opts in with `<`, we want to match — that's how a
		// caller would actually capture a dynamic field by intent.
		const filter = '0x2::dynamic_field::Field<';
		const dynamicFieldType = '0x2::dynamic_field::Field<u64, 0xabc::registry::RegistryInner>';
		expect(objectTypeMatchesFilter(dynamicFieldType, filter)).toBe(true);
	});
});

describe('objectTypeMatchesFilter — non-matches', () => {
	it('returns false for unrelated types', () => {
		expect(objectTypeMatchesFilter('0x2::coin::Coin<u64>', '::registry::Registry')).toBe(false);
		expect(objectTypeMatchesFilter('0x2::coin::Coin<u64>', '0x2::package::UpgradeCap')).toBe(
			false,
		);
	});

	it('endsWith filter is anchored — leading-only match returns false', () => {
		// `0x2::coin::Coin` is a *prefix* of the type, not a suffix.
		const filter = '0x2::coin::Coin';
		const objectType = '0x2::coin::CoinMetadata';
		expect(objectTypeMatchesFilter(objectType, filter)).toBe(false);
	});
});
