/**
 * Mint a second Console API key against the staging deployment so the space has
 * more than one active service signer.
 *
 * Why: with a single key, the roster path always short-circuits at
 * "no other signers" and the chain ∩ candidates intersection is never
 * exercised. Mint-time back-fill also grants the new key access to existing
 * private buckets, which puts its address into the anchor group's membership —
 * the state a later create needs in order to author a verified roster.
 *
 * Usage: pnpm tsx scripts/e2e-mint-second-key.mts
 * Prints the new signer address and key id. Never prints the key or its seed.
 */
import * as fs from "node:fs";
import { Effect } from "effect";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient.js";
import { KeyAdminService } from "../src/console/KeyAdminService.js";
import { SpaceId } from "../src/console/types.js";
import { AppRuntime, unwrapFiberFailure } from "../src/runtime.js";

const program = Effect.gen(function* () {
  const api = yield* ConsoleApiClient;
  const keyAdmin = yield* KeyAdminService;

  const spaces = yield* api.listSpaces();
  const space = spaces[0];
  if (space === undefined) return yield* Effect.fail(new Error("this key has no spaces"));

  const outcome = yield* keyAdmin.generateApiKey({
    spaceId: SpaceId.make(space.id),
    permission: "read_only",
    label: `e2e-roster-peer-${Date.now()}`,
  });

  // Two failure branches carry no `credential` field at all, so both must be
  // handled before touching `outcome.credential` below.
  if (!outcome.ok && outcome.stage === "persist") {
    // The mint succeeded server-side but its secrets never made it to disk, so
    // there is no credential (and no credentialFile) to read a private key from.
    return yield* Effect.fail(
      new Error(
        `key ${outcome.keyId} was minted but its secrets could not be persisted ` +
          `(attempted ${outcome.attemptedPath}): ${outcome.reason}`,
      ),
    );
  }
  if (!outcome.ok && outcome.stage === "mint") {
    // The 201 itself failed validation — there is no keyId, spaceId, or
    // credential at all here, only the pre-mint marker.
    return yield* Effect.fail(
      new Error(`mint response failed validation (marker ${outcome.marker}): ${outcome.reason}`),
    );
  }

  // Secrets no longer ride on the outcome — generateApiKey persists them to a
  // private file immediately after mint and hands back only a pointer. Read
  // the file to get the private key needed to derive the new signer's address.
  const persisted = JSON.parse(fs.readFileSync(outcome.credential.credentialFile, "utf-8")) as {
    privateKey: string;
  };

  const signers = yield* api.listSpaceSigners();

  return {
    ok: outcome.ok,
    ...(outcome.ok ? {} : { stage: outcome.stage, reason: outcome.reason }),
    keyId: outcome.credential.keyId,
    permission: outcome.credential.permission,
    // Derived from the minted seed, which the result carries but never prints:
    // the mint response has no address field, and this is what identifies the new
    // key inside `spaceSignersNow` below.
    newSignerAddress: normalizeSuiAddress(
      Ed25519Keypair.fromSecretKey(
        decodeSuiPrivateKey(persisted.privateKey).secretKey,
      ).toSuiAddress(),
    ),
    privateBucketsGranted: outcome.credential.privateBuckets.map((b) => ({
      bucketId: b.bucketId,
      groupId: b.groupId,
    })),
    spaceSignersNow: signers.signers.map((s) => ({
      address: normalizeSuiAddress(s.service_signer_address),
      scope: s.scope,
    })),
  };
});

try {
  console.log(JSON.stringify(await AppRuntime.runPromise(program), null, 2));
} catch (err) {
  const unwrapped = unwrapFiberFailure(err);
  console.error(unwrapped instanceof Error ? unwrapped.message : String(unwrapped));
  process.exit(1);
}
