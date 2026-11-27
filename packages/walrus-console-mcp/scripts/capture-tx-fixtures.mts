/**
 * Regenerate tests/fixtures/sponsoredTransactions.json from a live Console
 * deployment.
 *
 * Run this whenever the bucket-policy contract is redeployed, or whenever the
 * shape of a sponsored transaction changes — the allowlist in
 * src/console/txValidation.ts is derived from what Console ACTUALLY builds, and
 * a fixture that no longer matches production means the validator would refuse a
 * legitimate transaction.
 *
 *   pnpm tsx scripts/capture-tx-fixtures.mts
 *
 * Needs a configured ~/.config/walrus-console-mcp/config.json with both the
 * working and Key-Admin credentials, pointed at a NON-PRODUCTION deployment.
 *
 * It mints a throwaway read/write key named txshape-fixture-<timestamp> to learn
 * the private bucket group ids. Delete that key afterwards. The legacy reserve is kept as a rejection
 * fixture. Use capture-746-fixture.mts for current bucket reserves.
 *
 * The output contains addresses, object ids, and transaction bytes — no secrets.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { writeFileAtomic } from "../src/atomicWrite.js";

const fixturePath = "tests/fixtures/sponsoredTransactions.json";
const cfg = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/walrus-console-mcp/config.json"), "utf-8"),
);
const addr = (seed: string) =>
  Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(seed).secretKey).toSuiAddress();

const call = async (p: string, key: string, init?: RequestInit) => {
  const res = await fetch(`${cfg.baseUrl}${p}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${p} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

async function main() {
  const existing = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
  if (
    typeof existing?.workingAddress !== "string" ||
    !existing.workingAddress ||
    typeof existing.createBucket?.bytes !== "string" ||
    !existing.createBucket.bytes ||
    typeof existing.createBucket.bucketId !== "string" ||
    !existing.createBucket.bucketId
  ) {
    throw new Error(`The legacy reserve and its signer must be present in ${fixturePath}.`);
  }
  const workingAddress = existing.workingAddress;
  const adminAddress = addr(cfg.adminServicePrivateKey);

  const child = Ed25519Keypair.generate();
  const minted = await call("/api/v1/api-keys", cfg.adminKey, {
    method: "POST",
    body: JSON.stringify({
      permissions: "read_write",
      serviceSignerAddress: child.toSuiAddress(),
      name: `txshape-fixture-${Date.now()}`,
    }),
  });
  const groupIds = (minted.private_buckets ?? []).map((b: any) => b.group_id);
  const sponsorRw = await call("/api/v1/seal/sponsor", cfg.adminKey, {
    method: "POST",
    body: JSON.stringify({
      kind: "grant_bucket_access",
      groupIds,
      recipientAddress: child.toSuiAddress(),
      scope: "readwrite",
    }),
  });
  const sponsorRo = await call("/api/v1/seal/sponsor", cfg.adminKey, {
    method: "POST",
    body: JSON.stringify({
      kind: "grant_bucket_access",
      groupIds,
      recipientAddress: child.toSuiAddress(),
      scope: "read",
    }),
  });

  const out = {
    _comment:
      "Captured from live testnet Console on 2026-08-18. Real transaction bytes, no secrets: " +
      "addresses and object ids only. Regenerate with scripts/capture-tx-fixtures.mts if the " +
      "bucket-policy contract is redeployed.",
    network: "testnet",
    workingAddress,
    adminAddress,
    createBucket: existing.createBucket,
    grantBucketAccessReadWrite: {
      bytes: sponsorRw.bytes,
      recipientAddress: child.toSuiAddress(),
      groupIds,
    },
    grantBucketAccessRead: {
      bytes: sponsorRo.bytes,
      recipientAddress: child.toSuiAddress(),
      groupIds,
    },
  };
  writeFileAtomic(fixturePath, `${JSON.stringify(out, null, 2)}\n`, {
    mode: 0o644,
    preserveExistingMode: true,
  });
  console.log("workingAddress:", workingAddress);
  console.log("adminAddress  :", adminAddress);
  console.log("groups        :", groupIds.length);
  console.log("written tests/fixtures/sponsoredTransactions.json");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
