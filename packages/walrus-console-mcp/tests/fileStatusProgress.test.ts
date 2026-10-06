import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Cause, Effect, Exit, Layer, Option, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { ConsoleConfigTag } from "../src/config";
import {
  ConsoleApiClient,
  type FileStatusWire,
  reconcileFileStatusProgress,
} from "../src/console/ConsoleApiClient";
import type { BucketId, FileId } from "../src/console/types";

describe("reconcileFileStatusProgress", () => {
  it("reports 1 for a completed upload the worker left at 0.95", () => {
    const res: FileStatusWire = { data: { state: "completed", progress: 0.95 } };

    expect(reconcileFileStatusProgress(res)).toEqual({
      data: { state: "completed", progress: 1 },
    });
  });

  it("reports 1 for a completed upload that carries no progress at all", () => {
    const res: FileStatusWire = { data: { state: "completed" } };

    expect(reconcileFileStatusProgress(res)).toEqual({
      data: { state: "completed", progress: 1 },
    });
  });

  it("leaves a completed upload that already reports 1 alone", () => {
    const res: FileStatusWire = { data: { state: "completed", progress: 1 } };

    expect(reconcileFileStatusProgress(res)).toEqual({
      data: { state: "completed", progress: 1 },
    });
  });

  // `get_file_status` is a pass-through tool: the server can add fields to the
  // status at any time and they must survive the rewrite. Without this, the
  // completed branch reconstructing the object instead of spreading it passes
  // every other test in this file.
  it("keeps the rest of a completed status intact", () => {
    const res = {
      requestId: "req-1",
      data: { state: "completed", progress: 0.95, checkedAt: "2026-09-04T00:00:00Z" },
    } as unknown as FileStatusWire;

    expect(reconcileFileStatusProgress(res)).toEqual({
      requestId: "req-1",
      data: { state: "completed", progress: 1, checkedAt: "2026-09-04T00:00:00Z" },
    });
  });

  it("drops progress from a failed upload and keeps its error", () => {
    const res: FileStatusWire = {
      data: {
        state: "failed",
        progress: 0.5,
        error: { code: "upload_payload_too_large", message: "File is too large to upload." },
      },
    };

    const out = reconcileFileStatusProgress(res);

    expect(out.data).not.toHaveProperty("progress");
    expect(out).toEqual({
      data: {
        state: "failed",
        error: { code: "upload_payload_too_large", message: "File is too large to upload." },
      },
    });
  });

  it("passes an in-flight active upload through untouched", () => {
    const res: FileStatusWire = { data: { state: "active", progress: 0.5 } };

    expect(reconcileFileStatusProgress(res)).toEqual({
      data: { state: "active", progress: 0.5 },
    });
  });

  // Once console#573 deploys this is the most common failed input, and it was
  // the one shape none of the cases covered: the rest-destructure is a no-op
  // when the key is already absent, so only an explicit case stops a later
  // rebuild-instead-of-destructure refactor from shipping green.
  it("leaves an already-reconciled failed status alone", () => {
    const res: FileStatusWire = {
      data: { state: "failed", error: { code: "upload_failed", message: "Upload failed." } },
    };

    expect(reconcileFileStatusProgress(res)).toEqual({
      data: { state: "failed", error: { code: "upload_failed", message: "Upload failed." } },
    });
  });

  // `http_status`, not `httpStatus`: Console's response serializer snake_cases
  // every /api/v1 body, so this is the key that reaches the wire.
  it("keeps http_status on a failed status", () => {
    const res: FileStatusWire = {
      data: {
        state: "failed",
        progress: 0.95,
        error: { code: "upload_payload_too_large", message: "Too large.", http_status: 413 },
      },
    };

    expect(reconcileFileStatusProgress(res)).toEqual({
      data: {
        state: "failed",
        error: { code: "upload_payload_too_large", message: "Too large.", http_status: 413 },
      },
    });
  });

  // The description promises a 0..1 fraction while queued or active, and this
  // is the one branch an unpatched Console can get wrong that the terminal
  // branches do not cover. `7500.372535140416` is the literal value console#573
  // is correcting in the published Postman example for this endpoint.
  it("caps an out-of-range in-flight progress at 1", () => {
    const res: FileStatusWire = { data: { state: "active", progress: 7500.372535140416 } };

    expect(reconcileFileStatusProgress(res)).toEqual({
      data: { state: "active", progress: 1 },
    });
  });

  it.each([
    ["a string", "50%"],
    ["a boolean", true],
    ["a negative number", -1],
    ["NaN", Number.NaN],
  ])("drops an in-flight progress that is %s", (_label, reported) => {
    const res = { data: { state: "active", progress: reported } } as unknown as FileStatusWire;

    const out = reconcileFileStatusProgress(res);

    expect(out.data).not.toHaveProperty("progress");
    expect(out).toEqual({ data: { state: "active" } });
  });

  it("passes a queued upload through untouched", () => {
    const res: FileStatusWire = { data: { state: "queued" } };

    expect(reconcileFileStatusProgress(res)).toEqual({ data: { state: "queued" } });
  });

  // Callers hold the response they passed in. Rewriting it in place would let a
  // reconciled value leak back into whatever the client is still holding, and
  // reads identically at every call site, so pin it explicitly.
  // Every row must be a case the reconciler actually *changes*, otherwise an
  // in-place rewrite writes back the value that was already there and the
  // assertion cannot see it. `active` with an in-range 0.5 was exactly that
  // blind spot: clamping it is a no-op, so mutating in place survived.
  it.each([
    ["completed", { data: { state: "completed", progress: 0.95 } }],
    ["failed", { data: { state: "failed", progress: 0.5 } }],
    ["active", { data: { state: "active", progress: 7500.372535140416 } }],
    ["queued", { data: { state: "queued", progress: "50%" } }],
  ])("does not mutate a %s response it is given", (_label, input) => {
    const res = input as FileStatusWire;
    const before = structuredClone(res);

    reconcileFileStatusProgress(res);

    expect(res).toEqual(before);
  });
});

// A correct reconciler proves nothing until the client actually calls it,
// so pin the wiring at the ConsoleApiClient boundary too.
const TestConfig = Layer.succeed(ConsoleConfigTag, {
  apiKey: Redacted.make("hbr_test_key"),
  servicePrivateKey: Redacted.make(""),
  adminKey: Redacted.make(""),
  adminServicePrivateKey: Redacted.make(""),
  baseUrl: "https://api.example.test",
  webAccountAddress: "",
  keyAdminAddress: "",
});

type SeenRequest = { method: string; url: string };

const stubHttpReturning = (body: unknown, seen: SeenRequest[]) =>
  HttpClient.make((request) => {
    seen.push({ method: request.method, url: request.url });
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

const provideStub = (body: unknown, seen: SeenRequest[]) =>
  Effect.gen(function* () {
    const api = yield* ConsoleApiClient;
    return yield* api.getFileUploadStatus("bucket-1" as BucketId, "file-1" as FileId);
  }).pipe(
    Effect.provide(
      ConsoleApiClient.Default.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            TestConfig,
            Layer.succeed(HttpClient.HttpClient, stubHttpReturning(body, seen)),
          ),
        ),
      ),
    ),
  );

const statusEffect = (body: unknown) => provideStub(body, []);

const fetchStatusRecording = (body: unknown) => {
  const seen: SeenRequest[] = [];
  return Effect.runPromise(provideStub(body, seen)).then((result) => ({ result, seen }));
};

const fetchStatus = (body: unknown) => fetchStatusRecording(body).then(({ result }) => result);

describe("ConsoleApiClient.getFileUploadStatus", () => {
  it("turns a server-reported completed/0.95 into completed/1", async () => {
    const result = await fetchStatus({ data: { state: "completed", progress: 0.95 } });

    expect(result).toEqual({ data: { state: "completed", progress: 1 } });
  });

  it("strips progress off a failed status but keeps the error", async () => {
    const result = await fetchStatus({
      data: {
        state: "failed",
        progress: 0.95,
        error: { code: "upload_failed", message: "Upload failed." },
      },
    });

    expect(result.data).not.toHaveProperty("progress");
    expect(result).toEqual({
      data: { state: "failed", error: { code: "upload_failed", message: "Upload failed." } },
    });
  });

  it("leaves an in-flight status as the server sent it", async () => {
    const result = await fetchStatus({ data: { state: "active", progress: 0.5 } });

    expect(result).toEqual({ data: { state: "active", progress: 0.5 } });
  });

  // Asserting only the body leaves the wiring unpinned: a stub that answers 200
  // to anything stays green if the method is re-pointed at a neighbouring route
  // or the reconciler is moved onto a different call.
  it("GETs the status route for the requested bucket and file", async () => {
    const { seen } = await fetchStatusRecording({ data: { state: "queued" } });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.url).toBe(
      "https://api.example.test/api/v1/buckets/bucket-1/files/file-1/status",
    );
  });

  // A 200 with no `data` used to throw a TypeError from the reconciler. Inside
  // `Effect.gen` that is a defect, and defects sail past the `Effect.mapError`
  // in `uploadFile` that keeps the accepted fileId in the message (COMG-662).
  // It has to surface in the typed channel so both callers keep their handling.
  it("fails with a typed ConsoleApiError when a 200 carries no data object", async () => {
    const exit = await Effect.runPromiseExit(statusEffect({}));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // `failureOption` is empty for a defect, so this also pins that the
      // TypeError path is gone rather than merely renamed.
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value._tag).toBe("ConsoleApiError");
        expect(failure.value.message).toContain("no `data` object");
      }
      expect(Cause.defects(exit.cause)).toHaveLength(0);
    }
  });
});
