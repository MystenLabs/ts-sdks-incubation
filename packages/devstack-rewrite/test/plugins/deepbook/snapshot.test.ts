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
	it('captures the runtime/deepbook/<name> subtree', () => {
		const decl = makeLocalSnapshotable({
			name: 'main',
			app: 'arena',
			stack: 'devstack',
			indexerEnabled: false,
			serverEnabled: false,
		});
		expect(decl.kind).toBe('snapshotable');
		expect(decl.subtrees).toEqual(['deepbook/main']);
	});

	it('declares no managed containers when indexer + server are off', () => {
		const decl = makeLocalSnapshotable({
			name: 'main',
			app: 'arena',
			stack: 'devstack',
			indexerEnabled: false,
			serverEnabled: false,
		});
		expect(decl.managedContainers).toEqual([]);
	});

	it('declares indexer label tuple when indexer is on', () => {
		const decl = makeLocalSnapshotable({
			name: 'main',
			app: 'arena',
			stack: 'devstack',
			indexerEnabled: true,
			serverEnabled: false,
		});
		expect(decl.managedContainers).toEqual([
			{ app: 'arena', stack: 'devstack', plugin: 'deepbook', role: 'indexer' },
		]);
	});

	it('declares both indexer + server label tuples when both are on', () => {
		const decl = makeLocalSnapshotable({
			name: 'main',
			app: 'arena',
			stack: 'devstack',
			indexerEnabled: true,
			serverEnabled: true,
		});
		expect(decl.managedContainers).toHaveLength(2);
		expect(decl.managedContainers).toEqual(
			expect.arrayContaining([
				{ app: 'arena', stack: 'devstack', plugin: 'deepbook', role: 'indexer' },
				{ app: 'arena', stack: 'devstack', plugin: 'deepbook', role: 'server' },
			]),
		);
	});

	it("missing tolerance is 'fine' (cache is best-effort)", () => {
		const decl = makeLocalSnapshotable({
			name: 'main',
			app: 'arena',
			stack: 'devstack',
			indexerEnabled: false,
			serverEnabled: false,
		});
		expect(decl.missingTolerance).toBe('fine');
	});

	it('declares no secret material', () => {
		const decl = makeLocalSnapshotable({
			name: 'main',
			app: 'arena',
			stack: 'devstack',
			indexerEnabled: false,
			serverEnabled: false,
		});
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
