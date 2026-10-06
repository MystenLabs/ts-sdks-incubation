import { HttpClient } from "@effect/platform";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpLayer } from "../src/runtime.js";

// security review, minor: `HttpLayer` (installed into every service via
// `runtime.ts`'s `BaseLayer`) is the ONLY thing standing between an
// `HttpClient`-based API call and a redirect this client must not follow —
// `fetchWithRedirectGuard` itself already has thorough direct-call coverage
// in tests/safeFetch.test.ts, but nothing proved the WIRING actually routes
// `HttpClient` traffic through it rather than the real `globalThis.fetch`.
// These tests run a real `HttpClient.HttpClient` effect through `HttpLayer`,
// the same layer the whole server provides, with `globalThis.fetch` stubbed
// so no real network call is ever made.

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const getThrough = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url);
  }).pipe(Effect.provide(HttpLayer), Effect.runPromise);

describe("HttpLayer (runtime.ts wiring)", () => {
  it("still succeeds for a normal, non-redirected request", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await getThrough("https://api.walrus.xyz/x");

    expect(response.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  // The wiring question, not the guard's own logic (already covered directly):
  // does an `HttpClient`-based call actually go through `fetchWithRedirectGuard`
  // at all, or does it fall back to the real `fetch` because the override was
  // never reached? A redirect to a disallowed host proves it either way — this
  // fails closed only if the guard actually ran.
  it("refuses a redirect to a disallowed host, without ever requesting it", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    );

    await expect(getThrough("https://api.walrus.xyz/x")).rejects.toThrow();
    // The whole point: the attacker-chosen host is never actually requested.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
