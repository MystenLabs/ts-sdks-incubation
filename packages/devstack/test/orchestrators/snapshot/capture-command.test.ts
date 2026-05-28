// Tests for the shared `captureSnapshot` command primitive.
//
// The primitive is the hoisted core of `EngineCommand`
// `snapshot.capture` — exercised here directly (NOT through the CLI
// or the supervisor command handler — that's the whole point of the
// hoist). The positive path (orchestrator walks participants, writes
// the snapshot, returns metadata) needs full supervisor scaffolding
// and is covered by `capture.test.ts`'s integration suite; this file
// pins only the contract a future web-dashboard receiver depends on:
// the orchestrator's tagged-error union flows through unchanged.

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Effect, Exit, Layer, Option } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type { ContainerRuntime } from '../../../src/contracts/container-runtime.ts';
import {
	captureSnapshot,
	SnapshotIdError,
	layerSnapshotOrchestrator,
} from '../../../src/orchestrators/snapshot/index.ts';
import { ContainerRuntimeService } from '../../../src/runtime/docker/index.ts';
import { appName, chainId, stackName } from '../../../src/substrate/brand.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import {
	layerIdentity,
	layerRuntimeRoot,
	layerStackPaths,
} from '../../../src/substrate/runtime/paths.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';

const identity: Identity = {
	app: appName('capture-command-test'),
	stack: stackName('main'),
	chain: chainId('sui:local'),
};

const noopContainerRuntime: ContainerRuntime = {
	ensureImage: () => Effect.die('ensureImage not used'),
	ensureNetwork: () => Effect.die('ensureNetwork not used'),
	ensureContainer: () => Effect.die('ensureContainer not used'),
	exec: () => Effect.die('exec not used'),
	runOneShot: () => Effect.die('runOneShot not used'),
	inspectByLabels: () => Effect.succeed([]),
	followLogs: () => Effect.die('followLogs not used') as never,
	pause: () => Effect.die('pause not used'),
	pauseAndCommit: () => Effect.die('pauseAndCommit not used'),
	saveImage: () => Effect.die('saveImage not used') as never,
	saveImages: () => Effect.die('saveImages not used') as never,
	loadImage: () => Effect.die('loadImage not used'),
	tagImage: () => Effect.die('tagImage not used'),
	removeImage: () => Effect.die('removeImage not used'),
	unpause: () => Effect.die('unpause not used'),
	stop: () => Effect.die('stop not used'),
	sweepOrphans: () => Effect.die('sweepOrphans not used'),
	removeManagedContainers: () => Effect.die('removeManagedContainers not used'),
	removeManagedImages: () => Effect.die('removeManagedImages not used'),
	removeManagedNetworks: () => Effect.die('removeManagedNetworks not used'),
	removeManagedVolumes: () => Effect.die('removeManagedVolumes not used'),
};

const containerRuntimeLayer = Layer.succeed(ContainerRuntimeService)(noopContainerRuntime);

const orchestratorLayerFor = (root: string) => {
	const base = Layer.mergeAll(
		NodeFileSystem.layer,
		NodePath.layer,
		layerRuntimeRoot(root),
		layerIdentity(identity),
		containerRuntimeLayer,
	);
	const withStackPaths = layerStackPaths.pipe(Layer.provideMerge(base));
	return layerSnapshotOrchestrator.pipe(Layer.provideMerge(withStackPaths));
};

describe('captureSnapshot — shared command primitive', () => {
	it.effect(
		'surfaces SnapshotIdError when the caller-supplied id is malformed',
		() =>
			withTempRoot('capture-command-bad-id', (root) =>
				Effect.gen(function* () {
					// Typed-error contract: bad id flows through the
					// orchestrator's `validateSnapshotId('capture', …)` guard
					// and surfaces as a `SnapshotIdError` (NOT an
					// `Effect.die`). The primitive is what a future web
					// dashboard's command receiver imports — it MUST see the
					// orchestrator's tagged-error union unchanged.
					const exit = yield* captureSnapshot({
						snapshotId: '../escape',
					}).pipe(Effect.exit);

					expect(Exit.isFailure(exit)).toBe(true);
					const err = Exit.findErrorOption(exit);
					expect(Option.isSome(err)).toBe(true);
					const value = Option.getOrThrow(err);
					expect(value).toBeInstanceOf(SnapshotIdError);
					if (value instanceof SnapshotIdError) {
						expect(value.operation).toBe('capture');
						expect(value.field).toBe('id');
						expect(value.value).toBe('../escape');
					}
				}).pipe(Effect.provide(orchestratorLayerFor(root))),
			),
	);
});
