import { HttpClient } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import type { BucketId, FileId } from "../src/console/types";
import { MAX_TRANSFER_BYTES_ENV } from "../src/transferLimits";

/**
 * Download buffers the whole ciphertext, and Seal then allocates the plaintext
 * beside it. Unbounded, one large file ends a long-lived MCP session — so the
 * cap has to be enforced BEFORE the body is read, and again while reading it,
 * because `Content-Length` is a claim by the server, not a guarantee.
 */

const TestConfig = Layer.succeed(ConsoleConfigTag, {
  apiKey: Redacted.make("hbr_test_key"),
  servicePrivateKey: Redacted.make(""),
  adminKey: Redacted.make(""),
  adminServicePrivateKey: Redacted.make(""),
  baseUrl: "https://api.example.test",
  webAccountAddress: "",
  keyAdminAddress: "",
});

const TestLayer = ConsoleApiClient.Default.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      TestConfig,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unused")),
      ),
    ),
  ),
);

const BUCKET = "bucket-1" as BucketId;
const FILE = "file-1" as FileId;

const download = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* ConsoleApiClient;
      return yield* api.downloadBucketFile(BUCKET, FILE);
    }).pipe(Effect.provide(TestLayer)),
  );

const downloadError = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* ConsoleApiClient;
      return yield* api.downloadBucketFile(BUCKET, FILE);
    }).pipe(Effect.provide(TestLayer), Effect.flip),
  );

/** A streaming body, so the size cap is exercised against real chunk delivery. */
const streamed = (chunks: Uint8Array[], headers: Record<string, string> = {}): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    }),
    { status: 200, headers },
  );

let envBackup: NodeJS.ProcessEnv;

beforeEach(() => {
  envBackup = { ...process.env };
});

afterEach(() => {
  process.env = envBackup;
  vi.restoreAllMocks();
});

describe("downloadBucketFile size limits", () => {
  it("returns the body when it is within the cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamed([new Uint8Array([1, 2, 3])], { "content-length": "3" })),
    );

    expect(await download()).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects on Content-Length without draining the body, and releases it", async () => {
    process.env[MAX_TRANSFER_BYTES_ENV] = "16";
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(256));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200, headers: { "content-length": "1024" } })),
    );

    await expect(downloadError()).resolves.toMatchObject({ _tag: "PayloadTooLargeError" });
    // An abandoned body holds its socket open; in a long-lived process that leaks.
    expect(cancelled).toBe(true);
    // A stream pre-buffers one chunk to fill its queue, so 1 pull is the floor, not
    // evidence of reading. Draining 1024 bytes would take four.
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it("still stops a body that overruns a truthful-looking Content-Length", async () => {
    // A lying or absent header must not become a bypass — the running count is
    // what actually bounds memory.
    process.env[MAX_TRANSFER_BYTES_ENV] = "16";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamed([new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)], {
          "content-length": "8",
        }),
      ),
    );

    await expect(downloadError()).resolves.toMatchObject({ _tag: "PayloadTooLargeError" });
  });

  it("bounds a body with no Content-Length at all", async () => {
    process.env[MAX_TRANSFER_BYTES_ENV] = "16";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamed([new Uint8Array(64)])),
    );

    await expect(downloadError()).resolves.toMatchObject({ _tag: "PayloadTooLargeError" });
  });

  it("accepts a body exactly at the cap", async () => {
    process.env[MAX_TRANSFER_BYTES_ENV] = "16";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamed([new Uint8Array(16)], { "content-length": "16" })),
    );

    expect(await download()).toHaveLength(16);
  });

  it("reassembles multiple chunks in order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamed([new Uint8Array([1, 2]), new Uint8Array([3, 4])])),
    );

    expect(await download()).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

describe("downloadBucketFile bounds the ERROR body too (F9)", () => {
  it("stops reading an oversized error body, cancels it, and truncates the message", async () => {
    // A non-OK response from a hostile-but-allowlisted endpoint could stream an
    // endless error body; `failFromFetchResponse` must not buffer it whole.
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 500 })),
    );

    const error = (await downloadError()) as { _tag: string; message: string };
    expect(error._tag).toBe("ConsoleApiError");
    // Bounded to ~64 KiB, nowhere near the endless body it was fed.
    expect(error.message.length).toBeLessThan(70_000);
    expect(error.message).toMatch(/truncated/);
    expect(cancelled).toBe(true);
    // 64 KiB / 1 KiB ≈ 64 reads, not an unbounded drain.
    expect(pulls).toBeLessThan(200);
  });
});
