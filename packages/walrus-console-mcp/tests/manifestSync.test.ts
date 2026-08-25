import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// Guards against manifest.json drifting out of sync with the tools the server
// actually registers — the .mcpb bundle advertises manifest.json's inventory,
// so a missing (or stale) entry silently ships an inaccurate tool list.
//
// The registered names are read from bin/console-mcp.ts as TEXT, never
// imported: importing it runs the module top-to-bottom, which connects the
// stdio transport and starts the server. A regex over the source is enough to
// recover every `registerTool("name", …)`.

const ROOT = path.join(__dirname, "..");

/** The 17 tools the MCP server is expected to register. */
const EXPECTED_TOOLS = [
  "ping_console",
  "list_spaces",
  "get_storage_usage",
  "list_buckets",
  "create_bucket",
  "generate_api_key",
  "upload_file",
  "download_file",
  "list_files",
  "get_file_status",
  "get_bucket",
  "rename_bucket",
  "delete_bucket",
  "delete_file",
  "update_file",
  "get_bucket_metadata",
  "update_bucket_metadata",
] as const;

function registeredToolNames(): string[] {
  const src = fs.readFileSync(path.join(ROOT, "bin", "console-mcp.ts"), "utf-8");
  const names: string[] = [];
  const re = /registerTool\(\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    names.push(match[1]!);
  }
  return names;
}

function manifestToolNames(): string[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf-8")) as {
    tools: { name: string }[];
  };
  return manifest.tools.map((t) => t.name);
}

describe("tool inventory", () => {
  it("registers exactly the 17 documented tools", () => {
    expect([...registeredToolNames()].sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("manifest.json lists exactly the registered tools (no drift)", () => {
    expect([...manifestToolNames()].sort()).toEqual([...registeredToolNames()].sort());
  });

  it("has no duplicate tool names in the manifest", () => {
    const names = manifestToolNames();
    expect(new Set(names).size).toBe(names.length);
  });
});
