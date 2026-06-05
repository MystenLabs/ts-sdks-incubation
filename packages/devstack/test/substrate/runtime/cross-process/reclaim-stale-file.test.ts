// reclaim-stale-file — the shared unparseable/stale reclaim guard.
//
// This guard is the TOCTOU close used by `stack-lock.ts` (its sole
// remaining consumer). The bug it fixes: the naive shape (stat the
// mtime, decide it's a stale orphan, then unlink) has a window in which
// a competing process can legitimately reclaim the garbage file and
// write a FRESH, VALID O_EXCL body. The unconditional unlink would then
// clobber that live lock/reservation, producing two simultaneous holders
// (a mutual-exclusion break).
//
// The headline test plants a stale, unparseable body and drives a
// competitor's fresh valid write into the re-stat window via an
// injectable `parse` that flips from null (unparseable) to a value
// (parseable) between the guard's first read and its post-re-stat read.
// The guard MUST bail (`changed`) and leave the file on disk.

import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';

import { reclaimUnparseableStaleFile } from '../../../../src/substrate/runtime/cross-process/reclaim-stale-file.ts';
import { withTempRootSync } from '../../../helpers/with-temp-root.ts';

const STALE_AFTER = 30_000;

/** Backdate a file's mtime well past the staleness window so the guard
 *  treats it as an aged orphan. */
const backdate = (path: string): void => {
	const past = (Date.now() - 60_000) / 1_000;
	utimesSync(path, past, past);
};

/** A `parse` that always fails (body is garbage). */
const neverParses = (): unknown => null;

/** A `parse` that always succeeds (body is well-formed). The returned
 *  value is opaque to the guard — only null vs non-null matters. */
const alwaysParses = (): unknown => ({ ok: true });

describe('reclaimUnparseableStaleFile — re-stat guard (TOCTOU close)', () => {
	it('bails (does NOT unlink) when a fresh VALID body lands in the re-stat window', () => {
		withTempRootSync('reclaim-stale-file', (root) => {
			const path = join(root, 'stack.lock');
			// Plant a stale, currently-unparseable body — the same shape a
			// peer leaves behind after a mid-write crash.
			writeFileSync(path, '{partial-json', { flag: 'wx' });
			backdate(path);

			// Simulate the competitor: the FIRST parse (the guard's initial
			// classification read) sees garbage → null; the SECOND parse
			// (the guard's post-re-stat re-read) sees the competitor's
			// freshly-written valid body → non-null. The guard must detect
			// the change and refuse to unlink.
			let calls = 0;
			const parse = (_raw: string): unknown => {
				calls += 1;
				return calls === 1 ? null : { ok: true };
			};

			const outcome = reclaimUnparseableStaleFile(path, parse, STALE_AFTER);

			expect(outcome).toBe('changed');
			// The live body the competitor wrote is UNTOUCHED — the whole
			// point of the guard.
			expect(existsSync(path)).toBe(true);
			expect(parse).toBeDefined();
			// We consulted parse at least twice (initial + re-read).
			expect(calls).toBeGreaterThanOrEqual(2);
		});
	});

	it('bails when the inode identity (mtime) changes in the re-stat window', () => {
		withTempRootSync('reclaim-stale-file', (root) => {
			const path = join(root, 'stack.lock');
			writeFileSync(path, '{partial-json', { flag: 'wx' });
			backdate(path);

			// The competitor rewrites the file (still unparseable, but a
			// NEW mtime) between the guard's initial read and its re-stat.
			// We hook that mutation onto the parse callback — the second
			// invocation is the guard's re-read, fired AFTER the re-stat,
			// so to perturb the re-stat we mutate on the FIRST call.
			let mutated = false;
			const parse = (_raw: string): unknown => {
				if (!mutated) {
					mutated = true;
					// Touch the file forward so its mtime no longer matches
					// the identity the guard captured a moment ago.
					const future = (Date.now() + 120_000) / 1_000;
					utimesSync(path, future, future);
				}
				return null;
			};

			const outcome = reclaimUnparseableStaleFile(path, parse, STALE_AFTER);

			expect(outcome).toBe('changed');
			expect(existsSync(path)).toBe(true);
		});
	});

	it('reclaims (unlinks) an aged, consistently-unparseable orphan', () => {
		withTempRootSync('reclaim-stale-file', (root) => {
			const path = join(root, 'stack.lock');
			writeFileSync(path, '{partial-json', { flag: 'wx' });
			backdate(path);

			const outcome = reclaimUnparseableStaleFile(path, neverParses, STALE_AFTER);

			expect(outcome).toBe('reclaimed');
			expect(existsSync(path)).toBe(false);
		});
	});

	it('leaves a FRESH unparseable body alone (inside the staleness window)', () => {
		withTempRootSync('reclaim-stale-file', (root) => {
			const path = join(root, 'stack.lock');
			// Current mtime — a writer is presumed mid-flush.
			writeFileSync(path, '{partial-json', { flag: 'wx' });

			const outcome = reclaimUnparseableStaleFile(path, neverParses, STALE_AFTER);

			expect(outcome).toBe('fresh');
			expect(existsSync(path)).toBe(true);
		});
	});

	it('leaves a PARSEABLE body alone regardless of age (a live holder owns it)', () => {
		withTempRootSync('reclaim-stale-file', (root) => {
			const path = join(root, 'stack.lock');
			writeFileSync(path, JSON.stringify({ pid: 1 }), { flag: 'wx' });
			backdate(path);

			const outcome = reclaimUnparseableStaleFile(path, alwaysParses, STALE_AFTER);

			expect(outcome).toBe('parseable');
			expect(existsSync(path)).toBe(true);
			// Byte-identical — the guard never rewrote it.
			expect(readFileSync(path, 'utf8')).toBe(JSON.stringify({ pid: 1 }));
		});
	});

	it('reports absent when the file does not exist', () => {
		withTempRootSync('reclaim-stale-file', (root) => {
			const path = join(root, 'does-not-exist.lock');
			const outcome = reclaimUnparseableStaleFile(path, neverParses, STALE_AFTER);
			expect(outcome).toBe('absent');
		});
	});
});
