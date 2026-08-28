import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { ConsoleConfigTag } from "../src/config";
import type { ApiKeyStatusResponse, CreateApiKeyResponse } from "../src/console/ConsoleApiClient";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleApiError } from "../src/console/errors";

/**
 * PR #39 code review (docs/pr-39-code-review.md, section 3) — `createApiKey`
 * and `getApiKeyStatus` used to `(yield* res.json) as X` with no runtime
 * validation. `mintedCredentialStore.ts` grew a `typeof keyId !== "string"`
 * guard purely to defend against the first cast, and `KeyAdminService.ts`'s
 * own comment named the second as a defect ("die") source. These tests pin
 * that a malformed 2xx body now fails as a typed `ConsoleApiError` — never a
 * thrown TypeError — at the parse boundary itself.
 */

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function harness(
  responseBody: unknown,
  status = 200,
  opts: { apiKey?: string; adminKey?: string } = {},
) {
  const seen: Seen[] = [];

  const stub = HttpClient.make((request) => {
    const raw = (request.body as { body?: Uint8Array }).body;
    seen.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body: raw ? JSON.parse(new TextDecoder().decode(raw)) : undefined,
    });
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(responseBody), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  const layer = ConsoleApiClient.Default.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(ConsoleConfigTag, {
          apiKey: Redacted.make(opts.apiKey ?? "hbr_test_key"),
          servicePrivateKey: Redacted.make(""),
          adminKey: Redacted.make(opts.adminKey ?? "hbradm_test_key"),
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

/**
 * Like `harness`, but publishes `rawBody` VERBATIM as the response body,
 * instead of running it through `JSON.stringify` first — needed to simulate a
 * 201 whose body is not valid JSON at all (a proxy injecting an HTML error
 * page, a truncated connection). `harness`'s `JSON.stringify(responseBody)`
 * can only ever produce well-formed JSON (even a raw string argument comes
 * out JSON-quoted), so it cannot reach the `res.json` decode-failure path —
 * only the schema-mismatch path after a successful decode.
 */
function rawBodyHarness(rawBody: string, status: number) {
  const stub = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(rawBody, { status, headers: { "content-type": "application/json" } }),
      ),
    ),
  );

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

  return { layer };
}

const run = <A>(
  layer: Layer.Layer<ConsoleApiClient>,
  f: (api: typeof ConsoleApiClient.Service) => Effect.Effect<A, unknown>,
) => Effect.runPromise(ConsoleApiClient.pipe(Effect.flatMap(f), Effect.provide(layer)) as never);

const runFail = <A>(
  layer: Layer.Layer<ConsoleApiClient>,
  f: (api: typeof ConsoleApiClient.Service) => Effect.Effect<A, unknown>,
) =>
  Effect.runPromise(
    ConsoleApiClient.pipe(Effect.flatMap(f), Effect.provide(layer), Effect.flip) as never,
  );

const KEY_ID = "11111111-1111-1111-1111-111111111111";
const GROUP_ID = `0x${"b".repeat(64)}`;

describe("createApiKey", () => {
  it("accepts a realistic, well-formed 201 body", async () => {
    const { layer } = harness(
      {
        id: KEY_ID,
        name: "mcp-mint-abc123def456",
        key: "hbr_abcdefghijklmnopqrstuvwxyz",
        space_id: "sp_1",
        permissions: "read_write",
        service_signer_address: `0x${"a".repeat(64)}`,
        status: "registering",
        expected_permission: "BucketEditor",
        private_buckets: [{ bucket_id: "bucket_1", group_id: GROUP_ID }],
        created_at: "2026-08-26T00:00:00.000Z",
      },
      201,
    );

    const result = (await run(layer, (api) =>
      api.createApiKey({ permissions: "read_write", serviceSignerAddress: `0x${"a".repeat(64)}` }),
    )) as CreateApiKeyResponse;

    expect(result.id).toBe(KEY_ID);
    expect(result.key).toBe("hbr_abcdefghijklmnopqrstuvwxyz");
    expect(result.space_id).toBe("sp_1");
    expect(result.permissions).toBe("read_write");
    expect(result.status).toBe("registering");
    expect(result.private_buckets).toEqual([{ bucket_id: "bucket_1", group_id: GROUP_ID }]);
  });

  it("fails with a typed ConsoleApiError, not a thrown defect, on a malformed 201 body", async () => {
    const { layer } = harness(
      {
        // `id` is missing — the field mintedCredentialStore.ts's
        // `typeof keyId !== "string"` guard exists to defend against, until
        // Task 3 removes it now that this validates upstream.
        key: "hbr_abcdefghijklmnopqrstuvwxyz",
        space_id: "sp_1",
        permissions: "read_write",
        status: "registering",
        private_buckets: [],
      },
      201,
    );

    const error = await runFail(layer, (api) =>
      api.createApiKey({ permissions: "read_write", serviceSignerAddress: `0x${"a".repeat(64)}` }),
    );

    expect(error).toBeInstanceOf(ConsoleApiError);
    const apiError = error as ConsoleApiError;
    expect(apiError.code).toBe("invalid_response_shape");
    // `id:` (the zodIssues() "path: message" format), not just "id" — the
    // word "validation" earlier in the message also contains "id" as a
    // substring, which would make a bare `toContain("id")` pass vacuously.
    expect(apiError.message).toContain("id:");
  });

  /**
   * M1 (round-3 review) — the `stage: "mint"` protection (F1(a)) only covered
   * a body that PARSES as JSON but fails schema validation. `res.json` itself
   * runs BEFORE `safeParse` and can fail on its own — a proxy injecting an
   * HTML error page, a truncated connection — as an `@effect/platform`
   * `ResponseError`, NOT a `ConsoleApiError`. Uncaught, that would ride the
   * error channel straight past `KeyAdminService`'s `catchIf` (which only
   * matches `ConsoleApiError`), reaching the MCP caller as `isError: true`
   * with no marker and no "do NOT retry" guidance — precisely the outcome
   * `stage: "mint"` exists to prevent, just reached through the OTHER way a
   * 201's body can be unusable. This pins that `createApiKey` converts a
   * decode failure into the SAME `ConsoleApiError` shape
   * (`code: "invalid_response_shape"`, `status: 201`) the schema-mismatch
   * path above produces — the exact shape `KeyAdminService`'s `catchIf`
   * predicate matches on (see its own "resolves to stage:'mint'..." test,
   * which pins the OTHER half of this chain: that shape converts to a
   * `stage: "mint"` outcome carrying the marker, never `isError`).
   */
  it("fails with a typed ConsoleApiError (never a raw ResponseError) on a 201 whose body is not valid JSON at all", async () => {
    const { layer } = rawBodyHarness("<html><body>502 Bad Gateway</body></html>", 201);

    const error = await runFail(layer, (api) =>
      api.createApiKey({ permissions: "read_write", serviceSignerAddress: `0x${"a".repeat(64)}` }),
    );

    expect(error).toBeInstanceOf(ConsoleApiError);
    const apiError = error as ConsoleApiError;
    expect(apiError.code).toBe("invalid_response_shape");
    // The same `status: 201` `KeyAdminService`'s predicate pins on to tell
    // this apart from a genuine non-2xx rejection.
    expect(apiError.status).toBe(201);
    expect(apiError.message).toContain("not be used");
  });

  /**
   * F1(b) (code-review pass on Tasks 1-3 together) — only `id`/`key`/`space_id`
   * are load-bearing enough to reject a 201 over. `status` only seeds a poll
   * loop's initial value — a server-side enum widening must not fail an
   * otherwise-successful mint.
   *
   * Superseded by the final review round: `private_buckets` defaulting to `[]`
   * on ANY absent/null/malformed input (round 2's fix) collapsed "Console said
   * zero buckets" and "Console didn't say" into the same value, which
   * `KeyAdminService.generateApiKey` then silently read as the former —
   * skipping bucket-access grants for a space that might actually need them,
   * with `ok: true` and no signal anything was skipped. A missing field now
   * parses to `null` ("unknown"), not `[]` ("Console said there are none") —
   * see `createApiKeyResponseSchema`'s doc comment and the
   * `"private-buckets-unknown"` stage this feeds in KeyAdminService.ts.
   */
  it("accepts a 201 that omits private_buckets, parsing it as null (unknown, not empty)", async () => {
    const { layer } = harness(
      {
        id: KEY_ID,
        key: "hbr_abcdefghijklmnopqrstuvwxyz",
        space_id: "sp_1",
        permissions: "read_write",
        status: "registering",
        // private_buckets omitted entirely.
      },
      201,
    );

    const result = (await run(layer, (api) =>
      api.createApiKey({ permissions: "read_write", serviceSignerAddress: `0x${"a".repeat(64)}` }),
    )) as CreateApiKeyResponse;

    expect(result.private_buckets).toBeNull();
  });

  it("accepts a 201 where private_buckets is a non-array value, parsing it as null", async () => {
    const { layer } = harness(
      {
        id: KEY_ID,
        key: "hbr_abcdefghijklmnopqrstuvwxyz",
        space_id: "sp_1",
        permissions: "read_write",
        status: "registering",
        private_buckets: "not-an-array", // wrong type, not just missing
      },
      201,
    );

    const result = (await run(layer, (api) =>
      api.createApiKey({ permissions: "read_write", serviceSignerAddress: `0x${"a".repeat(64)}` }),
    )) as CreateApiKeyResponse;

    expect(result.private_buckets).toBeNull();
  });

  /**
   * Coordinator correction, final review — an EARLIER version of this fix
   * dropped the malformed element and kept the valid sibling
   * (`[{bucket_1...}]`), on the theory that "a private_buckets array from
   * Console is always taken at its own word about being empty or non-empty."
   * The coordinator overruled that: a non-empty array is Console asserting
   * buckets EXIST, and granting only the elements that happened to parse
   * would silently under-grant — the caller gets a key with real access to
   * some buckets and none to the rest, with nothing saying so. A single
   * unparseable element now makes the WHOLE array untrustworthy (`null`,
   * "unknown"), not just that one element — see this file's
   * "malformed elements" test below for the fully-parsed case still working.
   */
  it("treats a private_buckets array with even one malformed element as entirely unknown (null), not a filtered list", async () => {
    const { layer } = harness(
      {
        id: KEY_ID,
        key: "hbr_abcdefghijklmnopqrstuvwxyz",
        space_id: "sp_1",
        permissions: "read_write",
        status: "registering",
        private_buckets: [
          { bucket_id: "bucket_1", group_id: GROUP_ID },
          { bucket_id: "bucket_2" }, // missing group_id — malformed element
          { not: "a bucket grant at all" },
        ],
      },
      201,
    );

    const result = (await run(layer, (api) =>
      api.createApiKey({ permissions: "read_write", serviceSignerAddress: `0x${"a".repeat(64)}` }),
    )) as CreateApiKeyResponse;

    expect(result.private_buckets).toBeNull();
  });

  it("accepts a private_buckets array only when EVERY element parses", async () => {
    const GROUP_ID_2 = `0x${"c".repeat(64)}`;
    const { layer } = harness(
      {
        id: KEY_ID,
        key: "hbr_abcdefghijklmnopqrstuvwxyz",
        space_id: "sp_1",
        permissions: "read_write",
        status: "registering",
        private_buckets: [
          { bucket_id: "bucket_1", group_id: GROUP_ID },
          { bucket_id: "bucket_2", group_id: GROUP_ID_2 },
        ],
      },
      201,
    );

    const result = (await run(layer, (api) =>
      api.createApiKey({ permissions: "read_write", serviceSignerAddress: `0x${"a".repeat(64)}` }),
    )) as CreateApiKeyResponse;

    expect(result.private_buckets).toEqual([
      { bucket_id: "bucket_1", group_id: GROUP_ID },
      { bucket_id: "bucket_2", group_id: GROUP_ID_2 },
    ]);
  });

  it("accepts a status value outside today's known enum", async () => {
    const { layer } = harness(
      {
        id: KEY_ID,
        key: "hbr_abcdefghijklmnopqrstuvwxyz",
        space_id: "sp_1",
        permissions: "read_write",
        status: "some_future_status_console_added_later",
        private_buckets: [],
      },
      201,
    );

    const result = (await run(layer, (api) =>
      api.createApiKey({ permissions: "read_write", serviceSignerAddress: `0x${"a".repeat(64)}` }),
    )) as CreateApiKeyResponse;

    expect(result.status).toBe("some_future_status_console_added_later");
  });

  /**
   * R1 (round-2 review) — the `.nullish()` fix applied to
   * `registration_progress` (F3) was applied inconsistently: `private_buckets`
   * only tolerated a MISSING key, not an explicit JSON `null`, even though the
   * same "JSON APIs routinely serialize an absent optional as null" reasoning
   * applies identically here. A 201 must not be discarded just because
   * `private_buckets` came back as an explicit `null` rather than an omitted
   * key.
   *
   * Superseded by the final review round in the same way as the "omits
   * private_buckets" test above: an explicit `null` now parses to `null`
   * ("unknown"), not `[]` ("Console said zero buckets") — the two are NOT
   * interchangeable to `KeyAdminService.generateApiKey` (see its
   * `"private-buckets-unknown"` stage).
   */
  it("accepts a 201 with private_buckets: null, parsing it as null (unknown, not empty)", async () => {
    const { layer } = harness(
      {
        id: KEY_ID,
        key: "hbr_abcdefghijklmnopqrstuvwxyz",
        space_id: "sp_1",
        permissions: "read_write",
        status: "registering",
        private_buckets: null,
      },
      201,
    );

    const result = (await run(layer, (api) =>
      api.createApiKey({ permissions: "read_write", serviceSignerAddress: `0x${"a".repeat(64)}` }),
    )) as CreateApiKeyResponse;

    expect(result.private_buckets).toBeNull();
  });

  it("accepts a 201 with private_buckets: [], parsing it as an empty array (known, not unknown)", async () => {
    const { layer } = harness(
      {
        id: KEY_ID,
        key: "hbr_abcdefghijklmnopqrstuvwxyz",
        space_id: "sp_1",
        permissions: "read_write",
        status: "registering",
        private_buckets: [],
      },
      201,
    );

    const result = (await run(layer, (api) =>
      api.createApiKey({ permissions: "read_write", serviceSignerAddress: `0x${"a".repeat(64)}` }),
    )) as CreateApiKeyResponse;

    // An explicit [] is Console SAYING there are no private buckets — must
    // stay a real (non-null) empty array, distinct from the null cases above.
    expect(result.private_buckets).not.toBeNull();
    expect(result.private_buckets).toEqual([]);
  });

  /**
   * The final whole-branch review — `permissions` staying `z.enum(["read_only",
   * "read_write"])` meant a third permission tier, or any case/format change,
   * failed the WHOLE 201 body even though id/key/space_id arrived perfectly
   * valid, discarding the one-time secrets over a field that is pure
   * pass-through display data (`GenerateApiKeyResult.permission`). `permissions`
   * now echoes Console's raw string; it must never fail the parse.
   */
  it("accepts a 201 with a permissions value outside today's known enum, echoing it raw", async () => {
    const { layer } = harness(
      {
        id: KEY_ID,
        key: "hbr_abcdefghijklmnopqrstuvwxyz",
        space_id: "sp_1",
        permissions: "some_future_tier_console_added_later",
        status: "registering",
        private_buckets: [],
      },
      201,
    );

    const result = (await run(layer, (api) =>
      api.createApiKey({ permissions: "read_write", serviceSignerAddress: `0x${"a".repeat(64)}` }),
    )) as CreateApiKeyResponse;

    expect(result.permissions).toBe("some_future_tier_console_added_later");
  });

  it("accepts a 201 where permissions is missing or the wrong type, without claiming a real tier", async () => {
    const { layer } = harness(
      {
        id: KEY_ID,
        key: "hbr_abcdefghijklmnopqrstuvwxyz",
        space_id: "sp_1",
        // permissions omitted entirely — also covers wrong-typed (e.g. a number),
        // since both fail the `typeof v === "string"` check the same way.
        status: "registering",
        private_buckets: [],
      },
      201,
    );

    const result = (await run(layer, (api) =>
      api.createApiKey({ permissions: "read_write", serviceSignerAddress: `0x${"a".repeat(64)}` }),
    )) as CreateApiKeyResponse;

    // Must NOT silently default to "read_only"/"read_write" — that would claim
    // a permission the key might not actually have.
    expect(result.permissions).not.toBe("read_only");
    expect(result.permissions).not.toBe("read_write");
    expect(result.permissions).toBe("(not reported by Console)");
  });

  /**
   * R1, secondary — `status` was still REQUIRED even after the enum-widening
   * fix, so a 201 that merely OMITS `status` orphaned the mint identically to
   * the bug the private_buckets fix above closes, despite `status` only
   * seeding `pollUntilActive`'s initial value. Defaults to `"registering"` —
   * a real Console value meaning "keep polling", the honest assumption when
   * the field isn't there to say otherwise.
   */
  it('accepts a 201 that omits status entirely, defaulting it to "registering"', async () => {
    const { layer } = harness(
      {
        id: KEY_ID,
        key: "hbr_abcdefghijklmnopqrstuvwxyz",
        space_id: "sp_1",
        permissions: "read_write",
        private_buckets: [],
        // status omitted entirely.
      },
      201,
    );

    const result = (await run(layer, (api) =>
      api.createApiKey({ permissions: "read_write", serviceSignerAddress: `0x${"a".repeat(64)}` }),
    )) as CreateApiKeyResponse;

    expect(result.status).toBe("registering");
  });

  it('accepts a 201 with status: null, defaulting it to "registering"', async () => {
    const { layer } = harness(
      {
        id: KEY_ID,
        key: "hbr_abcdefghijklmnopqrstuvwxyz",
        space_id: "sp_1",
        permissions: "read_write",
        status: null,
        private_buckets: [],
      },
      201,
    );

    const result = (await run(layer, (api) =>
      api.createApiKey({ permissions: "read_write", serviceSignerAddress: `0x${"a".repeat(64)}` }),
    )) as CreateApiKeyResponse;

    expect(result.status).toBe("registering");
  });

  it("still requires id/key/space_id — the load-bearing tier is unaffected by the loosening", async () => {
    // A 201 missing `key` genuinely cannot be used (there are no secrets to
    // persist), so this must still reject — the loosening above must not have
    // widened the schema so far that it swallows THIS case too.
    const { layer } = harness(
      {
        id: KEY_ID,
        space_id: "sp_1",
        permissions: "read_write",
        status: "registering",
        private_buckets: [],
        // key omitted.
      },
      201,
    );

    const error = await runFail(layer, (api) =>
      api.createApiKey({ permissions: "read_write", serviceSignerAddress: `0x${"a".repeat(64)}` }),
    );

    expect(error).toBeInstanceOf(ConsoleApiError);
    expect((error as ConsoleApiError).code).toBe("invalid_response_shape");
  });

  /**
   * L3 (round-3 review) — `z.string()` accepts the EMPTY string, which is
   * just as unusable as a missing field for the load-bearing tier: an
   * `id: ""` would otherwise pass validation, persist to
   * `minted-keys/<sha256 of "">.json`, render `incomplete()`'s recovery as
   * "The key  already exists in space " (naming nothing), and — worse — a
   * SECOND such response would hit the `exclusive` EEXIST at that same fixed
   * empty-string path and be misreported as a duplicate keyId, even though
   * that second key's secrets are genuinely gone. `.min(1)` routes this to
   * the same marker-based `stage: "mint"` recovery as a missing field.
   */
  it("rejects an empty id, not just a missing one", async () => {
    const { layer } = harness(
      {
        id: "", // present, but empty — must be treated the same as absent
        key: "hbr_abcdefghijklmnopqrstuvwxyz",
        space_id: "sp_1",
        permissions: "read_write",
        status: "registering",
        private_buckets: [],
      },
      201,
    );

    const error = await runFail(layer, (api) =>
      api.createApiKey({ permissions: "read_write", serviceSignerAddress: `0x${"a".repeat(64)}` }),
    );

    expect(error).toBeInstanceOf(ConsoleApiError);
    const apiError = error as ConsoleApiError;
    expect(apiError.code).toBe("invalid_response_shape");
    expect(apiError.status).toBe(201);
  });
});

describe("getApiKeyStatus", () => {
  it("accepts a realistic, well-formed 200 body", async () => {
    const { layer } = harness(
      {
        data: {
          id: KEY_ID,
          status: "registering",
          registration_progress: { granted: 1, total: 3 },
        },
      },
      200,
    );

    const result = (await run(layer, (api) => api.getApiKeyStatus(KEY_ID))) as ApiKeyStatusResponse;

    expect(result.data.status).toBe("registering");
    expect(result.data.registration_progress).toEqual({ granted: 1, total: 3 });
  });

  it("fails with a typed ConsoleApiError on a malformed 200 body, never reaching res.data.status", async () => {
    // `{ data: {} }` — no `status`. Before this change, `pollUntilActive`'s
    // `res.data.status` dereference on this shape would throw a TypeError
    // (a defect), not fail with a typed error. Status is 200 deliberately:
    // a non-2xx would hit `handleError` instead and prove nothing about the
    // Zod path.
    const { layer } = harness({ data: {} }, 200);

    const error = await runFail(layer, (api) => api.getApiKeyStatus(KEY_ID));

    expect(error).toBeInstanceOf(ConsoleApiError);
    const apiError = error as ConsoleApiError;
    expect(apiError.code).toBe("invalid_response_shape");
    // Pins the nested path-joining: the offending field is `data.status`.
    expect(apiError.message).toContain("data.status:");
  });

  /**
   * F3 (code-review pass on Tasks 1-3 together) — JSON APIs routinely
   * serialize an absent optional field as an explicit `null`, and the old
   * `as ApiKeyStatusResponse` cast tolerated it. `.optional()` alone rejects
   * `null` outright, which would fail every poll of a `registering` key with
   * no grants accrued yet — this pins the `.nullish()` fix.
   */
  it("accepts registration_progress: null", async () => {
    const { layer } = harness(
      { data: { id: KEY_ID, status: "registering", registration_progress: null } },
      200,
    );

    const result = (await run(layer, (api) => api.getApiKeyStatus(KEY_ID))) as ApiKeyStatusResponse;

    expect(result.data.status).toBe("registering");
    expect(result.data.registration_progress).toBeNull();
  });

  /**
   * R2 (round-2 review) — `data.status` was still a closed
   * `z.enum(["registering", "active", "revoking", "revoked"])`, applying the
   * strict-enum tradeoff `createApiKeyResponseSchema.status` was deliberately
   * loosened away from, for the exact same endpoint `pollUntilActive` polls
   * in a loop. A Console-added status this build has never seen must not
   * fail every poll of an otherwise-healthy, actively-registering mint.
   */
  it("accepts a status value outside today's known enum", async () => {
    const { layer } = harness(
      { data: { id: KEY_ID, status: "pending_future_status", registration_progress: null } },
      200,
    );

    const result = (await run(layer, (api) => api.getApiKeyStatus(KEY_ID))) as ApiKeyStatusResponse;

    expect(result.data.status).toBe("pending_future_status");
  });
});
