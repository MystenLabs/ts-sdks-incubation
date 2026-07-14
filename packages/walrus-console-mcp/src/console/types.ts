import { Schema } from "effect";

/**
 * Branded IDs and core DTOs matching the Console external OpenAPI.
 * Use these everywhere instead of raw strings.
 */

export const SpaceId = Schema.String.pipe(Schema.brand("SpaceId"));
export type SpaceId = typeof SpaceId.Type;

export const BucketId = Schema.String.pipe(Schema.brand("BucketId"));
export type BucketId = typeof BucketId.Type;

export const FileId = Schema.String.pipe(Schema.brand("FileId"));
export type FileId = typeof FileId.Type;

export interface SpaceListItem {
  readonly id: SpaceId;
  readonly type: "personal" | "team";
  readonly name: string;
  readonly plan: "free" | "starter" | "pro" | "business";
  readonly storage_used: number;
  readonly storage_cap: number;
  readonly bucket_count: number;
  readonly role: "owner" | "admin" | "editor" | "viewer";
  readonly created_at: string;
}

/** Aggregated storage usage for the authenticated space (GET /api/v1/usage). */
export interface StorageUsage {
  readonly storage_used: number;
  readonly storage_cap: number;
  readonly available: number;
  readonly percent_used: number;
}

export interface Bucket {
  readonly id: BucketId;
  readonly space_id: SpaceId;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly seal_policy_id: string | null;
  readonly storage_used: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface FileSummary {
  readonly id: FileId;
  readonly bucket_id: BucketId;
  readonly name: string;
  readonly size: number;
  readonly status: string;
  readonly is_private: boolean;
  readonly mime_type: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateBucketInput {
  readonly spaceId: SpaceId;
  readonly name: string; // 1-100 chars
}

export interface UploadFileInput {
  readonly bucketId: BucketId;
  readonly localPath: string;
  readonly name?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface DownloadFileInput {
  readonly bucketId: BucketId;
  readonly fileId: FileId;
  readonly destPath: string; // where to write the decrypted bytes
}
