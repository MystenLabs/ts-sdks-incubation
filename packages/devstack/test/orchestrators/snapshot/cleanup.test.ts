import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Stream } from 'effect';

import type { ContainerRuntime } from '../../../src/contracts/container-runtime.ts';
import type { ContainerLabelTuple } from '../../../src/contracts/snapshotable.ts';
import { runPrune, runWipe } from '../../../src/orchestrators/snapshot/index.ts';

const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'snapshot-cleanup-test-'));

const runtimeStub = (events: string[]): ContainerRuntime => ({
	ensureImage: () => Effect.die('ensureImage not used'),
	ensureNetwork: () => Effect.die('ensureNetwork not used'),
	ensureContainer: () => Effect.die('ensureContainer not used'),
	exec: () => Effect.die('exec not used'),
	runOneShot: () => Effect.die('runOneShot not used'),
	inspectByLabels: () => Effect.die('inspectByLabels not used'),
	followLogs: () => Stream.empty,
	pause: () => Effect.die('pause not used'),
	pauseAndCommit: () => Effect.die('pauseAndCommit not used'),
	saveImage: () => Stream.empty,
	saveImages: () => Stream.empty,
	loadImage: () => Effect.die('loadImage not used'),
	tagImage: () => Effect.die('tagImage not used'),
	removeImage: () => Effect.die('removeImage not used'),
	unpause: () => Effect.die('unpause not used'),
	stop: () => Effect.die('stop not used'),
	sweepOrphans: () => Effect.die('sweepOrphans not used'),
	removeManagedContainers: (match: Partial<ContainerLabelTuple>) =>
		Effect.sync(() => {
			events.push(`containers:${match.app}/${match.stack}`);
			return 2;
		}),
	removeManagedImages: (match: Partial<ContainerLabelTuple>) =>
		Effect.sync(() => {
			events.push(`images:${match.app}/${match.stack}`);
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
		'wipe uses explicit managed-resource cleanup and preserves snapshots/cache by default',
		() =>
			Effect.gen(function* () {
				const root = freshRoot();
				const events: string[] = [];
				try {
					const stackRoot = join(root, 'stack');
					const stateFilePath = join(stackRoot, 'state.json');
					const cacheDir = join(stackRoot, 'cache');
					mkdirSync(join(stackRoot, 'snapshots'), { recursive: true });
					mkdirSync(cacheDir, { recursive: true });
					mkdirSync(join(stackRoot, 'work'), { recursive: true });
					writeFileSync(stateFilePath, '{}');

					yield* runWipe({
						labelMatch: { app: 'app', stack: 'main' },
						stackRoot,
						stateFilePath,
						cacheDir,
						runtime: runtimeStub(events),
					}).pipe(Effect.provide(NodeFileSystem.layer));

					expect(events).toEqual(['containers:app/main', 'networks:app/main', 'volumes:app/main']);
					expect(existsSync(stateFilePath)).toBe(false);
					expect(existsSync(join(stackRoot, 'work'))).toBe(false);
					expect(existsSync(join(stackRoot, 'snapshots'))).toBe(true);
					expect(existsSync(cacheDir)).toBe(true);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
	);

	it.effect('prune uses managed image cleanup rather than boot orphan sweep', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			const events: string[] = [];
			try {
				const stackRoot = join(root, 'stack');
				mkdirSync(join(stackRoot, 'snapshots'), { recursive: true });

				const result = yield* runPrune({
					stackRoot,
					imageLabelFilter: { app: 'app', stack: 'main' },
					classifiers: [],
					runtime: runtimeStub(events),
				}).pipe(Effect.provide(NodeFileSystem.layer));

				expect(result.imagesSwept).toBe(3);
				expect(events).toEqual(['images:app/main']);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
