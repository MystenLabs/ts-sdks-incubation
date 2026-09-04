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
  // The canonical testnet URL, so the session resolves to testnet (the
  // resolver treats unrecognised hosts as mainnet). fetch is mocked in every
  // test, so nothing is ever sent to this host.
  baseUrl: "https://api.testnet.console.walrus.xyz",
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

describe("downloadBucketFile UGC redirect policy (COMG-817)", () => {
  // TestConfig's baseUrl is the canonical testnet API, so the session
  // resolves to testnet and the one legal redirect target is the testnet host.
  const UGC = "https://testnet-files.walrususercontent.com/downloads/tok-123";

  const redirectTo = (location: string, status = 307): Response =>
    new Response(null, { status, headers: { location } });

  it("follows a 307 to the network's UGC host, WITHOUT the Authorization header", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (calls.length === 1) return redirectTo(UGC);
        return streamed([new Uint8Array([9, 8, 7])], { "content-length": "3" });
      }),
    );

    expect(await download()).toEqual(new Uint8Array([9, 8, 7]));
    expect(calls).toHaveLength(2);
    // First request carries the key and must not auto-follow.
    expect((calls[0]!.init!.headers as Record<string, string>)["Authorization"]).toMatch(
      /^Bearer /,
    );
    expect(calls[0]!.init!.redirect).toBe("manual");
    // The hop goes to the token URL, credential-less, and refuses further hops.
    expect(calls[1]!.url).toBe(UGC);
    expect(calls[1]!.init!.headers).toBeUndefined();
    expect(calls[1]!.init!.redirect).toBe("error");
  });

  it("refuses a redirect to any other host, and never fetches it", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return redirectTo("https://evil.example.com/downloads/tok-123");
      }),
    );

    const error = (await downloadError()) as { _tag: string; message: string };
    expect(error._tag).toBe("ConsoleApiError");
    expect(error.message).toMatch(/redirect refused/i);
    expect(error.message).toContain("evil.example.com");
    // The token must never leak into the error string.
    expect(error.message).not.toContain("tok-123");
    expect(calls).toHaveLength(1);
  });

  it("refuses the OTHER network's UGC host — hosts are pinned per network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => redirectTo("https://files.walrususercontent.com/downloads/tok-123")),
    );

    const error = (await downloadError()) as { _tag: string; message: string };
    expect(error._tag).toBe("ConsoleApiError");
    expect(error.message).toMatch(/redirect refused/i);
  });

  it("refuses an explicit port even on the right host — token URLs never carry one", async () => {
    // The second fetch, if the hop were followed, would SUCCEED — so the only
    // thing that can fail this download is the redirect validator itself. (An
    // always-redirect mock passes vacuously: the hop's redirect:"error" would
    // reject any outcome.)
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (calls.length === 1) {
          return redirectTo("https://testnet-files.walrususercontent.com:8080/downloads/tok-123");
        }
        return streamed([new Uint8Array([1])], { "content-length": "1" });
      }),
    );

    const error = (await downloadError()) as { _tag: string; message: string };
    expect(error._tag).toBe("ConsoleApiError");
    expect(error.message).toMatch(/redirect refused/i);
    expect(calls).toHaveLength(1);
  });

  it("refuses an http (non-https) redirect even to the right host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => redirectTo("http://testnet-files.walrususercontent.com/downloads/tok-123")),
    );

    const error = (await downloadError()) as { _tag: string };
    expect(error._tag).toBe("ConsoleApiError");
  });

  it("refuses a redirect with no Location header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 307 })),
    );

    const error = (await downloadError()) as { _tag: string; message: string };
    expect(error._tag).toBe("ConsoleApiError");
    expect(error.message).toMatch(/redirect refused/i);
  });

  it("refuses a relative Location — it resolves to the API host, not the UGC host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => redirectTo("/downloads/tok-123")),
    );

    const error = (await downloadError()) as { _tag: string; message: string };
    expect(error._tag).toBe("ConsoleApiError");
    expect(error.message).toMatch(/redirect refused/i);
  });

  it("applies the size cap to the redirected body too", async () => {
    process.env[MAX_TRANSFER_BYTES_ENV] = "16";
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (first) {
          first = false;
          return redirectTo(UGC);
        }
        return streamed([new Uint8Array(64)]);
      }),
    );

    await expect(downloadError()).resolves.toMatchObject({ _tag: "PayloadTooLargeError" });
  });

  it("still serves a plain 200 with no redirect — pre-UGC behavior unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamed([new Uint8Array([1, 2, 3])], { "content-length": "3" })),
    );

    expect(await download()).toEqual(new Uint8Array([1, 2, 3]));
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
