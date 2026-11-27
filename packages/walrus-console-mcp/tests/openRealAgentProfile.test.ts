import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { installProfile, repository } from "./helpers/installProfile.js";

it("Claude existing-login mode preserves authentication environment and isolates only its MCP server", () => {
  const profile = installProfile();
  const normal = fs.mkdtempSync(path.join(os.tmpdir(), "claude normal profile "));
  try {
    const isolation = Object.fromEntries(
      [
        "HOME",
        "USERPROFILE",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
      ].map((key) => [key, profile.env[key]]),
    );
    fs.writeFileSync(path.join(profile.root, "profile-env.json"), JSON.stringify(isolation));
    fs.mkdirSync(path.join(profile.root, ".cursor"));
    fs.writeFileSync(
      path.join(profile.root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "walrus-console-mcp": { command: profile.launcher, args: [] },
          unrelated: { command: "must-not-load" },
        },
      }),
    );
    const normalConfig = path.join(normal, "config.json");
    fs.writeFileSync(normalConfig, "normal config untouched");
    const resultFile = path.join(profile.root, "record.json");
    profile.executable(
      "claude",
      `const fs=require('node:fs'); const args=process.argv.slice(2);
const config=args.includes('--mcp-config') ? JSON.parse(args[args.indexOf('--mcp-config')+1]) : null;
fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({args,config,home:process.env.HOME,authDir:process.env.CLAUDE_CONFIG_DIR,consoleKey:process.env.CONSOLE_API_KEY}));`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../scripts/open-real-agent-profile.mts", import.meta.url)),
        profile.root,
        "claude",
        "--existing-login",
      ],
      {
        cwd: repository,
        env: {
          ...process.env,
          PATH: profile.env["PATH"],
          HOME: normal,
          CLAUDE_CONFIG_DIR: path.join(normal, "auth"),
          CONSOLE_API_KEY: "fixture-must-not-inherit",
        },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const recorded = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    expect(recorded.home).toBe(normal);
    expect(recorded.authDir).toBe(path.join(normal, "auth"));
    expect(recorded.consoleKey).toBeUndefined();
    expect(recorded.args).toContain("--strict-mcp-config");
    expect(recorded.config).toEqual({
      mcpServers: {
        "walrus-console-mcp": {
          command: profile.launcher,
          args: [],
          env: isolation,
        },
      },
    });
    expect(fs.readFileSync(normalConfig, "utf8")).toBe("normal config untouched");
  } finally {
    profile.cleanup();
    fs.rmSync(normal, { recursive: true, force: true });
  }
});

it("Codex explicitly passes the scratch config path to its MCP child", () => {
  const profile = installProfile();
  try {
    const isolation = {
      HOME: profile.root,
      XDG_CONFIG_HOME: path.join(profile.root, "config"),
      CODEX_HOME: path.join(profile.root, ".codex"),
    };
    fs.writeFileSync(path.join(profile.root, "profile-env.json"), JSON.stringify(isolation));
    const record = path.join(profile.root, "codex-args.json");
    profile.executable(
      "codex",
      `require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify(process.argv.slice(2)));`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../scripts/open-real-agent-profile.mts", import.meta.url)),
        profile.root,
        "codex",
      ],
      {
        cwd: repository,
        env: profile.env,
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const args = JSON.parse(fs.readFileSync(record, "utf8"));
    expect(args).toContain("-c");
    expect(args).toContain(
      `mcp_servers.walrus-console-mcp.env.XDG_CONFIG_HOME=${JSON.stringify(path.join(profile.root, "config"))}`,
    );
    expect(args).toContain(
      `mcp_servers.walrus-console-mcp.env.HOME=${JSON.stringify(profile.root)}`,
    );
    expect(fs.existsSync(path.join(profile.root, ".codex", "config.toml"))).toBe(false);
  } finally {
    profile.cleanup();
  }
});

it("Cursor repairs a legacy scratch command before opening the isolated window", () => {
  const profile = installProfile();
  try {
    const isolation = { HOME: profile.root, XDG_CONFIG_HOME: path.join(profile.root, "config") };
    fs.writeFileSync(path.join(profile.root, "profile-env.json"), JSON.stringify(isolation));
    fs.mkdirSync(path.join(profile.root, ".cursor"));
    const configPath = path.join(profile.root, ".cursor", "mcp.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        extra: "preserve",
        mcpServers: {
          "walrus-console-mcp": { command: profile.launcher, args: [], disabled: false },
          other: { command: "untouched", args: ["keep"] },
        },
      }),
    );
    const record = path.join(profile.root, "cursor-args.json");
    profile.executable(
      "cursor",
      `require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify(process.argv.slice(2)));`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../scripts/open-real-agent-profile.mts", import.meta.url)),
        profile.root,
        "cursor",
      ],
      {
        cwd: repository,
        env: profile.env,
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
      extra: "preserve",
      mcpServers: {
        "walrus-console-mcp": {
          command: profile.launcher,
          args: ["--stdio"],
          disabled: false,
          env: isolation,
        },
        other: { command: "untouched", args: ["keep"] },
      },
    });
    expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual([
      "--new-window",
      "--user-data-dir",
      path.join(profile.root, "cursor-ui"),
      profile.allowed,
    ]);
  } finally {
    profile.cleanup();
  }
});
