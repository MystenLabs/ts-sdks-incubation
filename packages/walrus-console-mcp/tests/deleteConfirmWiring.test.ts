import { describe, expect, it } from "vitest";
import { CONSOLE_MCP_SRC, inputSchemaBlockOf, toolRegistrationBlock } from "./toolRegistrationText";

// the security review — `confirmDestructive` (tests/toolSchemas.test.ts) proves the
// schema itself rejects anything but `true`, but that's only a real gate if
// bin/console-mcp.ts actually wires it into both delete tools' inputSchema.

describe("delete tools wire confirmDestructive into their input schema", () => {
  it.each(["delete_bucket", "delete_file"])("%s requires confirm: confirmDestructive", (name) => {
    expect(inputSchemaBlockOf(CONSOLE_MCP_SRC, name)).toMatch(/confirm:\s*confirmDestructive/);
  });

  // COMG-1021: the client now takes `confirm` as a parameter, so the flag cannot
  // originate there. This pins the other half, that the handler hands on the
  // value the schema validated instead of writing its own `true`.
  it("delete_bucket forwards the validated confirm to the client", () => {
    expect(toolRegistrationBlock(CONSOLE_MCP_SRC, "delete_bucket")).toMatch(
      /api\.deleteBucket\(BucketId\.make\(bucketId\),\s*\{\s*confirm,/,
    );
  });

  it("does not count a confirmDestructive mention outside inputSchema as wiring (review finding on PR #44)", () => {
    // The old whole-block regex would have passed on this: the mention lives
    // in a comment inside the handler, not in the schema the SDK validates.
    const decoySrc = [
      'registerTool(\n  "delete_bucket",\n  {',
      "    inputSchema: {\n      bucketId: z.string(),\n    },",
      "  },\n  async () => {",
      "    // confirm: confirmDestructive used to live here",
      "  },\n);",
    ].join("\n");

    expect(inputSchemaBlockOf(decoySrc, "delete_bucket")).not.toMatch(
      /confirm:\s*confirmDestructive/,
    );
  });
});
