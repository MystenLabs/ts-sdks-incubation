import { Data } from "effect";

/**
 * Console API and Seal crypto domain errors.
 * All extend Data.TaggedError for exhaustive matching (matches console/api conventions).
 */

export class ConsoleApiError extends Data.TaggedError("ConsoleApiError")<{
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
  readonly endpoint?: string;
}> {}

export class ConsoleAuthError extends Data.TaggedError("ConsoleAuthError")<{
  readonly message: string;
  readonly code:
    | "missing_api_key"
    | "invalid_api_key"
    | "read_only_api_key"
    // A 403 from a scope violation (e.g. a working key hitting the Key-Admin mint
    // endpoints). Kept distinct so the fidelity isn't lost to invalid_api_key.
    | "insufficient_scope";
}> {}

export class SealCryptoError extends Data.TaggedError("SealCryptoError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly step:
    | "load_keypair"
    | "parse"
    | "encrypt"
    | "decrypt"
    | "build_ptb"
    | "session_key"
    | "sign"
    | "generate_keypair";
}> {}

/**
 * Raised when Seal `fetch_key` failed inside the Console proxy rather than at the key
 * servers, so a caller can tell an outage or a credential problem from a genuine access
 * denial — which stays the SDK's own `NoAccessError` and is deliberately not wrapped here.
 *
 * `condition` is what to do about it; `code` is the Console token it came from, kept
 * verbatim so a backend code added later still reaches the agent unflattened.
 */
export class SealProxyError extends Data.TaggedError("SealProxyError")<{
  readonly message: string;
  readonly cause?: unknown;
  /**
   * - `disabled` — proxy flagged off on that deployment; not something the caller can fix.
   * - `rate_limited` — back off and retry.
   * - `unavailable` — the proxy could not reach Seal's aggregator; transient.
   * - `misconfigured` — the Console's own upstream credential was rejected. Like `disabled`
   *   it is not the caller's to fix, and unlike `unavailable` it will not clear on retry.
   * - `credential` — this MCP's `CONSOLE_API_KEY` / `CONSOLE_SERVICE_PRIVATE_KEY` is wrong,
   *   under-scoped, or not yet registered on-chain. Actionable by the user.
   * - `request` — rejected before reaching Seal, which in practice means this MCP and the
   *   Console disagree on the wire contract.
   * - `unknown` — a Console code this build has no mapping for. Deliberately not folded into
   *   one of the above: guessing `unavailable` would tell an agent to retry something that
   *   may never succeed. The `code` field still carries the token.
   */
  readonly condition:
    | "disabled"
    | "rate_limited"
    | "unavailable"
    | "misconfigured"
    | "credential"
    | "request"
    | "unknown";
  /** Raw Console error code, e.g. `not_configured`, `read_only_api_key`. */
  readonly code: string;
}> {}

/**
 * A create-bucket refusal about the caller's own IDENTITY PINS, raised either
 * side of the reserve but always BEFORE anything is signed.
 *
 * Separate from `SealCryptoError` because the remedy is completely different:
 * nothing here is a crypto or transaction problem, and an agent told to "check
 * your service key" when the real defect is an unset
 * `CONSOLE_WEB_ACCOUNT_ADDRESS` will retry the wrong fix forever.
 *
 * - `missing_owner_pin` — no owner address is configured, so the `add_owner`
 *   call in the reserve could never be checked against anything. Refused before
 *   the reserve, so no half-created bucket is left behind.
 * - `owner_echo_mismatch` / `admin_echo_mismatch` — the reserve response echoed
 *   back an owner / Key-Admin that is not the one we pinned. These are
 *   DIAGNOSTICS, not the security boundary: the boundary is `txValidation`'s
 *   walk of the signed bytes, which does not consult the echo at all. They exist
 *   so "the server ignored the pin I sent" reads as itself instead of surfacing
 *   later as a mysterious refusal to sign.
 * - `group_id_underivable` — the object id of the group the transaction creates
 *   could not be computed locally, so there is no trustworthy value to cache as
 *   the space's anchor. Raised BEFORE finalize.
 * - `group_id_mismatch` — the locally derived group id and the one the server
 *   reported disagree. Unlike the two echoes, this one is NOT merely diagnostic
 *   in effect: the anchor decides who a later create may grant access to, so the
 *   derived value is authoritative and a disagreement refuses rather than
 *   resolving. Raised after finalize, so the bucket exists; the message says so
 *   and names `finalized.bucket_id` so the orphan is findable.
 * - `bucket_id_arg_mismatch` — the BCS `bucket_id` in the validated PTB does
 *   not match the reserve's id. Raised BEFORE finalize; nothing was submitted.
 * - `bucket_id_mismatch` — finalize reported a different bucket id than the
 *   reserve. Raised after finalize; the message names both so the orphan is
 *   findable.
 * - `anchor_id_mismatch` — a stored anchor's group id does not reproduce from
 *   its recorded bucket id and creator. Raised before the reserve, so nothing
 *   is created; the operator deletes `anchors.json` (or restores a file this
 *   client wrote) and the next create bootstraps.
 */
export class BucketCreatePinError extends Data.TaggedError("BucketCreatePinError")<{
  readonly message: string;
  readonly reason:
    | "missing_owner_pin"
    | "owner_echo_mismatch"
    | "admin_echo_mismatch"
    | "group_id_underivable"
    | "group_id_mismatch"
    | "bucket_id_arg_mismatch"
    | "bucket_id_mismatch"
    | "anchor_id_mismatch";
}> {}

/** Raised when a mint is attempted without a configured Key-Admin credential. */
export class AdminCredentialMissingError extends Data.TaggedError("AdminCredentialMissingError")<{
  readonly message: string;
}> {}

export class MirrorGrantMissingError extends Data.TaggedError("MirrorGrantMissingError")<{
  readonly bucketId: string;
  readonly fileId?: string;
  readonly attempt: number;
}> {}

export class FileStatusError extends Data.TaggedError("FileStatusError")<{
  readonly fileId: string;
  readonly state: string;
  readonly error?: { code: string; message: string };
}> {}

export class LocalFsError extends Data.TaggedError("LocalFsError")<{
  readonly message: string;
  readonly path: string;
  readonly operation: "read" | "write" | "stat" | "validate";
}> {}

/**
 * Console rejected the upload because the file type is on the server deny list
 * (COMG-590). Separate from `ConsoleApiError` so an agent can tell
 * "never going to work" from a transient 5xx and stop retrying.
 *
 * `layer` is reserved for a future BE-side per-layer hint (e.g. an
 * `X-Deny-Layer` response header from the Console files route). Today
 * Console's 415 does not name which of its two checks fired, so this field
 * is unconditionally emitted as `"server"` by `ConsoleApiClient`. The
 * `extension` / `magic_bytes` values stay in the union so a follow-up BE
 * change can start populating them without breaking existing callers:
 * - `extension` — name-based reject at the route (runs on public + private).
 * - `magic_bytes` — content-sniff at the upload service (public only; private
 *   payloads arrive encrypted and detect as nothing).
 * - `server` — Console said 415 without a layer hint; treat as denied.
 *
 * Public and private buckets both surface as 415 with the same body shape, so
 * this error is emitted identically for both — the caller doesn't need bucket
 * visibility to interpret it.
 */
export class UnsupportedFileTypeError extends Data.TaggedError("UnsupportedFileTypeError")<{
  readonly message: string;
  readonly fileName: string;
  readonly layer: "extension" | "magic_bytes" | "server";
  readonly code?: string;
}> {}

/**
 * Console rejected the upload because it exceeds the size cap. Separate from
 * `UnsupportedFileTypeError` so an agent can tell "wrong type" (change file)
 * from "too big" (split / compress). Bytes are echoed when Console reports
 * them, absent otherwise.
 */
export class PayloadTooLargeError extends Data.TaggedError("PayloadTooLargeError")<{
  readonly message: string;
  readonly fileName: string;
  readonly bytes?: number;
  readonly code?: string;
}> {}
