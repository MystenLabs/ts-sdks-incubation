import { describe, expect, it } from 'vitest';

import { makeWalletSnapshotable } from '../../../src/plugins/wallet/index.ts';

describe('wallet snapshot contribution', () => {
	it('declares pairing token as plugin-owned secret state', () => {
		const decl = makeWalletSnapshotable();

		expect(decl).toMatchObject({
			kind: 'snapshotable',
			subtrees: ['wallet/token'],
			missingTolerance: 'fatal',
			secretMaterial: true,
		});
	});
});
