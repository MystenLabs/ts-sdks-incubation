import { describe, expect, it } from "vitest";
import { CONSOLE_MCP_SRC, inputSchemaBlockOf } from "./toolRegistrationText";
import { toolRegistrationBlock } from "./toolSource";

/**
 * COMG-1018 — a beta user could not enumerate a bucket past its first page.
 *
 * Both endpoints have always paged, and ConsoleApiClient has always taken the
 * cursor (tests/listPagination.test.ts pins that). The defect was entirely in
 * this file's tool definitions: the schemas exposed only the filters, so a
 * caller holding a `next_cursor` had nowhere to put it, and `list_files`
 * passed a hardcoded `undefined` into the client's cursor slot. Both halves
 * are asserted here, because either one alone silently restores the bug — a
 * schema that accepts `cursor` while the handler drops it looks like it works
 * and returns page 1 forever.
 */

describe("paged listing tools accept a cursor", () => {
  it.each(["list_files", "list_buckets"])("%s takes cursor in its input schema", (name) => {
    expect(inputSchemaBlockOf(CONSOLE_MCP_SRC, name)).toMatch(/cursor: z\s*\.string\(\)/);
  });

  it("list_buckets takes visibility in its input schema", () => {
    expect(inputSchemaBlockOf(CONSOLE_MCP_SRC, "list_buckets")).toMatch(/visibility:/);
  });

  it("list_files forwards the cursor to the client instead of a hardcoded undefined", () => {
    const block = toolRegistrationBlock("list_files");

    // The client signature is (bucketId, limit, cursor, q) — positional, so a
    // dropped cursor is not a type error, only a listing that never advances.
    // `[^;]` scans to the end of the statement: `[^)]` would stop at the paren
    // closing `BucketId.make(bucketId)` and never reach the cursor or q slot.
    expect(block).toMatch(
      /listBucketFiles\(\s*BucketId\.make\(bucketId\),\s*limit,\s*cursor,\s*q\s*\)/,
    );
    expect(block).not.toMatch(/listBucketFiles\([^;]*\bundefined\b/);
  });

  it("list_buckets forwards cursor and visibility to the client", () => {
    const block = toolRegistrationBlock("list_buckets");
    const call = block.slice(block.indexOf("api.listBuckets("));

    expect(call).toMatch(/\bcursor,/);
    expect(call).toMatch(/\bvisibility,/);
  });

  it("each tool's description tells a caller how to page", () => {
    // The schema is only half the fix: an agent that is never told to loop
    // stops at page 1 with the cursor in hand, which is what the reporter did.
    // Only the description slice counts: the cursor field's .describe() also
    // names next_cursor, and would pass a description reverted to one line.
    for (const name of ["list_files", "list_buckets"]) {
      const block = toolRegistrationBlock(name);
      const description = block.slice(block.indexOf("description:"), block.indexOf("inputSchema:"));
      expect(description).toMatch(/next_cursor/);
    }
  });
});
