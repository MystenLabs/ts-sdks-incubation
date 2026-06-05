// Unit tests for `snapshot.ts` — the Snapshotable contributions.
//
// We pin the secret-material flag + missing-tolerance + subtree paths
// so a refactor doesn't silently regress the snapshot capture
// contract (distilled-doc §"What survives snapshot" — the master-key
// env-file is load-bearing).
//
// Lives at `test/plugins/seal/snapshot.test.ts` per the mirror-src/
// rule.

import { describe, expect, it } from 'vitest';

import {
	makeKnownSnapshotable,
	makeLocalKeygenSnapshotable,
} from '../../../src/plugins/seal/snapshot.ts';

describe('makeLocalKeygenSnapshotable — distilled-doc §"What survives snapshot"', () => {
	it('declares secret material (0o600 mode-bit round-trip)', () => {
		const decl = makeLocalKeygenSnapshotable({
			name: 'seal',
			app: 'app',
			stack: 'main',
		});
		expect(decl.kind).toBe('snapshotable');
		expect(decl.secretMaterial).toBe(true);
	});

	it('captures the runtime/seal subtree', () => {
		const decl = makeLocalKeygenSnapshotable({
			name: 'seal',
			app: 'app',
			stack: 'main',
		});
		// The orchestrator roots `subtrees` under `runtime/`. Plugin-side
		// the path is the canonical directory subtree `seal/`
		// (plugin-blind from the orchestrator's POV).
		expect(decl.subtrees).toContain('seal/');
	});

	it('declares the key-server container by label tuple', () => {
		const decl = makeLocalKeygenSnapshotable({
			name: 'seal',
			app: 'app',
			stack: 'main',
		});
		expect(decl.managedContainers).toBeDefined();
		expect(decl.managedContainers!.length).toBe(1);
		expect(decl.managedContainers![0]).toEqual({
			app: 'app',
			stack: 'main',
			plugin: 'seal',
			role: 'key-server',
		});
	});

	it('missing tolerance is fatal (losing master-key.env would silently re-derive a fresh keypair)', () => {
		const decl = makeLocalKeygenSnapshotable({
			name: 'seal',
			app: 'app',
			stack: 'main',
		});
		expect(decl.missingTolerance).toBe('fatal');
	});
});

describe('makeKnownSnapshotable — known-deployment mode has no host state', () => {
	it('declares no secret material', () => {
		const decl = makeKnownSnapshotable({ name: 'seal' });
		expect(decl.secretMaterial).toBe(false);
	});

	it('declares no subtrees (read-only remote handle)', () => {
		const decl = makeKnownSnapshotable({ name: 'seal' });
		expect(decl.subtrees).toEqual([]);
	});

	it("missing tolerance is 'fine' (no host-side state to lose)", () => {
		const decl = makeKnownSnapshotable({ name: 'seal' });
		expect(decl.missingTolerance).toBe('fine');
	});
});
