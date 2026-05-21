// Wallet plugin — Snapshotable contribution.
//
// The dev-wallet pairing token is plugin-owned state. Snapshot L3 must
// not special-case its runtime path; the wallet declares the subtree
// like any other stateful plugin.

import { Effect } from 'effect';

import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';

export const makeWalletSnapshotable = (): SnapshotableDecl => ({
	kind: 'snapshotable',
	subtrees: ['wallet/token'],
	missingTolerance: 'fatal',
	secretMaterial: true,
	preRestore: Effect.succeed({ kind: 'wallet-pairing-token' as const }),
	postRestore: Effect.void,
});
