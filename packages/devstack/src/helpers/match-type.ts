// Test whether a Sui object's `objectType` matches a user-declared
// `capture` filter. Shared by `publishMovePackage` and
// `seedSharedObject` so both helpers obey the same rule.
//
// `endsWith` when the filter doesn't contain `<` (so `::registry::Registry`
// matches `<pkg>::registry::Registry` but NOT
// `0x2::dynamic_field::Field<u64, <pkg>::registry::RegistryInner>`), and
// `includes` when the filter contains `<` (so `::coin::TreasuryCap<` matches
// `0x2::coin::TreasuryCap<<pkg>::mock_usdc::MOCK_USDC>`).

export function objectTypeMatchesFilter(typeStr: string, filter: string): boolean {
	if (filter.includes('<')) return typeStr.includes(filter);
	return typeStr.endsWith(filter);
}
