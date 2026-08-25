import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type ConsoleConfig, ConsoleConfigTag, hasAdminCredential } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleApiError, ConsoleAuthError } from "../src/console/errors";
import {
  type GenerateApiKeyOutcome,
  KeyAdminService,
  MAX_API_KEY_LABEL_LENGTH,
  MAX_API_KEY_NAME_LENGTH,
  pollUntilActive,
} from "../src/console/KeyAdminService";
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
    webAccountAddress: "",
    keyAdminAddress: "",
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

/**
 * A wrong-but-valid admin seed signs the sponsored PTB fine — the failure only
 * surfaces once Console checks the signature against the registered signer at
 * /execute.
 *
 * This used to assert the failure arrived on the ERROR channel. It no longer
 * does: /execute runs after the mint, so failing there would discard the
 * credential (see the F8 block below). The hint still has to reach the caller,
 * which is what is asserted now — it is the only thing pointing at a wrong admin
 * signer, and it is easy to lose when an error is turned into prose.
 */
describe("KeyAdminService.generateApiKey — admin-signer hint on execute failure", () => {
  it("carries the hint and the original message onto the outcome", async () => {
    const outcome = await mint(
      mintHarness({
        execute: () =>
          Effect.fail(
            new ConsoleAuthError({
              message: "Signature verification failed",
              code: "invalid_api_key",
            }),
          ),
      }),
    );

    const failed = incomplete(outcome);
    expect(failed.stage).toBe("grant");
    expect(failed.reason).toContain("Signature verification failed");
    expect(failed.reason).toContain("CONSOLE_ADMIN_SERVICE_PRIVATE_KEY");
    expect(failed.reason).toContain("CONSOLE_ADMIN_KEY");
  });
});

describe("pollUntilActive", () => {
  const status = (s: string, progress?: { granted: number; total: number }) =>
    ({ data: { status: s, ...(progress ? { registration_progress: progress } : {}) } }) as never;

  it("returns immediately when the key is already active", async () => {
    let calls = 0;
    const outcome = await Effect.runPromise(
      pollUntilActive("active", () => {
        calls += 1;
        return Effect.succeed(status("active"));
      }),
    );

    expect(outcome.kind).toBe("active");
    // No sleep, no status call — this is the common case and must not cost 2s.
    expect(calls).toBe(0);
  });

  it("stops as soon as the status turns active", async () => {
    let calls = 0;
    const outcome = await Effect.runPromise(
      pollUntilActive(
        "registering",
        () => {
          calls += 1;
          return Effect.succeed(status(calls >= 2 ? "active" : "registering"));
        },
        10,
        1,
      ),
    );

    expect(outcome.kind).toBe("active");
    expect(calls).toBe(2);
  });

  it("reports stalled rather than failing when the budget runs out", async () => {
    // Running out is not an error: the key exists either way, and the caller needs
    // its credential regardless of whether registration landed.
    const outcome = await Effect.runPromise(
      pollUntilActive(
        "registering",
        () => Effect.succeed(status("registering", { granted: 1, total: 3 })),
        3,
        1,
      ),
    );

    if (outcome.kind !== "stalled") throw new Error("expected a stalled outcome");
    expect(outcome.status).toBe("registering");
    expect(outcome.progress).toEqual({ granted: 1, total: 3 });
  });
});

/**
 * F8 — an accepted mint is irreversible, so nothing after it may discard the
 * one-time secrets.
 *
 * `createApiKey` is the point of no return: the server-side key exists from that
 * moment and the `hbr_` value is shown exactly once. Every later step (space
 * check, bucket grant, activation poll) can still fail, and each one used to
 * propagate a plain Effect failure — throwing away the only copy of the
 * credential while leaving the key behind as an orphan nobody can use or revoke.
 */

const MINTED = {
  id: "key_1",
  name: null,
  key: "hbr_minted_once",
  space_id: "sp_1",
  permissions: "read_write" as const,
  service_signer_address: "0xchild",
  status: "active" as const,
  expected_permission: null,
  private_buckets: [{ bucket_id: "b1", group_id: "g1" }],
  created_at: "2024-01-01T00:00:00Z",
};

const CHILD = { address: "0xchild", privateKey: "suiprivkey1child" };

function mintHarness(over: {
  minted?: Partial<typeof MINTED>;
  sponsor?: () => Effect.Effect<unknown, unknown>;
  execute?: () => Effect.Effect<unknown, unknown>;
  status?: () => Effect.Effect<unknown, unknown>;
}) {
  const stubApi = {
    createApiKey: () => Effect.succeed({ ...MINTED, ...over.minted }),
    sponsorGrantBucketAccess:
      over.sponsor ?? (() => Effect.succeed({ bytes: "AAAA", digest: "0xdigest" })),
    executeSponsored: over.execute ?? (() => Effect.succeed({ digest: "0xdigest" })),
    getApiKeyStatus: over.status ?? (() => Effect.succeed({ data: { status: "active" as const } })),
  } as unknown as ConsoleApiClient;

  const stubSeal = {
    generateChildKeypair: () => Effect.succeed(CHILD),
    signTransactionBytes: () => Effect.succeed({ signature: "c2lnbmF0dXJl" }),
  } as unknown as SealCryptoService;

  return KeyAdminService.DefaultWithoutDependencies.pipe(
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
}

/**
 * Assert the mint did not complete, and narrow to that branch. `expect(ok).toBe(false)`
 * proves it at runtime but tells the compiler nothing, and the fields worth
 * checking live only on the incomplete branch.
 */
function incomplete(outcome: GenerateApiKeyOutcome) {
  if (outcome.ok) throw new Error("expected an incomplete mint, got a successful one");
  return outcome;
}

const mint = (layer: Layer.Layer<KeyAdminService>, spaceId = "sp_1") =>
  Effect.runPromise(
    KeyAdminService.pipe(
      Effect.flatMap((svc) => svc.generateApiKey({ spaceId, permission: "read_write" })),
      Effect.provide(layer),
    ),
  );

describe("generateApiKey — a successful mint", () => {
  it("reports ok and returns the credential", async () => {
    const outcome = await mint(mintHarness({}));

    if (!outcome.ok) throw new Error(`expected a successful mint: ${outcome.reason}`);
    expect(outcome.credential.apiKey).toBe("hbr_minted_once");
    expect(outcome.credential.privateKey).toBe("suiprivkey1child");
    expect(outcome.credential.keyId).toBe("key_1");
    expect(outcome.credential.privateBuckets).toEqual([{ bucketId: "b1", groupId: "g1" }]);
  });
});

describe("generateApiKey — lost-response mitigation (F7)", () => {
  it("embeds a unique marker in the mint name and logs a pre-mint breadcrumb", async () => {
    // If createApiKey's 201 is lost after the key is created, the marker is the
    // only way an operator finds the orphan (there is no list/revoke API). This
    // does not make the mint idempotent — it makes a lost key findable.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let capturedName: string | undefined;

    const stubApi = {
      createApiKey: (a: { name?: string }) => {
        capturedName = a.name;
        return Effect.succeed(MINTED);
      },
      sponsorGrantBucketAccess: () => Effect.succeed({ bytes: "AAAA", digest: "0xdigest" }),
      executeSponsored: () => Effect.succeed({ digest: "0xdigest" }),
      getApiKeyStatus: () => Effect.succeed({ data: { status: "active" as const } }),
    } as unknown as ConsoleApiClient;

    const stubSeal = {
      generateChildKeypair: () => Effect.succeed(CHILD),
      signTransactionBytes: () => Effect.succeed({ signature: "c2lnbmF0dXJl" }),
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

    await mint(layer);

    expect(capturedName).toMatch(/mcp-mint-/);
    const marker = capturedName?.match(/mcp-mint-[0-9a-f-]+/)?.[0];
    expect(marker).toBeTruthy();
    // The breadcrumb names the same marker, so a lost mint is traceable.
    expect(spy.mock.calls.flat().join(" ")).toContain(marker as string);
  });

  /**
   * Console caps the stored `name` at 64 and rejects a longer one with a bare
   * 400 — which surfaced as an unexplained mint failure, found by the COMG-761
   * e2e rather than by a test. The label is the operator's convenience; the
   * marker is the only handle on a key whose 201 was lost. So when something
   * has to give, it is the label.
   */
  it("keeps a long label from pushing the mint name past Console's limit", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let capturedName: string | undefined;

    const stubApi = {
      createApiKey: (a: { name?: string }) => {
        capturedName = a.name;
        return Effect.succeed(MINTED);
      },
      sponsorGrantBucketAccess: () => Effect.succeed({ bytes: "AAAA", digest: "0xdigest" }),
      executeSponsored: () => Effect.succeed({ digest: "0xdigest" }),
      getApiKeyStatus: () => Effect.succeed({ data: { status: "active" as const } }),
    } as unknown as ConsoleApiClient;

    const stubSeal = {
      generateChildKeypair: () => Effect.succeed(CHILD),
      signTransactionBytes: () => Effect.succeed({ signature: "c2lnbmF0dXJl" }),
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

    await Effect.runPromise(
      Effect.gen(function* () {
        const keyAdmin = yield* KeyAdminService;
        return yield* keyAdmin.generateApiKey({
          spaceId: "sp_1",
          permission: "read_only",
          label: "x".repeat(200),
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(capturedName).toBeTruthy();
    expect((capturedName as string).length).toBeLessThanOrEqual(MAX_API_KEY_NAME_LENGTH);
    // The marker survives the clamp — it is the tail, and it is the recovery handle.
    expect(capturedName).toMatch(/mcp-mint-[0-9a-f]{12}\]$/);
    expect(spy.mock.calls.flat().join(" ")).toContain("mcp-mint-");
  });

  it("advertises a label limit the server will actually accept", () => {
    // An advertised maximum the API refuses is worse than a smaller honest one:
    // the tool's schema previously said 64 while ~19 was the real ceiling.
    const longestName = `${"x".repeat(MAX_API_KEY_LABEL_LENGTH)} [mcp-mint-123456789012]`;
    expect(longestName.length).toBe(MAX_API_KEY_NAME_LENGTH);
  });
});

describe("generateApiKey — post-mint failures keep the credential recoverable", () => {
  it("returns the minted secrets when the space does not match", async () => {
    const outcome = await mint(mintHarness({}), "sp_WRONG");

    const failed = incomplete(outcome);
    expect(failed.stage).toBe("space-check");
    // The whole point: the one-time values survive the failure.
    expect(failed.credential.apiKey).toBe("hbr_minted_once");
    expect(failed.credential.privateKey).toBe("suiprivkey1child");
    expect(failed.credential.keyId).toBe("key_1");
    // And it reports the space it actually landed in, not the one asked for.
    expect(failed.credential.spaceId).toBe("sp_1");
    expect(failed.reason).toContain("sp_WRONG");
  });

  it("returns the minted secrets when the bucket grant fails", async () => {
    const outcome = await mint(
      mintHarness({
        execute: () =>
          Effect.fail(
            new ConsoleAuthError({
              message: "Signature verification failed",
              code: "invalid_api_key",
            }),
          ),
      }),
    );

    const failed = incomplete(outcome);
    expect(failed.stage).toBe("grant");
    expect(failed.credential.apiKey).toBe("hbr_minted_once");
    expect(failed.credential.privateKey).toBe("suiprivkey1child");
  });

  it("keeps the admin-signer hint on a grant failure", async () => {
    // The hint used to ride on a thrown ConsoleAuthError. It must survive the move
    // onto the outcome, because a wrong admin signer is the likeliest cause here
    // and the message is the only thing that points at it.
    const outcome = await mint(
      mintHarness({
        execute: () =>
          Effect.fail(
            new ConsoleAuthError({
              message: "Signature verification failed",
              code: "invalid_api_key",
            }),
          ),
      }),
    );

    const failed = incomplete(outcome);
    expect(failed.reason).toContain("Signature verification failed");
    expect(failed.reason).toContain("CONSOLE_ADMIN_SERVICE_PRIVATE_KEY");
  });

  it("returns the minted secrets when the activation poll errors", async () => {
    const outcome = await mint(
      mintHarness({
        minted: { status: "registering" as never },
        status: () =>
          Effect.fail(new ConsoleAuthError({ message: "boom", code: "invalid_api_key" })),
      }),
    );

    const failed = incomplete(outcome);
    expect(failed.stage).toBe("activation");
    expect(failed.credential.apiKey).toBe("hbr_minted_once");
  });

  it("tells the caller not to retry, because a retry mints a second orphan", async () => {
    const outcome = await mint(mintHarness({}), "sp_WRONG");

    const failed = incomplete(outcome);
    expect(failed.recovery).toMatch(/do not|don't|without retry|already exists/i);
    expect(failed.recovery).toContain("key_1");
  });
});

describe("generateApiKey — pre-mint failures still fail", () => {
  it("fails outright when the mint itself is rejected", async () => {
    // Nothing was created, so there is nothing to hand back — this must stay on the
    // error channel rather than becoming a partial success with no credential.
    const stubApi = {
      createApiKey: () =>
        Effect.fail(new ConsoleAuthError({ message: "nope", code: "invalid_api_key" })),
      sponsorGrantBucketAccess: () => Effect.die("must not run"),
      executeSponsored: () => Effect.die("must not run"),
      getApiKeyStatus: () => Effect.die("must not run"),
    } as unknown as ConsoleApiClient;

    const stubSeal = {
      generateChildKeypair: () => Effect.succeed(CHILD),
      signTransactionBytes: () => Effect.succeed({ signature: "c2lnbmF0dXJl" }),
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

    expect(error._tag).toBe("ConsoleAuthError");
  });
});

describe("generateApiKey — failures that are not typed errors", () => {
  it("keeps the credential when a post-mint step DIES rather than failing", async () => {
    // Effect.either would not have caught this. getApiKeyStatus casts its body with
    // `as ApiKeyStatusResponse`, so an unexpected payload throws a TypeError inside
    // the generator — a defect, not a failure — and that used to sail past the
    // handler and reject, destroying the credential.
    const outcome = await mint(
      mintHarness({
        minted: { status: "registering" as never },
        status: () => Effect.succeed(undefined as never), // -> res.data is undefined
      }),
    );

    const failed = incomplete(outcome);
    expect(failed.stage).toBe("activation");
    expect(failed.credential.apiKey).toBe("hbr_minted_once");
    expect(failed.credential.privateKey).toBe("suiprivkey1child");
  });

  it("keeps the credential when a post-mint step dies explicitly", async () => {
    const outcome = await mint(
      mintHarness({
        execute: () => Effect.die(new TypeError("unexpected shape")),
      }),
    );

    const failed = incomplete(outcome);
    expect(failed.stage).toBe("grant");
    expect(failed.credential.apiKey).toBe("hbr_minted_once");
    expect(failed.reason).toContain("unexpected shape");
  });
});

describe("generateApiKey — the failure is machine-readable, not just prose", () => {
  it("carries the tag, code and status of a grant rejection", async () => {
    // The caller is told not to retry, so `reason` alone would leave it unable to
    // tell a permanent scope problem from a transient 500.
    const outcome = await mint(
      mintHarness({
        execute: () =>
          Effect.fail(
            new ConsoleApiError({
              message: "forbidden",
              code: "insufficient_scope",
              status: 403,
            }),
          ),
      }),
    );

    const failed = incomplete(outcome);
    expect(failed.detail).toEqual({
      tag: "ConsoleApiError",
      code: "insufficient_scope",
      status: 403,
    });
  });

  it("omits detail entirely when the failure carried none", async () => {
    const outcome = await mint(mintHarness({}), "sp_WRONG");

    const failed = incomplete(outcome);
    // A space mismatch is our own check, not a transport error — inventing an
    // empty object here would imply structure that does not exist.
    expect(failed.detail).toBeUndefined();
  });
});
