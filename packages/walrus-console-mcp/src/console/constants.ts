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

export const SealIdentity = bcs.struct("SealIdentity", {
  policyObjectId: bcs.Address,
  nonce: bcs.fixedArray(32, bcs.u8()),
});

export type SealIdentityInput = {
  policyObjectId: string;
  nonce: number[];
};
