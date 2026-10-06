import * as fs from "node:fs";
import * as path from "node:path";
import { getMcpConfigForManifest, type McpbManifestAny } from "@anthropic-ai/mcpb/browser";
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

/** The parts of manifest.json these tests read. */
interface Manifest {
  tools: { name: string; description: string }[];
  server: { mcp_config: { env: Record<string, string> } };
  user_config: Record<string, { required?: boolean; multiple?: boolean; default?: unknown }>;
}

function readManifest<T = Manifest>(): T {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf-8")) as T;
}

function manifestToolNames(): string[] {
  return readManifest().tools.map((t) => t.name);
}

describe("tool inventory", () => {
  it("registers exactly the 17 documented tools", () => {
    expect([...registeredToolNames()].sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("manifest.json lists exactly the registered tools (no drift)", () => {
    expect([...manifestToolNames()].sort()).toEqual([...registeredToolNames()].sort());
  });

  // COMG-1021 turned delete_bucket into a two-answer call. The .mcpb bundle
  // advertises manifest.json's text, so leaving the old "and all its files"
  // there tells bundle users the opposite of what the tool now does.
  it("says delete_bucket needs deleteContents for a non-empty bucket", () => {
    const deleteBucket = readManifest().tools.find((t) => t.name === "delete_bucket");

    expect(deleteBucket?.description).toMatch(/deleteContents/);
  });

  it("has no duplicate tool names in the manifest", () => {
    const names = manifestToolNames();
    expect(new Set(names).size).toBe(names.length);
  });
});

// The .mcpb install form reaches the server only through
// `server.mcp_config.env`, where Claude Desktop substitutes each
// `${user_config.X}` with the field's value. Two Desktop behaviours turn a
// field into a literal `${user_config.X}` string in the server's environment
// instead, which the server then reads as a real value:
//
// - Desktop substitutes only fields with a saved value or a manifest `default`
//   (modelcontextprotocol/mcpb#250). A field the user never clicked into is not
//   saved, so an optional field needs `"default": ""` to arrive blank.
// - Desktop will not put an array into a string: a `multiple: true` field logs
//   "Cannot replace user_config.X with array value in string context" and keeps
//   the placeholder. Arrays expand only inside `args`, and every value in `env`
//   is a string.
describe("user_config env wiring", () => {
  /** The manifest, plus every `user_config` key that some env value references. */
  function envWiring() {
    const manifest = readManifest();
    const envFields = Object.values(manifest.server.mcp_config.env).flatMap((value) =>
      [...value.matchAll(/\$\{user_config\.([^}]+)\}/g)].map((m) => m[1]!),
    );
    return { userConfig: manifest.user_config, envFields };
  }

  it("references only user_config fields that exist", () => {
    const { userConfig, envFields } = envWiring();
    expect(envFields.filter((key) => !Object.hasOwn(userConfig, key))).toEqual([]);
  });

  it("gives every optional env field a default (mcpb#250)", () => {
    const { userConfig, envFields } = envWiring();
    const missing = envFields.filter((key) => {
      const field = userConfig[key];
      return field !== undefined && field.required !== true && field.default === undefined;
    });
    expect(missing).toEqual([]);
  });

  it("has no multiple-value field in env (arrays cannot fill a string)", () => {
    const { userConfig, envFields } = envWiring();
    expect(envFields.filter((key) => userConfig[key]?.multiple === true)).toEqual([]);
  });

  // A space with no active Key-Admin key builds no management grant, so
  // create_bucket needs no manager pin there, and the Connect MCP panel shows
  // no address to paste. Requiring the field would block those users from
  // installing at all; a space that does have one gets a refusal naming the
  // field instead.
  it("leaves Key Admin Address optional, defaulting to blank", () => {
    const field = readManifest().user_config["console_key_admin_address"];
    expect(field?.required).not.toBe(true);
    expect(field?.default).toBe("");
  });

  // The same check end to end, through @anthropic-ai/mcpb's own substitution
  // (the code that logs the array-in-string warning above). A user who fills
  // only the Required fields must not leave a placeholder for the server.
  it("leaves no ${user_config.X} in the server config when only Required fields are filled", async () => {
    const manifest = readManifest<McpbManifestAny>();
    const userConfig = Object.fromEntries(
      Object.entries(manifest.user_config ?? {})
        .filter(([, field]) => field.required === true)
        .map(([key, field]) => [
          key,
          field.multiple === true ? ["/a", "/b"] : field.type === "directory" ? "/a" : "x",
        ]),
    );

    const config = await getMcpConfigForManifest({
      manifest,
      extensionPath: "/ext",
      systemDirs: {},
      userConfig,
      pathSeparator: "/",
    });

    expect(config).toBeDefined();
    expect(JSON.stringify(config).match(/\$\{user_config\.[^}]+\}/g) ?? []).toEqual([]);
  });
});
