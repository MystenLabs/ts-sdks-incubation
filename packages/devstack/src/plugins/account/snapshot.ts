// Account plugin — Snapshotable contribution.
//
// Architecture §3 + 12-account.md "Cross-component references":
// Account's persisted secret material lives under the runtime tree
// at `runtime/account/<name>.key` (bech32 secret, 0o600 inside a
// 0o700 parent). The runtime-rooted tar already captures this via
// the substrate's auto-included subtree convention — Account just
// declares the SECRET-MATERIAL flag so the substrate preserves the
// permissions bits on round-trip.
//
// Distilled-doc invariant ("Restrictive file permissions"): the
// 0o600 / 0o700 mode bits are load-bearing. The `secretMaterial:
// true` flag drives the substrate's mode-bit preservation;
// re-tightening on warm-start is the runtime's job (snapshot only
// captures + restores).
//
// Variants that do NOT persist secret material (`signer`,
// `impersonate`) emit an EMPTY snapshot decl with
// `missingTolerance: 'fine'` so cross-variant restores are clean
// no-ops.

import { Effect } from 'effect';

import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';
import type { AccountVariantKind } from './errors.ts';

/** Build the Snapshotable contribution for a resolved variant.
 *
 *  Only the `ephemeral` variant declares a persisted subtree, scoped
 *  to a single account's key path. */
export const makeAccountSnapshotable = (parts: {
	readonly accountName: string;
	readonly variant: AccountVariantKind;
	readonly app: string;
	readonly stack: string;
}): SnapshotableDecl => {
	if (parts.variant !== 'ephemeral') {
		return {
			kind: 'snapshotable',
			subtrees: [],
			missingTolerance: 'fine',
		};
	}

	return {
		kind: 'snapshotable',
		// Per-account secret file under the runtime tree. The
		// substrate's runtime-tar already covers `runtime/account/`
		// inclusively; this opt-in extra is symmetric with Sui's
		// `sui-fork/` subtree declaration.
		subtrees: [`account/${parts.accountName}.key`],
		missingTolerance: 'fine',
		secretMaterial: true,
		// Pre-restore identity guard: assert the snapshot was taken
		// under the same `(app, stack, name)` triplet. The substrate's
		// identity walker reads this opaquely.
		preRestore: Effect.succeed({
			kind: 'account-secret',
			account: parts.accountName,
			app: parts.app,
			stack: parts.stack,
		}),
		postRestore: Effect.void,
	};
};
