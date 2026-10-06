import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Effect, Fiber, Layer, Redacted } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const POLICY_OBJECT_ID = `0x${"1".repeat(64)}`;
const DECRYPT_ID = `${"1".repeat(64)}${"07".repeat(32)}`;

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
 * Object ids handed to `seal_approve`, in call order. `decrypt` takes no policy
 * argument, so this is how a test observes WHICH group it derived for the PTB.
 */
const approvedObjects: string[] = [];

/**
 * Test seams on the stubbed `SealClient.decrypt`/`encrypt`, reset per test.
 * `gate` lets a test hold the promise open after the fiber is interrupted,
 * which is how the M8 wiring tests observe that the real service waits for it.
 */
const decryptHooks: {
  entered: (() => void) | undefined;
  gate: Promise<void> | undefined;
  /** When set, the stubbed key-server decrypt rejects with this. */
  reject: Error | undefined;
} = {
  entered: undefined,
  gate: undefined,
  reject: undefined,
};
const encryptHooks: {
  entered: (() => void) | undefined;
  gate: Promise<void> | undefined;
  /** Last options passed to the stubbed SealClient.encrypt. */
  lastOptions: { aad?: Uint8Array } | undefined;
} = {
  entered: undefined,
  gate: undefined,
  lastOptions: undefined,
};

/**
 * The AAD the stubbed `parse` reports, so a test can drive the real decrypt seam
 * down the BOUND lane. A fixed `null` here is why nothing observed what the seam
 * computes for a bound file: every other harness stubs the seam itself.
 */
const parseHooks: { aad: Uint8Array | null } = { aad: null };

vi.mock("@mysten/seal", () => ({
  EncryptedObject: {
    // The real `parse` returns `ciphertext`, which carries the AAD; null is the legacy lane.
    parse: () => ({ id: DECRYPT_ID, ciphertext: { Aes256Gcm: { aad: parseHooks.aad } } }),
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
      if (decryptHooks.reject) throw decryptHooks.reject;
      return new Uint8Array([1, 2, 3]);
    }
    async encrypt(options: { aad?: Uint8Array }) {
      encryptHooks.entered?.();
      encryptHooks.lastOptions = options;
      if (encryptHooks.gate) await encryptHooks.gate;
      return { encryptedObject: new Uint8Array([1, 2, 3]) };
    }
  },
}));

vi.mock("@mysten/sui/transactions", () => ({
  Transaction: class {
    pure = { vector: () => ({}) };
    object(id: string) {
      approvedObjects.push(id);
      return {};
    }
    moveCall() {}
    async build() {
      return new Uint8Array([9]);
    }
  },
}));

const { SealCryptoService } = await import("../src/console/SealCryptoService");
const { encodeFileAad } = await import("../src/console/fileAad");
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

// No policy argument: decrypt reads it out of the ciphertext's identity, which the
// mocked `EncryptedObject.parse` above pins to DECRYPT_ID (POLICY_OBJECT_ID + nonce).
const decryptOnce = () =>
  Effect.gen(function* () {
    const seal = yield* SealCryptoService;
    return yield* seal.decrypt(new Uint8Array([1]), {
      bucketId: "bucket-1",
      fileId: "file-1",
      // The group the mocked identity names, so the group check passes.
      expectedGroupId: POLICY_OBJECT_ID,
      record: { original_name: null, declared_mime_type: null, content_size: null },
    });
  });

// encrypt's identity encodes this as a `SealIdentity.policyObjectId` (`bcs.Address`)
// before touching the mocked Seal client, so it must be a real 32-byte hex address
// rather than an arbitrary label.
const ENCRYPT_AAD = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

const encryptOnce = () =>
  Effect.gen(function* () {
    const seal = yield* SealCryptoService;
    return yield* seal.encrypt(new Uint8Array([1]), POLICY_OBJECT_ID, ENCRYPT_AAD);
  });

beforeEach(() => {
  created.length = 0;
  approvedObjects.length = 0;
  decryptHooks.entered = undefined;
  decryptHooks.gate = undefined;
  decryptHooks.reject = undefined;
  parseHooks.aad = null;
  encryptHooks.entered = undefined;
  encryptHooks.gate = undefined;
  encryptHooks.lastOptions = undefined;
});

describe("SealCryptoService.encrypt — AAD required (COMG-1061)", () => {
  it("forwards the AAD bytes to SealClient.encrypt", async () => {
    await Effect.runPromise(encryptOnce().pipe(Effect.provide(freshService())));
    expect(encryptHooks.lastOptions?.aad).toEqual(ENCRYPT_AAD);
  });
});

describe("SealCryptoService.decrypt — policy derivation (COMG-848)", () => {
  // The group `seal_approve` is asked to approve must come from the ciphertext's own
  // identity. On-chain that is the only group that can approve it (`EInvalidPrefix`),
  // so deriving it is what makes a caller-supplied policy unable to matter — the
  // parameter is gone from `decrypt` entirely rather than merely being validated.
  it("hands seal_approve the policy embedded in the ciphertext", async () => {
    await Effect.runPromise(decryptOnce().pipe(Effect.provide(freshService())));
    expect(approvedObjects).toContain(POLICY_OBJECT_ID);
  });

  // A key-server denial after parse must still carry the embedded policy for
  // diagnostics / agent-visible tool output.
  it("carries the embedded policy on a key-server decrypt failure", async () => {
    decryptHooks.reject = new Error("NoAccessError: user does not have access");
    const error = await Effect.runPromise(
      decryptOnce().pipe(Effect.flip, Effect.provide(freshService())),
    );
    expect(error).toMatchObject({
      _tag: "SealCryptoError",
      step: "decrypt",
      embeddedPolicyId: POLICY_OBJECT_ID,
    });
  });
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
    for (const result of out) expect(Array.from(result.plaintext)).toEqual([1, 2, 3]);
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

/**
 * Through the real decrypt seam, which every other harness replaces. The stubbed
 * key server returns three bytes, which is what the bindings below declare.
 */
describe("decrypt's bound result", () => {
  const BUCKET = "b7f0b3a0-0000-4000-8000-00000000000a";

  const bindingFor = (contentSize: number) => ({
    bucketId: BUCKET,
    fileId: "file-1",
    expectedGroupId: POLICY_OBJECT_ID,
    record: {
      original_name: "the-real-name.pdf",
      declared_mime_type: "application/pdf",
      content_size: contentSize,
    },
  });

  const aadFor = (contentSize: number) =>
    encodeFileAad({
      bucketId: BUCKET,
      originalName: "the-real-name.pdf",
      declaredType: "application/pdf",
      contentSize,
    });

  it("returns the name the ciphertext authenticates, and says it is bound", async () => {
    parseHooks.aad = aadFor(3);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const seal = yield* SealCryptoService;
        return yield* seal.decrypt(new Uint8Array([1]), bindingFor(3));
      }).pipe(Effect.provide(freshService())),
    );

    expect(Array.from(result.plaintext)).toEqual([1, 2, 3]);
    expect(result.bound).toBe(true);
    expect(result.authenticatedName).toBe("the-real-name.pdf");
  });

  it("reports a legacy ciphertext as unbound and authenticates no name", async () => {
    parseHooks.aad = null;

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const seal = yield* SealCryptoService;
        return yield* seal.decrypt(new Uint8Array([1]), {
          ...bindingFor(3),
          record: { original_name: null, declared_mime_type: null, content_size: null },
        });
      }).pipe(Effect.provide(freshService())),
    );

    expect(result.bound).toBe(false);
    expect(result.authenticatedName).toBeNull();
  });

  // The AAD matched the record, so the compare passed and a key WAS fetched. The
  // bytes that came back are the wrong length, which is the only thing left that
  // can still say the ciphertext is not the one this record describes.
  it("refuses when the decrypted length disagrees with the bound size", async () => {
    parseHooks.aad = aadFor(99);

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const seal = yield* SealCryptoService;
        return yield* seal.decrypt(new Uint8Array([1]), bindingFor(99));
      }).pipe(Effect.flip, Effect.provide(freshService())),
    );

    expect(error._tag).toBe("FileBindingRefusedError");
    expect(error).toMatchObject({ reason: "size" });
    expect(error.message).toContain("99");
  });
});
