/**
 * Seal constants for Walrus Console.
 *
 * Package identifiers moved to `packageConfig.ts` — they are network-dependent and
 * change on every contract redeploy, so they are resolved rather than pinned here.
 *
 * Key server identifiers moved to `seal-config.ts` (COMG-604) for the same reason: the
 * committee is per-network, and it is resolved alongside the aggregator endpoint that
 * fronts it.
 */

// BCS schema for Seal identity (must exactly match the on-chain `seal_approve` check).
import { bcs } from "@mysten/sui/bcs";
import { normalizeSuiAddress, toHex } from "@mysten/sui/utils";

export const SealIdentity = bcs.struct("SealIdentity", {
  policyObjectId: bcs.Address,
  nonce: bcs.fixedArray(32, bcs.u8()),
});

export type SealIdentityInput = {
  policyObjectId: string;
  nonce: number[];
};

/** Length of the policy-object prefix `seal_approve` checks, in bytes. */
const POLICY_PREFIX_BYTES = 32;

/**
 * Read the policy object a Seal ciphertext is bound to.
 *
 * On-chain, `seal_approve` asserts that the group object id equals the first 32
 * bytes of the identity (`EInvalidPrefix`), so that prefix is the only group that
 * can ever approve the ciphertext. Decryption therefore derives the policy from it;
 * nothing is compared against a caller-supplied id.
 *
 * Only the prefix is read. It is the contractual part: the nonce after it is this
 * client's (and Harbor's) convention, and Seal treats the identity as opaque bytes,
 * so parsing the full `SealIdentity` would reject identities the contract accepts.
 */
export function parseSealIdentityPolicyId(idBytes: Uint8Array): string {
  if (idBytes.length < POLICY_PREFIX_BYTES) {
    throw new Error(
      `Seal identity is ${idBytes.length} bytes; a ${POLICY_PREFIX_BYTES}-byte policy prefix is required`,
    );
  }
  return normalizeSuiAddress(toHex(idBytes.subarray(0, POLICY_PREFIX_BYTES)));
}
