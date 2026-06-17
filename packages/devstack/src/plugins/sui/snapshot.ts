// Sui plugin — Snapshotable contribution.
//
// Architecture §3: the snapshot orchestrator captures and restores
// without naming the plugin. Sui's contribution is mode-aware:
//
//   - local mode  — chain state (localnet validator) MUST live in
//                   the writable container layer (NOT a named
//                   volume), so `docker commit` captures it. The
//                   validator commit captures chain state, the
//                   embedded-fullnode db, and the GraphQL consistent-
//                   store on-disk store. When the GraphQL indexer is on
//                   (the default), its data lives in sui's OWNED postgres
//                   sidecar — captured here too under sui's own
//                   `indexer-db` role (the sidecar's vendored image
//                   relocates PGDATA into the writable layer).
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
// `{kind, chainId}` and let a container-`local` snapshot restore against a
// `local-rpc` stack (and vice versa): restoring container chain-state
// against an external RPC is a silent no-op masquerading as success.
// With `mode` in the record the values differ on the `mode` key and the
// guard refuses before any mutation.

import { Effect } from 'effect';

import type { ContainerLabelTuple, SnapshotableDecl } from '../../contracts/snapshotable.ts';
import type { SuiPluginMode } from './mode/spec.ts';
import { SUI_INDEXER_DB_ROLE } from './mode/local.ts';

/** Build the Snapshotable contribution for a resolved mode + chain id.
 *
 *  `hasIndexer` (local mode only) folds the sui-owned indexer-db sidecar
 *  into the captured containers when GraphQL is on; off when the caller
 *  set `indexer: false` (or BYO'd a Postgres the sui plugin doesn't own).
 *
 *  Identity guard data lives in `preRestore`: the substrate compares
 *  the snapshot's stored chain identity against the resolver's
 *  current answer; a mismatch refuses BEFORE any destructive
 *  mutation. */
export const makeSnapshotable = (
	mode: SuiPluginMode,
	app: string,
	stack: string,
	chainId: string,
	hasIndexer: boolean,
): SnapshotableDecl => {
	const labels = (role: string): ContainerLabelTuple => ({
		app,
		stack,
		plugin: 'sui',
		role,
	});

	switch (mode) {
		case 'local': {
			// The validator's writable layer captures chain state, the
			// embedded-fullnode db, and the GraphQL consistent-store
			// on-disk store. When the indexer is on (default), sui ALSO
			// owns a postgres sidecar whose PGDATA-relocated writable layer
			// holds the indexer's data — captured here under sui's own
			// `indexer-db` role. The runtime adapter pauses each container
			// before commit; architecture default grace is "pause
			// container".
			return {
				kind: 'snapshotable',
				// Chain state lives in the writable container layer
				// — declared via `managedContainers`, not subtrees.
				subtrees: [],
				managedContainers: hasIndexer
					? [labels('validator'), labels(SUI_INDEXER_DB_ROLE)]
					: [labels('validator')],
				missingTolerance: 'fine',
				preRestore: Effect.succeed({ kind: 'sui-chain' as const, mode: 'local' as const, chainId }),
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
				preRestore: Effect.succeed({ kind: 'sui-chain' as const, mode, chainId }),
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
				preRestore: Effect.succeed({ kind: 'sui-chain' as const, mode: 'fork' as const, chainId }),
			};
		}
	}
};
