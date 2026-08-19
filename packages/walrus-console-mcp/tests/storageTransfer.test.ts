import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConsoleApiError } from "../src/console/errors";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleStorageService } from "../src/console/ConsoleStorageService";
import { SealCryptoService } from "../src/console/SealCryptoService";
import { BucketId, FileId } from "../src/console/types";

/**
 * Two properties of the transfer path that only show up under failure or load:
 *
 *  - concurrent transfers must not each buffer a payload (F11), because every one
 *    of them holds plaintext AND Seal ciphertext at the same time;
 *  - the id of an ACCEPTED upload must survive whatever happens next (F14), or a
 *    retry re-encrypts and duplicates a file that already exists server-side.
 */

let tmpDir: string;
let tmpFile: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "transfer-test-"));
  tmpFile = path.join(tmpDir, "note.txt");
  await fs.writeFile(tmpFile, "hello");
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface HarnessOptions {
  onUpload?: () => Effect.Effect<void>;
  statusResult?: () => Effect.Effect<{ data: { state: string } }, ConsoleApiError>;
}

function makeHarness(opts: HarnessOptions = {}) {
  const events: string[] = [];

  const api = {
    uploadBucketFile: () =>
      Effect.gen(function* () {
        events.push("upload:start");
        if (opts.onUpload) yield* opts.onUpload();
        events.push("upload:end");
        return { data: { id: FileId.make("file-accepted-1") } };
      }),
    getFileUploadStatus: () =>
      opts.statusResult?.() ?? Effect.succeed({ data: { state: "completed" as const } }),
    downloadBucketFile: () =>
      Effect.gen(function* () {
        events.push("download:start");
        if (opts.onUpload) yield* opts.onUpload();
        events.push("download:end");
        return new Uint8Array([1, 2, 3]);
      }),
  };

  const seal = {
    encrypt: (plaintext: Uint8Array) => Effect.succeed(plaintext),
    decrypt: (ciphertext: Uint8Array) => Effect.succeed(ciphertext),
  };

  const layer = ConsoleStorageService.DefaultWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ConsoleApiClient, api as unknown as typeof ConsoleApiClient.Service),
        Layer.succeed(SealCryptoService, seal as unknown as typeof SealCryptoService.Service),
      ),
    ),
  );

  return { events, layer };
}

/**
 * Unprovided on purpose. `Effect.provide` builds the layer for the effect it is
 * applied to, so providing per-effect would give each transfer its OWN
 * ConsoleStorageService — and its own semaphore, which gates nothing. Layer
 * memoisation only spans a single provide, so the concurrency tests below provide
 * once, around both transfers.
 */
const uploadEffect = ConsoleStorageService.pipe(
  Effect.flatMap((s) => s.uploadFileToBucket(BucketId.make("bucket-1"), "0xpolicy", tmpFile)),
);

const uploadWith = (layer: Layer.Layer<ConsoleStorageService>) =>
  uploadEffect.pipe(Effect.provide(layer));

describe("transfer concurrency (F11)", () => {
  it("does not run two uploads at the same time", async () => {
    // Interleaved starts would mean two payloads buffered at once — with a 256 MiB
    // cap each and two copies apiece, that is how the session dies.
    const { events, layer } = makeHarness({ onUpload: () => Effect.sleep("10 millis") });

    await Effect.runPromise(
      Effect.all([uploadEffect, uploadEffect], { concurrency: "unbounded" }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(events).toEqual(["upload:start", "upload:end", "upload:start", "upload:end"]);
  });

  it("does not run a download alongside an upload", async () => {
    // One heap, so the limit has to span both directions rather than being
    // per-operation.
    const { events, layer } = makeHarness({ onUpload: () => Effect.sleep("10 millis") });

    const downloadEffect = ConsoleStorageService.pipe(
      Effect.flatMap((s) =>
        s.downloadFile(
          BucketId.make("bucket-1"),
          FileId.make("file-1"),
          "0xpolicy",
          path.join(tmpDir, "out.bin"),
        ),
      ),
    );

    await Effect.runPromise(
      Effect.all([uploadEffect, downloadEffect], { concurrency: "unbounded" }).pipe(
        Effect.provide(layer),
      ),
    );

    const starts = events.filter((e) => e.endsWith(":start"));
    const firstEnd = events.findIndex((e) => e.endsWith(":end"));
    expect(starts).toHaveLength(2);
    // The second transfer must not begin before the first one finished.
    expect(events.indexOf(starts[1] as string)).toBeGreaterThan(firstEnd);
  });

  it("releases the permit when a transfer fails", async () => {
    const { events, layer } = makeHarness({
      statusResult: () => Effect.fail(new ConsoleApiError({ message: "status boom" })),
    });

    await Effect.runPromise(Effect.either(uploadWith(layer)));
    await Effect.runPromise(Effect.either(uploadWith(layer)));

    // A permit leaked on the failure path would deadlock the second transfer.
    expect(events.filter((e) => e === "upload:start")).toHaveLength(2);
  });
});

describe("accepted upload id survives a later failure (F14)", () => {
  it("names the accepted file id in an error raised during polling", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { layer } = makeHarness({
      statusResult: () => Effect.fail(new ConsoleApiError({ message: "status boom" })),
    });

    const error = await Effect.runPromise(Effect.flip(uploadWith(layer)));

    // Without the id the caller's only recovery is to upload again, which
    // re-encrypts and duplicates a file the server already has.
    expect(JSON.stringify(error)).toContain("file-accepted-1");
  });

  it("logs the accepted file id as soon as the upload is accepted", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { layer } = makeHarness();

    await Effect.runPromise(uploadWith(layer));

    // Polling can outlast the process; a crash mid-poll must still leave the id
    // somewhere the user can find it.
    expect(spy.mock.calls.flat().join(" ")).toContain("file-accepted-1");
  });

  it("still reports the id on a successful upload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { layer } = makeHarness();

    const result = await Effect.runPromise(uploadWith(layer));

    expect(result.fileId).toBe("file-accepted-1");
  });
});
