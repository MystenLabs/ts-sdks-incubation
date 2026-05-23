// Postgres plugin — Snapshotable contribution.
//
// Architecture §3: the snapshot orchestrator captures and restores
// without naming the plugin. Postgres's contribution is the
// container's writable layer — image-commit captures PGDATA only
// because the vendored image relocates `PGDATA` OFF the upstream
// `VOLUME /var/lib/postgresql/data` (which docker commit excludes).
//
// Identity contribution (distilled doc § Postgres-specific concerns +
// architecture identity-guard pattern): the postgres "server
// identifier" doubles as a guard. On restore we compare the
// snapshot's stored postgres identity (server name + the set of
// requested databases) against the resolver's current answer; if
// the user pointed at a different cluster shape mid-cycle, the
// identity-guard refuses BEFORE any destructive mutation.
//
// Stop-grace (distilled doc § Postgres-specific concerns): the service
// threads a 20s Docker stop grace into the container spec, matching the
// sui-indexer-db sidecar for the same image. This file's `quiesce`
// Effect is intentionally `Effect.void` (the substrate engine pauses the
// container around `docker commit`); the plugin only contributes the
// LABEL TUPLE that lets the engine find it.

import { Effect } from 'effect';

import type { ContainerLabelTuple, SnapshotableDecl } from '../../contracts/snapshotable.ts';

/** Identity payload contributed to the substrate's identity-guard.
 *  The substrate's pre-restore hook reads this; identity mismatch
 *  refuses the restore. Server name + ordered database list is the
 *  smallest tuple that distinguishes a postgres instance for snapshot
 *  purposes — image tag / version is intentionally NOT part of
 *  identity (a minor-version bump should restore cleanly). */
export interface PostgresIdentityPayload {
	readonly kind: 'postgres-server';
	readonly name: string;
	readonly databases: ReadonlyArray<string>;
}

export interface MakeSnapshotableOptions {
	readonly app: string;
	readonly stack: string;
	readonly name: string;
	readonly databases: ReadonlyArray<string>;
}

/** Build the Snapshotable contribution.
 *
 *  Container-bearing only; no host-side subtree. Postgres's entire
 *  state lives in the container's writable layer at the relocated
 *  `PGDATA` (see `service.ts` for the image build context). */
export const makeSnapshotable = (opts: MakeSnapshotableOptions): SnapshotableDecl => {
	const labels: ContainerLabelTuple = {
		app: opts.app,
		stack: opts.stack,
		plugin: 'postgres',
		role: opts.name,
	};

	const identity: PostgresIdentityPayload = {
		kind: 'postgres-server',
		name: opts.name,
		// Frozen list so the identity payload is structurally stable
		// across calls — the substrate hashes it for comparison.
		databases: Object.freeze([...opts.databases].sort()) as ReadonlyArray<string>,
	};

	return {
		kind: 'snapshotable',
		// No host-tree subtree — all state lives in the container.
		subtrees: [],
		managedContainers: [labels],
		// Engine-level pause-around-commit handles quiescence; the
		// plugin's contribution is just the label tuple above.
		missingTolerance: 'fine',
		preRestore: Effect.succeed(identity),
		postRestore: Effect.void,
	};
};
