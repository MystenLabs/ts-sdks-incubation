import type { FileStatusErrorBody } from "./ConsoleApiClient";
import type { UploadFailureCondition } from "./errors";

/**
 * Turns a failed upload status into what the agent should do next.
 *
 * Console's raw message for a closed daily cap reads like "try again later",
 * which a client takes literally. Console now enumerates `error.code` and, for
 * the two cap codes, says when uploads resume (`retry_at`). This module maps
 * the code to a `condition` and writes the sentence that tells the agent to
 * stop.
 *
 * The code list mirrors Console's `UploadFailureCode` enum and its retry
 * classes (`api/src/domain/files/upload-failure.ts`, published on the status
 * endpoint's OpenAPI). A `Map`, not an object literal, for the same reason as
 * `CONDITION_BY_CODE` in seal-config.ts: the key is a string this MCP does not
 * control, and an object lookup for `constructor` would resolve through
 * `Object.prototype`.
 */
const CONDITION_BY_CODE = new Map<string, UploadFailureCondition>(
  Object.entries<UploadFailureCondition>({
    // This account's rolling 24h funding cap. Terminal for the account until
    // `retry_at`; every upload before then fails the same way.
    upload_daily_funding_limit: "daily_limit",
    // The omnibus-wide daily cap or its kill switch: every account, nothing
    // this one did. `retry_at` is present only when a cap window closed it.
    upload_funding_paused: "funding_paused",
    // The space is full; only deleting files changes the answer.
    upload_cap_exceeded: "storage_cap",
    // The same upload can be retried after a short pause.
    upload_wallet_funding_required: "transient",
    upload_rate_limited: "transient",
    upload_unauthorized: "transient",
    upload_funding_failed: "transient",
    upload_funding_pending: "transient",
    upload_funding_gave_up: "transient",
    upload_funding_timeout: "transient",
    upload_upstream_unavailable: "transient",
    // Retrying as-is will not succeed.
    upload_payload_too_large: "permanent",
    upload_bucket_not_found: "permanent",
    upload_quota_rejected: "permanent",
    upload_funding_below_min_shortfall: "permanent",
    upload_bucket_gone: "permanent",
    upload_failed: "permanent",
  }),
);

/**
 * Unknown codes fall to `permanent`, not `transient`: a code this build does
 * not know is most likely a new terminal outcome, and telling an agent to
 * retry something that may never succeed is the failure mode this module
 * exists to stop. The raw code still reaches the agent on `error.code`.
 */
const FALLBACK_CONDITION: UploadFailureCondition = "permanent";

const GUIDANCE: Record<UploadFailureCondition, (retryAt: string | undefined) => string> = {
  // Console leaves `retry_at` off a daily-limit failure only when nothing was
  // counted against the cap, which means this file's funding alone exceeds it:
  // waiting does not help that file, but smaller ones may still fit.
  daily_limit: (retryAt) =>
    retryAt !== undefined
      ? `This account's daily funding limit is reached. Stop uploading to this account until ` +
        `${retryAt}; every upload before then fails the same way. If this is part of a batch, ` +
        "stop the batch and report the resume time rather than trying the remaining files."
      : "This file needs more funding than the account's whole daily limit, so it cannot be " +
        "uploaded under the limit and waiting will not help. Do not retry it; smaller files " +
        "may still upload.",
  funding_paused: (retryAt) =>
    "Upload funding is paused service-wide, for every account; nothing this account did " +
    "caused it. Stop the batch. " +
    (retryAt !== undefined
      ? `Retry at ${retryAt}, or earlier if the operator lifts the pause.`
      : "Do not retry until an operator lifts the pause; there is no time to wait for."),
  storage_cap: () =>
    "The space's storage cap is reached. Free space (delete files) before uploading again; " +
    "retrying as-is fails the same way.",
  transient: () =>
    "Transient. Retry the same upload after a short pause, once; if it fails again, stop " +
    "and report it.",
  permanent: () =>
    "Retrying this upload as-is will not succeed. Do not retry automatically; report the " +
    "code and message.",
};

/** What a failed status means for the agent, next to Console's own `error`. */
export interface UploadFailureReading {
  readonly condition: UploadFailureCondition;
  readonly guidance: string;
}

/**
 * The condition for a failed status's error, and the sentence that goes with
 * it. Pure, so the table is assertable without a request.
 */
export function interpretUploadFailure(
  error: FileStatusErrorBody | undefined,
): UploadFailureReading {
  const code = error?.code ?? "unknown";
  const condition = CONDITION_BY_CODE.get(code) ?? FALLBACK_CONDITION;
  const retryAt = typeof error?.retry_at === "string" ? error.retry_at : undefined;
  return {
    condition,
    guidance:
      GUIDANCE[condition](retryAt) +
      (CONDITION_BY_CODE.has(code)
        ? ""
        : " (This MCP build does not recognise the code; treat Console's message as the source of truth.)"),
  };
}

/** What `ConsoleStorageService` remembers between uploads once the daily limit has closed. */
export interface UploadsPause {
  /** Local epoch ms after which uploads are allowed again. */
  readonly until: number;
  /** Console's `retry_at`, for the refusal message. */
  readonly retryAt: string;
}

/**
 * Whether a failure closes uploads for this account until Console's time.
 *
 * Only `daily_limit` blocks. Per-account caps come from Console's env, so
 * nothing lifts them before the window rolls and the block cannot go stale.
 * A `funding_paused` window can be lifted by an operator at any moment
 * (Console's /admin), so it gets guidance only; blocking on its `retry_at`
 * would keep refusing uploads after the raise. A daily limit without a time
 * means this one file is too large for the cap, and smaller files may fit.
 *
 * The deadline comes from `retry_after_seconds` (Console computes it on every
 * read) against the local clock, so a skewed host clock does not stretch or
 * shorten it; `retry_at` is the fallback when the seconds are missing.
 */
export function uploadsBlockedUntil(
  error: FileStatusErrorBody | undefined,
  now: number = Date.now(),
): UploadsPause | undefined {
  if (error === undefined || CONDITION_BY_CODE.get(error.code) !== "daily_limit") return undefined;
  if (typeof error.retry_at !== "string") return undefined;
  const seconds = error.retry_after_seconds;
  const until =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
      ? now + seconds * 1000
      : Date.parse(error.retry_at);
  if (Number.isNaN(until) || until <= now) return undefined;
  return { until, retryAt: error.retry_at };
}

/** The refusal an upload gets while the daily limit is closed. */
export function uploadsPausedMessage(pause: UploadsPause): string {
  return "Refused without an API call. " + GUIDANCE.daily_limit(pause.retryAt);
}
