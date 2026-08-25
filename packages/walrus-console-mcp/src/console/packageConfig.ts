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

/**
 * The COMG-746/761 staging deploy at `api.testnet.patestation.org`.
 *
 * COMG-746 is "align with the REPUBLISHED contract": that branch republished
 * `walrus_console` (harbor `e0a74060`), so the staging API builds its PTBs
 * against a different `bucket_policy` package and a different registry than the
 * one production testnet still runs. Both hosts are the testnet *network*, so
 * network alone cannot tell them apart — hence a host-keyed entry rather than a
 * change to `TESTNET_PACKAGE_CONFIG`, which would break the default endpoint.
 *
 * These four values were read back out of a live reserve from that deployment
 * (`scripts/probe-746-package-ids.mts`), not copied from a document: the ids in
 * harbor's `constants.ts` live on the unmerged republish branch, and its main
 * still carries the production ids below.
 *
 * TEMPORARY. When the republish merges and production testnet is upgraded, this
 * collapses back into `TESTNET_PACKAGE_CONFIG` and this entry is deleted. A
 * stale entry here does not weaken anything — a wrong package id makes every
 * signature REFUSE (`txValidation` allowlists exact packages), which is the
 * direction to fail in.
 */
export const STAGING_TESTNET_PACKAGE_CONFIG: BucketGroupPackageConfig = {
  packageId: "0xea146b35c7998a6da2db993a378058b3dffab71a60317ed2d587aecff6a498c6",
  originalPackageId: "0xea146b35c7998a6da2db993a378058b3dffab71a60317ed2d587aecff6a498c6",
  bucketRegistryId: "0xa425e58c5cb70069488301c9e296831ab7cecaa3ac547cabbad7f29dbf0bd83e",
  // Unchanged by the republish: `permissioned_group` is the sui-groups framework
  // package, versioned independently of `bucket_policy`.
  permissionedGroupPackageId: "0xba8a26d42bc8b5e5caf4dac2a0f7544128d5dd9b4614af88eec1311ade11de79",
};

/** Hosts whose Console API builds PTBs against a non-default package set. */
const HOST_PACKAGE_CONFIGS: Record<string, BucketGroupPackageConfig> = {
  "api.testnet.patestation.org": STAGING_TESTNET_PACKAGE_CONFIG,
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
 * The package set the Console at `baseUrl` actually builds its PTBs against.
 *
 * Prefer this over `resolvePackageConfig(resolveSuiNetwork(...))` anywhere the
 * result is compared against bytes that host returned. Two Console deployments
 * can sit on the same Sui network and different contract versions — that is the
 * state during a republish — and network alone cannot distinguish them, so
 * resolving by network there pins the wrong package and refuses every
 * signature. Hosts with no entry fall through to their network's config.
 */
export function resolvePackageConfigForBaseUrl(baseUrl: string): BucketGroupPackageConfig {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return resolvePackageConfig(resolveSuiNetwork(baseUrl));
  }
  // `Object.hasOwn` rather than a bare index. `host` is caller-supplied, and
  // `HOST_PACKAGE_CONFIGS` is an object literal, so `https://constructor/` would
  // otherwise resolve through `Object.prototype` and return a FUNCTION where a
  // package config belongs — the same prototype-chain hole `anchorStore` closes
  // with a prototype-less map. One guard is enough here because this map has
  // exactly one reader and is a fixed literal rather than something built from
  // untrusted input. Unreachable today (the base-URL allowlist filters the host
  // long before this) and kept anyway: nothing about this function documents
  // that the allowlist is what makes it safe.
  const hostConfig = Object.hasOwn(HOST_PACKAGE_CONFIGS, host)
    ? HOST_PACKAGE_CONFIGS[host]
    : undefined;
  return hostConfig ?? resolvePackageConfig(resolveSuiNetwork(baseUrl));
}

export function resolveFullnodeUrl(network: SuiNetwork): string {
  return FULLNODE_URLS[network];
}
