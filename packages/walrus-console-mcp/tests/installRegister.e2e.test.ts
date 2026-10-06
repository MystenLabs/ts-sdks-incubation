import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stepRegister } from "../bin/install.js";
import { cliClient } from "../src/clients.js";
import { loadConfigFile, mergeConfigFile } from "../src/configFile.js";
import { serverBinPath } from "../src/installDir.js";
import { type CommandInvocation, commandInvocation } from "../src/spawnCommand.js";

/**
 * Spread into execFileSync's options: @types/node omits windowsVerbatimArguments
 * there, though Node forwards it to spawnSync.
 */
const verbatim = (inv: CommandInvocation) =>
  inv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {};

/**
 * Step 4/4 of the installer, for real: npm installs a package into the private
 * root, and the resulting launcher is registered with an agent through that
 * agent's own CLI. Only the package (a local stub tarball) and the agent (a
 * recorder) are fake — every subprocess runs through the same spawn path users
 * get. On Windows both npm and the agent are `.cmd` batch files, which a bare
 * `execFileSync(name)` cannot spawn, so this runs on the Windows CI job as well
 * as Linux.
 *
 * The temp root carries a space on purpose: `C:\Users\<first> <last>\…` is an
 * ordinary Windows profile path, and a shell-joined command line splits on it.
 */

const isWindows = process.platform === "win32";

let root: string;
const savedEnv: Record<string, string | undefined> = {};

const setEnv = (key: string, value: string) => {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "walrus install e2e "));
  // Keep every write inside the temp root: the install root, the config file,
  // and the agent's PATH entry.
  setEnv("LOCALAPPDATA", path.join(root, "local"));
  setEnv("XDG_DATA_HOME", path.join(root, "local"));
  setEnv("APPDATA", path.join(root, "roaming"));
  setEnv("XDG_CONFIG_HOME", path.join(root, "roaming"));
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** A publishable stub whose bin is named like the real one and prints a marker. */
function packStub(): string {
  const pkgDir = path.join(root, "stub pkg");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: "walrus-console-mcp-stub",
      version: "1.0.0",
      bin: { "walrus-console-mcp": "cli.js" },
    }),
  );
  fs.writeFileSync(path.join(pkgDir, "cli.js"), '#!/usr/bin/env node\nconsole.log("stub-ok");\n');

  const dest = path.join(root, "packs");
  fs.mkdirSync(dest, { recursive: true });
  const inv = commandInvocation("npm", ["pack", pkgDir, "--pack-destination", dest, "--silent"]);
  execFileSync(inv.file, inv.args, { stdio: "ignore", ...verbatim(inv) });
  return path.join(dest, "walrus-console-mcp-stub-1.0.0.tgz");
}

/** An agent CLI on PATH that appends each invocation's argv to a log. */
function installFakeAgent(): string {
  const binDir = path.join(root, "agent bin");
  const log = path.join(root, "agent.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "record.cjs"),
    `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
  );
  if (isWindows) {
    // npm's own shim shape, which is what `codex`/`gemini`/`claude` are there.
    fs.writeFileSync(path.join(binDir, "fakeagent.cmd"), '@node "%~dp0\\record.cjs" %*\r\n');
  } else {
    const script = path.join(binDir, "fakeagent");
    fs.writeFileSync(script, `#!/bin/sh\nexec node "$(dirname "$0")/record.cjs" "$@"\n`);
    fs.chmodSync(script, 0o755);
  }
  setEnv("PATH", `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`);
  return log;
}

describe("installer step 4/4, end to end", () => {
  it("installs with npm and registers the launcher through the agent's CLI", async () => {
    const spec = packStub();
    const log = installFakeAgent();
    const agent = cliClient({
      id: "fakeagent",
      label: "Fake agent",
      bin: "fakeagent",
      addArgs: (name, command) => ["mcp", "add", name, "--", command],
      removeArgs: (name) => ["mcp", "remove", name],
    });

    const result = await stepRegister(spec, { select: async () => [agent] });

    expect(result).toEqual({ outcome: "installed", configured: 1 });

    const launcher = serverBinPath(path.join(root, "local", "walrus-console-mcp"));
    expect(fs.existsSync(launcher)).toBe(true);

    // Remove first (idempotency), then add — with the launcher path intact, space and all.
    const calls = fs
      .readFileSync(log, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    expect(calls).toEqual([
      ["mcp", "remove", "walrus-console-mcp"],
      ["mcp", "add", "walrus-console-mcp", "--", launcher],
    ]);

    // The registered command actually starts.
    const run = commandInvocation(launcher, []);
    const out = execFileSync(run.file, run.args, { encoding: "utf-8", ...verbatim(run) });
    expect(out.trim()).toBe("stub-ok");
  }, 180_000);

  it("saves and then re-saves the config file", () => {
    // The second merge renames over an existing config.json, which Windows can
    // refuse with EPERM while another process holds the file.
    const allowed = fs.mkdtempSync(path.join(root, "allowed "));
    mergeConfigFile({ allowedDirs: [allowed] });
    mergeConfigFile({ allowedDirs: [allowed, root] });

    expect(loadConfigFile().allowedDirs).toEqual([allowed, root]);
  });
});
