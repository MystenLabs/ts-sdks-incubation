import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ConsoleConfig, ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleStorageService, RosterChainDepsTag } from "../src/console/ConsoleStorageService";
import type { RosterChainDeps } from "../src/console/rosterVerification";
import { SealCryptoService } from "../src/console/SealCryptoService";
import { BucketId, FileId } from "../src/console/types";

/**
 * COMG-662 — the regression this pins: `uploadFileToBucket` called
 * `uploadBucketFile` with three arguments, so `metadata` was always
 * `undefined` and every description/tag the caller supplied was dropped
 * silently. The upload still succeeded, which is why nothing caught it.
 *
 * Asserted at the seam where the argument is actually passed, so a future
 * refactor that stops threading it through fails here rather than in a live
 * upload.
 */

let tmpFile: string;

beforeAll(async () => {
  tmpFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "comg662-")), "note.txt");
  await fs.writeFile(tmpFile, "hello");
});

afterAll(async () => {
  await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
});

/** Enough config for the service to build; the upload path reads none of it. */
const STUB_CONFIG: ConsoleConfig = {
  apiKey: Redacted.make("hbr_working_key_value"),
  servicePrivateKey: Redacted.make("suiprivkey1working"),
  adminKey: Redacted.make(""),
  adminServicePrivateKey: Redacted.make(""),
  baseUrl: "https://api.testnet.console.walrus.xyz",
  webAccountAddress: "",
  keyAdminAddress: "",
};

/**
 * `createBucket` verifies its roster against chain state, so the service now
 * declares those reads as a dependency. Nothing in this file creates a bucket,
 * so an unreachable stub is enough — stated rather than defaulted, so a flow
 * that DOES read chain can never silently reach a real fullnode from a test.
 */
const NO_CHAIN_READS = Layer.succeed(RosterChainDepsTag, {} as RosterChainDeps);

/** Captures what the API client was handed, and short-circuits the network. */
function makeHarness() {
  const calls: Array<Record<string, unknown> | undefined> = [];

  const api = {
    uploadBucketFile: (
      _bucketId: unknown,
      _bytes: Uint8Array,
      _fileName: string,
      metadata?: Record<string, unknown>,
    ) => {
      calls.push(metadata);
      return Effect.succeed({ data: { id: FileId.make("file-1") } });
    },
    getFileUploadStatus: () => Effect.succeed({ data: { state: "completed" as const } }),
  };

  const seal = {
    encrypt: (plaintext: Uint8Array) => Effect.succeed(plaintext),
  };

  const layer = ConsoleStorageService.DefaultWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ConsoleApiClient, api as unknown as typeof ConsoleApiClient.Service),
        Layer.succeed(SealCryptoService, seal as unknown as typeof SealCryptoService.Service),
        Layer.succeed(ConsoleConfigTag, STUB_CONFIG),
        NO_CHAIN_READS,
      ),
    ),
  );

  return { calls, layer };
}

async function upload(
  layer: Layer.Layer<ConsoleStorageService>,
  metadata?: { description?: string; tags?: string[] },
) {
  return await Effect.runPromise(
    ConsoleStorageService.pipe(
      Effect.flatMap((storage) =>
        storage.uploadFileToBucket(
          BucketId.make("bucket-1"),
          "0xpolicy",
          tmpFile,
          undefined,
          metadata,
        ),
      ),
      Effect.provide(layer),
    ),
  );
}

describe("uploadFileToBucket — metadata pass-through (COMG-662)", () => {
  it("forwards description and tags to the upload call", async () => {
    const { calls, layer } = makeHarness();

    await upload(layer, { description: "quarterly report", tags: ["finance", "q3"] });

    expect(calls).toEqual([{ description: "quarterly report", tags: ["finance", "q3"] }]);
  });

  it("forwards only the field that was supplied", async () => {
    const { calls, layer } = makeHarness();

    await upload(layer, { tags: ["draft"] });

    expect(calls).toEqual([{ tags: ["draft"] }]);
  });

  it("still sends no metadata when the caller supplies none", async () => {
    const { calls, layer } = makeHarness();

    await upload(layer);

    expect(calls).toEqual([undefined]);
  });
});
