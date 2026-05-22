// Walrus plugin — main acquire body. Mode dispatch.
//
// Distilled-doc reference (06-walrus.md §"Modes & variants" — four
// distinct operating modes):
//
//   - local                       — `walrusLocalCluster(...)`
//   - live (testnet/mainnet)      — `walrusKnownDeployment(...)`
//   - fork-known (`*-fork`)       — auto-routes to known-deployment
//                                    with the wrapped upstream
//   - fork-localcluster-refused   — synchronous refusal at factory
//                                    time
//
// Architecture: Walrus is ONE plugin with internal mode dispatch.
// The factory at the barrel (`index.ts`) constructs the discriminator
// from typed options (or from the resolved network); this file
// dispatches on the discriminator and assembles mode-appropriate
// subsystems.
//
// What this file does:
//
//   1. Receive a resolved mode discriminator.
//   2. Dispatch to the right `boot*` builder.
//   3. Return the mode's boot artifacts (the barrel projects them
//      onto the plugin's resolved value).
//
// What it does NOT do:
//
//   - Provision the container runtime — that arrives via the
//     `BuildContext` passed by the barrel.
//   - Resolve bootstrap assets — local-cluster mode owns those
//     resolvers; this file just dispatches.

import { Effect, FileSystem, Path, type Scope } from 'effect';

import type { ArtifactPublishError } from '../../primitives/artifact-publisher.ts';
import type { WalrusError } from './errors.ts';
import {
	bootKnownDeployment,
	type KnownDeploymentBootResult,
	type WalrusKnownDeploymentOptions,
} from './mode/known-deploy.ts';
import {
	bootLocalCluster,
	type LocalClusterBootResult,
	type LocalClusterDeps,
	type ResolvedLocalClusterOptions,
} from './mode/local-cluster.ts';
import { refuseLocalClusterOnFork } from './mode/fork-refusal.ts';

/** Mode discriminator. Internal — the barrel constructs ONE of these
 *  per composed walrus instance and dispatches here. */
export type WalrusMode =
	| { readonly mode: 'local'; readonly opts: ResolvedLocalClusterOptions }
	| { readonly mode: 'known'; readonly opts: WalrusKnownDeploymentOptions };

/** Result of one acquire — discriminated by mode so the barrel can
 *  project mode-asymmetrically onto the tag set. */
export type WalrusBootResult = LocalClusterBootResult | KnownDeploymentBootResult;

/** Dispatch on the mode and return the boot artifacts.
 *
 *  `deps` is the local-cluster's full dependency bundle. The known
 *  branch ignores all of it (no I/O at acquire time — purely
 *  synchronous projection from options); the type lets the barrel
 *  pass one record for both paths. */
export const bootWalrusService = (
	deps: LocalClusterDeps,
	mode: WalrusMode,
): Effect.Effect<
	WalrusBootResult,
	WalrusError | ArtifactPublishError,
	Scope.Scope | FileSystem.FileSystem | Path.Path
> => {
	switch (mode.mode) {
		case 'local':
			return bootLocalCluster(deps, mode.opts);
		case 'known':
			return bootKnownDeployment(mode.opts);
	}
};

// Re-export so callers (the barrel's `walrus()` factory's fork
// branch) can invoke the refusal directly without an extra import.
export { refuseLocalClusterOnFork };
