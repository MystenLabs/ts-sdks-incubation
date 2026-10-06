import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runConfigure } from "../bin/configure.js";
import { runInstall } from "../bin/install.js";
import { BOOLEAN_FLAGS, VALUE_FLAGS } from "../src/cliArgs.js";
import { loadConfigFile } from "../src/configFile.js";
import { CONFIG_USAGE, INSTALL_USAGE, ROOT_USAGE, isHelpFlag, wantsHelp } from "../src/usage.js";

/**
 * COMG-1036 item 2: `config --help` and `install --help` answered "Unknown
 * flag: --help", so there was no way to find out what either command takes.
 *
 * The drift guard matters more than the wording: a flag the parser accepts but
 * the usage screen never mentions is a flag nobody can find, and `parseArgs`
 * has grown one nearly every time this CLI has been touched.
 */

const captureStdout = (): { text: () => string; restore: () => void } => {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
};

describe("isHelpFlag / wantsHelp", () => {
  it("takes both spellings, anywhere in the arguments", () => {
    expect(isHelpFlag("--help")).toBe(true);
    expect(isHelpFlag("-h")).toBe(true);
    expect(isHelpFlag("--helpful")).toBe(false);
    expect(wantsHelp(["--api-key", "hbr_x", "--help"])).toBe(true);
    expect(wantsHelp(["--silent"])).toBe(false);
  });
});

describe("usage screens document every flag the parser takes", () => {
  const VALUE_FLAG_NAMES = Object.keys(VALUE_FLAGS);

  it("install", () => {
    for (const flag of [...VALUE_FLAG_NAMES, "--allowed-dirs", ...BOOLEAN_FLAGS]) {
      expect(INSTALL_USAGE).toContain(flag);
    }
    expect(INSTALL_USAGE).toContain("--help");
  });

  it("config", () => {
    // Every boolean flag except the one `config` has no step for. Spelled as an
    // exclusion rather than a list, so a new boolean flag fails this test until
    // someone decides which verbs it belongs to.
    const forConfig = BOOLEAN_FLAGS.filter((flag) => flag !== "--no-register");
    for (const flag of [...VALUE_FLAG_NAMES, "--allowed-dirs", ...forConfig]) {
      expect(CONFIG_USAGE).toContain(flag);
    }
    expect(CONFIG_USAGE).toContain("--help");
  });

  // `config` has no registration step at all, so offering the flag that turns
  // one off would be describing a command that does not exist.
  it("config does not offer --no-register", () => {
    expect(CONFIG_USAGE).not.toContain("--no-register");
  });

  it("names every environment variable the silent path reads", () => {
    for (const name of [
      "CONSOLE_CREDENTIAL_BUNDLE",
      "CONSOLE_API_KEY",
      "CONSOLE_SERVICE_PRIVATE_KEY",
      "CONSOLE_ADMIN_KEY",
      "CONSOLE_ADMIN_SERVICE_PRIVATE_KEY",
      "CONSOLE_MCP_ALLOWED_DIRS",
    ]) {
      expect(INSTALL_USAGE).toContain(name);
      expect(CONFIG_USAGE).toContain(name);
    }
  });

  it("gives one runnable example per command", () => {
    expect(INSTALL_USAGE).toContain("walrus-console-mcp install --allowed-dirs");
    expect(CONFIG_USAGE).toContain("walrus-console-mcp config --silent --allowed-dirs");
  });

  // 80 columns is the narrowest terminal this CLI already draws for
  // (see panelWidth). A usage screen that wraps is the thing being fixed
  // elsewhere in this change, not something to reintroduce here.
  it("fits 80 columns", () => {
    for (const screen of [INSTALL_USAGE, CONFIG_USAGE, ROOT_USAGE]) {
      for (const line of screen.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it("the bare command points at both verbs", () => {
    expect(ROOT_USAGE).toContain("walrus-console-mcp install");
    expect(ROOT_USAGE).toContain("walrus-console-mcp config");
  });

  // The one root-level flag. bin/console-mcp.ts reads it by hand, not through
  // parseArgs, so the flag-table checks above never see it.
  it("the bare command documents --import-bundle", () => {
    expect(ROOT_USAGE).toContain("walrus-console-mcp --import-bundle <base64url>");
  });

  // Read as text rather than imported: importing bin/console-mcp.ts runs it top
  // to bottom, which connects the stdio transport and starts the server (the
  // same reason tests/manifestSync.test.ts reads that file as source).
  //
  // The branch, not the identifier. Matching a bare `ROOT_USAGE` is satisfied by
  // the import statement alone, so it held with the whole branch deleted.
  it("the entry point answers a bare --help before it starts the server", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "bin", "console-mcp.ts"), "utf-8");
    const branch = /isHelpFlag\(process\.argv\[2\][\s\S]{0,300}?ROOT_USAGE/.exec(src);
    const transport = src.indexOf("StdioServerTransport(");
    expect(branch).not.toBeNull();
    expect(transport).toBeGreaterThan(-1);
    expect(branch?.index ?? -1).toBeLessThan(transport);
  });
});

describe("--help on the commands themselves", () => {
  let tmpDir: string;
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-usage-test-"));
    envBackup = { ...process.env };
    process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("CONSOLE_")) delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = envBackup;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("install --help prints usage instead of refusing the flag", async () => {
    const capture = captureStdout();
    try {
      await runInstall(["--help"]);
    } finally {
      capture.restore();
    }
    const out = capture.text();
    expect(out).not.toContain("Unknown flag");
    expect(out).toContain("walrus-console-mcp install [flags]");
    expect(loadConfigFile()).toEqual({});
  });

  // The only proof that the bare command does not sit on stdio waiting for
  // JSON-RPC. It needs the built entry, which CI produces (Build runs before
  // Test); locally it skips unless you have run `pnpm build`, and the source
  // assertion above covers the wiring either way.
  const BUILT_ENTRY = path.join(__dirname, "..", "dist", "console-mcp.js");
  it.skipIf(!fs.existsSync(BUILT_ENTRY))(
    "a bare --help exits instead of waiting on stdio",
    () => {
      const result = spawnSync(process.execPath, [BUILT_ENTRY, "--help"], {
        encoding: "utf-8",
        // A hang is the failure this test exists for, so it has to be bounded.
        // Without the branch the process holds stdin open and is killed here.
        // Generous, because this spawn shares a machine with the rest of a
        // parallel run: 1.5s alone, but it timed out at 15s under contention.
        timeout: 60_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("walrus-console-mcp install");
    },
    30_000,
  );

  // `takeValue` in src/cliArgs.ts consumes any next token that does not start
  // with `--`, so `-h` is a legal value position. Reading it as help there would
  // turn a bad folder into a successful no-op.
  it("a help flag in a value position stays the error it was", async () => {
    const capture = captureStdout();
    try {
      await runInstall(["--allowed-dirs", "-h"]).catch(() => undefined);
    } finally {
      capture.restore();
    }
    const out = capture.text();
    expect(out).not.toContain("walrus-console-mcp install [flags]");
    expect(out).toContain("-h");
  });

  it("config --help prints usage and returns 0", async () => {
    const capture = captureStdout();
    let code: number;
    try {
      code = await runConfigure(["--help"]);
    } finally {
      capture.restore();
    }
    expect(code).toBe(0);
    expect(capture.text()).not.toContain("Unknown flag");
    expect(capture.text()).toContain("walrus-console-mcp config [flags]");
  });

  // Help writes nothing, so there is no half-applied command to reason about:
  // it wins over the other arguments rather than competing with them.
  it("help wins over a credential flag, and nothing is written", async () => {
    const capture = captureStdout();
    let code: number;
    try {
      code = await runConfigure(["--api-key", "hbr_would_be_saved", "--help"]);
    } finally {
      capture.restore();
    }
    expect(code).toBe(0);
    expect(capture.text()).toContain("walrus-console-mcp config [flags]");
    expect(loadConfigFile()).toEqual({});
  });
});
