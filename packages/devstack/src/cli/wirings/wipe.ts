// `devstack wipe` verb wiring — direct/offline path.
//
// Refuses to run when a supervisor owns the stack (the operator must
// shut down `devstack up` first). When safe, drains the snapshot
// catalog AND removes any router-dispatch files this stack contributed
// so the router doesn't keep referencing endpoints that no longer
// exist on disk.

import { Effect, FileSystem, Logger } from 'effect';

import {
	SnapshotOrchestratorService,
	type WipeTargets,
} from '../../orchestrators/snapshot/index.ts';
import { removeRouterDispatchFilesForStack } from '../../orchestrators/router/cleanup.ts';

import { ensureNoLiveSupervisor, identityValueFor, type ResolvedIdentity } from './identity.ts';
import { buildDirectSnapshotLayers } from '../../orchestrators/layers.ts';
import { provideFileSystem } from './provide-file-system.ts';

export const runWipeDirect = (identity: ResolvedIdentity): Effect.Effect<void, unknown> =>
	Effect.gen(function* () {
		yield* ensureNoLiveSupervisor(identity, 'shut down the attached `devstack up` session first');
		const program = Effect.gen(function* () {
			const snapshot = yield* SnapshotOrchestratorService;
			const fs = yield* FileSystem.FileSystem;
			yield* provideFileSystem(fs, snapshot.wipe({}));
			yield* removeRouterDispatchFilesForStack({
				runtimeRoot: identity.runtimeRoot,
				app: identity.app,
				stack: identity.stack,
			});
		});
		return yield* program.pipe(
			Effect.provide(
				buildDirectSnapshotLayers({
					identity: identityValueFor(identity),
					runtimeRoot: identity.runtimeRoot,
				}),
			),
			Effect.provide(Logger.layer([Logger.consolePretty()])),
		);
	});

/** Read-only enumeration of the concrete targets a real `wipe` would
 *  remove — backs `devstack wipe --dry-run`. Deliberately does NOT
 *  `ensureNoLiveSupervisor` (a preview must work whether or not a
 *  supervisor is attached; it mutates nothing) and skips the router
 *  dispatch-file removal (that is a destructive side effect of the real
 *  wipe, not part of the preview). */
export const runWipePlanDirect = (
	identity: ResolvedIdentity,
): Effect.Effect<WipeTargets, unknown> =>
	Effect.gen(function* () {
		const snapshot = yield* SnapshotOrchestratorService;
		const fs = yield* FileSystem.FileSystem;
		return yield* provideFileSystem(fs, snapshot.wipePlan({}));
	}).pipe(
		Effect.provide(
			buildDirectSnapshotLayers({
				identity: identityValueFor(identity),
				runtimeRoot: identity.runtimeRoot,
			}),
		),
		Effect.provide(Logger.layer([Logger.consolePretty()])),
	);
