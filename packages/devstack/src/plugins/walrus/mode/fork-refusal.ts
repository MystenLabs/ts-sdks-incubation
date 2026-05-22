// Walrus mode — fork refusal.
//
// Distilled-doc reference (06-walrus.md §"Modes & variants" cell
// `fork-localcluster-refused`):
//
//   - `walrusLocalCluster()` MUST refuse `*-fork` networks at
//     factory time. sui-fork doesn't expose JSON-RPC; the local
//     cluster's storage nodes need JSON-RPC against the chain.
//   - The refusal is SYNCHRONOUS — letting the supervisor partway
//     through the image build before the nodes fail to dial would
//     be confusing.
//   - The error carries an actionable `hint` pointing at the
//     correct fork-compatible factory (`walrusFor(network).known({...})`).
//
// Architecture (Tension 11 + asymmetric fanout): the PRIMARY refusal
// lives at the TYPE level via the mode-narrowed factory namespace
// (`walrusFor(network).<mode>` — the `.local` property is absent on
// fork-mode networks). This file is
// defense-in-depth for callers that bypass the typed namespace.
//
// Why a dedicated file: the refusal logic IS the mode body. Keeping
// it in `mode/fork-refusal.ts` makes the four-modes symmetry visible
// in the directory listing and lets `service.ts` dispatch by mode
// without an "else" branch.

import { ForkIncompatibleError, forkIncompatibleError } from '../errors.ts';

/** Synchronous factory-time refusal. Throws the typed
 *  `ForkIncompatibleError` so the misconfiguration surfaces at the
 *  `defineDevstack(...)` call site, not at runtime acquire.
 *
 *  Architecture: this is the *runtime* refusal. The *compile-time*
 *  refusal happens in `index.ts` — the `walrusFor(...)` namespace's
 *  fork branch exposes only `.known`, so `.local` is a type-system
 *  error. */
export const refuseLocalClusterOnFork = (network: string): never => {
	throw forkIncompatibleError(network);
};

/** Type-only re-export so consumers can `catch` by tag without
 *  importing from the errors module. */
export type { ForkIncompatibleError };
