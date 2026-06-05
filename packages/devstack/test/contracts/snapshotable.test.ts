// Structural pins for the `SnapshotableDecl` capability contract.
//
// Mirrors the style of `plugin-expander.test.ts`: the contract is the
// substrate-owned seam, so the test exercises the wire-shape (discriminated
// `kind`, required fields).

import { describe, expect, it } from 'vitest';

import type { SnapshotableDecl } from '../../src/contracts/snapshotable.ts';

describe('contracts/snapshotable — structural pins', () => {
	it('discriminated-union `kind` is the literal `"snapshotable"`', () => {
		const decl: SnapshotableDecl = {
			kind: 'snapshotable',
			subtrees: ['runtime/x/'],
			missingTolerance: 'fine',
		};
		// Compile-time: narrow on the literal.
		const tagged: 'snapshotable' = decl.kind;
		expect(tagged).toBe('snapshotable');
	});

	it('rejects a literal that omits `subtrees` (required field)', () => {
		// @ts-expect-error -- `subtrees` is required.
		const _missingSubtrees: SnapshotableDecl = {
			kind: 'snapshotable',
			missingTolerance: 'fine',
		};
		void _missingSubtrees;
	});

	it('rejects a `missingTolerance` value outside the union literal', () => {
		const _wrongTolerance: SnapshotableDecl = {
			kind: 'snapshotable',
			subtrees: [],
			// @ts-expect-error -- only `'fatal' | 'fine'` allowed.
			missingTolerance: 'maybe',
		};
		void _wrongTolerance;
	});
});
