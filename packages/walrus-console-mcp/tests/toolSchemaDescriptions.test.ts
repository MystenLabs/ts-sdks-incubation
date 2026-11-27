import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileDescriptionSchema, fileTagsSchema } from "../src/console/fileMetadata";

/**
 * Every inputSchema property carries a description in the JSON Schema an agent
 * receives from tools/list. Spawned like generateApiKeyRegisteredHandler.test.ts,
 * because importing bin/console-mcp.ts starts the stdio server.
 */

let tools: Tool[] = [];
let client: Client;
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
      // tools/list and the calls below make no request; this keeps any
      // accidental one off the network.
      CONSOLE_API_BASE_URL: "http://127.0.0.1:9",
    },
    stderr: "ignore",
  });
  client = new Client({ name: "tool-schema-probe", version: "0.0.0" });
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
    { description?: string; enum?: string[] } | undefined;

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

const firstText = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { type: string; text?: string }[])[0]?.text ?? "";

/**
 * Zod 4 builds each tool's JSON Schema in `io: "input"` mode, which leaves out
 * `additionalProperties` for a default (strip) object. Zod 3 printed `false`,
 * even though the server has always accepted an unknown key and dropped it.
 * The first two tests below pin both halves of that contract. If tool schemas
 * are made strict (`z.strictObject`), update them and the CHANGELOG: unknown
 * arguments would then be refused at runtime as well.
 */
describe("unknown tool arguments (zod 4 contract)", () => {
  it("no inputSchema advertises additionalProperties", () => {
    const advertising = tools
      .filter((tool) => "additionalProperties" in tool.inputSchema)
      .map((tool) => tool.name);
    expect(advertising).toEqual([]);
  });

  it("an unknown argument is dropped, not refused", async () => {
    // With the unknown key dropped, update_file sees no field to change, so its
    // own handler refuses. That proves the call got past input validation.
    const result = await client.callTool({
      name: "update_file",
      arguments: { fileId: "f_1", bogus_extra: 1 },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Provide at least one of: name, description, tags.");
  });

  it("a misspelled confirm still fails validation on delete_bucket", async () => {
    const result = await client.callTool({
      name: "delete_bucket",
      arguments: { bucketId: "b_1", confirmm: true },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/Input validation error[\s\S]*at confirm/);
  });

  // The full text, not just the hint: a re-describe that drops or swaps the
  // base description (bucketTagsSchema advertises different limits) must fail.
  it.each([
    ["description", `${fileDescriptionSchema.description} Pass null to clear it.`],
    ["tags", `${fileTagsSchema.description} Pass null to clear them.`],
  ])("update_file.%s keeps its description and the null hint", (key, expected) => {
    expect(property("update_file", key)?.description).toBe(expected);
  });
});
