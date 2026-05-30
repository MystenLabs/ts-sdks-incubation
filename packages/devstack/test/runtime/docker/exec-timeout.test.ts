// Bug regression: the docker subprocess lifecycle has two related
// timeout/kill gaps the file headers claimed were already covered.
//
//   Bug 1 — `dockerExec` had no per-call timeout. The `exec.ts` header
//     claimed a wall-clock `Effect.timeout`, but `dockerExec` invoked
//     `dockerRunOk('exec', …)` with none. A wedged `docker exec` (hung
//     container `sh`, half-open daemon socket) hung the fiber forever;
//     callers driving it through `waitForProbe` WITHOUT `attemptTimeoutMs`
//     never timed it out (the probe only checks its deadline between
//     attempts). Fix: an optional `timeoutMillis` that collapses a
//     timeout into a typed `DaemonUnreachable` instead of hanging.
//
//   Bug 2 — the spawn seam (`client.ts` `dockerCommand`) set neither
//     `killSignal` nor `forceKillAfter`, so the Node spawner's
//     scope-close finalizer sent ONE SIGTERM then waited indefinitely
//     for the child. A timeout-interrupt could then block on scope-close
//     if the docker CLI ignored SIGTERM — the promised SIGTERM→SIGKILL
//     escalation did not exist. Fix: `forceKillAfter` on the spawn path.
//
// Both are exercised against the real `NodeChildProcessSpawner` with a
// fake `docker` shell binary, mirroring `image-load-fiber-cleanup.test.ts`.
// `it.live` because wall-clock timeouts and real `kill(pid, 0)` round
// trips can't be driven by TestClock.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Layer, Option } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import {
	DockerHost,
	DockerSpawner,
	dockerExec,
	layerDockerHost,
} from '../../../src/runtime/docker/index.ts';

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

/** Fake `docker` that hangs forever on `exec`, emitting one byte/sec so
 *  the captured stdout stream stays open (mirrors the wedged-`sh` /
 *  half-open-socket failure mode). It traps SIGTERM and IGNORES it, so
 *  the only thing that can reap it is SIGKILL — letting us assert the
 *  `forceKillAfter` escalation actually fires. The PID is written so the
 *  test can observe liveness directly. */
const writeWedgedDocker = (bin: string, pidfile: string): void => {
	writeFileSync(
		bin,
		[
			'#!/bin/sh',
			'if [ "$1" = "exec" ]; then',
			// Ignore SIGTERM (15) entirely; only SIGKILL (uncatchable) ends us.
			'  trap "" TERM',
			`  echo $$ > ${JSON.stringify(pidfile)}`,
			'  while :; do',
			'    printf "x"',
			'    sleep 1',
			'  done',
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

const waitForFile = (path: string, timeoutMs: number): Effect.Effect<void> =>
	Effect.gen(function* () {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (existsSync(path)) return;
			yield* Effect.sleep('25 millis');
		}
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

describe('dockerExec timeout + force-kill escalation', () => {
	// Bug 1: a wedged exec that exceeds `timeoutMillis` fails with the
	// typed `DaemonUnreachable` error rather than hanging the fiber.
	it.live(
		'a wedged docker exec exceeding timeoutMillis fails with DaemonUnreachable (not a hang)',
		() =>
			Effect.gen(function* () {
				const root = mkdtempSync(join(tmpdir(), 'docker-exec-timeout-'));
				try {
					const bin = join(root, 'docker');
					const pidfile = join(root, 'docker.pid');
					writeWedgedDocker(bin, pidfile);

					const exit = yield* dockerExec('wedged-container', ['sh', '-c', 'sleep 999'], {
						timeoutMillis: 250,
					}).pipe(Effect.provide(fakeDockerLayer(bin)), Effect.exit);

					expect(Exit.isFailure(exit)).toBe(true);
					// The timeout collapses into the daemon-unreachable
					// envelope this surface already produces via wrapGeneric,
					// so callers see one shape.
					const errOpt = Exit.findErrorOption(exit);
					expect(Option.isSome(errOpt)).toBe(true);
					if (Option.isSome(errOpt)) {
						const err = errOpt.value;
						expect(err._tag).toBe('DaemonUnreachable');
						expect(err).toMatchObject({ op: 'docker.exec' });
						if (err._tag === 'DaemonUnreachable') {
							expect(err.detail).toContain('timed out');
						}
					}
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
		15_000,
	);

	// Bug 2: when the timeout interrupts the exec, the spawner's
	// scope-close finalizer must escalate SIGTERM→SIGKILL. The fake
	// docker ignores SIGTERM, so a SIGTERM-only finalizer (the pre-fix
	// behavior) would leave the child alive forever. We assert the child
	// PID actually dies — which can only happen via the `forceKillAfter`
	// SIGKILL.
	it.live(
		'on timeout the docker CLI child is force-killed (SIGKILL) even when it ignores SIGTERM',
		() =>
			Effect.gen(function* () {
				const root = mkdtempSync(join(tmpdir(), 'docker-exec-forcekill-'));
				try {
					const bin = join(root, 'docker');
					const pidfile = join(root, 'docker.pid');
					writeWedgedDocker(bin, pidfile);

					const exit = yield* dockerExec('wedged-container', ['sh', '-c', 'sleep 999'], {
						// Generous timeout: the child must finish fork/exec and
						// write its pidfile BEFORE the exec is interrupted and
						// force-killed. Under heavy parallel test load a tight
						// 250ms can lose the race to shell startup, leaving the
						// pidfile (and the liveness assertion below) absent.
						timeoutMillis: 2500,
					}).pipe(Effect.provide(fakeDockerLayer(bin)), Effect.exit);
					expect(Exit.isFailure(exit)).toBe(true);

					// The pidfile is written at child startup, well before the
					// generous timeout fires, so it reliably exists here.
					yield* waitForFile(pidfile, 5_000);
					const pid = Number.parseInt(readFileSync(pidfile, 'utf8').trim(), 10);
					expect(Number.isFinite(pid)).toBe(true);

					// SIGTERM is trapped/ignored by the child, so only the
					// `forceKillAfter` SIGKILL can reap it. Allow longer than
					// the 5s grace for the escalation to complete.
					const dead = yield* waitUntilDead(pid, 10_000);
					expect(dead).toBe(true);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
		20_000,
	);
});
