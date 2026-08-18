import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Effect, Layer, Redacted } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Does the REAL decrypt path single-flight its SessionKey?
 *
 * `sealSessionCache.test.ts` proves `singleFlight` behaves correctly in
 * isolation, and `canReuseSessionKey` proves the reuse predicate. Neither proves
 * that `getSessionKey` actually *routes through* the lock — a refactor could drop
 * the lock and both would stay green. This drives
 * `SealCryptoService.decrypt` itself, concurrently, on a cold cache, and counts
 * how many times `SessionKey.create` is reached.
 *
 * Everything that would touch the network is stubbed: the Seal SDK (parse,
 * SessionKey, SealClient) and the Sui transaction builder, whose `build()`
 * resolves the policy object over RPC. The service, its Effect wiring and its
 * caching are the real thing.
 */

/** Counts creations and yields to the event loop, which is what opened the race. */
const created: string[] = [];

vi.mock("@mysten/seal", () => ({
  EncryptedObject: {
    parse: () => ({ id: "0xab" }),
  },
  SessionKey: {
    create: async ({ address }: { address: string }) => {
      created.push(address);
      // The real create() is an RPC + a signature. The await is the whole point:
      // without it every caller would serialise naturally and the bug could not
      // reproduce even when the lock is removed.
      await new Promise((r) => setTimeout(r, 25));
      return { isExpired: () => false, address };
    },
  },
  SealClient: class {
    async decrypt() {
      return new Uint8Array([1, 2, 3]);
    }
  },
}));

vi.mock("@mysten/sui/transactions", () => ({
  Transaction: class {
    pure = { vector: () => ({}) };
    object() {
      return {};
    }
    moveCall() {}
    async build() {
      return new Uint8Array([9]);
    }
  },
}));

const { SealCryptoService } = await import("../src/console/SealCryptoService");
const { ConsoleConfigTag } = await import("../src/config");

const SIGNER = Ed25519Keypair.generate().getSecretKey();

const TestConfig = Layer.succeed(ConsoleConfigTag, {
  apiKey: Redacted.make("hbr_test"),
  servicePrivateKey: Redacted.make(SIGNER),
  adminKey: Redacted.make(""),
  adminServicePrivateKey: Redacted.make(""),
  baseUrl: "https://api.example.test",
});

/** A fresh layer per test, so every run starts with a genuinely cold cache. */
const freshService = () =>
  SealCryptoService.DefaultWithoutDependencies.pipe(Layer.provide(TestConfig));

const decryptOnce = () =>
  Effect.gen(function* () {
    const seal = yield* SealCryptoService;
    return yield* seal.decrypt(new Uint8Array([1]), "0xpolicy");
  });

beforeEach(() => {
  created.length = 0;
});

describe("SealCryptoService.decrypt — session single-flight", () => {
  // Regression: five parallel download_file calls on a cold cache used to issue
  // five SessionKey.create round-trips, because each read the empty cache before
  // the first create resolved.
  it("creates one session key for five concurrent cold decrypts", async () => {
    const layer = freshService();
    await Effect.runPromise(
      Effect.all(
        Array.from({ length: 5 }, () => decryptOnce()),
        { concurrency: "unbounded" },
      ).pipe(Effect.provide(layer)),
    );
    expect(created).toHaveLength(1);
  });

  it("reuses the cached key for later sequential decrypts", async () => {
    const layer = freshService();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* decryptOnce();
        yield* decryptOnce();
        yield* decryptOnce();
      }).pipe(Effect.provide(layer)),
    );
    expect(created).toHaveLength(1);
  });

  it("still returns the decrypted bytes to every concurrent caller", async () => {
    const layer = freshService();
    const out = await Effect.runPromise(
      Effect.all(
        Array.from({ length: 5 }, () => decryptOnce()),
        { concurrency: "unbounded" },
      ).pipe(Effect.provide(layer)),
    );
    expect(out).toHaveLength(5);
    for (const bytes of out) expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });
});
