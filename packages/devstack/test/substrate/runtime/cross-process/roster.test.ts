// Roster claim / release / container-claim ledger — atomic-write
// integration smoke.
//
// After the atomic-write consolidation, every roster mutation routes
// through the canonical `atomicWriteFileSync` (no inline tempfile +
// rename dances). These tests pin the contract from the consumer's
// POV: claim writes a parseable roster, addClaim/removeClaim
// round-trip through the container-claim ledger, no tempfile leaks
// on success.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	addClaim,
	claim,
	pruneStaleClaims,
	readClaims,
	release,
	removeClaim,
} from '../../../../src/substrate/runtime/cross-process/roster.ts';

const ROSTER_TEST_TIMEOUT_MS = 15_000;
const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'roster-test-'));

const pathsFor = (
	root: string,
): { readonly stackLockFile: string; readonly rosterFile: string } => {
	const stackRoot = join(root, 'app', 'main');
	return {
		stackLockFile: join(stackRoot, 'stack.lock'),
		rosterFile: join(stackRoot, 'roster.json'),
	};
};

describe('roster.claim / release', () => {
	it.effect(
		'claim writes a parseable roster.json via the canonical primitive',
		() =>
			Effect.gen(function* () {
				const root = freshRoot();
				const paths = pathsFor(root);
				try {
					const result = yield* claim(paths);
					expect(result.roster.holders).toHaveLength(1);
					expect(existsSync(paths.rosterFile)).toBe(true);
					const onDisk = JSON.parse(readFileSync(paths.rosterFile, 'utf8'));
					expect(onDisk.version).toBe(1);
					expect(onDisk.holders).toHaveLength(1);
					expect(existsSync(paths.stackLockFile)).toBe(false);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
		ROSTER_TEST_TIMEOUT_MS,
	);

	it.effect(
		'release drops THIS process and reports last-leaver',
		() =>
			Effect.gen(function* () {
				const root = freshRoot();
				const paths = pathsFor(root);
				try {
					yield* claim(paths);
					const result = yield* release(paths);
					expect(result.lastLeaver).toBe(true);
					expect(result.roster.holders).toHaveLength(0);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
		ROSTER_TEST_TIMEOUT_MS,
	);

	it.effect(
		'claim leaves no tempfile siblings on success',
		() =>
			Effect.gen(function* () {
				const root = freshRoot();
				const paths = pathsFor(root);
				try {
					yield* claim(paths);
					yield* release(paths);
					const siblings = readdirSync(join(root, 'app', 'main'));
					expect(siblings.filter((s) => s.includes('.tmp.'))).toEqual([]);
					expect(siblings).toContain('roster.json');
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
		ROSTER_TEST_TIMEOUT_MS,
	);
});

describe('roster.addClaim / removeClaim (container-claim ledger)', () => {
	it.effect(
		'addClaim writes the container-claims.json via the canonical primitive',
		() =>
			Effect.gen(function* () {
				const root = freshRoot();
				const paths = pathsFor(root);
				try {
					yield* claim(paths);
					yield* addClaim(paths, 'devstack-main-sui');
					const doc = yield* readClaims(paths);
					expect(doc.claims).toHaveLength(1);
					expect(doc.claims[0]?.containerKey).toBe('devstack-main-sui');
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
		ROSTER_TEST_TIMEOUT_MS,
	);

	it.effect(
		'removeClaim reports last-claim-released when no peer holds it',
		() =>
			Effect.gen(function* () {
				const root = freshRoot();
				const paths = pathsFor(root);
				try {
					yield* claim(paths);
					yield* addClaim(paths, 'devstack-main-sui');
					const result = yield* removeClaim(paths, 'devstack-main-sui');
					expect(result.lastClaimReleased).toBe(true);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
		ROSTER_TEST_TIMEOUT_MS,
	);

	it.effect(
		'addClaim is idempotent for the same (containerKey, pid, host)',
		() =>
			Effect.gen(function* () {
				const root = freshRoot();
				const paths = pathsFor(root);
				try {
					yield* claim(paths);
					yield* addClaim(paths, 'devstack-main-sui');
					yield* addClaim(paths, 'devstack-main-sui');
					const doc = yield* readClaims(paths);
					expect(doc.claims).toHaveLength(1);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
		ROSTER_TEST_TIMEOUT_MS,
	);

	it.effect(
		'addClaim prunes stale same-host claims before appending',
		() =>
			Effect.gen(function* () {
				const root = freshRoot();
				const paths = pathsFor(root);
				try {
					const claimsFile = join(root, 'app', 'main', 'container-claims.json');
					yield* claim(paths);
					writeFileSync(
						claimsFile,
						JSON.stringify({
							version: 1,
							claims: [
								{
									containerKey: 'devstack-main-sui',
									pid: 0,
									startTime: 1,
									hostname: hostname(),
									claimedAt: 1,
								},
							],
						}),
					);

					yield* addClaim(paths, 'devstack-main-sui');

					const doc = yield* readClaims(paths);
					expect(doc.claims).toHaveLength(1);
					expect(doc.claims[0]?.pid).toBe(process.pid);
					expect(doc.claims[0]?.startTime).toEqual(expect.any(Number));
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
		ROSTER_TEST_TIMEOUT_MS,
	);

	it.effect(
		'removeClaim ignores stale peers when computing last-claim release',
		() =>
			Effect.gen(function* () {
				const root = freshRoot();
				const paths = pathsFor(root);
				try {
					yield* claim(paths);
					yield* addClaim(paths, 'devstack-main-sui');
					const claimsFile = join(root, 'app', 'main', 'container-claims.json');
					const current = yield* readClaims(paths);
					writeFileSync(
						claimsFile,
						JSON.stringify({
							version: 1,
							claims: [
								...current.claims,
								{
									containerKey: 'devstack-main-sui',
									pid: 0,
									startTime: 1,
									hostname: hostname(),
									claimedAt: 1,
								},
							],
						}),
					);

					const result = yield* removeClaim(paths, 'devstack-main-sui');

					expect(result.lastClaimReleased).toBe(true);
					expect((yield* readClaims(paths)).claims).toEqual([]);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
		ROSTER_TEST_TIMEOUT_MS,
	);

	it.effect(
		'pruneStaleClaims keeps foreign-host claims conservative',
		() =>
			Effect.gen(function* () {
				const root = freshRoot();
				const paths = pathsFor(root);
				try {
					const claimsFile = join(root, 'app', 'main', 'container-claims.json');
					yield* claim(paths);
					writeFileSync(
						claimsFile,
						JSON.stringify({
							version: 1,
							claims: [
								{
									containerKey: 'devstack-main-sui',
									pid: 0,
									startTime: 1,
									hostname: 'other-host',
									claimedAt: 1,
								},
							],
						}),
					);

					const doc = yield* pruneStaleClaims(paths);

					expect(doc.claims).toHaveLength(1);
					expect(doc.claims[0]?.hostname).toBe('other-host');
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
		ROSTER_TEST_TIMEOUT_MS,
	);
});
