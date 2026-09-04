import { describe, expect, it } from "vitest";

import { SealAPIError } from "@mysten/seal";

import { interpretSealProxyFailure, resolveSealConfig } from "../src/console/seal-config";
import { formatToolError } from "../src/redaction";

/**
 * The committee object IDs are a trust boundary shared with the web app: encrypt against a
 * different one and the two apps stop being able to read each other's files. Pin the literals
 * so a rotation-by-accident shows up as a failing test rather than as undecryptable ciphertext.
 *
 * Source of truth: console `frontend/src/lib/seal/config.ts` (COMG-511).
 */
const TESTNET_COMMITTEE = "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98";
const MAINNET_COMMITTEE = "0x686098f1439237fff9f36b99c7329683c22979d2005c2465cb891acb012a7595";

const BASE_URL = "https://api.testnet.console.walrus.xyz";
const API_KEY = "hbrsk_test_key";

describe("resolveSealConfig", () => {
  it("pins the testnet committee as the single key server", () => {
    const { serverConfigs } = resolveSealConfig("testnet", BASE_URL, API_KEY);

    expect(serverConfigs).toHaveLength(1);
    expect(serverConfigs[0]?.objectId).toBe(TESTNET_COMMITTEE);
    expect(serverConfigs[0]?.weight).toBe(1);
  });

  it("pins the mainnet committee as the single key server", () => {
    const { serverConfigs } = resolveSealConfig("mainnet", BASE_URL, API_KEY);

    expect(serverConfigs).toHaveLength(1);
    expect(serverConfigs[0]?.objectId).toBe(MAINNET_COMMITTEE);
  });

  it("uses a different committee per network", () => {
    // Guards against a copy-paste that points both networks at the same object.
    expect(TESTNET_COMMITTEE).not.toBe(MAINNET_COMMITTEE);
  });

  it("derives a threshold of 1 from the single committee entry", () => {
    // Not the old 2-of-3: the m-of-n is enforced inside the committee now. Encrypting at 2
    // against one server would make every file permanently undecryptable.
    expect(resolveSealConfig("testnet", BASE_URL, API_KEY).threshold).toBe(1);
    expect(resolveSealConfig("mainnet", BASE_URL, API_KEY).threshold).toBe(1);
  });

  describe("aggregator endpoint", () => {
    it("points at the Console API's fetch_key proxy, not Seal's gateway", () => {
      const { serverConfigs } = resolveSealConfig("mainnet", BASE_URL, API_KEY);

      expect(serverConfigs[0]?.aggregatorUrl).toBe(
        "https://api.testnet.console.walrus.xyz/api/v1/seal/aggregator",
      );
      // The Enoki key lives server-side (COMG-580); the MCP must never reach Seal directly.
      expect(serverConfigs[0]?.aggregatorUrl).not.toContain("mystenlabs.com");
    });

    it("follows CONSOLE_API_BASE_URL rather than a per-network hostname", () => {
      // Same proxy path on every network — the API picks the upstream gateway itself.
      const testnet = resolveSealConfig("testnet", "https://api.console.walrus.xyz", API_KEY);
      const mainnet = resolveSealConfig("mainnet", "https://api.console.walrus.xyz", API_KEY);

      expect(testnet.serverConfigs[0]?.aggregatorUrl).toBe(
        "https://api.console.walrus.xyz/api/v1/seal/aggregator",
      );
      expect(mainnet.serverConfigs[0]?.aggregatorUrl).toBe(testnet.serverConfigs[0]?.aggregatorUrl);
    });

    it("supports a loopback base URL for local stacks", () => {
      const { serverConfigs } = resolveSealConfig("testnet", "http://localhost:3000", API_KEY);

      expect(serverConfigs[0]?.aggregatorUrl).toBe("http://localhost:3000/api/v1/seal/aggregator");
    });

    it("does not double the slash when the base URL carries a trailing one", () => {
      const { serverConfigs } = resolveSealConfig("testnet", `${BASE_URL}/`, API_KEY);

      expect(serverConfigs[0]?.aggregatorUrl).toBe(`${BASE_URL}/api/v1/seal/aggregator`);
    });
  });

  describe("proxy authentication", () => {
    it("sends the Console Bearer key, which is what the proxy authenticates", () => {
      const { serverConfigs } = resolveSealConfig("testnet", BASE_URL, API_KEY);

      expect(serverConfigs[0]?.apiKeyName).toBe("Authorization");
      expect(serverConfigs[0]?.apiKey).toBe(`Bearer ${API_KEY}`);
    });

    it("omits the header entirely when no API key is configured", () => {
      // Rather than sending a malformed `Bearer `: an unconfigured MCP should get a clean 401.
      const { serverConfigs } = resolveSealConfig("testnet", BASE_URL, "");

      expect(serverConfigs[0]).not.toHaveProperty("apiKeyName");
      expect(serverConfigs[0]).not.toHaveProperty("apiKey");
    });

    it("carries no Seal-specific credential of its own", () => {
      // The Enoki X-API-Key is the API's business now. If one ever reappears here, this fails.
      const serialized = JSON.stringify(resolveSealConfig("mainnet", BASE_URL, API_KEY));

      expect(serialized).not.toContain("X-API-Key");
    });
  });

  it("rejects a network with no committee", () => {
    expect(() =>
      // @ts-expect-error — exercising the runtime guard against an unsupported network.
      resolveSealConfig("devnet", BASE_URL, API_KEY),
    ).toThrow(/only testnet and mainnet/);
  });
});

/**
 * COMG-605 — proxy failure classification.
 *
 * Every case drives the REAL `SealAPIError.assertResponse` over a body the Console proxy
 * actually emits, rather than constructing a `SealAPIError` by hand. That distinction is the
 * whole point of these tests: hand-built instances can carry a `status`, but `assertResponse`
 * calls `#generate(error, message, requestId)` without one whenever the body parses as JSON,
 * so `status` is always `undefined` in production and any mapping keyed on it is dead code.
 */
describe("interpretSealProxyFailure", () => {
  /** Mirrors what the Console envelope middleware puts on a locally generated failure. */
  const consoleBody = (code: string) => ({
    error: "Something the console said",
    code,
    message: `console:${code}`,
  });

  const throwFrom = async (status: number, body: unknown): Promise<unknown> => {
    const res = new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
    try {
      await SealAPIError.assertResponse(res, "req-1");
    } catch (e) {
      return e;
    }
    // Outside the `try` deliberately: inside it, this throw is caught by the `catch`
    // above and returned as an ordinary Error, so a regression that stopped the SDK
    // throwing would leave the negative cases below passing green.
    throw new Error("assertResponse did not throw");
  };

  it("reports the SDK really does drop the status, which is why we match on the message", async () => {
    const err = (await throwFrom(503, consoleBody("not_configured"))) as SealAPIError;
    expect(err).toBeInstanceOf(SealAPIError);
    expect(err.status).toBeUndefined();
    expect(err.message).toBe("console:not_configured");
  });

  it.each([
    ["not_configured", 503, "disabled"],
    ["TooManyRequestsError", 429, "rate_limited"],
    ["upstream_error", 502, "unavailable"],
    ["upstream_unavailable", 503, "unavailable"],
    // `catchAllDefect` in harbor `routes/seal.ts` promotes every unexpected proxy defect
    // to `UnknownError`, which declares no `code` — so `respondWithProxyError`'s
    // `code: err.code ?? err._tag` puts the bare tag on the wire. This is the commonest
    // proxy-side 500, not an exotic one.
    ["UnknownError", 500, "unavailable"],
    // Synthesized only when the aggregator answers 401, which harbor's own comment
    // explains is always Kong rejecting the Console's Enoki key. Permanent, not transient.
    ["aggregator_auth_failed", 502, "misconfigured"],
    ["unauthorized", 401, "credential"],
    ["read_only_api_key", 403, "credential"],
    ["api_key_registering", 403, "credential"],
    ["mirror_missing_grant", 403, "credential"],
    ["sessionkey_address_mismatch", 400, "credential"],
    ["invalid_request", 400, "request"],
  ])("maps %s (%i) to condition %s", async (code, status, condition) => {
    const mapped = interpretSealProxyFailure(await throwFrom(status, consoleBody(code)));
    expect(mapped?._tag).toBe("SealProxyError");
    expect(mapped?.condition).toBe(condition);
    expect(mapped?.code).toBe(code);
  });

  it("keeps an unrecognised console code addressable instead of guessing a condition", async () => {
    const mapped = interpretSealProxyFailure(await throwFrom(418, consoleBody("brand_new_code")));
    expect(mapped?.condition).toBe("unknown");
    expect(mapped?.code).toBe("brand_new_code");
  });

  /**
   * The table is keyed by a string this MCP does not control. Looked up on a plain object
   * literal, a code that names an `Object.prototype` member resolves to the inherited value
   * instead of `undefined`, so the `?? "unknown"` fallback never fires — and because the
   * inherited value is a function, `JSON.stringify` drops it silently. Keep the lookup
   * own-key only (a `Map`, not an object literal).
   */
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"])(
    "falls back to unknown for %s, which names an Object.prototype member",
    async (code) => {
      const mapped = interpretSealProxyFailure(await throwFrom(500, consoleBody(code)));
      expect(mapped?.code).toBe(code);
      expect(mapped?.condition).toBe("unknown");
      // The stricter half: `toBe("unknown")` alone would also pass if a future literal
      // happened to inherit a falsy member and fall through the `??`. The contract is that
      // `condition` is always one of the declared strings.
      expect(typeof mapped?.condition).toBe("string");
    },
  );

  it("keeps condition on the wire at the tool boundary, not just in memory", async () => {
    // `describeError` (src/redaction.ts) JSON.stringifies any `_tag` error to build the
    // tool-boundary message — the COMG-602 contract that sibling fields survive so an agent
    // can tell a permanent failure from a transient one. A non-string `condition` vanishes
    // there without a trace, so assert against the real formatter rather than the object.
    const mapped = interpretSealProxyFailure(await throwFrom(500, consoleBody("constructor")));
    const rendered = formatToolError("download_file", mapped);

    expect(rendered).toContain('"condition":"unknown"');
    expect(rendered).toContain('"code":"constructor"');
  });

  it("leaves a Seal access denial alone so it keeps its own typed error", async () => {
    const denial = await throwFrom(403, { error: "NoAccess", message: "denied" });
    expect((denial as Error).constructor.name).toBe("NoAccessError");
    expect(interpretSealProxyFailure(denial)).toBeUndefined();
  });

  it("leaves a relayed key-server error alone", async () => {
    const relayed = await throwFrom(400, { error: "InvalidPTB", message: "bad ptb" });
    expect(interpretSealProxyFailure(relayed)).toBeUndefined();
  });

  it("finds the token one level down a cause chain", async () => {
    const inner = await throwFrom(503, consoleBody("not_configured"));
    const wrapped = new Error("decrypt failed", { cause: inner });
    expect(interpretSealProxyFailure(wrapped)?.condition).toBe("disabled");
  });

  it("ignores non-errors and unrelated failures", () => {
    expect(interpretSealProxyFailure(undefined)).toBeUndefined();
    expect(interpretSealProxyFailure("console:not_configured")).toBeUndefined();
    expect(interpretSealProxyFailure(new Error("ECONNREFUSED"))).toBeUndefined();
  });
});
