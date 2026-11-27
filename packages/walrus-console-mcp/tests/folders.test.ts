import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Either, Layer, Redacted } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient } from "../src/console/ConsoleApiClient";
import { ConsoleApiError } from "../src/console/errors";
import { moveFile } from "../src/console/folderOps";
import { folderDescriptionSchema, folderNameSchema } from "../src/console/folderSchemas";
import { BucketId, FileId, FolderId } from "../src/console/types";

const BASE = "https://api.example.test";
const BUCKET = BucketId.make("22222222-2222-4222-8222-222222222222");
const ROOT = FolderId.make("33333333-3333-4333-8333-333333333333");
const SUB = FolderId.make("44444444-4444-4444-8444-444444444444");
const FILE = FileId.make("55555555-5555-4555-8555-555555555555");

interface Seen {
  method: string;
  url: string;
  body: string | undefined;
}

type Reply = { status: number; body?: unknown };

function harness(reply: (seen: Seen) => Reply = () => ({ status: 200, body: {} })) {
  const seen: Seen[] = [];
  const stub = HttpClient.make((request) => {
    const body =
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined;
    const entry = { method: request.method, url: request.url, body };
    seen.push(entry);
    const { status, body: replyBody } = reply(entry);
    const response =
      replyBody === undefined
        ? new Response(null, { status })
        : new Response(JSON.stringify(replyBody), {
            status,
            headers: { "content-type": "application/json" },
          });
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  const layer = ConsoleApiClient.Default.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(ConsoleConfigTag, {
          apiKey: Redacted.make("hbr_test_key"),
          servicePrivateKey: Redacted.make(""),
          adminKey: Redacted.make(""),
          adminServicePrivateKey: Redacted.make(""),
          baseUrl: BASE,
          webAccountAddress: "",
          keyAdminAddress: "",
        }),
        Layer.succeed(HttpClient.HttpClient, stub),
      ),
    ),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, ConsoleApiClient>) =>
    Effect.runPromise(Effect.either(effect).pipe(Effect.provide(layer)));
  const api = <A, E>(f: (api: typeof ConsoleApiClient.Service) => Effect.Effect<A, E>) =>
    run(Effect.flatMap(ConsoleApiClient, f));
  return { seen, run, api };
}

const failure = <A, E>(result: Either.Either<A, E>): E => {
  if (Either.isRight(result)) throw new Error("expected a failure");
  return result.left;
};

describe("listBucketFiles under subfolders", () => {
  // A bare call is the whole bucket, as it was before folders existed, only
  // because neither field reaches Console and Console defaults them.
  it("sends neither folderId nor recursive when the caller names neither", async () => {
    const { seen, api } = harness(() => ({ status: 200, body: { data: [], pagination: {} } }));

    await api((a) => a.listBucketFiles(BUCKET));

    expect(seen[0]?.url).toBe(`${BASE}/api/v1/buckets/${BUCKET}/files?`);
  });

  it("sends the folder and recursive=false when asked", async () => {
    const { seen, api } = harness(() => ({ status: 200, body: { data: [], pagination: {} } }));

    await api((a) =>
      a.listBucketFiles(BUCKET, 20, undefined, undefined, { folderId: SUB, recursive: false }),
    );

    const url = new URL(seen[0]!.url);
    expect(url.searchParams.get("folderId")).toBe(SUB);
    expect(url.searchParams.get("recursive")).toBe("false");
  });
});

describe("subfolder routes", () => {
  it("creates under the parent it is given", async () => {
    const { seen, api } = harness(() => ({ status: 201, body: { data: { id: SUB } } }));

    const folder = await api((a) =>
      a.createFolder(BUCKET, { parentFolderId: ROOT, name: "reports" }),
    );

    expect(Either.getOrThrow(folder)).toEqual({ id: SUB });
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: `${BASE}/api/v1/buckets/${BUCKET}/folders`,
    });
    expect(JSON.parse(seen[0]!.body!)).toEqual({ parentFolderId: ROOT, name: "reports" });
  });

  it("lists one folder's subfolders", async () => {
    const { seen, api } = harness(() => ({
      status: 200,
      body: { folders: [{ id: SUB }], next_cursor: null },
    }));

    const res = await api((a) => a.listChildFolders(BUCKET, ROOT, 50));

    expect(Either.getOrThrow(res)).toEqual({ folders: [{ id: SUB }], next_cursor: null });
    expect(seen[0]?.url).toBe(`${BASE}/api/v1/buckets/${BUCKET}/folders/${ROOT}/children?limit=50`);
  });

  it("patches only the fields it is given, null description included", async () => {
    const { seen, api } = harness(() => ({ status: 200, body: { data: { id: SUB } } }));

    await api((a) => a.updateFolder(BUCKET, SUB, { parentFolderId: ROOT, description: null }));

    expect(seen[0]).toMatchObject({
      method: "PATCH",
      url: `${BASE}/api/v1/buckets/${BUCKET}/folders/${SUB}`,
    });
    expect(JSON.parse(seen[0]!.body!)).toEqual({ parentFolderId: ROOT, description: null });
  });

  it("sends confirm alone unless the caller asked for the contents", async () => {
    const { seen, api } = harness(() => ({ status: 204 }));

    await api((a) => a.deleteFolder(BUCKET, SUB, { confirm: true, deleteContents: false }));
    await api((a) => a.deleteFolder(BUCKET, SUB, { confirm: true, deleteContents: true }));

    expect(seen.map((s) => s.url)).toEqual([
      `${BASE}/api/v1/buckets/${BUCKET}/folders/${SUB}?confirm=true`,
      `${BASE}/api/v1/buckets/${BUCKET}/folders/${SUB}?confirm=true&deleteContents=true`,
    ]);
  });

  it("surfaces folder_not_empty with its counts", async () => {
    const { api } = harness(() => ({
      status: 409,
      body: {
        error: "The folder still holds 3 files and 2 subfolders.",
        code: "folder_not_empty",
        file_count: 3,
        folder_count: 2,
      },
    }));

    const error = failure(
      await api((a) => a.deleteFolder(BUCKET, SUB, { confirm: true, deleteContents: false })),
    );

    expect(error).toBeInstanceOf(ConsoleApiError);
    expect(error).toMatchObject({
      code: "folder_not_empty",
      status: 409,
      fileCount: 3,
      folderCount: 2,
    });
  });

  // A 403 used to read as an auth failure, so an account without the feature
  // would have been told its API key was invalid.
  it("keeps feature_not_enabled rather than calling the key invalid", async () => {
    const { api } = harness(() => ({
      status: 403,
      body: { error: "Nested folders are not enabled.", code: "feature_not_enabled" },
    }));

    const error = failure(await api((a) => a.listChildFolders(BUCKET, ROOT)));

    expect(error).toBeInstanceOf(ConsoleApiError);
    expect(error).toMatchObject({ code: "feature_not_enabled", status: 403 });
  });
});

describe("uploadBucketFile folderId field", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const captureForm = () => {
    const sent: { body?: FormData } = {};
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.body = init?.body as FormData;
      return new Response(JSON.stringify({ data: { id: "file-1" } }), { status: 202 });
    }) as unknown as typeof fetch;
    return sent;
  };

  it("sends the destination folder when given and nothing otherwise", async () => {
    const { api } = harness();
    const bytes = new Uint8Array([1]);

    const nested = captureForm();
    await api((a) => a.uploadBucketFile(BUCKET, bytes, "a.txt", undefined, 1, "text/plain", SUB));
    const atRoot = captureForm();
    await api((a) => a.uploadBucketFile(BUCKET, bytes, "a.txt", undefined, 1, "text/plain"));

    expect(nested.body?.get("folderId")).toBe(SUB);
    // Absent, not empty: Console refuses the field while the feature is off.
    expect(atRoot.body?.has("folderId")).toBe(false);
  });
});

describe("move_file", () => {
  const movedFile = (over: Record<string, unknown> = {}) => ({
    data: {
      id: FILE,
      bucket_id: BUCKET,
      name: "report.pdf",
      folder_id: ROOT,
      path: [],
      renamed_from: null,
      ...over,
    },
  });

  it("moves to the root of the bucket a bucket id names", async () => {
    const { seen, run } = harness((s) =>
      s.method === "GET"
        ? { status: 200, body: { data: { id: BUCKET, root_folder_id: ROOT } } }
        : { status: 200, body: movedFile() },
    );

    const res = Either.getOrThrow(await run(moveFile(FILE, BUCKET)));

    expect(seen[1]).toMatchObject({ method: "PATCH", url: `${BASE}/api/v1/files/${FILE}` });
    expect(JSON.parse(seen[1]!.body!)).toEqual({ folderId: ROOT });
    expect(res).toMatchObject({
      folderId: ROOT,
      destinationKind: "bucket_root",
      renamedFrom: null,
    });
  });

  it("sends an id that is not a bucket on as a folder id", async () => {
    const { seen, run } = harness((s) =>
      s.method === "GET"
        ? { status: 404, body: { error: "Bucket not found" } }
        : { status: 200, body: movedFile({ folder_id: SUB, path: ["a", "b"] }) },
    );

    const res = Either.getOrThrow(await run(moveFile(FILE, SUB)));

    expect(JSON.parse(seen[1]!.body!)).toEqual({ folderId: SUB });
    expect(res).toMatchObject({ folderId: SUB, path: ["a", "b"], destinationKind: "folder" });
  });

  it("reports the suffixed name a taken name gets", async () => {
    const { run } = harness((s) =>
      s.method === "GET"
        ? { status: 404, body: { error: "Bucket not found" } }
        : {
            status: 200,
            body: movedFile({ name: "report (1).pdf", renamed_from: "report.pdf" }),
          },
    );

    const res = Either.getOrThrow(await run(moveFile(FILE, SUB)));

    expect(res).toMatchObject({ name: "report (1).pdf", renamedFrom: "report.pdf" });
    expect(res.note).toContain('"report (1).pdf"');
  });

  it("passes reencrypt_required through unchanged for another bucket", async () => {
    const otherRoot = "66666666-6666-4666-8666-666666666666";
    const { run } = harness((s) =>
      s.method === "GET"
        ? { status: 200, body: { data: { id: "other", root_folder_id: otherRoot } } }
        : {
            status: 409,
            body: {
              error: "The file is encrypted for its bucket.",
              code: "reencrypt_required",
            },
          },
    );

    const error = failure(await run(moveFile(FILE, "77777777-7777-4777-8777-777777777777")));

    expect(error).toBeInstanceOf(ConsoleApiError);
    expect(error).toMatchObject({
      code: "reencrypt_required",
      status: 409,
      message: "The file is encrypted for its bucket.",
    });
  });

  it.each(["forbidden", "bucket_not_in_scope"])(
    "reports a bucket the key cannot read (403 %s) as unreachable, not as a bad key",
    async (code) => {
      const { seen, run } = harness(() => ({
        status: 403,
        body: { error: "Access denied", code },
      }));

      const error = failure(await run(moveFile(FILE, BUCKET)));

      expect(error).toBeInstanceOf(ConsoleApiError);
      expect(error).toMatchObject({ code: "destination_not_reachable", status: 403 });
      expect(seen.map((s) => s.method)).toEqual(["GET"]);
    },
  );

  it("still reports a 401 on the probe as an auth failure", async () => {
    const { run } = harness(() => ({ status: 401, body: { error: "Invalid API key" } }));

    const error = failure(await run(moveFile(FILE, BUCKET)));

    expect(error).toMatchObject({ _tag: "ConsoleAuthError", code: "invalid_api_key" });
  });

  it("refuses a bucket with no root yet without sending the move", async () => {
    const { seen, run } = harness(() => ({
      status: 200,
      body: { data: { id: BUCKET, root_folder_id: null } },
    }));

    const error = failure(await run(moveFile(FILE, BUCKET)));

    expect(error).toMatchObject({ code: "root_folder_missing" });
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
  });
});

describe("subfolder name rules mirror Console's", () => {
  it.each(["reports", "  padded  ", "café", "a".repeat(255), "v1.2 final"])(
    "accepts %j",
    (name) => {
      expect(folderNameSchema.safeParse(name).success).toBe(true);
    },
  );

  it.each([
    ["", "Name can't be empty."],
    ["   ", "Name can't be empty."],
    ["a".repeat(256), "Name must be 255 characters or fewer."],
    [".", "Name can't be . or .."],
    ["..", "Name can't be . or .."],
    ["draft.", "Name can't end with a period."],
    ["a/b", "Name can't contain slashes."],
    ["a\\b", "Name can't contain slashes."],
    ["<b>", "Name can't contain < or >."],
    ["tab\there", "Name contains invalid characters."],
    ["del\x7f", "Name contains invalid characters."],
    ["lone\uD800", "Name contains invalid characters."],
  ])("refuses %j with Console's message", (name, message) => {
    const result = folderNameSchema.safeParse(name);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(message);
  });

  it("measures the NFC form, as Console stores it", () => {
    // 255 decomposed `é` are 510 code units but 255 once composed.
    expect(folderNameSchema.safeParse("é".repeat(255)).success).toBe(true);
  });

  it("caps the description and refuses control characters but not line breaks", () => {
    expect(folderDescriptionSchema.safeParse("line one\nline two").success).toBe(true);
    expect(folderDescriptionSchema.safeParse("a".repeat(1001)).success).toBe(false);
    expect(folderDescriptionSchema.safeParse("bell\x07").success).toBe(false);
  });
});
