import { createServer } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { ALLOWED_DIRS_ENV } from "../src/pathSandbox";
import { installProfile } from "./helpers/installProfile.js";

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
  /** Reuse an existing fixture config across separate server connections. */
  readonly configHome?: string;
  /** Extra env vars for the server process. */
  readonly env?: Record<string, string>;
  /** Omit for a client with no roots capability; "throws" fails roots/list. */
  readonly roots?: readonly string[] | "throws";
};

async function withConsole<T>(
  options: PingOptions,
  action: (client: Client, configHome: string) => Promise<T>,
): Promise<T> {
  // Same throwaway-config-dir reasoning as generateApiKeyRegisteredHandler:
  // XDG_CONFIG_HOME on macOS/Linux, APPDATA on Windows, so the developer's
  // real config.json can never leak into what ping reports.
  const configHome =
    options.configHome ?? fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-ping-allowed-dirs-"));
  if (options.configHome === undefined)
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

  return action(client, configHome);
}

async function pingConsole(options: PingOptions): Promise<Record<string, unknown>> {
  return withConsole(options, async (client) => {
    const result = (await client.callTool({
      name: "ping_console",
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(textOf(result)) as Record<string, unknown>;
    for (const field of [
      "allowed_folders",
      "excluded_saved_folders",
      "protected_config_directory",
    ]) {
      expect(body).not.toHaveProperty(field);
    }
    return body;
  });
}

/**
 * A loopback Console that answers any key on GET /api/v1/spaces with an empty list. ping_console
 * now makes that call, so the credential-retention tests need an answer; they check what is
 * retained, not whether the key is valid.
 */
async function startAcceptingConsole(): Promise<string> {
  const server = createServer((req, res) => {
    if (req.url === "/api/v1/spaces") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

const scratchDir = (name: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `walrus-mcp-ping-${name}-`));
  cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
};

describe("ping_console with a single credential environment override", () => {
  it.each([
    ["CONSOLE_API_KEY", "hbr_environment_key"],
    ["CONSOLE_SERVICE_PRIVATE_KEY", "suiprivkey1_environment_signer"],
    ["CONSOLE_ADMIN_KEY", "hbradm_environment_key"],
    ["CONSOLE_ADMIN_SERVICE_PRIVATE_KEY", "suiprivkey1_environment_admin_signer"],
  ])(
    "retains saved credentials and folder grants with %s",
    async (envName, value) => {
      const saved = scratchDir("credential-saved");
      const fromEnv = scratchDir("credential-env");
      const workspace = scratchDir("credential-workspace");
      const baseUrl = await startAcceptingConsole();
      const body = await pingConsole({
        configJson: {
          apiKey: "hbr_saved_key",
          servicePrivateKey: "suiprivkey1_saved_signer",
          adminKey: "hbradm_saved_key",
          adminServicePrivateKey: "suiprivkey1_saved_admin_signer",
          webAccountAddress: `0x${"1".repeat(64)}`,
          keyAdminAddress: `0x${"2".repeat(64)}`,
          baseUrl,
          allowedDirsScope: "shared",
          allowedDirs: [saved],
        },
        env: { [envName]: value, [ALLOWED_DIRS_ENV]: fromEnv },
        roots: [workspace],
      });
      expect(body).toMatchObject({
        ok: true,
        has_api_key: true,
        has_service_key: true,
        has_admin_key: true,
        has_admin_signer: true,
        has_web_account_address: true,
        has_key_admin_address: true,
        base_url: baseUrl,
        allowed_dirs: [workspace, fromEnv, saved],
        allowed_dirs_source: "union",
      });
    },
    20_000,
  );
});

describe("saved scope migration over live MCP connections", () => {
  it("requires explicit sharing and reloads migration/downgrade without reconnecting", async () => {
    const saved = scratchDir("legacy-scope");
    const workspaceA = scratchDir("scope-a");
    const workspaceB = scratchDir("scope-b");
    fs.writeFileSync(path.join(saved, "fixture.txt"), "scope fixture");
    const ping = async (client: Client) => {
      const result = await client.callTool({ name: "ping_console", arguments: {} });
      expect(result.isError).toBeFalsy();
      return JSON.parse(textOf(result as CallToolResult)).allowed_dirs;
    };
    await withConsole(
      { roots: [workspaceA], configJson: { allowedDirs: [saved] } },
      async (clientA, configHome) => {
        await withConsole(
          { roots: [workspaceB], configHome, env: { [ALLOWED_DIRS_ENV]: saved } },
          async (clientB) => {
            expect(await ping(clientA)).toEqual([workspaceA]);
            expect(await ping(clientB)).toEqual([workspaceB, saved]);
            const denied = await clientA.callTool({
              name: "upload_file",
              arguments: {
                bucketId: "00000000-0000-0000-0000-000000000001",
                localPath: path.join(saved, "fixture.txt"),
              },
            });
            expect(denied.isError).toBe(true);
            expect(textOf(denied as CallToolResult)).toContain("fallback scope");
            const entry = fileURLToPath(new URL("../bin/console-mcp.ts", import.meta.url));
            for (const scope of ["shared", "fallback"] as const) {
              const configured = spawnSync(
                process.execPath,
                [
                  "--import",
                  "tsx",
                  entry,
                  "config",
                  "--silent",
                  "--allowed-dirs",
                  saved,
                  "--allowed-dirs-scope",
                  scope,
                ],
                {
                  env: {
                    PATH: process.env["PATH"] ?? "",
                    XDG_CONFIG_HOME: configHome,
                    APPDATA: configHome,
                  },
                  encoding: "utf8",
                },
              );
              expect(configured.status, configured.stderr).toBe(0);
              expect(await ping(clientA)).toEqual(
                scope === "shared" ? [workspaceA, saved] : [workspaceA],
              );
              // This independent environment grant survives saved-scope revocation.
              expect(await ping(clientB)).toEqual([workspaceB, saved]);
            }
            await withConsole({ configHome }, async (clientC) => {
              expect(await ping(clientC)).toEqual([saved]);
            });
          },
        );
      },
    );
  }, 30_000);

  it("install persists explicit shared scope without changing client registration", async () => {
    const profile = installProfile();
    cleanup.push(async () => profile.cleanup());
    const saved = fs.realpathSync(profile.allowed);
    // Exercise the production installer with a local, dependency-free package.
    // --no-register still installs a launcher; all writes stay in this profile.
    const pkg = path.join(profile.root, "stub-package");
    fs.mkdirSync(pkg);
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "walrus-scope-test-stub",
        version: "1.0.0",
        bin: { "walrus-console-mcp": "cli.js" },
      }),
    );
    fs.writeFileSync(path.join(pkg, "cli.js"), "#!/usr/bin/env node\n");
    profile.localPackage(pkg);
    await withConsole(
      { roots: [], configHome: path.join(profile.root, "config") },
      async (client, configHome) => {
        const configured = profile.run([
          "install",
          "--silent",
          "--no-register",
          "--allowed-dirs",
          saved,
          "--allowed-dirs-scope",
          "shared",
        ]);
        expect(configured.status, configured.stderr).toBe(0);
        expect(fs.existsSync(profile.launcher)).toBe(true);
        expect(fs.existsSync(path.join(profile.root, ".cursor", "mcp.json"))).toBe(false);
        const config = JSON.parse(
          fs.readFileSync(path.join(configHome, "walrus-console-mcp", "config.json"), "utf8"),
        );
        expect(config.allowedDirsScope).toBe("shared");
        const result = await client.callTool({ name: "ping_console", arguments: {} });
        expect(JSON.parse(textOf(result as CallToolResult)).allowed_dirs).toEqual([saved]);
      },
    );
  }, 30_000);
});

describe("ping_console reports the folders the sandbox actually uses", () => {
  it("reports folders saved in config.json when nothing else is configured", async () => {
    const saved = scratchDir("saved");
    const body = await pingConsole({
      configJson: { allowedDirsScope: "shared", allowedDirs: [saved] },
    });
    expect(body["allowed_dirs"]).toEqual([saved]);
    expect(body["allowed_dirs_source"]).toBe("file");
  }, 20_000);

  it("reports environment and saved folders together", async () => {
    const saved = scratchDir("saved");
    const fromEnv = scratchDir("env");
    const body = await pingConsole({
      configJson: { allowedDirsScope: "shared", allowedDirs: [saved] },
      env: { [ALLOWED_DIRS_ENV]: fromEnv },
    });
    expect(body["allowed_dirs"]).toEqual([fromEnv, saved]);
    expect(body["allowed_dirs_source"]).toBe("union");
  }, 20_000);

  it("reports the canonical workspace, environment and saved union", async () => {
    const saved = scratchDir("saved");
    const fromEnv = scratchDir("env");
    const workspace = scratchDir("workspace");
    const body = await pingConsole({
      configJson: { allowedDirsScope: "shared", allowedDirs: [saved] },
      env: { [ALLOWED_DIRS_ENV]: fromEnv },
      roots: [workspace],
    });
    expect(body["allowed_dirs"]).toEqual([workspace, fromEnv, saved]);
    expect(body["allowed_dirs_source"]).toBe("union");
  }, 20_000);

  it("reports clientRoots when only workspace folders contribute", async () => {
    const workspace = scratchDir("workspace-only");
    const body = await pingConsole({ roots: [workspace] });
    expect(body["allowed_dirs"]).toEqual([workspace]);
    expect(body["allowed_dirs_source"]).toBe("clientRoots");
  }, 20_000);

  it("reports env when only environment folders contribute", async () => {
    const fromEnv = scratchDir("env-only");
    const body = await pingConsole({ env: { [ALLOWED_DIRS_ENV]: fromEnv } });
    expect(body["allowed_dirs"]).toEqual([fromEnv]);
    expect(body["allowed_dirs_source"]).toBe("env");
  }, 20_000);

  it.each(["clientRoots", "env"] as const)(
    "retains %s as the first source when canonical aliases contribute no new entries",
    async (firstSource) => {
      const folder = scratchDir("dedup");
      const aliases = scratchDir("aliases");
      const alias = path.join(aliases, "folder-link");
      fs.symlinkSync(folder, alias, "dir");
      const body = await pingConsole({
        ...(firstSource === "clientRoots" ? { roots: [alias] } : {}),
        env: { [ALLOWED_DIRS_ENV]: alias },
        configJson: { allowedDirsScope: "shared", allowedDirs: [folder, alias] },
      });
      expect(body["allowed_dirs"]).toEqual([folder]);
      expect(body["allowed_dirs_source"]).toBe(firstSource);
    },
    20_000,
  );

  it("isolates workspace grants across live connections while sharing CLI saved-list replacements", async () => {
    const workspaceA = scratchDir("workspace-a");
    const workspaceB = scratchDir("workspace-b");
    const saved = scratchDir("shared-saved");
    const added = scratchDir("replacement-saved");
    for (const folder of [workspaceA, workspaceB, saved, added]) {
      fs.writeFileSync(path.join(folder, "fixture.txt"), "shared grants regression fixture\n");
    }
    const ping = async (client: Client, folders: string[], source: string) => {
      const result = (await client.callTool({
        name: "ping_console",
        arguments: {},
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(textOf(result));
      expect(body["allowed_dirs"]).toEqual(folders);
      expect(body["allowed_dirs_source"]).toBe(source);
    };
    const refuseUpload = async (client: Client, file: string) => {
      const result = (await client.callTool({
        name: "upload_file",
        arguments: {
          bucketId: "00000000-0000-0000-0000-000000000001",
          localPath: file,
        },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("outside the folders this server can access");
    };
    await withConsole(
      {
        roots: [workspaceA],
        env: { [ALLOWED_DIRS_ENV]: saved },
        configJson: { allowedDirsScope: "shared", allowedDirs: [saved] },
      },
      async (clientA, configHome) => {
        await withConsole({ roots: [workspaceB], configHome }, async (clientB) => {
          await withConsole({ configHome }, async (clientC) => {
            await ping(clientA, [workspaceA, saved], "union");
            await ping(clientB, [workspaceB, saved], "union");
            await ping(clientC, [saved], "file");
            await refuseUpload(clientA, path.join(workspaceB, "fixture.txt"));
            await refuseUpload(clientB, path.join(workspaceA, "fixture.txt"));
            await refuseUpload(clientC, path.join(workspaceA, "fixture.txt"));
            await refuseUpload(clientC, path.join(workspaceB, "fixture.txt"));
            // This server inherits the test checkout's cwd, which grants nothing without client roots.
            await refuseUpload(clientC, fileURLToPath(new URL("../README.md", import.meta.url)));
            const entry = fileURLToPath(new URL("../bin/console-mcp.ts", import.meta.url));
            const configured = spawnSync(
              process.execPath,
              [
                "--import",
                "tsx",
                entry,
                "config",
                "--silent",
                "--allowed-dirs-scope",
                "shared",
                "--allowed-dirs",
                added,
              ],
              {
                env: {
                  PATH: process.env["PATH"] ?? "",
                  XDG_CONFIG_HOME: configHome,
                  APPDATA: configHome,
                },
                encoding: "utf8",
              },
            );
            expect(configured.status, configured.stderr).toBe(0);
            // No connections are recreated: the replacement reaches all three on their next call.
            // A retains saved via its independent environment grant; B and C lose that folder.
            await ping(clientA, [workspaceA, saved, added], "union");
            await ping(clientB, [workspaceB, added], "union");
            await ping(clientC, [added], "file");
            await refuseUpload(clientB, path.join(saved, "fixture.txt"));
            await refuseUpload(clientC, path.join(saved, "fixture.txt"));
          });
        });
      },
    );
  }, 30_000);

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps explicit grants usable and saved grants withheld when Home cannot be resolved",
    async () => {
      const root = scratchDir("inaccessible-home");
      const denied = path.join(root, "denied");
      const home = path.join(denied, "home");
      fs.mkdirSync(home, { recursive: true });
      const workspace = scratchDir("workspace");
      const fromEnv = scratchDir("env");
      const saved = scratchDir("saved");
      fs.writeFileSync(path.join(saved, "input.txt"), "unclassified saved grant fixture\n");
      fs.chmodSync(denied, 0);
      try {
        expect(() => fs.realpathSync(home)).toThrow(/EACCES/);
        await withConsole(
          {
            roots: [workspace],
            env: { HOME: home, [ALLOWED_DIRS_ENV]: fromEnv },
            configJson: { allowedDirsScope: "shared", allowedDirs: [saved] },
          },
          async (client, configHome) => {
            const ping = (await client.callTool({
              name: "ping_console",
              arguments: {},
            })) as CallToolResult;
            expect(ping.isError).toBeFalsy();
            const body = JSON.parse(textOf(ping));
            expect(body.allowed_dirs).toEqual([workspace, fromEnv]);
            expect(body.allowed_dirs_source).toBe("union");
            const deniedSaved = (await client.callTool({
              name: "upload_file",
              arguments: {
                bucketId: "00000000-0000-0000-0000-000000000001",
                localPath: path.join(saved, "input.txt"),
              },
            })) as CallToolResult;
            expect(deniedSaved.isError).toBe(true);
            expect(textOf(deniedSaved)).toContain("Home cannot be resolved");
            // A real client can explicitly grant a config ancestor; it still cannot grant the config subtree.
            client.setRequestHandler(ListRootsRequestSchema, async () => ({
              roots: [{ uri: pathToFileURL(configHome).href }],
            }));
            const deniedConfig = (await client.callTool({
              name: "upload_file",
              arguments: {
                bucketId: "00000000-0000-0000-0000-000000000001",
                localPath: path.join(configHome, "walrus-console-mcp", "config.json"),
              },
            })) as CallToolResult;
            expect(deniedConfig.isError).toBe(true);
            expect(textOf(deniedConfig)).toContain("MCP config directory is protected");
          },
        );
        // If the client's sole root is also inaccessible, an empty result must still explain
        // the withheld saved grant instead of suggesting an ineffective config replacement.
        await withConsole(
          {
            roots: [home],
            env: { HOME: home },
            configJson: { allowedDirsScope: "shared", allowedDirs: [saved] },
          },
          async (client) => {
            const response = (await client.callTool({
              name: "upload_file",
              arguments: {
                bucketId: "00000000-0000-0000-0000-000000000001",
                localPath: path.join(saved, "input.txt"),
              },
            })) as CallToolResult;
            expect(response.isError).toBe(true);
            expect(textOf(response)).toContain("Restore access to Home and retry");
            expect(textOf(response)).not.toContain("config --allowed-dirs");
          },
        );
      } finally {
        fs.chmodSync(denied, 0o700);
      }
    },
    20_000,
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "retains saved-only fallback without needing to resolve an inaccessible Home",
    async () => {
      const root = scratchDir("fallback-home");
      const denied = path.join(root, "denied");
      const home = path.join(denied, "home");
      fs.mkdirSync(home, { recursive: true });
      const saved = scratchDir("saved-fallback");
      fs.chmodSync(denied, 0);
      try {
        expect(() => fs.realpathSync(home)).toThrow(/EACCES/);
        const body = await pingConsole({
          env: { HOME: home },
          configJson: { allowedDirsScope: "shared", allowedDirs: [saved] },
        });
        expect(body["allowed_dirs"]).toEqual([saved]);
        expect(body["allowed_dirs_source"]).toBe("file");
      } finally {
        fs.chmodSync(denied, 0o700);
      }
    },
    20_000,
  );

  // "Safe to call first": a client that advertises roots but fails the
  // roots/list request must not make ping fail — it falls through exactly
  // as upload_file would.
  it("still answers, falling through to the saved list, when the client's roots/list fails", async () => {
    const saved = scratchDir("saved");
    const body = await pingConsole({
      configJson: { allowedDirsScope: "shared", allowedDirs: [saved] },
      roots: "throws",
    });
    expect(body["allowed_dirs"]).toEqual([saved]);
    expect(body["allowed_dirs_source"]).toBe("file");
  }, 20_000);

  it("reports an empty list with source file and denies transfers when no source yields a folder", async () => {
    const fixture = scratchDir("no-grants");
    fs.writeFileSync(path.join(fixture, "input.txt"), "ungranted fixture\n");
    await withConsole({}, async (client) => {
      const result = (await client.callTool({
        name: "ping_console",
        arguments: {},
      })) as CallToolResult;
      const body = JSON.parse(textOf(result));
      expect(body.allowed_dirs).toEqual([]);
      expect(body.allowed_dirs_source).toBe("file");
      for (const call of [
        {
          name: "upload_file",
          arguments: {
            bucketId: "00000000-0000-0000-0000-000000000001",
            localPath: path.join(fixture, "input.txt"),
          },
        },
        {
          name: "download_file",
          arguments: {
            bucketId: "00000000-0000-0000-0000-000000000001",
            fileId: "00000000-0000-0000-0000-000000000002",
            destPath: path.join(fixture, "output.txt"),
          },
        },
      ]) {
        const denied = (await client.callTool(call)) as CallToolResult;
        expect(denied.isError).toBe(true);
        expect(textOf(denied)).toContain("no folders are set up yet");
      }
    });
  }, 20_000);

  it("reloads folders saved by config on the next call without reconnecting a roots-advertising client", async () => {
    const saved = scratchDir("saved");
    const added = scratchDir("added");
    const workspace = scratchDir("workspace");
    await withConsole(
      { configJson: { allowedDirsScope: "shared", allowedDirs: [saved] }, roots: [workspace] },
      async (client, configHome) => {
        await client.callTool({ name: "ping_console", arguments: {} });
        const entry = fileURLToPath(new URL("../bin/console-mcp.ts", import.meta.url));
        const configured = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            entry,
            "config",
            "--silent",
            "--allowed-dirs-scope",
            "shared",
            "--allowed-dirs",
            saved,
            "--allowed-dirs",
            added,
          ],
          {
            env: {
              PATH: process.env["PATH"] ?? "",
              XDG_CONFIG_HOME: configHome,
              APPDATA: configHome,
            },
            encoding: "utf8",
          },
        );
        expect(configured.status, configured.stderr).toBe(0);
        const result = (await client.callTool({
          name: "ping_console",
          arguments: {},
        })) as CallToolResult;
        expect(JSON.parse(textOf(result)).allowed_dirs).toEqual([workspace, saved, added]);
      },
    );
  }, 20_000);

  it("refuses config upload and download through the registered tools, before storage is contacted", async () => {
    const workspace = scratchDir("workspace");
    await withConsole({ roots: [workspace] }, async (client, configHome) => {
      const dir = path.join(configHome, "walrus-console-mcp");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ allowedDirs: [configHome], allowedDirsScope: "shared" }),
      );
      for (const call of [
        {
          name: "upload_file",
          arguments: {
            bucketId: "00000000-0000-0000-0000-000000000001",
            localPath: path.join(dir, "config.json"),
          },
        },
        {
          name: "download_file",
          arguments: {
            bucketId: "00000000-0000-0000-0000-000000000001",
            fileId: "00000000-0000-0000-0000-000000000002",
            destPath: path.join(dir, "admin.json"),
          },
        },
      ]) {
        const result = (await client.callTool(call)) as CallToolResult;
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("MCP config directory is protected");
      }
    });
  }, 20_000);

  it("does not persist workspace or environment folders in the suggested config command", async () => {
    const workspace = scratchDir("workspace");
    const fromEnv = scratchDir("env");
    const saved = scratchDir("saved");
    const blocked = scratchDir("blocked");
    await withConsole(
      {
        roots: [workspace],
        env: { [ALLOWED_DIRS_ENV]: fromEnv },
        configJson: { allowedDirsScope: "shared", allowedDirs: [saved] },
      },
      async (client) => {
        const result = (await client.callTool({
          name: "upload_file",
          arguments: {
            bucketId: "00000000-0000-0000-0000-000000000001",
            localPath: path.join(blocked, "file.txt"),
          },
        })) as CallToolResult;
        expect(result.isError).toBe(true);
        const message = textOf(result);
        expect(message).toContain(`${saved} (file)`);
        const command = message.match(/`walrus-console-mcp config[^`]+`/)?.[0];
        expect(command).toBe(
          `\`walrus-console-mcp config --allowed-dirs '${saved}' --allowed-dirs <dir> --allowed-dirs-scope shared\``,
        );
      },
    );
  }, 20_000);

  it("bounds an unresponsive roots request and retries on the next call", async () => {
    const saved = scratchDir("saved");
    const workspace = scratchDir("workspace");
    await withConsole(
      { roots: [], configJson: { allowedDirsScope: "shared", allowedDirs: [saved] } },
      async (client) => {
        client.setRequestHandler(ListRootsRequestSchema, async () => new Promise<never>(() => {}));
        const first = (await client.callTool({ name: "ping_console", arguments: {} }, undefined, {
          timeout: 5000,
        })) as CallToolResult;
        expect(first.isError).toBeFalsy();
        expect(JSON.parse(textOf(first)).allowed_dirs).toEqual([saved]);
        client.setRequestHandler(ListRootsRequestSchema, async () => ({
          roots: [{ uri: pathToFileURL(workspace).href }],
        }));
        const second = (await client.callTool({
          name: "ping_console",
          arguments: {},
        })) as CallToolResult;
        expect(JSON.parse(textOf(second)).allowed_dirs).toEqual([workspace, saved]);
      },
    );
  }, 20_000);

  it("refuses Home through the silent CLI and leaves the workspace folders untouched", async () => {
    const workspace = scratchDir("workspace");
    await withConsole({ roots: [workspace] }, async (client, configHome) => {
      const entry = fileURLToPath(new URL("../bin/console-mcp.ts", import.meta.url));
      const configured = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          entry,
          "config",
          "--silent",
          "--allowed-dirs-scope",
          "shared",
          "--allowed-dirs",
          os.homedir(),
        ],
        {
          env: {
            PATH: process.env["PATH"] ?? "",
            XDG_CONFIG_HOME: configHome,
            APPDATA: configHome,
          },
          encoding: "utf8",
        },
      );
      expect(configured.status).not.toBe(0);
      expect(configured.stdout + configured.stderr).toContain("is your home directory");
      const result = (await client.callTool({
        name: "ping_console",
        arguments: {},
      })) as CallToolResult;
      const body = JSON.parse(textOf(result));
      expect(body["allowed_dirs"]).toEqual([workspace]);
      expect(body["allowed_dirs_source"]).toBe("clientRoots");
    });
  });

  it("names a client root that is the home directory instead of listing it as allowed", async () => {
    const home = scratchDir("home");
    const body = await pingConsole({ env: { HOME: home, USERPROFILE: home }, roots: [home] });
    expect(body["allowed_dirs"]).toEqual([]);
    expect(body["refused_roots"]).toEqual([home]);
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
