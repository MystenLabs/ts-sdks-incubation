// Account variant — ephemeral (generate-or-recover, fund-by-default).
//
// Distilled-doc invariants:
//
//   - "Concurrent first-time keypair persistence": EXCL-create write.
//     Two parallel generators must not both win; the loser falls
//     back to reading the winner's persisted key.
//   - "Restrictive file permissions": 0o600 secret + 0o700 parent.
//   - "Bare form equals ephemeral-funded": this resolver is what the
//     bare `account('alice')` factory call lands on.
//   - "Auto-promotion to fork-impersonate funding": handled in
//     `funding.ts`; this file just hands off the address. The
//     promotion event is emitted there (loud-by-default).
//
// Persistence note: the EXCL-write + read-existing dance lands when
// the substrate's atomic-write primitive is wired in. For now we
// generate a fresh keypair per acquire — that matches "ephemeral"
// semantically; warm-restart equivalence is a separate concern
// surfaced via the snapshot capability, which serializes the
// resolved bech32 secret. The factory boundary already guards
// against accidental on-chain pollution by funding through the
// faucet which is idempotent on a fresh address.

import { Effect } from 'effect';

import { generateEd25519Keypair, type ResolvedKeypair } from '../keypair.ts';
import type { AccountAcquireError } from '../errors.ts';

export interface EphemeralVariantArgs {
	readonly name: string;
	/** Filesystem path where the bech32 secret will be persisted by
	 *  the substrate's snapshot capability. Captured here for the
	 *  forthcoming EXCL-write path. */
	readonly secretFilePath: string;
}

/** Resolve the ephemeral variant — generate a fresh Ed25519 keypair.
 *
 *  The persistence path (EXCL-write + chmod + concurrent-winner
 *  fallback) lands when the substrate's atomic-write primitive is
 *  threaded in. The `secretFilePath` arg is preserved so that wiring
 *  is a no-op rename. */
export const resolveEphemeralVariant = (
	args: EphemeralVariantArgs,
): Effect.Effect<ResolvedKeypair, AccountAcquireError> => {
	void args.secretFilePath;
	return generateEd25519Keypair(args.name);
};
