import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { type ConsoleConfig, ConsoleConfigTag } from "../src/config";
import { SealCryptoService } from "../src/console/SealCryptoService";

/** Build a config with whichever signer half the test needs; the rest are unused stubs. */
function makeConfig(
  over: Partial<Record<"servicePrivateKey" | "adminServicePrivateKey", string>>,
): ConsoleConfig {
  return {
    apiKey: Redacted.make("hbr_working_key_value"),
    servicePrivateKey: Redacted.make(over.servicePrivateKey ?? ""),
    adminKey: Redacted.make("hbradm_x"),
    adminServicePrivateKey: Redacted.make(over.adminServicePrivateKey ?? ""),
    baseUrl: "https://api.testnet.console.walrus.xyz",
    webAccountAddress: "",
    keyAdminAddress: "",
  } satisfies ConsoleConfig;
}

/**
 * `getKeypair` is the one SealCryptoService seam reachable without a network:
 * it only touches config + `decodeSuiPrivateKey`. The Sui/Seal client objects
 * built alongside it are stateless config holders (no I/O until a call is
 * made), so constructing the service in-test is safe.
 */
describe("SealCryptoService.getKeypair — decode failure message", () => {
  it("explains a garbled CONSOLE_SERVICE_PRIVATE_KEY and points at `config`", async () => {
    const config = makeConfig({ servicePrivateKey: `suiprivkey1${"x".repeat(59)}` });
    const layer = SealCryptoService.DefaultWithoutDependencies.pipe(
      Layer.provide(Layer.succeed(ConsoleConfigTag, config)),
    );

    const error = await Effect.runPromise(
      SealCryptoService.pipe(
        Effect.flatMap((svc) => svc.getKeypair("working")),
        Effect.flip,
        Effect.provide(layer),
      ),
    );

    expect(error._tag).toBe("SealCryptoError");
    const message = (error as { message: string }).message;
    expect(message).toContain("CONSOLE_SERVICE_PRIVATE_KEY");
    expect(message).toContain("suiprivkey1");
    expect(message).toContain("walrus-console-mcp config");
  });

  it("explains a garbled CONSOLE_ADMIN_SERVICE_PRIVATE_KEY the same way", async () => {
    const config = makeConfig({ adminServicePrivateKey: `suiprivkey1${"x".repeat(59)}` });
    const layer = SealCryptoService.DefaultWithoutDependencies.pipe(
      Layer.provide(Layer.succeed(ConsoleConfigTag, config)),
    );

    const error = await Effect.runPromise(
      SealCryptoService.pipe(
        Effect.flatMap((svc) => svc.getKeypair("admin")),
        Effect.flip,
        Effect.provide(layer),
      ),
    );

    const message = (error as { message: string }).message;
    expect(message).toContain("CONSOLE_ADMIN_SERVICE_PRIVATE_KEY");
    expect(message).toContain("suiprivkey1");
    expect(message).toContain("walrus-console-mcp config");
  });
});
