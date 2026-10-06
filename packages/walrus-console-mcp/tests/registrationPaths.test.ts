import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const fixtures = fileURLToPath(new URL("./fixtures/pr90/", import.meta.url));
const runner = path.join(fixtures, "register-path.mts");
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-registration-paths-"));
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(home, ".gemini", "config"), { recursive: true });
  fs.mkdirSync(path.join(home, ".gemini", "antigravity"), { recursive: true });
  fs.writeFileSync(path.join(home, ".gemini", "config", ".migrated"), "");
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const configPath = (id: string) =>
  path.join(
    home,
    ...(id === "cursor" ? [".cursor", "mcp.json"] : [".gemini", "config", "mcp_config.json"]),
  );
const seed = (id: string) => {
  const raw = fs.readFileSync(path.join(fixtures, `${id}.json`), "utf-8");
  fs.writeFileSync(configPath(id), raw);
  return JSON.parse(raw);
};
const launcher = () => path.join(home, "private-install", "walrus-console-mcp");
function run(id: string, action = "direct") {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("CONSOLE_")),
  );
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", runner, id, action, launcher()],
    {
      env: {
        ...env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, "config"),
        APPDATA: path.join(home, "config"),
      },
      encoding: "utf-8",
      timeout: 15_000,
    },
  );
  const line = output.split("\n").find((entry) => entry.startsWith("PR90_RESULT="));
  if (!line) throw new Error(`Registration child returned no result: ${output}`);
  return { result: JSON.parse(line.slice("PR90_RESULT=".length)), output };
}

describe.each(["cursor", "antigravity"])("%s actual registry registration path", (id) => {
  it("preserves local/remote entries and unknown keys while replacing only Walrus", () => {
    const before = seed(id);
    const other = id === "cursor" ? "antigravity" : "cursor";
    seed(other);
    const untouched = fs.readFileSync(configPath(other), "utf-8");
    const { result } = run(id);
    expect(result).toEqual({ detected: true, problem: null });
    const after = JSON.parse(fs.readFileSync(configPath(id), "utf-8"));
    expect(after).toEqual({
      ...before,
      mcpServers: { ...before.mcpServers, "walrus-console-mcp": { command: launcher(), args: [] } },
    });
    expect(fs.readFileSync(configPath(other), "utf-8")).toBe(untouched);
    const once = fs.readFileSync(configPath(id), "utf-8");
    run(id);
    expect(fs.readFileSync(configPath(id), "utf-8")).toBe(once);
  });

  it.skipIf(process.platform === "win32")(
    "keeps a relative config symlink, writes its target and preserves mode",
    () => {
      const before = seed(id);
      const target = path.join(home, "dotfiles", `${id}.json`);
      fs.mkdirSync(path.dirname(target));
      fs.renameSync(configPath(id), target);
      fs.chmodSync(target, 0o640);
      const relativeTarget = path.relative(path.dirname(configPath(id)), target);
      fs.symlinkSync(relativeTarget, configPath(id));
      expect(run(id).result.error).toBeUndefined();
      expect(fs.lstatSync(configPath(id)).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(configPath(id))).toBe(relativeTarget);
      expect(fs.statSync(target).mode & 0o777).toBe(0o640);
      expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({
        ...before,
        mcpServers: {
          ...before.mcpServers,
          "walrus-console-mcp": { command: launcher(), args: [] },
        },
      });
    },
  );

  it.each([null, ["server"], "abc"])(
    "refuses malformed mcpServers %j without changing bytes",
    (servers) => {
      const raw = JSON.stringify({ mcpServers: servers, fixtureSettings: { keep: true } });
      fs.writeFileSync(configPath(id), raw);
      expect(run(id).result.error).toMatch(/mcpServers.*not an object/);
      expect(fs.readFileSync(configPath(id), "utf-8")).toBe(raw);
    },
  );

  it("refuses invalid JSON without changing bytes", () => {
    const raw = '{ "mcpServers": { "unfinished"';
    fs.writeFileSync(configPath(id), raw);
    expect(run(id).result.error).toMatch(/could not be parsed/);
    expect(fs.readFileSync(configPath(id), "utf-8")).toBe(raw);
  });

  it("reports configured only after the real entry can be read back", () => {
    seed(id);
    const { result, output } = run(id, "step");
    expect(result).toEqual({ outcome: "installed", configured: 1 });
    expect(output).toContain(`${id === "cursor" ? "Cursor" : "Antigravity"} configured`);
    if (id === "antigravity") expect(output).toMatch(/reload|refresh/i);
  });

  it("does not report success after a later selected client overwrites its entry", () => {
    seed(id);
    const { result, output } = run(id, "stale");
    expect(result).toEqual({ outcome: "installed", configured: 0 });
    expect(output).toContain(`${id === "cursor" ? "Cursor" : "Antigravity"} could not be verified`);
    expect(output).not.toContain(`${id === "cursor" ? "Cursor" : "Antigravity"} configured`);
    expect(
      JSON.parse(fs.readFileSync(configPath(id), "utf-8")).mcpServers["walrus-console-mcp"].command,
    ).toBe("/fixture/old-launcher");
  });

  it.each([null, ["unrecognized-content"], 42, "text", true].map((config) => ({ config })))(
    "refuses a non-object top-level config $config without changing bytes",
    ({ config }) => {
      const raw = `  ${JSON.stringify(config)}\n`;
      fs.writeFileSync(configPath(id), raw);
      expect(run(id).result.error).toMatch(/top-level.*not an object/);
      expect(fs.readFileSync(configPath(id), "utf-8")).toBe(raw);
    },
  );
});

it("Antigravity refuses before migration while the Cursor path remains usable", () => {
  seed("antigravity");
  const before = fs.readFileSync(configPath("antigravity"), "utf-8");
  fs.rmSync(path.join(home, ".gemini", "config", ".migrated"));
  expect(run("antigravity").result.error).toMatch(/migration|start|once/i);
  expect(fs.readFileSync(configPath("antigravity"), "utf-8")).toBe(before);
  seed("cursor");
  expect(run("cursor").result.error).toBeUndefined();
});
