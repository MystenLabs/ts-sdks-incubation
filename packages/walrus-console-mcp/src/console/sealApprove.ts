import { Transaction } from "@mysten/sui/transactions";

import type { BucketGroupPackageConfig } from "./packageConfig";

/**
 * Build the `seal_approve` access-check transaction kind. Never broadcast — Seal
 * key servers evaluate it to decide whether to release shares.
 *
 * The argument list is `(id, registry, group)`. The registry was added by the
 * version-gating redeploy and is not optional: omitting it is an argument-count
 * mismatch, and passing a group from a different package is a type mismatch.
 * Mirrors `bucketPolicy.sealApprove` in `@walrus-console/bucket-groups`.
 *
 * Kept separate from SealCryptoService so the call shape is assertable without a
 * Sui client or a network round-trip.
 */
export function buildSealApproveTransaction(
  packageConfig: BucketGroupPackageConfig,
  idBytes: Uint8Array,
  groupId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageConfig.packageId}::bucket_policy::seal_approve`,
    arguments: [
      tx.pure.vector("u8", Array.from(idBytes)),
      tx.object(packageConfig.bucketRegistryId),
      tx.object(groupId),
    ],
  });
  return tx;
}
