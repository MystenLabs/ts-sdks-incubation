// Bug #14 regression: the helper fibers forked inside `saveImages`
// (`Stream.unwrap`'s inner `Effect.gen`) MUST ride the consuming
// stream's scope. With `Effect.forkChild` they were unscoped — a
// consumer that interrupted before the stream's natural completion
// would skip `Stream.ensuring(cleanup)`'s explicit `Fiber.interrupt`
// path and leak the stderr-drain + exit-await fibers (plus the
// spawned child).
//
// We exercise the post-fix `Effect.forkScoped` semantics directly: a
// long-running fake `docker save` is spawned, the consuming scope is
// interrupted before the stream finishes draining, and we assert the
// child process actually exits. A leaking fiber would keep the child
// alive past scope close.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Data, Deferred, Effect, Fiber, Layer, Stream } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import { DockerHost, DockerSpawner, layerDockerHost } from '../../../src/runtime/docker/client.ts';
import { saveImages } from '../../../src/runtime/docker/image.ts';

const layerDockerSpawnerFromNode: Layer.Layer<DockerSpawner, never, ChildProcessSpawner> =
	Layer.effect(
		DockerSpawner,
		Effect.gen(function* () {
			return yield* ChildProcessSpawner;
		}),
	);

const fakeDockerLayer = (bin: string): Layer.Layer<DockerHost | DockerSpawner> =>
	Layer.merge(
		layerDockerHost({ bin }),
		layerDockerSpawnerFromNode.pipe(
			Layer.provideMerge(
				NodeChildProcessSpawner.layer.pipe(
					Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
				),
			),
		),
	);

/** Fake `docker` binary. On `save` it writes its PID then sleeps
 *  forever (emitting one byte/sec so the stream stays open); on
 *  `image rm` it succeeds silently. */
const writeFakeDocker = (bin: string, pidfile: string): void => {
	writeFileSync(
		bin,
		[
			'#!/bin/sh',
			'if [ "$1" = "save" ]; then',
			`  echo $$ > ${JSON.stringify(pidfile)}`,
			'  while :; do',
			'    printf "x"',
			'    sleep 1',
			'  done',
			'fi',
			'if [ "$1" = "image" ] && [ "$2" = "rm" ]; then',
			'  exit 0',
			'fi',
			'exit 0',
			'',
		].join('\n'),
	);
	chmodSync(bin, 0o755);
};

const isProcessAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Typed failure surfaced when `waitForFile` exhausts its deadline.
 *  Carries the probed `path` and `waitedMs` so callers and test logs
 *  can identify the wait that timed out without parsing a string. */
class WaitForFileTimeoutError extends Data.TaggedError('WaitForFileTimeoutError')<{
	readonly path: string;
	readonly waitedMs: number;
}> {}

const waitForFile = (
	path: string,
	timeoutMs: number,
): Effect.Effect<void, WaitForFileTimeoutError> =>
	Effect.gen(function* () {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (existsSync(path)) return;
			yield* Effect.sleep('25 millis');
		}
		// Surface the timeout via a tagged error rather than `Effect.die`
		// with a string. Without this, callers that `readFileSync(path)`
		// next get an ENOENT with no breadcrumb back to the wait —
		// making "fiber never wrote the pidfile" look like an unrelated
		// I/O bug. The typed error also lets callers `catchTag` for
		// retry / fallback logic without string-matching cause messages.
		yield* Effect.fail(new WaitForFileTimeoutError({ path, waitedMs: timeoutMs }));
	});

const waitUntilDead = (pid: number, timeoutMs: number): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!isProcessAlive(pid)) return true;
			yield* Effect.sleep('25 millis');
		}
		return !isProcessAlive(pid);
	});

describe('saveImages fiber cleanup (Bug #14)', () => {
	// `it.live` because wall-clock waits drive the child-process probe;
	// TestClock can't observe a real `kill(pid, 0)` round trip.
	it.live(
		'fibers forked inside saveImages ride the stream scope and are interrupted on early termination',
		() =>
			Effect.gen(function* () {
				const root = mkdtempSync(join(tmpdir(), 'docker-fiber-cleanup-'));
				try {
					const bin = join(root, 'docker');
					const pidfile = join(root, 'docker.pid');
					writeFakeDocker(bin, pidfile);

					const consumerStarted = yield* Deferred.make<void>();

					// Fork a consumer that drains the stream in its own scope.
					// When we interrupt the fiber, that scope closes — and the
					// stderr/exit fibers, having been forked via
					// `Effect.forkScoped`, MUST be interrupted alongside it,
					// which in turn lets the spawner's own scope close and
					// kill the child.
					const consumer = Effect.gen(function* () {
						yield* Deferred.succeed(consumerStarted, void 0);
						yield* Stream.runDrain(saveImages(['fiber-leak-test:tag']));
					}).pipe(Effect.scoped, Effect.provide(fakeDockerLayer(bin)));

					const consumerFiber = yield* Effect.forkScoped(consumer);

					yield* Deferred.await(consumerStarted);
					yield* waitForFile(pidfile, 5_000);
					const pid = Number.parseInt(readFileSync(pidfile, 'utf8').trim(), 10);
					expect(Number.isFinite(pid)).toBe(true);
					expect(isProcessAlive(pid)).toBe(true);

					yield* Fiber.interrupt(consumerFiber);

					const dead = yield* waitUntilDead(pid, 5_000);
					expect(dead).toBe(true);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}).pipe(Effect.scoped),
		15_000,
	);
});
