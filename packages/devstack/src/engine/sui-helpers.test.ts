// Unit coverage for the small object-change picker. Pure function so
// no `it.effect` — plain `it` keeps the diagnostic surface readable
// when a match heuristic regresses.

import { describe, expect, it } from '@effect/vitest';
import type { SuiObjectChange } from './shared.js';
import { parseCoinTypeFromGeneric, pickCreatedByType } from './sui-helpers.js';

const created = (objectId: string, objectType: string, owner?: string): SuiObjectChange =>
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
		expect(pickCreatedByType(changes, { prefix: '0x2::coin::TreasuryCap<', all: true })).toEqual(
			[],
		);
	});

	it('prefix filter matches gRPC-normalized long-form addresses', () => {
		// gRPC normalizes the outer address segment to the 64-zero-padded
		// long form (`0x0000…0002`); user-authored prefixes still use the
		// short form (`0x2::coin::TreasuryCap<`). The matcher
		// canonicalizes the address bytes so both transports' object-type
		// shapes match the same prefix constant. Regression test for the
		// "pkg.coins = {}" diagnostic — without this canonicalization
		// every gRPC-mediated publish discovers zero coins.
		const changes = [
			created(
				'0xtcap',
				'0x0000000000000000000000000000000000000000000000000000000000000002::coin::TreasuryCap<0xabc::mock_usdc::MOCK_USDC>',
				'0xpublisher',
			),
		];
		expect(pickCreatedByType(changes, { prefix: '0x2::coin::TreasuryCap<' })).toBe('0xtcap');
		expect(pickCreatedByType(changes, { prefix: '0x2::coin::TreasuryCap<', all: true })).toEqual([
			{
				objectId: '0xtcap',
				objectType:
					'0x0000000000000000000000000000000000000000000000000000000000000002::coin::TreasuryCap<0xabc::mock_usdc::MOCK_USDC>',
				owner: '0xpublisher',
			},
		]);
	});

	it('suffix filter matches gRPC-normalized full Move types', () => {
		// `${packageId}::pool::Pool<0x2::sui::SUI, 0xPKG::mock::MOCK>` is
		// the canonical example: callers (deepbook local-deploy) build
		// the suffix from a freshly-known packageId + the bare coin
		// types they have on hand, both in short form. gRPC returns the
		// full long-form for every address in the type. `suffix`
		// canonicalizes via `normalizeStructTag` so the two halves meet
		// in the middle.
		const longBase =
			'0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
		const longQuote =
			'0x0000000000000000000000000000000000000000000000000000000000000abc::mock_usdc::MOCK_USDC';
		const longPool = `0x0000000000000000000000000000000000000000000000000000000000000def::pool::Pool<${longBase}, ${longQuote}>`;
		const shortSuffix = '0xdef::pool::Pool<0x2::sui::SUI, 0xabc::mock_usdc::MOCK_USDC>';
		const changes = [created('0xpool', longPool)];
		expect(pickCreatedByType(changes, { suffix: shortSuffix })).toBe('0xpool');
	});

	it('includes filter matches gRPC-normalized inner generic', () => {
		// `mintFromTreasury` uses `pickCreatedByType(..., {includes:
		// '0x2::coin::Coin<${fullCoinType}>'})` to find the minted Coin
		// object. gRPC returns `0x0000…0002::coin::Coin<...>`, so the
		// matcher must canonicalize via `normalizeStructTag` to
		// recognize the equivalence.
		const longCoin =
			'0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<0x0000000000000000000000000000000000000000000000000000000000000abc::mock_usdc::MOCK_USDC>';
		const shortIncludes = '0x2::coin::Coin<0xabc::mock_usdc::MOCK_USDC>';
		const changes = [created('0xcoin', longCoin, '0xrecipient')];
		expect(pickCreatedByType(changes, { includes: shortIncludes })).toBe('0xcoin');
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
			parseCoinTypeFromGeneric('0x2::coin::TreasuryCap<0x0::sui::SUI>', '0x2::coin::TreasuryCap'),
		).toBe('0x0::sui::SUI');
		expect(
			parseCoinTypeFromGeneric(
				'0x2::coin::TreasuryCap<0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI>',
				'0x2::coin::TreasuryCap',
			),
		).toBe('0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI');
	});

	it('matches gRPC-normalized outer address (`0x000…0002` vs `0x2`)', () => {
		// gRPC normalizes every address in the `objectType` returned by
		// `executeTransaction`/`getTransaction` to the 64-zero-padded
		// long form. JSON-RPC and user-authored wrapper constants use
		// the short form. The matcher canonicalizes both sides so the
		// publish-discovery pass works regardless of which transport
		// the publish receipt came back through. This is the regression
		// test for the "pkg.coins = {}" diagnostic.
		expect(
			parseCoinTypeFromGeneric(
				'0x0000000000000000000000000000000000000000000000000000000000000002::coin::TreasuryCap<0xabc::mock_usdc::MOCK_USDC>',
				'0x2::coin::TreasuryCap',
			),
		).toBe('0xabc::mock_usdc::MOCK_USDC');
		expect(
			parseCoinTypeFromGeneric(
				'0x0000000000000000000000000000000000000000000000000000000000000002::coin::CoinMetadata<0x0000000000000000000000000000000000000000000000000000000000000abc::mock_usdc::MOCK_USDC>',
				'0x2::coin::CoinMetadata',
			),
		).toBe('0x0000000000000000000000000000000000000000000000000000000000000abc::mock_usdc::MOCK_USDC');
	});

	it('returns undefined for wrong wrapper', () => {
		expect(
			parseCoinTypeFromGeneric('0x2::coin::CoinMetadata<0xabc::mod::T>', '0x2::coin::TreasuryCap'),
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
			parseCoinTypeFromGeneric('0x2::coin::TreasuryCap<0xabc::mod::T', '0x2::coin::TreasuryCap'),
		).toBeUndefined();
		expect(
			// missing opening `<` — falls past the wrapper-head check
			parseCoinTypeFromGeneric('0x2::coin::TreasuryCap0xabc::mod::T>', '0x2::coin::TreasuryCap'),
		).toBeUndefined();
	});
});
