import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import type { BucketId } from "../src/console/types";
import { deleteBucketContents } from "../src/toolSchemas";

/**
 * COMG-1021 — a beta user lost a folder and the 8 files in it to one
 * `delete_bucket` call. `confirm=true` did not stop it because this client
 * hardcoded the flag into the URL, so Console's gate was satisfied here rather
 * than by the person. Both flags are parameters now, and `confirm`'s literal
 * type means the only value that compiles is the one the schema produced.
 */

interface Seen {
  url: string;
}

function harness(status = 204) {
  const seen: Seen[] = [];

  const stub = HttpClient.make((request) => {
    seen.push({ url: request.url });
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));
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

const BUCKET = "22222222-2222-2222-2222-222222222222" as BucketId;

describe("deleteBucket flags (COMG-1021)", () => {
  it("sends confirm alone when the caller did not ask for the contents", async () => {
    const { seen, layer } = harness();

    await run(layer, (api) => api.deleteBucket(BUCKET, { confirm: true, deleteContents: false }));

    expect(seen[0]?.url).toBe(`https://api.example.test/api/v1/buckets/${BUCKET}?confirm=true`);
    // The absence is the point: with it, Console cascades without ever telling
    // the user how much was in there.
    expect(seen[0]?.url).not.toContain("deleteContents");
  });

  it("adds deleteContents only when the caller asks for it", async () => {
    const { seen, layer } = harness();

    await run(layer, (api) => api.deleteBucket(BUCKET, { confirm: true, deleteContents: true }));

    expect(seen[0]?.url).toBe(
      `https://api.example.test/api/v1/buckets/${BUCKET}?confirm=true&deleteContents=true`,
    );
  });

  it("builds confirm from the argument rather than a literal in the URL", async () => {
    const { seen, layer } = harness();

    // A deliberate type-lie. The schema can only ever produce `true`, so this is
    // the only way to show the query string is derived from what the caller
    // passed instead of written here, which is what let the folder go in the
    // first place.
    await run(layer, (api) =>
      api.deleteBucket(BUCKET, { confirm: false as unknown as true, deleteContents: false }),
    );

    expect(seen[0]?.url).toBe(`https://api.example.test/api/v1/buckets/${BUCKET}?confirm=false`);
  });

  // The guarantee is the signature, not a runtime branch: no value of `confirm`
  // other than the schema's literal `true` compiles. Hardcode the flag back into
  // the URL and drop the parameter, and this expect-error goes unused, which
  // fails typecheck.
  it("will not compile a call that omits confirm", () => {
    type DeleteBucketOpts = Parameters<(typeof ConsoleApiClient.Service)["deleteBucket"]>[1];

    // @ts-expect-error `confirm` is required.
    const withoutConfirm: DeleteBucketOpts = { deleteContents: false };
    const withConfirm: DeleteBucketOpts = { confirm: true, deleteContents: false };

    expect(withoutConfirm.deleteContents).toBe(false);
    expect(withConfirm.confirm).toBe(true);
  });
});

describe("deleteBucketContents schema", () => {
  // Optional on purpose: omitting it is the normal first call, and the refusal
  // it earns from Console is what surfaces the file count to the user.
  it("accepts an omitted value", () => {
    expect(deleteBucketContents.safeParse(undefined).success).toBe(true);
  });

  // `false` must not be a way to say yes, and must not be silently accepted as
  // a distinct third state the client then has to interpret.
  it("refuses false and every non-true value", () => {
    for (const bad of [false, "true", 1, null]) {
      expect(deleteBucketContents.safeParse(bad).success).toBe(false);
    }
  });

  it("accepts exactly true", () => {
    expect(deleteBucketContents.safeParse(true).success).toBe(true);
  });
});
