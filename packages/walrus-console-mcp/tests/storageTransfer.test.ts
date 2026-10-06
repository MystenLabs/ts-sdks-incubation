import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Fiber, Layer, Redacted, TestClock, TestContext } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type ConsoleConfig, ConsoleConfigTag } from "../src/config";
import { ConsoleApiError } from "../src/console/errors";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleStorageService, RosterChainDepsTag } from "../src/console/ConsoleStorageService";
import type { RosterChainDeps } from "../src/console/rosterVerification";
import { SealCryptoService } from "../src/console/SealCryptoService";
import { BucketId, FileId } from "../src/console/types";
import { boundFile, FIXTURE_OWNER, verifiedBucket } from "./verifiedBucket";
import { tryPromiseSettling } from "../src/effectPromise";

/**
 * Two properties of the transfer path that only show up under failure or load:
 *
 *  - concurrent transfers must not each buffer a payload (F11), because every one
 *    of them holds plaintext AND Seal ciphertext at the same time;
 *  - an ACCEPTED upload's id is what `uploadFileToBucket` returns, full stop
 *    (F14, COMG-1019) — it no longer polls to a terminal state in-process, so
 *    there is no later step for that id to fail to survive.
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
  webAccountAddress: FIXTURE_OWNER,
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
  onUpload?: () => Effect.Effect<void, ConsoleApiError>;
}

function makeHarness(opts: HarnessOptions = {}) {
  const events: string[] = [];

  const api = {
    getBucketById: (id: string) => Effect.succeed(verifiedBucket(STUB_CONFIG.baseUrl, id)),
    // Read before the bytes are, so it is deliberately NOT one of the
    // `events` below — those trace the payload phase the transfer lock bounds.
    getBucketFile: (_b: string, f: string) => Effect.succeed(boundFile(f)),
    uploadBucketFile: (
      _bucketId: string,
      _bytes: Uint8Array,
      fileName: string,
      _metadata?: unknown,
      contentSize?: number,
      declaredType?: string,
    ) =>
      Effect.gen(function* () {
        events.push("upload:start");
        if (opts.onUpload) yield* opts.onUpload();
        events.push("upload:end");
        return {
          data: {
            id: FileId.make("file-accepted-1"),
            original_name: fileName.trim().normalize("NFC"),
            declared_mime_type: declaredType ?? null,
            content_size: contentSize ?? null,
          },
        };
      }),
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
    decrypt: (ciphertext: Uint8Array) =>
      Effect.succeed({ plaintext: ciphertext, authenticatedName: null, bound: false }),
  };

  const layer = ConsoleStorageService.DefaultWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ConsoleApiClient, api as unknown as typeof ConsoleApiClient.Service),
        Layer.succeed(SealCryptoService, seal as unknown as typeof SealCryptoService.Service),
        // Uploads verify the bucket's policy against the pinned owner
        // (COMG-1007), which `getBucketById` above derives from.
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
  Effect.flatMap((s) => s.uploadFileToBucket(BucketId.make("bucket-1"), undefined, tmpFile)),
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
      onUpload: () => Effect.fail(new ConsoleApiError({ message: "upload boom" })),
    });

    await Effect.runPromise(Effect.either(uploadWith(layer)));
    await Effect.runPromise(Effect.either(uploadWith(layer)));

    // A permit leaked on the failure path would deadlock the second transfer.
    expect(events.filter((e) => e === "upload:start")).toHaveLength(2);
  });

  // "releases the permit once the upload is accepted, before polling (M12)" was
  // removed here (COMG-1019): it relied on upload A polling forever after accept
  // to prove the permit wasn't held through that poll. `uploadFileToBucket` no
  // longer polls in-process at all — it returns right after accept — so nothing
  // after accept can hold the permit, structurally, for any upload. The
  // remaining concurrency tests above already cover the phase that still holds
  // it (payload read/encrypt/upload).

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
      getBucketById: (id: string) => Effect.succeed(verifiedBucket(STUB_CONFIG.baseUrl, id)),
      uploadBucketFile: (
        _bucketId: string,
        _bytes: Uint8Array,
        fileName: string,
        _metadata?: unknown,
        contentSize?: number,
        declaredType?: string,
      ) =>
        Effect.sync(() => ({
          data: {
            id: FileId.make(`file-${encryptCalls}`),
            original_name: fileName.trim().normalize("NFC"),
            declared_mime_type: declaredType ?? null,
            content_size: contentSize ?? null,
          },
        })),
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

describe("upload_file returns as soon as the upload is accepted (COMG-1019)", () => {
  it("never calls get_file_status, even once, before resolving", async () => {
    // A beta user's 99 MiB upload timed out client-side (the MCP TS SDK's
    // default 60s request timeout) while uploadFileToBucket was still polling
    // get_file_status in-process, waiting for a terminal state that can take
    // minutes on a real upload. get_file_status here is Effect.never — if a
    // regression reintroduces even one poll call before returning, this hangs
    // past the bounded timeout below instead of the process just running long,
    // so it fails loudly rather than only showing up as a slow CI run.
    let statusCalls = 0;
    const api = {
      getBucketById: (id: string) => Effect.succeed(verifiedBucket(STUB_CONFIG.baseUrl, id)),
      uploadBucketFile: (
        _bucketId: string,
        _bytes: Uint8Array,
        fileName: string,
        _metadata?: unknown,
        contentSize?: number,
        declaredType?: string,
      ) =>
        Effect.succeed({
          data: {
            id: FileId.make("file-1"),
            original_name: fileName.trim().normalize("NFC"),
            declared_mime_type: declaredType ?? null,
            content_size: contentSize ?? null,
          },
        }),
      getFileUploadStatus: () => {
        statusCalls += 1;
        return Effect.never;
      },
    };
    const seal = { encrypt: (plaintext: Uint8Array) => Effect.succeed(plaintext) };
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

    const result = await Effect.runPromise(
      uploadEffect.pipe(Effect.provide(layer), Effect.timeout("500 millis")),
    );

    expect(statusCalls).toBe(0);
    expect(result).toMatchObject({ fileId: "file-1", pending: true });
  });

  it("gives up after UPLOAD_ACCEPT_TIMEOUT instead of hanging on a stalled connection to Console", async () => {
    // COMG-1019 review (nikola0x0): returning right after accept fixes the
    // reported bug, but nothing bounded the accept step itself — a stalled
    // `fetch` to Console (uploadBucketFile here is Effect.never) would have
    // hung the tool call indefinitely, with no server-side signal at all
    // until whatever the MCP client's own transport does. TestClock, not a
    // real wait, per the same reasoning uploadPolicy.test.ts already uses
    // for the mirror-grant budget: assert the real 4-minute constant
    // without a slow test.
    const api = {
      getBucketById: (id: string) => Effect.succeed(verifiedBucket(STUB_CONFIG.baseUrl, id)),
      uploadBucketFile: () => Effect.never,
    };
    const seal = { encrypt: (plaintext: Uint8Array) => Effect.succeed(plaintext) };
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

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(uploadEffect.pipe(Effect.either));
        yield* TestClock.adjust("4 minutes");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(layer), Effect.provide(TestContext.TestContext)),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConsoleApiError);
      expect((result.left as ConsoleApiError).message).toContain(
        "Timed out after 4 minutes accepting this upload",
      );
    }
  });
});

describe("accepted upload id survives a later failure (F14)", () => {
  // "names the accepted file id in an error raised during polling" was removed
  // here (COMG-1019): `uploadFileToBucket` no longer polls in-process, so there
  // is no post-accept status-check failure left for the id to need surviving —
  // the two tests below cover what's left of F14's concern instead.

  it("logs the accepted file id as soon as the upload is accepted", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { layer } = makeHarness();

    await Effect.runPromise(uploadWith(layer));

    // A crash right after accept must still leave the id somewhere the user
    // can find it, even though the tool call itself has already returned by
    // then.
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
      getBucketById: (id: string) => Effect.succeed(verifiedBucket(STUB_CONFIG.baseUrl, id)),
      getBucketFile: (_b: string, f: string) => Effect.succeed(boundFile(f)),
      downloadBucketFile: () => Effect.succeed(new Uint8Array([9, 9, 9])),
    };
    const seal = {
      // A slow decrypt gives the test a window to cancel after the download but
      // before the write lands — the point of the async, signal-aware writer.
      decrypt: (ct: Uint8Array) =>
        Effect.sleep("200 millis").pipe(
          Effect.as({ plaintext: ct, authenticatedName: null, bound: false }),
        ),
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
          svc.downloadFile(BucketId.make("bucket-1"), FileId.make("file-1"), dest),
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
