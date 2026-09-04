import { describe, expect, it } from "vitest";
import {
  bucketDescriptionSchema,
  bucketTagsSchema,
  buildBucketMetadataPatch,
  buildFilePatch,
  buildUploadMetadata,
  fileDescriptionSchema,
  fileTagsSchema,
  MAX_BUCKET_TAG_LENGTH,
  MAX_FILE_TAG_LENGTH,
} from "../src/console/fileMetadata";

describe("buildUploadMetadata", () => {
  it("returns undefined when neither field is provided", () => {
    expect(buildUploadMetadata({})).toBeUndefined();
  });

  it("carries a description through", () => {
    expect(buildUploadMetadata({ description: "quarterly report" })).toEqual({
      description: "quarterly report",
    });
  });

  it("carries tags through", () => {
    expect(buildUploadMetadata({ tags: ["finance", "q3"] })).toEqual({
      tags: ["finance", "q3"],
    });
  });

  it("carries both together", () => {
    expect(buildUploadMetadata({ description: "notes", tags: ["draft"] })).toEqual({
      description: "notes",
      tags: ["draft"],
    });
  });

  // "Absent" is a missing key, not "" / [] — the server treats the empty state as
  // a deleted key, and upload rejects null outright (it is `.optional()` but not
  // `.nullable()`). Sending an empty value would persist a key meaning "absent".
  it("omits a field the caller left out rather than sending an empty value", () => {
    expect(buildUploadMetadata({ description: "only me" })).not.toHaveProperty("tags");
    expect(buildUploadMetadata({ tags: ["only-me"] })).not.toHaveProperty("description");
  });
});

/**
 * These pin the Console limits the MCP mirrors. The two surfaces genuinely
 * disagree on tag length (files 30, buckets 24), so they are asserted
 * separately — a re-sync that updates one and forgets the other has to change
 * a test to do it.
 */
describe("metadata limits", () => {
  it("files: allows a description at the cap and rejects one over it", () => {
    expect(fileDescriptionSchema.safeParse("x".repeat(1000)).success).toBe(true);
    expect(fileDescriptionSchema.safeParse("x".repeat(1001)).success).toBe(false);
  });

  it("buckets: allows a description at the cap and rejects one over it", () => {
    expect(bucketDescriptionSchema.safeParse("x".repeat(1000)).success).toBe(true);
    expect(bucketDescriptionSchema.safeParse("x".repeat(1001)).success).toBe(false);
  });

  it("allows the maximum number of tags and rejects one more", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `tag${i}`);
    expect(fileTagsSchema.safeParse(ten).success).toBe(true);
    expect(fileTagsSchema.safeParse([...ten, "overflow"]).success).toBe(false);
    expect(bucketTagsSchema.safeParse(ten).success).toBe(true);
    expect(bucketTagsSchema.safeParse([...ten, "overflow"]).success).toBe(false);
  });

  it("enforces the per-surface tag length: files 30, buckets 24", () => {
    expect(MAX_FILE_TAG_LENGTH).toBe(30);
    expect(MAX_BUCKET_TAG_LENGTH).toBe(24);

    // A 30-char tag is valid on a file and invalid on a bucket — the exact
    // asymmetry a single shared schema would paper over.
    const thirty = "t".repeat(30);
    expect(fileTagsSchema.safeParse([thirty]).success).toBe(true);
    expect(bucketTagsSchema.safeParse([thirty]).success).toBe(false);
  });

  it("rejects an empty tag on both surfaces", () => {
    expect(fileTagsSchema.safeParse([""]).success).toBe(false);
    expect(bucketTagsSchema.safeParse([""]).success).toBe(false);
  });
});

/**
 * PATCH semantics are NOT the same as upload's, in two ways that matter:
 *
 * - `null` is meaningful on a file patch — it is the explicit clear signal
 *   (`descriptionPatchSchema` is `.nullable()`), whereas upload rejects it.
 * - Buckets do NOT accept `null` at all (`.optional()` without `.nullable()`),
 *   so a file-shaped clear would 400 there.
 *
 * `undefined` means "leave alone" on both, and an all-undefined patch has
 * nothing to send — Console refuses an empty body outright.
 */
describe("buildFilePatch", () => {
  it("returns undefined when there is nothing to change", () => {
    expect(buildFilePatch({})).toBeUndefined();
  });

  it("keeps null so the server clears the field", () => {
    expect(buildFilePatch({ description: null })).toEqual({ description: null });
    expect(buildFilePatch({ tags: null })).toEqual({ tags: null });
  });

  it("omits fields left undefined rather than clearing them", () => {
    expect(buildFilePatch({ description: undefined, tags: ["keep"] })).toEqual({
      tags: ["keep"],
    });
  });

  it("carries a rename alongside metadata", () => {
    expect(buildFilePatch({ name: "renamed.txt", description: "why" })).toEqual({
      name: "renamed.txt",
      description: "why",
    });
  });
});

describe("buildBucketMetadataPatch", () => {
  it("returns undefined when there is nothing to change", () => {
    expect(buildBucketMetadataPatch({})).toBeUndefined();
  });

  it("carries description and tags", () => {
    expect(buildBucketMetadataPatch({ description: "team assets", tags: ["shared"] })).toEqual({
      description: "team assets",
      tags: ["shared"],
    });
  });

  it("omits fields left undefined", () => {
    expect(buildBucketMetadataPatch({ tags: ["only"] })).toEqual({ tags: ["only"] });
  });
});
