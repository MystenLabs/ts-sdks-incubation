import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";

// Stub HttpClient returning a canned snake_case usage envelope, mirroring what
// the deployed GET /api/v1/usage produces after response serialization.
const stubHttp = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(
        JSON.stringify({
          data: {
            storage_used: 2147483648,
            storage_cap: 10737418240,
            available: 8589934592,
            percent_used: 0.2,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  ),
);

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
  Layer.provideMerge(Layer.mergeAll(TestConfig, Layer.succeed(HttpClient.HttpClient, stubHttp))),
);

// Stub returning 401 to exercise the auth-error path (handleError → ConsoleAuthError).
const stubHttp401 = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify({ error: "invalid api key" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    ),
  ),
);

const TestLayer401 = ConsoleApiClient.Default.pipe(
  Layer.provideMerge(Layer.mergeAll(TestConfig, Layer.succeed(HttpClient.HttpClient, stubHttp401))),
);

describe("ConsoleApiClient.getStorageUsage", () => {
  it("returns the unwrapped storage usage data", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* ConsoleApiClient;
        return yield* api.getStorageUsage();
      }).pipe(Effect.provide(TestLayer)),
    );
    expect(result).toEqual({
      storage_used: 2147483648,
      storage_cap: 10737418240,
      available: 8589934592,
      percent_used: 0.2,
    });
  });

  it("maps a 401 response to a ConsoleAuthError", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* ConsoleApiClient;
        return yield* api.getStorageUsage();
      }).pipe(Effect.provide(TestLayer401), Effect.flip),
    );
    expect((error as { _tag: string })._tag).toBe("ConsoleAuthError");
  });

  it("bounds an oversized error body on the HttpClient path (F9)", async () => {
    // `res.json` would buffer the whole thing; handleError reads the stream up to
    // a cap and cancels the rest, so an endless error body cannot exhaust memory.
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
    const stub500 = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    const layer = ConsoleApiClient.Default.pipe(
      Layer.provideMerge(Layer.mergeAll(TestConfig, Layer.succeed(HttpClient.HttpClient, stub500))),
    );

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* ConsoleApiClient;
        return yield* api.getStorageUsage();
      }).pipe(Effect.provide(layer), Effect.flip),
    );

    // 500 (not 401/403) → ConsoleApiError, with a bounded message.
    expect((error as { _tag: string })._tag).toBe("ConsoleApiError");
    expect((error as { message: string }).message.length).toBeLessThan(70_000);
    // The read stopped near the cap rather than draining the endless stream.
    expect(pulls).toBeLessThan(200);
    expect(cancelled).toBe(true);
  });
});
