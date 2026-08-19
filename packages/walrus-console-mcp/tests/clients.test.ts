import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLI_CLIENT_SPECS,
  claudeDesktopConfigPath,
  cliClient,
  commandExists,
  cursorConfigPath,
  dirExists,
  getClients,
  jsonFileClient,
  renderChecklistLines,
  renderConfirmLine,
  SERVER_NAME,
  selectClients,
  upsertMcpServer,
} from "../src/clients.js";

/**
 * What the installer now records: the absolute path of the launcher it installed
 * into its own directory, resolved once at install time rather than at every
 * launch. See src/installDir.ts.
 */
const INSTALLED_BIN = path.join(
  "/home/u/.local/share/walrus-console-mcp",
  "node_modules",
  ".bin",
  "walrus-console-mcp",
);

const stubClient = (id: string, detected: boolean) => ({
  id,
  label: id,
  detect: () => detected,
  register: () => {},
  manualHint: () => "",
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-clients-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("commandExists", () => {
  it("finds a binary present in a PATH directory (POSIX)", () => {
    fs.writeFileSync(path.join(tmpDir, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    expect(commandExists("claude", { path: tmpDir, platform: "linux" })).toBe(true);
  });

  it("returns false when the binary is not on PATH", () => {
    expect(commandExists("codex", { path: tmpDir, platform: "linux" })).toBe(false);
  });

  it("returns false for an empty PATH", () => {
    expect(commandExists("claude", { path: "", platform: "linux" })).toBe(false);
  });

  it("honors PATHEXT on Windows (bin without extension resolves to bin.CMD)", () => {
    fs.writeFileSync(path.join(tmpDir, "gemini.CMD"), "");
    expect(
      commandExists("gemini", {
        path: tmpDir,
        platform: "win32",
        pathext: ".EXE;.CMD;.BAT",
      }),
    ).toBe(true);
  });
});

describe("upsertMcpServer", () => {
  // The entry records the ABSOLUTE launcher path resolved at install time. It must
  // never go back to `npx -y <spec>`: that resolves the package name against the
  // directory the agent was started in, so any project shipping a package of the
  // same name gets launched holding this server's Console credentials.
  it("adds our stdio entry pointing at the absolute launcher", () => {
    const result = upsertMcpServer({}, "walrus-console-mcp", INSTALLED_BIN);
    expect(result.mcpServers["walrus-console-mcp"]).toEqual({
      command: INSTALLED_BIN,
      args: [],
    });
  });

  it("never emits a resolution-time launcher", () => {
    const entry = upsertMcpServer({}, "walrus-console-mcp", INSTALLED_BIN).mcpServers[
      "walrus-console-mcp"
    ];
    expect(entry?.command).not.toBe("npx");
    expect(entry?.args).not.toContain("-y");
    expect(path.isAbsolute(entry?.command ?? "")).toBe(true);
  });

  it("preserves other existing servers", () => {
    const existing = {
      mcpServers: { "other-server": { command: "other", args: [] } },
    };
    const result = upsertMcpServer(existing, "walrus-console-mcp", INSTALLED_BIN);
    expect(result.mcpServers["other-server"]).toEqual({ command: "other", args: [] });
    expect(result.mcpServers["walrus-console-mcp"]).toBeDefined();
  });

  it("overwrites a stale entry for the same server name", () => {
    // Including one left behind by an older, npx-based install.
    const existing = {
      mcpServers: {
        "walrus-console-mcp": {
          command: "npx",
          args: ["-y", "@mysten-incubation/walrus-console-mcp@0.0.1"],
        },
      },
    };
    const result = upsertMcpServer(existing, "walrus-console-mcp", INSTALLED_BIN);
    expect(result.mcpServers["walrus-console-mcp"]).toEqual({
      command: INSTALLED_BIN,
      args: [],
    });
  });

  it("preserves unrelated top-level keys in the config", () => {
    const existing = { theme: "dark", mcpServers: {} };
    const result = upsertMcpServer(existing, "walrus-console-mcp", INSTALLED_BIN);
    expect((result as { theme?: string }).theme).toBe("dark");
  });
});

describe("CLI client arg builders", () => {
  const name = "walrus-console-mcp";
  const command = INSTALLED_BIN;
  const byId = (id: string) => {
    const c = CLI_CLIENT_SPECS.find((s: (typeof CLI_CLIENT_SPECS)[number]) => s.id === id);
    if (!c) throw new Error(`no CLI client spec: ${id}`);
    return c;
  };

  it("claude-code: add uses --scope user and the -- separator", () => {
    expect(byId("claude-code").addArgs(name, command)).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "walrus-console-mcp",
      "--",
      INSTALLED_BIN,
    ]);
  });

  it("claude-code: remove targets the same scope + name", () => {
    expect(byId("claude-code").removeArgs(name)).toEqual([
      "mcp",
      "remove",
      "--scope",
      "user",
      "walrus-console-mcp",
    ]);
  });

  it("codex: add uses the -- separator and no scope flag", () => {
    expect(byId("codex").addArgs(name, command)).toEqual([
      "mcp",
      "add",
      "walrus-console-mcp",
      "--",
      INSTALLED_BIN,
    ]);
  });

  it("codex: remove takes just the name", () => {
    expect(byId("codex").removeArgs(name)).toEqual(["mcp", "remove", "walrus-console-mcp"]);
  });

  it("gemini: add uses --scope user but NO -- separator", () => {
    expect(byId("gemini").addArgs(name, command)).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "walrus-console-mcp",
      INSTALLED_BIN,
    ]);
  });

  it("gemini: remove targets the same scope + name", () => {
    expect(byId("gemini").removeArgs(name)).toEqual([
      "mcp",
      "remove",
      "--scope",
      "user",
      "walrus-console-mcp",
    ]);
  });
});

describe("cliClient", () => {
  const spec = CLI_CLIENT_SPECS[0]; // claude-code
  if (!spec) throw new Error("expected a CLI client spec");
  const pkgSpec = INSTALLED_BIN;

  it("registers by running remove (idempotency) THEN add, in order", () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const client = cliClient(spec, { run: (bin, args) => calls.push({ bin, args }) });

    client.register(pkgSpec);

    expect(calls.map((c) => c.args[1])).toEqual(["remove", "add"]);
    expect(calls[0]?.bin).toBe("claude");
    expect(calls[1]?.args).toEqual(spec.addArgs(SERVER_NAME, pkgSpec));
  });

  it("still runs add when the best-effort remove fails (not yet registered)", () => {
    const seen: string[] = [];
    const client = cliClient(spec, {
      run: (_bin, args) => {
        seen.push(String(args[1]));
        if (args[1] === "remove") throw new Error("not found");
      },
    });

    client.register(pkgSpec);

    expect(seen).toEqual(["remove", "add"]);
  });

  it("throws when the add step fails", () => {
    const client = cliClient(spec, {
      run: (_bin, args) => {
        if (args[1] === "add") throw new Error("add failed");
      },
    });

    expect(() => client.register(pkgSpec)).toThrow("add failed");
  });

  it("detect() uses the injected predicate", () => {
    expect(cliClient(spec, { detect: () => true }).detect()).toBe(true);
    expect(cliClient(spec, { detect: () => false }).detect()).toBe(false);
  });

  it("manualHint() is the copy-pasteable add command", () => {
    const hint = cliClient(spec).manualHint(pkgSpec);
    expect(hint).toBe(`claude ${spec.addArgs(SERVER_NAME, pkgSpec).join(" ")}`);
  });
});

describe("jsonFileClient", () => {
  const pkgSpec = INSTALLED_BIN;

  it("writes our merged entry to the resolved config path", () => {
    const configPath = path.join(tmpDir, "cursor", "mcp.json");
    const client = jsonFileClient({
      id: "cursor",
      label: "Cursor",
      configPath: () => configPath,
      detect: () => true,
    });

    client.register(pkgSpec);

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.mcpServers[SERVER_NAME]).toEqual({
      command: pkgSpec,
      args: [],
    });
  });

  it("preserves other servers already in the file", () => {
    const configPath = path.join(tmpDir, "mcp.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }),
    );
    const client = jsonFileClient({
      id: "cursor",
      label: "Cursor",
      configPath: () => configPath,
      detect: () => true,
    });

    client.register(pkgSpec);

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.mcpServers.other).toEqual({ command: "x", args: [] });
    expect(config.mcpServers[SERVER_NAME]).toBeDefined();
  });

  it("throws when the platform has no config path", () => {
    const client = jsonFileClient({
      id: "claude-desktop",
      label: "Claude Desktop",
      configPath: () => null,
      detect: () => false,
    });
    expect(() => client.register(pkgSpec)).toThrow();
  });
});

describe("config path resolvers", () => {
  it("claudeDesktopConfigPath resolves per platform", () => {
    expect(claudeDesktopConfigPath("darwin", "/home/x")).toContain(
      path.join("Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );
    expect(claudeDesktopConfigPath("linux", "/home/x")).toBe(
      path.join("/home/x", ".config", "Claude", "claude_desktop_config.json"),
    );
    expect(claudeDesktopConfigPath("freebsd", "/home/x")).toBeNull();
  });

  it("cursorConfigPath is ~/.cursor/mcp.json on every platform", () => {
    expect(cursorConfigPath("darwin", "/home/x")).toBe(path.join("/home/x", ".cursor", "mcp.json"));
    expect(cursorConfigPath("win32", "C:\\Users\\x")).toBe(
      path.join("C:\\Users\\x", ".cursor", "mcp.json"),
    );
  });
});

describe("dirExists", () => {
  it("is true for an existing directory, false otherwise", () => {
    expect(dirExists(tmpDir)).toBe(true);
    expect(dirExists(path.join(tmpDir, "nope"))).toBe(false);
  });

  it("is false for a file (not a directory)", () => {
    const file = path.join(tmpDir, "f");
    fs.writeFileSync(file, "");
    expect(dirExists(file)).toBe(false);
  });
});

describe("getClients", () => {
  it("returns the five supported clients in a stable order", () => {
    const ids = getClients().map((c) => c.id);
    expect(ids).toEqual(["claude-code", "claude-desktop", "cursor", "codex", "gemini"]);
  });

  it("every client exposes detect/register/manualHint", () => {
    for (const c of getClients()) {
      expect(typeof c.detect).toBe("function");
      expect(typeof c.register).toBe("function");
      expect(typeof c.manualHint).toBe("function");
      expect(c.label.length).toBeGreaterThan(0);
    }
  });
});

describe("renderChecklistLines", () => {
  const items = [
    { label: "Claude Code", checked: true, detected: true },
    { label: "Codex", checked: false, detected: false },
  ];

  it("marks the cursor row, the checkbox state, and detection tag", () => {
    const lines = renderChecklistLines(items, 0);
    expect(lines[0]).toBe("❯ ◼  Claude Code      found");
    expect(lines[1]).toBe("  ◻  Codex        not found");
  });

  it("moves the cursor marker to the selected row", () => {
    const lines = renderChecklistLines(items, 1);
    expect(lines[0]?.startsWith("  ")).toBe(true);
    expect(lines[1]?.startsWith("❯ ")).toBe(true);
  });

  it("right-aligns found/not-found into a single column", () => {
    const lines = renderChecklistLines(items, 0);
    expect(lines[0]?.length).toBe(lines[1]?.length);
    expect(lines[0]?.endsWith("    found")).toBe(true);
    expect(lines[1]?.endsWith("not found")).toBe(true);
  });
});

describe("renderConfirmLine", () => {
  it("shows the count and pluralizes", () => {
    expect(renderConfirmLine(3, false)).toBe("     [ Configure 3 agents ]");
    expect(renderConfirmLine(1, false)).toBe("     [ Configure 1 agent ]");
  });

  it("marks the row when selected", () => {
    expect(renderConfirmLine(2, true)).toBe("❯    [ Configure 2 agents ]");
  });

  it("lines the confirm text up with the client labels above it", () => {
    const label = renderChecklistLines([{ label: "X", checked: false, detected: true }], -1);
    const confirm = renderConfirmLine(1, false);
    // Both start their text at the same column: marker + glyph + gap.
    expect(label[0]?.indexOf("X")).toBe(confirm.indexOf("["));
  });
});

describe("selectClients", () => {
  it("non-TTY: auto-selects only the detected clients (no UI)", async () => {
    const chosen = await selectClients([stubClient("a", true), stubClient("b", false)], {
      isTTY: false,
    });
    expect(chosen?.map((c) => c.id)).toEqual(["a"]);
  });

  it("interactive: space/enter toggle the focused row; the Confirm row finishes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    // alpha starts checked (detected); beta starts unchecked.
    const clients = [stubClient("alpha", true), stubClient("beta", false)];
    const pending = selectClients(clients, { input, output, isTTY: true });

    input.write(" "); // space toggles alpha OFF (cursor 0)
    input.write("\x1b[B"); // -> beta (cursor 1)
    input.write("\r"); // enter toggles beta ON (does NOT confirm)
    input.write("\x1b[B"); // -> Confirm row (cursor 2)
    input.write("\r"); // enter on the Confirm row confirms
    const chosen = await pending;
    expect(chosen?.map((c) => c.id)).toEqual(["beta"]);
  });

  it("interactive: navigating to the Confirm row and pressing space confirms", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const clients = [stubClient("alpha", true), stubClient("beta", false)];
    const pending = selectClients(clients, { input, output, isTTY: true });

    input.write("\x1b[B"); // cursor 0 (alpha) -> 1 (beta)
    input.write("\x1b[B"); // -> 2 (Confirm row)
    input.write(" "); // space on the Confirm row confirms
    const chosen = await pending;
    expect(chosen?.map((c) => c.id)).toEqual(["alpha"]); // alpha stayed ticked, beta not
  });

  it("interactive: Ctrl-C cancels and returns null", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = selectClients([stubClient("alpha", true)], { input, output, isTTY: true });
    input.write("\x03"); // Ctrl-C
    expect(await pending).toBeNull();
  });
});

describe("jsonFileClient — preserving an existing config", () => {
  const pkgSpec = INSTALLED_BIN;

  const clientFor = (configPath: string) =>
    jsonFileClient({
      id: "cursor",
      label: "Cursor",
      configPath: () => configPath,
      detect: () => true,
    });

  it("refuses to register rather than replacing a config it cannot parse", () => {
    // Treating a parse error as "empty config" turns one bad byte into a wipe of
    // every setting the user has — MCP servers, and whatever else the client keeps
    // in the same file. Refusing leaves the file untouched and tells them why.
    const configPath = path.join(tmpDir, "cursor", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{ "mcpServers": { broken');

    expect(() => clientFor(configPath).register(pkgSpec)).toThrow(/could not be parsed/i);
    expect(fs.readFileSync(configPath, "utf-8")).toBe('{ "mcpServers": { broken');
  });

  it("refuses to register rather than replacing a config it cannot read", () => {
    const configPath = path.join(tmpDir, "cursor", "unreadable.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{}");
    fs.chmodSync(configPath, 0o000);

    try {
      expect(() => clientFor(configPath).register(pkgSpec)).toThrow();
    } finally {
      fs.chmodSync(configPath, 0o600);
    }
  });

  it("still treats a missing config as empty and creates it", () => {
    const configPath = path.join(tmpDir, "cursor", "fresh.json");

    clientFor(configPath).register(pkgSpec);

    expect(JSON.parse(fs.readFileSync(configPath, "utf-8")).mcpServers[SERVER_NAME]).toBeDefined();
  });

  it("keeps a JSON null config from being treated as an object", () => {
    const configPath = path.join(tmpDir, "cursor", "null.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "null");

    clientFor(configPath).register(pkgSpec);

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.mcpServers[SERVER_NAME]).toBeDefined();
  });

  it("preserves unrelated top-level keys and other servers", () => {
    const configPath = path.join(tmpDir, "cursor", "rich.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        theme: "dark",
        mcpServers: { other: { command: "other-bin", args: [] } },
      }),
    );

    clientFor(configPath).register(pkgSpec);

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.theme).toBe("dark");
    expect(config.mcpServers.other).toEqual({ command: "other-bin", args: [] });
    expect(config.mcpServers[SERVER_NAME]).toBeDefined();
  });

  it("does not change the mode of a config file it did not create", () => {
    const configPath = path.join(tmpDir, "cursor", "moded.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{}");
    fs.chmodSync(configPath, 0o644);

    clientFor(configPath).register(pkgSpec);

    expect(fs.statSync(configPath).mode & 0o777).toBe(0o644);
  });

  it("leaves no temp file beside the config", () => {
    const configPath = path.join(tmpDir, "cursor", "tidy.json");

    clientFor(configPath).register(pkgSpec);

    expect(fs.readdirSync(path.dirname(configPath))).toEqual(["tidy.json"]);
  });
});
