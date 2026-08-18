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
  /**
   * Declared plaintext byte count for private files. `size` stays the stored
   * (ciphertext) length, which is what quota and transfer use. Null on public
   * files and on private files uploaded before this field existed — there is no
   * server-side backfill, because plaintext length cannot be recovered from
   * ciphertext.
   */
  readonly content_size?: number | null;
  readonly status: string;
  readonly is_private: boolean;
  readonly mime_type: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Folder (bucket) description + tags — `GET`/`PATCH /api/v1/buckets/:id/metadata`
 * (COMG-489). Separate from `Bucket`: it is a different endpoint, so a bucket
 * read does not carry it.
 */
export interface BucketMetadata {
  readonly description: string | null;
  readonly tags: readonly string[];
  /**
   * Folder stats returned alongside the editable fields — COMG-489 ships them
   * from the same endpoint, so they arrive whether or not a caller wants them.
   * `size` is the stored (ciphertext) total, matching `Bucket.storage_used`.
   */
  readonly size: number;
  readonly asset_count: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_opened_at: string | null;
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

/**
 * The size to show a caller. Prefers the declared plaintext length and falls back
 * to the stored length. Uses a null check rather than `||` so a genuine 0-byte
 * file reports 0 instead of its ciphertext length.
 */
export function fileDisplaySize(file: Pick<FileSummary, "size" | "content_size">): number {
  return file.content_size ?? file.size;
}

/** A listed file with the resolved size the caller should display. */
export interface FileSummaryWithDisplaySize extends FileSummary {
  readonly display_size: number;
}

/**
 * Attach `display_size` to a listed file.
 *
 * `size` and `content_size` are both left untouched — quota and transfer callers
 * depend on the stored (ciphertext) length, so this adds a field rather than
 * rewriting one. Without it every consumer has to re-derive the fallback, and a
 * private file uploaded before `content_size` existed reads as its encrypted
 * length.
 */
export function withDisplaySize(file: FileSummary): FileSummaryWithDisplaySize {
  return { ...file, display_size: fileDisplaySize(file) };
}
