import { describe, expect, it } from "vitest";
import { type FileSummary, fileDisplaySize, withDisplaySize } from "../src/console/types";

/** Minimal FileSummary; only the size fields matter to these tests. */
function file(size: number, content_size?: number | null): FileSummary {
  return {
    id: "f1" as FileSummary["id"],
    bucket_id: "b1" as FileSummary["bucket_id"],
    name: "x.txt",
    size,
    ...(content_size === undefined ? {} : { content_size }),
    status: "active",
    is_private: true,
    mime_type: "text/plain",
    metadata: null,
    created_at: "2026-08-03T00:00:00.000Z",
    updated_at: "2026-08-03T00:00:00.000Z",
  };
}

describe("fileDisplaySize", () => {
  it("prefers the declared plaintext size when present", () => {
    expect(fileDisplaySize({ size: 445, content_size: 0 })).toBe(0);
    expect(fileDisplaySize({ size: 1245, content_size: 800 })).toBe(800);
  });

  it("falls back to the stored size when plaintext was never declared", () => {
    expect(fileDisplaySize({ size: 445, content_size: null })).toBe(445);
    expect(fileDisplaySize({ size: 445 })).toBe(445);
  });
});

describe("withDisplaySize", () => {
  it("adds display_size resolved from the plaintext length", () => {
    expect(withDisplaySize(file(675, 229)).display_size).toBe(229);
  });

  it("adds display_size falling back to the stored length for pre-change files", () => {
    expect(withDisplaySize(file(537, null)).display_size).toBe(537);
    expect(withDisplaySize(file(537)).display_size).toBe(537);
  });

  it("keeps both raw fields intact so quota callers still see the stored size", () => {
    const mapped = withDisplaySize(file(675, 229));

    expect(mapped.size).toBe(675);
    expect(mapped.content_size).toBe(229);
  });
});
