import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Either, Layer, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ConsoleConfig, ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleStorageService, RosterChainDepsTag } from "../src/console/ConsoleStorageService";
import { ConsoleApiError, SealCryptoError } from "../src/console/errors";
import type { RosterChainDeps } from "../src/console/rosterVerification";
import { SealCryptoService } from "../src/console/SealCryptoService";
import { BucketId, FileId } from "../src/console/types";
import { boundFile, verifiedBucket } from "./verifiedBucket";

/**
 * After the wrong_group gate in decrypt, a mismatched seal_policy_id column
 * cannot cause decrypt/approve to fail (those use the embedded/derived group).
 * download_file therefore keeps the original SealCryptoError rather than
 * rewriting it into a column-disagreement story.
 */

const BASE_URL = "https://api.testnet.console.walrus.xyz";
const BUCKET = "bucket-1";
const FILE_POLICY = `0x${"1".repeat(64)}`;
const BUCKET_POLICY = `0x${"2".repeat(64)}`;

const NO_CHAIN_READS = Layer.succeed(RosterChainDepsTag, {} as RosterChainDeps);

let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-download-mismatch-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface HarnessOptions {
  /** What `seal.decrypt` does; a SealCryptoError models a failed decryption. */
  decrypt: Effect.Effect<Uint8Array, SealCryptoError>;
  bucketPolicy?: string | null;
  lookupFails?: boolean;
}

function makeHarness(opts: HarnessOptions) {
  const calls = { lookups: 0 };
  const api = {
    downloadBucketFile: () => Effect.succeed(new Uint8Array([9, 9, 9])),
    getBucketFile: (_b: string, f: string) => Effect.succeed(boundFile(f)),
    getBucketById: (id: string) =>
      Effect.suspend(() => {
        calls.lookups++;
        return opts.lookupFails
          ? Effect.fail(new ConsoleApiError({ message: "Bucket not found.", status: 404 }))
          : Effect.succeed(
              verifiedBucket(BASE_URL, id, {
                sealPolicyId: opts.bucketPolicy === undefined ? BUCKET_POLICY : opts.bucketPolicy,
              }),
            );
      }),
  };
  const seal = {
    decrypt: () =>
      opts.decrypt.pipe(
        Effect.map((plaintext) => ({ plaintext, authenticatedName: null, bound: false })),
      ),
  };
  const config: ConsoleConfig = {
    apiKey: Redacted.make("hbr_working_key_value"),
    servicePrivateKey: Redacted.make(""),
    adminKey: Redacted.make(""),
    adminServicePrivateKey: Redacted.make(""),
    baseUrl: BASE_URL,
    webAccountAddress: "",
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

/** A failed decryption, carrying the file's policy unless `embeddedPolicyId` is null. */
const failing = (step: SealCryptoError["step"], embeddedPolicyId: string | null = FILE_POLICY) =>
  new SealCryptoError({
    message: "Seal decryption failed. Common causes: CONSOLE_SERVICE_PRIVATE_KEY is not…",
    step,
    ...(embeddedPolicyId === null ? {} : { embeddedPolicyId }),
  });

/**
 * Effect attaches span information to a failure through a proxy, so the error a
 * caller receives is not the same reference as the one raised (and vitest cannot
 * diff the proxy). Compare what identifies the error instead.
 */
function expectOriginal(result: Either.Either<unknown, unknown>, original: SealCryptoError) {
  expect(Either.isLeft(result)).toBe(true);
  if (!Either.isLeft(result)) return;
  const left = result.left as { _tag?: string; step?: string; message?: string };
  expect({ tag: left._tag, step: left.step, message: left.message }).toEqual({
    tag: original._tag,
    step: original.step,
    message: original.message,
  });
}

function download(layer: Layer.Layer<ConsoleStorageService>, name: string) {
  const dest = path.join(tmpDir, name);
  return Effect.runPromise(
    ConsoleStorageService.pipe(
      Effect.flatMap((storage) =>
        storage.downloadFile(BucketId.make(BUCKET), FileId.make("file-1"), dest),
      ),
      Effect.either,
      Effect.provide(layer),
    ),
  ).then((result) => ({ result, dest }));
}

describe("downloadFile — decrypt failures keep their original cause", () => {
  it("keeps the SealCryptoError when the recorded seal_policy_id disagrees with the ciphertext group", async () => {
    const original = failing("decrypt");
    const { calls, layer } = makeHarness({ decrypt: Effect.fail(original) });
    const { result, dest } = await download(layer, "mismatch.out");

    expectOriginal(result, original);
    expect(calls.lookups).toBe(1);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("keeps a build_ptb failure the same way", async () => {
    const original = failing("build_ptb");
    const { layer } = makeHarness({ decrypt: Effect.fail(original) });
    const { result } = await download(layer, "build-ptb.out");
    expectOriginal(result, original);
  });

  it("keeps the original error when the file's policy matches the bucket's", async () => {
    const original = failing("decrypt");
    const { layer } = makeHarness({ decrypt: Effect.fail(original), bucketPolicy: FILE_POLICY });
    const { result } = await download(layer, "same-policy.out");
    expectOriginal(result, original);
  });

  it("makes no extra call when decryption succeeds", async () => {
    const { calls, layer } = makeHarness({ decrypt: Effect.succeed(new Uint8Array([1, 2, 3])) });
    const { result, dest } = await download(layer, "ok.out");
    expect(Either.isRight(result)).toBe(true);
    expect(calls.lookups).toBe(1);
    expect(fs.readFileSync(dest)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("leaves failures at other steps alone, and still reads the bucket only once", async () => {
    const original = failing("load_keypair");
    const { calls, layer } = makeHarness({ decrypt: Effect.fail(original) });
    const { result } = await download(layer, "keypair.out");
    expectOriginal(result, original);
    expect(calls.lookups).toBe(1);
  });

  it("refuses before decrypting when the bucket cannot be read", async () => {
    const original = failing("decrypt");
    const { calls, layer } = makeHarness({ decrypt: Effect.fail(original), lookupFails: true });
    const { result, dest } = await download(layer, "lookup-fails.out");

    expect(Either.isLeft(result) && (result.left as { _tag?: string })._tag).toBe(
      "ConsoleApiError",
    );
    expect(calls.lookups).toBe(1);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("refuses a private bucket that reports no policy, before decrypting", async () => {
    const { layer } = makeHarness({ decrypt: Effect.fail(failing("decrypt")), bucketPolicy: null });
    const { result } = await download(layer, "no-policy.out");

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      const left = result.left as { _tag?: string; reason?: string; message?: string };
      expect(left._tag).toBe("FileBindingRefusedError");
      expect(left.reason).toBe("missing_policy");
      expect(left.message).toContain("private but reports no seal_policy_id");
    }
  });

  it("keeps the original error when the failure carries no embedded policy", async () => {
    const original = failing("decrypt", null);
    const { calls, layer } = makeHarness({ decrypt: Effect.fail(original) });
    const { result } = await download(layer, "no-embedded.out");
    expectOriginal(result, original);
    expect(calls.lookups).toBe(1);
  });
});
