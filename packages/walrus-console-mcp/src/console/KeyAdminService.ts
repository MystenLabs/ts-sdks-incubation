import * as path from "node:path";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { Cause, Duration, Effect, Exit } from "effect";
import { ConsoleConfigLive, ConsoleConfigTag, hasAdminCredential } from "../config";
import { registerSecret } from "../redaction";
import type { ApiKeyPermission, ApiKeyStatusResponse } from "./ConsoleApiClient";
import { ConsoleApiClient } from "./ConsoleApiClient";
import { AdminCredentialMissingError, ConsoleApiError, ConsoleAuthError } from "./errors";
import { isRevokedKeyCode } from "./revokedKey";
import { mintedCredentialFilePath, persistMintedCredential } from "./mintedCredentialStore";
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

// Exported so bin/console-mcp.ts's pre-flight (asked before the elicitation
// prompt, so a human isn't asked to approve a mint that cannot run) can reuse
// the exact same guard and text this service enforces as defense in depth,
// rather than keeping a second copy of both free to drift.
export const ADMIN_MISSING_MESSAGE =
  "generate_api_key requires a Key-Admin credential. " +
  "Set CONSOLE_ADMIN_KEY (hbradm_…) and CONSOLE_ADMIN_SERVICE_PRIVATE_KEY. " +
  "A working key cannot mint.";

// Poll cadence for child-key activation: ~30s budget at a 2s interval.
const POLL_INTERVAL = Duration.seconds(2);
const POLL_MAX_ATTEMPTS = 15;

const ADMIN_SIGNER_HINT =
  "CONSOLE_ADMIN_SERVICE_PRIVATE_KEY may not be the signer registered for CONSOLE_ADMIN_KEY.";

/** Console's `name` limit on POST /api/v1/api-keys. Longer is a hard 400. */
export const MAX_API_KEY_NAME_LENGTH = 64;

/**
 * Longest `label` a caller may pass, given that the mint marker is appended.
 * Exported so the tool's input schema states the REAL limit instead of one the
 * server will reject — an advertised maximum the API refuses is worse than a
 * smaller honest one.
 */
export const MAX_API_KEY_LABEL_LENGTH = MAX_API_KEY_NAME_LENGTH - " [mcp-mint-123456789012]".length;

/**
 * Keep the composed key name inside Console's limit, preserving the TAIL.
 *
 * The tail is where the marker lives, and the marker is the only way to find a
 * key whose 201 was lost in flight — so if something has to go, it is the
 * operator's label, never the recovery handle.
 */
function clampKeyName(name: string): string {
  if (name.length <= MAX_API_KEY_NAME_LENGTH) return name;
  return name.slice(name.length - MAX_API_KEY_NAME_LENGTH);
}

const withHint = (message: string) => `${message} ${ADMIN_SIGNER_HINT}`;

/**
 * How to undo a mint. Attached to every completed mint, because no credential
 * this client holds can do it, and nothing else in the response says so.
 *
 * A revoke endpoint does exist — `DELETE /api/v1/api-keys/:id` — but it, the key
 * list, and the revocation-plan pre-check are all session-only: they answer 403
 * "This endpoint requires session authentication" to the working key and the
 * Key-Admin key alike. That is not an oversight to route around. Revoking runs an
 * on-chain unshare over the key's buckets, which needs a wallet, which is why it
 * is gated to a browser session. So a human in the Console UI really is the only
 * path from here, and a caller that does not know it will assume a tool call can
 * clean up after itself.
 *
 * Takes the key's NAME rather than naming its id, because the id is not a value
 * the destination renders: the Integrations table lists keys by label and uses
 * the id only as a React key. Guidance built around the id would send an agent
 * hunting for the one field that never appears on screen — so the mint marker
 * lives in the name, and the name is what this points at.
 */
export const revocationGuidance = (keyName: string) =>
  `To revoke this key, open the Console UI → Integrations and delete the key named ` +
  `"${keyName}". Match on that name, NOT on the key id: the Integrations table lists keys by ` +
  `name and never renders the id, which is why the mint marker is embedded in the name. No ` +
  `credential this client holds can list or revoke keys — those endpoints require a browser ` +
  `session — so this is the only way to remove it.`;

/**
 * The raw shape `createApiKey` mints: the one-time secrets plus everything
 * else about the key. NEVER returned from `generateApiKey` — it exists only
 * long enough to be handed to `persistMintedCredential`, which writes it to
 * disk and hands back the pointer shape (`GenerateApiKeyResult`) that IS
 * returned, on every branch.
 */
export interface MintedSecrets {
  readonly apiKey: string; // hbr_… — shown once
  readonly privateKey: string; // suiprivkey1… — shown once
  /**
   * Console's raw `permissions` string, echoed as-is (or
   * `"(not reported by Console)"` — see `createApiKeyResponseSchema`'s doc
   * comment in ConsoleApiClient.ts). NOT `ApiKeyPermission`: that type is the
   * caller's REQUEST, and echoing it back here instead of the response would
   * silently claim a permission the key might not actually have been minted
   * with.
   */
  readonly permission: string;
  readonly spaceId: string;
  readonly keyId: string;
  /**
   * The name the key was minted under — the operator's label plus the mint
   * marker, clamped to Console's limit. This is the only field of the key that
   * the Console UI actually displays, so it is the handle a human uses to find
   * this key by eye. Carried here (and therefore persisted, and returned on the
   * result) so the caller never has to reconstruct it.
   */
  readonly name: string;
  /**
   * `[]` here means one of two different things — "this space genuinely has
   * no private buckets" or "Console's response didn't say" — and this array
   * alone cannot distinguish them. The outcome's `stage` is the real signal
   * for the second case (see `MintStage`'s `"private-buckets-unknown"`);
   * treat an empty array here as authoritative only once you've confirmed
   * the outcome wasn't that stage.
   */
  readonly privateBuckets: readonly { bucketId: string; groupId: string }[];
}

/**
 * What `generateApiKey` actually returns. There is only one shape now:
 * persist runs before any branch below is reached, so there is no
 * "not yet persisted" state left to represent — every branch either carries
 * this pointer or (the `stage: "persist"` branch) explains why it couldn't.
 */
export interface GenerateApiKeyResult {
  /** See `MintedSecrets.permission` — Console's raw echoed string, not a caller-claimed tier. */
  readonly permission: string;
  readonly spaceId: string;
  readonly keyId: string;
  /**
   * See `MintedSecrets.name`. The one field of this key the Console UI renders,
   * and therefore the handle for finding it there — the id is not displayed.
   */
  readonly name: string;
  /** See `MintedSecrets.privateBuckets` — `[]` is ambiguous on its own; check `stage`. */
  readonly privateBuckets: readonly { bucketId: string; groupId: string }[];
  /** Where the one-time secrets were written — 0600, parent dir 0700. Read them from here. */
  readonly credentialFile: string;
}

/**
 * Which step failed. Named for the caller, not for the code path.
 *
 * A space *mismatch* no longer lands here: it is a warning on an otherwise
 * complete mint (see `SpaceMismatchWarning`), not a failure. `"space-check"`
 * stays in the union because it is still the name of the step, and a defect
 * raised while it runs is attributed to it.
 */
export type MintStage =
  | "mint"
  | "persist"
  | "space-check"
  | "private-buckets-unknown"
  | "grant"
  | "activation";

/**
 * The stages that run once the key definitely exists AND its secrets are
 * definitely durable on disk — the two stages that precede both those facts
 * (`"mint"`, `"persist"`) are excluded, because only from here on is a
 * `credential` pointer guaranteed to exist to attach to the outcome.
 */
type PostPersistStage = Exclude<MintStage, "mint" | "persist">;

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
 * The caller passed a `spaceId` and the mint landed somewhere else.
 *
 * This is NOT a failed mint. `spaceId` never reaches Console — `createApiKey`
 * sends only `permissions`, `serviceSignerAddress` and `name`, and the space is
 * derived server-side from the Key-Admin credential. So a mismatch does not mean
 * "a key was created in the wrong place"; it means the admin credential this host
 * is configured with belongs to a different space than the caller believed. The
 * key itself is valid, scoped, and grantable — just not in the space that was
 * asserted.
 *
 * Reporting that as `ok: false` was the actual defect behind COMG-849: the mint
 * had succeeded, the secrets were on disk, and the only thing wrong was the
 * caller's expectation — but the failure label invited a retry, and every retry
 * mints another key against the 25-key-per-user cap, with no way for this client
 * to revoke any of them (see `REVOCATION_GUIDANCE`).
 */
export interface SpaceMismatchWarning {
  readonly kind: "space-mismatch";
  /** What the caller asserted the admin credential's space would be. */
  readonly expected: string;
  /** Where the key was actually minted — the admin credential's real space. */
  readonly actual: string;
  readonly message: string;
}

/** Non-fatal observations about a mint that nonetheless completed. */
export type MintWarning = SpaceMismatchWarning;

/**
 * The result of a mint attempt.
 *
 * `createApiKey` is a point of no return: a 201 means a key exists server-side
 * and its `hbr_` value has been shown for the only time it ever will be —
 * REGARDLESS of whether that 201's body turns out to be usable.
 * `generateApiKey` persists the secrets to disk immediately once it can (right
 * after building them from a validated response) — before the space check, the
 * bucket grant, or the activation poll run — so by the time any of the four
 * branches below is produced, the secrets are already durable at
 * `credential.credentialFile`, EXCEPT:
 *  - the `"mint"` branch: the 201 arrived but its body failed validation, so
 *    there is no `id`/`key`/`space_id` to build a credential — or even a
 *    filename — from. Nothing was, or could be, persisted.
 *  - the `"persist"` branch: the body validated fine, but writing it to disk
 *    is the step that failed.
 *
 * So none of these are errors on Effect's failure channel. They come back as
 * `ok: false` carrying the pointer credential (where there is one), because the
 * alternative is destroying the only copy of a secret that still controls a
 * live key.
 *
 * There is no programmatic way back from a lost credential. `/api/v1/api-keys`
 * answers 403 "This endpoint requires session authentication" to BOTH the
 * working key and the Key-Admin key, so a key whose credential file is gone can
 * be neither enumerated nor revoked from here — only from the Console UI, by a
 * human who first has to work out that it exists. For `"mint"` specifically,
 * that human has nothing to search for except the pre-mint marker breadcrumb
 * already on stderr — there is no keyId at all.
 *
 * They stay on the SUCCESS channel deliberately, even though F9 otherwise wants
 * failures flagged with `isError`. An `isError` result invites the one response
 * that makes this strictly worse: a retry, which mints a *second* orphan. A
 * caller must read `ok` and act on `recovery`, not re-run the tool.
 *
 * For the same reason, this service's `ok: false` results are reserved for a
 * mint that genuinely did not finish. The MCP handler may additionally return
 * `stage: "declined"` before it calls this service; that result minted nothing
 * and is safe to retry only after a fresh confirmation. A completed mint with
 * a caveat — the caller's `spaceId` assertion not matching where the admin
 * credential actually minted — reports `ok: true` and carries a `warnings`
 * entry (COMG-849). Labelling that case a failure was the retry bait; the key
 * was always valid.
 */
export type GenerateApiKeyOutcome =
  | {
      readonly ok: true;
      readonly credential: GenerateApiKeyResult;
      /**
       * Present only when there is something to say. A completed mint can still
       * carry a caveat — today, only that the key landed in a different space
       * than the caller asserted (`SpaceMismatchWarning`).
       */
      readonly warnings?: readonly MintWarning[];
      /**
       * How to get rid of this key. No credential this client holds can do it —
       * the revoke endpoint requires a browser session. See `revocationGuidance`.
       */
      readonly revocation: string;
    }
  | {
      readonly ok: false;
      readonly stage: PostPersistStage;
      /** What went wrong, carrying the original message. */
      readonly reason: string;
      /** Structured form of the same failure, when it carried one. */
      readonly detail?: MintFailureDetail;
      /** Where the one-time secrets live. Present because persist already succeeded. */
      readonly credential: GenerateApiKeyResult;
      /**
       * Caveats gathered before this step failed — a space mismatch is detected
       * before the grant and activation steps run, so a later failure must not
       * swallow it.
       */
      readonly warnings?: readonly MintWarning[];
      /**
       * How to get rid of this key. Present here as well as on the clean
       * branch, because this is the outcome most likely to need it: the key is
       * live and the flow behind it is half-built.
       */
      readonly revocation: string;
      /** What the caller must do now — and what it must not do. */
      readonly recovery: string;
    }
  | {
      readonly ok: false;
      readonly stage: "persist";
      /** What went wrong, carrying the original message. */
      readonly reason: string;
      /** The mint's own id — the only handle left on the orphaned key. */
      readonly keyId: string;
      readonly spaceId: string;
      /** Where the write was attempted, even though nothing landed there. */
      readonly attemptedPath: string;
      /** What the caller must do now — and what it must not do. */
      readonly recovery: string;
    }
  | {
      readonly ok: false;
      readonly stage: "mint";
      /** What went wrong, carrying the original message. */
      readonly reason: string;
      /**
       * The client-side marker embedded in the mint's `name` and logged to
       * stderr BEFORE `createApiKey` was called — the only handle left on this
       * key. There is no `keyId` field on this branch: the response that would
       * have carried it is exactly what failed to validate.
       */
      readonly marker: string;
      /** What the caller must do now — and what it must not do. */
      readonly recovery: string;
    };

/** A mint confirmation that ended before KeyAdminService began a mint. */
export interface GenerateApiKeyDeclinedOutcome {
  readonly ok: false;
  readonly stage: "declined";
  readonly reason: string;
}

/** The generate_api_key tool's full result set, including a pre-mint decline. */
export type GenerateApiKeyToolOutcome = GenerateApiKeyOutcome | GenerateApiKeyDeclinedOutcome;

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
 * Exported with its cadence as parameters so the budget and the active/stalled
 * decision are worth asserting without waiting out a real 30-second registration.
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
      // `registration_progress` is `.nullish()` at the parse boundary (an
      // absent optional can arrive as an explicit JSON `null`, not just a
      // missing key) — normalize both to `undefined` here.
      progress = res.data.registration_progress ?? undefined;
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
      privateBuckets: readonly { group_id: string }[],
      childAddress: string,
      scope: "read" | "readwrite",
    ) {
      // Two private buckets can share one access group (bucket_id differs,
      // group_id doesn't) — membership is per GROUP, so granting it once
      // covers both buckets. Deduped here, before the request is even built,
      // rather than left for the validator to reject: asking Console for the
      // same group twice gets back two legitimate `add_editor` calls for it
      // (Console did exactly what was asked), and `assertGrantBucketAccessStructure`'s
      // exact-once coverage check would then refuse a PTB that is correct for
      // what was requested — the request itself was the bug. Deduping the ask
      // means Console's honest response has exactly one call per group, which
      // is what the validator expects.
      //
      // Deduped on `normalizeSuiAddress`, not the raw string: `assertGrantBucketAccessStructure`
      // (txValidation.ts) normalizes every id it compares, so two textually
      // different but equivalent forms of the SAME group (e.g. `0x0ab…` vs
      // `0xab…`) would survive a raw-string `Set` as two distinct entries —
      // resurrecting the exact bug this dedupe exists to fix, just reached
      // through normalization instead of a literal duplicate. Keyed by the
      // normalized form so equivalent ids collapse; valued by the FIRST raw
      // form seen, since any valid representation of the same address
      // resolves to the same on-chain object.
      const groupIds = [
        ...new Map(
          privateBuckets.map((b) => [normalizeSuiAddress(b.group_id), b.group_id]),
        ).values(),
      ];
      const sponsor = yield* api.sponsorGrantBucketAccess({
        groupIds,
        recipientAddress: childAddress,
        scope,
      });
      // Validated against exactly what was requested before the ADMIN key signs:
      // the scope (so a `read` grant cannot come back as `add_editor`), the
      // groups, and the recipient (so access cannot be redirected to a third
      // party while the response still looks like our own grant).
      const { signature } = yield* seal.signTransactionBytes(
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
          // A revoked key already carries its own remedy; a signer hint would
          // send the caller looking in the wrong place.
          ConsoleAuthError: (error) =>
            Effect.fail(
              isRevokedKeyCode(error.code)
                ? error
                : new ConsoleAuthError({ message: withHint(error.message), code: error.code }),
            ),
        }),
      );
    });

    const generateApiKey = Effect.fn("KeyAdminService.generateApiKey")(function* (args: {
      /**
       * Optional. NOT a selector — it never reaches Console, which derives the
       * space from the Key-Admin credential. It is an assertion: "I believe the
       * admin bundle on this host is for this space." Omit it and no assertion
       * is made; pass it and a mismatch comes back as a warning on a completed
       * mint (see `SpaceMismatchWarning`).
       */
      spaceId?: string | undefined;
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

      // A unique client-side marker embedded in the mint's name. `createApiKey` is
      // a point of no return whose 201 can be lost in flight (a crash, a dropped
      // connection) AFTER the key was created server-side. No credential this
      // client holds can list or revoke keys, so a lost key becomes an orphan
      // findable only by eye in the Console UI — this marker is what makes it
      // findable. It does NOT make the
      // mint idempotent: a retry still mints a second key. It only ensures the
      // first one can be identified. Server-stored idempotency is the real fix
      // (tracked separately).
      // Console caps `name` at 64 characters and rejects a longer one with a bare
      // 400 (`ZodError: String must contain at most 64 character(s)`), which
      // surfaces here as an unexplained mint failure. A full UUID marker plus
      // " [] " left only 16 characters for the label while the tool advertised 64,
      // so any label past ~19 characters broke the mint outright — found by the
      // COMG-761 e2e, not by a test. 12 hex digits (48 bits) is far past collision
      // risk for "find this one key in one space's list", which is all the marker
      // is for.
      const marker = `mcp-mint-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const name = clampKeyName(args.label ? `${args.label} [${marker}]` : marker);

      // Breadcrumb for the pre-201 window, emitted BEFORE the call: if the response
      // never arrives, stderr still records that a key with this marker may exist.
      // stderr, not the tool result, because it outlives a crashed request.
      console.error(
        `[console-mcp] generate_api_key: minting a Console key marked "${marker}". If this ` +
          `call does not return (crash, timeout, dropped response), a key with that marker may ` +
          `still have been created — find it by that marker in the Console UI before minting again.`,
      );

      // 2. Ask Console to mint the child hbr_ key under the admin's key_admin scope.
      // The space is derived server-side from the admin credential — args.spaceId is
      // validated below, not used to select the space.
      //
      // `createApiKey` itself is Zod-validated at the parse boundary (see
      // createApiKeyResponseSchema's doc comment): a 201 whose body fails that
      // validation fails typed as `ConsoleApiError { code: "invalid_response_shape" }`
      // rather than being trusted with an unsound cast. That failure is caught HERE,
      // specifically, and converted to a success-channel value rather than being
      // allowed to propagate: a 201 is Console's own point of no return (the comment
      // on that error says so), so letting this sail through as a rejected promise
      // would (a) surface as `isError: true`, inviting exactly the retry that mints
      // a second orphan (see GenerateApiKeyOutcome's doc comment — this is the same
      // reasoning as every OTHER post-mint failure, just for one that happens before
      // there is a `credential` to attach), and (b) discard `secrets` before persist
      // ever ran, losing them outright — the one thing Task 3 exists to prevent.
      // Every OTHER failure from this call (network, auth, a non-201 status) has NOT
      // reached that point of no return and must keep failing normally — hence the
      // predicate, not a blanket catch.
      const mintAttempt = yield* api
        .createApiKey({
          permissions: args.permission,
          serviceSignerAddress: child.address,
          name,
        })
        .pipe(
          Effect.map((minted) => ({ kind: "minted" as const, minted })),
          Effect.catchIf(
            // Deliberately a plain boolean predicate, not a `(e): e is ConsoleApiError`
            // type guard: a guard would erase `ConsoleApiError` from the *residual*
            // error type below, but a non-"invalid_response_shape" `ConsoleApiError`
            // (a real 4xx from `handleError`) still escapes this catch at runtime —
            // typing it out would be a lie the rest of this function relies on being
            // false (see the "pre-mint failures still fail" test).
            //
            // `error.status === 201` is load-bearing, not decoration: `code` alone is
            // NOT enough to identify "our own synthesized validation failure". Console
            // — or a compromised endpoint, a threat this codebase already models —
            // controls the `code` string in an ordinary error body too (`handleError`,
            // `ConsoleApiClient.ts`, copies it verbatim from the response JSON), so a
            // genuine 400 carrying `{"error":{"code":"invalid_response_shape"}}` would
            // match on `code` alone despite NOTHING having been minted. Status pins it:
            // this branch of `createApiKey` only ever constructs a `ConsoleApiError`
            // with `status: res.status` INSIDE the `res.status !== 201` early return's
            // else-path — i.e. exactly when a 201 arrived — so `status === 201` can only
            // be true for the self-synthesized validation failure, never for a `handleError`
            // response (which sets `status` to the REAL non-2xx status code).
            (error) =>
              error instanceof ConsoleApiError &&
              error.code === "invalid_response_shape" &&
              error.status === 201,
            (error) =>
              Effect.succeed({ kind: "unverifiable" as const, error: error as ConsoleApiError }),
          ),
        );

      if (mintAttempt.kind === "unverifiable") {
        const mintUnverifiable: GenerateApiKeyOutcome = {
          ok: false,
          stage: "mint",
          reason: mintAttempt.error.message,
          marker,
          recovery:
            `Console returned a 201 for this mint (a point of no return — the key likely exists ` +
            `server-side) but its response body failed validation, so there is no keyId, ` +
            `spaceId, or credential available here at all — nothing could be persisted. Do NOT ` +
            `call generate_api_key again to "retry": that risks minting a second key while this ` +
            `one is orphaned. Instead, find this mint by its marker "${marker}" (embedded in the ` +
            `key's name, and already logged to stderr before the mint ran) in the Console UI, ` +
            `and recover or revoke it by hand from there.`,
        };
        return mintUnverifiable;
      }
      const minted = mintAttempt.minted;

      // From here down the key EXISTS. Build the raw secrets immediately so
      // every exit below can hand back a pointer to them — see
      // GenerateApiKeyOutcome for why a failure after this point must not
      // travel on the error channel.
      const secrets: MintedSecrets = {
        apiKey: minted.key,
        privateKey: child.privateKey,
        permission: minted.permissions,
        spaceId: minted.space_id,
        keyId: minted.id,
        // The composed, clamped name that was actually sent — Console stores it
        // verbatim as the key's label, which is what the Integrations table
        // shows. Taken from the request rather than the 201 body because the
        // response schema does not parse `name` at all.
        name,
        // `minted.private_buckets` is `null` when Console's response didn't say
        // (see createApiKeyResponseSchema's doc comment) — persisted as `[]`
        // either way, since the secrets themselves (apiKey/privateKey) are valid
        // and durable regardless; the "we don't know" signal lives on the
        // outcome's `stage`, not in this file, once `completion` runs below.
        privateBuckets: (minted.private_buckets ?? []).map((b) => ({
          bucketId: b.bucket_id,
          groupId: b.group_id,
        })),
      };

      // Defense in depth: any OTHER code path that happens to log or
      // stringify these secrets from here on gets scrubbed — including the
      // synchronous persist step immediately below, before it ever writes
      // them to disk.
      registerSecret(secrets.apiKey);
      registerSecret(secrets.privateKey);

      // Persist BEFORE the interruptible pipeline (`completion` below, with its
      // `Effect.onInterrupt`) is even constructed, and reachable by nothing but
      // plain synchronous statements since `createApiKey` returned — there is no
      // `yield*` between the mint and here, so nothing can interrupt this fiber
      // in between. That is what makes the interrupt breadcrumb below true: by
      // the time cancellation is possible, the secrets are already durable on
      // disk. `persistMintedCredential` is the sync writer (not the async one),
      // so a plain try/catch is enough — no Effect needed for this step.
      let credential: GenerateApiKeyResult;
      try {
        credential = persistMintedCredential(secrets);
      } catch (cause) {
        // `persistMintedCredential` itself starts by computing this exact same
        // path (mintedCredentialStore.ts's `persistMintedCredential` calls
        // `mintedCredentialFilePath` internally before it ever touches the
        // filesystem) — so if THAT computation is what threw (`getConfigDir()`
        // -> `os.homedir()` throws `ERR_SYSTEM_ERROR` when `HOME` is unset and
        // the passwd lookup also fails, a real container misconfiguration, not
        // hypothetical), recomputing it again here throws the identical error
        // a SECOND time — now uncaught, since this line sits outside the try
        // above. That would kill the generator entirely and lose the whole
        // `stage: "persist"` outcome (keyId, spaceId, the "do NOT retry"
        // guidance) to an `isError: true` rejection, inviting exactly the
        // retry-and-orphan this outcome exists to prevent. The now-deleted
        // `persistAndRedactOutcome` (see facfeb3f) carried a guard for this
        // exact hazard; Task 3b's move into this function dropped it along
        // with the function. Restored here as a plain try/catch with a
        // placeholder, in the same spirit as that guard's
        // `"(no path computed — keyId/spaceId were not both strings)"`.
        let attemptedPath: string;
        try {
          attemptedPath = mintedCredentialFilePath(secrets.keyId);
        } catch {
          attemptedPath = "(no path computed — path computation itself failed)";
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        // stderr, not the tool result: outlives the request and is the only
        // trace of this keyId if the caller never sees a structured result.
        // Names the keyId so the key can be found by hand — never the secrets.
        console.error(
          `[console-mcp] generate_api_key minted key ${secrets.keyId} in space ` +
            `${secrets.spaceId}, but its credential file at ${attemptedPath} could not be ` +
            `written (${message}). The key is live; its one-time secrets are not recoverable ` +
            `from this process. Do not call generate_api_key again — that mints a second key ` +
            `and orphans this one. Fix the ${path.dirname(attemptedPath)} permissions (or free ` +
            `disk space) and recover the key's status from the Console UI.`,
        );
        const persistFailure: GenerateApiKeyOutcome = {
          ok: false,
          stage: "persist",
          reason: message,
          keyId: secrets.keyId,
          spaceId: secrets.spaceId,
          attemptedPath,
          recovery:
            `Key ${secrets.keyId} in space ${secrets.spaceId} was minted, but its one-time ` +
            `secrets could not be saved to ${attemptedPath}, so this tool call cannot hand them ` +
            `to you. Do NOT call generate_api_key again — the mint already succeeded and a ` +
            `retry orphans a second key. Fix the write failure and ask an operator to recover ` +
            `the key's status from the Console UI.`,
        };
        return persistFailure;
      }

      // Caveats that do not stop the mint. Collected as the flow runs, and
      // attached to whatever outcome it ends on: the space check happens before
      // the grant and activation steps, so a later failure must not swallow a
      // warning already raised.
      const warnings: MintWarning[] = [];

      const incomplete = (
        stage: PostPersistStage,
        reason: string,
        detail?: MintFailureDetail,
      ): GenerateApiKeyOutcome => ({
        ok: false,
        stage,
        reason,
        ...(detail ? { detail } : {}),
        credential,
        ...(warnings.length > 0 ? { warnings } : {}),
        // Present on this branch too, and not as an afterthought: an incomplete
        // mint is the case MOST likely to need revoking — a live key with a
        // half-built flow behind it — so it must carry the same specific path
        // as a clean one, not vaguer prose.
        revocation: revocationGuidance(credential.name),
        recovery:
          `The key ${minted.id} already exists in space ${minted.space_id}, and its one-time ` +
          `secrets are the ONLY copy — they will not be shown again. They have already been ` +
          `saved to credential.credentialFile; read them from there. Do NOT call ` +
          `generate_api_key again to "retry": the mint already succeeded, so a second call mints ` +
          `a second key and orphans this one. No credential this client holds can list or revoke ` +
          `keys (those endpoints require a browser session), so an orphan can only be cleaned up ` +
          `by hand in the Console UI.`,
      });

      // Which step is running, so a failure caught below can name it. A mutable
      // marker rather than per-step error handling: every post-mint step funnels
      // into ONE exit handler, so there is exactly one place that can drop the
      // credential, instead of one per step. Neither "mint" nor "persist" can
      // appear here — both already ran above and either already succeeded (this
      // line runs) or already returned (this line does not).
      let stage: PostPersistStage = "space-check";

      const completion = Effect.gen(function* () {
        // The admin credential scopes the mint to one space, and the space cannot
        // be checked BEFORE minting: the Key-Admin credential has no data-plane
        // access (GET /api/v1/spaces answers 403 "key_admin has no data-plane
        // access"), and the working key's space list would not describe the
        // admin's scope even where a working key exists — which on a provisioning
        // host it need not.
        //
        // So this is a WARNING, not a failure (COMG-849). `args.spaceId` never
        // reached Console; the key was minted into the admin credential's own
        // space and is entirely valid there. The only thing a mismatch proves is
        // that this host's admin bundle is not the one the caller assumed — worth
        // saying loudly, but reporting it as `ok: false` was itself the bug: it
        // invited the retry that mints a second key against the 25-key cap, with
        // no way for this client to revoke either one. The mint continues so the key is
        // granted and activated like any other, rather than left half-built.
        // Trimmed, not just `!== undefined`: a blank string is what a caller
        // writes when it means "nothing to assert" but reaches for the field
        // anyway. Comparing it yields a warning with holes where the space ids
        // belong, ending in advice to revoke a key that is perfectly correct.
        // The tool schema rejects blanks at the boundary; this makes the
        // nonsense unreachable for any caller, including a direct one.
        const asserted = args.spaceId?.trim();
        if (asserted !== undefined && asserted !== "" && minted.space_id !== asserted) {
          warnings.push({
            kind: "space-mismatch",
            expected: asserted,
            actual: minted.space_id,
            message:
              `This key was minted into space ${minted.space_id}, not the ${asserted} you ` +
              `passed. spaceId does not select the space — the Key-Admin credential does — so ` +
              `this means the CONSOLE_ADMIN_KEY configured on this host belongs to a different ` +
              `space than you expected. The key is valid and usable in ${minted.space_id}. If ` +
              `you needed a key for ${asserted}, do NOT retry: configure the admin bundle ` +
              `for that space first, then mint, and revoke this key.`,
          });
          // Also to stderr: a misconfigured admin bundle is an operator problem,
          // and the operator is not necessarily whoever reads this tool result.
          console.error(
            `[console-mcp] generate_api_key: minted key ${minted.id} into space ` +
              `${minted.space_id}, but the caller asserted ${asserted}. The CONSOLE_ADMIN_KEY ` +
              `on this host is scoped to ${minted.space_id}. The key is valid; the expectation ` +
              `was wrong.`,
          );
        }

        // `null` means Console's 201 body didn't say whether this space has
        // private buckets at all — NOT the same as an explicit `[]`, which means
        // Console said there are none. Collapsing the two (as a prior fix here
        // did) silently skips granting for a space that may actually have
        // buckets the caller now can't reach, with nothing in the result saying
        // so. Secrets are already durable (persisted above) either way; this
        // just stops the grant step from running on data we don't have, and
        // says so plainly instead of reporting `ok: true` with empty grants.
        if (minted.private_buckets === null) {
          return incomplete(
            "private-buckets-unknown",
            `Console's response for this mint did not include a usable private_buckets list ` +
              `(the field was missing, not an array, or a non-empty array with at least one ` +
              `entry Console's response didn't format usably), so bucket-access grants were ` +
              `SKIPPED entirely. This does NOT mean space ${minted.space_id} has no private ` +
              `buckets — only that this mint could not tell. If it does, this key currently has ` +
              `no access to any of them.`,
          );
        }

        // If the space has private buckets, run ONE sponsored grant_bucket_access
        // PTB covering every group, signed with the ADMIN seed (never the working key).
        if (minted.private_buckets.length > 0) {
          stage = "grant";
          const scope = args.permission === "read_write" ? "readwrite" : "read";
          yield* grantBucketAccess(minted.private_buckets, child.address, scope);
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

        const done: GenerateApiKeyOutcome = {
          ok: true,
          credential,
          ...(warnings.length > 0 ? { warnings } : {}),
          revocation: revocationGuidance(credential.name),
        };
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
        // uses, so a human can find and remove it.
        //
        // Unlike before persist moved above this pipeline, the secrets are NOT
        // lost here — `credential` (the pointer) is already closed over, because
        // persisting happened synchronously before `completion` was even built.
        // So this breadcrumb can — and must — say the secrets were saved, and
        // name where. What it genuinely does NOT know is whether the space
        // check, bucket grant, or activation poll had finished; that part really
        // is unknown, so it says so instead of guessing.
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            console.error(
              `[console-mcp] generate_api_key was cancelled after minting key ${minted.id} ` +
                `in space ${minted.space_id}. Its one-time secrets were already saved to ` +
                `${credential.credentialFile} before the cancellation, so they are NOT lost. ` +
                `Whether the remaining steps (space check, bucket grant, activation) finished ` +
                `is unknown from here — check the key's status in the Console UI.`,
            );
          }),
        ),
      );

      // Effect.exit, not Effect.either: `either` only intercepts the typed failure
      // channel, so a DEFECT would sail past it and reject — losing the credential
      // this whole shape exists to preserve. `getApiKeyStatus`'s response is now
      // Zod-validated at the parse boundary (ConsoleApiClient.ts), so a malformed
      // payload fails typed as `ConsoleApiError` rather than throwing inside the
      // generator — but that closes only ONE source of defects, not the class:
      // `seal`, `api`, and every other dependency this generator calls can still
      // die (tests/keyAdmin.test.ts's "DIES rather than failing" stubs one
      // directly), so `Effect.exit` stays required regardless.
      const exit = yield* Effect.exit(completion);
      if (Exit.isSuccess(exit)) return exit.value;
      return incomplete(stage, causeMessage(exit.cause), causeDetail(exit.cause));
    });

    return { generateApiKey } as const;
  }),

  dependencies: [ConsoleApiClient.Default, SealCryptoService.Default, ConsoleConfigLive],
}) {}
