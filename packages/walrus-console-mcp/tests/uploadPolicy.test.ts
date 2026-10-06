import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bcs } from "@mysten/sui/bcs";
import { Effect, Either, Fiber, Layer, Redacted, TestClock, TestContext } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ConsoleConfig, ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import {
  ConsoleStorageService,
  deriveBucketGroupId,
  resolveUploadPolicy,
  RosterChainDepsTag,
} from "../src/console/ConsoleStorageService";
import { ConsoleApiError, SealCryptoError } from "../src/console/errors";
import { resolvePackageConfigForBaseUrl } from "../src/console/packageConfig";
import { WEB_ACCOUNT_PIN_REMEDY } from "../src/console/pinRemedy";
import type { RosterChainDeps } from "../src/console/rosterVerification";
import { SealCryptoService } from "../src/console/SealCryptoService";
import { type Bucket, BucketId, FileId } from "../src/console/types";
import { derivedPolicy, FIXTURE_OWNER, verifiedBucket } from "./verifiedBucket";

/**
 * COMG-1007 — `upload_file` used to encrypt under whatever `sealPolicyId` the
 * caller passed, so a file could land in bucket A bound to bucket B's group.
 * The policy is now derived from the bucket and verified locally; these pin that
 * it cannot come from the caller OR be chosen freely by the endpoint.
 */

const BASE_URL = "https://api.testnet.console.walrus.xyz";
const PACKAGE_CONFIG = resolvePackageConfigForBaseUrl(BASE_URL);
const BUCKET = "bucket-under-test";
const OTHER_BUCKET = "some-other-bucket";
const SIGNER = `0x${"5e".repeat(32)}`;
const EARLIER_SIGNER = `0x${"e1".repeat(32)}`;
const STRANGER = `0x${"99".repeat(32)}`;

describe("resolveUploadPolicy", () => {
  const policyBy = (creator: string, bucketId = BUCKET) =>
    derivedPolicy(BASE_URL, bucketId, creator);

  it("verifies a policy that derives from the bucket id and a trusted creator", () => {
    const result = resolveUploadPolicy(PACKAGE_CONFIG, BUCKET, policyBy(FIXTURE_OWNER), [
      FIXTURE_OWNER,
    ]);
    expect(result).toEqual({
      status: "verified",
      policyId: policyBy(FIXTURE_OWNER),
      creator: FIXTURE_OWNER,
    });
  });

  it("reports which trusted creator matched", () => {
    const result = resolveUploadPolicy(PACKAGE_CONFIG, BUCKET, policyBy(SIGNER), [
      FIXTURE_OWNER,
      SIGNER,
    ]);
    expect(result).toMatchObject({ status: "verified", creator: SIGNER });
  });

  it("refuses a policy created by anyone outside the trusted set", () => {
    const result = resolveUploadPolicy(PACKAGE_CONFIG, BUCKET, policyBy(STRANGER), [
      FIXTURE_OWNER,
      SIGNER,
    ]);
    expect(result).toEqual({ status: "unverifiable", reported: policyBy(STRANGER) });
  });

  // The endpoint only selects: it cannot hand back a trusted creator's group for a
  // DIFFERENT bucket, because the bucket id in the derivation is the caller's.
  it("refuses a trusted creator's policy for a different bucket", () => {
    const result = resolveUploadPolicy(
      PACKAGE_CONFIG,
      BUCKET,
      policyBy(FIXTURE_OWNER, OTHER_BUCKET),
      [FIXTURE_OWNER],
    );
    expect(result.status).toBe("unverifiable");
  });

  it("reports no policy when the bucket has none", () => {
    for (const reported of [null, undefined, ""]) {
      expect(resolveUploadPolicy(PACKAGE_CONFIG, BUCKET, reported, [FIXTURE_OWNER])).toEqual({
        status: "no_policy",
      });
    }
  });

  it("skips a candidate that is not an address instead of giving up", () => {
    const result = resolveUploadPolicy(PACKAGE_CONFIG, BUCKET, policyBy(FIXTURE_OWNER), [
      "not-an-address",
      "",
      FIXTURE_OWNER,
    ]);
    expect(result.status).toBe("verified");
  });

  // Console's `uuidSchema` trims and lowercases, so it resolves an uppercase id to
  // the stored lowercase bucket; the derivation has to use that same form.
  it("canonicalizes the bucket id the way Console does before deriving", () => {
    const id = "3f2c0b8e-9a41-4d7b-8c25-6e1f0a9d2b7c";
    const result = resolveUploadPolicy(
      PACKAGE_CONFIG,
      `  ${id.toUpperCase()} `,
      policyBy(FIXTURE_OWNER, id),
      [FIXTURE_OWNER],
    );
    expect(result.status).toBe("verified");
  });

  // `normalizeSuiAddress` pads anything, so without validation a non-id would be
  // reported back as a 0x000…-padded value the endpoint never sent.
  it("treats a reported policy that is not an object id as unverifiable, verbatim", () => {
    expect(resolveUploadPolicy(PACKAGE_CONFIG, BUCKET, "abc", [FIXTURE_OWNER])).toEqual({
      status: "unverifiable",
      reported: "abc",
    });
  });

  it("verifies nothing with no candidates", () => {
    expect(resolveUploadPolicy(PACKAGE_CONFIG, BUCKET, policyBy(FIXTURE_OWNER), []).status).toBe(
      "unverifiable",
    );
  });
});

// ---------------------------------------------------------------------------
// The upload flow
// ---------------------------------------------------------------------------

const NO_CHAIN_READS = Layer.succeed(RosterChainDepsTag, {} as RosterChainDeps);

let tmpDir: string;
let tmpFile: string;
const savedEnv = {
  APPDATA: process.env["APPDATA"],
  XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"],
};

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-upload-policy-"));
  tmpFile = path.join(tmpDir, "payload.txt");
  fs.writeFileSync(tmpFile, "hello");
  // `getConfigDir` reads APPDATA on Windows and XDG_CONFIG_HOME elsewhere; point
  // both at the temp dir so the anchors tier never sees a real anchors.json.
  process.env["APPDATA"] = tmpDir;
  process.env["XDG_CONFIG_HOME"] = tmpDir;
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const anchorsFile = () => path.join(tmpDir, "walrus-console-mcp", "anchors.json");

beforeEach(() => {
  fs.rmSync(anchorsFile(), { force: true });
});

function writeAnchor(
  spaceId: string,
  bucketId: string,
  creator: string,
  groupId = derivedPolicy(BASE_URL, bucketId, creator),
  /** The package ids the entry records; `null` writes an entry that records none. */
  ids: { bucketRegistryId: string; originalPackageId: string } | null = {
    bucketRegistryId: PACKAGE_CONFIG.bucketRegistryId,
    originalPackageId: PACKAGE_CONFIG.originalPackageId,
  },
) {
  fs.mkdirSync(path.dirname(anchorsFile()), { recursive: true });
  fs.writeFileSync(
    anchorsFile(),
    JSON.stringify({
      [spaceId]: [
        {
          groupId,
          bucketId,
          creator,
          ...ids,
          recordedAt: "2026-09-11T00:00:00.000Z",
        },
      ],
    }),
  );
}

interface HarnessOptions {
  bucket: Bucket;
  owner?: string;
  /** This host's signer address; omit to model a host whose key fails to load. */
  signer?: string;
  /** How many bucket lookups answer 403 `mirror_missing_grant` before succeeding. */
  lookupFailures?: number;
  /** When set, every lookup fails with this instead (a non-retryable error). */
  lookupError?: ConsoleApiError;
}

function makeHarness(opts: HarnessOptions) {
  const calls = { encryptedUnder: [] as string[], uploads: 0, keypairLoads: 0, lookups: 0 };

  const api = {
    getBucketById: () =>
      Effect.suspend(() => {
        calls.lookups++;
        if (opts.lookupError) return Effect.fail(opts.lookupError);
        return calls.lookups <= (opts.lookupFailures ?? 0)
          ? Effect.fail(
              new ConsoleApiError({
                message: "Service signer missing on-chain grant for this bucket.",
                code: "mirror_missing_grant",
                status: 403,
              }),
            )
          : Effect.succeed(opts.bucket);
      }),
    uploadBucketFile: (
      _bucketId: string,
      _bytes: Uint8Array,
      fileName: string,
      _metadata?: unknown,
      contentSize?: number,
      declaredType?: string,
    ) =>
      Effect.sync(() => {
        calls.uploads++;
        return {
          data: {
            id: FileId.make("file-1"),
            original_name: fileName.trim().normalize("NFC"),
            declared_mime_type: declaredType ?? null,
            content_size: contentSize ?? null,
          },
        };
      }),
    getFileUploadStatus: () => Effect.succeed({ data: { state: "completed" as const } }),
  };

  const seal = {
    encrypt: (plaintext: Uint8Array, policyId: string) =>
      Effect.sync(() => {
        calls.encryptedUnder.push(policyId);
        return plaintext;
      }),
    getKeypair: () => {
      calls.keypairLoads++;
      return opts.signer
        ? Effect.succeed({ toSuiAddress: () => opts.signer })
        : Effect.fail(new SealCryptoError({ message: "no service key", step: "load_keypair" }));
    },
  };

  const config: ConsoleConfig = {
    apiKey: Redacted.make("hbr_working_key_value"),
    servicePrivateKey: Redacted.make(""),
    adminKey: Redacted.make(""),
    adminServicePrivateKey: Redacted.make(""),
    baseUrl: BASE_URL,
    webAccountAddress: opts.owner ?? "",
    keyAdminAddress: "",
  };

  const layer = ConsoleStorageService.DefaultWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ConsoleApiClient, api as unknown as typeof ConsoleApiClient.Service),
        Layer.succeed(SealCryptoService, seal as unknown as typeof SealCryptoService.Service),
        Layer.succeed(ConsoleConfigTag, config),
        NO_CHAIN_READS,
      ),
    ),
  );
  return { calls, layer };
}

/** Runs one upload and returns its Either, so refusals can be inspected. */
function upload(
  layer: Layer.Layer<ConsoleStorageService>,
  requested?: string,
  localPath = tmpFile,
) {
  return Effect.runPromise(
    ConsoleStorageService.pipe(
      Effect.flatMap((storage) =>
        storage.uploadFileToBucket(BucketId.make(BUCKET), requested, localPath),
      ),
      Effect.either,
      Effect.provide(layer),
    ),
  );
}

/** A path that does not exist: a refusal that fires before the read proves the file was never opened. */
const MISSING_FILE = () => path.join(tmpDir, "never-read.bin");

describe("uploadFileToBucket — policy derivation (COMG-1007)", () => {
  it("encrypts under the derived policy when sealPolicyId is omitted", async () => {
    const { calls, layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET),
      owner: FIXTURE_OWNER,
    });
    const result = await upload(layer);
    expect(Either.isRight(result)).toBe(true);
    expect(calls.encryptedUnder).toEqual([derivedPolicy(BASE_URL, BUCKET, FIXTURE_OWNER)]);
    expect(calls.uploads).toBe(1);
  });

  it("accepts a sealPolicyId that matches the bucket's policy", async () => {
    const { calls, layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET),
      owner: FIXTURE_OWNER,
    });
    const result = await upload(layer, derivedPolicy(BASE_URL, BUCKET, FIXTURE_OWNER));
    expect(Either.isRight(result)).toBe(true);
    expect(calls.encryptedUnder).toHaveLength(1);
  });

  // The reported bug: an agent passes another bucket's (perfectly real) policy id.
  it("refuses another bucket's policy before reading the file, naming both", async () => {
    const { calls, layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET),
      owner: FIXTURE_OWNER,
    });
    const wrong = derivedPolicy(BASE_URL, OTHER_BUCKET, FIXTURE_OWNER);
    const result = await upload(layer, wrong, MISSING_FILE());

    expect(Either.isLeft(result) && result.left._tag).toBe("UploadPolicyError");
    if (Either.isLeft(result) && result.left._tag === "UploadPolicyError") {
      expect(result.left.reason).toBe("caller_mismatch");
      expect(result.left.message).toContain(wrong);
      expect(result.left.message).toContain(derivedPolicy(BASE_URL, BUCKET, FIXTURE_OWNER));
    }
    expect(calls.encryptedUnder).toEqual([]);
    expect(calls.uploads).toBe(0);
  });

  it("refuses a policy the endpoint reports but no trusted creator derives", async () => {
    const hostile = derivedPolicy(BASE_URL, BUCKET, STRANGER);
    const { calls, layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET, { sealPolicyId: hostile }),
      owner: FIXTURE_OWNER,
      signer: SIGNER,
    });
    const result = await upload(layer, undefined, MISSING_FILE());
    expect(
      Either.isLeft(result) && result.left._tag === "UploadPolicyError" && result.left.reason,
    ).toBe("unverifiable");
    if (Either.isLeft(result) && result.left._tag === "UploadPolicyError") {
      expect(result.left.message).toContain(
        "the id create_bucket returned to the key that created the bucket",
      );
      // Printing Console's value would invite the agent to confirm it with that value.
      expect(result.left.message).not.toContain(hostile);
    }
    expect(calls.encryptedUnder).toEqual([]);
  });

  // Option B: a bucket another key created (e.g. an orchestrator's, uploaded into by
  // a worker) cannot be verified locally, but the caller can confirm its policy.
  it("uploads into an unverifiable bucket when the caller confirms Console's policy", async () => {
    const othersPolicy = derivedPolicy(BASE_URL, BUCKET, STRANGER);
    const { calls, layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET, { sealPolicyId: othersPolicy }),
      owner: FIXTURE_OWNER,
      signer: SIGNER,
    });
    const result = await upload(layer, othersPolicy);
    expect(Either.isRight(result)).toBe(true);
    expect(calls.encryptedUnder).toEqual([othersPolicy]);
    expect(calls.uploads).toBe(1);
  });

  // The original mix-up must still be caught on a bucket that cannot be verified.
  it("refuses an unverifiable bucket when the caller's policy differs from Console's, naming both", async () => {
    const othersPolicy = derivedPolicy(BASE_URL, BUCKET, STRANGER);
    const wrong = derivedPolicy(BASE_URL, OTHER_BUCKET, FIXTURE_OWNER);
    const { calls, layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET, { sealPolicyId: othersPolicy }),
      owner: FIXTURE_OWNER,
      signer: SIGNER,
    });
    const result = await upload(layer, wrong, MISSING_FILE());
    expect(Either.isLeft(result) && result.left._tag === "UploadPolicyError").toBe(true);
    if (Either.isLeft(result) && result.left._tag === "UploadPolicyError") {
      expect(result.left.reason).toBe("caller_mismatch");
      expect(result.left.message).toContain(wrong);
      expect(result.left.message).toContain(othersPolicy);
    }
    expect(calls.encryptedUnder).toEqual([]);
    expect(calls.uploads).toBe(0);
  });

  it("refuses a bucket that reports no Seal policy", async () => {
    const { calls, layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET, { sealPolicyId: null }),
      owner: FIXTURE_OWNER,
    });
    const result = await upload(layer, undefined, MISSING_FILE());
    expect(
      Either.isLeft(result) && result.left._tag === "UploadPolicyError" && result.left.reason,
    ).toBe("no_policy");
    expect(calls.encryptedUnder).toEqual([]);
  });

  it("verifies a bucket this host created through its signing key", async () => {
    const { calls, layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET, { creator: SIGNER }),
      signer: SIGNER,
    });
    const result = await upload(layer);
    expect(Either.isRight(result)).toBe(true);
    expect(calls.encryptedUnder).toEqual([derivedPolicy(BASE_URL, BUCKET, SIGNER)]);
  });

  it("verifies a bucket an earlier signer created through the space's anchors, without loading a key", async () => {
    writeAnchor("space-1", "an-older-bucket", EARLIER_SIGNER);
    const { calls, layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET, { creator: EARLIER_SIGNER }),
    });
    const result = await upload(layer);
    expect(Either.isRight(result)).toBe(true);
    expect(calls.encryptedUnder).toEqual([derivedPolicy(BASE_URL, BUCKET, EARLIER_SIGNER)]);
    expect(calls.keypairLoads).toBe(0);
  });

  // Seal encryption needs no key, so an upload into a web-UI bucket must not
  // start requiring one.
  it("never loads the signing key when the pinned owner already verifies the bucket", async () => {
    const { calls, layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET),
      owner: FIXTURE_OWNER,
    });
    await upload(layer);
    expect(calls.keypairLoads).toBe(0);
  });

  it("treats an unloadable key as no candidate, and says how to pin the owner", async () => {
    const { calls, layer } = makeHarness({ bucket: verifiedBucket(BASE_URL, BUCKET) });
    const result = await upload(layer, undefined, MISSING_FILE());
    expect(calls.keypairLoads).toBe(1);
    expect(
      Either.isLeft(result) && result.left._tag === "UploadPolicyError" && result.left.reason,
    ).toBe("unverifiable");
    if (Either.isLeft(result) && result.left._tag === "UploadPolicyError") {
      expect(result.left.message).toContain(WEB_ACCOUNT_PIN_REMEDY);
    }
  });

  // A broken service key must be named as the problem, not blamed on the bucket.
  it("names a signing key that failed to load, and lists what was tried", async () => {
    const { layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET, { creator: SIGNER }),
      owner: FIXTURE_OWNER,
    });
    const result = await upload(layer, undefined, MISSING_FILE());
    expect(Either.isLeft(result) && result.left._tag).toBe("UploadPolicyError");
    if (Either.isLeft(result) && result.left._tag === "UploadPolicyError") {
      expect(result.left.message).toContain("no service key");
      expect(result.left.message).toContain(`the pinned web account ${FIXTURE_OWNER}`);
      expect(result.left.message).toContain("can still be written to from the key that created it");
    }
  });

  // Agents send "" for an optional argument they were told to omit.
  it("treats an empty sealPolicyId as omitted", async () => {
    const { calls, layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET),
      owner: FIXTURE_OWNER,
    });
    const result = await upload(layer, "");
    expect(Either.isRight(result)).toBe(true);
    expect(calls.encryptedUnder).toEqual([derivedPolicy(BASE_URL, BUCKET, FIXTURE_OWNER)]);
  });

  it("refuses a sealPolicyId that is not an object id, echoing what was sent", async () => {
    const { calls, layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET),
      owner: FIXTURE_OWNER,
    });
    const result = await upload(layer, "abc", MISSING_FILE());
    expect(Either.isLeft(result) && result.left._tag === "UploadPolicyError").toBe(true);
    if (Either.isLeft(result) && result.left._tag === "UploadPolicyError") {
      expect(result.left.reason).toBe("caller_mismatch");
      expect(result.left.message).toContain('"abc"');
      expect(result.left.message).not.toContain("0x000");
    }
    expect(calls.encryptedUnder).toEqual([]);
  });

  // A stale anchor (recorded under other package ids, e.g. before a republish) still
  // names a genuine earlier signer — but only if it reproduces under the ids it recorded.
  it("trusts a stale anchor's creator only when it reproduces under the ids it recorded", async () => {
    const older = {
      bucketRegistryId: `0x${"a1".repeat(32)}`,
      originalPackageId: `0x${"b2".repeat(32)}`,
    };
    const olderGroup = deriveBucketGroupId(
      { ...PACKAGE_CONFIG, ...older },
      bcs.string().serialize("an-older-bucket").toBytes(),
      EARLIER_SIGNER,
    );

    writeAnchor("space-1", "an-older-bucket", EARLIER_SIGNER, olderGroup, older);
    const genuine = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET, { creator: EARLIER_SIGNER }),
    });
    expect(Either.isRight(await upload(genuine.layer))).toBe(true);
    expect(genuine.calls.keypairLoads).toBe(0);

    writeAnchor("space-1", "an-older-bucket", EARLIER_SIGNER, `0x${"77".repeat(32)}`, older);
    const forged = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET, { creator: EARLIER_SIGNER }),
    });
    const refused = await upload(forged.layer, undefined, MISSING_FILE());
    expect(
      Either.isLeft(refused) && refused.left._tag === "UploadPolicyError" && refused.left.reason,
    ).toBe("unverifiable");
  });

  // An entry that records no package ids used to be trusted without any derivation.
  it("requires an anchor that records no package ids to reproduce under the current ids", async () => {
    writeAnchor("space-1", "an-older-bucket", EARLIER_SIGNER, `0x${"77".repeat(32)}`, null);
    const forged = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET, { creator: EARLIER_SIGNER }),
    });
    const refused = await upload(forged.layer, undefined, MISSING_FILE());
    expect(
      Either.isLeft(refused) && refused.left._tag === "UploadPolicyError" && refused.left.reason,
    ).toBe("unverifiable");
    expect(forged.calls.encryptedUnder).toEqual([]);

    writeAnchor("space-1", "an-older-bucket", EARLIER_SIGNER, undefined, null);
    const genuine = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET, { creator: EARLIER_SIGNER }),
    });
    expect(Either.isRight(await upload(genuine.layer))).toBe(true);
  });

  // `createBucket` treats an unreproducible anchor as tampering; this tier must not
  // trust its `creator` either.
  it("ignores an anchor whose group id does not reproduce", async () => {
    writeAnchor("space-1", "an-older-bucket", EARLIER_SIGNER, `0x${"77".repeat(32)}`);
    const { calls, layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET, { creator: EARLIER_SIGNER }),
    });
    const result = await upload(layer, undefined, MISSING_FILE());
    expect(
      Either.isLeft(result) && result.left._tag === "UploadPolicyError" && result.left.reason,
    ).toBe("unverifiable");
    expect(calls.encryptedUnder).toEqual([]);
  });
});

describe("uploadFileToBucket — bucket lookup behind the ACL mirror (COMG-1007 review)", () => {
  // A bucket created seconds ago 403s `mirror_missing_grant` on GET until the grant
  // propagates; the normal create_bucket → upload_file flow must wait it out.
  it("retries the lookup through mirror_missing_grant, then uploads", async () => {
    const { calls, layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET),
      owner: FIXTURE_OWNER,
      lookupFailures: 1,
    });
    const result = await upload(layer);
    expect(Either.isRight(result)).toBe(true);
    expect(calls.lookups).toBe(2);
    expect(calls.uploads).toBe(1);
  }, 15000);

  it("gives up after 12 lookups with MirrorGrantMissingError, before reading the file", async () => {
    const { calls, layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET),
      owner: FIXTURE_OWNER,
      lookupFailures: 99,
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          ConsoleStorageService.pipe(
            Effect.flatMap((storage) =>
              storage.uploadFileToBucket(BucketId.make(BUCKET), undefined, MISSING_FILE()),
            ),
            Effect.either,
          ),
        );
        for (let i = 0; i < 12; i++) yield* TestClock.adjust("3 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(layer), Effect.provide(TestContext.TestContext)),
    );
    expect(Either.isLeft(result) && result.left._tag).toBe("MirrorGrantMissingError");
    expect(calls.lookups).toBe(12);
    expect(calls.encryptedUnder).toEqual([]);
  });

  it("does not retry a lookup that fails for any other reason", async () => {
    const { calls, layer } = makeHarness({
      bucket: verifiedBucket(BASE_URL, BUCKET),
      owner: FIXTURE_OWNER,
      lookupError: new ConsoleApiError({ message: "Bucket not found.", status: 404 }),
    });
    const result = await upload(layer, undefined, MISSING_FILE());
    expect(Either.isLeft(result) && result.left._tag).toBe("ConsoleApiError");
    expect(calls.lookups).toBe(1);
  });
});
