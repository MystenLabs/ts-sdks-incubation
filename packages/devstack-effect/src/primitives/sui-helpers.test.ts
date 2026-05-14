// Unit coverage for the small object-change pickers. These are pure
// functions, so no `it.effect` — plain `it` keeps the diagnostic surface
// readable when a match heuristic regresses.

import { describe, expect, it } from '@effect/vitest';
import type { SuiObjectChange } from './shared.js';
import { pickCreatedByTypeIncludes, pickCreatedByTypeSuffix } from './sui-helpers.js';

const created = (objectId: string, objectType: string): SuiObjectChange =>
	({
		type: 'created',
		sender: '0xsender',
		owner: { AddressOwner: '0xowner' },
		objectType,
		objectId,
		version: '1',
		digest: 'digest',
	}) as unknown as SuiObjectChange;

const mutated = (objectId: string, objectType: string): SuiObjectChange =>
	({
		type: 'mutated',
		sender: '0xsender',
		owner: { AddressOwner: '0xowner' },
		objectType,
		objectId,
		version: '2',
		previousVersion: '1',
		digest: 'digest',
	}) as unknown as SuiObjectChange;

describe('pickCreatedByTypeSuffix', () => {
	it('returns the objectId of the first created change matching the suffix', () => {
		const changes = [
			created('0xother', '0x2::package::UpgradeCap'),
			created('0xlobby', '0xabc::game::Lobby'),
		];
		expect(pickCreatedByTypeSuffix(changes, '::game::Lobby')).toBe('0xlobby');
	});

	it('returns undefined when no created change matches', () => {
		const changes = [created('0xother', '0x2::package::UpgradeCap')];
		expect(pickCreatedByTypeSuffix(changes, '::game::Lobby')).toBeUndefined();
	});

	it('ignores mutated changes even when their type matches', () => {
		// `created` is what publish/seed flows care about; mutated objects
		// already existed pre-tx and would be a footgun if returned.
		const changes = [mutated('0xexisting', '0xabc::game::Lobby')];
		expect(pickCreatedByTypeSuffix(changes, '::game::Lobby')).toBeUndefined();
	});
});

describe('pickCreatedByTypeIncludes', () => {
	it('matches generic types via substring (e.g. TreasuryCap<...>)', () => {
		const changes = [
			created('0xtcap', '0x2::coin::TreasuryCap<0xabc::mock_usdc::MOCK_USDC>'),
		];
		expect(pickCreatedByTypeIncludes(changes, '::coin::TreasuryCap<')).toBe('0xtcap');
	});

	it('returns undefined on miss', () => {
		const changes = [created('0xother', '0xabc::game::Lobby')];
		expect(pickCreatedByTypeIncludes(changes, '::coin::TreasuryCap<')).toBeUndefined();
	});
});
