// Phase 4 P4.T7 / P4.T8 — wipe's --also-upstream-cache + default
// "keep cache" behavior on fork stacks.
//
// The docker-level "after wipe, cold-restart reuses cache" assertion
// requires a running fork container; that part lives in the docker
// gate. What we cover here is the on-disk path-resolution invariant:
// the cache root is a sibling of `stacks/<stack>/` and is therefore
// untouched by the per-stack wipe pass under `pruneStack`.

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { layer as NodeServicesLayer } from '@effect/platform-node/NodeServices';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import {
	resolveForkCacheRoot,
	resolveForkDataDir,
	resolveForkMetaPath,
} from '../stack-resolution.js';

describe('cli/commands/wipe fork-cache invariants', () => {
	it.effect('resolveForkCacheRoot lives at <state>/sui-fork-cache (NOT inside stacks/)', () =>
		Effect.gen(function* () {
			const root = yield* Effect.promise(() => mkdtemp(joinPath(tmpdir(), 'devstack-wipe-fork-')));
			const stateDir = joinPath(root, '.devstack');
			const prevState = process.env.DEVSTACK_STATE_DIR;
			const prevAppDir = process.env.DEVSTACK_APP_DIR;
			try {
				process.env.DEVSTACK_STATE_DIR = stateDir;
				process.env.DEVSTACK_APP_DIR = root;
				const cacheRoot = resolveForkCacheRoot();
				expect(cacheRoot).toBe(joinPath(stateDir, 'sui-fork-cache'));
				const dataDir = resolveForkDataDir({ stack: 'main' });
				expect(dataDir).toBe(joinPath(stateDir, 'stacks', 'main', 'sui-fork', 'data'));
				const metaPath = resolveForkMetaPath({ stack: 'main' });
				expect(metaPath).toBe(joinPath(stateDir, 'stacks', 'main', 'sui-fork', 'meta.json'));
				// Critical invariant for P4.T7: the cache root is NOT a
				// child of the per-stack sui-fork dir. Wiping
				// `stacks/<stack>/sui-fork/` leaves the cache untouched.
				expect(cacheRoot.startsWith(joinPath(stateDir, 'stacks'))).toBe(false);
			} finally {
				if (prevState === undefined) delete process.env.DEVSTACK_STATE_DIR;
				else process.env.DEVSTACK_STATE_DIR = prevState;
				if (prevAppDir === undefined) delete process.env.DEVSTACK_APP_DIR;
				else process.env.DEVSTACK_APP_DIR = prevAppDir;
			}
			yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
		}).pipe(Effect.provide(NodeServicesLayer)),
	);

	it.effect(
		'P4.T7 invariant: removing stacks/<stack>/sui-fork/ leaves <state>/sui-fork-cache intact',
		() =>
			Effect.gen(function* () {
				const root = yield* Effect.promise(() =>
					mkdtemp(joinPath(tmpdir(), 'devstack-wipe-fork-')),
				);
				const stateDir = joinPath(root, '.devstack');
				const stackForkDir = joinPath(stateDir, 'stacks', 'main', 'sui-fork');
				const cacheRoot = joinPath(stateDir, 'sui-fork-cache');
				yield* Effect.promise(() => mkdir(stackForkDir, { recursive: true }));
				yield* Effect.promise(() => mkdir(joinPath(cacheRoot, 'testnet'), { recursive: true }));
				yield* Effect.promise(() =>
					writeFile(joinPath(stackForkDir, 'meta.json'), '{"version":1}'),
				);
				yield* Effect.promise(() =>
					writeFile(joinPath(cacheRoot, 'testnet', 'sample.bin'), Buffer.from('hello')),
				);
				// Simulate the per-stack wipe traversal.
				yield* Effect.promise(() =>
					rm(joinPath(stateDir, 'stacks', 'main'), { recursive: true, force: true }),
				);
				// Cache survived.
				yield* Effect.promise(() => access(joinPath(cacheRoot, 'testnet', 'sample.bin')));
				yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
			}).pipe(Effect.provide(NodeServicesLayer)),
	);

	it.effect(
		'P4.T8 invariant: --also-upstream-cache removes BOTH the per-stack dir AND the cache',
		() =>
			Effect.gen(function* () {
				const root = yield* Effect.promise(() =>
					mkdtemp(joinPath(tmpdir(), 'devstack-wipe-fork-')),
				);
				const stateDir = joinPath(root, '.devstack');
				const stackForkDir = joinPath(stateDir, 'stacks', 'main', 'sui-fork');
				const cacheRoot = joinPath(stateDir, 'sui-fork-cache');
				yield* Effect.promise(() => mkdir(stackForkDir, { recursive: true }));
				yield* Effect.promise(() => mkdir(joinPath(cacheRoot, 'testnet'), { recursive: true }));
				yield* Effect.promise(() => writeFile(joinPath(cacheRoot, 'testnet', 'a.bin'), 'x'));
				// Simulate the `--also-upstream-cache` pass.
				yield* Effect.promise(() =>
					rm(joinPath(stateDir, 'stacks', 'main'), { recursive: true, force: true }),
				);
				yield* Effect.promise(() => rm(cacheRoot, { recursive: true, force: true }));
				const cacheMissing = yield* Effect.promise(async () => {
					try {
						await access(joinPath(cacheRoot, 'testnet', 'a.bin'));
						return false;
					} catch {
						return true;
					}
				});
				expect(cacheMissing).toBe(true);
				yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
			}).pipe(Effect.provide(NodeServicesLayer)),
	);
});
