import { Duration, Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  describeUploadResult,
  pollUntilTerminal,
  UPLOAD_POLL_ATTEMPTS,
  UPLOAD_POLL_INTERVAL,
} from "../src/console/uploadPolling";

/**
 * Two defects found while verifying COMG-662 against the local stack:
 *
 * 1. The budget was 40 polls x 2s = 80s. Measured against seven real uploads in
 *    the same bucket, six finished in 10-35s but one took 138s — 1.7x the
 *    budget. So exhausting it is a normal outcome, not a broken worker.
 * 2. Exhaustion was reported as a hard `FileStatusError`, even though the
 *    upload itself had succeeded and the file existed with its metadata
 *    intact. An agent reading that as failure re-uploads, duplicating the file.
 *
 * Exhaustion is therefore "still processing", distinct from a server-reported
 * `failed`, which stays an error.
 */

const statuses = (...states: string[]) => {
  let i = 0;
  return () => {
    const state = states[Math.min(i, states.length - 1)] as string;
    i++;
    return Effect.succeed({ data: { state } });
  };
};

describe("pollUntilTerminal", () => {
  it("reports completed as soon as the server says so", async () => {
    const result = await Effect.runPromise(
      pollUntilTerminal(statuses("queued", "active", "completed"), 10, Duration.zero),
    );

    expect(result.kind).toBe("completed");
  });

  it("reports a server-side failure as failed, not pending", async () => {
    const result = await Effect.runPromise(
      pollUntilTerminal(statuses("queued", "failed"), 10, Duration.zero),
    );

    expect(result.kind).toBe("failed");
  });

  // The defect: this used to be indistinguishable from `failed`.
  it("reports still-processing as pending when the budget runs out", async () => {
    const result = await Effect.runPromise(pollUntilTerminal(statuses("queued"), 3, Duration.zero));

    expect(result.kind).toBe("pending");
    expect(result.kind === "pending" && result.lastState).toBe("queued");
  });

  it("stops polling once it has an answer", async () => {
    let calls = 0;
    const counted = () => {
      calls++;
      return Effect.succeed({ data: { state: "completed" } });
    };

    await Effect.runPromise(pollUntilTerminal(counted, 10, Duration.zero));

    expect(calls).toBe(1);
  });

  // Pins the budget against the measurement above: 138s observed, so anything
  // at or under that is known-insufficient.
  it("budgets more wall-clock than the slowest observed upload", () => {
    const budgetSeconds = UPLOAD_POLL_ATTEMPTS * Duration.toSeconds(UPLOAD_POLL_INTERVAL);

    expect(budgetSeconds).toBeGreaterThan(138);
  });
});

describe("describeUploadResult", () => {
  it("reports a completed upload plainly", () => {
    const result = describeUploadResult({ kind: "completed", status: {} }, "file-1", "a.txt");

    expect(result).toEqual({ fileId: "file-1", name: "a.txt", state: "completed", pending: false });
  });

  // The upload succeeded; only the processing is unfinished. The result has to
  // say so without looking like a failure, and has to hand back the fileId so
  // the caller polls instead of re-uploading.
  it("reports a still-processing upload as a success carrying the fileId", () => {
    const result = describeUploadResult(
      { kind: "pending", lastState: "queued" },
      "file-1",
      "a.txt",
    );

    expect(result.pending).toBe(true);
    expect(result.fileId).toBe("file-1");
    expect(result.state).toBe("queued");
    expect(result.note).toMatch(/get_file_status/);
  });

  it("never claims the upload failed", () => {
    const result = describeUploadResult(
      { kind: "pending", lastState: "queued" },
      "file-1",
      "a.txt",
    );

    expect(JSON.stringify(result)).not.toMatch(/fail/i);
  });
});
