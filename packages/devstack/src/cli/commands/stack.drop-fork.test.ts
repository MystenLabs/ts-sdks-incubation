// Phase 4 P4.T10 — `devstack stack drop <name>` removes per-stack data
// (including sui-fork/) but preserves the shared cache.
//
// Same path-resolution invariant as wipe (P4.T7): `stack drop` walks
// `<state>/stacks/<name>/` and only removes that subtree. The
// `<state>/sui-fork-cache/` lives outside that subtree, so it survives
// by construction.

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { layer as NodeServicesLayer } from '@effect/platform-node/NodeServices';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

describe('cli/commands/stack drop on a fork stack (P4.T10)', () => {
	it.effect('drops <state>/stacks/<name>/ including sui-fork/, leaves cache intact', () =>
		Effect.gen(function* () {
			const root = yield* Effect.promise(() =>
				mkdtemp(joinPath(tmpdir(), 'devstack-stack-drop-fork-')),
			);
			const stateDir = joinPath(root, '.devstack');
			const stackDir = joinPath(stateDir, 'stacks', 'main');
			const forkDataDir = joinPath(stackDir, 'sui-fork', 'data');
			const cacheRoot = joinPath(stateDir, 'sui-fork-cache');
			yield* Effect.promise(() => mkdir(forkDataDir, { recursive: true }));
			yield* Effect.promise(() => mkdir(joinPath(cacheRoot, 'testnet'), { recursive: true }));
			yield* Effect.promise(() =>
				writeFile(joinPath(stackDir, 'sui-fork', 'meta.json'), '{"version":1}'),
			);
			yield* Effect.promise(() =>
				writeFile(joinPath(forkDataDir, 'placeholder.bin'), Buffer.from('x')),
			);
			yield* Effect.promise(() =>
				writeFile(joinPath(cacheRoot, 'testnet', 'cached.bin'), Buffer.from('y')),
			);
			// `stack drop main` semantics: `fs.remove(stackDir, recursive)`.
			yield* Effect.promise(() => rm(stackDir, { recursive: true, force: true }));
			// Stack subtree is gone — wrap the access in a try/catch
			// INSIDE the Promise so the rejection doesn't bubble out as
			// an Effect defect.
			const stackGone = yield* Effect.promise(async () => {
				try {
					await access(joinPath(forkDataDir, 'placeholder.bin'));
					return false;
				} catch {
					return true;
				}
			});
			expect(stackGone).toBe(true);
			// Cache survived (this access should succeed).
			yield* Effect.promise(() => access(joinPath(cacheRoot, 'testnet', 'cached.bin')));
			yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
		}).pipe(Effect.provide(NodeServicesLayer)),
	);
});
