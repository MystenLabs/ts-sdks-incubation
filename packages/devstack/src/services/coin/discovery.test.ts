// Unit coverage for `discoverCoinsFromPublish`. Pure function over a
// synthesized `objectChanges` array — no Effect, no `it.effect` needed.
// Fixture mirrors what a real `examples/wallet/move/mock_usdc` publish
// receipt produces (UpgradeCap + TreasuryCap + CoinMetadata), with the
// addresses + object ids replaced by deterministic test values.

import { describe, expect, it } from 'vitest';
import type { SuiObjectChange } from '../../engine/shared.js';
import { discoverCoinsFromPublish } from './discovery.js';

// Test fixtures use hex-valid addresses (the COIN_TYPE_RE regex in
// sui-helpers.ts rejects non-hex characters in the address slot —
// fixtures with `0xpkgusdc...` etc. would parse as malformed). All chars
// here are in `[0-9a-f]`.
const PUBLISHER = '0xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
const OTHER_OWNER = '0xa110ce5511445566778899aabbccddeeff00112233445566778899aabbccddee';

const MOCK_USDC_TYPE =
	'0xabc1111111111111111111111111111111111111111111111111111111111111::mock_usdc::MOCK_USDC';
const MOCK_WETH_TYPE =
	'0xdeff111111111111111111111111111111111111111111111111111111111111::mock_weth::MOCK_WETH';

const created = (objectId: string, objectType: string, owner?: string): SuiObjectChange => ({
	type: 'created',
	objectId,
	objectType,
	...(owner !== undefined ? { owner } : {}),
});

const published = (packageId: string): SuiObjectChange => ({
	type: 'published',
	packageId,
});

describe('discoverCoinsFromPublish', () => {
	it('finds a single coin from a publish receipt with TreasuryCap + CoinMetadata', () => {
		const changes = [
			published('0xpkgusdc'),
			created('0xupgrade', '0x2::package::UpgradeCap', PUBLISHER),
			created('0xtcap', `0x2::coin::TreasuryCap<${MOCK_USDC_TYPE}>`, PUBLISHER),
			created('0xmeta', `0x2::coin::CoinMetadata<${MOCK_USDC_TYPE}>`),
		];
		const out = discoverCoinsFromPublish(changes, PUBLISHER);
		expect(out).toHaveLength(1);
		expect(out[0]).toEqual({
			coinType: MOCK_USDC_TYPE,
			moduleName: 'mock_usdc',
			witnessName: 'MOCK_USDC',
			treasuryCapId: '0xtcap',
			treasuryCapOwner: PUBLISHER,
			metadataId: '0xmeta',
			publisherOwnsCap: true,
		});
	});

	it('finds two coins from a single publish (multi-currency module)', () => {
		const changes = [
			published('0xpkg'),
			created('0xupgrade', '0x2::package::UpgradeCap', PUBLISHER),
			created('0xtcap1', `0x2::coin::TreasuryCap<${MOCK_USDC_TYPE}>`, PUBLISHER),
			created('0xmeta1', `0x2::coin::CoinMetadata<${MOCK_USDC_TYPE}>`),
			created('0xtcap2', `0x2::coin::TreasuryCap<${MOCK_WETH_TYPE}>`, PUBLISHER),
			created('0xmeta2', `0x2::coin::CoinMetadata<${MOCK_WETH_TYPE}>`),
		];
		const out = discoverCoinsFromPublish(changes, PUBLISHER);
		expect(out).toHaveLength(2);
		// Stable sort by coinType — `0xpkgusdc...` < `0xpkgweth...`
		expect(out[0]?.coinType).toBe(MOCK_USDC_TYPE);
		expect(out[1]?.coinType).toBe(MOCK_WETH_TYPE);
		expect(out[0]?.treasuryCapId).toBe('0xtcap1');
		expect(out[1]?.treasuryCapId).toBe('0xtcap2');
		expect(out.every((c) => c.publisherOwnsCap)).toBe(true);
	});

	it('flags publisherOwnsCap=false when the cap was transferred to another owner', () => {
		const changes = [
			published('0xpkg'),
			created('0xtcap', `0x2::coin::TreasuryCap<${MOCK_USDC_TYPE}>`, OTHER_OWNER),
			created('0xmeta', `0x2::coin::CoinMetadata<${MOCK_USDC_TYPE}>`),
		];
		const out = discoverCoinsFromPublish(changes, PUBLISHER);
		expect(out).toHaveLength(1);
		expect(out[0]?.publisherOwnsCap).toBe(false);
		expect(out[0]?.treasuryCapOwner).toBe(OTHER_OWNER);
	});

	it('flags publisherOwnsCap=false when the cap has no address-owner (shared/object owner)', () => {
		const changes = [
			published('0xpkg'),
			// Shared cap — no `owner` field on the SuiObjectChange projection
			// (the devstack projection only surfaces AddressOwner).
			created('0xtcap', `0x2::coin::TreasuryCap<${MOCK_USDC_TYPE}>`),
			created('0xmeta', `0x2::coin::CoinMetadata<${MOCK_USDC_TYPE}>`),
		];
		const out = discoverCoinsFromPublish(changes, PUBLISHER);
		expect(out).toHaveLength(1);
		expect(out[0]?.publisherOwnsCap).toBe(false);
		expect(out[0]?.treasuryCapOwner).toBeUndefined();
		expect(out[0]?.treasuryCapId).toBe('0xtcap');
	});

	it('surfaces a coin with only a TreasuryCap (custom init, no CoinMetadata)', () => {
		// A coin module that emits a cap but bypasses `coin::create_currency`
		// won't have a `CoinMetadata` object. Discovery should still
		// record the coin so downstream consumers can see it (and degrade
		// gracefully — `decimals`/`symbol` come from a separate RPC).
		const changes = [
			published('0xpkg'),
			created('0xtcap', `0x2::coin::TreasuryCap<${MOCK_USDC_TYPE}>`, PUBLISHER),
		];
		const out = discoverCoinsFromPublish(changes, PUBLISHER);
		expect(out).toHaveLength(1);
		expect(out[0]?.coinType).toBe(MOCK_USDC_TYPE);
		expect(out[0]?.treasuryCapId).toBe('0xtcap');
		expect(out[0]?.metadataId).toBeUndefined();
		expect(out[0]?.publisherOwnsCap).toBe(true);
	});

	it('surfaces a coin with only a CoinMetadata (very unusual, but valid)', () => {
		const changes = [
			published('0xpkg'),
			created('0xmeta', `0x2::coin::CoinMetadata<${MOCK_USDC_TYPE}>`),
		];
		const out = discoverCoinsFromPublish(changes, PUBLISHER);
		expect(out).toHaveLength(1);
		expect(out[0]?.coinType).toBe(MOCK_USDC_TYPE);
		expect(out[0]?.metadataId).toBe('0xmeta');
		expect(out[0]?.treasuryCapId).toBeUndefined();
		expect(out[0]?.publisherOwnsCap).toBe(false);
	});

	it('ignores non-coin objects (UpgradeCap, generic mutated changes)', () => {
		const changes = [
			published('0xpkg'),
			created('0xupgrade', '0x2::package::UpgradeCap', PUBLISHER),
			created('0xrandom', '0xfoo::game::Lobby', PUBLISHER),
		];
		const out = discoverCoinsFromPublish(changes, PUBLISHER);
		expect(out).toEqual([]);
	});

	it('ignores TreasuryCap with nested generics (refuses to guess)', () => {
		const changes = [
			published('0xpkg'),
			created('0xexotic', '0x2::coin::TreasuryCap<0xfoo::a::A<0xbar::b::B>>', PUBLISHER),
		];
		const out = discoverCoinsFromPublish(changes, PUBLISHER);
		expect(out).toEqual([]);
	});

	it('returns empty for a publish that created no coins', () => {
		const changes = [
			published('0xpkg'),
			created('0xupgrade', '0x2::package::UpgradeCap', PUBLISHER),
		];
		expect(discoverCoinsFromPublish(changes, PUBLISHER)).toEqual([]);
	});
});
