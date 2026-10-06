import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConsoleConfig, ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleStorageService, RosterChainDepsTag } from "../src/console/ConsoleStorageService";
import type { RosterChainDeps } from "../src/console/rosterVerification";
import { SealCryptoService } from "../src/console/SealCryptoService";
import { BucketId, FileId } from "../src/console/types";
import { boundFile, verifiedBucket } from "./verifiedBucket";

/**
 * `download_file` against file names at and over the 255 cap a single name has
 * on NTFS, ext4 and APFS. Console accepts names up to 255 characters, so a legal
 * name must download, and one no filesystem can hold must be refused with the
 * limit named — before anything is fetched. Runs on the Windows CI job, where
 * an over-long name otherwise surfaces only as ENOENT.
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "download-long-name-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const STUB_CONFIG: ConsoleConfig = {
  apiKey: Redacted.make("hbr_working_key_value"),
  servicePrivateKey: Redacted.make("suiprivkey1working"),
  adminKey: Redacted.make(""),
  adminServicePrivateKey: Redacted.make(""),
  baseUrl: "https://api.testnet.console.walrus.xyz",
  webAccountAddress: "",
  keyAdminAddress: "",
};

const PAYLOAD = new Uint8Array([1, 2, 3]);

function makeHarness() {
  const fetched: string[] = [];
  const api = {
    downloadBucketFile: (_bucketId: BucketId, fileId: FileId) =>
      Effect.sync(() => {
        fetched.push(fileId);
        return PAYLOAD;
      }),
    // The record the binding is compared against, and the bucket the
    // expected group is derived from. Both are read before the bytes are fetched,
    // which is why `fetched` stays the assertion about the FETCH specifically.
    getBucketFile: (_bucketId: BucketId, fileId: FileId) => Effect.succeed(boundFile(fileId)),
    getBucketById: (id: string) => Effect.succeed(verifiedBucket(STUB_CONFIG.baseUrl, id)),
  };
  const seal = {
    decrypt: (ciphertext: Uint8Array) =>
      Effect.succeed({ plaintext: ciphertext, authenticatedName: null, bound: false }),
  };
  const layer = ConsoleStorageService.DefaultWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ConsoleApiClient, api as unknown as typeof ConsoleApiClient.Service),
        Layer.succeed(SealCryptoService, seal as unknown as typeof SealCryptoService.Service),
        Layer.succeed(ConsoleConfigTag, STUB_CONFIG),
        Layer.succeed(RosterChainDepsTag, {} as RosterChainDeps),
      ),
    ),
  );
  const download = (destPath: string) =>
    ConsoleStorageService.pipe(
      Effect.flatMap((s) =>
        s.downloadFile(BucketId.make("bucket-1"), FileId.make("file-1"), destPath),
      ),
      Effect.provide(layer),
    );
  return { fetched, download };
}

describe("download_file with a long file name", () => {
  it("downloads a 252-character file name and leaves nothing else behind", async () => {
    const name = `extreme_long_filename_test_${"a".repeat(252 - 27 - 4)}.txt`;
    const dest = path.join(dir, name);
    const { download } = makeHarness();

    const result = await Effect.runPromise(download(dest));

    expect(name).toHaveLength(252);
    expect(result).toEqual({ bytesWritten: PAYLOAD.length, destPath: dest, bound: false });
    expect(new Uint8Array(await fs.readFile(dest))).toEqual(PAYLOAD);
    expect(await fs.readdir(dir)).toEqual([name]);
  });

  it("refuses a name over the limit before fetching, naming the limit and a name that fits", async () => {
    const name = `${"b".repeat(300)}.txt`;
    const { fetched, download } = makeHarness();

    const error = await Effect.runPromise(Effect.flip(download(path.join(dir, name))));

    expect(error._tag).toBe("LocalFsError");
    // The exact length and unit clause, not just a loose "/255/" match: a
    // wrong length, a swapped unit, or a message that stopped naming either
    // one at all would previously slip past this assertion unnoticed.
    expect(error.message).toContain("is 304 UTF-16 units long, over the 255-unit limit");
    expect(error.message).toContain(`"${"b".repeat(251)}.txt"`);
    expect(fetched).toEqual([]);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
