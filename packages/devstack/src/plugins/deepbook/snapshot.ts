// Deepbook plugin — Snapshotable contribution.
//
// What needs to survive snapshot:
//
//   - Cached publish receipts under runtime/deepbook/<name>/cache/
//     (driven by the artifact publisher primitive's cache layer; the host-tree
//     subtree is `deepbook/<name>` and the artifact publisher cache lives inside it).
//   - Managed containers — the optional indexer + server use
//     labeled tuples drive the docker commit + save path.
//
// Architecture: the orchestrator is service-name-blind — it walks
// the Snapshotable decls, sees `deepbook/<name>` as just a subtree
// path, and treats the secret flag as opaque.

import { Effect } from 'effect';

import type { ContainerLabelTuple, SnapshotableDecl } from '../../contracts/snapshotable.ts';

/** Build the Snapshotable contribution for the local-mode plugin. */
export const makeLocalSnapshotable = (inputs: {
	readonly name: string;
	readonly app: string;
	readonly stack: string;
	readonly indexerEnabled: boolean;
	readonly serverEnabled: boolean;
}): SnapshotableDecl => {
	const managed: Array<ContainerLabelTuple> = [];
	if (inputs.indexerEnabled) {
		managed.push({
			app: inputs.app,
			stack: inputs.stack,
			plugin: 'deepbook',
			role: 'indexer',
		});
	}
	if (inputs.serverEnabled) {
		managed.push({
			app: inputs.app,
			stack: inputs.stack,
			plugin: 'deepbook',
			role: 'server',
		});
	}
	return {
		kind: 'snapshotable',
		subtrees: [`deepbook/${inputs.name}`],
		managedContainers: managed,
		quiesce: Effect.void,
		preRestore: Effect.succeed({ kind: 'deepbook' as const, name: inputs.name }),
		postRestore: Effect.void,
		missingTolerance: 'fine',
		secretMaterial: false,
	};
};

/** Build the Snapshotable contribution for the known-deployment
 *  mode. No on-disk state, no managed containers — pure value
 *  producer. */
export const makeKnownSnapshotable = (inputs: { readonly name: string }): SnapshotableDecl => ({
	kind: 'snapshotable',
	subtrees: [],
	preRestore: Effect.succeed({ kind: 'deepbook' as const, name: inputs.name }),
	postRestore: Effect.void,
	missingTolerance: 'fine',
	secretMaterial: false,
});
