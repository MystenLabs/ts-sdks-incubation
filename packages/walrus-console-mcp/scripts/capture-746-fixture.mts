/**
 * Capture a REAL 746-shape create-bucket reserve as a test fixture.
 *
 * Why this exists: every acceptance test for the `createBucketIdentity` arm
 * builds its own PTB with `build746Reserve`. That is our construction of what we
 * BELIEVE the server sends, so those tests are a closed loop — if the builder
 * drifts from the real shape, the suite validates a fiction and stays green.
 * This branch already shipped one bug of exactly that kind (a response field
 * read under a name the wire never used, where the stubs asserted the same wrong
 * shape the client believed in).
 *
 * The captured bytes are the only thing in the suite whose shape we did not
 * author. A test that validates them proves the pins match a real Console rather
 * than matching our idea of one.
 *
 * The reserve is left UN-FINALIZED: no bucket is created and no gas is spent.
 * It does leave a `pending_policy` row on the deployment, which is cheap and
 * visible in the UI.
 *
 * Usage: pnpm tsx scripts/capture-746-fixture.mts
 * Writes tests/fixtures/createBucket746.json. Prints no secrets; the file holds
 * only addresses, object ids and transaction bytes, all of which are public.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { ConsoleConfigTag, getKeyAdminAddress, getWebAccountAddress } from "../src/config.js";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient.js";
import { resolvePackageConfigForBaseUrl } from "../src/console/packageConfig.js";
import { SealCryptoService } from "../src/console/SealCryptoService.js";
import { SpaceId } from "../src/console/types.js";
import { AppRuntime, unwrapFiberFailure } from "../src/runtime.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "tests", "fixtures", "createBucket746.json");

const program = Effect.gen(function* () {
  const cfg = yield* ConsoleConfigTag;
  const api = yield* ConsoleApiClient;
  const seal = yield* SealCryptoService;

  const owner = getWebAccountAddress(cfg);
  if (owner === undefined) {
    return yield* Effect.fail(new Error("no owner pin configured — run `config` first"));
  }
  const manager = getKeyAdminAddress(cfg);
  const signer = (yield* seal.getKeypair("working")).toSuiAddress();
  const pkg = resolvePackageConfigForBaseUrl(cfg.baseUrl);

  const spaces = yield* api.listSpaces();
  const space = spaces[0];
  if (space === undefined) return yield* Effect.fail(new Error("this key has no spaces"));

  // An EMPTY authored roster: the fixture must pin the identity commands, and a
  // roster would bake this space's current signer set into a file that outlives
  // it. `rosterVerification.test.ts` covers roster membership separately, with
  // stubs it can vary.
  const reserve = yield* api.createBucket(
    SpaceId.make(space.id),
    `fixture-746-${Date.now()}`,
    owner,
    [],
  );

  return {
    _comment:
      "A REAL create-bucket reserve from the COMG-746/761 deployment, captured by " +
      "scripts/capture-746-fixture.mts. Un-finalized: no bucket was created. This is the only " +
      "create-bucket PTB in the suite whose shape this repository did not author — tests that " +
      "build their own reserve prove the validator is self-consistent, and this proves it agrees " +
      "with a real Console. Recapture whenever the API's PTB shape changes; a drift here is the " +
      "signal that the hand-built fixtures have become fiction.",
    capturedAt: new Date().toISOString(),
    baseUrl: cfg.baseUrl,
    packageConfig: pkg,
    signerAddress: normalizeSuiAddress(signer),
    ownerAddress: normalizeSuiAddress(owner),
    managerAddress: manager === undefined ? null : normalizeSuiAddress(manager),
    expectedMembers: [] as const,
    bucketId: reserve.bucket_id,
    bytes: reserve.bytes,
    ownerEcho: reserve.owner_address ?? null,
    adminEcho: reserve.admin_signer_address ?? null,
  };
});

try {
  const fixture = await AppRuntime.runPromise(program);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${path.relative(REPO, OUT)}`);
  console.log(`  bucketId  ${fixture.bucketId}`);
  console.log(`  signer    ${fixture.signerAddress}`);
  console.log(`  owner     ${fixture.ownerAddress}`);
  console.log(`  manager   ${fixture.managerAddress ?? "(none)"}`);
  console.log(`  bytes     ${fixture.bytes.length} base64 chars`);
} catch (err) {
  const unwrapped = unwrapFiberFailure(err);
  console.error(unwrapped instanceof Error ? unwrapped.message : String(unwrapped));
  process.exit(1);
}
