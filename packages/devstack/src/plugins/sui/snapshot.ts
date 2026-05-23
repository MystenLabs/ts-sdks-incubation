// Sui plugin — Snapshotable contribution.
//
// Architecture §3: the snapshot orchestrator captures and restores
// without naming the plugin. Sui's contribution is mode-aware:
//
//   - local mode  — chain state (localnet validator) MUST live in
//                   the writable container layer (NOT a named
//                   volume), so `docker commit` captures it. Same
//                   for the postgres indexer (PGDATA relocated off
//                   the inherited VOLUME path).
//
//   - external    — no container, no snapshot. The `SnapshotableDecl`
//                   has `missingTolerance: 'fine'` so restore against
//                   a snapshot taken in local mode is a clean no-op.
//
//   - live        — same as external; no snapshot.
//
//   - fork        — data dir is a bind-mount; snapshot capture is
//                   handled separately by the snapshot orchestrator.
//                   This file emits the bind-mount subtree as the
//                   capture descriptor.
//
// Chain identity (chainId + per-mode cluster id) is the canonical
// identity-guard contribution from this plugin. The substrate's
// pre-restore hook reads it; identity mismatch refuses the restore.

import { Effect } from 'effect';

import type { ContainerLabelTuple, SnapshotableDecl } from '../../contracts/snapshotable.ts';
import type { SuiPluginMode } from './mode/spec.ts';

/** Build the Snapshotable contribution for a resolved mode + chain id.
 *
 *  Identity guard data lives in `preRestore`: the substrate compares
 *  the snapshot's stored chain identity against the resolver's
 *  current answer; a mismatch refuses BEFORE any destructive
 *  mutation. */
export const makeSnapshotable = (
	mode: SuiPluginMode,
	app: string,
	stack: string,
	chain: string,
): SnapshotableDecl => {
	const labels = (role: string): ContainerLabelTuple => ({
		app,
		stack,
		plugin: 'sui',
		role,
	});

	switch (mode) {
		case 'local': {
			// Validator's writable layer + postgres indexer's writable
			// layer. The runtime adapter pauses both before commit;
			// architecture default grace is "pause container".
			return {
				kind: 'snapshotable',
				// Chain state lives in the writable container layer
				// — declared via `managedContainers`, not subtrees.
				subtrees: [],
				managedContainers: [labels('validator'), labels('postgres')],
				missingTolerance: 'fine',
				preRestore: Effect.succeed({ kind: 'sui-chain', chain }),
				postRestore: Effect.void,
			};
		}
		case 'local-rpc':
		case 'live': {
			// No container, no capture. The decl still exists so the
			// identity guard fires on restore (e.g. restoring a local
			// snapshot while the resolver says "live testnet" — the
			// identity-guard refuses).
			return {
				kind: 'snapshotable',
				subtrees: [],
				missingTolerance: 'fine',
				preRestore: Effect.succeed({ kind: 'sui-chain', chain }),
			};
		}
		case 'fork': {
			// Data dir + meta are bind-mounted host paths; the
			// orchestrator walks the declared subtree. The fork
			// container itself is also captured (writable layer for
			// dep + cache state).
			return {
				kind: 'snapshotable',
				subtrees: ['sui-fork/'],
				managedContainers: [labels('fork-validator')],
				missingTolerance: 'fine',
				preRestore: Effect.succeed({ kind: 'sui-chain', chain }),
			};
		}
	}
};
