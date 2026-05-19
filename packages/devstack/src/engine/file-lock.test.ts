// Unit tests for the shared file-lock primitives. Integration coverage
// lives in `port-allocator.test.ts` (sync caller) and
// `sui-fork.lock.test.ts` (sync caller, Effect-wrapped). State-store
// keeps its own retry-loop tests.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	ownLockBody,
	parseLockBody,
	releaseLockSync,
	serializeLockBody,
	tryClaimLockSync,
} from './file-lock.js';

describe('file-lock — parse / serialize', () => {
	it('round-trips a body without optional fields', () => {
		const body = { pid: 100, startedAt: 'Jan 1 12:00:00', host: 'h1' };
		const round = parseLockBody(serializeLockBody(body));
		expect(round).toEqual(body);
	});

	it('round-trips a body WITH instanceId + acquiredAt', () => {
		const body = {
			pid: 100,
			startedAt: 'Jan 1 12:00:00',
			host: 'h1',
			instanceId: 'abc-uuid',
			acquiredAt: '2026-05-18T00:00:00.000Z',
		};
		const round = parseLockBody(serializeLockBody(body));
		// `acquiredAt` is intentionally dropped from the parse output —
		// callers that need it read it back from the on-disk JSON via
		// `JSON.parse` directly (only state-store cares).
		expect(round).toMatchObject({
			pid: 100,
			startedAt: 'Jan 1 12:00:00',
			host: 'h1',
			instanceId: 'abc-uuid',
		});
	});

	it('returns undefined for malformed JSON', () => {
		expect(parseLockBody('not-json')).toBeUndefined();
	});

	it('returns undefined for the pre-Theme-6c bare-pid format', () => {
		expect(parseLockBody('1234')).toBeUndefined();
	});

	it('returns undefined for a payload missing required fields', () => {
		expect(parseLockBody(JSON.stringify({ pid: 100 }))).toBeUndefined();
	});

	it('rejects non-finite pid (NaN / Infinity)', () => {
		expect(parseLockBody(JSON.stringify({ pid: NaN, startedAt: '', host: '' }))).toBeUndefined();
	});
});

describe('file-lock — tryClaimLockSync / releaseLockSync', () => {
	let dir: string;
	let path: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'devstack-file-lock-'));
		path = join(dir, 'test.lock');
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('claims a fresh path', () => {
		const result = tryClaimLockSync(path);
		expect(result.ok).toBe(true);
		const raw = readFileSync(path, 'utf8');
		expect(parseLockBody(raw)?.pid).toBe(process.pid);
	});

	it('refuses to claim when another live holder owns the path', () => {
		// Self-claim once.
		const first = tryClaimLockSync(path);
		expect(first.ok).toBe(true);
		// Second claim — same pid (alive!), so the implementation should
		// detect ourselves as the live holder and refuse.
		const second = tryClaimLockSync(path);
		expect(second.ok).toBe(false);
	});

	it('reclaims a stale lock (dead PID, same host)', () => {
		// Cross-host bodies are treated as alive (PID comparisons are
		// meaningless across hosts), so the stale-PID test must use the
		// current host's name. PID 999_999 should be reliably dead on a
		// CI runner.
		writeFileSync(
			path,
			JSON.stringify({
				pid: 999_999,
				startedAt: '',
				host: hostname(),
			}),
		);
		const result = tryClaimLockSync(path);
		expect(result.ok).toBe(true);
		expect(parseLockBody(readFileSync(path, 'utf8'))?.pid).toBe(process.pid);
	});

	it('release deletes the lock only when ownBody.instanceId matches', () => {
		const result = tryClaimLockSync(path);
		expect(result.ok).toBe(true);
		if (result.ok) {
			releaseLockSync(path, result.body);
		}
		expect(() => readFileSync(path)).toThrow(/ENOENT/);
	});

	it('release is idempotent — running on an already-released lock is a no-op', () => {
		const result = tryClaimLockSync(path);
		expect(result.ok).toBe(true);
		if (result.ok) {
			releaseLockSync(path, result.body);
			// Second release should not throw.
			expect(() => releaseLockSync(path, result.body)).not.toThrow();
		}
	});

	it('release with mismatched instanceId leaves the on-disk lock alone', () => {
		const result = tryClaimLockSync(path);
		expect(result.ok).toBe(true);
		// Forge a different body (different instanceId).
		const forged = ownLockBody();
		releaseLockSync(path, forged);
		// On-disk lock should still be there.
		expect(() => readFileSync(path)).not.toThrow();
	});
});
