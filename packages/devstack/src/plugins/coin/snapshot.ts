// Coin plugin — Snapshotable contribution.
//
// Distilled-doc 13-coin.md §Persistence model:
//
//   - The mint-cache (`coin/mint/<chainId>/...`) lives in the
//     state-store and IS captured by the substrate's auto-included
//     subtree under `runtime/<plugin-key>/state-store/...`. We
//     declare no extra subtrees here.
//   - The `CoinRegistry` is purely in-process; nothing to capture.
//   - Per-Layer-invocation metadata cache is also in-process.
//
// The plugin therefore emits a MINIMAL snapshot decl:
// `missingTolerance: 'fine'` (a fresh stack with no cache entries
// just re-mints / re-resolves on next acquisition), no subtrees, no
// containers. The decl exists for shape symmetry with the other
// plugins and so a per-coin "wipe" recipe has a contribution to
// target in the future.

import { Effect } from 'effect';

import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';

/** Identity guard for the snapshot orchestrator. Per-coin record so
 *  the substrate can dedup by `(plugin, symbol)` if a future
 *  per-coin wipe lands. */
export const makeCoinSnapshotable = (parts: { readonly symbol: string }): SnapshotableDecl => ({
	kind: 'snapshotable',
	subtrees: [],
	missingTolerance: 'fine',
	preRestore: Effect.succeed({
		kind: 'coin' as const,
		symbol: parts.symbol,
	}),
	postRestore: Effect.void,
});
