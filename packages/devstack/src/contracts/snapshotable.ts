// Snapshotable capability contract (architecture §3).
//
// Lets the snapshot orchestrator capture and restore a plugin's
// state WITHOUT naming the plugin. The orchestrator walks decls;
// per-service paths/labels never appear in orchestrator code.

import type { Effect, Scope } from 'effect';

/** Label tuple identifying managed containers. The orchestrator
 *  filters the runtime adapter by this tuple. */
export interface ContainerLabelTuple {
	readonly app: string;
	readonly stack: string;
	readonly plugin: string;
	readonly role: string;
}

/** Capture descriptor: zero or more subtrees + managed containers +
 *  optional typed metadata slice. */
export interface SnapshotableDecl {
	readonly kind: 'snapshotable';
	/** Host-tree subtrees, relative to the substrate's runtime-dir
	 *  root. Auto-included subtrees under `runtime/<plugin-key>/`
	 *  are added by the substrate; this list is opt-in extras. */
	readonly subtrees: ReadonlyArray<string>;
	/** Managed containers identified by label tuples — orchestrator
	 *  is name-blind. */
	readonly managedContainers?: ReadonlyArray<ContainerLabelTuple>;
	/** Quiescence hook: how to make state consistent before commit.
	 *  Default is "pause container"; postgres / RocksDB declare
	 *  longer grace. */
	readonly quiesce?: Effect.Effect<void, never, Scope.Scope>;
	/** Pre-restore hook: contribute to the identity guard. */
	readonly preRestore?: Effect.Effect<unknown, never>;
	/** Post-restore hook. */
	readonly postRestore?: Effect.Effect<void, never>;
	/** Missing-tolerance flag: is absence on restore fatal or fine? */
	readonly missingTolerance: 'fatal' | 'fine';
	/** Secret-material declaration drives mode bits (0o600 inside
	 *  0o700 parent). Substrate preserves on round-trip. */
	readonly secretMaterial?: boolean;
}
