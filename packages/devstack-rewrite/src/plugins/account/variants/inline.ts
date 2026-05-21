// Account variant — inline (literal bech32 secret in config).
//
// Distilled-doc warning: TESTS AND DEMOS ONLY. The key is serialized
// as part of the user's devstack config; if that file is committed,
// the key is in their git history. The user-facing factory in
// `index.ts` mirrors the warning in JSDoc.
//
// This file accepts either a `string` (bech32 form) or a `Uint8Array`
// (raw 32-byte secret key). Both funnel through Ed25519 construction
// so downstream paths are uniform.

import { Effect } from 'effect';

import {
	decodeBech32Secret,
	resolvedKeypairFromEd25519Bytes,
	type ResolvedKeypair,
} from '../keypair.ts';
import type { AccountAcquireError } from '../errors.ts';

export interface InlineVariantArgs {
	readonly name: string;
	readonly secretKey: string | Uint8Array;
}

/** Resolve the inline variant. String input takes the bech32 decode
 *  path; Uint8Array input takes the raw-bytes-into-Ed25519 path. */
export const resolveInlineVariant = (
	args: InlineVariantArgs,
): Effect.Effect<ResolvedKeypair, AccountAcquireError> => {
	if (typeof args.secretKey === 'string') {
		return decodeBech32Secret(args.secretKey, args.name, 'inline');
	}
	return resolvedKeypairFromEd25519Bytes(args.secretKey, args.name, 'inline');
};
