import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Stream } from 'effect';

import type { ContainerRuntime } from '../../../src/contracts/container-runtime.ts';
import type { ContainerLabelTuple } from '../../../src/contracts/snapshotable.ts';
import { runPrune, runWipe } from '../../../src/orchestrators/snapshot/index.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';

const runtimeStub = (events: string[]): ContainerRuntime => ({
	ensureImage: () => Effect.die('ensureImage not used'),
	ensureNetwork: () => Effect.die('ensureNetwork not used'),
	ensureContainer: () => Effect.die('ensureContainer not used'),
	exec: () => Effect.die('exec not used'),
	runOneShot: () => Effect.die('runOneShot not used'),
	inspectByLabels: () => Effect.die('inspectByLabels not used'),
	pauseAndCommit: () => Effect.die('pauseAndCommit not used'),
	saveImages: () => Stream.empty,
	loadImage: () => Effect.die('loadImage not used'),
	tagImage: () => Effect.die('tagImage not used'),
	removeImage: () => Effect.die('removeImage not used'),
	stop: () => Effect.die('stop not used'),
	removeManagedContainers: (match: Partial<ContainerLabelTuple>) =>
		Effect.sync(() => {
			events.push(`containers:${match.app}/${match.stack}`);
			return 2;
		}),
	removeManagedImages: (match: Partial<ContainerLabelTuple>) =>
		Effect.sync(() => {
			events.push(`images:${match.app}/${match.stack}:${match.role ?? '<no-role>'}`);
			return 3;
		}),
	removeManagedNetworks: (match: Partial<ContainerLabelTuple>) =>
		Effect.sync(() => {
			events.push(`networks:${match.app}/${match.stack}`);
			return 1;
		}),
	removeManagedVolumes: (match: Partial<ContainerLabelTuple>) =>
		Effect.sync(() => {
			events.push(`volumes:${match.app}/${match.stack}`);
			return 1;
		}),
});

describe('snapshot cleanup orchestration', () => {
	it.effect(
		'wipe uses explicit managed-resource cleanup and preserves snapshots AND cache by default',
		() =>
			withTempRoot('snapshot-cleanup-test', (root) =>
				Effect.gen(function* () {
					const events: string[] = [];
					const stackRoot = join(root, 'stack');
					const cacheDir = join(stackRoot, 'cache');
					mkdirSync(join(stackRoot, 'snapshots'), { recursive: true });
					mkdirSync(cacheDir, { recursive: true });
					mkdirSync(join(stackRoot, 'work'), { recursive: true });

					yield* runWipe({
						labelMatch: { app: 'app', stack: 'main' },
						stackRoot,
						runtime: runtimeStub(events),
					}).pipe(Effect.provide(NodeFileSystem.layer));

					expect(events).toEqual(['containers:app/main', 'networks:app/main', 'volumes:app/main']);
					expect(existsSync(join(stackRoot, 'work'))).toBe(false);
					// Coupled wipe-scope: snapshots AND cache survive together by
					// default so a later restore can reuse the live deploy cache.
					expect(existsSync(join(stackRoot, 'snapshots'))).toBe(true);
					expect(existsSync(cacheDir)).toBe(true);
				}),
			),
	);

	it.effect('a hard reset (keepSnapshots:false) drops snapshots AND cache together', () =>
		withTempRoot('snapshot-cleanup-test', (root) =>
			Effect.gen(function* () {
				const events: string[] = [];
				const stackRoot = join(root, 'stack');
				const cacheDir = join(stackRoot, 'cache');
				const snapshotsDir = join(stackRoot, 'snapshots');
				mkdirSync(snapshotsDir, { recursive: true });
				mkdirSync(cacheDir, { recursive: true });
				writeFileSync(join(cacheDir, 'entry'), 'cache');
				writeFileSync(join(stackRoot, 'work'), 'removable');

				yield* runWipe({
					labelMatch: { app: 'app', stack: 'main' },
					stackRoot,
					runtime: runtimeStub(events),
					keepSnapshots: false,
				}).pipe(Effect.provide(NodeFileSystem.layer));

				// Hard reset: both wipe-scoped dirs are dropped together.
				expect(existsSync(cacheDir)).toBe(false);
				expect(existsSync(snapshotsDir)).toBe(false);
				expect(existsSync(join(stackRoot, 'work'))).toBe(false);
			}),
		),
	);

	it.effect('prune uses managed image cleanup rather than boot orphan sweep', () =>
		withTempRoot('snapshot-cleanup-test', (root) =>
			Effect.gen(function* () {
				const events: string[] = [];
				const stackRoot = join(root, 'stack');
				mkdirSync(join(stackRoot, 'snapshots'), { recursive: true });

				const result = yield* runPrune({
					stackRoot,
					imageLabelFilter: { app: 'app', stack: 'main' },
					runtime: runtimeStub(events),
				}).pipe(Effect.provide(NodeFileSystem.layer));

				expect(result.imagesSwept).toBe(3);
				// Prune must narrow the managed-image filter to the reserved
				// snapshot-image role so it cannot match build images.
				expect(events).toEqual(['images:app/main:snapshot-image']);
			}),
		),
	);

	it.effect('prune sweeps snapshot-byproduct images and NEVER build images', () =>
		withTempRoot('snapshot-cleanup-test', (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'stack');
				mkdirSync(join(stackRoot, 'snapshots'), { recursive: true });

				// A real `docker images --filter label=…` sweep over a stack
				// that has BOTH a leaked committed snapshot image and a live
				// build image. Both share `{managed, app, stack}`; only the
				// byproduct carries `role=snapshot-image` (stamped at commit).
				const fixtureImages: ReadonlyArray<{
					readonly tag: string;
					readonly labels: Readonly<Record<string, string>>;
				}> = [
					{
						tag: 'devstack-snapshot:postgres-db-abc123',
						labels: {
							'devstack.managed': 'true',
							'devstack.app': 'app',
							'devstack.stack': 'main',
							'devstack.role': 'snapshot-image',
						},
					},
					{
						tag: 'devstack-build:deadbeef0badf00d',
						labels: {
							'devstack.managed': 'true',
							'devstack.app': 'app',
							'devstack.stack': 'main',
							'devstack.plugin': 'postgres',
							'devstack.role': 'db',
						},
					},
				];
				// Mirror inventory's filter semantics: a managed-image filter
				// matches an image iff every requested label key/value is
				// present. Records which tags were actually removed.
				const removedTags: string[] = [];
				const filteredRuntime: ContainerRuntime = {
					...runtimeStub([]),
					removeManagedImages: (match: Partial<ContainerLabelTuple>) =>
						Effect.sync(() => {
							const wanted: Record<string, string> = { 'devstack.managed': 'true' };
							if (match.app !== undefined) wanted['devstack.app'] = match.app;
							if (match.stack !== undefined) wanted['devstack.stack'] = match.stack;
							if (match.plugin !== undefined) wanted['devstack.plugin'] = match.plugin;
							if (match.role !== undefined) wanted['devstack.role'] = match.role;
							let removed = 0;
							for (const image of fixtureImages) {
								const matches = Object.entries(wanted).every(
									([key, value]) => image.labels[key] === value,
								);
								if (matches) {
									removedTags.push(image.tag);
									removed += 1;
								}
							}
							return removed;
						}),
				};

				const result = yield* runPrune({
					stackRoot,
					imageLabelFilter: { app: 'app', stack: 'main' },
					runtime: filteredRuntime,
				}).pipe(Effect.provide(NodeFileSystem.layer));

				expect(result.imagesSwept).toBe(1);
				expect(removedTags).toEqual(['devstack-snapshot:postgres-db-abc123']);
				// The live build image must survive — untagging it would force
				// a silent rebuild on the next boot.
				expect(removedTags).not.toContain('devstack-build:deadbeef0badf00d');
			}),
		),
	);
});
