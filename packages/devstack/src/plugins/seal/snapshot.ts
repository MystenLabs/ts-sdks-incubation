// Seal plugin — Snapshotable contribution.
//
// Distilled-doc §"What survives snapshot":
//
//   - `runtime/seal/master-key.env`              (0o600 — SECRET MATERIAL)
//   - `runtime/seal/local-keygen-state.v1.json`  (public key metadata)
//   - `runtime/seal/key-server-config.yaml`
//   - Content-addressed cache entries (the keypair the ArtifactPublisher
//     persists under `cache/<namespace>/<chainId>/...`, auto-captured by
//     the substrate's cache subtree — we don't declare a subtree for those).
//   - Managed container — labeled tuple drives the docker commit +
//     save path.
//
// Distilled-doc invariant: the master-key file is the LOAD-BEARING
// piece — losing it on resume means the on-chain `KeyServer.url`'s
// public key would mismatch a fresh keygen. The substrate's
// `secretMaterial: true` flag drives the mode-bit round-trip (0o600
// inside 0o700 parent preserved through the snapshot tar).
//
// Architecture: the orchestrator is service-name-blind — it walks
// the Snapshotable decls, sees `runtime/seal/` as just a subtree
// path, and treats the secret flag as an opaque mode-bit directive.

import { Effect } from 'effect';

import type { ContainerLabelTuple, SnapshotableDecl } from '../../contracts/snapshotable.ts';

/** Build the Snapshotable contribution for the local-keygen mode.
 *
 *  Inputs threaded by the barrel from acquire-time substrate
 *  identity. Distilled-doc invariant #4: `master-key.env` MUST
 *  survive snapshot. `missingTolerance: 'fatal'` because the file's
 *  absence on restore would silently re-derive a fresh keypair
 *  against a stale on-chain public key. */
export const makeLocalKeygenSnapshotable = (inputs: {
	readonly name: string;
	readonly app: string;
	readonly stack: string;
}): SnapshotableDecl => {
	const labelTuple: ContainerLabelTuple = {
		app: inputs.app,
		stack: inputs.stack,
		plugin: 'seal',
		role: 'key-server',
	};
	return {
		kind: 'snapshotable',
		// Subtree under runtime/. The substrate roots this under the
		// per-stack runtime-dir; `seal` is plugin-blind from the
		// orchestrator's POV (just a path segment).
		subtrees: [`seal`],
		managedContainers: [labelTuple],
		// The key-server's Docker stop grace is owned by key-server.ts.
		quiesce: Effect.void,
		preRestore: Effect.succeed({
			kind: 'seal' as const,
			name: inputs.name,
		}),
		postRestore: Effect.void,
		missingTolerance: 'fatal',
		// Distilled-doc §Hard requirements #2 + #4: master-key.env is
		// secret material (0o600). The substrate's tar handler
		// preserves the mode bits on round-trip.
		secretMaterial: true,
	};
};

/** Build the Snapshotable contribution for the known-deployment
 *  modes (live / fork-known). No managed container, no on-disk
 *  state — we only need the orchestrator to see the plugin's
 *  identity for the manifest sidecar.
 *
 *  `missingTolerance: 'fine'` because the known-deployment mode
 *  has no host-side state to lose. */
export const makeKnownSnapshotable = (inputs: { readonly name: string }): SnapshotableDecl => ({
	kind: 'snapshotable',
	subtrees: [],
	missingTolerance: 'fine',
	preRestore: Effect.succeed({ kind: 'seal' as const, name: inputs.name }),
	postRestore: Effect.void,
	secretMaterial: false,
});
