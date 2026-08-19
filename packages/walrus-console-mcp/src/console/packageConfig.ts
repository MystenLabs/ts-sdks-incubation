/**
 * Bucket-policy package identifiers and the Sui network they belong to.
 *
 * These values MIRROR harbor `ts-sdks/packages/bucket-groups/src/constants.ts`.
 * `@walrus-console/bucket-groups` is an unpublished workspace package inside
 * harbor with no release pipeline, and this is a separate repository, so the
 * constants are copied rather than imported. Re-sync them whenever the contract
 * is redeployed — a stale copy here silently breaks every private-file
 * operation (COMG-601).
 */

export type SuiNetwork = "testnet" | "mainnet";

export interface BucketGroupPackageConfig {
  /** Package hosting the callable entry points, including `seal_approve`. */
  readonly packageId: string;
  /** V1-rooted id. Seal derives its identity namespace from this, not `packageId`. */
  readonly originalPackageId: string;
  /** Shared BucketRegistry the version gate reads. Required by `seal_approve`. */
  readonly bucketRegistryId: string;
  /**
   * The `permissioned_group` framework package that `bucket_policy` builds on.
   *
   * Not used to build anything locally — it is here because the sponsored
   * create-bucket PTB calls into it (`permissioned_group::grant_permission`), and
   * `txValidation` has to know which packages that flow is allowed to touch
   * before signing it. Captured from a live testnet reserve; see
   * scripts/capture-tx-fixtures.mts.
   */
  readonly permissionedGroupPackageId: string;
}

export const TESTNET_PACKAGE_CONFIG: BucketGroupPackageConfig = {
  packageId: "0x28d1cf624b03376df62138a0372b506bbd456790ee183e244c25231a39c618db",
  originalPackageId: "0x28d1cf624b03376df62138a0372b506bbd456790ee183e244c25231a39c618db",
  bucketRegistryId: "0x314fc86db4449e75f542015fd952513393b4671f6cf1dea01fd1f94697d97ab6",
  permissionedGroupPackageId: "0xba8a26d42bc8b5e5caf4dac2a0f7544128d5dd9b4614af88eec1311ade11de79",
};

/**
 * Placeholder, exactly as it is in the SDK: the mainnet `walrus_console::bucket_policy`
 * package has not shipped, so these are stand-in values. Do not treat mainnet as
 * verified until COMG-584's mainnet acceptance criterion closes.
 */
export const MAINNET_PACKAGE_CONFIG: BucketGroupPackageConfig = {
  packageId: "0x42e9f3b7d4ba898053835cbe8ff77bcd3580a1dc06820ae4e641fee11a455e9c",
  originalPackageId: "0x42e9f3b7d4ba898053835cbe8ff77bcd3580a1dc06820ae4e641fee11a455e9c",
  bucketRegistryId: "0x8fcff989d2f404b19e4a36c09add2166a76e7b1e73de3d3fb9afda003991270b",
  // Placeholder like the rest of this block. Note the consequence for
  // `txValidation`: a wrong id here does not weaken the check, it makes every
  // mainnet create-bucket signature refuse. That is the correct direction to fail
  // in, and it is another reason mainnet stays unverified until COMG-584 closes.
  permissionedGroupPackageId: "0x0000000000000000000000000000000000000000000000000000000000000000",
};

const PACKAGE_CONFIGS: Record<SuiNetwork, BucketGroupPackageConfig> = {
  testnet: TESTNET_PACKAGE_CONFIG,
  mainnet: MAINNET_PACKAGE_CONFIG,
};

const FULLNODE_URLS: Record<SuiNetwork, string> = {
  testnet: "https://fullnode.testnet.sui.io:443",
  mainnet: "https://fullnode.mainnet.sui.io:443",
};

/**
 * Derive the Sui network from the Console API base URL.
 *
 * The network is not configured separately on purpose: a standalone setting can
 * disagree with the API the MCP is actually talking to, and that disagreement is
 * invisible until a decrypt fails. Loopback and anything unrecognised fall back to
 * testnet, which is what local stacks run against.
 */
export function resolveSuiNetwork(baseUrl: string): SuiNetwork {
  try {
    return new URL(baseUrl).hostname.includes("mainnet") ? "mainnet" : "testnet";
  } catch {
    return "testnet";
  }
}

export function resolvePackageConfig(network: SuiNetwork): BucketGroupPackageConfig {
  return PACKAGE_CONFIGS[network];
}

export function resolveFullnodeUrl(network: SuiNetwork): string {
  return FULLNODE_URLS[network];
}
