// Unit tests for the walrus Snapshotable contribution.
//
// The snapshot decl is the bridge between the plugin's local-cluster
// containers + on-disk deploy outputs and the snapshot orchestrator's
// per-stack tar. These tests pin the contract surface so a refactor
// can't silently break round-trip semantics.

import { describe, expect, it } from 'vitest';

import { makeSnapshotable } from '../../../src/plugins/walrus/snapshot.ts';

describe('walrus makeSnapshotable', () => {
	it('local mode emits N storage-node container decls (one per role)', () => {
		const snap = makeSnapshotable('local', 'app', 'main', 'walrus', 'sui:localnet', 3);
		expect(snap.kind).toBe('snapshotable');
		expect(snap.managedContainers).toHaveLength(3);
		const roles = (snap.managedContainers ?? []).map((c) => c.role);
		expect(roles).toEqual(['storage-node-0', 'storage-node-1', 'storage-node-2']);
		// All other label fields stable.
		for (const c of snap.managedContainers ?? []) {
			expect(c.app).toBe('app');
			expect(c.stack).toBe('main');
			expect(c.plugin).toBe('walrus');
		}
	});

	it('local mode includes enabled publisher, aggregator, and upload-relay service containers', () => {
		const snap = makeSnapshotable('local', 'app', 'main', 'walrus', 'sui:localnet', 2, [
			'aggregator',
			'publisher',
			'upload-relay',
		]);
		const roles = (snap.managedContainers ?? []).map((c) => c.role);
		expect(roles).toEqual([
			'storage-node-0',
			'storage-node-1',
			'aggregator',
			'publisher',
			'upload-relay',
		]);
	});

	it('local mode subtree includes the deploy-output dir (rides the snapshot tar)', () => {
		const snap = makeSnapshotable('local', 'app', 'main', 'mywalrus', 'sui:localnet');
		// Distilled-doc invariant 7: `runtime/walrus/<name>/deploy/` MUST
		// ride the snapshot tar.
		expect(snap.subtrees).toEqual(['walrus/mywalrus/deploy/']);
	});

	it('local mode flags secret material (per-node keystores under deploy/)', () => {
		const snap = makeSnapshotable('local', 'app', 'main', 'walrus', 'sui:localnet');
		expect(snap.secretMaterial).toBe(true);
	});

	it('local mode default nodeCount is 1', () => {
		const snap = makeSnapshotable('local', 'app', 'main', 'walrus', 'sui:localnet');
		expect(snap.managedContainers).toHaveLength(1);
		expect(snap.managedContainers?.[0]?.role).toBe('storage-node-0');
	});

	it('known mode emits no subtrees + no containers (identity guard only)', () => {
		const snap = makeSnapshotable('known', 'app', 'main', 'walrusKnownDeployment', 'sui:testnet');
		expect(snap.subtrees).toEqual([]);
		expect(snap.managedContainers).toBeUndefined();
		expect(snap.secretMaterial).toBeUndefined();
	});

	it('missingTolerance is "fine" in both modes (walrus state survives container loss)', () => {
		expect(makeSnapshotable('local', 'a', 'm', 'w', 'sui:l').missingTolerance).toBe('fine');
		expect(makeSnapshotable('known', 'a', 'm', 'w', 'sui:t').missingTolerance).toBe('fine');
	});
});
