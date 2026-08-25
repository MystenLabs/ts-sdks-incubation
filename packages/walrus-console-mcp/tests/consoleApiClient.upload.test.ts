import { HttpClient } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import type { BucketId } from "../src/console/types";

// COMG-602 — upload rejection surface.
//
// uploadBucketFile uses raw `fetch` (not the platform HttpClient), so these
// tests stub `global.fetch` directly. Contract under test:
//
//   status | body.code                | tagged error
//   ------ | ------------------------ | ---------------------------
//   415    | "unsupported_file_type"  | UnsupportedFileTypeError
//   413    | "payload_too_large"      | PayloadTooLargeError
//   5xx    | any                      | ConsoleApiError
//   throw  | (network / DNS / abort)  | ConsoleApiError
//
// Pinned per COMG-602 AC: "Deny, size-limit, and transport failures are
// distinct to the caller" and "at least one denied type per enforcement layer
// is pinned by tests" (extension `.exe` + magic-byte `.png` covered below).

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
const BYTES = new Uint8Array([0x01, 0x02, 0x03]);

const runUpload = (fileName: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* ConsoleApiClient;
      return yield* api.uploadBucketFile(BUCKET, BYTES, fileName);
    }).pipe(Effect.provide(TestLayer), Effect.flip),
  );

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("uploadBucketFile — server deny list (415)", () => {
  it("maps extension-blocked types (e.g. .exe) to UnsupportedFileTypeError", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse(415, {
        error: "This file type is not accepted.",
        code: "unsupported_file_type",
      }),
    );

    const err = (await runUpload("virus.exe")) as {
      _tag: string;
      fileName: string;
      layer: string;
      code?: string;
      message: string;
    };
    expect(err._tag).toBe("UnsupportedFileTypeError");
    expect(err.fileName).toBe("virus.exe");
    expect(err.code).toBe("unsupported_file_type");
    expect(err.layer).toBe("server");
    expect(err.message).toMatch(/not accepted/i);
  });

  it("maps magic-byte-blocked payloads (renamed .png wrapping ELF) to UnsupportedFileTypeError", async () => {
    // Public-bucket path only: server sniffs bytes and rejects even though the
    // extension is allowed. Same status + code as the extension check, so MCP
    // surfaces both identically — the caller doesn't need to know which layer
    // caught it, only that "this file will never be accepted".
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse(415, {
        error: "This file type is not accepted.",
        code: "unsupported_file_type",
      }),
    );

    const err = (await runUpload("malware.png")) as {
      _tag: string;
      fileName: string;
    };
    expect(err._tag).toBe("UnsupportedFileTypeError");
    expect(err.fileName).toBe("malware.png");
  });

  it("still tags a 415 whose body was truncated / non-JSON as UnsupportedFileTypeError", async () => {
    // Reverse proxies sometimes replace an error body with an HTML page — status
    // alone is enough to classify the rejection, so we don't fall back to a
    // generic ConsoleApiError just because the body isn't parseable.
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("<html><body>415 Unsupported Media Type</body></html>", {
        status: 415,
        headers: { "content-type": "text/html" },
      }),
    );

    const err = (await runUpload("thing.exe")) as { _tag: string };
    expect(err._tag).toBe("UnsupportedFileTypeError");
  });
});

describe("uploadBucketFile — size cap (413)", () => {
  it("maps a 413 to PayloadTooLargeError and echoes the request byte count", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse(413, {
        error: "Payload too large.",
        code: "payload_too_large",
      }),
    );

    const err = (await runUpload("huge.bin")) as {
      _tag: string;
      fileName: string;
      bytes: number;
      code?: string;
    };
    expect(err._tag).toBe("PayloadTooLargeError");
    expect(err.fileName).toBe("huge.bin");
    // The client doesn't know Console's cap, but it can report what it sent.
    // Agent uses this to reason about whether a retry with a split file helps.
    expect(err.bytes).toBe(BYTES.byteLength);
    expect(err.code).toBe("payload_too_large");
  });
});

describe("uploadBucketFile — other failures stay in ConsoleApiError", () => {
  it("maps a 500 to ConsoleApiError with the status and any body echoed", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse(500, { error: "internal", code: "server_error" }),
    );

    const err = (await runUpload("ok.txt")) as {
      _tag: string;
      status: number;
      code?: string;
    };
    expect(err._tag).toBe("ConsoleApiError");
    expect(err.status).toBe(500);
    expect(err.code).toBe("server_error");
  });

  it("maps a fetch rejection (DNS / abort / offline) to ConsoleApiError", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("network down"));

    const err = (await runUpload("ok.txt")) as { _tag: string; message: string };
    expect(err._tag).toBe("ConsoleApiError");
    // Transport failures don't have a status; the caller distinguishes them
    // from server-side rejections by the absent `status` field + generic tag.
    expect((err as { status?: number }).status).toBeUndefined();
    expect(err.message).toMatch(/upload failed/i);
  });
});

describe("uploadBucketFile — the error body is bounded (F9)", () => {
  it("stops reading an oversized error body, cancels it, and bounds the message", async () => {
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
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(body, { status: 500 }));

    const err = (await runUpload("ok.txt")) as { _tag: string; message: string };
    expect(err._tag).toBe("ConsoleApiError");
    expect(err.message.length).toBeLessThan(70_000);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(200);
  });
});

describe("uploadBucketFile — a 202 whose body cannot be read (F8)", () => {
  it("reports the upload as ACCEPTED and points to list_files/get_file_status, not a re-upload", async () => {
    // 202 = accepted; an unreadable body is not an upload failure. The message
    // must not read like one, or an agent re-uploads and duplicates the file.
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("<html>not json</html>", {
        status: 202,
        headers: { "content-type": "text/html" },
      }),
    );

    const err = (await runUpload("report.pdf")) as { _tag: string; message: string };
    expect(err._tag).toBe("ConsoleApiError");
    expect(err.message).toMatch(/accepted/i);
    expect(err.message).toMatch(/list_files/);
    expect(err.message).toMatch(/get_file_status/);
    // The old, misleading wording is gone.
    expect(err.message).not.toMatch(/failed to parse/i);
  });
});

describe("uploadBucketFile — 202 accepted path is unchanged", () => {
  it("returns the parsed FileUploadResponse on a 202", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: "file-42" } }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* ConsoleApiClient;
        return yield* api.uploadBucketFile(BUCKET, BYTES, "hello.txt");
      }).pipe(Effect.provide(TestLayer)),
    );
    expect(result).toEqual({ data: { id: "file-42" } });
  });
});
