import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  antigravityClient,
  antigravityConfigPath,
  CLI_CLIENT_SPECS,
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
});

describe("config path resolvers", () => {
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
    expect(ids).toEqual(["claude-code", "cursor", "codex", "gemini", "antigravity"]);
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
  // The same zero-columns pty case tests/tui.test.ts covers for selectOne: both
  // selectors read `process.stdout.columns` themselves, and both read it the
  // same wrong way. Fixing one and not the other would leave the Register step
  // unframed in the run whose earlier steps frame.
  it("frames on a terminal that reports zero columns", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: 0, configurable: true });
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    try {
      const input = new PassThrough();
      const pending = selectClients([stubClient("alpha", true)], {
        input,
        output,
        isTTY: true,
        title: "REGISTER",
      });
      // Ctrl-C, not esc: a lone escape byte sits in readline's 500 ms
      // ESCAPE_CODE_TIMEOUT before it is delivered, and this test only needs
      // the first render to have happened.
      input.write("\x03");
      await pending;
      expect(chunks.join("")).toContain("\u256d");
    } finally {
      if (original) Object.defineProperty(process.stdout, "columns", original);
      else delete (process.stdout as { columns?: number }).columns;
    }
  });

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

  // COMG-1133: the rendered REGISTER panel, not just the registry ids — this is
  // what the user sees.
  it("interactive: the real registry renders five rows and no Claude Desktop", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    // Real ids and labels, stubbed detection: the host's PATH and ~/.cursor
    // must not decide what this test renders.
    const clients = getClients().map((c) => ({ ...c, detect: () => false }));
    const pending = selectClients(clients, { input, output, isTTY: true });
    input.write("\x03"); // Ctrl-C cancels once the first frame is drawn
    await pending;
    const text = chunks.join("");
    for (const label of ["Claude Code", "Cursor", "Codex", "Gemini", "Antigravity"]) {
      expect(text).toContain(label);
    }
    expect(text).not.toContain("Claude Desktop");
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
    // Inject a read that fails with EACCES so the case is deterministic on every
    // platform. A chmod 000 file is still readable as root and on Windows, which
    // made this test silently pass without exercising the refusal.
    const configPath = path.join(tmpDir, "cursor", "unreadable.json");
    const eacces = Object.assign(new Error("EACCES: permission denied, open"), {
      code: "EACCES",
    });
    const client = jsonFileClient({
      id: "cursor",
      label: "Cursor",
      configPath: () => configPath,
      detect: () => true,
      readFile: () => {
        throw eacces;
      },
    });

    expect(() => client.register(pkgSpec)).toThrow(/could not be read/i);
  });

  it("still treats a missing config as empty and creates it", () => {
    const configPath = path.join(tmpDir, "cursor", "fresh.json");

    clientFor(configPath).register(pkgSpec);

    expect(JSON.parse(fs.readFileSync(configPath, "utf-8")).mcpServers[SERVER_NAME]).toBeDefined();
  });

  it.each([null, [], 42, "text", true].map((value) => ({ value })))(
    "refuses a non-object config $value without changing bytes",
    ({ value }) => {
      const configPath = path.join(tmpDir, "cursor", "null.json");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const raw = `  ${JSON.stringify(value)}\n`;
      fs.writeFileSync(configPath, raw);

      expect(() => clientFor(configPath).register(pkgSpec)).toThrow(/top-level.*not an object/i);
      expect(fs.readFileSync(configPath, "utf-8")).toBe(raw);
    },
  );

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

describe("antigravityConfigPath", () => {
  it("is ~/.gemini/config/mcp_config.json on every platform", () => {
    expect(antigravityConfigPath("/Users/x")).toBe(
      path.join("/Users/x", ".gemini", "config", "mcp_config.json"),
    );
    expect(antigravityConfigPath("C:\\Users\\x")).toBe(
      path.join("C:\\Users\\x", ".gemini", "config", "mcp_config.json"),
    );
  });
});

describe("antigravityClient", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(tmpDir, "home-"));
  });
  const client = (hasAgy = false) => antigravityClient({ home, hasAgy: () => hasAgy });
  const cfgDir = () => path.join(home, ".gemini", "config");
  const cfgFile = () => antigravityConfigPath(home);
  const markMigrated = () => {
    fs.mkdirSync(cfgDir(), { recursive: true });
    fs.writeFileSync(path.join(cfgDir(), ".migrated"), "");
  };

  it("has the id, label and a nextStep naming both surfaces", () => {
    const c = client();
    expect(c.id).toBe("antigravity");
    expect(c.label).toBe("Antigravity");
    expect(c.nextStep).toContain("/mcp");
    expect(c.nextStep).toContain("Installed MCP Servers");
  });

  describe("detect", () => {
    it.each(["antigravity", "antigravity-cli", "antigravity-ide"])(
      "is found when ~/.gemini/%s is a directory",
      (dir) => {
        fs.mkdirSync(path.join(home, ".gemini", dir), { recursive: true });
        expect(client().detect()).toBe(true);
      },
    );

    it("is found when agy is on PATH", () => {
      expect(client(true).detect()).toBe(true);
    });

    it("is not found for ~/.gemini alone (Gemini CLI uses it)", () => {
      fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
      expect(client().detect()).toBe(false);
    });

    it("is not found for ~/.gemini/config alone", () => {
      fs.mkdirSync(cfgDir(), { recursive: true });
      expect(client().detect()).toBe(false);
    });

    it("is not found when ~/.gemini/antigravity is a file", () => {
      fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
      fs.writeFileSync(path.join(home, ".gemini", "antigravity"), "");
      expect(client().detect()).toBe(false);
    });
  });

  describe("register", () => {
    it("refuses before the first-start migration and creates nothing", () => {
      expect(() => client().register(INSTALLED_BIN)).toThrow(
        /hasn't finished its first start.*\.migrated/s,
      );
      expect(fs.existsSync(path.join(home, ".gemini"))).toBe(false);
    });

    it("refuses without touching an existing config when .migrated is missing", () => {
      fs.mkdirSync(cfgDir(), { recursive: true });
      fs.writeFileSync(cfgFile(), '{"mcpServers":{}}');
      expect(() => client().register(INSTALLED_BIN)).toThrow(/first start/);
      expect(fs.readFileSync(cfgFile(), "utf-8")).toBe('{"mcpServers":{}}');
      expect(fs.readdirSync(cfgDir())).toEqual(["mcp_config.json"]);
    });

    it("writes {command, args: []} once migrated", () => {
      markMigrated();
      client().register(INSTALLED_BIN);
      expect(JSON.parse(fs.readFileSync(cfgFile(), "utf-8"))).toEqual({
        mcpServers: { [SERVER_NAME]: { command: INSTALLED_BIN, args: [] } },
      });
    });

    it("preserves other servers and unknown keys at both levels", () => {
      markMigrated();
      fs.writeFileSync(
        cfgFile(),
        JSON.stringify({
          topLevel: { keep: 1 },
          mcpServers: {
            other: { command: "o", args: ["x"], env: { A: "1" } },
            [SERVER_NAME]: { command: "old", args: ["a"], extra: true },
          },
        }),
      );
      client().register(INSTALLED_BIN);
      const cfg = JSON.parse(fs.readFileSync(cfgFile(), "utf-8"));
      expect(cfg.topLevel).toEqual({ keep: 1 });
      expect(cfg.mcpServers.other).toEqual({ command: "o", args: ["x"], env: { A: "1" } });
      expect(cfg.mcpServers[SERVER_NAME].command).toBe(INSTALLED_BIN);
      expect(cfg.mcpServers[SERVER_NAME].args).toEqual([]);
    });

    it("refuses invalid JSON and leaves the file untouched", () => {
      markMigrated();
      fs.writeFileSync(cfgFile(), "{ not json");
      expect(() => client().register(INSTALLED_BIN)).toThrow(/could not be parsed/);
      expect(fs.readFileSync(cfgFile(), "utf-8")).toBe("{ not json");
    });

    it("manualHint names the shared config path once migrated", () => {
      markMigrated();
      expect(client().manualHint(INSTALLED_BIN)).toContain(cfgFile());
    });

    // The installer prints manualHint right after a refused register. Before the
    // first-start migration, a hand-written entry is dropped just like ours, so
    // the hint must not invite one.
    it("manualHint says to start Antigravity first, not to edit the file, before migration", () => {
      const hint = client().manualHint(INSTALLED_BIN);
      expect(hint).not.toContain(cfgFile());
      expect(hint).toMatch(/run `agy` once/);
      expect(hint).toMatch(/re-run/);
    });

    it("refuses a non-object mcpServers instead of spreading it", () => {
      markMigrated();
      fs.writeFileSync(cfgFile(), '{"mcpServers":"abc","x":1}');
      expect(() => client().register(INSTALLED_BIN)).toThrow(/mcpServers/);
      expect(fs.readFileSync(cfgFile(), "utf-8")).toBe('{"mcpServers":"abc","x":1}');
    });
  });
});
