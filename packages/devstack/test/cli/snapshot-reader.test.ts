// Snapshot-reader resolution contract.
//
// Regression: id-vs-name lookup used to be id-first then name-first
// fall-through. The two namespaces share the same `[A-Za-z0-9][A-Za-z0-9_-]*`
// grammar (the auto-mint shape `snap-<ts>-<uuid>` satisfies the same
// regex as a user-supplied label), so a label that happened to equal
// an existing id would silently resolve to the wrong artifact. The
// fix: resolve both axes in a single pass and surface `ambiguous`
// when distinct entries match.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { makeSnapshotReader } from '../../src/cli/snapshot-reader.ts';
import {
	SnapshotLayout,
	SNAPSHOT_META_VERSION,
	type SnapshotMetadata,
} from '../../src/orchestrators/snapshot/index.ts';
import { withTempRootSync } from '../helpers/with-temp-root.ts';

const metadata = (overrides: Partial<SnapshotMetadata> = {}): SnapshotMetadata => ({
	version: SNAPSHOT_META_VERSION,
	id: 'snap-fallback-fixture',
	label: null,
	createdAt: 1,
	app: 'sample-app',
	stack: 'main',
	network: 'localnet',
	hostTreeIncluded: false,
	subtrees: [],
	containers: [],
	identity: {},
	participants: [],
	...overrides,
});

const plantSnapshot = (stackRoot: string, meta: SnapshotMetadata): void => {
	const dir = join(stackRoot, 'snapshots', meta.id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, SnapshotLayout.metaFile), JSON.stringify(meta, null, 2));
};

describe('snapshot-reader resolve()', () => {
	it('returns the only entry when nothing else collides', () => {
		withTempRootSync('snap-reader-basic', (root) => {
			plantSnapshot(root, metadata({ id: 'snap-a', label: 'alpha' }));
			const reader = makeSnapshotReader({ stackRoot: root });
			const byId = Effect.runSync(reader.resolve('snap-a'));
			expect(byId.tag).toBe('found');
			if (byId.tag === 'found') expect(byId.entry.snapshotId).toBe('snap-a');
			const byName = Effect.runSync(reader.resolve('alpha'));
			expect(byName.tag).toBe('found');
			if (byName.tag === 'found') expect(byName.entry.snapshotId).toBe('snap-a');
		});
	});

	it('surfaces ambiguity when a ref matches an id on one entry AND a name on another', () => {
		// Snapshot `snap-a` is labelled `alpha`; snapshot `alpha` has no
		// label. Resolving `alpha` could match either — the previous
		// id-first fall-through quietly returned the bare `alpha` entry
		// and dropped the labelled match. The fix routes both candidates
		// into the `ambiguous` result so callers surface a typed
		// `CliSnapshotAmbiguousError` instead of restoring the wrong
		// artifact.
		withTempRootSync('snap-reader-collide', (root) => {
			plantSnapshot(root, metadata({ id: 'snap-a', label: 'alpha' }));
			plantSnapshot(root, metadata({ id: 'alpha', label: null }));
			const reader = makeSnapshotReader({ stackRoot: root });
			const resolved = Effect.runSync(reader.resolve('alpha'));
			expect(resolved.tag).toBe('ambiguous');
			if (resolved.tag === 'ambiguous') {
				expect(resolved.snapshotRef).toBe('alpha');
				expect(new Set(resolved.matches.map((m) => m.snapshotId))).toEqual(
					new Set(['snap-a', 'alpha']),
				);
			}
		});
	});

	it('does not surface ambiguity when both axes point at the same entry', () => {
		// Snapshot with id `alpha` and label `alpha` — both axes resolve
		// to the same entry, so the caller's intent is unambiguous.
		withTempRootSync('snap-reader-self', (root) => {
			plantSnapshot(root, metadata({ id: 'alpha', label: 'alpha' }));
			const reader = makeSnapshotReader({ stackRoot: root });
			const resolved = Effect.runSync(reader.resolve('alpha'));
			expect(resolved.tag).toBe('found');
			if (resolved.tag === 'found') expect(resolved.entry.snapshotId).toBe('alpha');
		});
	});

	it('returns not-found when no entry matches either axis', () => {
		withTempRootSync('snap-reader-miss', (root) => {
			plantSnapshot(root, metadata({ id: 'snap-a', label: 'alpha' }));
			const reader = makeSnapshotReader({ stackRoot: root });
			const resolved = Effect.runSync(reader.resolve('nothing'));
			expect(resolved.tag).toBe('not-found');
		});
	});

	it('still resolves names that collide with multiple snapshots as ambiguous (regression coverage)', () => {
		// Two snapshots sharing a label. The pre-fix code already
		// returned `ambiguous` for this case; the rewrite preserves the
		// contract.
		withTempRootSync('snap-reader-dup-name', (root) => {
			plantSnapshot(root, metadata({ id: 'snap-a', label: 'shared' }));
			plantSnapshot(root, metadata({ id: 'snap-b', label: 'shared' }));
			const reader = makeSnapshotReader({ stackRoot: root });
			const resolved = Effect.runSync(reader.resolve('shared'));
			expect(resolved.tag).toBe('ambiguous');
			if (resolved.tag === 'ambiguous') {
				expect(resolved.matches).toHaveLength(2);
			}
		});
	});
});
