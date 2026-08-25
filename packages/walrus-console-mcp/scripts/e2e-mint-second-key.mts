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
        decodeSuiPrivateKey(outcome.credential.privateKey).secretKey,
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
