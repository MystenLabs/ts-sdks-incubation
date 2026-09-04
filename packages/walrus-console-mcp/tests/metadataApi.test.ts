import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { BucketId, FileId } from "../src/console/types";

/**
 * COMG-662 — pins the wire shape of the two metadata endpoints: verb, path,
 * and body. The clear-by-null semantics only exist on the files path, so a
 * body assertion is the only thing that catches a client that silently drops
 * `null` (which is what `buildUploadMetadata` deliberately does).
 */

interface Seen {
  method: string;
  url: string;
  body: unknown;
}

function harness(responseBody: unknown) {
  const seen: Seen[] = [];

  const stub = HttpClient.make((request) => {
    const raw = (request.body as { body?: Uint8Array }).body;
    seen.push({
      method: request.method,
      url: request.url,
      body: raw ? JSON.parse(new TextDecoder().decode(raw)) : undefined,
    });
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

describe("updateFile", () => {
  it("PATCHes the file endpoint with the supplied fields", async () => {
    const { seen, layer } = harness({ data: { id: "file-1", name: "renamed.txt" } });

    await run(layer, (api) =>
      api.updateFile(FileId.make("file-1"), { name: "renamed.txt", tags: ["a"] }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("PATCH");
    expect(seen[0]?.url).toBe("https://api.example.test/api/v1/files/file-1");
    expect(seen[0]?.body).toEqual({ name: "renamed.txt", tags: ["a"] });
  });

  it("sends null through so the server clears the field", async () => {
    const { seen, layer } = harness({ data: { id: "file-1" } });

    await run(layer, (api) => api.updateFile(FileId.make("file-1"), { description: null }));

    expect(seen[0]?.body).toEqual({ description: null });
  });
});

describe("bucket metadata", () => {
  it("GETs the bucket metadata endpoint", async () => {
    const { seen, layer } = harness({ data: { description: "team assets", tags: ["shared"] } });

    const result = await run(layer, (api) => api.getBucketMetadata(BucketId.make("bucket-1")));

    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.url).toBe("https://api.example.test/api/v1/buckets/bucket-1/metadata");
    expect(result).toEqual({ data: { description: "team assets", tags: ["shared"] } });
  });

  it("PATCHes the bucket metadata endpoint", async () => {
    const { seen, layer } = harness({ data: { description: "updated", tags: [] } });

    await run(layer, (api) =>
      api.updateBucketMetadata(BucketId.make("bucket-1"), { description: "updated" }),
    );

    expect(seen[0]?.method).toBe("PATCH");
    expect(seen[0]?.url).toBe("https://api.example.test/api/v1/buckets/bucket-1/metadata");
    expect(seen[0]?.body).toEqual({ description: "updated" });
  });
});
