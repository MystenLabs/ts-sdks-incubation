import { Duration, Effect } from "effect";

/**
 * Polling for the async upload worker to finish processing a file.
 *
 * Kept separate from ConsoleStorageService so the budget and the
 * completed/failed/pending decision are assertable without waiting out a real
 * upload.
 */

/**
 * Budget sized from measurement, not guesswork: across seven uploads to the
 * same local bucket, six finished in 10-35s and one took 138s. The previous
 * 40 x 2s = 80s budget was under that, so a healthy-but-slow upload reported
 * as a failure roughly one time in seven.
 *
 * Exceeding this is still not an error — see `pollUntilTerminal`.
 */
export const UPLOAD_POLL_ATTEMPTS = 90;
export const UPLOAD_POLL_INTERVAL = Duration.seconds(2);

interface StatusLike {
  readonly data: {
    readonly state: string;
    readonly error?: { code: string; message: string } | undefined;
  };
}

export type PollOutcome<S> =
  | { readonly kind: "completed"; readonly status: S }
  | { readonly kind: "failed"; readonly status: S }
  /** Still processing when the budget ran out. The upload itself succeeded. */
  | { readonly kind: "pending"; readonly lastState: string };

/**
 * Poll `getStatus` until the server reports a terminal state or the budget is
 * spent.
 *
 * Running out is reported as `pending`, NOT as a failure: by this point the
 * upload has been accepted and the file exists server-side, so telling a caller
 * it failed invites a re-upload that duplicates the file.
 */
export interface UploadResult {
  readonly fileId: string;
  readonly name: string;
  readonly state: string;
  /** True when the upload landed but the worker had not finished processing. */
  readonly pending: boolean;
  readonly note?: string;
}

/**
 * Turn a non-failed poll outcome into the tool's result.
 *
 * A pending upload is reported as a success on purpose: the bytes are stored
 * and the file has an id. It carries that id and points at `get_file_status`
 * so an agent resumes rather than re-uploads.
 */
export const describeUploadResult = <S>(
  outcome: Exclude<PollOutcome<S>, { kind: "failed" }>,
  fileId: string,
  name: string,
): UploadResult =>
  outcome.kind === "completed"
    ? { fileId, name, state: "completed", pending: false }
    : {
        fileId,
        name,
        state: outcome.lastState,
        pending: true,
        note:
          "Upload stored; the server is still processing it. " +
          "Poll get_file_status with this fileId — do not upload again.",
      };

export const pollUntilTerminal = <S extends StatusLike, E, R>(
  getStatus: () => Effect.Effect<S, E, R>,
  attempts: number = UPLOAD_POLL_ATTEMPTS,
  interval: Duration.DurationInput = UPLOAD_POLL_INTERVAL,
): Effect.Effect<PollOutcome<S>, E, R> =>
  Effect.gen(function* () {
    let lastState = "queued";
    for (let i = 0; i < attempts; i++) {
      const status = yield* getStatus();
      lastState = status.data.state;
      if (lastState === "completed") return { kind: "completed" as const, status };
      if (lastState === "failed") return { kind: "failed" as const, status };
      yield* Effect.sleep(interval);
    }
    return { kind: "pending" as const, lastState };
  });
