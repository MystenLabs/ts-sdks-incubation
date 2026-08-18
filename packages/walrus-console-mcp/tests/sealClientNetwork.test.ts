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

function makeConfig(baseUrl: string): ConsoleConfig {
  return {
    apiKey: Redacted.make("hbr_working_key_value"),
    servicePrivateKey: Redacted.make(""),
    adminKey: Redacted.make("hbradm_x"),
    adminServicePrivateKey: Redacted.make(""),
    baseUrl,
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

  it("picks the committee by network, not a fixed testnet default", async () => {
    await constructServiceWith("https://api.testnet.harbor.walrus.xyz");
    const testnetCommittee = sealConstructorOptions[0]?.serverConfigs[0]?.objectId;

    sealConstructorOptions.length = 0;
    await constructServiceWith("https://api.mainnet.harbor.walrus.xyz");

    expect(sealConstructorOptions[0]?.serverConfigs[0]?.objectId).not.toBe(testnetCommittee);
  });
});
