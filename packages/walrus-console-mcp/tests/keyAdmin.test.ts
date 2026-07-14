import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { type ConsoleConfig, ConsoleConfigTag, hasAdminCredential } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { KeyAdminService } from "../src/console/KeyAdminService";
import { SealCryptoService } from "../src/console/SealCryptoService";

/** Build a config with working creds and whatever admin halves the test needs. */
function makeConfig(
  over: Partial<Record<"adminKey" | "adminServicePrivateKey", string>>,
): ConsoleConfig {
  return {
    apiKey: Redacted.make("hbr_working_key_value"),
    servicePrivateKey: Redacted.make("suiprivkey1working"),
    adminKey: Redacted.make(over.adminKey ?? ""),
    adminServicePrivateKey: Redacted.make(over.adminServicePrivateKey ?? ""),
    baseUrl: "https://api.testnet.harbor.walrus.xyz",
  } satisfies ConsoleConfig;
}

describe("hasAdminCredential", () => {
  it("is true only when both admin halves are present", () => {
    expect(
      hasAdminCredential(
        makeConfig({ adminKey: "hbradm_x", adminServicePrivateKey: "suiprivkey1a" }),
      ),
    ).toBe(true);
  });

  it("is false when only the admin key is set", () => {
    expect(hasAdminCredential(makeConfig({ adminKey: "hbradm_x" }))).toBe(false);
  });

  it("is false when only the admin signer is set", () => {
    expect(hasAdminCredential(makeConfig({ adminServicePrivateKey: "suiprivkey1a" }))).toBe(false);
  });

  it("is false when neither is set", () => {
    expect(hasAdminCredential(makeConfig({}))).toBe(false);
  });
});

describe("KeyAdminService.generateApiKey — missing-credential guard", () => {
  it("fails with AdminCredentialMissingError and never touches the network", async () => {
    // Any API call means the guard leaked — record every method and fail loudly if hit.
    const apiCalls: string[] = [];
    const track =
      (name: string) =>
      (..._args: unknown[]) => {
        apiCalls.push(name);
        return Effect.die(`network call "${name}" must not run without admin creds`);
      };
    const stubApi = {
      createApiKey: track("createApiKey"),
      sponsorGrantBucketAccess: track("sponsorGrantBucketAccess"),
      executeSponsored: track("executeSponsored"),
      getApiKeyStatus: track("getApiKeyStatus"),
    } as unknown as ConsoleApiClient;

    const stubSeal = {
      generateChildKeypair: track("generateChildKeypair"),
      signTransactionBytes: track("signTransactionBytes"),
    } as unknown as SealCryptoService;

    const layer = KeyAdminService.DefaultWithoutDependencies.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ConsoleApiClient, stubApi),
          Layer.succeed(SealCryptoService, stubSeal),
          Layer.succeed(ConsoleConfigTag, makeConfig({})), // no admin creds
        ),
      ),
    );

    const error = await Effect.runPromise(
      KeyAdminService.pipe(
        Effect.flatMap((svc) => svc.generateApiKey({ spaceId: "sp_1", permission: "read_write" })),
        Effect.flip, // we expect a failure; flip turns it into the success channel
        Effect.provide(layer),
      ),
    );

    expect(error._tag).toBe("AdminCredentialMissingError");
    expect((error as { message: string }).message).toContain("A working key cannot mint");
    expect(apiCalls).toEqual([]);
  });
});
