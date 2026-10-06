import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Either, Layer, Redacted } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type ConsoleConfig, ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient, type FileStatusErrorBody } from "../src/console/ConsoleApiClient";
import { ConsoleStorageService, RosterChainDepsTag } from "../src/console/ConsoleStorageService";
import { UploadsPausedError } from "../src/console/errors";
import type { RosterChainDeps } from "../src/console/rosterVerification";
import { SealCryptoService } from "../src/console/SealCryptoService";
import { BucketId, FileId } from "../src/console/types";
import { FIXTURE_OWNER, verifiedBucket } from "./verifiedBucket";

/**
 * Once `get_file_status` has read a daily-limit failure with a time,
 * `upload_file` refuses locally until then: before the policy lookup, the
 * file read, or the upload request. Uploads are accept-and-return, so the
 * block stops the next upload, not ones already accepted.
 */

let tmpDir: string;
let tmpFile: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daily-limit-test-"));
  tmpFile = path.join(tmpDir, "note.txt");
  await fs.writeFile(tmpFile, "hello");
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const STUB_CONFIG: ConsoleConfig = {
  apiKey: Redacted.make("hbr_working_key_value"),
  servicePrivateKey: Redacted.make("suiprivkey1working"),
  adminKey: Redacted.make(""),
  adminServicePrivateKey: Redacted.make(""),
  baseUrl: "https://api.testnet.console.walrus.xyz",
  webAccountAddress: FIXTURE_OWNER,
  keyAdminAddress: "",
};

const NO_CHAIN_READS = Layer.succeed(RosterChainDepsTag, {} as RosterChainDeps);

function makeHarness(failedWith: () => FileStatusErrorBody | undefined) {
  const calls = { getBucketById: 0, uploadBucketFile: 0, getFileUploadStatus: 0 };
  let uploads = 0;

  const api = {
    getBucketById: (id: string) => {
      calls.getBucketById += 1;
      return Effect.succeed(verifiedBucket(STUB_CONFIG.baseUrl, id));
    },
    uploadBucketFile: (
      _bucketId: string,
      _bytes: Uint8Array,
      fileName: string,
      _metadata?: unknown,
      contentSize?: number,
      declaredType?: string,
    ) => {
      calls.uploadBucketFile += 1;
      uploads += 1;
      return Effect.succeed({
        data: {
          id: FileId.make(`file-${uploads}`),
          original_name: fileName.trim().normalize("NFC"),
          declared_mime_type: declaredType ?? null,
          content_size: contentSize ?? null,
        },
      });
    },
    getFileUploadStatus: () => {
      calls.getFileUploadStatus += 1;
      const error = failedWith();
      return Effect.succeed(
        error === undefined
          ? { data: { state: "completed" as const, progress: 1 } }
          : { data: { state: "failed" as const, error } },
      );
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
  return { calls, layer };
}

const BUCKET = BucketId.make("bucket-1");
const upload = ConsoleStorageService.pipe(
  Effect.flatMap((s) => s.uploadFileToBucket(BUCKET, undefined, tmpFile)),
);
const status = (fileId: string) =>
  ConsoleStorageService.pipe(Effect.flatMap((s) => s.getFileStatus(BUCKET, FileId.make(fileId))));

const leftOf = <E>(either: Either.Either<unknown, E>): E | undefined =>
  Either.isLeft(either) ? either.left : undefined;

describe("upload_file after get_file_status reports a daily limit", () => {
  it("refuses the next uploads without an API call until the limit reopens", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-22T10:00:00Z") });
    const retryAt = "2026-09-22T11:00:00Z";
    let capped = true;
    const { calls, layer } = makeHarness(() =>
      capped
        ? {
            code: "upload_daily_funding_limit",
            message: "capped",
            retry_at: retryAt,
            retry_after_seconds: 3600,
          }
        : undefined,
    );

    // Provided once around the whole sequence: `Effect.provide` builds a
    // fresh service each time, and a fresh service remembers nothing.
    const { read, refused, allowed } = await Effect.runPromise(
      Effect.gen(function* () {
        yield* upload;
        const read = yield* status("file-1");
        const refused = yield* Effect.either(upload);
        vi.setSystemTime(new Date("2026-09-22T11:00:01Z"));
        capped = false;
        const allowed = yield* Effect.either(upload);
        return { read, refused, allowed };
      }).pipe(Effect.provide(layer)),
    );

    expect(read.data).toMatchObject({ state: "failed", condition: "daily_limit" });
    const error = leftOf(refused);
    expect(error).toBeInstanceOf(UploadsPausedError);
    expect((error as UploadsPausedError).retryAt).toBe(retryAt);
    expect((error as UploadsPausedError).message).toMatch(/refused without an API call/i);
    expect(Either.isRight(allowed)).toBe(true);
    // The refused upload never reached Console; the first and the allowed one did.
    expect(calls.uploadBucketFile).toBe(2);
  });

  it("times the block from retry_after_seconds, not retry_at against a skewed clock", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Host clock two hours ahead of Console: retry_at is already "past" here.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-22T12:00:00Z") });
    const { calls, layer } = makeHarness(() => ({
      code: "upload_daily_funding_limit",
      message: "capped",
      retry_at: "2026-09-22T11:00:00Z",
      retry_after_seconds: 3600,
    }));

    const refused = await Effect.runPromise(
      Effect.gen(function* () {
        yield* upload;
        yield* status("file-1");
        return yield* Effect.either(upload);
      }).pipe(Effect.provide(layer)),
    );

    expect(leftOf(refused)).toBeInstanceOf(UploadsPausedError);
    expect(calls.uploadBucketFile).toBe(1);
  });

  it("keeps the later deadline when an older failure is read after a newer one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-22T10:00:00Z") });
    let retryAfterSeconds = 3600;
    const { calls, layer } = makeHarness(() => ({
      code: "upload_daily_funding_limit",
      message: "capped",
      retry_at: new Date(Date.now() + retryAfterSeconds * 1000).toISOString(),
      retry_after_seconds: retryAfterSeconds,
    }));

    const refused = await Effect.runPromise(
      Effect.gen(function* () {
        yield* upload;
        yield* status("file-1");
        // An older failure whose window closes sooner.
        retryAfterSeconds = 60;
        yield* status("file-0");
        vi.setSystemTime(new Date("2026-09-22T10:02:00Z"));
        return yield* Effect.either(upload);
      }).pipe(Effect.provide(layer)),
    );

    expect(leftOf(refused)).toBeInstanceOf(UploadsPausedError);
    expect(calls.uploadBucketFile).toBe(1);
  });

  it("does not block after a service-wide pause, even one with a time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls, layer } = makeHarness(() => ({
      code: "upload_funding_paused",
      message: "paused",
      retry_at: new Date(Date.now() + 3_600_000).toISOString(),
      retry_after_seconds: 3600,
    }));

    const read = await Effect.runPromise(
      Effect.gen(function* () {
        yield* upload;
        const read = yield* status("file-1");
        yield* upload;
        return read;
      }).pipe(Effect.provide(layer)),
    );

    // An operator can lift a global window at any time, so the agent is told
    // to stop, but the MCP does not hold uploads shut on its own.
    expect(read.data).toMatchObject({ state: "failed", condition: "funding_paused" });
    expect(calls.uploadBucketFile).toBe(2);
  });

  it("does not block on a daily limit without a time (this file alone exceeds the cap)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls, layer } = makeHarness(() => ({
      code: "upload_daily_funding_limit",
      message: "capped",
    }));

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* upload;
        yield* status("file-1");
        yield* upload;
      }).pipe(Effect.provide(layer)),
    );

    expect(calls.uploadBucketFile).toBe(2);
  });

  it("does not stop uploads already sent before the failed status was read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls, layer } = makeHarness(() => ({
      code: "upload_daily_funding_limit",
      message: "capped",
      retry_at: new Date(Date.now() + 3_600_000).toISOString(),
      retry_after_seconds: 3600,
    }));

    // A batch fired in parallel is accepted before any status is read.
    await Effect.runPromise(
      Effect.all(
        Array.from({ length: 5 }, () => upload),
        { concurrency: "unbounded" },
      ).pipe(Effect.provide(layer)),
    );

    expect(calls.uploadBucketFile).toBe(5);
  });

  it("passes non-failed statuses through unchanged", async () => {
    const { layer } = makeHarness(() => undefined);
    const read = await Effect.runPromise(status("file-1").pipe(Effect.provide(layer)));
    expect(read).toEqual({ data: { state: "completed", progress: 1 } });
  });
});
