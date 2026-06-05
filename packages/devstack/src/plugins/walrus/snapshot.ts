// Walrus plugin — Snapshotable contribution.
//
// Distilled-doc reference (06-walrus.md §"Persistence model" +
// §"Hard requirements" item 7):
//   - `runtime/walrus/<name>/deploy/` MUST ride the snapshot tar.
//     It holds storage-node private keys + per-node configs that
//     `walrus-deploy` wrote; without them, a cached "walrus is already
//     deployed" artifact cannot be honored on resume.
//   - Local cluster: N storage-node containers' writable layers
//     hold RocksDB at `/var/walrus/storage` — managed-containers
//     declaration; runtime adapter pauses then `docker commit`.
//     Per-node label tuple `role: storage-node-${i}` so the snapshot
//     orchestrator's label filter resolves each node distinctly.
//   - Known-deployment: no containers, no subtrees. The shape still
//     exists so the identity guard fires on restore.
//
// Identity guard: contributes the deploy mode + chainId + (when
// local) the `name` discriminator to the pre-restore identity
// record. A snapshot taken in local mode restored under known
// mode (or vice versa) refuses BEFORE any destructive mutation.

import { Effect } from 'effect';

import type { ContainerLabelTuple, SnapshotableDecl } from '../../contracts/snapshotable.ts';

/** Discriminator passed to `makeSnapshotable` — narrower than the
 *  full mode union because the snapshot shape only cares about
 *  "local with containers" vs "known with nothing". */
export type WalrusSnapshotMode = 'local' | 'known';

/** Build the Snapshotable contribution.
 *
 *  `app` / `stack` / `walrusName` are resolved at the plugin's
 *  acquire-time so the snapshot's identity guard can match the
 *  plugin's actual container labels.
 *
 *  `nodeCount` (local mode only) drives the per-node managed-container
 *  decls. Each storage node carries `role: storage-node-${i}` so the
 *  substrate's label filter pauses/commits each independently. */
export const makeSnapshotable = (
	mode: WalrusSnapshotMode,
	app: string,
	stack: string,
	walrusName: string,
	chain: string,
	nodeCount = 1,
): SnapshotableDecl => {
	const labels = (role: string): ContainerLabelTuple => ({
		app,
		stack,
		plugin: 'walrus',
		role,
	});

	switch (mode) {
		case 'local': {
			const perNodeContainers: ReadonlyArray<ContainerLabelTuple> = Array.from(
				{ length: nodeCount },
				(_, i) => labels(`storage-node-${i}`),
			);
			return {
				kind: 'snapshotable',
				// `runtime/walrus/<name>/deploy/` — the deploy one-shot's
				// output dir. The substrate's runtime-dir root is
				// resolved at acquire; the path here is relative to it.
				subtrees: [`walrus/${walrusName}/deploy/`],
				managedContainers: perNodeContainers,
				missingTolerance: 'fine',
				// Storage nodes need >10s to flush + checkpoint RocksDB
				// on `docker stop`; the snapshot quiesce mirrors the
				// stop grace (distilled-doc invariant 22). Default
				// "pause container" gives us this for free in the
				// substrate's adapter.
				preRestore: Effect.succeed({
					kind: 'walrus' as const,
					mode: 'local' as const,
					name: walrusName,
					nodeCount,
					chain,
				}),
				postRestore: Effect.void,
				// Storage-node keystores are secret material; the
				// substrate preserves 0o600 on round-trip.
				secretMaterial: true,
			};
		}
		case 'known': {
			return {
				kind: 'snapshotable',
				subtrees: [],
				missingTolerance: 'fine',
				preRestore: Effect.succeed({
					kind: 'walrus' as const,
					mode: 'known' as const,
					chain,
				}),
			};
		}
	}
};
