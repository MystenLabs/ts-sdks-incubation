// CrossProcessLock service + two Layers — tests.
//
// `layerCrossProcessLockInProcess` is the in-memory semaphore fallback;
// `layerCrossProcessLockFlock` is the O_EXCL/PID-liveness-backed
// production Layer that adapts `acquireStackLock`.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Cause, Deferred, Effect, Exit, Layer, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	CrossProcessLock,
	layerCrossProcessLockFlock,
	layerCrossProcessLockInProcess,
} from '../../../src/substrate/runtime/cross-process-lock.ts';
import { ownHolder } from '../../../src/substrate/runtime/cross-process/liveness.ts';
import { StackPathsService } from '../../../src/substrate/runtime/paths.ts';
import type { StackPaths } from '../../../src/substrate/runtime/paths.ts';

const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'cross-process-lock-test-'));

const stackPathsFor = (stackRoot: string): StackPaths => ({
	stackRoot,
	stateFile: join(stackRoot, 'state.json'),
	stateLockHint: join(stackRoot, 'state.json.lock'),
	cacheDir: join(stackRoot, 'cache'),
	snapshotDir: join(stackRoot, 'snapshots'),
	stackLockFile: join(stackRoot, 'stack.lock'),
	rosterFile: join(stackRoot, 'roster.json'),
	snapshotReservationFile: join(stackRoot, 'snapshot.reservation'),
	cacheEntry: (namespace, chain, contentHash) => ({
		dir: join(stackRoot, 'cache', namespace, chain),
		file: join(stackRoot, 'cache', namespace, chain, `${contentHash}.json`),
	}),
	cacheChainDir: (namespace, chain) => join(stackRoot, 'cache', namespace, chain),
	cacheNamespaceDir: (namespace) => join(stackRoot, 'cache', namespace),
});

const stackPathsLayer = (stackRoot: string): Layer.Layer<StackPathsService> =>
	Layer.succeed(StackPathsService)(stackPathsFor(stackRoot));

describe('layerCrossProcessLockInProcess', () => {
	it.effect('withLock serializes concurrent fibers (same process)', () =>
		Effect.gen(function* () {
			const lock = yield* CrossProcessLock;
			const log = yield* Ref.make<ReadonlyArray<string>>([]);
			const append = (s: string) => Ref.update(log, (prev) => [...prev, s]);

			const a = lock.withLock(
				Effect.gen(function* () {
					yield* append('a-in');
					yield* Effect.sleep('10 millis');
					yield* append('a-out');
				}),
			);
			const b = lock.withLock(
				Effect.gen(function* () {
					yield* append('b-in');
					yield* append('b-out');
				}),
			);

			yield* Effect.all([a, b], { concurrency: 'unbounded' });
			const events = yield* Ref.get(log);
			const aStart = events.indexOf('a-in');
			const aEnd = events.indexOf('a-out');
			const bStart = events.indexOf('b-in');
			const bEnd = events.indexOf('b-out');
			expect(aStart).toBeGreaterThanOrEqual(0);
			expect(bStart).toBeGreaterThanOrEqual(0);
			const aRunFirst = aEnd < bStart;
			const bRunFirst = bEnd < aStart;
			expect(aRunFirst || bRunFirst).toBe(true);
		}).pipe(Effect.provide(layerCrossProcessLockInProcess)),
	);

	it.effect('withLock propagates the body Effect channel', () =>
		Effect.gen(function* () {
			const lock = yield* CrossProcessLock;
			const result = yield* lock.withLock(Effect.succeed(42));
			expect(result).toBe(42);
		}).pipe(Effect.provide(layerCrossProcessLockInProcess)),
	);

	it.effect('withLock propagates failures through the body channel', () =>
		Effect.gen(function* () {
			const lock = yield* CrossProcessLock;
			const exit = yield* lock.withLock(Effect.fail('boom' as const)).pipe(Effect.exit);
			expect(exit._tag).toBe('Failure');
		}).pipe(Effect.provide(layerCrossProcessLockInProcess)),
	);
});

describe('layerCrossProcessLockFlock', () => {
	it.effect('withLock writes the stack.lock file and unlinks on release', () => {
		const root = freshRoot();
		const stackRoot = join(root, 'app', 'main');
		return Effect.gen(function* () {
			try {
				const lock = yield* CrossProcessLock;
				const lockPath = join(stackRoot, 'stack.lock');
				yield* lock.withLock(
					Effect.sync(() => {
						expect(existsSync(lockPath)).toBe(true);
					}),
				);
				expect(existsSync(lockPath)).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(
			Effect.provide(layerCrossProcessLockFlock.pipe(Layer.provide(stackPathsLayer(stackRoot)))),
		);
	});

	it.effect('withLock serializes concurrent fibers via the on-disk lock', () => {
		const root = freshRoot();
		const stackRoot = join(root, 'app', 'main');
		return Effect.gen(function* () {
			try {
				const lock = yield* CrossProcessLock;
				const log = yield* Ref.make<ReadonlyArray<string>>([]);
				const append = (s: string) => Ref.update(log, (prev) => [...prev, s]);

				yield* Effect.all(
					[
						lock.withLock(
							Effect.gen(function* () {
								yield* append('a-in');
								yield* Effect.sleep('5 millis');
								yield* append('a-out');
							}),
						),
						lock.withLock(
							Effect.gen(function* () {
								yield* append('b-in');
								yield* append('b-out');
							}),
						),
					],
					{ concurrency: 'unbounded' },
				);
				const events = yield* Ref.get(log);
				const aEnd = events.indexOf('a-out');
				const bStart = events.indexOf('b-in');
				const bEnd = events.indexOf('b-out');
				const aStart = events.indexOf('a-in');
				const aRunFirst = aEnd < bStart;
				const bRunFirst = bEnd < aStart;
				expect(aRunFirst || bRunFirst).toBe(true);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(
			Effect.provide(layerCrossProcessLockFlock.pipe(Layer.provide(stackPathsLayer(stackRoot)))),
		);
	});

	it.effect('re-acquire after release succeeds', () => {
		const root = freshRoot();
		const stackRoot = join(root, 'app', 'main');
		return Effect.gen(function* () {
			try {
				const lock = yield* CrossProcessLock;
				const seen = yield* Ref.make(0);
				yield* lock.withLock(Ref.update(seen, (n) => n + 1));
				yield* lock.withLock(Ref.update(seen, (n) => n + 1));
				expect(yield* Ref.get(seen)).toBe(2);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(
			Effect.provide(layerCrossProcessLockFlock.pipe(Layer.provide(stackPathsLayer(stackRoot)))),
		);
	});

	it.effect('body errors release the lock so a subsequent acquire succeeds', () => {
		const root = freshRoot();
		const stackRoot = join(root, 'app', 'main');
		const lockPath = join(stackRoot, 'stack.lock');
		return Effect.gen(function* () {
			try {
				const lock = yield* CrossProcessLock;
				const first = yield* lock.withLock(Effect.fail('nope' as const)).pipe(Effect.exit);
				expect(first._tag).toBe('Failure');
				expect(existsSync(lockPath)).toBe(false);
				const second = yield* lock.withLock(Effect.succeed('ok'));
				expect(second).toBe('ok');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(
			Effect.provide(layerCrossProcessLockFlock.pipe(Layer.provide(stackPathsLayer(stackRoot)))),
		);
	});

	it.effect(
		'acquire timeout surfaces as typed StackLockTimeoutError, not a defect',
		() => {
			// Regression for Phase C1 — earlier `Effect.orDie` shape
			// converted a peer-contention timeout into a fiber defect that
			// could crash the surrounding scope. The typed shape must
			// surface `StackLockTimeoutError` in the `E` channel so
			// consumers (state-store) can map it to their own error.
			const root = freshRoot();
			const stackRoot = join(root, 'app', 'main');
			const lockPath = join(stackRoot, 'stack.lock');
			// Plant a stack.lock body that points at THIS process — the
			// liveness probe sees the holder as alive (same pid +
			// start-time), so the acquire loop never reclaims and times
			// out cleanly. Default acquire window is 5s (per stack-lock
			// module).
			mkdirSync(dirname(lockPath), { recursive: true });
			writeFileSync(lockPath, JSON.stringify(ownHolder()));
			return Effect.gen(function* () {
				try {
					const lock = yield* CrossProcessLock;
					const exit = yield* lock.withLock(Effect.succeed('unreachable')).pipe(Effect.exit);
					expect(Exit.isFailure(exit)).toBe(true);
					if (Exit.isFailure(exit)) {
						// MUST be a typed Fail, NOT a Die. The whole
						// point of this regression: peer contention
						// cannot be a defect.
						expect(Cause.hasDies(exit.cause)).toBe(false);
						const fail = exit.cause.reasons.find(Cause.isFailReason);
						expect(fail).toBeDefined();
						if (fail !== undefined) {
							expect((fail.error as { _tag: string })._tag).toBe('StackLockTimeoutError');
						}
					}
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}).pipe(
				Effect.provide(layerCrossProcessLockFlock.pipe(Layer.provide(stackPathsLayer(stackRoot)))),
			);
		},
		{ timeout: 15_000 },
	);

	it.effect('parallel-stack instances do not share locks', () => {
		// Two distinct stack roots → two distinct on-disk lock files →
		// the layers materialize independent in-process semaphores too.
		// Acquiring both concurrently should NOT serialize them.
		const root = freshRoot();
		const stackA = join(root, 'app-a', 'main');
		const stackB = join(root, 'app-b', 'main');
		const layerA = layerCrossProcessLockFlock.pipe(Layer.provide(stackPathsLayer(stackA)));
		const layerB = layerCrossProcessLockFlock.pipe(Layer.provide(stackPathsLayer(stackB)));

		const programA = (gate: Deferred.Deferred<void>) =>
			Effect.gen(function* () {
				const lock = yield* CrossProcessLock;
				return yield* lock.withLock(
					Effect.gen(function* () {
						yield* Deferred.succeed(gate, undefined);
						yield* Effect.sleep('20 millis');
						return 'a-done';
					}),
				);
			}).pipe(Effect.provide(layerA));

		const programB = (gate: Deferred.Deferred<void>) =>
			Effect.gen(function* () {
				yield* Deferred.await(gate);
				const lock = yield* CrossProcessLock;
				return yield* lock.withLock(Effect.succeed('b-done'));
			}).pipe(Effect.provide(layerB));

		return Effect.gen(function* () {
			try {
				const gate = yield* Deferred.make<void>();
				const [a, b] = yield* Effect.all([programA(gate), programB(gate)], {
					concurrency: 'unbounded',
				});
				expect(a).toBe('a-done');
				expect(b).toBe('b-done');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	});
});
