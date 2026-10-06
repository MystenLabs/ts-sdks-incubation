import { bcs } from "@mysten/sui/bcs";
import { deriveBucketGroupId } from "../src/console/ConsoleStorageService";
import { resolvePackageConfigForBaseUrl } from "../src/console/packageConfig";
import {
  type Bucket,
  BucketId,
  type FileId,
  type FileSummary,
  SpaceId,
} from "../src/console/types";

/**
 * A pinned web-account address for upload tests. `upload_file` only encrypts
 * under a policy it can derive from the bucket id and a trusted creator
 * (COMG-1007), so a test that uploads needs a bucket whose policy really is
 * `deriveBucketGroupId(bucketId, owner)` — a placeholder like "0xpolicy" is,
 * correctly, refused.
 */
export const FIXTURE_OWNER = `0x${"ab".repeat(32)}`;

/** The policy the client derives for `bucketId` created by `creator`. */
export function derivedPolicy(baseUrl: string, bucketId: string, creator: string): string {
  return deriveBucketGroupId(
    resolvePackageConfigForBaseUrl(baseUrl),
    bcs.string().serialize(bucketId).toBytes(),
    creator,
  );
}

/**
 * What `getBucketById` returns for a bucket created by `creator` (the pinned
 * owner by default). `sealPolicyId` overrides the reported policy, for tests
 * that model an endpoint reporting something else.
 */
export function verifiedBucket(
  baseUrl: string,
  bucketId: string,
  opts: {
    creator?: string;
    sealPolicyId?: string | null;
    spaceId?: string;
    visibility?: "public" | "private";
  } = {},
): Bucket {
  const reported =
    opts.sealPolicyId !== undefined
      ? opts.sealPolicyId
      : derivedPolicy(baseUrl, bucketId, opts.creator ?? FIXTURE_OWNER);
  return {
    id: BucketId.make(bucketId),
    space_id: SpaceId.make(opts.spaceId ?? "space-1"),
    name: "fixture",
    visibility: opts.visibility ?? "private",
    seal_policy_id: reported,
    // The creator the reported policy was derived from; the download derives from it too.
    creator: opts.creator ?? FIXTURE_OWNER,
    storage_used: 0,
    created_at: "2026-09-11T00:00:00.000Z",
    updated_at: "2026-09-11T00:00:00.000Z",
  };
}

/**
 * What `getBucketFile` returns for a file whose record carries its binding
 *. Defaults describe a bound file; pass `null` for any of the three
 * columns to model a record written before the binding shipped.
 */
export function boundFile(
  fileId: string,
  opts: {
    name?: string;
    originalName?: string | null;
    declaredMimeType?: string | null;
    contentSize?: number | null;
    bucketId?: string;
    metadata?: Record<string, unknown> | null;
  } = {},
): FileSummary {
  const name = opts.name ?? "fixture.bin";
  return {
    id: fileId as unknown as FileId,
    bucket_id: BucketId.make(opts.bucketId ?? "bucket-1"),
    name,
    size: 128,
    content_size: opts.contentSize === undefined ? 3 : opts.contentSize,
    original_name: opts.originalName === undefined ? name : opts.originalName,
    declared_mime_type:
      opts.declaredMimeType === undefined ? "application/octet-stream" : opts.declaredMimeType,
    status: "active",
    is_private: true,
    mime_type: "application/octet-stream",
    metadata: opts.metadata === undefined ? null : opts.metadata,
    created_at: "2026-09-11T00:00:00.000Z",
    updated_at: "2026-09-11T00:00:00.000Z",
  };
}
