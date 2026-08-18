import { HttpBody, HttpClient, HttpClientRequest, type HttpClientResponse } from "@effect/platform";
import { Effect } from "effect";
import { ConsoleConfigTag, getRawAdminKey, getRawApiKey } from "../config";
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
  readonly state: "pending_policy";
}

export interface FinalizeBucketResponse {
  readonly bucket_id: BucketId;
  readonly seal_policy_id: string | null;
  readonly state: string;
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

export interface PrivateBucketGrant {
  readonly bucket_id: string;
  readonly group_id: string; // 0x… Sui object id of the bucket's access group
}

/** Response of POST /api/v1/api-keys (mint child under key_admin scope). */
export interface CreateApiKeyResponse {
  readonly id: string;
  readonly name: string | null;
  readonly key: string; // hbr_… raw bearer, shown once
  readonly space_id: string;
  readonly permissions: ApiKeyPermission;
  readonly service_signer_address: string;
  readonly status: "registering" | "active";
  readonly expected_permission: "BucketViewer" | "BucketEditor" | null;
  readonly private_buckets: readonly PrivateBucketGrant[];
  readonly created_at: string;
}

/** Response of POST /api/v1/seal/sponsor (sponsored grant_bucket_access PTB). */
export interface SponsorResponse {
  readonly bytes: string; // base64 transaction kind bytes
  readonly digest: string; // 0x…
}

/** Response of GET /api/v1/api-keys/:id while a mint is registering / once active. */
export interface ApiKeyStatusResponse {
  readonly data: {
    readonly id: string;
    // "revoking"/"revoked" only occur on the revoke path (with a revocation_progress
    // sibling); modeled here so revoke_api_key/list_api_keys can reuse this shape.
    readonly status: "registering" | "active" | "revoking" | "revoked";
    readonly registration_progress?: { readonly granted: number; readonly total: number };
  };
}

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
    const text = yield* Effect.tryPromise(() => response.text()).pipe(
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
        const body: ConsoleErrorBody = yield* res.json.pipe(
          Effect.catchAll(() => Effect.succeed({})),
          Effect.map((b) => b as ConsoleErrorBody),
        );
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
        const rawText = yield* Effect.tryPromise(() => response.text()).pipe(
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

    const createBucket = Effect.fn("ConsoleApiClient.createBucket")(function* (
      spaceId: SpaceId,
      name: string,
    ) {
      const res = yield* authed.post(`/api/v1/spaces/${spaceId}/buckets`, {
        body: HttpBody.text(JSON.stringify({ name, scope: "private" }), "application/json"),
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
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${getRawApiKey(config)}`,
            },
            body: form,
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
            message: "Failed to parse upload response JSON",
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
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${getRawApiKey(config)}`,
            },
          }),
        catch: () => new ConsoleApiError({ message: "Download failed" }),
      });

      // Same parsing as upload: a private download can also 403 with
      // mirror_missing_grant, and callers need the code to say so usefully.
      if (response.status !== 200) return yield* failFromFetchResponse(response, "Download");

      const arrayBuffer = yield* Effect.tryPromise({
        try: () => response.arrayBuffer(),
        catch: () =>
          new ConsoleApiError({ message: "Failed to read download body", status: response.status }),
      });
      return new Uint8Array(arrayBuffer);
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
      return (yield* res.json) as CreateApiKeyResponse;
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
      return (yield* res.json) as ApiKeyStatusResponse;
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
    } as const;
  }),
  // HttpClient + ConsoleConfigTag are provided by the AppLayer at the runtime composition point (see src/runtime.ts)
  dependencies: [],
}) {}
