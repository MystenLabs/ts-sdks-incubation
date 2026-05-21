import { describe, expect, it } from 'vitest';

import { pickCreatedByType } from '../../../src/plugins/package/index.ts';
import type { ActionObjectChange } from '../../../src/plugins/action/index.ts';
import type { PublishObjectChange } from '../../../src/plugins/package/index.ts';

describe('plugins/package — public capture helpers', () => {
	it('picks created publish objects by type suffix', () => {
		const changes: ReadonlyArray<PublishObjectChange> = [
			{ type: 'mutated', objectId: '0xmut', objectType: '0xpkg::board::Board' },
			{ type: 'created', objectId: '0xboard', objectType: '0xpkg::board::Board' },
		];

		expect(pickCreatedByType(changes, { suffix: '::board::Board' })).toBe('0xboard');
	});

	it('picks created action objects by type suffix', () => {
		const changes: ReadonlyArray<ActionObjectChange> = [
			{ kind: 'mutated', objectId: '0xmut', objectType: '0xpkg::game::Lobby' },
			{ kind: 'created', objectId: '0xlobby', objectType: '0xpkg::game::Lobby' },
		];

		expect(pickCreatedByType(changes, { suffix: '::game::Lobby' })).toBe('0xlobby');
	});

	it('returns undefined when no created object matches', () => {
		const changes: ReadonlyArray<PublishObjectChange> = [
			{ type: 'created', objectId: '0xcap', objectType: '0x2::package::UpgradeCap' },
		];

		expect(pickCreatedByType(changes, { suffix: '::board::Board' })).toBeUndefined();
	});
});
