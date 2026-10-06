import { EncryptedObject } from "@mysten/seal";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { type ConsoleConfig, ConsoleConfigTag } from "../src/config";
import { parseSealIdentityPolicyId, SealIdentity } from "../src/console/constants";
import { encodeFileAad } from "../src/console/fileAad";
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

/** The decrypt seam's own signature, so the helper below cannot drift from it. */
type SealCryptoServiceShape = typeof SealCryptoService.Service;

describe("Seal identity policy binding", () => {
  const embeddedPolicyId = `0x${"1".repeat(64)}`;
  const BOUND_BUCKET = "b7f0b3a0-0000-4000-8000-00000000000a";
  const BOUND_AAD = {
    bucketId: BOUND_BUCKET,
    originalName: "report.pdf",
    declaredType: "application/pdf",
    contentSize: 1024,
  } as const;

  const encryptedObjectFor = (
    policyObjectId: string,
    aad: Uint8Array | null = null,
  ): Uint8Array => {
    const id = SealIdentity.serialize({
      policyObjectId,
      nonce: Array.from({ length: 32 }, () => 7),
    }).toHex();

    return EncryptedObject.serialize({
      version: 1,
      packageId: policyObjectId,
      id,
      services: [[policyObjectId, 1]],
      threshold: 1,
      encryptedShares: {
        BonehFranklinBLS12381: {
          nonce: new Uint8Array(96),
          encryptedShares: [],
          encryptedRandomness: new Uint8Array(32),
        },
      },
      // Policy derivation and keypair setup run before ciphertext decryption, so
      // this only needs to be a structurally valid encrypted-object variant.
      ciphertext: {
        Aes256Gcm: {
          blob: new Uint8Array([0]),
          aad,
        },
      },
    }).toBytes();
  };

  it("decodes the policy object ID from the encrypted identity", () => {
    const idBytes = SealIdentity.serialize({
      policyObjectId: embeddedPolicyId,
      nonce: Array.from({ length: 32 }, () => 7),
    }).toBytes();

    expect(parseSealIdentityPolicyId(idBytes)).toBe(embeddedPolicyId);
  });

  // Only the 32-byte prefix is contractual (`seal_approve` asserts it); the nonce
  // length is a producer convention, so a different one must still derive.
  it("reads only the 32-byte prefix, whatever follows it", () => {
    const prefix = SealIdentity.serialize({
      policyObjectId: embeddedPolicyId,
      nonce: Array.from({ length: 32 }, () => 7),
    })
      .toBytes()
      .subarray(0, 32);

    for (const tailLength of [0, 16, 32, 64]) {
      const idBytes = new Uint8Array(32 + tailLength);
      idBytes.set(prefix, 0);
      idBytes.fill(9, 32);
      expect(parseSealIdentityPolicyId(idBytes)).toBe(embeddedPolicyId);
    }
  });

  it("rejects an identity too short to hold the policy prefix", () => {
    expect(() => parseSealIdentityPolicyId(new Uint8Array(31))).toThrow(/32-byte policy prefix/);
  });

  // This config has no signer, so reaching keypair setup fails as `load_keypair`. That
  // makes it the ordering probe: a binding refusal here fired before any key was loaded.
  const decryptWith = (
    ciphertext: Uint8Array,
    binding: Partial<Parameters<SealCryptoServiceShape["decrypt"]>[1]> = {},
  ) => {
    const layer = SealCryptoService.DefaultWithoutDependencies.pipe(
      Layer.provide(Layer.succeed(ConsoleConfigTag, makeConfig({}))),
    );
    return Effect.runPromise(
      SealCryptoService.pipe(
        Effect.flatMap((service) =>
          service.decrypt(ciphertext, {
            bucketId: BOUND_BUCKET,
            fileId: "file-1",
            expectedGroupId: embeddedPolicyId,
            record: { original_name: null, declared_mime_type: null, content_size: null },
            ...binding,
          }),
        ),
        Effect.flip,
        Effect.provide(layer),
      ),
    );
  };

  // A legacy ciphertext whose group matches passes both binding checks.
  it("derives the policy from the ciphertext and proceeds to keypair setup", async () => {
    const error = await decryptWith(encryptedObjectFor(embeddedPolicyId));

    expect(error._tag).toBe("SealCryptoError");
    expect(error).toMatchObject({ step: "load_keypair" });
  });

  // The cross-bucket swap. `seal_approve`'s own `is_prefix` would approve this
  // ciphertext under ITS group; what it cannot know is which folder the caller
  // asked for, and this client holds access to every folder its key can read.
  it("refuses a ciphertext whose group is not the one this folder derives", async () => {
    const error = await decryptWith(encryptedObjectFor(`0x${"2".repeat(64)}`));

    expect(error._tag).toBe("FileBindingRefusedError");
    expect(error).toMatchObject({ reason: "wrong_group", fileId: "file-1" });
  });

  // The record is adversary input, so "we cannot verify this" and "this is fine"
  // must not be the same answer.
  it("refuses a bound ciphertext when the record carries no binding", async () => {
    const error = await decryptWith(encryptedObjectFor(embeddedPolicyId, encodeFileAad(BOUND_AAD)));

    expect(error._tag).toBe("FileBindingRefusedError");
    expect(error).toMatchObject({ reason: "record_not_bound" });
  });

  // The original attack: this record now points at another file's ciphertext.
  it("refuses a ciphertext that does not match the record's binding", async () => {
    const error = await decryptWith(
      encryptedObjectFor(
        embeddedPolicyId,
        encodeFileAad({ ...BOUND_AAD, originalName: "payroll.xlsx" }),
      ),
      {
        record: {
          original_name: BOUND_AAD.originalName,
          declared_mime_type: BOUND_AAD.declaredType,
          content_size: BOUND_AAD.contentSize,
        },
      },
    );

    expect(error._tag).toBe("FileBindingRefusedError");
    expect(error).toMatchObject({ reason: "mismatch" });
  });

  // A throw here would be a defect inside `Effect.gen`, skipping every typed
  // handler downstream. It has to arrive as the typed refusal, before any key.
  it("refuses a record with an impossible size as a typed error, not a defect", async () => {
    const error = await decryptWith(
      encryptedObjectFor(embeddedPolicyId, encodeFileAad(BOUND_AAD)),
      {
        record: {
          original_name: BOUND_AAD.originalName,
          declared_mime_type: BOUND_AAD.declaredType,
          content_size: -1,
        },
      },
    );

    expect(error._tag).toBe("FileBindingRefusedError");
    expect(error).toMatchObject({ reason: "record_not_bound" });
  });

  it("accepts a ciphertext that matches its record, and only then loads a key", async () => {
    const error = await decryptWith(
      encryptedObjectFor(embeddedPolicyId, encodeFileAad(BOUND_AAD)),
      {
        record: {
          original_name: BOUND_AAD.originalName,
          declared_mime_type: BOUND_AAD.declaredType,
          content_size: BOUND_AAD.contentSize,
        },
      },
    );

    expect(error).toMatchObject({ step: "load_keypair" });
  });
});
