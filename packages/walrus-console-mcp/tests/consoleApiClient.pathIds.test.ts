import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Cause, Effect, Exit, Layer, Option, Redacted } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleConfigTag } from "../src/config";
import { ConsoleApiClient, parseConsoleErrorBody } from "../src/console/ConsoleApiClient";
import { pathSegment } from "../src/console/pathSegment";
import { ConsoleApiError } from "../src/console/errors";
import type { BucketId, FileId, SpaceId } from "../src/console/types";
import { clearSecrets, REDACTION_PLACEHOLDER, registerSecret } from "../src/redaction";

/**
 * Each of these methods is run twice: with `..`,
 * which must be refused before any request leaves, and with `a/b?c#d`, whose
 * encoded form must reach the wire. A new call site that interpolates an id raw
 * fails the second check, and one that forgets the guard fails the first.
 */

const DOT_DOT = "..";
const HOSTILE = "a/b?c#d";
const HOSTILE_ENCODED = "a%2Fb%3Fc%23d";

type Api = typeof ConsoleApiClient.Service;

const cases: Array<[string, (api: Api, id: string) => Effect.Effect<unknown, unknown>]> = [
  ["listBuckets", (api, id) => api.listBuckets({ spaceId: id as SpaceId })],
  ["finalizeBucket", (api, id) => api.finalizeBucket(id as BucketId, "sig")],
  ["getBucketById", (api, id) => api.getBucketById(id as BucketId)],
  ["updateBucket", (api, id) => api.updateBucket(id as BucketId, { name: "n" })],
  ["renameBucket", (api, id) => api.renameBucket(id as BucketId, "n")],
  [
    "deleteBucket",
    (api, id) => api.deleteBucket(id as BucketId, { confirm: true, deleteContents: false }),
  ],
  ["getBucketFile", (api, id) => api.getBucketFile(id as BucketId, id as FileId)],
  ["getFileUploadStatus", (api, id) => api.getFileUploadStatus(id as BucketId, id as FileId)],
  ["downloadBucketFile", (api, id) => api.downloadBucketFile(id as BucketId, id as FileId)],
  ["deleteBucketFile", (api, id) => api.deleteBucketFile(id as BucketId, id as FileId)],
  ["updateFile", (api, id) => api.updateFile(id as FileId, { name: "x.txt" })],
  ["getBucketMetadata", (api, id) => api.getBucketMetadata(id as BucketId)],
  [
    "updateBucketMetadata",
    (api, id) => api.updateBucketMetadata(id as BucketId, { description: "d" }),
  ],
  ["listBucketFiles", (api, id) => api.listBucketFiles(id as BucketId)],
  ["getApiKeyStatus", (api, id) => api.getApiKeyStatus(id)],
  ["executeSponsored", (api, id) => api.executeSponsored(id, "sig")],
];

/** Records every request that leaves, and answers each with an empty 500. */
const seen: string[] = [];

const TestLayer = ConsoleApiClient.Default.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(ConsoleConfigTag, {
        apiKey: Redacted.make("hbr_test_key"),
        servicePrivateKey: Redacted.make(""),
        adminKey: Redacted.make("hbradm_test_key"),
        adminServicePrivateKey: Redacted.make(""),
        baseUrl: "https://api.testnet.console.walrus.xyz",
        webAccountAddress: "",
        keyAdminAddress: "",
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          seen.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 })),
          );
        }),
      ),
    ),
  ),
);

const run = (call: (api: Api, id: string) => Effect.Effect<unknown, unknown>, id: string) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const api = yield* ConsoleApiClient;
      return yield* call(api, id);
    }).pipe(Effect.provide(TestLayer)),
  );

afterEach(() => {
  seen.length = 0;
  clearSecrets();
  vi.unstubAllGlobals();
});

describe("pathSegment", () => {
  it.each(["", ".", ".."])("refuses %j as a typed ConsoleApiError", async (id) => {
    const exit = await Effect.runPromiseExit(pathSegment(id));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(
      Option.getOrUndefined(Cause.failureOption(Exit.isFailure(exit) ? exit.cause : Cause.empty)),
    ).toBeInstanceOf(ConsoleApiError);
  });

  it("encodes the separators and query characters an id can carry", async () => {
    expect(await Effect.runPromise(pathSegment(HOSTILE))).toBe(HOSTILE_ENCODED);
  });

  it("leaves a normal id unchanged", async () => {
    expect(await Effect.runPromise(pathSegment("bucket-1"))).toBe("bucket-1");
  });
});

describe("every id-taking method", () => {
  it.each(cases)("%s refuses '..' before any request is sent", async (_name, call) => {
    const exit = await run(call, DOT_DOT);
    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none();
    expect(Option.getOrUndefined(failure)).toBeInstanceOf(ConsoleApiError);
    expect(seen).toEqual([]);
  });

  it.each(cases)("%s sends the id encoded, not as path structure", async (_name, call) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    await run(call, HOSTILE);
    const urls = [...seen, ...vi.mocked(globalThis.fetch).mock.calls.map(([u]) => String(u))];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toContain(HOSTILE_ENCODED);
      expect(url).not.toContain("a/b?c#d");
    }
  });
});

it.each([
  [
    "createBucket",
    (api: Api, id: string) => api.createBucket(id as SpaceId, "notes", "0x1", []),
    "/spaces/project%2Barchive/buckets",
  ],
  [
    "uploadBucketFile",
    (api: Api, id: string) =>
      api.uploadBucketFile(id as BucketId, new Uint8Array([1]), "notes.txt"),
    "/buckets/project%2Barchive/files",
  ],
] as const)("%s encodes a plus sign in the path identifier", async (_name, call, expectedPath) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status: 500 }));
  vi.stubGlobal("fetch", fetch);

  await run(call, "project+archive");

  const urls = [...seen, ...fetch.mock.calls.map(([url]) => String(url))];
  expect(urls).toEqual([expect.stringContaining(expectedPath)]);
});

describe("server error messages", () => {
  it("clamps a JSON message to 500 characters", () => {
    const parsed = parseConsoleErrorBody({ message: "x".repeat(58_000) });
    expect(parsed.message?.length).toBe(501);
  });

  it("leaves a short message alone", () => {
    expect(parseConsoleErrorBody({ message: "not found" }).message).toBe("not found");
  });

  it("ignores non-string fields while preserving valid error fields", () => {
    expect(parseConsoleErrorBody({ message: 42, code: "not_found" })).toEqual({
      message: undefined,
      code: "not_found",
    });
    expect(parseConsoleErrorBody({ error: { message: "conflict", code: 17 } })).toEqual({
      message: "conflict",
      code: undefined,
    });
    expect(parseConsoleErrorBody({ code: "x".repeat(512) }).code).toBeUndefined();
  });

  it("redacts before clamping the message", () => {
    const fakeSecret = "test-only-secret-at-the-cutoff";
    registerSecret(fakeSecret);
    const prefix = " ".repeat(490);
    expect(parseConsoleErrorBody({ message: prefix + fakeSecret }).message).toBe(
      prefix + REDACTION_PLACEHOLDER,
    );
  });
});
