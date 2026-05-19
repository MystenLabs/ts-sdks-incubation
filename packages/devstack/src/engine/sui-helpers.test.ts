// Unit coverage for the small object-change picker. Pure function so
// no `it.effect` — plain `it` keeps the diagnostic surface readable
// when a match heuristic regresses.

import { describe, expect, it } from '@effect/vitest';
import type { SuiObjectChange } from './shared.js';
import { parseCoinTypeFromGeneric, pickCreatedByType } from './sui-helpers.js';

const created = (
	objectId: string,
	objectType: string,
	owner?: string,
): SuiObjectChange =>
	({
		type: 'created',
		objectId,
		objectType,
		...(owner !== undefined ? { owner } : {}),
	}) as SuiObjectChange;

const mutated = (objectId: string, objectType: string): SuiObjectChange =>
	({
		type: 'mutated',
		objectId,
		objectType,
	}) as SuiObjectChange;

describe('pickCreatedByType — suffix filter', () => {
	it('returns the objectId of the first created change matching the suffix', () => {
		const changes = [
			created('0xother', '0x2::package::UpgradeCap'),
			created('0xlobby', '0xabc::game::Lobby'),
		];
		expect(pickCreatedByType(changes, { suffix: '::game::Lobby' })).toBe('0xlobby');
	});

	it('returns undefined when no created change matches', () => {
		const changes = [created('0xother', '0x2::package::UpgradeCap')];
		expect(pickCreatedByType(changes, { suffix: '::game::Lobby' })).toBeUndefined();
	});

	it('ignores mutated changes even when their type matches', () => {
		// `created` is what publish/seed flows care about; mutated objects
		// already existed pre-tx and would be a footgun if returned.
		const changes = [mutated('0xexisting', '0xabc::game::Lobby')];
		expect(pickCreatedByType(changes, { suffix: '::game::Lobby' })).toBeUndefined();
	});
});

describe('pickCreatedByType — includes filter', () => {
	it('matches generic types via substring (e.g. TreasuryCap<...>)', () => {
		const changes = [created('0xtcap', '0x2::coin::TreasuryCap<0xabc::mock_usdc::MOCK_USDC>')];
		expect(pickCreatedByType(changes, { includes: '::coin::TreasuryCap<' })).toBe('0xtcap');
	});

	it('returns undefined on miss', () => {
		const changes = [created('0xother', '0xabc::game::Lobby')];
		expect(pickCreatedByType(changes, { includes: '::coin::TreasuryCap<' })).toBeUndefined();
	});
});

describe('pickCreatedByType — prefix filter (first match)', () => {
	it('matches by startsWith', () => {
		const changes = [
			created('0xother', '0x2::package::UpgradeCap'),
			created('0xtcap', '0x2::coin::TreasuryCap<0xabc::mock_usdc::MOCK_USDC>'),
		];
		expect(pickCreatedByType(changes, { prefix: '0x2::coin::TreasuryCap<' })).toBe('0xtcap');
	});
});

describe('pickCreatedByType — prefix filter (all: true)', () => {
	it('returns every created entry matching the prefix, preserving owner', () => {
		const changes = [
			created('0xtcap1', '0x2::coin::TreasuryCap<0xabc::mock_usdc::MOCK_USDC>', '0xpublisher'),
			created('0xtcap2', '0x2::coin::TreasuryCap<0xdef::mock_weth::MOCK_WETH>', '0xpublisher'),
			created('0xupgrade', '0x2::package::UpgradeCap'),
			mutated('0xother', '0x2::coin::TreasuryCap<0xfoo::bar::BAR>'),
		];
		const out = pickCreatedByType(changes, {
			prefix: '0x2::coin::TreasuryCap<',
			all: true,
		});
		expect(out).toHaveLength(2);
		expect(out[0]?.objectId).toBe('0xtcap1');
		expect(out[0]?.owner).toBe('0xpublisher');
		expect(out[1]?.objectId).toBe('0xtcap2');
	});

	it('omits owner when the created entry has no address-owner (e.g. shared cap)', () => {
		const changes = [
			created('0xshared', '0x2::coin::TreasuryCap<0xabc::mod::T>'), // no owner
		];
		const out = pickCreatedByType(changes, {
			prefix: '0x2::coin::TreasuryCap<',
			all: true,
		});
		expect(out).toHaveLength(1);
		expect(out[0]?.objectId).toBe('0xshared');
		expect(out[0]?.owner).toBeUndefined();
	});

	it('returns empty array on no match', () => {
		const changes = [created('0xfoo', '0xabc::game::Lobby')];
		expect(
			pickCreatedByType(changes, { prefix: '0x2::coin::TreasuryCap<', all: true }),
		).toEqual([]);
	});
});

describe('parseCoinTypeFromGeneric', () => {
	it('extracts the inner coin type from a well-formed TreasuryCap', () => {
		expect(
			parseCoinTypeFromGeneric(
				'0x2::coin::TreasuryCap<0xabc::mock_usdc::MOCK_USDC>',
				'0x2::coin::TreasuryCap',
			),
		).toBe('0xabc::mock_usdc::MOCK_USDC');
	});

	it('extracts the inner coin type from a well-formed CoinMetadata', () => {
		expect(
			parseCoinTypeFromGeneric(
				'0x2::coin::CoinMetadata<0xdef::mock_weth::MOCK_WETH>',
				'0x2::coin::CoinMetadata',
			),
		).toBe('0xdef::mock_weth::MOCK_WETH');
	});

	it('handles leading-zero addresses', () => {
		expect(
			parseCoinTypeFromGeneric(
				'0x2::coin::TreasuryCap<0x0::sui::SUI>',
				'0x2::coin::TreasuryCap',
			),
		).toBe('0x0::sui::SUI');
		expect(
			parseCoinTypeFromGeneric(
				'0x2::coin::TreasuryCap<0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI>',
				'0x2::coin::TreasuryCap',
			),
		).toBe(
			'0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
		);
	});

	it('returns undefined for wrong wrapper', () => {
		expect(
			parseCoinTypeFromGeneric(
				'0x2::coin::CoinMetadata<0xabc::mod::T>',
				'0x2::coin::TreasuryCap',
			),
		).toBeUndefined();
	});

	it('returns undefined for a non-wrapper type', () => {
		expect(
			parseCoinTypeFromGeneric('0x2::package::UpgradeCap', '0x2::coin::TreasuryCap'),
		).toBeUndefined();
	});

	it('returns undefined for nested generics', () => {
		// `0x2::coin::TreasuryCap<0x...::a::A<0x...::b::B>>` — we refuse
		// to guess what the caller meant.
		expect(
			parseCoinTypeFromGeneric(
				'0x2::coin::TreasuryCap<0xabc::a::A<0xdef::b::B>>',
				'0x2::coin::TreasuryCap',
			),
		).toBeUndefined();
	});

	it('returns undefined when the inner is malformed', () => {
		expect(
			parseCoinTypeFromGeneric('0x2::coin::TreasuryCap<not a type>', '0x2::coin::TreasuryCap'),
		).toBeUndefined();
		expect(
			parseCoinTypeFromGeneric('0x2::coin::TreasuryCap<>', '0x2::coin::TreasuryCap'),
		).toBeUndefined();
		expect(
			// missing closing `>`
			parseCoinTypeFromGeneric(
				'0x2::coin::TreasuryCap<0xabc::mod::T',
				'0x2::coin::TreasuryCap',
			),
		).toBeUndefined();
		expect(
			// missing opening `<` — falls past the wrapper-head check
			parseCoinTypeFromGeneric(
				'0x2::coin::TreasuryCap0xabc::mod::T>',
				'0x2::coin::TreasuryCap',
			),
		).toBeUndefined();
	});
});
