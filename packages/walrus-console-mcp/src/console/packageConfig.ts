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
  packageId: "0xf9b261d4c0dbcf845d79f864e85581f9686fd6de9f4770ba1d77489d67f7833c",
  originalPackageId: "0xf9b261d4c0dbcf845d79f864e85581f9686fd6de9f4770ba1d77489d67f7833c",
  bucketRegistryId: "0x902841af0cd25c5f8dee4980fe2942687c9ca80db56d77ff67a4ba6d9d97b9cf",
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

/**
 * Public fullnodes, reached over **gRPC**. Every on-chain read in this client
 * goes through `SuiGrpcClient` — `SealCryptoService`'s (which it also hands to
 * `SealClient` and `SessionKey.create`, so the SDK's reads ride the same
 * transport) and `rosterVerification`'s own.
 *
 * JSON-RPC is not an alternative here, it is GONE: the same host answers
 * `sui_getObject` with `-32601 "Method not found. JSON-RPC on public fullnodes
 * has been deprecated. Please migrate to gRPC or GraphQL endpoints."` Verified
 * live on 2026-08-22 against testnet; `scripts/probe-sui-transport.mts` re-checks
 * both halves (gRPC answers, JSON-RPC does not) and is the thing to run if a
 * chain read ever starts failing in a way that tempts someone to switch back.
 *
 * The host:port is the same for both — which is why a JSON-RPC caller fails at
 * the METHOD rather than at connect, and so reads as a broken query rather than
 * a wrong transport.
 */
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

/**
 * The package set the Console at `baseUrl` builds its PTBs against.
 *
 * Today this is purely network-derived: with one environment per network
 * (staging → testnet, production → mainnet), a Console host and its Sui network
 * identify the package set together. If a rollout ever puts two Console
 * deployments on the same network with different contract versions, this is the
 * seam to reintroduce a host-keyed override at — resolve the host first, fall
 * through to the network config.
 */
export function resolvePackageConfigForBaseUrl(baseUrl: string): BucketGroupPackageConfig {
  return resolvePackageConfig(resolveSuiNetwork(baseUrl));
}

export function resolveFullnodeUrl(network: SuiNetwork): string {
  return FULLNODE_URLS[network];
}
