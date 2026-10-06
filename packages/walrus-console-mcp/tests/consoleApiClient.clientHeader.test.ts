import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleConfigTag } from "../src/config";
import { fetchWithClientHeader, ConsoleApiClient } from "../src/console/ConsoleApiClient";
import type { BucketId, FileId } from "../src/console/types";

/**
 * COMG-1053 — an API key is shared by every headless surface, so Console tells
 * MCP traffic apart from a direct API integration only by this header. Both
 * credential lanes must send it, or MCP usage disappears into `client: "api"`.
 */

interface Seen {
  url: string;
  headers: Record<string, string>;
}

function harness(responseBody: unknown) {
  const seen: Seen[] = [];

  const stub = HttpClient.make((request) => {
    seen.push({ url: request.url, headers: { ...request.headers } });
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  const layer = ConsoleApiClient.Default.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(ConsoleConfigTag, {
          apiKey: Redacted.make("hbr_test_key"),
          servicePrivateKey: Redacted.make(""),
          adminKey: Redacted.make("hbradm_test_key"),
          adminServicePrivateKey: Redacted.make(""),
          baseUrl: "https://api.example.test",
          webAccountAddress: "",
          keyAdminAddress: "",
        }),
        Layer.succeed(HttpClient.HttpClient, stub),
      ),
    ),
  );

  return { seen, layer };
}

// Uncast, like `consoleApiClient.download.test.ts`. The cast was redundant rather
// than harmful: the `f` parameter signature below already pins `R` to `never`, so
// a case with an unsatisfied context fails the build either way.
const run = <A>(
  layer: Layer.Layer<ConsoleApiClient>,
  f: (api: typeof ConsoleApiClient.Service) => Effect.Effect<A, unknown>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* ConsoleApiClient;
      return yield* f(api);
    }).pipe(Effect.provide(layer)),
  );

const KEY_ID = "11111111-1111-1111-1111-111111111111";

describe("X-Console-Client", () => {
  it("is sent on the working-key lane", async () => {
    const { seen, layer } = harness({ data: [] });

    await run(layer, (api) => api.listSpaces());

    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers["x-console-client"]).toBe("mcp");
  });

  it("is sent on the Key-Admin lane", async () => {
    const { seen, layer } = harness({
      data: {
        id: KEY_ID,
        status: "registering",
        registration_progress: { granted: 1, total: 3 },
      },
    });

    await run(layer, (api) => api.getApiKeyStatus(KEY_ID));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers["x-console-client"]).toBe("mcp");
    // Which lane, not just that a header arrived: `getApiKeyStatus` routes through
    // `adminAuthed` today, and per-endpoint lane moves are documented practice. Without
    // this the `adminAuthed` header line could go unpinned while the case stays green.
    expect(seen[0]?.headers["authorization"]).toBe("Bearer hbradm_test_key");
  });

  // It names a surface; it must never be mistaken for a credential.
  it("does not displace the Authorization header", async () => {
    const { seen, layer } = harness({ data: [] });

    await run(layer, (api) => api.listSpaces());

    expect(seen[0]?.headers["authorization"]).toBe("Bearer hbr_test_key");
  });
});

// `uploadBucketFile` builds its own request rather than going through either
// HttpClient lane, so the lane tests above say nothing about it — and it is the
// call the upload events are attributed from.
describe("X-Console-Client on the multipart upload", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("is sent with the upload", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: "file-1" } }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );

    const { layer } = harness({});
    await run(layer, (api) =>
      api.uploadBucketFile("bucket-1" as BucketId, new Uint8Array([1, 2, 3]), "note.txt"),
    );

    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Console-Client"]).toBe("mcp");
    expect(headers["Authorization"]).toBe("Bearer hbr_test_key");
  });
});

// `downloadBucketFile` is the fourth site and the only one neither lane test
// nor the upload test reaches, so without this it could be reverted green.
describe("X-Console-Client on the download", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("is sent on the first hop, alongside the key", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-length": "3" },
      }),
    );

    const { layer } = harness({});
    await run(layer, (api) => api.downloadBucketFile("bucket-1" as BucketId, "file-1" as FileId));

    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Console-Client"]).toBe("mcp");
    expect(headers["Authorization"]).toBe("Bearer hbr_test_key");
  });
});

// The Seal SDK builds its own `fetch_key` requests and its only header slot is spent
// on `Authorization`, so this wrapper is the one way the aggregator lane is attributed.
// Tested here rather than through `SealCryptoService`, which would need the whole SDK
// stood up to observe one header.
describe("fetchWithClientHeader", () => {
  const stubFetch = () =>
    vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(null, { status: 204 }));

  const initOf = (base: ReturnType<typeof stubFetch>): RequestInit => base.mock.calls[0]?.[1] ?? {};

  it("adds the header to a request that has none", async () => {
    const base = stubFetch();

    await fetchWithClientHeader(base as unknown as typeof fetch)("https://api.example.test/x");

    expect(new Headers(initOf(base).headers).get("x-console-client")).toBe("mcp");
  });

  it("keeps the caller's other headers, including Authorization", async () => {
    const base = stubFetch();

    await fetchWithClientHeader(base as unknown as typeof fetch)("https://api.example.test/x", {
      headers: { Authorization: "Bearer hbr_test_key", Accept: "application/json" },
    });

    const headers = new Headers(initOf(base).headers);
    expect(headers.get("authorization")).toBe("Bearer hbr_test_key");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("x-console-client")).toBe("mcp");
  });

  it("preserves the rest of the init", async () => {
    const base = stubFetch();

    await fetchWithClientHeader(base as unknown as typeof fetch)("https://api.example.test/x", {
      method: "POST",
      body: "payload",
    });

    expect(initOf(base).method).toBe("POST");
    expect(initOf(base).body).toBe("payload");
  });
});
