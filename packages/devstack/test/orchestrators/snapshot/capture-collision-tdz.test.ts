// Snapshot orchestrator — closure-hoisting / TDZ regression guard.
//
// Code-review speculation (review fix phase 22f):
//   "capture calls `yield* list` for label uniqueness AFTER
//   acquiring the stack lock. `list` is defined later in the same
//   `Effect.gen`. JS hoisting via `const` makes this TDZ throw at
//   runtime IF the path is reached. (speculative — looks like `list`
//   may be hoisted by the closure.)"
//
// Per phase-22f decision for speculative items: reproducer goes FIRST.
// The intuition that prevents TDZ: the outer `Effect.gen` constructs
// the orchestrator service shape `{ capture, list, ... }` and RETURNS
// before any of those methods are called by an external caller. By the
// time `capture` is invoked from outside, every `const` in the outer
// gen has been bound. So mutual reference inside the gen body is safe
// via JavaScript closure semantics.
//
// The reproducer plants a snapshot metadata document on disk with a
// known label, then calls `capture` with the SAME label. That drives
// the orchestrator down the `existing.some(entry => label match)`
// branch — which is the branch the reviewer flagged — and asserts the
// resulting failure is a clean `SnapshotIdError` (no `ReferenceError`
// from TDZ). If the closure-hoisting EVER regresses (e.g. someone
// refactors `list` to an `Effect.fn` decorator that introduces a real
// TDZ window), this test surfaces the breakage immediately.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Effect, Exit, Layer } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { appName, stackName } from '../../../src/substrate/brand.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import {
	SnapshotIdError,
	SnapshotLayout,
	SnapshotOrchestratorService,
	SNAPSHOT_META_VERSION,
	layerSnapshotOrchestrator,
} from '../../../src/orchestrators/snapshot/index.ts';
import { ContainerRuntimeService } from '../../../src/runtime/docker/index.ts';
import type { ContainerRuntime } from '../../../src/contracts/container-runtime.ts';
import { layerIdentity, layerRuntimeRoot, layerStackPaths } from '../../../src/substrate/runtime/paths.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';

const identity: Identity = {
	app: appName('snapshot-tdz-test'),
	stack: stackName('main'),
	chain: 'sui:local',
};

/** A container runtime whose `inspectByLabels` returns no containers —
 *  the `capture` flow never reaches the participants because we trip
 *  the label-uniqueness branch before any runtime work fires. The
 *  other methods are `Effect.die` to surface accidental reach. */
const unusedContainerRuntime: ContainerRuntime = {
	ensureImage: () => Effect.die('ensureImage not used'),
	ensureNetwork: () => Effect.die('ensureNetwork not used'),
	ensureContainer: () => Effect.die('ensureContainer not used'),
	exec: () => Effect.die('exec not used'),
	runOneShot: () => Effect.die('runOneShot not used'),
	inspectByLabels: () => Effect.succeed([]),
	pauseAndCommit: () => Effect.die('pauseAndCommit not used'),
	saveImages: () => Effect.die('saveImages not used') as never,
	loadImage: () => Effect.die('loadImage not used'),
	tagImage: () => Effect.die('tagImage not used'),
	removeImage: () => Effect.die('removeImage not used'),
	stop: () => Effect.die('stop not used'),
	removeManagedContainers: () => Effect.die('removeManagedContainers not used'),
	removeManagedImages: () => Effect.die('removeManagedImages not used'),
	removeManagedNetworks: () => Effect.die('removeManagedNetworks not used'),
	removeManagedVolumes: () => Effect.die('removeManagedVolumes not used'),
};

const containerRuntimeLayer = Layer.succeed(ContainerRuntimeService)(unusedContainerRuntime);

/** Plant a snapshot directory with a metadata file on disk so the
 *  orchestrator's `list` returns one entry whose label matches the
 *  string the test's `capture` call passes. */
const plantSnapshot = (snapshotDir: string, label: string): void => {
	const snapId = 'snap-existing-fixture';
	const dir = join(snapshotDir, snapId);
	mkdirSync(dir, { recursive: true });
	const meta = {
		version: SNAPSHOT_META_VERSION,
		id: snapId,
		label,
		createdAt: Date.now(),
		app: String(identity.app),
		stack: String(identity.stack),
		network: String(identity.chain),
		hostTreeIncluded: false,
		subtrees: [],
		containers: [],
		identity: { chain: String(identity.chain) },
		participants: [],
	};
	writeFileSync(join(dir, SnapshotLayout.metaFile), JSON.stringify(meta));
};

describe('SnapshotOrchestrator.capture — label uniqueness branch (TDZ regression guard)', () => {
	it.effect('rejects a duplicate label with a SnapshotIdError, never a ReferenceError', () =>
		withTempRoot('snapshot-tdz', (root) =>
			Effect.gen(function* () {
				const snapshotDir = join(root, 'stacks', String(identity.stack), 'snapshots');
				const duplicateLabel = 'my-label';
				plantSnapshot(snapshotDir, duplicateLabel);

				const orchestrator = yield* SnapshotOrchestratorService;
				const exit = yield* orchestrator
					.capture({ label: duplicateLabel })
					.pipe(Effect.exit);

				expect(Exit.isFailure(exit)).toBe(true);
				const err = Exit.findErrorOption(exit);
				expect(err._tag).toBe('Some');
				if (err._tag === 'Some') {
					// The crucial assertion: it's the typed orchestrator
					// error, NOT a JS ReferenceError from a TDZ window
					// around `list`. A TDZ break would surface as an
					// `Effect.die` carrying the raw ReferenceError.
					expect(err.value).toBeInstanceOf(SnapshotIdError);
					if (err.value instanceof SnapshotIdError) {
						expect(err.value.operation).toBe('capture');
						expect(err.value.field).toBe('name');
						expect(err.value.value).toBe(duplicateLabel);
					}
				}
				// Defensive: no defect (die) surfaced.
				if (Exit.isFailure(exit)) {
					const causeJson = JSON.stringify(exit.cause);
					expect(causeJson).not.toContain('ReferenceError');
					expect(causeJson).not.toContain(
						'Cannot access',
					); /* TDZ message fragment */
				}
			}).pipe(
				Effect.provide(
					(() => {
						const base = Layer.mergeAll(
							NodeFileSystem.layer,
							NodePath.layer,
							layerRuntimeRoot(root),
							layerIdentity(identity),
							containerRuntimeLayer,
						);
						const withStackPaths = layerStackPaths.pipe(Layer.provideMerge(base));
						return layerSnapshotOrchestrator.pipe(Layer.provideMerge(withStackPaths));
					})(),
				),
			),
		),
	);
});
