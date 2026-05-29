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
//
// The `mode` discriminator is folded INTO the identity record (mirrors
// walrus's `preRestore` carrying `mode`). It is load-bearing: container
// `local` mode (committed chain-state artifacts in the writable layer)
// and `local-rpc` mode (caller-owned external RPC, no container) can
// resolve to the SAME chain id — e.g. a caller wrapping their own
// localnet reporting `sui:localnet`, identical to the in-container
// validator. Without the `mode` key the guard would compare only
// `{kind, chain}` and let a container-`local` snapshot restore against a
// `local-rpc` stack (and vice versa): restoring container chain-state
// against an external RPC is a silent no-op masquerading as success.
// With `mode` in the record the values differ on the `mode` key and the
// guard refuses before any mutation.

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
				preRestore: Effect.succeed({ kind: 'sui-chain' as const, mode: 'local' as const, chain }),
				postRestore: Effect.void,
			};
		}
		case 'local-rpc':
		case 'live': {
			// No container, no capture. The decl still exists so the
			// identity guard fires on restore (e.g. restoring a local
			// snapshot while the resolver says "live testnet" — the
			// identity-guard refuses). `mode` flows from the narrowed
			// parameter (`'local-rpc' | 'live'` here), so a `local-rpc`
			// snapshot also refuses against a container-`local` stack at
			// an identical chain id.
			return {
				kind: 'snapshotable',
				subtrees: [],
				missingTolerance: 'fine',
				preRestore: Effect.succeed({ kind: 'sui-chain' as const, mode, chain }),
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
				preRestore: Effect.succeed({ kind: 'sui-chain' as const, mode: 'fork' as const, chain }),
			};
		}
	}
};
