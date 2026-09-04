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

import { CONSOLE_API_BASE_URLS } from "../baseUrl.js";

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
 * The mainnet `walrus_console` publish of 2026-09-01. Fresh v1 publish, so
 * `originalPackageId` equals `packageId`.
 */
export const MAINNET_PACKAGE_CONFIG: BucketGroupPackageConfig = {
  packageId: "0xb8d5b1cade7917190c47b8abfc789f527389fc021a8963c22755bcc1b539786c",
  originalPackageId: "0xb8d5b1cade7917190c47b8abfc789f527389fc021a8963c22755bcc1b539786c",
  bucketRegistryId: "0x871f3d0341f36101ff0b30cd01dbe363f8d89d7f004df80e8084752d2f496958",
  // The mainnet sui-groups framework package, verified via MVR. As everywhere
  // else, a wrong id here does not weaken `txValidation` — it makes every
  // mainnet create-bucket signature refuse, which is the direction to fail in.
  permissionedGroupPackageId: "0x541840ae7df705d1c6329c22415ed61f9140a18b79b13c1c9dc7415b115c1ba8",
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
 * invisible until a decrypt fails.
 *
 * In normal use this is a lookup, not a guess: the two canonical deployments
 * (`CONSOLE_API_BASE_URLS` — the only hosts a default or documented setup ever
 * points at) are matched by exact host. The heuristic below only ever sees
 * non-canonical hosts, i.e. local stacks and internal staging deploys:
 * "testnet" in the hostname, loopback, and unparseable URLs resolve testnet;
 * anything else resolves mainnet, matching the published package's mainnet
 * default.
 *
 * A misnamed internal deploy (a testnet-backed Console on a host without
 * "testnet" in its name — none exists, and the base-URL allowlist already
 * confines hosts to company domains) would surface on that deploy as refused
 * signatures (`txValidation` pins exact package ids) and undecryptable
 * uploads. Give such a host an exact-match entry here rather than relying on
 * its name.
 */
export function resolveSuiNetwork(baseUrl: string): SuiNetwork {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "testnet";
  }
  for (const network of ["mainnet", "testnet"] as const) {
    if (host === new URL(CONSOLE_API_BASE_URLS[network]).hostname) return network;
  }
  // URL.hostname brackets IPv6, so "[::1]" is the only spelling that can occur.
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (loopback || host.includes("testnet")) return "testnet";
  return "mainnet";
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
