// Wipe orchestrator — dry-run enumeration (`planWipe`) and the
// empty-stack-root cleanup in `runWipe`.
//
// `planWipe` must enumerate the concrete teardown targets WITHOUT
// removing anything: matching container names (via the runtime adapter),
// the network/volume label scope, and the on-disk stack-root children a
// real wipe removes (everything except preserved `snapshots/` and,
// unless `keepCache`, `cache/`).
//
// `runWipe` must additionally reap the stack root when nothing survived
// so a wipe never leaks an empty `stacks/<stack>/` shell.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type {
	ContainerHandle,
	ContainerRuntime,
} from '../../../src/contracts/container-runtime.ts';
import type { ContainerLabelTuple } from '../../../src/contracts/snapshotable.ts';
import { planWipe, runWipe } from '../../../src/orchestrators/snapshot/index.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';

const APP = 'arena';
const STACK = 'main';

const handle = (name: string): ContainerHandle => ({
	id: `id-${name}`,
	name,
	imageName: 'arena-svc:test',
	status: 'running',
	ips: [],
});

const stubRuntime = (overrides: Partial<ContainerRuntime> = {}): ContainerRuntime =>
	({
		// Wipe consults `inspectByLabels` (plan) and `removeManaged*`
		// (real wipe). Everything else dies loudly if touched.
		inspectByLabels: (_labels: ContainerLabelTuple) =>
			Effect.succeed([] as ReadonlyArray<ContainerHandle>),
		removeManagedContainers: () => Effect.succeed(0),
		removeManagedNetworks: () => Effect.succeed(0),
		removeManagedVolumes: () => Effect.succeed(0),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		...(overrides as any),
	}) as unknown as ContainerRuntime;

// Lay down a realistic stack root: cross-process artifacts + per-plugin
// runtime trees, plus the preserved `snapshots/` and `cache/`.
const seedStackRoot = (stackRoot: string): void => {
	mkdirSync(join(stackRoot, 'snapshots', 'snap-1'), { recursive: true });
	mkdirSync(join(stackRoot, 'cache', 'sui'), { recursive: true });
	mkdirSync(join(stackRoot, 'runtime', 'sui-fork'), { recursive: true });
	writeFileSync(join(stackRoot, 'snapshots', 'snap-1', 'meta.json'), '{}', 'utf8');
	writeFileSync(join(stackRoot, 'cache', 'sui', 'x.json'), '{}', 'utf8');
	writeFileSync(join(stackRoot, 'runtime', 'sui-fork', 'genesis'), 'x', 'utf8');
	writeFileSync(join(stackRoot, 'roster.json'), '{}', 'utf8');
	writeFileSync(join(stackRoot, 'stack.lock'), '', 'utf8');
};

describe('planWipe — dry-run enumeration', () => {
	it.effect('enumerates matching containers, on-disk targets, and preserved dirs', () =>
		withTempRoot('wipe-plan', (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'stacks', STACK);
				seedStackRoot(stackRoot);

				const runtime = stubRuntime({
					inspectByLabels: () =>
						Effect.succeed([
							handle(`devstack-${APP}-${STACK}-svc`),
							handle(`devstack-${APP}-${STACK}-db`),
						]),
				});

				const targets = yield* planWipe({
					labelMatch: { app: APP, stack: STACK },
					stackRoot,
					runtime,
				}).pipe(Effect.provide(NodeFileSystem.layer));

				// Container names enumerated (sorted) — exactly what a real wipe
				// force-removes.
				expect(targets.containers).toEqual([
					`devstack-${APP}-${STACK}-db`,
					`devstack-${APP}-${STACK}-svc`,
				]);

				// Network/volume scope is the label match.
				expect(targets.networkLabelMatch).toEqual({ app: APP, stack: STACK });
				expect(targets.volumeLabelMatch).toEqual({ app: APP, stack: STACK });
				expect(targets.stackRoot).toBe(stackRoot);

				// On-disk: `snapshots/` preserved by default, `cache/` removed
				// (keepCache defaults false), plus the rest of the tree.
				const onDiskNames = targets.onDiskPaths.map((p) => p.slice(stackRoot.length + 1)).sort();
				expect(onDiskNames).toEqual(['cache', 'roster.json', 'runtime', 'stack.lock']);
				expect(targets.preserved).toEqual(['snapshots']);

				// Read-only: nothing was removed.
				expect(existsSync(join(stackRoot, 'runtime'))).toBe(true);
				expect(existsSync(join(stackRoot, 'snapshots'))).toBe(true);
			}),
		),
	);

	it.effect('keepCache preserves cache/ in the plan', () =>
		withTempRoot('wipe-plan-keepcache', (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'stacks', STACK);
				seedStackRoot(stackRoot);
				const targets = yield* planWipe({
					labelMatch: { app: APP, stack: STACK },
					stackRoot,
					runtime: stubRuntime(),
					keepCache: true,
				}).pipe(Effect.provide(NodeFileSystem.layer));
				expect([...targets.preserved].sort()).toEqual(['cache', 'snapshots']);
				const onDiskNames = targets.onDiskPaths.map((p) => p.slice(stackRoot.length + 1));
				expect(onDiskNames).not.toContain('cache');
			}),
		),
	);

	it.effect('absent stack root yields no on-disk targets (still lists containers)', () =>
		withTempRoot('wipe-plan-missing', (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'stacks', STACK); // never created
				const targets = yield* planWipe({
					labelMatch: { app: APP, stack: STACK },
					stackRoot,
					runtime: stubRuntime({ inspectByLabels: () => Effect.succeed([handle('only-svc')]) }),
				}).pipe(Effect.provide(NodeFileSystem.layer));
				expect(targets.onDiskPaths).toEqual([]);
				expect(targets.preserved).toEqual([]);
				expect(targets.containers).toEqual(['only-svc']);
			}),
		),
	);
});

describe('runWipe — empty stack-root cleanup', () => {
	it.effect('removes the stack root when nothing is preserved', () =>
		withTempRoot('wipe-empty', (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'stacks', STACK);
				// No snapshots/, no cache/ — only removable state.
				mkdirSync(join(stackRoot, 'runtime'), { recursive: true });
				writeFileSync(join(stackRoot, 'roster.json'), '{}', 'utf8');

				yield* runWipe({
					labelMatch: { app: APP, stack: STACK },
					stackRoot,
					runtime: stubRuntime(),
					keepCache: false,
				}).pipe(Effect.provide(NodeFileSystem.layer));

				// The whole stack root is gone — no empty shell left behind.
				expect(existsSync(stackRoot)).toBe(false);
			}),
		),
	);

	it.effect('keeps the stack root (preserving snapshots) when a snapshot survives', () =>
		withTempRoot('wipe-keep', (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'stacks', STACK);
				seedStackRoot(stackRoot);

				yield* runWipe({
					labelMatch: { app: APP, stack: STACK },
					stackRoot,
					runtime: stubRuntime(),
				}).pipe(Effect.provide(NodeFileSystem.layer));

				// Stack root survives because `snapshots/` is preserved...
				expect(existsSync(stackRoot)).toBe(true);
				expect(existsSync(join(stackRoot, 'snapshots'))).toBe(true);
				// ...but the removable state is gone.
				expect(existsSync(join(stackRoot, 'runtime'))).toBe(false);
				expect(existsSync(join(stackRoot, 'cache'))).toBe(false);
			}),
		),
	);
});
