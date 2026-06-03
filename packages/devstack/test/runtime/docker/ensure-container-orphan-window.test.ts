// Regression: orphan-container window between per-name-lock release and
// stop-finalizer registration.
//
// Before remediation, the post-`docker run` block (network attach → IP
// readback → inspect → addClaim → addFinalizer) ran OUTSIDE the per-name
// lock AND was interruptible. If `addClaim` failed (or an interrupt
// landed) before `addFinalizer` registered, the labelled-running
// container would have no scope-bound cleanup — stranded until the
// label-driven sweep ran later. This broke the per-scope contract
// (one `Effect.scoped` ⇒ one container managed).
//
// Fix: register the stop-on-scope-close finalizer BEFORE `addClaim`
// (and BEFORE the per-name lock release). Only the orphan-safety prefix
// (inspect → applyAction → publish-ports → finalizer-arm) runs
// uninterruptibly; the post-finalizer tail (assertOwned → network attach
// → IP readback → addClaim) runs interruptibly under `restore(...)`,
// since an interrupt there is safely handled by the now-armed finalizer.
// This test exercises the FAILURE (not interrupt) path: `addClaim` fails
// after the finalizer is armed, so scope close must still `docker stop`.
//
// This test forces an `addClaim` failure by pointing the roster file at
// a path under an existing regular file (so `mkdirSync(dirname(path))`
// throws ENOTDIR inside `withStackLock`). The container is reported
// running by the fake docker; we assert that despite the failure, the
// scope-close finalizer fires `docker stop` against the container.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Layer, Ref } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import type { EnsureContainerSpec } from '../../../src/contracts/container-runtime.ts';
import {
	DockerSpawner,
	layerDockerHost,
	type DockerHost,
} from '../../../src/runtime/docker/client.ts';
import { ensureContainer, type PerNameLockState } from '../../../src/runtime/docker/container.ts';
import { StackPathsService, type StackPaths } from '../../../src/substrate/runtime/paths.ts';

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

const stackPathsFor = (stackRoot: string, rosterFile: string): StackPaths => {
	const cacheDir = join(stackRoot, 'cache');
	const cacheNamespaceDir = (namespace: string): string => join(cacheDir, namespace);
	const cacheChainDir = (namespace: string, chain: string): string =>
		join(cacheNamespaceDir(namespace), chain);
	const cacheEntry = (
		namespace: string,
		chain: string,
		contentHash: string,
	): { readonly dir: string; readonly file: string } => {
		const dir = cacheChainDir(namespace, chain);
		return { dir, file: join(dir, `${contentHash}.json`) };
	};
	return {
		stackRoot,
		cacheDir,
		snapshotDir: join(stackRoot, 'snapshots'),
		// Point both lock and roster files into a path whose dirname is a
		// regular file — mkdirSync(dirname) inside withStackLock then fails
		// with ENOTDIR, surfacing as a typed roster/lock error that
		// ensureContainer maps to a DaemonUnreachable failure.
		stackLockFile: join(rosterFile, 'stack.lock'),
		rosterFile: join(rosterFile, 'roster.json'),
		containerClaimsFile: join(rosterFile, 'container-claims.json'),
		snapshotReservationFile: join(stackRoot, 'snapshot.reservation'),
		cacheEntry,
		cacheChainDir,
		cacheNamespaceDir,
	};
};

const stackPathsLayer = (
	stackRoot: string,
	rosterBlocker: string,
): Layer.Layer<StackPathsService> =>
	Layer.succeed(StackPathsService)(stackPathsFor(stackRoot, rosterBlocker));

describe('ensureContainer orphan-container window', () => {
	it(
		'stops the container at scope close when addClaim fails after docker run',
		{ timeout: 30_000 },
		async () => {
			const root = mkdtempSync(join(tmpdir(), 'docker-ensure-orphan-test-'));
			try {
				const bin = join(root, 'docker');
				const log = join(root, 'docker.log');
				const stackRoot = join(root, 'stack');
				mkdirSync(stackRoot, { recursive: true });
				// Regular file used to poison the roster path so that
				// `mkdirSync(dirname(stackLockFile))` throws ENOTDIR inside
				// addClaim's withStackLock → addClaim fails → ensureContainer
				// fails in the post-finalizer tail. The finalizer must
				// already be armed by that point.
				const rosterBlocker = join(root, 'roster-blocker');
				writeFileSync(rosterBlocker, 'not a directory');

				// Fake docker: inspect returns a matching, running container
				// (so decideRunAction picks `adopt`). `stop` (called by the
				// scope-close finalizer) is logged so the test can assert it
				// fired. Every other subcommand exits 0.
				const inspectJson = JSON.stringify([
					{
						Id: 'orphan-id',
						Image: 'sha256:desired',
						HostConfig: { PortBindings: {} },
						State: { Running: true, Paused: false, ExitCode: 0 },
						Config: {
							Image: 'img:desired',
							Labels: {
								'devstack.managed': 'true',
								'devstack.app': 'app',
								'devstack.stack': 'main',
								'devstack.plugin': 'postgres',
								'devstack.role': 'db',
							},
						},
						NetworkSettings: { Networks: {} },
					},
				]);
				writeFileSync(
					bin,
					[
						'#!/bin/sh',
						`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
						'if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then',
						`  printf '%s\\n' ${JSON.stringify(inspectJson)}`,
						'  exit 0',
						'fi',
						'if [ "$1" = "inspect" ]; then',
						`  printf '%s\\n' ${JSON.stringify(inspectJson)}`,
						'  exit 0',
						'fi',
						'exit 0',
						'',
					].join('\n'),
				);
				chmodSync(bin, 0o755);

				const spec: EnsureContainerSpec = {
					name: 'devstack-orphan',
					image: { digest: 'sha256:desired', tag: 'img:desired' },
					labels: {
						app: 'app',
						stack: 'main',
						plugin: 'postgres',
						role: 'db',
					},
					recreate: 'on-failure',
				};

				const exit = await Effect.runPromise(
					Effect.scoped(
						Effect.gen(function* () {
							const perNameLock = yield* Ref.make<PerNameLockState>(new Map());
							return yield* ensureContainer(spec, { cycle: 1, perNameLock });
						}),
					).pipe(
						Effect.provide(
							Layer.mergeAll(fakeDockerLayer(bin), stackPathsLayer(stackRoot, rosterBlocker)),
						),
						Effect.exit,
					),
				);

				// ensureContainer fails because addClaim cannot create its
				// lock-file directory (we poisoned the path).
				expect(Exit.isFailure(exit)).toBe(true);
				const err = Exit.findErrorOption(exit);
				expect(err._tag).toBe('Some');

				// The finalizer was armed BEFORE addClaim (in the
				// uninterruptible prefix), so even though addClaim fails in
				// the interruptible tail, scope close must have run
				// `docker stop` on the container.
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				const stopInvocations = lines.filter(
					(line) => line.startsWith('stop ') && line.includes('devstack-orphan'),
				);
				expect(stopInvocations.length).toBeGreaterThanOrEqual(1);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});
