import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { type ConsoleConfig, ConsoleConfigTag, hasAdminCredential } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleAuthError } from "../src/console/errors";
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
    baseUrl: "https://api.testnet.console.walrus.xyz",
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

describe("KeyAdminService.generateApiKey — admin-signer hint on execute failure", () => {
  it("wraps an execute-time rejection with a hint that the admin signer may be wrong", async () => {
    // A wrong-but-valid admin seed signs the sponsored PTB fine — the failure only
    // surfaces once Console checks the signature against the registered signer at
    // /execute. Simulate that by having executeSponsored fail like Console would.
    const stubApi = {
      createApiKey: () =>
        Effect.succeed({
          id: "key_1",
          name: null,
          key: "hbr_minted",
          space_id: "sp_1",
          permissions: "read_write" as const,
          service_signer_address: "0xchild",
          status: "active" as const,
          expected_permission: null,
          private_buckets: [{ bucket_id: "b1", group_id: "g1" }],
          created_at: "2024-01-01T00:00:00Z",
        }),
      sponsorGrantBucketAccess: () => Effect.succeed({ bytes: "AAAA", digest: "0xdigest" }),
      executeSponsored: () =>
        Effect.fail(
          new ConsoleAuthError({
            message: "Signature verification failed",
            code: "invalid_api_key",
          }),
        ),
      getApiKeyStatus: () =>
        Effect.die("getApiKeyStatus must not run — executeSponsored already failed"),
    } as unknown as ConsoleApiClient;

    const stubSeal = {
      generateChildKeypair: () =>
        Effect.succeed({ address: "0xchild", privateKey: "suiprivkey1child" }),
      signTransactionBytes: () => Effect.succeed("c2lnbmF0dXJl"),
    } as unknown as SealCryptoService;

    const layer = KeyAdminService.DefaultWithoutDependencies.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ConsoleApiClient, stubApi),
          Layer.succeed(SealCryptoService, stubSeal),
          Layer.succeed(
            ConsoleConfigTag,
            makeConfig({ adminKey: "hbradm_x", adminServicePrivateKey: "suiprivkey1a" }),
          ),
        ),
      ),
    );

    const error = await Effect.runPromise(
      KeyAdminService.pipe(
        Effect.flatMap((svc) => svc.generateApiKey({ spaceId: "sp_1", permission: "read_write" })),
        Effect.flip,
        Effect.provide(layer),
      ),
    );

    // Type is preserved (still a ConsoleAuthError, not swallowed into something else)...
    expect(error._tag).toBe("ConsoleAuthError");
    const message = (error as { message: string }).message;
    // ...and the original message survives alongside the new hint.
    expect(message).toContain("Signature verification failed");
    expect(message).toContain("CONSOLE_ADMIN_SERVICE_PRIVATE_KEY");
    expect(message).toContain("CONSOLE_ADMIN_KEY");
  });
});
