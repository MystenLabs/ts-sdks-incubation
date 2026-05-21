// Package plugin — Snapshotable contribution.
//
// Distilled doc §Cross-component references §snapshot: "persisted
// Package cache entries survive snapshot save/restore; the chain
// containers are tarred separately and on restore the verify probe
// re-confirms."
//
// The Package plugin OWNS the publishMove cache entries in the
// StateStore — those land under the substrate's runtime-dir root
// at `state-store/<plugin-key>/...` and are auto-captured by the
// substrate without an explicit subtree decl. We declare a
// `missingTolerance: 'fine'` shape because:
//
//   - A restored stack with a missing cache entry simply re-publishes
//     (cache miss). No data loss.
//   - A restored stack with a present cache entry runs the lenient
//     verify probe; if the chain snapshot also restored, the probe
//     resolves the cached id; otherwise it misses and re-publishes.
//
// No managed containers — the build container belongs to the Sui
// plugin (per-app, declared there). The Move build cache lives at
// `~/.move/git` on the host (NOT in a container) and is intentionally
// NOT captured: distilled doc §Cross-component references — vendored
// deps are content-addressed by sui-cli, re-fetched on demand.

import { Effect } from 'effect';

import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';

/** Build the Snapshotable contribution.
 *
 *  Identity guard: contributes the package's symbolic name + content
 *  hash to the pre-restore identity record. A snapshot taken under
 *  source-hash A restored against source-hash A is OK (verify probe
 *  re-confirms); a mismatch lets the substrate decide (typically:
 *  also OK — re-publish). The identity guard is mostly informational
 *  here. */
export const makeSnapshotable = (packageName: string, sourceHash: string): SnapshotableDecl => ({
	kind: 'snapshotable',
	subtrees: [],
	missingTolerance: 'fine',
	preRestore: Effect.succeed({
		kind: 'package' as const,
		name: packageName,
		sourceHash,
	}),
	postRestore: Effect.void,
});
