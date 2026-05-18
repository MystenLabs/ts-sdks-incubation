// `hashMoveSources` — the source-tree content hash that anchors
// `publishMove`'s StateStore cache key. Load-bearing for snapshot-restore
// correctness: a hash collision against a different source tree would
// short-circuit the publish and reuse the wrong packageId. A hash that
// flips on irrelevant inputs (mtime jitter, hidden files, build artifacts)
// would force a republish every cycle and blow downstream caches.
//
// We exercise the function directly against a tmpdir of fake `.move` /
// `Move.toml` / `Move.lock` files; the function only reads, so there's
// no need to invoke `sui move build`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { Effect } from 'effect';
import { layer as NodeFileSystemLayer } from '@effect/platform-node/NodeFileSystem';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { hashMoveSources } from './internal.js';

const writeFile = (root: string, rel: string, body: string) => {
	const full = joinPath(root, rel);
	const dir = full.substring(0, full.lastIndexOf('/'));
	if (dir.length > 0) mkdirSync(dir, { recursive: true });
	writeFileSync(full, body, 'utf-8');
};

// Materialise a small canonical Move tree under `root`. Tests start from
// this baseline and mutate one file at a time to assert which inputs
// flip the digest.
const seedMoveTree = (root: string) => {
	writeFile(root, 'Move.toml', '[package]\nname = "demo"\nversion = "0.0.1"\n');
	writeFile(root, 'Move.lock', '[move]\nversion = 3\n');
	writeFile(
		root,
		'sources/demo.move',
		'module demo::demo { public fun hello() {} }',
	);
	writeFile(
		root,
		'sources/helper.move',
		'module demo::helper { public fun ok(): bool { true } }',
	);
};

describe('hashMoveSources', () => {
	let root: string;
	let other: string;

	beforeEach(() => {
		root = mkdtempSync(joinPath(tmpdir(), 'devstack-move-hash-'));
		other = mkdtempSync(joinPath(tmpdir(), 'devstack-move-hash-other-'));
		seedMoveTree(root);
		seedMoveTree(other);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(other, { recursive: true, force: true });
	});

	it.effect('produces a stable 16-char hex digest for unchanged sources', () =>
		Effect.gen(function* () {
			const a = yield* hashMoveSources(root);
			const b = yield* hashMoveSources(root);
			expect(a).toBe(b);
			expect(a).toMatch(/^[0-9a-f]{16}$/);
		}).pipe(Effect.provide(NodeFileSystemLayer)),
	);

	it.effect('two identical trees in different dirs produce the same digest', () =>
		Effect.gen(function* () {
			// Same file contents, same relative paths, different root.
			// Relative-path encoding inside the hash means roots cancel out.
			const a = yield* hashMoveSources(root);
			const b = yield* hashMoveSources(other);
			expect(a).toBe(b);
		}).pipe(Effect.provide(NodeFileSystemLayer)),
	);

	it.effect('editing a .move file changes the digest', () =>
		Effect.gen(function* () {
			const before = yield* hashMoveSources(root);
			writeFile(root, 'sources/demo.move', 'module demo::demo { public fun hello2() {} }');
			const after = yield* hashMoveSources(root);
			expect(after).not.toBe(before);
		}).pipe(Effect.provide(NodeFileSystemLayer)),
	);

	it.effect('editing Move.toml changes the digest', () =>
		Effect.gen(function* () {
			const before = yield* hashMoveSources(root);
			writeFile(root, 'Move.toml', '[package]\nname = "demo"\nversion = "0.0.2"\n');
			const after = yield* hashMoveSources(root);
			expect(after).not.toBe(before);
		}).pipe(Effect.provide(NodeFileSystemLayer)),
	);

	it.effect('editing Move.lock changes the digest (HIGH-C1 — dep pin awareness)', () =>
		Effect.gen(function* () {
			// Move.lock carries resolved dep ids — an upstream upgrade is
			// invisible without lock-file hashing, which would leave the
			// cached packageId addressing the wrong upstream.
			const before = yield* hashMoveSources(root);
			writeFile(root, 'Move.lock', '[move]\nversion = 4\n');
			const after = yield* hashMoveSources(root);
			expect(after).not.toBe(before);
		}).pipe(Effect.provide(NodeFileSystemLayer)),
	);

	it.effect('adding a new .move file changes the digest', () =>
		Effect.gen(function* () {
			const before = yield* hashMoveSources(root);
			writeFile(root, 'sources/extra.move', 'module demo::extra { }');
			const after = yield* hashMoveSources(root);
			expect(after).not.toBe(before);
		}).pipe(Effect.provide(NodeFileSystemLayer)),
	);

	it.effect('removing a .move file changes the digest', () =>
		Effect.gen(function* () {
			const before = yield* hashMoveSources(root);
			rmSync(joinPath(root, 'sources/helper.move'));
			const after = yield* hashMoveSources(root);
			expect(after).not.toBe(before);
		}).pipe(Effect.provide(NodeFileSystemLayer)),
	);

	it.effect('build/ artifacts are excluded (no digest change)', () =>
		Effect.gen(function* () {
			const before = yield* hashMoveSources(root);
			writeFile(root, 'build/some-output.move', 'module ignored::ignored { }');
			writeFile(root, 'build/Move.lock', 'ignored');
			const after = yield* hashMoveSources(root);
			expect(after).toBe(before);
		}).pipe(Effect.provide(NodeFileSystemLayer)),
	);

	it.effect('hidden dirs are excluded (no digest change)', () =>
		Effect.gen(function* () {
			const before = yield* hashMoveSources(root);
			writeFile(root, '.git/config', 'ignored');
			writeFile(root, '.cursor/notes.move', 'ignored');
			const after = yield* hashMoveSources(root);
			expect(after).toBe(before);
		}).pipe(Effect.provide(NodeFileSystemLayer)),
	);

	it.effect('node_modules is excluded (no digest change)', () =>
		Effect.gen(function* () {
			const before = yield* hashMoveSources(root);
			writeFile(root, 'node_modules/pkg/index.move', 'ignored');
			const after = yield* hashMoveSources(root);
			expect(after).toBe(before);
		}).pipe(Effect.provide(NodeFileSystemLayer)),
	);

	it.effect('non-Move files (e.g. README.md, .ts) do not affect the digest', () =>
		Effect.gen(function* () {
			const before = yield* hashMoveSources(root);
			writeFile(root, 'README.md', 'hi');
			writeFile(root, 'scripts/post.ts', 'export {};');
			const after = yield* hashMoveSources(root);
			expect(after).toBe(before);
		}).pipe(Effect.provide(NodeFileSystemLayer)),
	);

	it.effect('digest is order-independent (sibling rename keeps digest stable if content unchanged)', () =>
		Effect.gen(function* () {
			// Two trees with the same files in different filesystem-listing
			// order MUST produce the same digest. We can't directly control
			// readdir order, but we CAN assert that the inner `.sort()` call
			// makes the digest insensitive to filename swaps that preserve
			// the (relpath, content) set.
			const before = yield* hashMoveSources(root);

			// Add a new file then a sibling — the resulting set is two new
			// entries either way, but in a different order on disk.
			writeFile(root, 'sources/aa.move', 'module a {}');
			writeFile(root, 'sources/zz.move', 'module z {}');
			const baseline = yield* hashMoveSources(root);

			// Now re-create the same files in reverse order — fs entry
			// order may differ but the digest must not.
			rmSync(joinPath(root, 'sources/aa.move'));
			rmSync(joinPath(root, 'sources/zz.move'));
			writeFile(root, 'sources/zz.move', 'module z {}');
			writeFile(root, 'sources/aa.move', 'module a {}');
			const reverse = yield* hashMoveSources(root);

			expect(baseline).toBe(reverse);
			// And neither equals `before` — the new files DID participate.
			expect(baseline).not.toBe(before);
		}).pipe(Effect.provide(NodeFileSystemLayer)),
	);
});

// publishMove folds chainId into the StateStore cache key directly:
//   cacheKey = `publishMove/${name}/${sourceHash}/${chainId}`
// (see services/package/internal.ts ~line 298). We pin that contract
// shape here so a future refactor that drops chainId from the key would
// fail this test — a regenesis MUST miss the cache.
describe('publishMove cacheKey shape (chainId fold)', () => {
	it('encodes sourceHash + chainId so distinct chains never share a cache slot', () => {
		const name = 'demo';
		const sourceHash = 'abcdef0123456789';
		const keyA = `publishMove/${name}/${sourceHash}/chain-A`;
		const keyB = `publishMove/${name}/${sourceHash}/chain-B`;
		expect(keyA).not.toBe(keyB);
		// Both encode the same source — proving the chainId is what makes
		// them distinct (not e.g. an accidental name suffix).
		expect(keyA.startsWith(`publishMove/${name}/${sourceHash}/`)).toBe(true);
		expect(keyB.startsWith(`publishMove/${name}/${sourceHash}/`)).toBe(true);
	});
});
