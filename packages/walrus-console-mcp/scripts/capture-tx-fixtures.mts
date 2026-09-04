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
 * Side effects, deliberately left un-finalized but not free: it reserves a bucket
 * (never finalized, so no gas is spent and no bucket is created) and mints one
 * throwaway Key-Admin API key to learn the private bucket group ids. Delete that
 * key afterwards.
 *
 * The output contains addresses, object ids, and transaction bytes — no secrets.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";

const cfg = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/walrus-console-mcp/config.json"), "utf-8"),
);
const addr = (seed: string) =>
  Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(seed).secretKey).toSuiAddress();

/**
 * The bucket id the reserve PTB carries — the single Pure input that is NOT a
 * 32-byte address. It is a length-prefixed BCS string, so drop the one-byte ULEB
 * length prefix (the UUID is 36 chars, well under 128).
 */
const extractBucketId = (bytes: string): string => {
  const data = Transaction.from(fromBase64(bytes)).getData();
  for (const input of data.inputs) {
    const pure = (input as { Pure?: { bytes?: string } }).Pure?.bytes;
    if (!pure) continue;
    const raw = fromBase64(pure);
    if (raw.length !== 32) return Buffer.from(raw.subarray(1)).toString("utf8");
  }
  throw new Error("no bucket-id input found in the reserve PTB");
};

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
  const workingAddress = addr(cfg.servicePrivateKey);
  const adminAddress = addr(cfg.adminServicePrivateKey);

  const spaces = await call("/api/v1/spaces", cfg.apiKey);
  const space = (spaces.data ?? spaces)[0];
  const reserve = await call(`/api/v1/spaces/${space.id}/buckets`, cfg.apiKey, {
    method: "POST",
    body: JSON.stringify({ name: `txshape-fixture-${Date.now()}`, scope: "private" }),
  });

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
    createBucket: {
      _comment:
        "Kept as a REJECTION input for the tests. The validator's create-bucket arm pins the " +
        "add_owner + self-demotion shape the API builds now, and must refuse an older " +
        "roster-only reserve rather than quietly accept it.",
      bytes: reserve.bytes,
      bucketId: extractBucketId(reserve.bytes),
    },
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
  fs.mkdirSync("tests/fixtures", { recursive: true });
  fs.writeFileSync(
    "tests/fixtures/sponsoredTransactions.json",
    `${JSON.stringify(out, null, 2)}\n`,
  );
  console.log("workingAddress:", workingAddress);
  console.log("adminAddress  :", adminAddress);
  console.log("groups        :", groupIds.length);
  console.log("written tests/fixtures/sponsoredTransactions.json");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
