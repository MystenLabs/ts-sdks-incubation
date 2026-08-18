/**
 * Smoke test for the upload retry on `mirror_missing_grant`.
 *
 * Run:  npx tsx scripts/smoke-upload-retry.mts
 *
 * Needs no credentials and no network — every HTTP call is stubbed. Takes ~6s,
 * because it lets the real retry sleep rather than faking the clock: the point
 * is to prove the production path actually waits and retries.
 *
 * Background. Console answers an upload into a freshly created private bucket
 * with 403 `mirror_missing_grant` until the bucket's on-chain access grant has
 * propagated. `ConsoleStorageService` is built to ride that out — it retries up
 * to 12 times, 3s apart. But the guard is
 *
 *     lastErr instanceof ConsoleApiError && lastErr.code === "mirror_missing_grant"
 *
 * and the multipart upload used to drop `code` on the floor, so the guard never
 * matched and the retry never ran. It had been dead since the first commit.
 *
 * Two traps this pins down, both of which look fine in a unit test that only
 * checks "is some field populated":
 *
 *   1. The error must stay a ConsoleApiError. Routing 401/403 through the shared
 *      `handleError` produces a ConsoleAuthError, whose `code` is a closed union
 *      that collapses anything unmodeled to "invalid_api_key" — so the retry
 *      silently dies even though a code is present.
 *   2. `code` must survive every body shape Console emits — including the 422
 *      that carries a code with no `error` key at all.
 *
 * Exit code 0 when every stage behaves as expected, 1 otherwise.
 */
import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { ConsoleConfigTag } from "../src/config.js";
import { ConsoleApiClient, parseConsoleErrorBody } from "../src/console/ConsoleApiClient.js";
import { ConsoleStorageService } from "../src/console/ConsoleStorageService.js";
import { ConsoleApiError } from "../src/console/errors.js";
import { SealCryptoService } from "../src/console/SealCryptoService.js";
import type { BucketId } from "../src/console/types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const pass = (label: string, detail = "") => console.log(`  PASS  ${label.padEnd(46)}${detail}`);
const fail = (label: string, detail = "") => {
  failures++;
  console.log(`  FAIL  ${label.padEnd(46)}${detail}`);
};

/**
 * The exact 403 body Console emits, verified against harbor/api. Two code paths
 * raise it — `api-keys.middleware.ts` and `ensureApiKeyCanAccessBucket` in
 * `domain/shared/api-key-bucket-access.ts` — and they converge on the same
 * shape, because `errorHandler` serializes every 4xx DomainError as
 * `{ error: message, ...(code ? { code } : {}) }` and ForbiddenError maps to 403.
 */
const GRANT_PENDING = JSON.stringify({
  error: "Service signer missing on-chain grant for this bucket.",
  code: "mirror_missing_grant",
});

/**
 * A real, non-retryable sibling: same 403, same ForbiddenError, but a different
 * code (`ensureApiKeyCanAccessBucket` raises it when the key has no grant for
 * the bucket at all). Sharper than a 404 here — it proves the retry keys off the
 * CODE, not merely off the status.
 */
const NOT_IN_SCOPE = JSON.stringify({
  error: "API key is not authorized for this bucket.",
  code: "bucket_not_in_scope",
});

/**
 * A real code-less error. `NotFoundError` in files.service.ts carries no `code`,
 * and `errorHandler` omits the field entirely — so `{ error }` alone is a shape
 * production genuinely returns, not just what the pre-fix client used to produce.
 */
const NO_CODE = JSON.stringify({ error: "File not found in this bucket." });

const TestConfig = Layer.succeed(ConsoleConfigTag, {
  apiKey: Redacted.make("hbr_smoke"),
  servicePrivateKey: Redacted.make(""),
  adminKey: Redacted.make(""),
  adminServicePrivateKey: Redacted.make(""),
  baseUrl: "https://api.example.test",
});

/** Status polling goes through the Effect HttpClient, not `fetch`. Always done. */
const stubHttp = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify({ data: { state: "completed" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  ),
);

/** Seal is irrelevant here; pass the plaintext straight through. */
const stubSeal = Layer.succeed(SealCryptoService, {
  encrypt: (bytes: Uint8Array) => Effect.succeed(bytes),
} as unknown as SealCryptoService);

const ApiLayer = ConsoleApiClient.Default.pipe(
  Layer.provideMerge(Layer.mergeAll(TestConfig, Layer.succeed(HttpClient.HttpClient, stubHttp))),
);
// DefaultWithoutDependencies, NOT Default: `Default` bakes in the service's own
// declared dependencies (including the real SealCryptoService), which would
// override the stub and drag in Sui BCS encoding for a policy id we do not have.
const StorageLayer = ConsoleStorageService.DefaultWithoutDependencies.pipe(
  Layer.provide(Layer.mergeAll(ApiLayer, stubSeal)),
);

const BUCKET = "bucket-smoke" as BucketId;

/**
 * Stub `fetch` so the multipart upload fails with `body` for the first
 * `failTimes` calls, then succeeds with 202. Returns a counter so the caller can
 * assert how many attempts the retry actually made.
 */
function stubUpload(failTimes: number, body: string, status = 403) {
  const attempts = { count: 0 };
  globalThis.fetch = (async () => {
    attempts.count += 1;
    if (attempts.count <= failTimes) {
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: { id: "file-1" } }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return attempts;
}

// ── Stage 1: the parser keeps `code` across the shapes harbor actually emits ─
//
// Verified against harbor/api rather than assumed. `errorHandler` serializes
// every 4xx DomainError as `{ error: message, ...(code ? { code } : {}) }`, and
// the OpenAPI `ErrorResponse` schema types `error` as a plain string — so the
// flat shapes below are what production returns. PlanLimitExceededError is the
// odd one out: it emits `code` with no `error` key at all.
console.log("\n  Stage 1 — parseConsoleErrorBody keeps the code\n");
for (const [label, body, want] of [
  [
    "flat   { error, code }        (the common 4xx)",
    {
      error: "Service signer missing on-chain grant for this bucket.",
      code: "mirror_missing_grant",
    },
    "mirror_missing_grant",
  ],
  [
    "flat   { error } only         (NotFoundError)",
    { error: "File not found in this bucket." },
    undefined,
  ],
  [
    "code, no error key            (PlanLimitExceeded, 422)",
    { code: "plan_limit_exceeded", limit: "10GB", currentTier: "free" },
    "plan_limit_exceeded",
  ],
  // Defensive only: no harbor route emits a nested error object. Kept because
  // the branch exists in parseConsoleErrorBody and a gateway could introduce it.
  [
    "nested { error: { code } }    (defensive, not observed)",
    { error: { code: "quota_exceeded", message: "over" } },
    "quota_exceeded",
  ],
] as const) {
  const got = parseConsoleErrorBody(body).code;
  if (got === want) pass(label, `code=${got}`);
  else fail(label, `want ${want}, got ${got}`);
}

// ── Stage 2: a 403 must yield a ConsoleApiError that satisfies the guard ─────
console.log("\n  Stage 2 — the 403 error satisfies the retry guard verbatim\n");
{
  stubUpload(1, GRANT_PENDING);
  const err = await Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* ConsoleApiClient;
      return yield* api.uploadBucketFile(BUCKET, new Uint8Array([1]), "a.txt");
    }).pipe(Effect.provide(ApiLayer), Effect.flip),
  );
  const e = err as { _tag: string; code?: string; status?: number };
  const tagLabel = "stays a ConsoleApiError (not ConsoleAuthError)";
  if (e._tag === "ConsoleApiError") pass(tagLabel, `_tag=${e._tag}`);
  else fail(tagLabel, `_tag=${e._tag} — retry guard cannot match`);

  if (e.code === "mirror_missing_grant") pass("preserves code", `code=${e.code}`);
  else fail("preserves code", `code=${e.code}`);

  // The guard, copied verbatim from ConsoleStorageService.
  const retryable = err instanceof ConsoleApiError && err.code === "mirror_missing_grant";
  if (retryable) pass("guard evaluates true → retry will fire");
  else fail("guard evaluates false → retry is dead code");
}

// ── Stage 3: end-to-end, the real retry loop rides out the grant delay ───────
console.log("\n  Stage 3 — real uploadFileToBucket retries and then succeeds\n");
const dir = mkdtempSync(join(tmpdir(), "wcm-upload-"));
const localPath = join(dir, "report.txt");
writeFileSync(localPath, "hello");

async function upload(): Promise<string> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* ConsoleStorageService;
      const out = yield* storage.uploadFileToBucket(BUCKET, "0xpolicy", localPath);
      return `uploaded ${out.fileId}`;
    }).pipe(
      Effect.provide(StorageLayer),
      Effect.catchAll((e) =>
        Effect.succeed(`FAILED: ${(e as { _tag?: string })._tag ?? String(e)}`),
      ),
    ),
  );
}

{
  const attempts = stubUpload(2, GRANT_PENDING); // 403, 403, then 202
  const started = process.hrtime.bigint();
  const result = await upload();
  const secs = Number(process.hrtime.bigint() - started) / 1e9;
  const ok = result.startsWith("uploaded") && attempts.count === 3;
  (ok ? pass : fail)(
    "grant pending twice, then granted",
    `${attempts.count} attempts in ${secs.toFixed(1)}s → ${result}`,
  );
}

// A body with no code must not retry — which is both what a real NotFoundError
// looks like and what the pre-fix client produced from every response.
{
  const attempts = stubUpload(2, NO_CODE, 404);
  const result = await upload();
  const ok = result.startsWith("FAILED") && attempts.count === 1;
  (ok ? pass : fail)("no code in body → no retry", `${attempts.count} attempt → ${result}`);
}

// The discriminating case: identical 403, a code IS present, but it is a
// different one. Retrying here would burn 36s waiting out a grant that is never
// coming, so it must abort on the first attempt.
{
  const attempts = stubUpload(12, NOT_IN_SCOPE);
  const result = await upload();
  const ok = result.startsWith("FAILED") && attempts.count === 1;
  (ok ? pass : fail)(
    "different code, same 403 → no retry",
    `${attempts.count} attempt → ${result}`,
  );
}

rmSync(dir, { recursive: true, force: true });
console.log(
  failures === 0
    ? "\n  All stages behaved as expected. The retry is reachable.\n"
    : `\n  ${failures} failure(s).\n`,
);
process.exit(failures === 0 ? 0 : 1);
