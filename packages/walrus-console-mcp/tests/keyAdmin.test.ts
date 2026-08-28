import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConsoleConfig, ConsoleConfigTag, hasAdminCredential } from "../src/config";
import { getConfigDir } from "../src/configFile.js";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleApiError, ConsoleAuthError } from "../src/console/errors";
import {
  type GenerateApiKeyOutcome,
  KeyAdminService,
  MAX_API_KEY_LABEL_LENGTH,
  MAX_API_KEY_NAME_LENGTH,
  pollUntilActive,
} from "../src/console/KeyAdminService";
import * as mintedCredentialStore from "../src/console/mintedCredentialStore.js";
import { SealCryptoService } from "../src/console/SealCryptoService";
import { clearSecrets, REDACTION_PLACEHOLDER, redactString } from "../src/redaction.js";

// Wraps ONLY `persistMintedCredential` and `mintedCredentialFilePath` in
// `vi.fn`s whose default implementation delegates to the real function —
// mirrors tests/atomicWrite.test.ts's `vi.mock("node:fs", ...)` pattern.
// Every other test in this file relies on the real filesystem behavior
// (default pass-through); only the restored-guard test below overrides
// either function, and only for that one call.
vi.mock("../src/console/mintedCredentialStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/console/mintedCredentialStore.js")>();
  return {
    ...actual,
    mintedCredentialFilePath: vi.fn(actual.mintedCredentialFilePath),
    persistMintedCredential: vi.fn(actual.persistMintedCredential),
  };
});

/**
 * generateApiKey now persists to disk as part of the mint (see
 * KeyAdminService.ts), so these tests need a real, isolated config dir —
 * mirroring the XDG-override pattern in tests/mintedCredentialStore.test.ts.
 */
let tmpDir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-keyadmin-test-"));
  originalEnv = { ...process.env };
  process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
});

afterEach(() => {
  // Some tests deliberately lock the config dir down (0o500) to force a
  // persist failure; restore before cleanup so rmSync can actually remove it.
  const configDir = getConfigDir();
  if (fs.existsSync(configDir)) fs.chmodSync(configDir, 0o700);
  process.env = originalEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Read a persisted credential file's secrets back off disk. */
function readCredentialSecrets(credentialFile: string): { apiKey: string; privateKey: string } {
  const parsed = JSON.parse(fs.readFileSync(credentialFile, "utf-8")) as {
    apiKey: string;
    privateKey: string;
  };
  return { apiKey: parsed.apiKey, privateKey: parsed.privateKey };
}

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
  // Widened to `string` (not the literal `"read_write"`) and `private_buckets`
  // widened to allow `null`, so `mintHarness`'s `over.minted` override can
  // exercise the final review round's two regressions: an unrecognized
  // permission value, and a missing/null private_buckets — see the
  // "an unrecognized permissions value" and "private_buckets missing from the
  // response" describe blocks below.
  permissions: "read_write" as string,
  service_signer_address: "0xchild",
  status: "active" as const,
  expected_permission: null,
  private_buckets: [{ bucket_id: "b1", group_id: "g1" }] as
    | readonly {
        bucket_id: string;
        group_id: string;
      }[]
    | null,
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
 * Assert the mint did not complete, and narrow to the post-mint-failure branch
 * (not the `stage: "persist"` or `stage: "mint"` branches, neither of which has
 * a `credential` field at all). `expect(ok).toBe(false)` proves it at runtime
 * but tells the compiler nothing, and the fields worth checking live only on
 * this branch.
 */
function incomplete(outcome: GenerateApiKeyOutcome) {
  if (outcome.ok) throw new Error("expected an incomplete mint, got a successful one");
  if (outcome.stage === "persist" || outcome.stage === "mint") {
    throw new Error(
      `expected a post-mint failure, got a "${outcome.stage}" failure: ${outcome.reason}`,
    );
  }
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
  it("reports ok and returns a pointer to the persisted credential", async () => {
    const outcome = await mint(mintHarness({}));

    if (!outcome.ok) throw new Error(`expected a successful mint: ${outcome.reason}`);
    // Prove the secrets genuinely reached disk, not just that a field exists.
    expect(typeof outcome.credential.credentialFile).toBe("string");
    const secrets = readCredentialSecrets(outcome.credential.credentialFile);
    expect(secrets.apiKey).toBe("hbr_minted_once");
    expect(secrets.privateKey).toBe("suiprivkey1child");
    expect(outcome.credential.keyId).toBe("key_1");
    expect(outcome.credential.privateBuckets).toEqual([{ bucketId: "b1", groupId: "g1" }]);
  });
});

/**
 * Final whole-branch review (medium) — `permissions` staying a strict
 * `z.enum(["read_only", "read_write"])` defeated the two-tier schema design:
 * `z.object` fails the WHOLE body on ANY single field failing, so a third
 * permission tier (or a case/format change) would route an otherwise-perfect
 * 201 into `stage: "mint"`, discarding the `hbr_` value and child private key
 * before `secrets` is even built. `permissions` is pure pass-through display
 * data (`GenerateApiKeyResult.permission`) — nothing branches on it — so this
 * pins that the mint still succeeds and the secrets still reach disk.
 */
describe("generateApiKey — an unrecognized permissions value does not orphan the mint (final review)", () => {
  it("still succeeds and persists secrets when Console echoes a permission value outside today's known enum", async () => {
    const outcome = await mint(
      mintHarness({ minted: { permissions: "some_future_tier_console_added_later" } }),
    );

    if (!outcome.ok) throw new Error(`expected a successful mint: ${outcome.reason}`);
    const secrets = readCredentialSecrets(outcome.credential.credentialFile);
    expect(secrets.apiKey).toBe("hbr_minted_once");
    expect(secrets.privateKey).toBe("suiprivkey1child");
    // Echoes Console's raw string — must NOT silently claim a known tier the
    // key might not actually have.
    expect(outcome.credential.permission).toBe("some_future_tier_console_added_later");
    expect(outcome.credential.permission).not.toBe("read_only");
    expect(outcome.credential.permission).not.toBe("read_write");
  });
});

/**
 * Final whole-branch review (low) — round 2's `private_buckets:
 * ...nullish().transform(v => v ?? [])` fix over-corrected: it made a missing
 * field indistinguishable from an explicit `[]`, so `minted.private_buckets
 * .length > 0` silently skipped the grant step for BOTH "this space has no
 * private buckets" and "we don't know" — and if `status` was already
 * `"active"`, the caller got `ok: true` with `privateBuckets: []` and no hint
 * that grants were ever skipped. This pins the chosen fix: an absent/null
 * `private_buckets` still persists the secrets (that half of round 2 must not
 * regress) but routes to a distinct `stage: "private-buckets-unknown"`
 * rather than `ok: true` — see `GenerateApiKeyOutcome`'s existing
 * `PostPersistStage` union member, which already accommodates any
 * `MintStage` value without a new branch.
 */
describe("generateApiKey — private_buckets missing from the response (final review)", () => {
  it('reports stage:"private-buckets-unknown" (not ok:true) while still persisting the secrets', async () => {
    const outcome = await mint(mintHarness({ minted: { private_buckets: null } }));

    const failed = incomplete(outcome);
    expect(failed.stage).toBe("private-buckets-unknown");
    expect(failed.reason).toMatch(/private_buckets/);
    const secrets = readCredentialSecrets(failed.credential.credentialFile);
    expect(secrets.apiKey).toBe("hbr_minted_once");
    expect(secrets.privateKey).toBe("suiprivkey1child");
  });

  it("still proceeds normally (ok:true) when private_buckets is an explicit empty array", async () => {
    const outcome = await mint(mintHarness({ minted: { private_buckets: [] } }));

    if (!outcome.ok) throw new Error(`expected a successful mint: ${outcome.reason}`);
    expect(outcome.credential.privateBuckets).toEqual([]);
  });

  /**
   * Coordinator correction, final review — end-to-end through the REAL
   * `ConsoleApiClient` (not the hand-built `mintHarness` stub, which bypasses
   * schema parsing entirely), so this exercises the actual chain: a 201 whose
   * `private_buckets` array has one good element and one malformed element
   * parses to `null` at the schema boundary (see
   * `consoleApiClient.keyAdmin.test.ts`'s equivalent test), and
   * `KeyAdminService` must react to that `null` the same way it does to a
   * missing field: `stage: "private-buckets-unknown"`, not `ok: true`, with
   * secrets already durable on disk.
   */
  it('wires a mix of good and bad private_buckets elements through the real schema to stage:"private-buckets-unknown"', async () => {
    const stubHttp = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              id: "key_1",
              key: "hbr_minted_once",
              space_id: "sp_1",
              permissions: "read_write",
              status: "active",
              private_buckets: [
                { bucket_id: "b1", group_id: "0xgoodgroup" },
                { bucket_id: "b2" }, // missing group_id — malformed element
              ],
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );

    const stubSeal = {
      generateChildKeypair: () => Effect.succeed(CHILD),
      signTransactionBytes: () => Effect.succeed({ signature: "c2lnbmF0dXJl" }),
    } as unknown as SealCryptoService;

    const layer = KeyAdminService.DefaultWithoutDependencies.pipe(
      Layer.provide(
        Layer.mergeAll(
          ConsoleApiClient.Default.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(HttpClient.HttpClient, stubHttp),
                Layer.succeed(
                  ConsoleConfigTag,
                  makeConfig({ adminKey: "hbradm_x", adminServicePrivateKey: "suiprivkey1a" }),
                ),
              ),
            ),
          ),
          Layer.succeed(SealCryptoService, stubSeal),
          Layer.succeed(
            ConsoleConfigTag,
            makeConfig({ adminKey: "hbradm_x", adminServicePrivateKey: "suiprivkey1a" }),
          ),
        ),
      ),
    );

    const outcome = await mint(layer);

    const failed = incomplete(outcome);
    expect(failed.stage).toBe("private-buckets-unknown");
    const secrets = readCredentialSecrets(failed.credential.credentialFile);
    expect(secrets.apiKey).toBe("hbr_minted_once");
    expect(secrets.privateKey).toBe("suiprivkey1child");
  });
});

describe("generateApiKey — minted secrets are registered for redaction (F2)", () => {
  afterEach(() => {
    clearSecrets();
  });

  it("registers the minted apiKey and privateKey so they redact out of any later output", async () => {
    const outcome = await mint(mintHarness({}));
    if (!outcome.ok) throw new Error(`expected a successful mint: ${outcome.reason}`);
    const secrets = readCredentialSecrets(outcome.credential.credentialFile);

    expect(redactString(`leaked ${secrets.apiKey} and ${secrets.privateKey}`)).toBe(
      `leaked ${REDACTION_PLACEHOLDER} and ${REDACTION_PLACEHOLDER}`,
    );
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
  it("returns a pointer to the minted secrets when the space does not match", async () => {
    const outcome = await mint(mintHarness({}), "sp_WRONG");

    const failed = incomplete(outcome);
    expect(failed.stage).toBe("space-check");
    // The whole point: the one-time values survive the failure — on disk.
    expect(typeof failed.credential.credentialFile).toBe("string");
    const secrets = readCredentialSecrets(failed.credential.credentialFile);
    expect(secrets.apiKey).toBe("hbr_minted_once");
    expect(secrets.privateKey).toBe("suiprivkey1child");
    expect(failed.credential.keyId).toBe("key_1");
    // And it reports the space it actually landed in, not the one asked for.
    expect(failed.credential.spaceId).toBe("sp_1");
    expect(failed.reason).toContain("sp_WRONG");
  });

  it("returns a pointer to the minted secrets when the bucket grant fails", async () => {
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
    const secrets = readCredentialSecrets(failed.credential.credentialFile);
    expect(secrets.apiKey).toBe("hbr_minted_once");
    expect(secrets.privateKey).toBe("suiprivkey1child");
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

  it("returns a pointer to the minted secrets when the activation poll errors", async () => {
    const outcome = await mint(
      mintHarness({
        minted: { status: "registering" as never },
        status: () =>
          Effect.fail(new ConsoleAuthError({ message: "boom", code: "invalid_api_key" })),
      }),
    );

    const failed = incomplete(outcome);
    expect(failed.stage).toBe("activation");
    expect(readCredentialSecrets(failed.credential.credentialFile).apiKey).toBe("hbr_minted_once");
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

/**
 * F1 (from the code-review pass on Tasks 1-3 together) — `createApiKey`'s 201
 * is Console's own point of no return, so a 201 whose BODY fails Zod
 * validation must not behave like "nothing was created": it must stay on the
 * SUCCESS channel (a `stage: "mint"` outcome), the same way every other
 * post-mint failure does, instead of rejecting and inviting a retry that
 * orphans a second key.
 */
describe("generateApiKey — the 201 arrived but its body failed validation (F1)", () => {
  it('resolves to stage:"mint" with no credential, naming the marker, instead of rejecting', async () => {
    let capturedName: string | undefined;
    const stubApi = {
      createApiKey: (a: { name?: string }) => {
        capturedName = a.name;
        return Effect.fail(
          new ConsoleApiError({
            message: "createApiKey received a 201 response that failed validation: id: Required",
            code: "invalid_response_shape",
            status: 201,
          }),
        );
      },
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

    // Must RESOLVE, never reject: a rejection here surfaces as isError:true
    // and invites exactly the retry that orphans a second key (see
    // GenerateApiKeyOutcome's doc comment).
    const outcome = await mint(layer);

    if (outcome.ok || outcome.stage !== "mint") {
      throw new Error(`expected a "mint" stage failure, got: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.reason).toContain("id: Required");
    expect(capturedName).toMatch(/mcp-mint-/);
    const marker = capturedName?.match(/mcp-mint-[0-9a-f]+/)?.[0];
    expect(marker).toBeTruthy();
    expect(outcome.marker).toBe(marker);
    expect(outcome.recovery).toContain(marker as string);
    expect(outcome.recovery).toMatch(/do not|don't/i);
    // No `credential` field on this branch at all — nothing was, or could
    // have been, persisted: the response that would carry id/key/space_id is
    // exactly what failed to validate.
    expect("credential" in outcome).toBe(false);
  });

  it("still fails outright for a ConsoleApiError that is NOT the response-validation code", async () => {
    // Only "invalid_response_shape" is converted. Any other ConsoleApiError
    // from createApiKey (a genuine 4xx from handleError) means the mint
    // itself was rejected — nothing exists server-side — so it must stay on
    // the error channel, same as the ConsoleAuthError case above.
    const stubApi = {
      createApiKey: () =>
        Effect.fail(
          new ConsoleApiError({ message: "forbidden", code: "insufficient_scope", status: 403 }),
        ),
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

    expect(error).toBeInstanceOf(ConsoleApiError);
    expect((error as ConsoleApiError).code).toBe("insufficient_scope");
  });

  /**
   * R3 (round-2 review) — `code` alone is not a safe discriminant. Console's
   * own error body — or a compromised endpoint, a threat this codebase
   * already models — controls the `code` string on a genuine non-2xx
   * response just as much as on the self-synthesized 201-validation failure.
   * `handleError` copies that `code` verbatim into `ConsoleApiError.code`, so
   * a 400 forging `{"error":{"code":"invalid_response_shape"}}` would match
   * the predicate on `code` alone despite NOTHING having been minted. Only
   * `error.status === 201` (which `handleError` can never produce — it only
   * runs for a non-2xx response) proves this really is the self-synthesized
   * failure.
   */
  it("still fails outright for a 400 that forges the invalid_response_shape code — nothing was minted", async () => {
    const stubApi = {
      createApiKey: () =>
        Effect.fail(
          new ConsoleApiError({
            message: "bad request",
            code: "invalid_response_shape", // forged by a hostile/compromised endpoint
            status: 400, // NOT 201 — the mint itself was rejected
          }),
        ),
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

    // Must FAIL (reject), never resolve to a stage:"mint" outcome — a 400
    // means the mint was refused, so there is no orphaned key to warn about,
    // and a false "do NOT retry" here would permanently block a mint that
    // never happened.
    const error = await Effect.runPromise(
      KeyAdminService.pipe(
        Effect.flatMap((svc) => svc.generateApiKey({ spaceId: "sp_1", permission: "read_write" })),
        Effect.flip,
        Effect.provide(layer),
      ),
    );

    expect(error).toBeInstanceOf(ConsoleApiError);
    expect((error as ConsoleApiError).code).toBe("invalid_response_shape");
    expect((error as ConsoleApiError).status).toBe(400);
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
    const secrets = readCredentialSecrets(failed.credential.credentialFile);
    expect(secrets.apiKey).toBe("hbr_minted_once");
    expect(secrets.privateKey).toBe("suiprivkey1child");
  });

  it("keeps the credential when a post-mint step dies explicitly", async () => {
    const outcome = await mint(
      mintHarness({
        execute: () => Effect.die(new TypeError("unexpected shape")),
      }),
    );

    const failed = incomplete(outcome);
    expect(failed.stage).toBe("grant");
    expect(readCredentialSecrets(failed.credential.credentialFile).apiKey).toBe("hbr_minted_once");
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

/**
 * Coverage for the persist-failure branch, replacing what
 * tests/mintedCredentialStore.test.ts used to cover for its now-deleted
 * MCP-boundary persist adapter, before persist moved into `generateApiKey` itself.
 */
describe("generateApiKey — the mint succeeds but its secrets cannot be saved to disk", () => {
  it('reports stage:"persist" with no credential, and logs a breadcrumb naming the keyId but neither secret', async () => {
    const configDir = getConfigDir();
    fs.mkdirSync(configDir, { recursive: true });
    // The write failure is injected through the `persistMintedCredential` spy
    // this file already installs, NOT by chmod-ing the config dir 0o500: root
    // bypasses DAC entirely, so a mode-bit injection is a no-op for uid 0 and
    // the assertions below fail in any privileged container. Same reason the
    // other write-failure tests in this suite use a seam (finding m2).
    vi.mocked(mintedCredentialStore.persistMintedCredential).mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await mint(mintHarness({}));

    if (outcome.ok || outcome.stage !== "persist") {
      throw new Error(`expected a persist failure, got: ${JSON.stringify(outcome)}`);
    }
    // The one remaining handle on the orphaned key — no `credential` field
    // exists on this branch at all (a write failure means there is nothing to
    // point at).
    expect(outcome.keyId).toBe("key_1");
    expect(outcome.spaceId).toBe("sp_1");
    expect(typeof outcome.attemptedPath).toBe("string");
    expect(outcome.recovery).toMatch(/do not|don't/i);

    const logged = spy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain("key_1");
    expect(logged).not.toContain("hbr_minted_once");
    expect(logged).not.toContain("suiprivkey1child");

    spy.mockRestore();
  });

  /**
   * Coordinator review, final follow-up — the now-deleted `persistAndRedactOutcome`
   * (see facfeb3f's commit message) carried a guard for exactly this hazard,
   * and Task 3b's move of persist into `generateApiKey` dropped the guard along
   * with the function it lived in. `persistMintedCredential` computes
   * `mintedCredentialFilePath(secrets.keyId)` internally before it ever touches
   * the filesystem — so if THAT computation is what made `persistMintedCredential`
   * throw (e.g. `getConfigDir()` -> `os.homedir()` throwing `ERR_SYSTEM_ERROR`
   * when `HOME` is unset and the passwd lookup also fails), recomputing the
   * same path a second time in the catch block, unguarded, would throw the
   * identical error again — now escaping the try/catch entirely and losing the
   * whole `stage: "persist"` outcome to an uncaught rejection. This pins that
   * the recomputation is now wrapped, so the persist-failure outcome survives
   * even when path computation itself is what's broken.
   */
  it('still reports stage:"persist" (not a rejection) when recomputing attemptedPath ALSO throws', async () => {
    const rootCause = Object.assign(new Error("homedir lookup failed"), {
      code: "ERR_SYSTEM_ERROR",
    });
    vi.mocked(mintedCredentialStore.persistMintedCredential).mockImplementationOnce(() => {
      throw rootCause;
    });
    vi.mocked(mintedCredentialStore.mintedCredentialFilePath).mockImplementationOnce(() => {
      throw rootCause;
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await mint(mintHarness({}));

    if (outcome.ok || outcome.stage !== "persist") {
      throw new Error(`expected a persist failure, got: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.keyId).toBe("key_1");
    expect(outcome.spaceId).toBe("sp_1");
    expect(outcome.reason).toBe("homedir lookup failed");
    expect(outcome.attemptedPath).toContain("no path computed");
    expect(outcome.recovery).toMatch(/do not|don't/i);

    spy.mockRestore();
  });
});

/**
 * F2 — two private buckets can share one access group (bucket_id differs,
 * group_id doesn't). Before the dedupe fix, `grantBucketAccess` asked Console
 * for that group twice, Console legitimately built two `add_editor` calls for
 * it, and `assertGrantBucketAccessStructure`'s exact-once coverage check then
 * refused the PTB — a mint failure at stage "grant" for a completely
 * legitimate transaction.
 */
describe("generateApiKey — a shared access group across two buckets does not break the grant (F2)", () => {
  it("asks Console for each group only once, and still succeeds", async () => {
    let capturedGroupIds: readonly string[] | undefined;

    const mintedWithSharedGroup = {
      ...MINTED,
      // Two DIFFERENT buckets, same group — the realistic case: a space owner
      // grouped several buckets under one access group.
      private_buckets: [
        { bucket_id: "b1", group_id: "g1" },
        { bucket_id: "b2", group_id: "g1" },
      ],
    };

    const stubApi = {
      createApiKey: () => Effect.succeed(mintedWithSharedGroup),
      sponsorGrantBucketAccess: (args: { groupIds: readonly string[] }) => {
        capturedGroupIds = args.groupIds;
        return Effect.succeed({ bytes: "AAAA", digest: "0xdigest" });
      },
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

    const outcome = await mint(layer);

    if (!outcome.ok) throw new Error(`expected a successful mint: ${outcome.reason}`);
    // The ask was deduped to one entry...
    expect(capturedGroupIds).toEqual(["g1"]);
    // ...but dedupe must apply ONLY to the grant request, not to what the
    // caller is told about their own buckets: both buckets still show up,
    // each correctly pointing at the shared group.
    expect(outcome.credential.privateBuckets).toEqual([
      { bucketId: "b1", groupId: "g1" },
      { bucketId: "b2", groupId: "g1" },
    ]);
  });
});

/**
 * R4 (round-2 review) — the F2 dedupe above collapsed on the RAW string,
 * which `assertGrantBucketAccessStructure` (txValidation.ts) does not: it
 * normalizes every id before comparing. Two textually different but
 * equivalent forms of the same group (a leading zero, or case) would survive
 * a raw-string `Set` as two distinct entries, resurrecting the exact
 * duplicate-request bug F2 fixed — just reached through normalization
 * instead of a literal repeat.
 */
describe("generateApiKey — grant dedupe collapses equivalent group id forms, not just identical strings (R4)", () => {
  it("dedupes on the normalized address when two buckets' group ids differ only in form", async () => {
    let capturedGroupIds: readonly string[] | undefined;

    const mintedWithEquivalentGroupForms = {
      ...MINTED,
      private_buckets: [
        { bucket_id: "b1", group_id: "0x0ab12" }, // leading zero
        { bucket_id: "b2", group_id: "0xAB12" }, // same address: no leading zero, different case
      ],
    };

    const stubApi = {
      createApiKey: () => Effect.succeed(mintedWithEquivalentGroupForms),
      sponsorGrantBucketAccess: (args: { groupIds: readonly string[] }) => {
        capturedGroupIds = args.groupIds;
        return Effect.succeed({ bytes: "AAAA", digest: "0xdigest" });
      },
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

    const outcome = await mint(layer);

    if (!outcome.ok) throw new Error(`expected a successful mint: ${outcome.reason}`);
    // Deduped to exactly one entry, even though the two raw strings differ.
    expect(capturedGroupIds).toHaveLength(1);
  });
});
