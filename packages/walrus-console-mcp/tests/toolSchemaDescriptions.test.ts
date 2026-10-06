import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Every inputSchema property carries a description in the JSON Schema an agent
 * receives from tools/list. Spawned like generateApiKeyRegisteredHandler.test.ts,
 * because importing bin/console-mcp.ts starts the stdio server.
 */

let tools: Tool[] = [];
let close = async () => {};

beforeAll(async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-schema-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("../bin/console-mcp.ts", import.meta.url))],
    env: {
      PATH: process.env["PATH"] ?? "",
      XDG_CONFIG_HOME: configHome,
      APPDATA: configHome,
      LOCALAPPDATA: configHome,
      // tools/list makes no request; this keeps any accidental one off the network.
      CONSOLE_API_BASE_URL: "http://127.0.0.1:9",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "tool-schema-probe", version: "0.0.0" });
  await client.connect(transport);
  tools = (await client.listTools()).tools;
  close = async () => {
    await client.close();
    fs.rmSync(configHome, { recursive: true, force: true });
  };
}, 30_000);

afterAll(() => close());

const property = (tool: string, key: string) =>
  tools.find((t) => t.name === tool)?.inputSchema.properties?.[key] as
    | { description?: string; enum?: string[] }
    | undefined;

describe("tool input schemas, as tools/list returns them", () => {
  it("lists the 17 tools", () => {
    expect(tools.length).toBeGreaterThanOrEqual(17);
  });

  it("describes every property", () => {
    const undescribed = tools.flatMap((tool) =>
      Object.entries(tool.inputSchema.properties ?? {})
        .filter(([, schema]) => !(schema as { description?: string }).description?.trim())
        .map(([key]) => `${tool.name}.${key}`),
    );
    expect(undescribed).toEqual([]);
  });

  it.each([
    ["list_spaces", "type", ["personal", "team"]],
    ["generate_api_key", "permission", ["read_only", "read_write"]],
    ["list_buckets", "visibility", ["public", "private"]],
  ])("%s.%s is a closed set", (tool, key, values) => {
    expect(property(tool, key)?.enum).toEqual(values);
  });

  it.each(["list_buckets", "list_files"])("%s.q says it matches the name only", (tool) => {
    expect(property(tool, "q")?.description).toMatch(/name only/);
  });
});
