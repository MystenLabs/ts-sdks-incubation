import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bcs } from "@mysten/sui/bcs";
import { Effect, Layer, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConsoleConfig, ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleStorageService, RosterChainDepsTag } from "../src/console/ConsoleStorageService";
import type { RosterChainDeps } from "../src/console/rosterVerification";
import { SealCryptoService } from "../src/console/SealCryptoService";
import { SpaceId } from "../src/console/types";
import type { SponsoredTxExpectation } from "../src/console/txValidation";

/**
 * The create-bucket identity pins have to REACH the validator to be worth
 * anything. `txValidation.test.ts` proves the checks are right; this proves the
 * addresses local configuration holds are the ones they are handed.
 *
 * The manager pin matters most for the population it was written for: a worker
 * host holding no admin credential, on a space that DOES have a key_admin key.
 * The reserve there contains a `grant_permission` the host can check against
 * nothing it can derive, so without the pin arriving the validator fails closed
 * and tells the operator to set a value that never gets read.
 */

const WEB_ACCOUNT = `0x${"a".repeat(64)}`;
const KEY_ADMIN = `0x${"b".repeat(64)}`;

const BASE_CONFIG: ConsoleConfig = {
  apiKey: Redacted.make("hbr_working_key_value"),
  servicePrivateKey: Redacted.make("suiprivkey1working"),
  adminKey: Redacted.make(""),
  adminServicePrivateKey: Redacted.make(""),
  baseUrl: "https://api.testnet.console.walrus.xyz",
  webAccountAddress: WEB_ACCOUNT,
  keyAdminAddress: "",
};

const SIGNER = `0x${"c".repeat(64)}`;

/**
 * No anchor is ever recorded for the space these tests use, so `createBucket`
 * takes the bootstrap path and reads no chain at all — this stub exists to
 * satisfy the dependency, not to answer anything.
 */
const NO_CHAIN_READS = Layer.succeed(RosterChainDepsTag, {} as RosterChainDeps);

/** Captures the expectation the storage flow hands the signer. */
function makeHarness(over: Partial<ConsoleConfig> = {}) {
  const seen: SponsoredTxExpectation[] = [];
  const reserved: string[] = [];

  const api = {
    createBucket: (spaceId: string) => {
      reserved.push(spaceId);
      return Effect.succeed({ bytes: "AAAA", bucket_id: "bucket-1" });
    },
    // `seal_policy_id: null` — the "server reported no group id" case, which is
    // legitimate and keeps these tests on the pins. The flow derives the anchor
    // itself; `storageCreateBucket.test.ts` is what exercises that derivation and
    // the refusal when a reported id contradicts it.
    finalizeBucket: () =>
      Effect.succeed({ bucket_id: "bucket-1", seal_policy_id: null, provisioning_state: "active" }),
    listSpaceSigners: () => Effect.succeed({ signers: [] }),
  };

  const seal = {
    getKeypair: () => Effect.succeed({ toSuiAddress: () => SIGNER }),
    signTransactionBytes: (_bytes: string, expectation: SponsoredTxExpectation) => {
      seen.push(expectation);
      return Effect.succeed({
        signature: "c2lnbmF0dXJl",
        create: {
          owner: WEB_ACCOUNT,
          members: [],
          signerRole: "viewer" as const,
          // The bucket-id argument the validator lifts out of the PTB; the flow
          // derives the new group's object id from it, so a summary without one
          // refuses rather than falling back to the id the server reports.
          bucketIdArg: bcs.string().serialize("bucket-1").toBytes(),
        },
      });
    },
  };

  const layer = ConsoleStorageService.DefaultWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ConsoleApiClient, api as unknown as typeof ConsoleApiClient.Service),
        Layer.succeed(SealCryptoService, seal as unknown as typeof SealCryptoService.Service),
        Layer.succeed(ConsoleConfigTag, { ...BASE_CONFIG, ...over }),
        NO_CHAIN_READS,
      ),
    ),
  );

  return { seen, reserved, layer };
}

// `createBucket` records the anchor of the bucket it creates, so keep that write
// inside a temp config dir instead of the developer's own.
let tmpDir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-pins-test-"));
  originalEnv = { ...process.env };
  process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
});

afterEach(() => {
  process.env = originalEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const create = (layer: Layer.Layer<ConsoleStorageService>) =>
  ConsoleStorageService.pipe(
    Effect.flatMap((storage) => storage.createBucket(SpaceId.make("space-1"), "notes")),
    Effect.provide(layer),
  );

describe("createBucket — the identity pins reach the validator", () => {
  it("pins the owner to the configured web account", async () => {
    const { seen, layer } = makeHarness();

    await Effect.runPromise(create(layer));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "createBucketIdentity", ownerAddress: WEB_ACCOUNT });
  });

  it("pins the manager to the configured Key-Admin address", async () => {
    const { seen, layer } = makeHarness({ keyAdminAddress: KEY_ADMIN });

    await Effect.runPromise(create(layer));

    expect(seen[0]).toMatchObject({ managerAddress: KEY_ADMIN });
  });

  it("omits managerAddress entirely when no Key-Admin is pinned", async () => {
    // Absent, not `undefined`: the field is optional under
    // exactOptionalPropertyTypes, and the validator falls back to the address this
    // host's admin keypair derives when the key is not present at all.
    const { seen, layer } = makeHarness();

    await Effect.runPromise(create(layer));

    expect(seen[0]).not.toHaveProperty("managerAddress");
  });

  it("refuses to create a bucket before reserving one when no owner is pinned", async () => {
    // Fail-closed, and fail EARLY: reserving a bucket this host cannot sign for
    // would leave a half-created bucket behind on every attempt.
    const { reserved, layer } = makeHarness({ webAccountAddress: "" });

    const error = await Effect.runPromise(create(layer).pipe(Effect.flip));

    expect(error._tag).toBe("BucketCreatePinError");
    if (error._tag !== "BucketCreatePinError") throw new Error("expected a BucketCreatePinError");
    expect(error.reason).toBe("missing_owner_pin");
    expect(error.message).toMatch(/CONSOLE_WEB_ACCOUNT_ADDRESS/);
    expect(reserved).toEqual([]);
  });
});
