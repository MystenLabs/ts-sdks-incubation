import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOWED_DIRS_ENV } from "../src/pathSandbox";

// `ping_console.allowed_dirs` must report what the sandbox itself selects
// (`selectAllowedDirs`), not CONSOLE_MCP_ALLOWED_DIRS alone, which read `[]`
// on a terminal install whose folders are saved in config.json.
//
// Drives the REAL registered handler over real stdio, launched from source
// with `tsx` the same way generateApiKeyRegisteredHandler.test.ts does
// (bin/console-mcp.ts starts stdio as a module-level side effect, so it can't
// be imported).
let cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.map((fn) => fn()));
  cleanup = [];
});

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error(`expected a text block, got ${block?.type}`);
  return block.text;
}

type PingOptions = {
  /** Written as the server's config.json. Omit for no file at all. */
  readonly configJson?: Record<string, unknown>;
  /** Extra env vars for the server process. */
  readonly env?: Record<string, string>;
  /** Omit for a client with no roots capability; "throws" fails roots/list. */
  readonly roots?: readonly string[] | "throws";
};

async function pingConsole(options: PingOptions): Promise<Record<string, unknown>> {
  // Same throwaway-config-dir reasoning as generateApiKeyRegisteredHandler:
  // XDG_CONFIG_HOME on macOS/Linux, APPDATA on Windows, so the developer's
  // real config.json can never leak into what ping reports.
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-ping-allowed-dirs-"));
  cleanup.push(async () => fs.rmSync(configHome, { recursive: true, force: true }));
  if (options.configJson !== undefined) {
    const configDir = path.join(configHome, "walrus-console-mcp");
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(options.configJson), {
      mode: 0o600,
    });
  }

  const entry = fileURLToPath(new URL("../bin/console-mcp.ts", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", entry],
    env: {
      PATH: process.env["PATH"] ?? "",
      XDG_CONFIG_HOME: configHome,
      APPDATA: configHome,
      LOCALAPPDATA: configHome,
      ...options.env,
    },
    stderr: "ignore",
  });
  cleanup.push(() => transport.close());

  const { roots } = options;
  const client = new Client(
    { name: "ping-allowed-dirs-probe", version: "0.0.0" },
    { capabilities: roots === undefined ? {} : { roots: {} } },
  );
  if (roots !== undefined) {
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      if (roots === "throws") throw new Error("probe: roots/list refused");
      return { roots: roots.map((dir) => ({ uri: pathToFileURL(dir).href })) };
    });
  }
  await client.connect(transport);

  const result = (await client.callTool({ name: "ping_console", arguments: {} })) as CallToolResult;
  expect(result.isError).toBeFalsy();
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

const scratchDir = (name: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `walrus-mcp-ping-${name}-`));
  cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

describe("ping_console reports the folders the sandbox actually uses", () => {
  it("reports folders saved in config.json when nothing else is configured", async () => {
    const saved = scratchDir("saved");
    const body = await pingConsole({ configJson: { allowedDirs: [saved] } });
    expect(body["allowed_dirs"]).toEqual([saved]);
    expect(body["allowed_dirs_source"]).toBe("file");
  }, 20_000);

  it("reports CONSOLE_MCP_ALLOWED_DIRS over the saved list when both are set", async () => {
    const saved = scratchDir("saved");
    const fromEnv = scratchDir("env");
    const body = await pingConsole({
      configJson: { allowedDirs: [saved] },
      env: { [ALLOWED_DIRS_ENV]: fromEnv },
    });
    expect(body["allowed_dirs"]).toEqual([fromEnv]);
    expect(body["allowed_dirs_source"]).toBe("env");
  }, 20_000);

  it("reports the client's MCP roots over both the env var and the saved list", async () => {
    const saved = scratchDir("saved");
    const fromEnv = scratchDir("env");
    const workspace = scratchDir("workspace");
    const body = await pingConsole({
      configJson: { allowedDirs: [saved] },
      env: { [ALLOWED_DIRS_ENV]: fromEnv },
      roots: [workspace],
    });
    expect(body["allowed_dirs"]).toEqual([workspace]);
    expect(body["allowed_dirs_source"]).toBe("clientRoots");
  }, 20_000);

  // "Safe to call first": a client that advertises roots but fails the
  // roots/list request must not make ping fail — it falls through exactly
  // as upload_file would.
  it("still answers, falling through to the saved list, when the client's roots/list fails", async () => {
    const saved = scratchDir("saved");
    const body = await pingConsole({ configJson: { allowedDirs: [saved] }, roots: "throws" });
    expect(body["allowed_dirs"]).toEqual([saved]);
    expect(body["allowed_dirs_source"]).toBe("file");
  }, 20_000);

  it("reports an empty list when no source yields a folder", async () => {
    const body = await pingConsole({});
    expect(body["allowed_dirs"]).toEqual([]);
    expect(body["allowed_dirs_source"]).toBe("file");
  }, 20_000);

  // PR #54 review: the admin pair without a Key-Admin pin is a WORKING setup
  // (create_bucket derives the manager from the admin signer), so ping must
  // not flag it.
  it("does not warn about a missing Key-Admin pin when the admin pair is set", async () => {
    const body = await pingConsole({
      env: {
        CONSOLE_ADMIN_KEY: "hbradm_probe_fake",
        CONSOLE_ADMIN_SERVICE_PRIVATE_KEY: "suiprivkey1_probe_fake",
      },
    });
    expect(body["has_admin_key"]).toBe(true);
    expect(body["has_key_admin_address"]).toBe(false);
    expect(body).not.toHaveProperty("warnings");
  }, 20_000);
});
