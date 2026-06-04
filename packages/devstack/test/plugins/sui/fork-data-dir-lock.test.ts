// Fork data-dir mutual-exclusion holder protocol (the 1B heartbeat-
// holder protocol) — the load-bearing concurrent-acquire invariant.
//
// Two stacks pointed at the SAME `<stackRoot>/sui-fork/<key>` data dir
// would corrupt the fork binary's RocksDB if both wrote. The fix
// serializes them with an on-disk HOLDER file (`holder.json`) guarded
// by the brief `stack.lock`: the first claimer wins, a second live-peer
// claim fails with an actionable `SuiPluginError`, and a released /
// dead holder is reclaimable.
//
// Seam: `acquireForkDataDirHolder(stackLockFile, dataDir)` — exported
// from `fork-orchestration.ts`, requires only a `Scope` (it talks to
// disk via node:fs sync; no FileSystem service, no StackPaths, no
// container, no upstream RPC). That makes the invariant fully
// deterministic to drive against real temp dirs. A full fork-mode e2e
// would need a live upstream RPC (flaky/slow) — deliberately NOT done
// here; this validates the holder INVARIANT directly.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, hostname as nodeHostname } from 'node:os';
import { join } from 'node:path';

import { Deferred, Effect, Exit, Fiber, Option, Scope } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	acquireForkDataDirHolder,
	forkHolderPath,
	type ForkLockHolder,
} from '../../../src/plugins/sui/fork-orchestration.ts';
import { atomicWriteJsonSync } from '../../../src/substrate/runtime/atomic-write.ts';

/** A fresh `<root>/sui-fork/<key>` layout under an OS temp dir. The
 *  caller cleans `root` up. `stackLockFile` sits at the stack root,
 *  mirroring `StackPaths.stackLockFile`. */
interface ForkTempLayout {
	readonly root: string;
	readonly dataDir: string;
	readonly stackLockFile: string;
	readonly cleanup: () => void;
}

const makeForkTempLayout = (): ForkTempLayout => {
	const root = mkdtempSync(join(tmpdir(), 'devstack-fork-lock-'));
	const dataDir = join(root, 'sui-fork', 'deadbeefdeadbeef');
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	return {
		root,
		dataDir,
		stackLockFile: join(root, 'stack.lock'),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
};

/** A pid that is guaranteed not to be a live process — drives the
 *  same-host `isPidAlive(holder.pid) === false` branch of
 *  `isForkHolderAlive`, marking the on-disk holder as a dead claim a
 *  new acquire may reclaim. `0x7fffffff` is above any real pid. */
const DEAD_PID = 0x7fffffff;

/** Write a holder file by hand (the on-disk shape is plain
 *  `JSON.stringify` of `ForkLockHolder`, via `atomicWriteJsonSync` —
 *  no versioned envelope). Used to seed a dead foreign claim that a
 *  fresh acquire should be able to reclaim. */
const writeRawHolder = (dataDir: string, holder: ForkLockHolder): void =>
	atomicWriteJsonSync(forkHolderPath(dataDir), holder);

const readRawHolder = (dataDir: string): ForkLockHolder =>
	JSON.parse(readFileSync(forkHolderPath(dataDir), 'utf8')) as ForkLockHolder;

describe('sui fork data-dir holder protocol', () => {
	it.effect('first acquire writes a live holder file and returns the holder', () =>
		Effect.gen(function* () {
			const layout = makeForkTempLayout();
			yield* Effect.addFinalizer(() => Effect.sync(layout.cleanup));

			const holder = yield* acquireForkDataDirHolder(layout.stackLockFile, layout.dataDir);

			// Returned holder is this process on this host.
			expect(holder.pid).toBe(process.pid);
			expect(holder.host).toBe(nodeHostname());
			expect(holder.instanceId).toEqual(expect.any(String));
			expect(holder.startedAt).toEqual(expect.any(Number));
			// startTime is the `ps -o lstart` hash (number) on POSIX, or
			// null where the probe can't run — either is valid here.
			expect(holder.startTime === null || typeof holder.startTime === 'number').toBe(true);

			// Holder file landed on disk and matches what was returned.
			expect(existsSync(forkHolderPath(layout.dataDir))).toBe(true);
			const onDisk = readRawHolder(layout.dataDir);
			expect(onDisk.instanceId).toBe(holder.instanceId);
			expect(onDisk.pid).toBe(holder.pid);
		}),
	);

	it.effect('second acquire against a live holder fails with the actionable fork-lock error', () =>
		Effect.gen(function* () {
			const layout = makeForkTempLayout();
			yield* Effect.addFinalizer(() => Effect.sync(layout.cleanup));

			// First holder stays live for the whole test (its scope is the
			// test's implicit scope — the heartbeat fiber never gets a
			// chance to harvest its own claim, and our pid is alive).
			const first = yield* acquireForkDataDirHolder(layout.stackLockFile, layout.dataDir);

			// Second claim against the SAME data dir while the first is
			// live must fail — running it in its own child scope so its
			// would-be finalizer does not clobber the first holder.
			const exit = yield* Effect.scoped(
				acquireForkDataDirHolder(layout.stackLockFile, layout.dataDir),
			).pipe(Effect.exit);

			expect(Exit.isFailure(exit)).toBe(true);
			const err = Exit.findErrorOption(exit);
			expect(Option.isSome(err)).toBe(true);
			if (Option.isSome(err)) {
				expect(err.value._tag).toBe('SuiPluginError');
				expect(err.value.phase).toBe('fork-lock');
				// Actionable: names the holding pid + host so the operator
				// can find the stack that owns the dir.
				expect(err.value.message).toContain(`pid ${first.pid}`);
				expect(err.value.message).toContain(first.host);
			}

			// The live holder on disk is untouched — still the first claim.
			expect(readRawHolder(layout.dataDir).instanceId).toBe(first.instanceId);
		}),
	);

	it.effect('release (scope close) removes the holder and allows re-acquire', () =>
		Effect.gen(function* () {
			const layout = makeForkTempLayout();
			yield* Effect.addFinalizer(() => Effect.sync(layout.cleanup));

			// Acquire under an explicit closeable scope so we control the
			// release point precisely.
			const firstScope = yield* Scope.make();
			const first = yield* Scope.provide(
				acquireForkDataDirHolder(layout.stackLockFile, layout.dataDir),
				firstScope,
			);
			expect(existsSync(forkHolderPath(layout.dataDir))).toBe(true);

			// Closing the scope runs the finalizer that unlinks the holder.
			yield* Scope.close(firstScope, Exit.void);
			expect(existsSync(forkHolderPath(layout.dataDir))).toBe(false);

			// A fresh claim against the now-free dir succeeds with a new
			// holder identity.
			const second = yield* acquireForkDataDirHolder(layout.stackLockFile, layout.dataDir);
			expect(second.instanceId).not.toBe(first.instanceId);
			expect(existsSync(forkHolderPath(layout.dataDir))).toBe(true);
			expect(readRawHolder(layout.dataDir).instanceId).toBe(second.instanceId);
		}),
	);

	it.effect('a dead-pid holder file is reclaimable by a new acquire', () =>
		Effect.gen(function* () {
			const layout = makeForkTempLayout();
			yield* Effect.addFinalizer(() => Effect.sync(layout.cleanup));

			// Seed a holder naming a DEAD pid on THIS host — the crash-
			// before-finalizer case. `isForkHolderAlive` probes the pid
			// (same host) and finds it dead, so the dir is reclaimable. The
			// `startTime` is a stale hash; `isPidAlive` short-circuits to
			// dead before the start-time check ever runs.
			const stale: ForkLockHolder = {
				pid: DEAD_PID,
				host: nodeHostname(),
				instanceId: 'stale-crashed-holder',
				startedAt: Date.now(),
				startTime: 123456,
			};
			writeRawHolder(layout.dataDir, stale);

			const reclaimed = yield* acquireForkDataDirHolder(layout.stackLockFile, layout.dataDir);

			// We took over: holder file now names this process, not the
			// dead pid.
			expect(reclaimed.pid).toBe(process.pid);
			expect(reclaimed.instanceId).not.toBe(stale.instanceId);
			expect(readRawHolder(layout.dataDir).instanceId).toBe(reclaimed.instanceId);
		}),
	);

	it.effect('a recycled-PID holder (live pid, mismatched startTime) is reclaimable', () =>
		Effect.gen(function* () {
			const layout = makeForkTempLayout();
			yield* Effect.addFinalizer(() => Effect.sync(layout.cleanup));

			// Seed a holder on THIS host naming a LIVE pid (our own) but a
			// `startTime` that can never match a real probe — FNV-1a is
			// `>>> 0` (always non-negative), so -1 is unreachable. This is
			// the recycled-PID case: a crashed stack's pid was handed to an
			// unrelated live process. Pre-fix, `isPidAlive` alone read this
			// as "in use" forever; post-fix the start-time mismatch reclaims
			// it. NOTE: skip the assertion only on platforms where the
			// start-time probe is unavailable (the conservative null branch
			// would correctly keep the holder ALIVE there).
			const recycled: ForkLockHolder = {
				pid: process.pid,
				host: nodeHostname(),
				instanceId: 'recycled-pid-holder',
				startedAt: Date.now(),
				startTime: -1,
			};
			writeRawHolder(layout.dataDir, recycled);

			const exit = yield* Effect.scoped(
				acquireForkDataDirHolder(layout.stackLockFile, layout.dataDir),
			).pipe(Effect.exit);

			expect(Exit.isSuccess(exit)).toBe(true);
			if (Exit.isSuccess(exit)) {
				expect(exit.value.instanceId).not.toBe(recycled.instanceId);
			}
		}),
	);

	it.effect('two concurrent acquires against the same dir: exactly one wins', () =>
		Effect.gen(function* () {
			const layout = makeForkTempLayout();
			yield* Effect.addFinalizer(() => Effect.sync(layout.cleanup));

			// A barrier so both fibers race the claim critical section at the
			// same instant — the `stack.lock` must serialize them so exactly
			// one writes its holder and the other sees a live peer.
			const start = yield* Deferred.make<void>();
			const racer = () =>
				Effect.gen(function* () {
					yield* Deferred.await(start);
					// Hold the claim in the test scope (no inner Effect.scoped) so
					// the winner keeps its holder LIVE while the loser races — an
					// immediate release would let both acquire and defeat the test.
					return yield* acquireForkDataDirHolder(layout.stackLockFile, layout.dataDir);
				}).pipe(Effect.forkScoped);

			const fiberA = yield* racer();
			const fiberB = yield* racer();
			yield* Deferred.succeed(start, undefined);

			const exitA = yield* Fiber.await(fiberA);
			const exitB = yield* Fiber.await(fiberB);

			// Exactly one success, one failure.
			const successes = [exitA, exitB].filter(Exit.isSuccess);
			const failures = [exitA, exitB].filter(Exit.isFailure);
			expect(successes.length).toBe(1);
			expect(failures.length).toBe(1);

			// The loser failed with the actionable fork-lock error.
			const loserErr = Exit.findErrorOption(failures[0]!);
			expect(Option.isSome(loserErr)).toBe(true);
			if (Option.isSome(loserErr)) {
				expect(loserErr.value._tag).toBe('SuiPluginError');
				expect(loserErr.value.phase).toBe('fork-lock');
			}
		}),
	);
});
