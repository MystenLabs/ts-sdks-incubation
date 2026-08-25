import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { ConsoleConfigTag } from "../src/config";
import type { CreateBucketReserveResponse } from "../src/console/ConsoleApiClient";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleApiError } from "../src/console/errors";
import { SpaceId } from "../src/console/types";

/**
 * COMG-761 — the create-bucket reserve now carries an owner cross-check
 * (`expectedOwnerAddress`) and an authored roster (`members`) the server
 * validates verbatim, plus a new read (`listSpaceSigners`) that supplies
 * roster candidates for a later task. This pins the wire shape:
 *
 *   - `members` is ALWAYS sent, `[]` included — the method signature makes it
 *     mandatory so a caller cannot silently omit it and fall back to the
 *     server-derived roster our validator refuses.
 *   - `expectedOwnerAddress` and every member address are normalized
 *     (`normalizeSuiAddress`) before they leave the client.
 *   - 409 `bucket_create_owner_mismatch` and 400
 *     `bucket_create_authored_members_invalid` surface `code` + `status` on
 *     `ConsoleApiError`.
 *   - `listSpaceSigners` uses the WORKING-key lane (`authed`), not admin — a
 *     worker host holds no admin credential at all.
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
          adminKey: Redacted.make(opts.adminKey ?? ""),
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

const runFail = <A>(
  layer: Layer.Layer<ConsoleApiClient>,
  f: (api: typeof ConsoleApiClient.Service) => Effect.Effect<A, unknown>,
) =>
  Effect.runPromise(
    ConsoleApiClient.pipe(Effect.flatMap(f), Effect.provide(layer), Effect.flip) as never,
  );

const OWNER = `0x${"a".repeat(64)}`;
const OWNER_MIXED_NO_PREFIX = "A".repeat(64); // mixed-case, no 0x — must normalize the same
const MEMBER = `0x${"b".repeat(64)}`;
const MEMBER_MIXED = `0x${"B".repeat(64)}`;

describe("createBucket", () => {
  it("always sends members, including an explicit empty roster", async () => {
    const { seen, layer } = harness(
      { bucket_id: "bucket-1", bytes: "AAAA", digest: "0xdigest", state: "pending_policy" },
      201,
    );

    await run(layer, (api) => api.createBucket(SpaceId.make("space-1"), "notes", OWNER, []));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("https://api.example.test/api/v1/spaces/space-1/buckets");
    expect(seen[0]?.body).toEqual({
      name: "notes",
      scope: "private",
      expectedOwnerAddress: OWNER,
      members: [],
    });
  });

  it("carries an authored roster and normalizes every address at the boundary", async () => {
    const { seen, layer } = harness(
      { bucket_id: "bucket-1", bytes: "AAAA", digest: "0xdigest", state: "pending_policy" },
      201,
    );

    await run(layer, (api) =>
      api.createBucket(SpaceId.make("space-1"), "notes", OWNER_MIXED_NO_PREFIX, [
        { address: MEMBER_MIXED, role: "editor" },
      ]),
    );

    expect(seen[0]?.body).toEqual({
      name: "notes",
      scope: "private",
      expectedOwnerAddress: OWNER,
      members: [{ address: MEMBER, role: "editor" }],
    });
  });

  it("parses the owner_address / admin_signer_address echo fields when present", async () => {
    const { layer } = harness(
      {
        bucket_id: "bucket-1",
        bytes: "AAAA",
        digest: "0xdigest",
        state: "pending_policy",
        owner_address: OWNER,
        admin_signer_address: null,
      },
      201,
    );

    const result = (await run(layer, (api) =>
      api.createBucket(SpaceId.make("space-1"), "notes", OWNER, []),
    )) as CreateBucketReserveResponse;

    expect(result.owner_address).toBe(OWNER);
    expect(result.admin_signer_address).toBeNull();
  });

  it("leaves the echo fields undefined when the response omits them", async () => {
    const { layer } = harness(
      { bucket_id: "bucket-1", bytes: "AAAA", digest: "0xdigest", state: "pending_policy" },
      201,
    );

    const result = (await run(layer, (api) =>
      api.createBucket(SpaceId.make("space-1"), "notes", OWNER, []),
    )) as CreateBucketReserveResponse;

    expect(result.owner_address).toBeUndefined();
    expect(result.admin_signer_address).toBeUndefined();
  });

  it("surfaces a 409 owner mismatch with code and status on ConsoleApiError", async () => {
    const { layer } = harness(
      { error: "owner mismatch", code: "bucket_create_owner_mismatch" },
      409,
    );

    const error = await runFail(layer, (api) =>
      api.createBucket(SpaceId.make("space-1"), "notes", OWNER, []),
    );

    expect(error).toBeInstanceOf(ConsoleApiError);
    const apiError = error as ConsoleApiError;
    expect(apiError.code).toBe("bucket_create_owner_mismatch");
    expect(apiError.status).toBe(409);
  });

  it("surfaces a 400 authored-members-invalid with code and status on ConsoleApiError", async () => {
    const { layer } = harness(
      { error: "member is not an active signer", code: "bucket_create_authored_members_invalid" },
      400,
    );

    const error = await runFail(layer, (api) =>
      api.createBucket(SpaceId.make("space-1"), "notes", OWNER, [
        { address: MEMBER, role: "viewer" },
      ]),
    );

    expect(error).toBeInstanceOf(ConsoleApiError);
    const apiError = error as ConsoleApiError;
    expect(apiError.code).toBe("bucket_create_authored_members_invalid");
    expect(apiError.status).toBe(400);
  });
});

describe("listSpaceSigners", () => {
  it("GETs the space-signers endpoint on the working-key lane, not admin", async () => {
    const { seen, layer } = harness(
      {
        signers: [
          {
            api_key_id: "11111111-1111-1111-1111-111111111111",
            service_signer_address: MEMBER,
            scope: "readwrite",
          },
        ],
      },
      200,
      { apiKey: "hbr_working_key", adminKey: "hbradm_admin_key" },
    );

    const result = await run(layer, (api) => api.listSpaceSigners());

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.url).toBe("https://api.example.test/api/v1/api-keys/space-signers");
    // The working-key Bearer, never the admin credential: this is the exact
    // lane a WORKING-key-only worker host can call.
    expect(seen[0]?.headers["authorization"]).toBe("Bearer hbr_working_key");
    expect(result).toEqual({
      signers: [
        {
          api_key_id: "11111111-1111-1111-1111-111111111111",
          service_signer_address: MEMBER,
          scope: "readwrite",
        },
      ],
    });
  });
});
