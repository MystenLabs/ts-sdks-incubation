import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { BucketId } from "../src/console/types";

/**
 * `GET /buckets/:id` sits behind Console's ACL-mirror grant check, so a bucket
 * created seconds ago answers 403 `mirror_missing_grant`. That is not an auth
 * failure — the key is fine, its grant just has not propagated — so `handleError`
 * must keep it a ConsoleApiError with its code (retryable), while every other
 * 401/403 still becomes a ConsoleAuthError (COMG-1007 review).
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

function layerAnswering(status: number, body: unknown) {
  const stub = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
  return ConsoleApiClient.Default.pipe(
    Layer.provideMerge(Layer.mergeAll(TestConfig, Layer.succeed(HttpClient.HttpClient, stub))),
  );
}

const lookupError = (status: number, body: unknown) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* ConsoleApiClient;
      return yield* api.getBucketById(BucketId.make("bucket-1"));
    }).pipe(Effect.provide(layerAnswering(status, body)), Effect.flip),
  );

describe("ConsoleApiClient — 403 mirror_missing_grant", () => {
  it("keeps a 403 mirror_missing_grant a ConsoleApiError with its code", async () => {
    const error = await lookupError(403, {
      error: "Service signer missing on-chain grant for this bucket.",
      code: "mirror_missing_grant",
    });
    expect(error).toMatchObject({
      _tag: "ConsoleApiError",
      code: "mirror_missing_grant",
      status: 403,
    });
  });

  it("still maps any other 403 to a ConsoleAuthError", async () => {
    const error = await lookupError(403, {
      error: "API key is not authorized for this bucket.",
      code: "bucket_not_in_scope",
    });
    expect((error as { _tag: string })._tag).toBe("ConsoleAuthError");
  });
});
