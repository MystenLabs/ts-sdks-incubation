import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { BucketId, SpaceId } from "../src/console/types";

/**
 * COMG-1018 — pins the query string both listing endpoints are paged with.
 *
 * The reported bug was in the tool schemas, not here: the client already took
 * `cursor` (and `visibility`), while `list_files` / `list_buckets` had no way
 * to accept either, so a space or bucket past the first page was unreachable.
 * These assertions are what stops the plumbing the tools now depend on from
 * being dropped again — a client that quietly stopped forwarding `cursor`
 * would turn a paged listing back into an endless first page.
 */

interface Seen {
  method: string;
  url: string;
}

function harness(responseBody: unknown) {
  const seen: Seen[] = [];

  const stub = HttpClient.make((request) => {
    seen.push({ method: request.method, url: request.url });
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
          adminKey: Redacted.make(""),
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

const run = <A>(
  layer: Layer.Layer<ConsoleApiClient>,
  f: (api: typeof ConsoleApiClient.Service) => Effect.Effect<A, unknown>,
) => Effect.runPromise(ConsoleApiClient.pipe(Effect.flatMap(f), Effect.provide(layer)) as never);

/** The query half of a recorded URL, as the server would parse it. */
const queryOf = (url: string | undefined) =>
  Object.fromEntries(new URL(url ?? "").searchParams.entries());

describe("listBuckets paging", () => {
  it("forwards cursor and visibility as query params", async () => {
    const { seen, layer } = harness({ buckets: [], next_cursor: null });

    await run(layer, (api) =>
      api.listBuckets({
        spaceId: SpaceId.make("space-1"),
        limit: 20,
        cursor: "opaque-cursor",
        visibility: "private",
      }),
    );

    expect(seen[0]?.method).toBe("GET");
    expect(queryOf(seen[0]?.url)).toEqual({
      limit: "20",
      cursor: "opaque-cursor",
      visibility: "private",
    });
  });

  it("omits both when the caller asks for the first page unfiltered", async () => {
    const { seen, layer } = harness({ buckets: [], next_cursor: null });

    await run(layer, (api) => api.listBuckets({ spaceId: SpaceId.make("space-1") }));

    expect(queryOf(seen[0]?.url)).toEqual({});
  });

  it("returns the cursor the next call needs", async () => {
    const { layer } = harness({ buckets: [], next_cursor: "page-2" });

    const result = await run(layer, (api) => api.listBuckets({ spaceId: SpaceId.make("space-1") }));

    expect(result).toMatchObject({ next_cursor: "page-2" });
  });
});

describe("listBucketFiles paging", () => {
  it("forwards the cursor as a query param", async () => {
    const { seen, layer } = harness({
      data: [],
      pagination: { limit: 20, has_more: false, next_cursor: null },
    });

    await run(layer, (api) =>
      api.listBucketFiles(BucketId.make("bucket-1"), 20, "opaque-cursor", "report"),
    );

    expect(seen[0]?.method).toBe("GET");
    expect(queryOf(seen[0]?.url)).toEqual({
      limit: "20",
      cursor: "opaque-cursor",
      q: "report",
    });
  });

  it("omits the cursor on a first page", async () => {
    const { seen, layer } = harness({
      data: [],
      pagination: { limit: 20, has_more: true, next_cursor: "page-2" },
    });

    await run(layer, (api) => api.listBucketFiles(BucketId.make("bucket-1")));

    expect(queryOf(seen[0]?.url)).toEqual({});
  });

  it("surfaces has_more and next_cursor under pagination, which is where the tool reads them", async () => {
    const { layer } = harness({
      data: [],
      pagination: { limit: 20, has_more: true, next_cursor: "page-2" },
    });

    const result = await run(layer, (api) => api.listBucketFiles(BucketId.make("bucket-1")));

    expect(result).toMatchObject({
      pagination: { has_more: true, next_cursor: "page-2" },
    });
  });
});
