/**
 * User-supplied `description` / `tags` metadata for files and buckets.
 *
 * Limits MIRROR the Console API constants — `MAX_FILE_*` in
 * `api/src/domain/files/files.types.ts` and `MAX_BUCKET_*` in
 * `api/src/domain/buckets/buckets.types.ts` (COMG-475, COMG-489). They are
 * enforced here so an over-limit value fails locally with a field-level message
 * instead of an opaque server 400. Re-sync on any Console change (COMG-662).
 *
 * Note the two surfaces do NOT agree on tag length: files allow 30, buckets 24.
 */

import { z } from "zod";

export const MAX_FILE_DESCRIPTION_LENGTH = 1000;
export const MAX_FILE_TAG_LENGTH = 30;
export const MAX_FILE_TAGS = 10;

export const MAX_BUCKET_DESCRIPTION_LENGTH = 1000;
/** Buckets cap tags shorter than files do. Not a typo — see the module note. */
export const MAX_BUCKET_TAG_LENGTH = 24;
export const MAX_BUCKET_TAGS = 10;

const descriptionSchema = (max: number) => z.string().trim().max(max);
const tagsSchema = (tagLength: number, maxTags: number) =>
  z.array(z.string().trim().min(1).max(tagLength)).max(maxTags);

export const fileDescriptionSchema = descriptionSchema(MAX_FILE_DESCRIPTION_LENGTH);
export const fileTagsSchema = tagsSchema(MAX_FILE_TAG_LENGTH, MAX_FILE_TAGS);

export const bucketDescriptionSchema = descriptionSchema(MAX_BUCKET_DESCRIPTION_LENGTH);
export const bucketTagsSchema = tagsSchema(MAX_BUCKET_TAG_LENGTH, MAX_BUCKET_TAGS);

/**
 * `| undefined` is explicit because the repo runs `exactOptionalPropertyTypes`:
 * callers forward optional tool arguments straight through, so the property is
 * present-and-undefined rather than absent. `buildUploadMetadata` treats both
 * the same.
 */
export interface FileUserMetadata {
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
}

/**
 * Assemble the `metadata` object for an upload.
 *
 * Returns `undefined` when the caller supplied neither field, so the multipart
 * form omits `metadata` entirely rather than sending `{}` — the server treats a
 * missing key as "absent", which is the canonical empty state.
 */
/**
 * A file patch. `null` clears a field; `undefined` leaves it untouched.
 * `PATCH /api/v1/files/:id` also renames, so `name` rides along here.
 */
export interface FilePatch {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly tags?: readonly string[] | null | undefined;
}

/** A bucket metadata patch. No `null` — the Console schema is not nullable. */
export interface BucketMetadataPatch {
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
}

/** Drop only the `undefined` entries, so an explicit `null` survives as a clear. */
function compact(entries: ReadonlyArray<readonly [string, unknown]>) {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (value !== undefined) patch[key] = value;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * Body for `PATCH /api/v1/files/:id`. Undefined when nothing was supplied —
 * Console rejects an empty body ("At least one of name, description, tags").
 */
export function buildFilePatch(input: FilePatch): Record<string, unknown> | undefined {
  return compact([
    ["name", input.name],
    ["description", input.description],
    ["tags", input.tags],
  ]);
}

/** Body for `PATCH /api/v1/buckets/:id/metadata`. Undefined when empty. */
export function buildBucketMetadataPatch(
  input: BucketMetadataPatch,
): Record<string, unknown> | undefined {
  return compact([
    ["description", input.description],
    ["tags", input.tags],
  ]);
}

export function buildUploadMetadata(input: FileUserMetadata): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (input.description !== undefined) metadata["description"] = input.description;
  if (input.tags !== undefined) metadata["tags"] = input.tags;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}
