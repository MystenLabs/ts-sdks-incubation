import { Effect } from "effect";
import { ConsoleApiClient } from "./ConsoleApiClient";
import { ConsoleApiError, ConsoleAuthError } from "./errors";
import { BucketId, FileId, FolderId } from "./types";

/**
 * The folder a bucket's tree starts at, from the single-bucket read.
 *
 * Null for a bucket created before folders existed, until its first upload
 * gives it one. Nothing can sit below a root that does not exist yet, so the
 * callers that only read treat it as empty, and the ones that write refuse.
 */
export const rootFolderIdOf = Effect.fn("folderOps.rootFolderIdOf")(function* (bucketId: BucketId) {
  const api = yield* ConsoleApiClient;
  const bucket = yield* api.getBucketById(bucketId);
  const root = bucket.root_folder_id;
  return typeof root === "string" && root !== "" ? FolderId.make(root) : null;
});

const noRootYet = (bucketId: string) =>
  new ConsoleApiError({
    message:
      `Bucket ${bucketId} has no root folder yet: it was created before subfolders existed ` +
      "and gets one with its first upload. Upload a file to it, then retry. Nothing was changed.",
    code: "root_folder_missing",
  });

/** `folderId` when given, otherwise the bucket's root; refuses a bucket with none yet. */
export const folderOrRoot = Effect.fn("folderOps.folderOrRoot")(function* (
  bucketId: BucketId,
  folderId: string | undefined,
) {
  if (folderId !== undefined) return FolderId.make(folderId);
  const root = yield* rootFolderIdOf(bucketId);
  if (root === null) return yield* Effect.fail(noRootYet(bucketId));
  return root;
});

/**
 * `move_file`'s destination: a folder id, or a bucket id meaning that bucket's
 * root.
 *
 * Asked of the bucket read first, because the two ids share one format. A 404
 * there means the id is not a bucket, so it goes to Console as a folder id and
 * Console judges it. A bucket of another of the caller's buckets resolves to
 * its root, and Console refuses that move with `reencrypt_required`, which is
 * passed through unchanged.
 *
 * A 403 there is a bucket the key may not read: outside its space, or outside
 * the buckets it is scoped to. The key itself is fine (a bad one gets 401), so
 * it is reported as an unreachable destination, not as an invalid key.
 */
export const resolveMoveDestination = Effect.fn("folderOps.resolveMoveDestination")(function* (
  destination: string,
) {
  const api = yield* ConsoleApiClient;
  const asBucket = yield* api.getBucketById(BucketId.make(destination)).pipe(
    Effect.map((bucket) => ({ kind: "bucket" as const, bucket })),
    Effect.catchIf(
      (error): error is ConsoleApiError => error instanceof ConsoleApiError && error.status === 404,
      () => Effect.succeed({ kind: "folder" as const }),
    ),
    Effect.catchIf(
      (error): error is ConsoleAuthError =>
        error instanceof ConsoleAuthError && error.status === 403,
      (error) =>
        Effect.fail(
          new ConsoleApiError({
            message:
              `Destination ${destination} is a bucket this API key cannot reach (${error.message}). ` +
              "Use a folder or bucket the key can read. Nothing was moved.",
            code: "destination_not_reachable",
            status: 403,
          }),
        ),
    ),
  );
  if (asBucket.kind === "folder") {
    return { folderId: FolderId.make(destination), destinationKind: "folder" as const };
  }
  const root = asBucket.bucket.root_folder_id;
  if (typeof root !== "string" || root === "") {
    return yield* Effect.fail(noRootYet(destination));
  }
  return { folderId: FolderId.make(root), destinationKind: "bucket_root" as const };
});

/** Moves a file to another folder of its own bucket, through the file update. */
export const moveFile = Effect.fn("folderOps.moveFile")(function* (
  fileId: string,
  destination: string,
) {
  const api = yield* ConsoleApiClient;
  const target = yield* resolveMoveDestination(destination);
  const { data } = yield* api.updateFile(FileId.make(fileId), { folderId: target.folderId });
  const renamedFrom = data.renamed_from ?? null;
  return {
    fileId: data.id,
    bucketId: data.bucket_id,
    folderId: data.folder_id ?? target.folderId,
    path: data.path ?? [],
    // The stored name. A name already taken in the destination is not an
    // error: the file takes the next free ` (n)` suffix, as an upload does.
    name: data.name,
    renamedFrom,
    destinationKind: target.destinationKind,
    ...(renamedFrom !== null
      ? {
          note:
            `"${renamedFrom}" was already taken in the destination, so the file is now ` +
            `named "${data.name}". Use that name, or fileId, to find it.`,
        }
      : {}),
  };
});
