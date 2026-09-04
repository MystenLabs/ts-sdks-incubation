import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Effect, Fiber, Layer, Redacted } from "effect";
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

/**
 * Test seams on the stubbed `SealClient.decrypt`/`encrypt`, reset per test.
 * `gate` lets a test hold the promise open after the fiber is interrupted,
 * which is how the M8 wiring tests observe that the real service waits for it.
 */
const decryptHooks: { entered: (() => void) | undefined; gate: Promise<void> | undefined } = {
  entered: undefined,
  gate: undefined,
};
const encryptHooks: { entered: (() => void) | undefined; gate: Promise<void> | undefined } = {
  entered: undefined,
  gate: undefined,
};

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
      decryptHooks.entered?.();
      if (decryptHooks.gate) await decryptHooks.gate;
      return new Uint8Array([1, 2, 3]);
    }
    async encrypt() {
      encryptHooks.entered?.();
      if (encryptHooks.gate) await encryptHooks.gate;
      return { encryptedObject: new Uint8Array([1, 2, 3]) };
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
  webAccountAddress: "",
  keyAdminAddress: "",
});

/** A fresh layer per test, so every run starts with a genuinely cold cache. */
const freshService = () =>
  SealCryptoService.DefaultWithoutDependencies.pipe(Layer.provide(TestConfig));

const decryptOnce = () =>
  Effect.gen(function* () {
    const seal = yield* SealCryptoService;
    return yield* seal.decrypt(new Uint8Array([1]), "0xpolicy");
  });

// Unlike `decrypt`'s policy id (only reaches the mocked `Transaction` builder),
// `encrypt` bcs-encodes this as a `SealIdentity.policyObjectId` (`bcs.Address`)
// before ever touching the mocked `SealClient`, so it must be a real 32-byte hex
// address rather than an arbitrary label.
const POLICY_OBJECT_ID = `0x${"1".repeat(64)}`;

const encryptOnce = () =>
  Effect.gen(function* () {
    const seal = yield* SealCryptoService;
    return yield* seal.encrypt(new Uint8Array([1]), POLICY_OBJECT_ID);
  });

beforeEach(() => {
  created.length = 0;
  decryptHooks.entered = undefined;
  decryptHooks.gate = undefined;
  encryptHooks.entered = undefined;
  encryptHooks.gate = undefined;
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

/**
 * Wiring, not mechanics: `tests/effectPromise.test.ts` proves
 * `tryPromiseSettling` holds a fiber's interruption open until the abandoned
 * promise settles. Nothing there proves `SealCryptoService.decrypt` actually
 * ROUTES through it — a refactor back to `Effect.tryPromise` would leave that
 * file green while re-opening M8. This drives the real decrypt and watches when
 * the interrupt completes.
 */
describe("SealCryptoService.decrypt — cancellation waits for the Seal promise (M8)", () => {
  it("does not finish interrupting until the abandoned decrypt settles", async () => {
    const layer = freshService();

    let decryptStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      decryptStarted = resolve;
    });
    let releaseGate!: () => void;
    decryptHooks.entered = () => decryptStarted();
    decryptHooks.gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const order: string[] = [];
    let orderWhileHeld: readonly string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(decryptOnce());
        // Deterministic rather than timed: wait for the stub decrypt to be
        // entered, so the interrupt below always lands on a pending promise.
        yield* Effect.promise(() => entered);

        // Forked, not awaited: post-fix it cannot complete until the gate opens.
        const interrupting = yield* Effect.fork(
          Fiber.interrupt(fiber).pipe(
            Effect.tap(() => Effect.sync(() => order.push("interrupt finished"))),
          ),
        );
        yield* Effect.sleep("50 millis");
        // Snapshot rather than assert in-fiber: a throw here would be a defect
        // that never releases the gate.
        orderWhileHeld = [...order];

        yield* Effect.sync(() => {
          order.push("decrypt promise settled");
          releaseGate();
        });
        yield* Fiber.join(interrupting).pipe(Effect.timeout("2 seconds"));
      }).pipe(Effect.provide(layer)),
    );

    expect(orderWhileHeld).toEqual([]);
    expect(order).toEqual(["decrypt promise settled", "interrupt finished"]);
  });
});

/**
 * Same wiring question as above, for the other `tryPromiseSettling` call site:
 * `SealCryptoService.encrypt` at `SealCryptoService.ts:329`. Encrypt is CPU-bound
 * and always settles in production, but M8's fix is about what happens to the
 * transfer permit while a cancelled encrypt's promise is still abandoned-but-live
 * — a refactor back to `Effect.tryPromise` here would leave `effectPromise.test.ts`
 * green while re-opening M8 for uploads. This drives the real encrypt and watches
 * when the interrupt completes.
 */
describe("SealCryptoService.encrypt — cancellation waits for the Seal promise (M8)", () => {
  it("does not finish interrupting until the abandoned encrypt settles", async () => {
    const layer = freshService();

    let encryptStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      encryptStarted = resolve;
    });
    let releaseGate!: () => void;
    encryptHooks.entered = () => encryptStarted();
    encryptHooks.gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const order: string[] = [];
    let orderWhileHeld: readonly string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(encryptOnce());
        // Deterministic rather than timed: wait for the stub encrypt to be
        // entered, so the interrupt below always lands on a pending promise.
        yield* Effect.promise(() => entered);

        // Forked, not awaited: post-fix it cannot complete until the gate opens.
        const interrupting = yield* Effect.fork(
          Fiber.interrupt(fiber).pipe(
            Effect.tap(() => Effect.sync(() => order.push("interrupt finished"))),
          ),
        );
        yield* Effect.sleep("50 millis");
        // Snapshot rather than assert in-fiber: a throw here would be a defect
        // that never releases the gate.
        orderWhileHeld = [...order];

        yield* Effect.sync(() => {
          order.push("encrypt promise settled");
          releaseGate();
        });
        yield* Fiber.join(interrupting).pipe(Effect.timeout("2 seconds"));
      }).pipe(Effect.provide(layer)),
    );

    expect(orderWhileHeld).toEqual([]);
    expect(order).toEqual(["encrypt promise settled", "interrupt finished"]);
  });
});
