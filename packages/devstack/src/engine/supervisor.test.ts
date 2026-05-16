// Coverage for the file-watcher noise filter (`isIgnoredWatchPath`).
//
// The Stage-2 build container bind-mounts the host source dir and lets
// `sui move build` rewrite `Move.lock` (plus the awk scrub's
// `Move.lock.new` intermediate) on every publish. Those file-change
// events flow through `fs.watch` and would trigger a full hot-restart
// cycle if not filtered — the restart would re-run the same publish
// that just produced the change, looping indefinitely on a single edit.
//
// This filter is a defensive boundary: the moment a new build-side
// artifact starts leaking into the host source, the symptom is a
// confusing "restart fires after every publish" — adding the basename
// here should be the only fix.

import { describe, expect, it } from 'vitest';
import { isIgnoredWatchPath } from './supervisor.js';

describe('isIgnoredWatchPath — file-watcher noise filter', () => {
	it('ignores Move.lock — rewritten by sui move build on every invocation', () => {
		expect(isIgnoredWatchPath('move/mock_usdc/Move.lock')).toBe(true);
		expect(isIgnoredWatchPath('/abs/path/Move.lock')).toBe(true);
	});

	it('ignores Move.lock.new — the awk scrub stages this before atomic rename', () => {
		// Without this branch, `awk … > $1.new && mv $1.new $1` triggers
		// two events per build: one for the .new create, one for the
		// rename. fs.watch sees both. The .new is purely transient.
		expect(isIgnoredWatchPath('move/mock_usdc/Move.lock.new')).toBe(true);
	});

	it('ignores `build/` — sui move build output dir, regenerated every run', () => {
		expect(isIgnoredWatchPath('move/mock_usdc/build/x.mv')).toBe(true);
		expect(isIgnoredWatchPath('move/mock_usdc/build/bytecode_modules/foo.mv')).toBe(true);
	});

	it('ignores node_modules and .git anywhere in the path', () => {
		expect(isIgnoredWatchPath('move/mock_usdc/node_modules/pkg/index.js')).toBe(true);
		expect(isIgnoredWatchPath('repo/.git/HEAD')).toBe(true);
	});

	it('ignores editor swap / backup files (.swp, .swx, ~ suffix)', () => {
		expect(isIgnoredWatchPath('move/mock_usdc/sources/.foo.move.swp')).toBe(true);
		expect(isIgnoredWatchPath('move/mock_usdc/sources/foo.move~')).toBe(true);
	});

	it('does NOT ignore actual Move source — `.move` files are the change we want to react to', () => {
		expect(isIgnoredWatchPath('move/mock_usdc/sources/mock_usdc.move')).toBe(false);
		expect(isIgnoredWatchPath('/abs/path/sources/foo.move')).toBe(false);
	});

	it('does NOT ignore Move.toml — user-authored manifest, real edits trigger republish', () => {
		expect(isIgnoredWatchPath('move/mock_usdc/Move.toml')).toBe(false);
	});

	it('does NOT ignore arbitrary files that happen to share a prefix', () => {
		// `Move.locked.txt` is not Move.lock; basename-equality matters.
		expect(isIgnoredWatchPath('move/mock_usdc/Move.locked.txt')).toBe(false);
		// `build-config.json` is not the `build/` directory.
		expect(isIgnoredWatchPath('move/mock_usdc/build-config.json')).toBe(false);
	});
});
