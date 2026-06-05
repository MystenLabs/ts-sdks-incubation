// Snapshotable capability contract (architecture §3).
//
// Lets the snapshot orchestrator capture and restore a plugin's
// state WITHOUT naming the plugin. The orchestrator walks decls;
// per-service paths/labels never appear in orchestrator code.
//
// -----------------------------------------------------------------------------
// Identity-contribution shape (`preRestore`)
// -----------------------------------------------------------------------------
//
// Each plugin's `preRestore` returns a typed object the orchestrator
// folds into the snapshot-side identity slice via
// `orchestrators/snapshot/identity-guard.ts`. The orchestrator runs
// `JSON.stringify` to derive a stable identity-comparison string, so
// every value MUST be JSON-serializable AND order-stable (the runtime
// reorders top-level keys before stringification — nested objects keep
// insertion order).
//
// Convention:
//
//   - `kind: '<plugin-key>'` — string literal, identifies the plugin so
//     two plugins can't accidentally write the same identity row.
//   - additional string-valued fields describe the identity scope
//     (chain, name, app, stack — only what the plugin's restore-side
//     guard needs to compare).
//
// Example shapes (see `plugins/{sui,seal,account,wallet}/snapshot.ts`):
//
//   { kind: 'sui-chain', chain: 'sui:testnet' }
//   { kind: 'seal', name: 'default' }
//   { kind: 'account-secret', account: 'alice', app: 'demo', stack: 'main' }
//   { kind: 'wallet-pairing-token' }
//
// -----------------------------------------------------------------------------
// Subtree convention (`subtrees`)
// -----------------------------------------------------------------------------
//
// A subtree string names a directory relative to the per-stack runtime
// root. The substrate auto-includes `runtime/<plugin-key>/` for every
// plugin; this list is opt-in extras (e.g. sibling directories outside
// the per-plugin tree). Convention:
//
//   - Directory paths SHOULD end with a trailing slash (e.g. `'sui-fork/'`)
//     so the substrate's tar walker recurses without an extra `stat`.
//   - File paths (no trailing slash, last segment carries an extension)
//     are allowed for single-file artifacts (`'wallet/token'`,
//     `'account/${name}.key'`). The substrate's tar handler stats the
//     entry and routes file vs directory automatically.
//
// TODO(plugins): migrate to the canonical shape — tracked sites:
//   - plugins/seal/snapshot.ts:50      `['seal']`           → `['seal/']`
//   - plugins/sui/snapshot.ts:87       `['sui-fork/']`      (already canonical)
//   - plugins/account/snapshot.ts:51   `['account/${name}.key']`  (file — keep)
//   - plugins/wallet/snapshot.ts:13    `['wallet/token']`         (file — keep)

import type { Effect } from 'effect';

/** Label tuple identifying managed containers. The orchestrator
 *  filters the runtime adapter by this tuple. */
export interface ContainerLabelTuple {
	readonly app: string;
	readonly stack: string;
	readonly plugin: string;
	readonly role: string;
}

/** A JSON-serializable value allowed inside an identity contribution.
 *  Excludes functions, symbols, undefined-valued slots inside objects,
 *  and class instances (anything `JSON.stringify` would drop or
 *  stringify lossy). */
export type IdentityContributionValue =
	| string
	| number
	| boolean
	| null
	| ReadonlyArray<IdentityContributionValue>
	| { readonly [field: string]: IdentityContributionValue | undefined };

/** Identity contribution shape returned by `preRestore`. Plugins MUST
 *  use a string-literal `kind` and JSON-serializable values; see the
 *  top-of-file convention section. The `[field]` index signature is
 *  permissive so existing payloads with `ReadonlyArray<string>` or
 *  nested object fields typecheck without
 *  per-plugin schema duplication. */
export interface IdentityContributionShape {
	readonly kind: string;
	readonly [field: string]: IdentityContributionValue | undefined;
}

/** Capture descriptor: zero or more subtrees + managed containers +
 *  optional typed metadata slice. */
export interface SnapshotableDecl {
	readonly kind: 'snapshotable';
	/** Host-tree subtrees, relative to the substrate's runtime-dir
	 *  root. Auto-included subtrees under `runtime/<plugin-key>/`
	 *  are added by the substrate; this list is opt-in extras. See
	 *  the top-of-file "Subtree convention" section for trailing-slash
	 *  + file-path rules. */
	readonly subtrees: ReadonlyArray<string>;
	/** Managed containers identified by label tuples — orchestrator
	 *  is name-blind. The capture bounce gracefully `docker stop`s each
	 *  (RocksDB/WAL flush) before commit, so no separate quiescence hook
	 *  is needed — the graceful stop IS the flush. */
	readonly managedContainers?: ReadonlyArray<ContainerLabelTuple>;
	/** Pre-restore hook: contribute to the identity guard. The returned
	 *  object is JSON-stringified to derive a stable comparison string.
	 *  See `IdentityContributionShape` + the top-of-file convention
	 *  section for the required shape. */
	readonly preRestore?: Effect.Effect<IdentityContributionShape, never>;
	/** Post-restore hook. */
	readonly postRestore?: Effect.Effect<void, never>;
	/** Missing-tolerance flag: is absence on restore fatal or fine? */
	readonly missingTolerance: 'fatal' | 'fine';
	/** Secret-material declaration drives mode bits (0o600 inside
	 *  0o700 parent). Substrate preserves on round-trip. */
	readonly secretMaterial?: boolean;
}
