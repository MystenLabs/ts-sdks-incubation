// Offline snapshot restore between two boots.
//
// Restore is offline-only: the orchestrator acquires an exclusive
// reservation and stage-and-swaps the runtime stack root, which conflicts
// with a live supervisor (the CLI guards this with `ensureNoLiveSupervisor`).
// So in the matrix test the restore runs BETWEEN two `runBoot` calls, when
// no supervisor is live. This mirrors the production `runSnapshotRestoreDirect`
// (cli/wirings/snapshot.ts) body — list snapshots, derive restore
// participants from the snapshot's recorded identity, restore — minus the
// CLI's ResolvedIdentity/ensureNoLiveSupervisor wrapper, since the caller
// already owns the no-supervisor window.

import { Effect, FileSystem, Logger } from 'effect';

import { buildDirectSnapshotLayers } from '../../../src/cli/wirings/build-verb-layers.ts';
import { provideFileSystem } from '../../../src/cli/wirings/provide-file-system.ts';
import {
	SnapshotOrchestratorService,
	type RestoreParticipant,
	type SnapshotMetadata,
} from '../../../src/orchestrators/snapshot/index.ts';
import { appName, stackName } from '../../../src/substrate/brand.ts';
import type { Identity } from '../../../src/substrate/identity.ts';

/** Each plugin that contributed an identity slice to the snapshot becomes a
 *  restore participant whose `liveIdentity` re-asserts that slice — the
 *  identity guard compares it against the live stack before any mutation. */
const snapshotIdentityParticipants = (meta: SnapshotMetadata): ReadonlyArray<RestoreParticipant> =>
	Object.entries(meta.identity).map(([plugin, value]) => ({
		plugin,
		liveIdentity: Effect.succeed({ [plugin]: value }),
	}));

export const restoreSnapshotOffline = async (params: {
	readonly runtimeRoot: string;
	readonly app: string;
	readonly stack: string;
	readonly network: string;
	readonly snapshotId: string;
}): Promise<SnapshotMetadata> => {
	const identity: Identity = {
		app: appName(params.app),
		stack: stackName(params.stack),
		chain: params.network,
	};
	const program = Effect.gen(function* () {
		const snapshot = yield* SnapshotOrchestratorService;
		const fs = yield* FileSystem.FileSystem;
		const entries = yield* provideFileSystem(fs, snapshot.list);
		const entry = entries.find((e) => e.id === params.snapshotId);
		if (entry === undefined) {
			return yield* Effect.die(
				`restoreSnapshotOffline: snapshot '${params.snapshotId}' not found in catalog`,
			);
		}
		const meta = entry.metadata ?? null;
		const participants = meta === null ? [] : snapshotIdentityParticipants(meta);
		return yield* provideFileSystem(fs, snapshot.restore({ id: params.snapshotId, participants }));
	});
	return Effect.runPromise(
		program.pipe(
			Effect.provide(buildDirectSnapshotLayers({ identity, runtimeRoot: params.runtimeRoot })),
			Effect.provide(Logger.layer([])),
		) as Effect.Effect<SnapshotMetadata, unknown, never>,
	);
};
