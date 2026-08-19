import { Cause, Duration, Effect, Exit } from "effect";
import { ConsoleConfigLive, ConsoleConfigTag, hasAdminCredential } from "../config";
import type { ApiKeyPermission, ApiKeyStatusResponse } from "./ConsoleApiClient";
import { ConsoleApiClient } from "./ConsoleApiClient";
import { AdminCredentialMissingError, ConsoleApiError, ConsoleAuthError } from "./errors";
import { SealCryptoService } from "./SealCryptoService";

/**
 * KeyAdminService — headless minting of Console working keys (Approach B).
 *
 * Minting power lives in the isolated Key-Admin credential (CONSOLE_ADMIN_KEY +
 * CONSOLE_ADMIN_SERVICE_PRIVATE_KEY). An ordinary working key cannot mint.
 *
 * End-to-end flow (modeled on ConsoleStorageService.createBucket's reserve→sign→finalize
 * and uploadFileToBucket's poll loop):
 *   generate child keypair → createApiKey → (if private buckets) sponsor grant_bucket_access
 *   → sign with the ADMIN seed → executeSponsored → poll until "active" → return child credential.
 *
 * The admin seed never leaves the host; all four secrets stay Redacted.
 */

const ADMIN_MISSING_MESSAGE =
  "generate_api_key requires a Key-Admin credential. " +
  "Set CONSOLE_ADMIN_KEY (hbradm_…) and CONSOLE_ADMIN_SERVICE_PRIVATE_KEY. " +
  "A working key cannot mint.";

// Poll cadence for child-key activation: ~30s budget at a 2s interval.
const POLL_INTERVAL = Duration.seconds(2);
const POLL_MAX_ATTEMPTS = 15;

const ADMIN_SIGNER_HINT =
  "CONSOLE_ADMIN_SERVICE_PRIVATE_KEY may not be the signer registered for CONSOLE_ADMIN_KEY.";

const withHint = (message: string) => `${message} ${ADMIN_SIGNER_HINT}`;

export interface GenerateApiKeyResult {
  readonly apiKey: string; // hbr_… — shown once
  readonly privateKey: string; // suiprivkey1… — shown once
  readonly permission: ApiKeyPermission;
  readonly spaceId: string;
  readonly keyId: string;
  readonly privateBuckets: readonly { bucketId: string; groupId: string }[];
}

/** Which post-mint step failed. Named for the caller, not for the code path. */
export type MintStage = "space-check" | "grant" | "activation";

/**
 * The machine-readable half of a post-mint failure.
 *
 * `reason` is prose, and prose is not enough here: the caller is explicitly told
 * NOT to retry, so `reason` would otherwise be its only signal for a decision it
 * cannot revisit. A 403 `insufficient_scope` (permanent — this admin credential
 * can never grant those groups) and a 500 (transient — a human could re-run the
 * grant) are the same sentence to a reader and completely different situations.
 */
export interface MintFailureDetail {
  /** The tagged error's `_tag`, when the failure carried one. */
  readonly tag?: string;
  /** Console's own error code, e.g. "insufficient_scope". */
  readonly code?: string;
  readonly status?: number;
}

/**
 * The result of a mint attempt.
 *
 * `createApiKey` is a point of no return: from the moment it returns, a key
 * exists server-side and its `hbr_` value has been shown for the only time it
 * ever will be. Everything after it — the space check, the bucket grant, the
 * activation poll — can still fail, and none of those failures can un-mint it.
 *
 * So post-mint failures are NOT errors here. They come back as `ok: false`
 * carrying the credential, because the alternative is destroying the only copy
 * of a secret that still controls a live key.
 *
 * There is no programmatic way back from that. `/api/v1/api-keys` answers 403
 * "This endpoint requires session authentication" to BOTH the working key and
 * the Key-Admin key, so a key whose credential was thrown away can be neither
 * enumerated nor revoked from here — only from the Console UI, by a human who
 * first has to work out that it exists.
 *
 * They stay on the SUCCESS channel deliberately, even though F9 otherwise wants
 * failures flagged with `isError`. An `isError` result invites the one response
 * that makes this strictly worse: a retry, which mints a *second* orphan. A
 * caller must read `ok` and act on `recovery`, not re-run the tool.
 */
export type GenerateApiKeyOutcome =
  | { readonly ok: true; readonly credential: GenerateApiKeyResult }
  | {
      readonly ok: false;
      readonly stage: MintStage;
      /** What went wrong, carrying the original message. */
      readonly reason: string;
      /** Structured form of the same failure, when it carried one. */
      readonly detail?: MintFailureDetail;
      /** The one-time secrets. Present precisely because the step after them failed. */
      readonly credential: GenerateApiKeyResult;
      /** What the caller must do now — and what it must not do. */
      readonly recovery: string;
    };

/** Terminal result of waiting for a minted key to register. */
export type ActivationOutcome =
  | { readonly kind: "active" }
  | {
      readonly kind: "stalled";
      readonly status: string;
      readonly progress?: { granted: number; total: number };
    };

/**
 * Poll until the minted key reports "active", or the budget runs out.
 *
 * Exported with its cadence as parameters for the same reason `pollUntilTerminal`
 * is: the budget and the active/stalled decision are worth asserting without
 * waiting out a real 30-second registration.
 *
 * Running out is NOT an error here. The key exists either way; "stalled" only
 * means registration had not landed yet, and the caller needs its credential
 * regardless.
 */
export const pollUntilActive = <E, R>(
  initialStatus: string,
  getStatus: () => Effect.Effect<ApiKeyStatusResponse, E, R>,
  attempts: number = POLL_MAX_ATTEMPTS,
  interval: Duration.DurationInput = POLL_INTERVAL,
): Effect.Effect<ActivationOutcome, E, R> =>
  Effect.gen(function* () {
    let status = initialStatus;
    let progress: { granted: number; total: number } | undefined;
    for (let attempt = 0; attempt < attempts && status !== "active"; attempt++) {
      yield* Effect.sleep(interval);
      const res = yield* getStatus();
      status = res.data.status;
      progress = res.data.registration_progress;
    }
    if (status === "active") return { kind: "active" as const };
    return { kind: "stalled" as const, status, ...(progress ? { progress } : {}) };
  });

/**
 * Best-effort human-readable message from an unknown failure.
 *
 * The post-mint path turns errors into prose on the outcome, so the original
 * message has to survive the conversion — it is often the only thing that names
 * the actual cause.
 */
function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const { message } = error as { message?: unknown };
    if (typeof message === "string" && message) return message;
  }
  return String(error);
}

/** The typed failure inside a cause, if it carried one rather than a defect. */
const failureOf = (cause: Cause.Cause<unknown>): unknown => {
  const failure = Cause.failureOption(cause);
  if (failure._tag === "Some") return failure.value;
  const defect = Cause.dieOption(cause);
  return defect._tag === "Some" ? defect.value : undefined;
};

function causeMessage(cause: Cause.Cause<unknown>): string {
  const error = failureOf(cause);
  // Cause.pretty is the fallback for a cause carrying neither — an interrupt, or
  // several failures at once — so the outcome never reports an empty reason.
  return error === undefined ? Cause.pretty(cause) : messageOf(error);
}

function causeDetail(cause: Cause.Cause<unknown>): MintFailureDetail | undefined {
  const error = failureOf(cause);
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as { _tag?: unknown; code?: unknown; status?: unknown };
  const detail: MintFailureDetail = {
    ...(typeof e._tag === "string" ? { tag: e._tag } : {}),
    ...(typeof e.code === "string" ? { code: e.code } : {}),
    ...(typeof e.status === "number" ? { status: e.status } : {}),
  };
  return Object.keys(detail).length > 0 ? detail : undefined;
}

export class KeyAdminService extends Effect.Service<KeyAdminService>()("KeyAdminService", {
  effect: Effect.gen(function* () {
    const api = yield* ConsoleApiClient;
    const seal = yield* SealCryptoService;
    const config = yield* ConsoleConfigTag;

    /**
     * The sponsored grant_bucket_access PTB: one transaction covering every group,
     * signed with the ADMIN seed (never the working key).
     *
     * Split out so the mint flow can run it under `Effect.either` — a failure here
     * must become a recoverable outcome, not a thrown error that discards the
     * credential the caller has already been charged for.
     */
    const grantBucketAccess = Effect.fn("KeyAdminService.grantBucketAccess")(function* (
      minted: { id: string; private_buckets: readonly { group_id: string }[] },
      childAddress: string,
      scope: "read" | "readwrite",
    ) {
      const groupIds = minted.private_buckets.map((b) => b.group_id);
      const sponsor = yield* api.sponsorGrantBucketAccess({
        groupIds,
        recipientAddress: childAddress,
        scope,
      });
      // Validated against exactly what was requested before the ADMIN key signs:
      // the scope (so a `read` grant cannot come back as `add_editor`), the
      // groups, and the recipient (so access cannot be redirected to a third
      // party while the response still looks like our own grant).
      const signature = yield* seal.signTransactionBytes(
        sponsor.bytes,
        { kind: "grantBucketAccess", recipientAddress: childAddress, groupIds, scope },
        "admin",
      );
      // A wrong-but-valid admin seed signs the PTB fine — Ed25519 signing doesn't
      // know whose key it "should" be — and only fails once Console checks the
      // signature against the registered signer here at execute time. That
      // failure is easy to misread as a generic API error, so append a hint.
      // Only the two Console-domain error tags get it; anything else (e.g. a
      // transport-level HttpClientError) passes through untouched — a DNS
      // failure isn't a signer problem. The original message is kept as a prefix
      // rather than replaced, and every original field is preserved.
      return yield* api.executeSponsored(sponsor.digest, signature).pipe(
        Effect.catchTags({
          ConsoleApiError: (error) =>
            Effect.fail(
              new ConsoleApiError({
                message: withHint(error.message),
                ...(error.code !== undefined ? { code: error.code } : {}),
                ...(error.status !== undefined ? { status: error.status } : {}),
                ...(error.endpoint !== undefined ? { endpoint: error.endpoint } : {}),
              }),
            ),
          ConsoleAuthError: (error) =>
            Effect.fail(
              new ConsoleAuthError({ message: withHint(error.message), code: error.code }),
            ),
        }),
      );
    });

    const generateApiKey = Effect.fn("KeyAdminService.generateApiKey")(function* (args: {
      spaceId: string;
      permission: ApiKeyPermission;
      label?: string | undefined;
    }) {
      // Guard first — no network mutation happens without the Key-Admin credential.
      if (!hasAdminCredential(config)) {
        return yield* Effect.fail(
          new AdminCredentialMissingError({ message: ADMIN_MISSING_MESSAGE }),
        );
      }

      // 1. Generate a fresh child keypair locally; its address is the mint's signer.
      const child = yield* seal.generateChildKeypair();

      // 2. Ask Console to mint the child hbr_ key under the admin's key_admin scope.
      // The space is derived server-side from the admin credential — args.spaceId is
      // validated below, not used to select the space.
      const minted = yield* api.createApiKey({
        permissions: args.permission,
        serviceSignerAddress: child.address,
        name: args.label,
      });

      // From here down the key EXISTS. Build the credential immediately so every
      // exit below can hand it back — see GenerateApiKeyOutcome for why a failure
      // after this point must not travel on the error channel.
      const credential: GenerateApiKeyResult = {
        apiKey: minted.key,
        privateKey: child.privateKey,
        permission: minted.permissions,
        spaceId: minted.space_id,
        keyId: minted.id,
        privateBuckets: minted.private_buckets.map((b) => ({
          bucketId: b.bucket_id,
          groupId: b.group_id,
        })),
      };

      const incomplete = (
        stage: MintStage,
        reason: string,
        detail?: MintFailureDetail,
      ): GenerateApiKeyOutcome => ({
        ok: false,
        stage,
        reason,
        ...(detail ? { detail } : {}),
        credential,
        recovery:
          `The key ${minted.id} already exists in space ${minted.space_id}, and the values above ` +
          `are the ONLY copy of its secrets — record them now. Do NOT call generate_api_key again ` +
          `to "retry": the mint already succeeded, so a second call mints a second key and orphans ` +
          `this one. There is no API to list or revoke keys (that endpoint requires a browser ` +
          `session), so an orphan can only be cleaned up by hand in the Console UI.`,
      });

      // Which step is running, so a failure caught below can name it. A mutable
      // marker rather than per-step error handling: every post-mint step funnels
      // into ONE exit handler, so there is exactly one place that can drop the
      // credential, instead of one per step.
      let stage: MintStage = "space-check";

      const completion = Effect.gen(function* () {
        // The admin credential scopes the mint to one space, and the space cannot
        // be checked BEFORE minting: the Key-Admin credential has no data-plane
        // access (GET /api/v1/spaces answers 403 "key_admin has no data-plane
        // access"), and the working key's space list would not describe the
        // admin's scope even where a working key exists — which on a provisioning
        // host it need not.
        if (minted.space_id !== args.spaceId) {
          return incomplete(
            "space-check",
            `The Key-Admin credential minted into space ${minted.space_id}, not the requested ` +
              `${args.spaceId}. The key is valid, but for a different space.`,
          );
        }

        // If the space has private buckets, run ONE sponsored grant_bucket_access
        // PTB covering every group, signed with the ADMIN seed (never the working key).
        if (minted.private_buckets.length > 0) {
          stage = "grant";
          const scope = args.permission === "read_write" ? "readwrite" : "read";
          yield* grantBucketAccess(minted, child.address, scope);
        }

        // Poll until the key is active (returns at once when grants already landed
        // or there were no private buckets).
        stage = "activation";
        const activation = yield* pollUntilActive(minted.status, () =>
          api.getApiKeyStatus(minted.id),
        );
        if (activation.kind === "stalled") {
          const { status, progress } = activation;
          return incomplete(
            "activation",
            `The key did not reach "active" within the poll budget (last status: ${status}` +
              `${progress ? `, ${progress.granted}/${progress.total} grants landed` : ""}). ` +
              `Registration may still be in flight.`,
          );
        }

        const done: GenerateApiKeyOutcome = { ok: true, credential };
        return done;
      }).pipe(
        // Interruption is the one failure that cannot be turned into a result.
        // `runPromise` carries the MCP request's AbortSignal, so a client timeout or
        // a cancelled tool call kills this fiber mid-poll — and there is no way to
        // return a value from that: Effect.exit does not shield the continuation,
        // and Effect.uninterruptible does not deliver the value either (runPromise
        // still rejects with "All fibers interrupted"). Both were measured, not
        // assumed. What IS possible is refusing to let the orphan be silent: the
        // key id goes to stderr, the same durable channel the accepted-upload id
        // uses, so a human can find and remove it. The secrets are deliberately NOT
        // logged — stderr outlives the request and ends up in client log files.
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            console.error(
              `[console-mcp] generate_api_key was cancelled after minting key ${minted.id} ` +
                `in space ${minted.space_id}. Its credential could not be delivered and cannot ` +
                `be recovered. The key is live: remove it by hand in the Console UI.`,
            );
          }),
        ),
      );

      // Effect.exit, not Effect.either: `either` only intercepts the typed failure
      // channel, so a DEFECT would sail past it and reject — losing the credential
      // this whole shape exists to preserve. That is not hypothetical here:
      // getApiKeyStatus casts its body with `as ApiKeyStatusResponse`, so an
      // unexpected payload makes `res.data.status` throw a TypeError inside the
      // generator, which becomes a die rather than a failure.
      const exit = yield* Effect.exit(completion);
      if (Exit.isSuccess(exit)) return exit.value;
      return incomplete(stage, causeMessage(exit.cause), causeDetail(exit.cause));
    });

    return { generateApiKey } as const;
  }),

  dependencies: [ConsoleApiClient.Default, SealCryptoService.Default, ConsoleConfigLive],
}) {}
