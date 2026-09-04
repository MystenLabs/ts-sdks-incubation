import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Fiber, Layer, Redacted } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type ConsoleConfig, ConsoleConfigTag } from "../src/config";
import { ConsoleApiError } from "../src/console/errors";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleStorageService, RosterChainDepsTag } from "../src/console/ConsoleStorageService";
import type { RosterChainDeps } from "../src/console/rosterVerification";
import { SealCryptoService } from "../src/console/SealCryptoService";
import { BucketId, FileId } from "../src/console/types";
import { tryPromiseSettling } from "../src/effectPromise";

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

/** Enough config for the service to build; no network or crypto reads it. */
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
        // Only createBucket reads it (for the owner pin); the transfers below do
        // not, so the address fields stay empty.
        Layer.succeed(ConsoleConfigTag, STUB_CONFIG),
        NO_CHAIN_READS,
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

  it("releases the permit once the upload is accepted, before polling (M12)", async () => {
    // Bespoke layer, keyed by fileId rather than makeHarness's shared onUpload
    // hook: this test needs upload A to poll forever while upload B's own poll
    // completes immediately, and only the fileId each one is issued tells them
    // apart.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const events: string[] = [];
    let uploadCount = 0;

    const api = {
      uploadBucketFile: () =>
        Effect.sync(() => {
          uploadCount += 1;
          const n = uploadCount;
          events.push(`upload:${n}`);
          return { data: { id: FileId.make(`file-${n}`) } };
        }),
      // file-1 (upload A) never reaches a terminal state — if the permit were
      // still held across the poll (pre-fix), upload B could never even start.
      getFileUploadStatus: (_bucketId: BucketId, fileId: FileId) =>
        fileId === FileId.make("file-1")
          ? Effect.never
          : Effect.succeed({ data: { state: "completed" as const } }),
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

    await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* Effect.fork(uploadEffect);
        // Give A time to clear its payload phase and start (never-ending) polling
        // before B is forked, so a leaked permit shows up as B never starting.
        yield* Effect.sleep("20 millis");
        const b = yield* Effect.fork(uploadEffect);

        // Post-fix, B's upload is accepted and polled to completion in
        // milliseconds. Pre-fix, B is stuck waiting on A's permit, which A never
        // releases (its poll never terminates) — bounding the wait turns that
        // deadlock into an observed TimeoutException instead of a hung test.
        yield* Fiber.join(b).pipe(Effect.timeout("2 seconds"));

        yield* Fiber.interrupt(a);
      }).pipe(Effect.provide(layer)),
    );

    expect(events).toEqual(["upload:1", "upload:2"]);
  });

  it("holds the permit until a cancelled upload's abandoned encrypt settles (M8)", async () => {
    // Cancelling an MCP request interrupts the fiber, but no Seal API takes a
    // signal, so `sealClient.encrypt`'s promise keeps running with the plaintext
    // AND the ciphertext reachable. If the permit were released during that
    // teardown, a retry would start its own payload phase alongside it — two
    // payloads live at once, which is exactly what the size-1 permit exists to
    // prevent. `tryPromiseSettling` is what the real service wraps its Seal
    // calls in; the stub below models it with a gate the test controls.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const events: string[] = [];
    let encryptCalls = 0;
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    let markAEntered!: () => void;
    const aEntered = new Promise<void>((resolve) => {
      markAEntered = resolve;
    });

    const api = {
      uploadBucketFile: () =>
        Effect.sync(() => ({ data: { id: FileId.make(`file-${encryptCalls}`) } })),
      getFileUploadStatus: () => Effect.succeed({ data: { state: "completed" as const } }),
    };
    const seal = {
      encrypt: (plaintext: Uint8Array) =>
        tryPromiseSettling({
          try: () => {
            encryptCalls += 1;
            const which = encryptCalls === 1 ? "A" : "B";
            events.push(`encrypt:${which}`);
            if (which === "A") markAEntered();
            return which === "A" ? gate.then(() => plaintext) : Promise.resolve(plaintext);
          },
          catch: (cause) => cause as Error,
          // Bounded far under the 60s default so a regression fails this test
          // instead of wedging the suite for a minute.
          settleTimeoutMs: 2_000,
          label: "Seal encrypt",
        }),
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

    let eventsWhileHeld: readonly string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* Effect.fork(uploadEffect);
        // Deterministic rather than timed: the interrupt below must land while
        // A's encrypt promise is genuinely pending, or it would be testing the
        // (signal-aware, fast-settling) file read instead.
        yield* Effect.promise(() => aEntered);

        // Forked, not awaited: the interrupt itself cannot complete until A's
        // abandoned promise settles, so awaiting it here would deadlock the test.
        yield* Effect.fork(Fiber.interrupt(a));
        const b = yield* Effect.fork(uploadEffect);

        yield* Effect.sleep("50 millis");
        // Snapshot rather than assert in-fiber: a throw here would be a defect
        // that never releases the gate.
        eventsWhileHeld = [...events];

        yield* Effect.sync(() => resolveGate());
        yield* Fiber.join(b).pipe(Effect.timeout("2 seconds"));
      }).pipe(Effect.provide(layer)),
    );

    // 50ms after the cancel, B had still not started: the permit was held.
    expect(eventsWhileHeld).toEqual(["encrypt:A"]);
    // And releasing the gate lets it through — held, not deadlocked.
    expect(events).toEqual(["encrypt:A", "encrypt:B"]);
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

describe("an aborted download leaves nothing behind (F10)", () => {
  it("writes neither the destination nor a temp file when cancelled mid-transfer", async () => {
    const dest = path.join(tmpDir, "aborted-dl.bin");

    const api = {
      downloadBucketFile: () => Effect.succeed(new Uint8Array([9, 9, 9])),
    };
    const seal = {
      // A slow decrypt gives the test a window to cancel after the download but
      // before the write lands — the point of the async, signal-aware writer.
      decrypt: (ct: Uint8Array) => Effect.sleep("200 millis").pipe(Effect.as(ct)),
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

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ConsoleStorageService;
        const fiber = yield* Effect.fork(
          svc.downloadFile(BucketId.make("bucket-1"), FileId.make("file-1"), "0xpolicy", dest),
        );
        yield* Effect.sleep("20 millis");
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(layer)),
    );

    // No destination, and no temp sibling either — the cancelled transfer left the
    // directory exactly as it found it.
    const entries = await fs.readdir(tmpDir);
    expect(entries.some((f) => f.includes("aborted-dl.bin"))).toBe(false);
  });
});
