import { Effect, Layer, Redacted } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Captures what `SuiGrpcClient` was constructed with. `vi.hoisted` because
 * `vi.mock` factories are lifted above the imports below, so a plain `const`
 * would still be in its temporal dead zone when the factory runs.
 */
const { grpcConstructorOptions, sealConstructorOptions } = vi.hoisted(() => ({
  grpcConstructorOptions: [] as unknown[],
  sealConstructorOptions: [] as SealClientOptionsCapture[],
}));

interface SealClientOptionsCapture {
  serverConfigs: {
    objectId: string;
    weight: number;
    aggregatorUrl?: string;
    apiKeyName?: string;
    apiKey?: string;
  }[];
  verifyKeyServers?: boolean;
  fetch?: typeof fetch;
}

vi.mock("@mysten/sui/grpc", () => ({
  SuiGrpcClient: class {
    constructor(options: unknown) {
      grpcConstructorOptions.push(options);
    }
  },
}));

/**
 * Stubs only what construction touches. `EncryptedObject` and `SessionKey` are referenced by
 * the module but not called until an encrypt/decrypt, so empty placeholders are enough.
 */
vi.mock("@mysten/seal", () => ({
  SealClient: class {
    constructor(options: SealClientOptionsCapture) {
      sealConstructorOptions.push(options);
    }
  },
  EncryptedObject: {},
  SessionKey: {},
}));

import { type ConsoleConfig, ConsoleConfigTag } from "../src/config";
import { resolveFullnodeUrl } from "../src/console/packageConfig";
import { resolveSealConfig } from "../src/console/seal-config";
import { SealCryptoService } from "../src/console/SealCryptoService";
import { UnapprovedRedirectError } from "../src/safeFetch";

function makeConfig(baseUrl: string): ConsoleConfig {
  return {
    apiKey: Redacted.make("hbr_working_key_value"),
    servicePrivateKey: Redacted.make(""),
    adminKey: Redacted.make("hbradm_x"),
    adminServicePrivateKey: Redacted.make(""),
    baseUrl,
    webAccountAddress: "",
    keyAdminAddress: "",
  } satisfies ConsoleConfig;
}

/**
 * Build the service so its constructor-time wiring runs. The Sui and Seal
 * clients are stateless config holders — `SealClient` only stores what it is
 * handed — so nothing here reaches the network.
 */
async function constructServiceWith(baseUrl: string): Promise<void> {
  const layer = SealCryptoService.DefaultWithoutDependencies.pipe(
    Layer.provide(Layer.succeed(ConsoleConfigTag, makeConfig(baseUrl))),
  );
  await Effect.runPromise(SealCryptoService.pipe(Effect.asVoid, Effect.provide(layer)));
}

/**
 * The network is derived from the Console API base URL rather than configured,
 * and nothing else in the suite observes that it reaches the Sui client:
 * re-pinning `network: "testnet"` here — which is what `main` carries, so it is
 * a plausible merge-conflict resolution — leaves every other test green while
 * pointing mainnet decrypts at a testnet fullnode.
 */
describe("SealCryptoService — Sui client follows the resolved network", () => {
  beforeEach(() => {
    grpcConstructorOptions.length = 0;
    sealConstructorOptions.length = 0;
  });

  it("points at the testnet fullnode for a testnet Console host", async () => {
    await constructServiceWith("https://api.testnet.harbor.walrus.xyz");

    expect(grpcConstructorOptions).toEqual([
      { baseUrl: resolveFullnodeUrl("testnet"), network: "testnet" },
    ]);
  });

  it("points at the mainnet fullnode for a mainnet Console host", async () => {
    await constructServiceWith("https://api.mainnet.harbor.walrus.xyz");

    expect(grpcConstructorOptions).toEqual([
      { baseUrl: resolveFullnodeUrl("mainnet"), network: "mainnet" },
    ]);
  });
});

/**
 * `sealConfig.test.ts` pins what `resolveSealConfig` returns; these pin that the service
 * actually hands it to the SDK. Without them the wiring could regress to the pre-COMG-604
 * three-server literal — or drop the Bearer header the proxy authenticates — while every
 * pure-function assertion stayed green.
 */
describe("SealCryptoService — Seal client is wired to the committee behind the proxy", () => {
  beforeEach(() => {
    grpcConstructorOptions.length = 0;
    sealConstructorOptions.length = 0;
  });

  it("configures exactly one committee key server, not the retired 2-of-3 set", async () => {
    await constructServiceWith("https://api.testnet.harbor.walrus.xyz");

    expect(sealConstructorOptions).toHaveLength(1);
    expect(sealConstructorOptions[0]?.serverConfigs).toHaveLength(1);
    expect(sealConstructorOptions[0]?.serverConfigs[0]?.objectId).toBe(
      resolveSealConfig("testnet", "https://api.testnet.harbor.walrus.xyz", "").serverConfigs[0]
        ?.objectId,
    );
  });

  it("routes key requests to the Console proxy on the configured host", async () => {
    await constructServiceWith("https://api.mainnet.harbor.walrus.xyz");

    expect(sealConstructorOptions[0]?.serverConfigs[0]?.aggregatorUrl).toBe(
      "https://api.mainnet.harbor.walrus.xyz/api/v1/seal/aggregator",
    );
  });

  it("attaches the Console Bearer key so the proxy accepts the request", async () => {
    await constructServiceWith("https://api.testnet.harbor.walrus.xyz");

    expect(sealConstructorOptions[0]?.serverConfigs[0]?.apiKeyName).toBe("Authorization");
    // `makeConfig` sets this key; the proxy 401s without it.
    expect(sealConstructorOptions[0]?.serverConfigs[0]?.apiKey).toBe(
      "Bearer hbr_working_key_value",
    );
  });

  // COMG-1053. The SDK owns these requests and its only header slot is spent on
  // `Authorization`, so `SealClientOptions.fetch` is the one way `fetch_key` is
  // attributed. Asserted on the wiring, not just the helper: dropping the option
  // here would leave the helper's own tests green.
  it("hands the SDK a fetch that declares this client as MCP", async () => {
    await constructServiceWith("https://api.testnet.harbor.walrus.xyz");

    const sealFetch = sealConstructorOptions[0]?.fetch;
    expect(sealFetch).toBeTypeOf("function");

    const base = vi.fn(
      async (_input: string | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = base as unknown as typeof fetch;
    try {
      await sealFetch?.("https://api.testnet.harbor.walrus.xyz/v1/fetch_key", {
        headers: { Authorization: "Bearer hbr_working_key_value" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const headers = new Headers(base.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-console-client")).toBe("mcp");
    // The SDK's own auth still rides along.
    expect(headers.get("authorization")).toBe("Bearer hbr_working_key_value");
  });

  // the security review. The SDK sets no redirect policy of its own, so without the guard a
  // redirected `fetch_key` POST is replayed to the target with its body: the SessionKey
  // certificate, the `seal_approve` PTB and the ephemeral key. Asserted on the wiring
  // for the same reason as the attribution test above — `safeFetch.test.ts` covers the
  // guard, and stays green if this lane stops using it.
  describe("fetch_key is behind the redirect guard", () => {
    const FETCH_KEY_URL =
      "https://api.testnet.harbor.walrus.xyz/api/v1/seal/aggregator/v1/fetch_key";

    /** Call the wired fetch the way the SDK does, against a stubbed global `fetch`. */
    async function postFetchKeyAnsweredWith(...responses: Response[]) {
      await constructServiceWith("https://api.testnet.harbor.walrus.xyz");
      const sealFetch = sealConstructorOptions[0]?.fetch;
      expect(sealFetch).toBeTypeOf("function");

      const base = vi.fn(async (_input: string | URL, _init?: RequestInit) => {
        const next = responses.shift();
        if (!next) throw new Error("unexpected extra fetch");
        return next;
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = base as unknown as typeof fetch;
      try {
        const result = await Promise.resolve(
          sealFetch?.(FETCH_KEY_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer hbr_working_key_value",
            },
            body: JSON.stringify({ ptb: "ptb", certificate: "certificate" }),
          }),
        ).then(
          (response) => ({ response, error: undefined }),
          (error: unknown) => ({ response: undefined, error }),
        );
        return { base, ...result };
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    const redirectTo = (location: string) =>
      new Response(null, { status: 307, headers: { location } });

    it("refuses a redirect to an unapproved host without ever requesting it", async () => {
      const { base, error } = await postFetchKeyAnsweredWith(
        redirectTo("https://attacker.example/v1/fetch_key"),
      );

      expect(error).toBeInstanceOf(UnapprovedRedirectError);
      expect(base).toHaveBeenCalledTimes(1);
    });

    // Followed by design, not an oversight: the guard refuses unapproved targets, and
    // an approved host on another origin (`*.walrus.xyz`) is still followed, exactly as
    // on the upload and `HttpClient` lanes. What this lane needs from the guard is that
    // such a hop carries nothing: the request that reaches the second host is empty.
    it("never replays the body, nor the key across origins, on a redirect it does follow", async () => {
      const { base, response } = await postFetchKeyAnsweredWith(
        redirectTo("https://other.walrus.xyz/v1/fetch_key"),
        new Response(null, { status: 400 }),
      );

      expect(response?.status).toBe(400);
      expect(base).toHaveBeenCalledTimes(2);
      // The first hop is the real request: body, key and attribution all present.
      const first = base.mock.calls[0]?.[1];
      expect(first?.body).toBe(JSON.stringify({ ptb: "ptb", certificate: "certificate" }));
      expect(new Headers(first?.headers).get("authorization")).toBe("Bearer hbr_working_key_value");
      expect(new Headers(first?.headers).get("x-console-client")).toBe("mcp");
      // The followed hop carries none of them.
      const second = base.mock.calls[1]?.[1];
      expect(second?.body).toBeUndefined();
      expect(new Headers(second?.headers).get("authorization")).toBeNull();
      expect(new Headers(second?.headers).get("x-console-client")).toBeNull();
    });
  });

  it("picks the committee by network, not a fixed testnet default", async () => {
    await constructServiceWith("https://api.testnet.harbor.walrus.xyz");
    const testnetCommittee = sealConstructorOptions[0]?.serverConfigs[0]?.objectId;

    sealConstructorOptions.length = 0;
    await constructServiceWith("https://api.mainnet.harbor.walrus.xyz");

    expect(sealConstructorOptions[0]?.serverConfigs[0]?.objectId).not.toBe(testnetCommittee);
  });
});
