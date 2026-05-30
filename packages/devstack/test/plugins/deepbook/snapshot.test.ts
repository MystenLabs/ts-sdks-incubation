// Unit tests for the deepbook Snapshotable contribution.
//
// Pin the subtree path + managed-container label projection so a
// refactor doesn't silently regress the orchestrator-name-blindness
// contract.

import { describe, expect, it } from 'vitest';

import {
	makeKnownSnapshotable,
	makeLocalSnapshotable,
} from '../../../src/plugins/deepbook/snapshot.ts';

describe('makeLocalSnapshotable', () => {
	it('captures the deepbook/<name> subtree', () => {
		const decl = makeLocalSnapshotable({ name: 'main' });
		expect(decl.kind).toBe('snapshotable');
		expect(decl.subtrees).toEqual(['deepbook/main']);
	});

	it('declares no managed containers (indexer + server daemons not wired yet)', () => {
		const decl = makeLocalSnapshotable({ name: 'main' });
		expect(decl.managedContainers).toEqual([]);
	});

	it("missing tolerance is 'fine' (cache is best-effort)", () => {
		const decl = makeLocalSnapshotable({ name: 'main' });
		expect(decl.missingTolerance).toBe('fine');
	});

	it('declares no secret material', () => {
		const decl = makeLocalSnapshotable({ name: 'main' });
		expect(decl.secretMaterial).toBe(false);
	});
});

describe('makeKnownSnapshotable', () => {
	it('declares no subtrees (read-only remote handle)', () => {
		const decl = makeKnownSnapshotable({ name: 'main' });
		expect(decl.subtrees).toEqual([]);
	});

	it("missing tolerance is 'fine'", () => {
		const decl = makeKnownSnapshotable({ name: 'main' });
		expect(decl.missingTolerance).toBe('fine');
	});
});
