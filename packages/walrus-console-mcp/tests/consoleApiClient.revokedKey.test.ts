import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { displayKeyPrefix } from "../src/console/revokedKey";
import type { BucketId, FileId } from "../src/console/types";
import { formatToolError } from "../src/redaction";

/**
 * A key rotated or revoked in Console answers 401 with one of three codes, and
 * each needs a different fix. None may surface as a bare authentication error:
 * the message names the key by prefix, says what happened and names the remedy.
 */

const API_KEY = "hbr_ab12cd34secretsecretsecretsecretxx";
const ADMIN_KEY = "hbradm_ef56gh78secretsecretsecretsecretx";
const TESTNET_INTEGRATIONS = "https://testnet.console.walrus.xyz/integrations";

const TestConfig = Layer.succeed(ConsoleConfigTag, {
  apiKey: Redacted.make(API_KEY),
  servicePrivateKey: Redacted.make(""),
  adminKey: Redacted.make(ADMIN_KEY),
  adminServicePrivateKey: Redacted.make(""),
  baseUrl: "https://api.testnet.console.walrus.xyz",
  webAccountAddress: "",
  keyAdminAddress: "",
});

const layerAnswering401 = (code: string) =>
  ConsoleApiClient.Default.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        TestConfig,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify({ error: "API key has been revoked.", code }), {
                  status: 401,
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );

const failWith = <A, E>(code: string, run: (api: ConsoleApiClient) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* ConsoleApiClient;
      return yield* run(api);
    }).pipe(Effect.provide(layerAnswering401(code)), Effect.flip),
  );

const listSpacesError = (code: string) => failWith(code, (api) => api.listSpaces());

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConsoleApiClient: revoked-key 401s", () => {
  it("tells a plain Revoke to create a new key", async () => {
    const error = await listSpacesError("api_key_revoked");

    expect(error).toMatchObject({ _tag: "ConsoleAuthError", code: "api_key_revoked" });
    const { message } = error as { message: string };
    expect(message).toContain("hbr_ab12cd34…");
    expect(message).toContain("was revoked and will not work again");
    expect(message).toContain(
      `Create a new key in Console → Integrations (${TESTNET_INTEGRATIONS})`,
    );
  });

  it("tells an unfinished rotation to finish it or create a new key", async () => {
    const error = await listSpacesError("api_key_rotation_incomplete");

    expect(error).toMatchObject({
      _tag: "ConsoleAuthError",
      code: "api_key_rotation_incomplete",
    });
    const { message } = error as { message: string };
    expect(message).toContain("hbr_ab12cd34…");
    expect(message).toContain("a key rotation that has not finished");
    expect(message).toContain(`In Console → Integrations (${TESTNET_INTEGRATIONS})`);
    expect(message).toContain("finish the rotation if Console offers it, or create a new key");
  });

  it("tells a replaced key to install the rotation's credential bundle", async () => {
    const error = await listSpacesError("api_key_replaced");

    expect(error).toMatchObject({ _tag: "ConsoleAuthError", code: "api_key_replaced" });
    const { message } = error as { message: string };
    expect(message).toContain("hbr_ab12cd34…");
    expect(message).toContain("replaced by a key rotation");
    expect(message).toContain("credential bundle Console showed when that rotation finished");
    expect(message).toContain(
      `create a new key in Console → Integrations (${TESTNET_INTEGRATIONS})`,
    );
    // Only a Management API key's rotation changes the Key-Admin address.
    expect(message).not.toContain("Key-Admin");
  });

  it("gives each state a different message", async () => {
    const messages = await Promise.all(
      ["api_key_revoked", "api_key_rotation_incomplete", "api_key_replaced"].map(
        async (code) => ((await listSpacesError(code)) as { message: string }).message,
      ),
    );
    expect(new Set(messages).size).toBe(3);
  });

  it("names the Key-Admin credential when that is the key refused", async () => {
    const error = await failWith("api_key_replaced", (api) => api.getApiKeyStatus("key-1"));

    const { message } = error as { message: string };
    expect(message).toContain("hbradm_ef56gh78…");
    expect(message).not.toContain("hbr_ab12cd34");
    expect(message).toContain("new Key-Admin address, and the bundle carries it");
  });

  it("never prints the rest of the secret at the tool boundary", async () => {
    const error = await listSpacesError("api_key_revoked");

    const text = formatToolError("list_spaces", error);
    expect(text).toContain("was revoked");
    expect(text).not.toContain(API_KEY.slice(12));
  });

  it("keeps any other 401 on the generic invalid_api_key code", async () => {
    const error = await listSpacesError("unauthorized");

    expect(error).toMatchObject({ _tag: "ConsoleAuthError", code: "invalid_api_key" });
  });

  it("gives a download the same readable message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "revoked", code: "api_key_rotation_incomplete" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const error = await failWith("unused", (api) =>
      api.downloadBucketFile("bucket-1" as BucketId, "file-1" as FileId),
    );

    expect(error).toMatchObject({ code: "api_key_rotation_incomplete", status: 401 });
    expect((error as { message: string }).message).toContain(
      "a key rotation that has not finished",
    );
  });
});

// The upload path posts multipart through the raw `fetch`, not the Effect HTTP client, so
// it has its own 401 branch. These mock `fetch` itself, the only way that branch runs.
describe("ConsoleApiClient: revoked-key 401s on upload", () => {
  const uploadError = async (code: string) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "revoked", code }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    return failWith("unused", (api) =>
      api.uploadBucketFile(
        "bucket-1" as BucketId,
        new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
        "notes.txt",
      ),
    );
  };

  it.each([
    ["api_key_revoked", "was revoked and will not work again"],
    ["api_key_rotation_incomplete", "a key rotation that has not finished"],
    ["api_key_replaced", "replaced by a key rotation"],
  ])("gives an upload refused with %s the readable message", async (code, text) => {
    const error = await uploadError(code);

    expect(error).toMatchObject({ code, status: 401 });
    const { message } = error as { message: string };
    expect(message).toContain("hbr_ab12cd34…");
    expect(message).toContain(text);
    expect(message).not.toContain(API_KEY.slice(12));
  });
});

describe("displayKeyPrefix", () => {
  it("shows the visible prefix of either key kind, and nothing for an unknown shape", () => {
    expect(displayKeyPrefix(API_KEY)).toBe("hbr_ab12cd34…");
    expect(displayKeyPrefix(ADMIN_KEY)).toBe("hbradm_ef56gh78…");
    expect(displayKeyPrefix("not-a-key")).toBe("the configured API key");
  });
});
