import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
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
       * Full create bucket flow (private + Seal).
       * Returns the final active bucket.
       */
      const createBucket = Effect.fn("ConsoleStorageService.createBucket")(function* (
        spaceId: SpaceId,
        name: string,
      ) {
        // 1. Reserve
        const reserve = yield* api.createBucket(spaceId, name);

        // 2. Sign locally
        const signature = yield* seal.signTransactionBytes(reserve.bytes);

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
        // fs.readFile returns a Buffer, which IS a Uint8Array — pass it straight to
        // seal.encrypt instead of copying the whole file into a second buffer.
        const fileBytes = yield* Effect.tryPromise({
          try: () => fs.readFile(localPath),
          catch: () =>
            new LocalFsError({
              message: "Failed to read local file",
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

        // Wait for the async worker. Only a server-reported `failed` is an
        // error here: running out of polling budget means the upload landed and
        // is still being processed, and reporting that as a failure made agents
        // re-upload a file that already existed (COMG-662 verification).
        const outcome = yield* pollUntilTerminal(() => api.getFileUploadStatus(bucketId, fileId));

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
      });

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

        yield* Effect.tryPromise({
          try: () => fs.writeFile(destPath, plaintext),
          catch: () =>
            new LocalFsError({
              message: "Failed to write downloaded file",
              path: destPath,
              operation: "write",
            }),
        });

        return { bytesWritten: plaintext.length, destPath };
      });

      return {
        createBucket,
        uploadFileToBucket,
        downloadFile,
      } as const;
    }),

    dependencies: [ConsoleApiClient.Default, SealCryptoService.Default],
  },
) {}
