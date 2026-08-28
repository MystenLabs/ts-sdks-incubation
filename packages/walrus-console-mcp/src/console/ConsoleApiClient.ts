import { HttpBody, HttpClient, HttpClientRequest, type HttpClientResponse } from "@effect/platform";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { Effect, Stream } from "effect";
import { z } from "zod";
import { ConsoleConfigTag, getRawAdminKey, getRawApiKey } from "../config";
import { MAX_TRANSFER_BYTES_ENV, maxTransferBytes } from "../transferLimits";
import {
  ConsoleApiError,
  ConsoleAuthError,
  PayloadTooLargeError,
  UnsupportedFileTypeError,
} from "./errors";
import type {
  Bucket,
  BucketId,
  BucketMetadata,
  FileId,
  FileSummary,
  SpaceId,
  SpaceListItem,
  StorageUsage,
} from "./types";
import type { RosterMember } from "./txValidation";

// Console stores a file's mime_type from the multipart part's content-type (it does NOT
// sniff the ciphertext or read the extension server-side). The UI keys preview/rendering
// off that stored mime, so an octet-stream type makes images/PDFs un-previewable even
// though they decrypt fine. Derive the real type from the file name.
const EXT_MIME: Record<string, string> = {
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
  csv: "text/csv",
  htm: "text/html",
  html: "text/html",
  md: "text/markdown",
  mdx: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
};

function contentTypeFromName(fileName: string): string {
  const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  return EXT_MIME[ext] ?? "application/octet-stream";
}

export interface CreateBucketReserveResponse {
  readonly bucket_id: BucketId;
  readonly bytes: string; // base64 sponsored tx
  readonly digest: string;
  /**
   * Wire name is `provisioning_state`. There is no `state` key and never was —
   * the DB column behind it is called `state`, which is where that name leaks in
   * from on the server side, and reading it here silently yielded `undefined`.
   */
  readonly provisioning_state: "pending_policy";
  // Echoes of the request's `expectedOwnerAddress` / the space's admin signer,
  // for disclosure only — the validator (txValidation.ts) is what actually
  // checks the signed PTB against the caller's pins; these are not consulted.
  readonly owner_address?: string;
  readonly admin_signer_address?: string | null;
}

/** Response of GET /api/v1/api-keys/space-signers — Task 7's roster-candidate source. */
export interface SpaceSignersResponse {
  readonly signers: readonly {
    readonly api_key_id: string;
    readonly service_signer_address: string;
    readonly scope: "read" | "readwrite";
  }[];
}

export interface FinalizeBucketResponse {
  readonly bucket_id: BucketId;
  readonly seal_policy_id: string | null;
  /** See `CreateBucketReserveResponse` — the wire name is `provisioning_state`. */
  readonly provisioning_state: string;
}

export interface FileUploadResponse {
  readonly data: {
    readonly id: FileId;
  };
}

export interface FileStatusResponse {
  readonly data: {
    readonly state: "queued" | "active" | "completed" | "failed";
    readonly progress?: number;
    readonly error?: { code: string; message: string };
  };
}

export interface FileListResponse {
  readonly data: readonly FileSummary[];
  readonly pagination: {
    readonly limit: number;
    readonly has_more: boolean;
    readonly next_cursor: string | null;
  };
}

/** Console wraps single-resource GETs as `{ data: <resource> }`. */
interface DataEnvelope<T> {
  readonly data: T;
}

// === Key-Admin mint flow (generate_api_key) ===

export type ApiKeyPermission = "read_only" | "read_write";

const privateBucketGrantSchema = z.object({
  bucket_id: z.string(),
  group_id: z.string(), // 0x… Sui object id of the bucket's access group
});
export type PrivateBucketGrant = z.infer<typeof privateBucketGrantSchema>;

/** Raw string Console echoed for `permissions`, when it isn't a usable one. */
const UNREPORTED_PERMISSION = "(not reported by Console)";

/**
 * Response of POST /api/v1/api-keys (mint child under key_admin scope).
 *
 * Narrow on purpose, but not uniformly strict — two tiers, split by what a
 * failure to parse actually costs:
 *
 *  - `id`, `key`, `space_id` are load-bearing and stay REQUIRED, non-empty
 *    strings (`.min(1)`, not just `z.string()`). Without `key` there are no
 *    secrets to persist at all; without `id`/`space_id` there is nothing to
 *    build a credential file path from, or to name in a recovery message. An
 *    EMPTY string passes `z.string()` but is exactly as unusable as a missing
 *    field — `{"id": "", "space_id": "", "key": "hbr_…"}` would otherwise
 *    parse successfully, persist to `minted-keys/<sha256 of "">.json`, and
 *    render `incomplete()`'s recovery as "The key  already exists in space "
 *    (naming nothing); a SECOND such response would then hit the `exclusive`
 *    EEXIST at that same fixed empty-string path and be misreported as a
 *    duplicate keyId, even though that second key's secrets are genuinely
 *    gone. A response missing (or emptying) any of these genuinely cannot be
 *    used, so `KeyAdminService.generateApiKey` treats a parse failure here as
 *    a `stage: "mint"` outcome (no credential, recovery via the pre-mint
 *    marker) — never a crash, and never silently trusted with `as`.
 *  - `permissions`, `status`, `private_buckets` are pass-through or seed a poll
 *    loop; loosened so that `id`/`key`/`space_id` are genuinely the ONLY
 *    fields that can fail this parse — a Console-side widening of any of the
 *    three below (a third permission tier, a new status string, an extra
 *    field on a bucket-grant element) must never discard a mint that
 *    otherwise succeeded (the createApiKey call is a point of no return — see
 *    its own message on a validation failure). Each is built on
 *    `z.unknown().transform(...)`, not a typed Zod primitive, specifically so
 *    a WRONG-TYPED value (a number where a string was expected, a string
 *    where an array was expected) degrades the same way a missing one does,
 *    instead of failing `.safeParse` for the whole body. This closes a
 *    hazard class that surfaced three review rounds running (round 1 F1,
 *    round 3 M1, and this one): treating "optional" as `.nullish()` on an
 *    otherwise-typed field still lets any OTHER wrong type on that field nuke
 *    the parse.
 *
 *    `permissions` echoes Console's raw string as-is when it is a non-empty
 *    string, and otherwise falls back to `UNREPORTED_PERMISSION` — a string
 *    that reads as "we don't know" rather than as a real tier. This
 *    deliberately does NOT default to `"read_only"`/`"read_write"` or to the
 *    caller's requested permission: either would silently claim the minted
 *    key has a permission it may not actually have. `permissions` is
 *    pass-through display data (`GenerateApiKeyResult.permission`, itself now
 *    `string` rather than `ApiKeyPermission` for the same reason) — nothing
 *    in `KeyAdminService` branches on the parsed response value, only on the
 *    caller's own `args.permission` request, so loosening the type has no
 *    control-flow effect.
 *
 *    `status` falls back to `"registering"` (a real Console value meaning
 *    "poll me") for anything that isn't a non-empty string — missing, null,
 *    or wrong-typed alike. That is the honest assumption when the field
 *    can't be read: keep polling rather than guess "active".
 *
 *    `private_buckets` distinguishes "Console said this space has zero
 *    private buckets" from "we don't know" — the two mean OPPOSITE things to
 *    `KeyAdminService.generateApiKey`'s grant step (see its own comments): an
 *    explicit `[]` skips granting because there is nothing to grant; `null`
 *    means grants were skipped because Console's response didn't say. A
 *    non-array value (missing, `null`, or any other wrong type) parses to
 *    `null` for exactly this reason.
 *
 *    A real, non-empty array is Console making a POSITIVE assertion — "this
 *    space has private buckets" — and that assertion is trusted, but only
 *    once EVERY element in it parses via `privateBucketGrantSchema.safeParse`.
 *    If even one element fails, the whole array parses to `null`, not a
 *    filtered-down list of the elements that DID parse: a caller who reads a
 *    partial array as authoritative grants access to the buckets it could
 *    read and silently skips the rest, ending up with a key that has NO
 *    access to whichever buckets were behind the unparseable element(s) and
 *    nothing in the outcome saying so — an under-grant, not an over-grant,
 *    but a silent one either way. That is worse than not knowing at all,
 *    because it looks like success (`ok: true`) right up until someone hits a
 *    permission error on a bucket that was silently dropped. An unreadable
 *    element in an otherwise-real array is, if anything, a STRONGER signal of
 *    "unknown" than a missing field is: a missing field is merely ambiguous,
 *    while a non-empty-but-partially-unreadable array positively tells us
 *    there was real data here that this parse could not fully trust. An
 *    explicit `[]`, by contrast, has no elements to fail on and stays a real,
 *    trusted empty array — Console's word that there is nothing to grant.
 *
 *    So `null` has THREE distinct causes, all folded into one value on
 *    purpose (`KeyAdminService.generateApiKey` reacts identically to all
 *    three — see its own `"private-buckets-unknown"` stage): the field was
 *    missing or `null`; the field was present but not an array; or the field
 *    WAS a real, non-empty array and at least one of its elements failed
 *    `privateBucketGrantSchema.safeParse`.
 *
 * `name`, `service_signer_address`, `expected_permission`, and `created_at` are
 * real wire fields but nothing in this codebase reads them, so they are
 * deliberately left out entirely: an unread field changing shape upstream must
 * not break a mint. See docs/pr-39-code-review.md section 3.
 */
const createApiKeyResponseSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1), // hbr_… raw bearer, shown once
  space_id: z.string().min(1),
  permissions: z
    .unknown()
    .transform((v) => (typeof v === "string" && v.length > 0 ? v : UNREPORTED_PERMISSION)),
  status: z.unknown().transform((v) => (typeof v === "string" && v.length > 0 ? v : "registering")),
  private_buckets: z.unknown().transform((v): readonly PrivateBucketGrant[] | null => {
    if (!Array.isArray(v)) return null; // missing, null, or simply not an array
    if (v.length === 0) return []; // Console's own word: no private buckets
    // A non-empty array is Console asserting buckets EXIST — if any element
    // can't be read, the whole list is untrustworthy (not just that element):
    // granting only the elements that DID parse would silently under-grant.
    // See this schema's doc comment above.
    const grants: PrivateBucketGrant[] = [];
    for (const el of v) {
      const parsed = privateBucketGrantSchema.safeParse(el);
      if (!parsed.success) return null;
      grants.push(parsed.data);
    }
    return grants;
  }),
});
export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponseSchema>;

/** Response of POST /api/v1/seal/sponsor (sponsored grant_bucket_access PTB). */
export interface SponsorResponse {
  readonly bytes: string; // base64 transaction kind bytes
  readonly digest: string; // 0x…
}

/**
 * Response of GET /api/v1/api-keys/:id while a mint is registering / once active.
 *
 * Narrow on purpose — only `data.status` and `data.registration_progress` are
 * read (by `pollUntilActive` in KeyAdminService.ts). `data.id` is a real wire
 * field nothing here reads, so it is left out. See docs/pr-39-code-review.md
 * section 3.
 *
 * `data.status` is a plain string, not a closed enum, for the SAME reason
 * `createApiKeyResponseSchema.status` above is: `pollUntilActive` polls this
 * endpoint in a loop purely to compare against the literal `"active"`, so a
 * Console-side status this build has never seen (say `"pending"`) must not
 * turn every poll of an otherwise-healthy mint into an `invalid_response_shape`
 * failure — that would report a misleading `stage: "activation"` outcome for a
 * key that is registering completely normally. (The credential is still
 * preserved either way, since `KeyAdminService` treats this as a post-mint
 * failure — but a wrong "the key is stuck" reading is still wrong.)
 *
 * `registration_progress` is `.nullish()`, not `.optional()`: JSON APIs
 * routinely serialize an absent optional field as an explicit `null` rather
 * than omitting the key, and the old `as ApiKeyStatusResponse` cast tolerated
 * either (`pollUntilActive` just left `progress` falsy either way). `.optional()`
 * alone rejects `null` outright, which would fail every poll of a `registering`
 * key that had not yet accrued any grants — a regression `.nullish()` closes.
 */
const apiKeyStatusResponseSchema = z.object({
  data: z.object({
    status: z.string(),
    registration_progress: z.object({ granted: z.number(), total: z.number() }).nullish(),
  }),
});
export type ApiKeyStatusResponse = z.infer<typeof apiKeyStatusResponseSchema>;

/** Console error bodies arrive as `{ error: "msg" }` or `{ error: { code, message } }`. */
interface ConsoleErrorBody {
  readonly code?: string;
  readonly message?: string;
  readonly error?: string | { readonly code?: string; readonly message?: string };
}

/**
 * Pull `{ code, message }` out of a decoded Console error body.
 *
 * Shapes verified against the Console API source, not assumed. Its global
 * `errorHandler` serializes every 4xx domain error as
 * `{ error: message, ...(code ? { code } : {}) }` and the OpenAPI
 * `ErrorResponse` schema types `error` as a plain string, so production emits:
 *
 *   `{ error: "msg", code: "…" }`  the common 4xx (incl. mirror_missing_grant)
 *   `{ error: "msg" }`             errors carrying no code (e.g. NotFoundError)
 *   `{ code: "…", limit, … }`      PlanLimitExceeded (422) — no `error` key
 *
 * The nested `{ error: { code, message } }` branch is defensive: no Console
 * route emits it today, but a gateway could, and without it `String(message)`
 * on an object would yield "[object Object]" while the code vanished.
 *
 * Pure and exported so the raw-`fetch` paths (multipart upload / download) can
 * reuse the exact parsing the HttpClient paths get, and so it is unit-testable.
 */
export function parseConsoleErrorBody(body: unknown): {
  code: string | undefined;
  message: string | undefined;
} {
  if (typeof body !== "object" || body === null) return { code: undefined, message: undefined };
  const { code, message, error } = body as ConsoleErrorBody;
  return {
    code: code ?? (error && typeof error === "object" ? error.code : undefined),
    message: (typeof error === "string" ? error : error?.message) ?? message,
  };
}

/**
 * Flatten a Zod validation failure into one readable line naming WHICH
 * field(s) were wrong, e.g. `"id: Required; status: Invalid enum value"`.
 * Used at the `createApiKey` / `getApiKeyStatus` parse boundary so a
 * `ConsoleApiError.message` says more than "the response was malformed".
 */
function zodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * The `ConsoleApiError` `createApiKey` fails with when a definite 201 —
 * Console's own point of no return — turns out to carry a body this client
 * cannot use. Shared by BOTH ways that can happen: the body isn't valid JSON
 * at all (a proxy injecting an HTML error page, a truncated connection —
 * `res.json` itself fails, before `safeParse` ever runs), or it decodes fine
 * but fails schema validation. Both routes need the IDENTICAL shape
 * (`code: "invalid_response_shape"`, `status: 201`) because both are meant to
 * reach `KeyAdminService.generateApiKey`'s `createApiKey` `catchIf` and
 * convert into the same recoverable `stage: "mint"` outcome — not the
 * `isError: true` that would otherwise invite a second-orphan retry. Scoped
 * to `createApiKey` only: `getApiKeyStatus`'s identical `res.json` pattern is
 * NOT wrapped this way, because it runs inside `KeyAdminService`'s
 * `completion` pipeline, where `Effect.exit` already catches a decode failure
 * and preserves the credential — wrapping it here too would just be doing the
 * same job twice.
 */
function createApiKeyUnusableResponse(detail: string): ConsoleApiError {
  return new ConsoleApiError({
    message:
      `createApiKey received a 201 response that could not be used: ${detail} This does NOT ` +
      `mean nothing was created — the mint is a point of no return, so the key may already ` +
      `exist server-side despite this failure. Check the pre-mint marker breadcrumb logged to ` +
      `stderr before this call to find it by name in the Console UI.`,
    code: "invalid_response_shape",
    status: 201,
  });
}

/**
 * Fail with a `ConsoleApiError` built from a non-OK raw-`fetch` response,
 * preserving the Console error `code`.
 *
 * Always a `ConsoleApiError`, never a `ConsoleAuthError` — even on 403. Console
 * returns `mirror_missing_grant` (an ACL grant that has not propagated on-chain
 * yet) as a **403**, and `ConsoleStorageService`'s upload retry matches on
 * `ConsoleApiError.code`. Routing these through `handleError` instead would map
 * every 401/403 to a `ConsoleAuthError`, whose closed `code` union collapses
 * anything unmodeled to "invalid_api_key" — silently disabling that retry.
 */
function failFromFetchResponse(
  response: Response,
  action: string,
): Effect.Effect<never, ConsoleApiError> {
  return Effect.gen(function* () {
    // Bounded: a non-OK response from a hostile-but-allowlisted endpoint could
    // carry a multi-megabyte body, and this text ends up on a long-lived error.
    const text = yield* Effect.tryPromise(() => boundedResponseText(response)).pipe(
      Effect.catchAll(() => Effect.succeed("")),
    );
    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      decoded = undefined; // non-JSON body (proxy HTML, empty) — fall back to raw text
    }
    const { code, message } = parseConsoleErrorBody(decoded);
    return yield* Effect.fail(
      new ConsoleApiError({
        message: `${action} failed with status ${response.status}: ${message ?? text}`,
        ...(code !== undefined ? { code } : {}),
        status: response.status,
      }),
    );
  });
}

/**
 * Typed Console REST API client as an Effect v3 Service.
 * Uses @effect/platform HttpClient (with bearer auth pre-processor).
 * Matches console/api service conventions (Effect.fn, annotate, TaggedError).
 *
 * Only the curated external surface (Bearer-only) is implemented.
 */

/** Internal marker so `readBounded`'s cap breach is distinguishable from an I/O error. */
class TransferTooLargeError extends Error {
  constructor(readonly bytesRead: number) {
    super(`download exceeded ${bytesRead} bytes`);
  }
}

const oversizedDownload = (fileId: FileId, bytes: number, limit: number) =>
  new PayloadTooLargeError({
    message:
      `Download is ${bytes} bytes, over the ${limit}-byte transfer limit. The server buffers ` +
      `the ciphertext and its decrypted plaintext at once, so an unbounded download can end ` +
      `the MCP session. Raise ${MAX_TRANSFER_BYTES_ENV} if this file really is meant to be ` +
      `this large.`,
    fileName: fileId,
    bytes,
  });

/**
 * Read a response body into one buffer, aborting as soon as the running total
 * passes `limit`.
 *
 * `arrayBuffer()` cannot be used here: it resolves only once the entire body is
 * already in memory, which is precisely the allocation being guarded against.
 */
async function readBounded(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      // Checked per chunk, not just at the fetch: by this point the response has
      // started and the body could still be many chunks long.
      if (signal?.aborted) {
        await reader.cancel();
        throw new Error("download aborted");
      }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        throw new TransferTooLargeError(total);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Bytes of an ERROR body we are willing to buffer before giving up on it.
 *
 * An error body is a `{ code, message }` JSON a few hundred bytes long; anything
 * past this is a misbehaving or hostile endpoint (a multi-megabyte proxy HTML
 * page, or a stream that never ends). The failure path runs in a long-lived
 * process, so an unbounded read here is the same liveness hazard the transfer cap
 * guards against on the happy path — and it is deliberately far below that
 * 256 MiB cap, because an error is not a transfer. Large enough that no real
 * Console error body is ever truncated, so `parseConsoleErrorBody` keeps working.
 */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * Concatenate up to `MAX_ERROR_BODY_BYTES` of body chunks into UTF-8 text,
 * appending a marker when the body was cut short. Pure, so both the raw-`fetch`
 * and the HttpClient error paths share one truncation rule.
 */
function decodeBoundedBody(chunks: readonly Uint8Array[], truncated: boolean): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const cap = Math.min(total, MAX_ERROR_BODY_BYTES);
  const buf = new Uint8Array(cap);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= cap) break;
    const slice = chunk.subarray(0, cap - offset);
    buf.set(slice, offset);
    offset += slice.length;
  }
  const text = new TextDecoder().decode(buf);
  return truncated ? `${text}… (response body truncated)` : text;
}

/**
 * Read a non-OK raw-`fetch` body into bounded text, cancelling whatever is left
 * once the cap is reached rather than draining (and buffering) the whole thing.
 */
async function boundedResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return decodeBoundedBody([new Uint8Array(await response.arrayBuffer())], false);

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    if (total >= MAX_ERROR_BODY_BYTES) {
      truncated = true;
      await reader.cancel();
    }
  } finally {
    reader.releaseLock();
  }
  return decodeBoundedBody(chunks, truncated);
}

export class ConsoleApiClient extends Effect.Service<ConsoleApiClient>()("ConsoleApiClient", {
  effect: Effect.gen(function* () {
    const config = yield* ConsoleConfigTag;
    const http = yield* HttpClient.HttpClient;

    // Authenticated client: prepend the API base URL + Bearer header for every request
    const authed = http.pipe(
      HttpClient.mapRequest(HttpClientRequest.prependUrl(config.baseUrl)),
      HttpClient.mapRequest((req) =>
        HttpClientRequest.setHeader(req, "Authorization", `Bearer ${getRawApiKey(config)}`),
      ),
      HttpClient.mapRequest(HttpClientRequest.acceptJson),
    );

    // Admin-authed client: identical, but bears the isolated Key-Admin credential
    // (hbradm_…) instead of the working key. Used only by the mint flow — callers MUST
    // gate on hasAdminCredential() first, otherwise this sends an empty `Bearer ` header.
    const adminAuthed = http.pipe(
      HttpClient.mapRequest(HttpClientRequest.prependUrl(config.baseUrl)),
      HttpClient.mapRequest((req) =>
        HttpClientRequest.setHeader(req, "Authorization", `Bearer ${getRawAdminKey(config)}`),
      ),
      HttpClient.mapRequest(HttpClientRequest.acceptJson),
    );

    const handleError = (res: HttpClientResponse.HttpClientResponse) =>
      Effect.gen(function* () {
        // Bound the body BEFORE decoding it: `res.json` buffers the whole thing,
        // so a hostile endpoint's oversized error body would be read in full. Read
        // the stream up to the cap, cancelling the rest, then parse what we got —
        // a real Console error is a small JSON well under the cap, so this is a
        // no-op for it; an over-cap body is truncated (and so fails to parse,
        // falling back to the status line) rather than buffered.
        const rawText = yield* res.stream.pipe(
          Stream.runFoldWhile(
            { chunks: [] as Uint8Array[], total: 0 },
            (acc) => acc.total < MAX_ERROR_BODY_BYTES,
            (acc, chunk: Uint8Array) => ({
              chunks: [...acc.chunks, chunk],
              total: acc.total + chunk.length,
            }),
          ),
          Effect.map(({ chunks, total }) =>
            decodeBoundedBody(chunks, total >= MAX_ERROR_BODY_BYTES),
          ),
          Effect.catchAll(() => Effect.succeed("")),
        );
        let body: ConsoleErrorBody = {};
        try {
          body = JSON.parse(rawText) as ConsoleErrorBody;
        } catch {
          // Non-JSON or truncated body — leave {} so `message` falls back to the
          // status line below, exactly as the old `res.json` catch did.
        }
        const parsed = parseConsoleErrorBody(body);
        const code = parsed.code;
        const message = parsed.message ?? `HTTP ${res.status}`;
        if (res.status === 401 || res.status === 403) {
          return yield* Effect.fail(
            new ConsoleAuthError({
              message: String(message),
              // Preserve the real code where Console gives us one we model (read_only /
              // scope violations from the mint endpoints); otherwise fall back.
              code:
                code === "read_only_api_key"
                  ? "read_only_api_key"
                  : code === "insufficient_scope"
                    ? "insufficient_scope"
                    : "invalid_api_key",
            }),
          );
        }
        return yield* Effect.fail(
          new ConsoleApiError({
            message: String(message),
            ...(code !== undefined ? { code } : {}),
            status: res.status,
          }),
        );
      });

    // Multipart upload uses raw `fetch` (not the platform HttpClient) so it has
    // its own error mapping. Splits Console's 415 (deny list, COMG-590) and 413
    // (size cap) into dedicated tags so agents can branch on
    // "never going to work" vs "retry later".
    const handleUploadError = (response: Response, fileName: string, bytes: number) =>
      Effect.gen(function* () {
        // Bounded, like the download path: an oversized or endless error body must
        // not be buffered into an error message in this long-lived process.
        const rawText = yield* Effect.tryPromise(() => boundedResponseText(response)).pipe(
          Effect.catchAll(() => Effect.succeed("")),
        );
        let code: string | undefined;
        let message: string | undefined;
        if (rawText.length > 0) {
          try {
            const body = JSON.parse(rawText) as ConsoleErrorBody;
            const errBody = body.error;
            code = body.code ?? (errBody && typeof errBody === "object" ? errBody.code : undefined);
            message = (typeof errBody === "string" ? errBody : errBody?.message) ?? body.message;
          } catch {
            // Non-JSON body (proxy/gateway HTML page). Fall through: status alone
            // is enough to classify deny vs size; body text goes on ConsoleApiError.
          }
        }
        if (response.status === 415 || code === "unsupported_file_type") {
          return yield* Effect.fail(
            new UnsupportedFileTypeError({
              message: message ?? "This file type is not accepted.",
              fileName,
              // Console emits the same code for both enforcement layers; without
              // an explicit hint we can't tell them apart, so record "server".
              layer: "server",
              ...(code !== undefined ? { code } : {}),
            }),
          );
        }
        if (response.status === 413 || code === "payload_too_large") {
          return yield* Effect.fail(
            new PayloadTooLargeError({
              message: message ?? "Payload too large.",
              fileName,
              bytes,
              ...(code !== undefined ? { code } : {}),
            }),
          );
        }
        return yield* Effect.fail(
          new ConsoleApiError({
            message: `Upload failed with status ${response.status}${
              rawText.length > 0 ? `: ${rawText}` : ""
            }`,
            ...(code !== undefined ? { code } : {}),
            status: response.status,
          }),
        );
      });

    const listSpaces = Effect.fn("ConsoleApiClient.listSpaces")(function* (filter?: {
      type?: "personal" | "team" | undefined;
    }) {
      const url = filter?.type ? `/api/v1/spaces?type=${filter.type}` : "/api/v1/spaces";
      const res = yield* authed.get(url);
      if (res.status !== 200) return yield* handleError(res);
      const json = (yield* res.json) as DataEnvelope<readonly SpaceListItem[]>;
      return json.data;
    });

    const getStorageUsage = Effect.fn("ConsoleApiClient.getStorageUsage")(function* () {
      const res = yield* authed.get("/api/v1/usage");
      if (res.status !== 200) return yield* handleError(res);
      const json = (yield* res.json) as DataEnvelope<StorageUsage>;
      return json.data;
    });

    const listBuckets = Effect.fn("ConsoleApiClient.listBuckets")(function* (args: {
      spaceId: SpaceId;
      limit?: number | undefined;
      cursor?: string | undefined;
      q?: string | undefined;
      visibility?: "public" | "private" | undefined;
    }) {
      const params = new URLSearchParams();
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      if (args.cursor) params.set("cursor", args.cursor);
      if (args.q) params.set("q", args.q);
      if (args.visibility) params.set("visibility", args.visibility);

      const res = yield* authed.get(`/api/v1/spaces/${args.spaceId}/buckets?${params.toString()}`);
      if (res.status !== 200) return yield* handleError(res);
      const json = (yield* res.json) as {
        buckets: readonly Bucket[];
        next_cursor: string | null;
      };
      return {
        buckets: json.buckets,
        next_cursor: json.next_cursor,
      };
    });

    // === Write flows support ===

    /**
     * Reserve a bucket-creation PTB. `members` is a REQUIRED parameter, not an
     * optional one with a default: the server treats `[]` (an authored EMPTY
     * roster) as semantically different from an ABSENT `members` key (fall
     * back to the server's own derived roster) — and this client's
     * `txValidation` refuses a server-derived roster it never asked for. So
     * every call site must decide its roster explicitly; there is no call
     * shape here that silently omits the key.
     *
     * `expectedOwnerAddress` is the caller's diagnostic cross-check against
     * the space's on-chain owner; a mismatch is a 409
     * (`bucket_create_owner_mismatch`) surfaced via `handleError`. Both it and
     * every member address are normalized here (`normalizeSuiAddress`)
     * because config pins are stored raw and `isValidSuiAddress` accepts
     * mixed-case / `0x`-less forms — this is the boundary where that gets
     * resolved before the address leaves the process.
     */
    const createBucket = Effect.fn("ConsoleApiClient.createBucket")(function* (
      spaceId: SpaceId,
      name: string,
      expectedOwnerAddress: string,
      members: readonly RosterMember[],
    ) {
      const body = {
        name,
        scope: "private",
        expectedOwnerAddress: normalizeSuiAddress(expectedOwnerAddress),
        members: members.map((member) => ({
          address: normalizeSuiAddress(member.address),
          role: member.role,
        })),
      };
      const res = yield* authed.post(`/api/v1/spaces/${spaceId}/buckets`, {
        body: HttpBody.text(JSON.stringify(body), "application/json"),
      });
      if (res.status !== 201) return yield* handleError(res);
      return (yield* res.json) as CreateBucketReserveResponse;
    });

    const finalizeBucket = Effect.fn("ConsoleApiClient.finalizeBucket")(function* (
      bucketId: BucketId,
      signature: string,
    ) {
      const res = yield* authed.post(`/api/v1/buckets/${bucketId}/finalize`, {
        body: HttpBody.text(JSON.stringify({ signature }), "application/json"),
      });
      if (res.status !== 200) return yield* handleError(res);
      return (yield* res.json) as FinalizeBucketResponse;
    });

    const getBucketById = Effect.fn("ConsoleApiClient.getBucketById")(function* (
      bucketId: BucketId,
    ) {
      const res = yield* authed.get(`/api/v1/buckets/${bucketId}`);
      if (res.status !== 200) return yield* handleError(res);
      const json = (yield* res.json) as DataEnvelope<Bucket>;
      return json.data;
    });

    const updateBucket = Effect.fn("ConsoleApiClient.updateBucket")(function* (
      bucketId: BucketId,
      body: {
        name: string;
        visibility?: "public" | "private";
        sealPolicyId?: string | null;
      },
    ) {
      const res = yield* authed.put(`/api/v1/buckets/${bucketId}`, {
        body: HttpBody.text(JSON.stringify(body), "application/json"),
      });
      if (res.status !== 200) return yield* handleError(res);
      const json = (yield* res.json) as Bucket & { data?: Bucket };
      return json.data ?? json;
    });

    const renameBucket = Effect.fn("ConsoleApiClient.renameBucket")(function* (
      bucketId: BucketId,
      newName: string,
    ) {
      // PUT /buckets/{id} is a partial update. visibility (and sealPolicyId) are immutable
      // server-side — sending visibility at all returns 403 "Visibility cannot be changed
      // after creation" — so a rename sends only the name.
      return yield* updateBucket(bucketId, { name: newName });
    });

    const deleteBucket = Effect.fn("ConsoleApiClient.deleteBucket")(function* (bucketId: BucketId) {
      // Console guards bucket deletion behind ?confirm=true (it deletes all contained files).
      const res = yield* authed.del(`/api/v1/buckets/${bucketId}?confirm=true`);
      // Console returns 204 No Content on success.
      if (res.status !== 200 && res.status !== 204) {
        return yield* handleError(res);
      }
      return { id: bucketId, deleted: true };
    });

    const uploadBucketFile = Effect.fn("ConsoleApiClient.uploadBucketFile")(function* (
      bucketId: BucketId,
      // `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`: @types/node widens the
      // latter to `Uint8Array<ArrayBufferLike>`, which BlobPart rejects because the
      // buffer could be a SharedArrayBuffer. Stating the requirement on the
      // parameter puts it where it is already satisfied — Seal's encrypt() returns
      // exactly this type — instead of erasing it here by copying every encrypted
      // file. A caller handing over `fs.readFile` output now fails to compile,
      // which is the honest answer: Buffer's `.slice()` is `subarray()` and would
      // not have produced the unshared buffer the old comment claimed anyway.
      fileBytes: Uint8Array<ArrayBuffer>,
      fileName: string,
      metadata?: Record<string, unknown>,
      contentSize?: number,
    ) {
      // Pragmatic multipart using native fetch (reliable for MCP use case)
      const form = new FormData();
      const blob = new Blob([fileBytes], { type: contentTypeFromName(fileName) });
      form.append("file", blob, fileName);
      if (metadata) {
        form.append("metadata", JSON.stringify(metadata));
      }
      // Private uploads carry ciphertext, so the server cannot infer the plaintext
      // length. Declare it or the file reports its encrypted size forever — there
      // is no backfill (COMG-264).
      if (contentSize !== undefined) {
        form.append("contentSize", String(contentSize));
      }

      const url = `${config.baseUrl}/api/v1/buckets/${bucketId}/files`;
      // `Effect.tryPromise` hands its callback the RUNNING FIBER's AbortSignal, so
      // threading it into fetch is all it takes for a cancelled MCP request to
      // actually stop the transfer rather than just disconnect the caller.
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${getRawApiKey(config)}`,
            },
            body: form,
            signal,
          }),
        catch: () => new ConsoleApiError({ message: "Multipart upload failed" }),
      });

      if (response.status !== 202) {
        return yield* handleUploadError(response, fileName, fileBytes.byteLength);
      }

      const json = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () =>
          new ConsoleApiError({
            // A 202 means the upload was ACCEPTED — the bytes are stored and the
            // server has an id for them — so an unreadable body here is NOT an
            // upload failure. Say so, and steer away from the one response that
            // makes it worse: re-uploading duplicates a file the server already
            // has. The file is findable by the name it was uploaded under.
            message:
              `The upload was ACCEPTED (HTTP 202) but its response body could not be read, so ` +
              `the server's file id is not available here. Do NOT upload again — that would ` +
              `duplicate a file the server already has. Find it with list_files (search by the ` +
              `name you uploaded), then track its processing with get_file_status.`,
            status: response.status,
          }),
      });
      return json as FileUploadResponse;
    });

    const getFileUploadStatus = Effect.fn("ConsoleApiClient.getFileUploadStatus")(function* (
      bucketId: BucketId,
      fileId: FileId,
    ) {
      const res = yield* authed.get(`/api/v1/buckets/${bucketId}/files/${fileId}/status`);
      if (res.status !== 200) return yield* handleError(res);
      return (yield* res.json) as FileStatusResponse;
    });

    const downloadBucketFile = Effect.fn("ConsoleApiClient.downloadBucketFile")(function* (
      bucketId: BucketId,
      fileId: FileId,
    ) {
      const url = `${config.baseUrl}/api/v1/buckets/${bucketId}/files/${fileId}/download`;
      // Same as the upload above: the fiber's signal reaches fetch, so an aborted
      // request tears the connection down instead of streaming a file nobody wants.
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${getRawApiKey(config)}`,
            },
            signal,
          }),
        catch: () => new ConsoleApiError({ message: "Download failed" }),
      });

      // Same parsing as upload: a private download can also 403 with
      // mirror_missing_grant, and callers need the code to say so usefully.
      if (response.status !== 200) return yield* failFromFetchResponse(response, "Download");

      // The response body is buffered whole, and Seal then allocates the decrypted
      // plaintext beside it — so an unbounded download is two unbounded
      // allocations in a process that is meant to outlive the transfer.
      const limit = maxTransferBytes();

      // Trust `Content-Length` FIRST, because it is the only check that can reject
      // before anything is buffered. Cancel the body on the way out: an abandoned
      // stream holds the socket open and, in a long-lived process, leaks it.
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > limit) {
        yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
        return yield* Effect.fail(oversizedDownload(fileId, declared, limit));
      }

      // Then enforce it again while reading. The header is a claim by the server,
      // not a guarantee — it can be absent, or wrong — so the running byte count is
      // what actually bounds memory.
      const body = yield* Effect.tryPromise({
        try: (signal) => readBounded(response, limit, signal),
        catch: (cause) =>
          cause instanceof TransferTooLargeError
            ? oversizedDownload(fileId, cause.bytesRead, limit)
            : new ConsoleApiError({
                message: "Failed to read download body",
                status: response.status,
              }),
      });
      return body;
    });

    const deleteBucketFile = Effect.fn("ConsoleApiClient.deleteBucketFile")(function* (
      bucketId: BucketId,
      fileId: FileId,
    ) {
      const res = yield* authed.del(`/api/v1/buckets/${bucketId}/files/${fileId}`);
      // Console returns 204 No Content on success; tolerate 200 with a body too.
      if (res.status !== 200 && res.status !== 204) {
        return yield* handleError(res);
      }
      return { id: fileId, deleted: true };
    });

    /**
     * PATCH /api/v1/files/:id — rename and/or edit description and tags
     * (COMG-475). `null` on a metadata field clears it; a field left out is
     * untouched. Console rejects a body with none of the three, so callers
     * build it with `buildFilePatch`, which returns undefined for an empty
     * patch rather than sending one.
     */
    const updateFile = Effect.fn("ConsoleApiClient.updateFile")(function* (
      fileId: FileId,
      patch: Record<string, unknown>,
    ) {
      const res = yield* authed.patch(`/api/v1/files/${fileId}`, {
        body: HttpBody.text(JSON.stringify(patch), "application/json"),
      });
      if (res.status !== 200) return yield* handleError(res);
      return (yield* res.json) as { data: FileSummary };
    });

    /** GET /api/v1/buckets/:id/metadata — folder description + tags (COMG-489). */
    const getBucketMetadata = Effect.fn("ConsoleApiClient.getBucketMetadata")(function* (
      bucketId: BucketId,
    ) {
      const res = yield* authed.get(`/api/v1/buckets/${bucketId}/metadata`);
      if (res.status !== 200) return yield* handleError(res);
      return (yield* res.json) as { data: BucketMetadata };
    });

    /**
     * PATCH /api/v1/buckets/:id/metadata.
     *
     * Unlike the file patch above, the Console schema here is `.optional()`
     * without `.nullable()` — sending `null` is a 400, not a clear.
     */
    const updateBucketMetadata = Effect.fn("ConsoleApiClient.updateBucketMetadata")(function* (
      bucketId: BucketId,
      patch: Record<string, unknown>,
    ) {
      const res = yield* authed.patch(`/api/v1/buckets/${bucketId}/metadata`, {
        body: HttpBody.text(JSON.stringify(patch), "application/json"),
      });
      if (res.status !== 200) return yield* handleError(res);
      return (yield* res.json) as { data: BucketMetadata };
    });

    const listBucketFiles = Effect.fn("ConsoleApiClient.listBucketFiles")(function* (
      bucketId: BucketId,
      limit?: number,
      cursor?: string,
      q?: string,
    ) {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (cursor) params.set("cursor", cursor);
      if (q) params.set("q", q);

      const res = yield* authed.get(`/api/v1/buckets/${bucketId}/files?${params.toString()}`);
      if (res.status !== 200) return yield* handleError(res);
      return (yield* res.json) as FileListResponse;
    });

    /**
     * GET /api/v1/api-keys/space-signers — candidate roster addresses for a
     * later create-bucket authoring step (Task 7). Space is resolved from
     * auth; no params, no body.
     *
     * Deliberately on the `authed` (working-key) lane, NOT `adminAuthed`:
     * Console accepts session-or-any-active-API-key here, so a plain
     * WORKING key can call it — and that is exactly the population this
     * exists for. A worker host holds no admin credential at all, so putting
     * this on `adminAuthed` would break it for the very host the feature is
     * for.
     */
    const listSpaceSigners = Effect.fn("ConsoleApiClient.listSpaceSigners")(function* () {
      const res = yield* authed.get("/api/v1/api-keys/space-signers");
      if (res.status !== 200) return yield* handleError(res);
      return (yield* res.json) as SpaceSignersResponse;
    });

    // === Key-Admin mint flow (all calls bear the hbradm_ credential) ===

    const createApiKey = Effect.fn("ConsoleApiClient.createApiKey")(function* (args: {
      permissions: ApiKeyPermission;
      serviceSignerAddress: string;
      name?: string | undefined;
    }) {
      const body = {
        permissions: args.permissions,
        serviceSignerAddress: args.serviceSignerAddress,
        ...(args.name ? { name: args.name } : {}),
      };

      const res = yield* adminAuthed.post("/api/v1/api-keys", {
        body: HttpBody.text(JSON.stringify(body), "application/json"),
      });
      if (res.status !== 201) return yield* handleError(res);
      // `res.json` itself can fail — a proxy injecting an HTML error page, a
      // truncated connection — and that failure is an `@effect/platform`
      // `ResponseError`, NOT a `ConsoleApiError`. Left uncaught, it would ride
      // the error channel straight past `KeyAdminService`'s `catchIf` (which
      // only matches `ConsoleApiError`), reaching the caller as `isError: true`
      // with no marker and no "do NOT retry" guidance on a mint that is,
      // exactly like the schema-mismatch case below, already a point of no
      // return. Converted here into the SAME `ConsoleApiError` shape so both
      // routes reach the same `stage: "mint"` recovery.
      const decodedBody = yield* res.json.pipe(
        Effect.catchTag("ResponseError", (error) =>
          Effect.fail(
            createApiKeyUnusableResponse(
              `Its body could not be parsed as JSON (${error.message}).`,
            ),
          ),
        ),
      );
      const parsed = createApiKeyResponseSchema.safeParse(decodedBody);
      if (!parsed.success) {
        return yield* Effect.fail(
          createApiKeyUnusableResponse(`It failed schema validation: ${zodIssues(parsed.error)}.`),
        );
      }
      return parsed.data;
    });

    const sponsorGrantBucketAccess = Effect.fn("ConsoleApiClient.sponsorGrantBucketAccess")(
      function* (args: {
        groupIds: readonly string[];
        recipientAddress: string;
        scope: "read" | "readwrite";
      }) {
        const res = yield* adminAuthed.post("/api/v1/seal/sponsor", {
          body: HttpBody.text(
            JSON.stringify({
              kind: "grant_bucket_access",
              groupIds: args.groupIds,
              recipientAddress: args.recipientAddress,
              scope: args.scope,
            }),
            "application/json",
          ),
        });
        if (res.status !== 200) return yield* handleError(res);
        return (yield* res.json) as SponsorResponse;
      },
    );

    const executeSponsored = Effect.fn("ConsoleApiClient.executeSponsored")(function* (
      digest: string,
      signature: string,
    ) {
      const res = yield* adminAuthed.post(
        `/api/v1/seal/sponsor/${encodeURIComponent(digest)}/execute`,
        { body: HttpBody.text(JSON.stringify({ signature }), "application/json") },
      );
      if (res.status !== 200) return yield* handleError(res);
      return (yield* res.json) as { digest: string };
    });

    const getApiKeyStatus = Effect.fn("ConsoleApiClient.getApiKeyStatus")(function* (
      keyId: string,
    ) {
      const res = yield* adminAuthed.get(`/api/v1/api-keys/${encodeURIComponent(keyId)}`);
      if (res.status !== 200) return yield* handleError(res);
      const parsed = apiKeyStatusResponseSchema.safeParse(yield* res.json);
      if (!parsed.success) {
        return yield* Effect.fail(
          new ConsoleApiError({
            message:
              `getApiKeyStatus received a 200 response that failed validation: ` +
              `${zodIssues(parsed.error)}.`,
            code: "invalid_response_shape",
            status: res.status,
          }),
        );
      }
      return parsed.data;
    });

    return {
      listSpaces,
      getStorageUsage,
      listBuckets,
      createApiKey,
      sponsorGrantBucketAccess,
      executeSponsored,
      getApiKeyStatus,
      createBucket,
      finalizeBucket,
      uploadBucketFile,
      getFileUploadStatus,
      downloadBucketFile,
      listBucketFiles,
      updateFile,
      getBucketMetadata,
      updateBucketMetadata,
      deleteBucketFile,
      getBucketById,
      updateBucket,
      renameBucket,
      deleteBucket,
      listSpaceSigners,
    } as const;
  }),
  // HttpClient + ConsoleConfigTag are provided by the AppLayer at the runtime composition point (see src/runtime.ts)
  dependencies: [],
}) {}
