import * as path from "node:path";
import { Effect } from "effect";
import { writeFileAtomic } from "../atomicWrite";
import { readFileWithinRoot } from "../pathSandbox";
import { maxTransferBytes } from "../transferLimits";
import type { FileUploadResponse } from "./ConsoleApiClient";
import { ConsoleApiClient } from "./ConsoleApiClient";
import {
  ConsoleApiError,
  FileStatusError,
  LocalFsError,
  MirrorGrantMissingError,
  PayloadTooLargeError,
  UnsupportedFileTypeError,
} from "./errors";
import { buildUploadMetadata, type FileUserMetadata } from "./fileMetadata";
import { SealCryptoService } from "./SealCryptoService";
import { describeUploadResult, pollUntilTerminal } from "./uploadPolling";
import type { BucketId, FileId, SpaceId } from "./types";

/**
 * High-level "ggdrive" style operations.
 * Combines ConsoleApiClient + SealCryptoService into user-friendly flows.
 *
 * All heavy crypto + signing + retry logic lives here.
 */

export class ConsoleStorageService extends Effect.Service<ConsoleStorageService>()(
  "ConsoleStorageService",
  {
    effect: Effect.gen(function* () {
      const api = yield* ConsoleApiClient;
      const seal = yield* SealCryptoService;

      /**
       * One transfer at a time, across BOTH directions.
       *
       * Size-capping each transfer bounds one payload; it does nothing about N of
       * them at once. Every transfer holds two full copies — an upload has the
       * plaintext and the Seal ciphertext, a download has the ciphertext and the
       * decrypted plaintext — so peak memory is (permits x 2 x cap). The cap and
       * this limit are the same guard from two directions, and they only work
       * together.
       *
       * One permit rather than a few: the two directions share one heap, so
       * splitting the budget between them just makes the worst case a multiple of
       * itself. Created here, in the service effect, so it is per-layer and shared
       * by every call — a semaphore built per invocation would gate nothing.
       */
      const transferLock = yield* Effect.makeSemaphore(1);

      /**
       * Full create bucket flow (private + Seal).
       * Returns the final active bucket.
       */
      const createBucket = Effect.fn("ConsoleStorageService.createBucket")(function* (
        spaceId: SpaceId,
        name: string,
      ) {
        // 1. Reserve
        const reserve = yield* api.createBucket(spaceId, name);

        // 2. Validate, then sign locally. The expectation is what stops these bytes
        //    being anything other than the bucket-group PTB we just asked for —
        //    without it the working key signs whatever the endpoint returns.
        const signature = yield* seal.signTransactionBytes(reserve.bytes, {
          kind: "createBucket",
        });

        // 3. Finalize
        const finalized = yield* api.finalizeBucket(reserve.bucket_id, signature);

        return {
          bucketId: finalized.bucket_id,
          sealPolicyId: finalized.seal_policy_id,
          state: finalized.state,
        };
      });

      /**
       * Upload a local file: read, encrypt with Seal, upload with retry + polling.
       * Caller provides sealPolicyId (returned from createBucket).
       */
      const uploadFileToBucket = Effect.fn("ConsoleStorageService.uploadFileToBucket")(function* (
        bucketId: BucketId,
        sealPolicyId: string,
        localPath: string,
        targetName?: string,
        userMetadata?: FileUserMetadata,
      ) {
        // readFileWithinRoot, not fs.readFile: it opens with O_NOFOLLOW so a
        // symlink planted between the path's validation and this read cannot
        // redirect it, and it takes the size from the OPEN descriptor to reject an
        // oversized file BEFORE the bytes are buffered. That ordering is the whole
        // point — this process then holds the plaintext and the Seal ciphertext at
        // once, so learning the size after the read is too late to protect it.
        // Returns a Buffer, which IS a Uint8Array, so it goes straight to
        // seal.encrypt with no second copy.
        const fileBytes = yield* Effect.try({
          try: () =>
            readFileWithinRoot(localPath, { maxBytes: maxTransferBytes(), label: "Source" }),
          catch: (cause) =>
            new LocalFsError({
              message: cause instanceof Error ? cause.message : "Failed to read local file",
              path: localPath,
              operation: "read",
            }),
        });

        const fileName = targetName ?? path.basename(localPath);

        // Undefined when the caller supplied neither field, so the multipart form
        // omits `metadata` rather than sending `{}` (COMG-662).
        const metadata = buildUploadMetadata(userMetadata ?? {});

        // Encrypt
        const encrypted = yield* seal.encrypt(fileBytes, sealPolicyId);

        // Upload with simple retry loop on mirror_missing_grant (pragmatic & type-safe).
        // uploadBucketFile now surfaces deny-list (415) and size-cap (413) as
        // dedicated tagged errors — those fall straight through the
        // `mirror_missing_grant` gate and abort the loop instead of retrying a
        // rejection that will never change.
        let uploadResult: FileUploadResponse | undefined;
        let lastErr: ConsoleApiError | UnsupportedFileTypeError | PayloadTooLargeError | undefined;
        for (let attempt = 0; attempt < 12; attempt++) {
          const res = yield* api
            .uploadBucketFile(bucketId, encrypted, fileName, metadata, fileBytes.length)
            .pipe(Effect.either);

          if (res._tag === "Right") {
            uploadResult = res.right;
            break;
          }

          lastErr = res.left;
          if (lastErr instanceof ConsoleApiError && lastErr.code === "mirror_missing_grant") {
            yield* Effect.sleep("3 seconds");
            continue;
          }
          return yield* Effect.fail(lastErr);
        }

        if (!uploadResult) {
          return yield* Effect.fail(new MirrorGrantMissingError({ bucketId, attempt: 12 }));
        }

        const fileId = uploadResult.data.id;

        // The upload is ACCEPTED at this point: the bytes are stored and the server
        // has an id for them. Everything after this is observation. Emit the id
        // immediately so a crash, a disconnect, or a killed session still leaves it
        // somewhere recoverable — otherwise the only way back is to upload again,
        // which re-encrypts and duplicates a file that already exists.
        console.error(`[console-mcp] upload accepted — fileId=${fileId} (bucket ${bucketId})`);

        // Wait for the async worker. Only a server-reported `failed` is an
        // error here: running out of polling budget means the upload landed and
        // is still being processed, and reporting that as a failure made agents
        // re-upload a file that already existed (COMG-662 verification).
        const outcome = yield* pollUntilTerminal(() =>
          api.getFileUploadStatus(bucketId, fileId),
        ).pipe(
          // Anything that goes wrong from here on is a status-check problem, not an
          // upload problem, and the caller needs the id to act on it rather than
          // re-uploading. Re-tagged rather than swallowed: the original message is
          // kept as a prefix.
          Effect.mapError((error) =>
            error instanceof ConsoleApiError
              ? new ConsoleApiError({
                  message:
                    `${error.message} — the upload itself was accepted as fileId=${fileId}; ` +
                    `check it with get_file_status instead of uploading again.`,
                  ...(error.code !== undefined ? { code: error.code } : {}),
                  ...(error.status !== undefined ? { status: error.status } : {}),
                  ...(error.endpoint !== undefined ? { endpoint: error.endpoint } : {}),
                })
              : error,
          ),
        );

        if (outcome.kind === "failed") {
          return yield* Effect.fail(
            new FileStatusError({
              fileId,
              state: outcome.status.data.state,
              error: outcome.status.data.error ?? { code: "unknown", message: "Upload failed" },
            }),
          );
        }

        return describeUploadResult(outcome, fileId, fileName);
      }, transferLock.withPermits(1));

      /**
       * Download + decrypt to a local path.
       */
      const downloadFile = Effect.fn("ConsoleStorageService.downloadFile")(function* (
        bucketId: BucketId,
        fileId: FileId,
        sealPolicyId: string,
        destPath: string,
      ) {
        const ciphertext = yield* api.downloadBucketFile(bucketId, fileId);

        const plaintext = yield* seal.decrypt(ciphertext, sealPolicyId);

        // Atomic replacement rather than a direct write, for two reasons that
        // happen to share one fix. A direct write can truncate an existing file and
        // then fail — on a full disk, on termination, against a competing download
        // — destroying data that was fine. And it writes THROUGH a symlink, so one
        // planted at the destination after the path was validated would land the
        // decrypted plaintext outside the sandbox. Writing a sibling temp with
        // O_EXCL (unhijackable) and renaming over the target replaces the symlink
        // itself instead of following it.
        //
        // 0o600: this is plaintext that was private enough to be Seal-encrypted at
        // rest; it should not land world-readable under a loose umask.
        yield* Effect.try({
          try: () => writeFileAtomic(destPath, plaintext, { mode: 0o600 }),
          catch: (cause) =>
            new LocalFsError({
              message: cause instanceof Error ? cause.message : "Failed to write downloaded file",
              path: destPath,
              operation: "write",
            }),
        });

        return { bytesWritten: plaintext.length, destPath };
      }, transferLock.withPermits(1));

      return {
        createBucket,
        uploadFileToBucket,
        downloadFile,
      } as const;
    }),

    dependencies: [ConsoleApiClient.Default, SealCryptoService.Default],
  },
) {}
