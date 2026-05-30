// Structural pins for the `SnapshotableDecl` capability contract.
//
// Mirrors the style of `plugin-expander.test.ts`: the contract is the
// substrate-owned seam, so the test exercises the wire-shape (discriminated
// `kind`, required fields) and the round-trip through the
// `define-capabilities.ts` helper. Plugin-author symmetry: anything the
// built-ins emit must be reproducible with the public `snapshotable(...)`
// helper.

import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import { snapshotable } from '../../src/api/define-capabilities.ts';
import type {
	ContainerLabelTuple,
	IdentityContributionShape,
	SnapshotableDecl,
} from '../../src/contracts/snapshotable.ts';

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

	it('`define-capabilities.ts` helper round-trips: adds `kind`, preserves payload', () => {
		const sample = {
			subtrees: ['runtime/sui/'],
			managedContainers: [
				{
					app: 'demo',
					stack: 'main',
					plugin: 'sui',
					role: 'validator',
				} satisfies ContainerLabelTuple,
			],
			preRestore: Effect.succeed({ kind: 'demo' } as IdentityContributionShape),
			postRestore: Effect.void,
			missingTolerance: 'fine' as const,
			secretMaterial: false,
		};
		const decl = snapshotable(sample);
		expect(decl.kind).toBe('snapshotable');
		expect(decl.subtrees).toEqual(['runtime/sui/']);
		expect(decl.managedContainers?.[0]?.role).toBe('validator');
		expect(decl.missingTolerance).toBe('fine');
		expect(decl.secretMaterial).toBe(false);
	});

	it('helper does NOT accept a literal that pre-baked `kind`', () => {
		const _withKind = snapshotable({
			// @ts-expect-error -- helper owns the `kind` slot.
			kind: 'snapshotable',
			subtrees: [],
			missingTolerance: 'fine',
		});
		void _withKind;
	});
});
