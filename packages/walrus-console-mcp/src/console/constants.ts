/**
 * Testnet constants for Walrus Console + Seal.
 * Sourced directly from:
 * - https://api.testnet.harbor.walrus.xyz/docs/quickstart.md
 * - console/alpha-docs/Console API Quickstart.md
 *
 * These are pinned for the alpha testnet deployment.
 * DO NOT change without updating the corresponding on-chain objects.
 */

// Original (immutable) package id of the Console bucket-policy package.
// Seal derives identity using the ORIGINAL package id, even after upgrades.
export const CONSOLE_ORIGINAL_PACKAGE_ID =
  "0x8b2429358e9b0f005b69fe8ad3cbd1268ad87f35047a21612e082c64824faf8d";

// Latest (upgradable) package id that hosts the `seal_approve` entry function.
export const CONSOLE_LATEST_PACKAGE_ID =
  "0xc11d875481544e9b6c616f7d6704266e1633b4034eab7ed76626dc25ebfcd506";

// Seal key servers on testnet (threshold = 2 out of 3).
export const SEAL_KEY_SERVER_OBJECT_IDS = [
  "0x6068c0acb197dddbacd4746a9de7f025b2ed5a5b6c1b1ab44dade4426d141da2",
  "0x164ac3d2b3b8694b8181c13f671950004765c23f270321a45fdd04d40cccf0f2",
  "0x9c949e53c36ab7a9c484ed9e8b43267a77d4b8d70e79aa6b39042e3d4c434105",
] as const;

// Fullnode used for Seal + Sui operations in this MCP server.
export const SUI_TESTNET_FULLNODE = "https://fullnode.testnet.sui.io:443";

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
