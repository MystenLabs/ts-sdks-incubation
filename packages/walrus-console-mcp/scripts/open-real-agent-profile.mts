/** Open a real client using the profile retained by test-real-agent-install. */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { writeFileAtomic } from "../src/atomicWrite.js";
import { CURSOR_STDIO_ARGS } from "../src/clients.js";
import { commandInvocation } from "../src/spawnCommand.js";

const [root, client, mode] = process.argv.slice(2);
assert.ok(
  mode === undefined || (mode === "--existing-login" && client === "claude"),
  "--existing-login is supported for Claude only.",
);
assert.ok(
  root && client && ["claude", "codex", "agy", "cursor"].includes(client),
  "Usage: tsx scripts/open-real-agent-profile.mts <scratch-profile> <claude|codex|agy|cursor> [--existing-login]",
);
const isolation = JSON.parse(fs.readFileSync(path.join(root, "profile-env.json"), "utf8"));
const permitted = new Set([
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
]);
assert.ok(
  Object.entries(isolation).every(
    ([key, value]) => permitted.has(key) && typeof value === "string",
  ),
);
if (client === "cursor") {
  const configPath = path.join(root, ".cursor", "mcp.json");
  const raw = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(raw);
  const entry = config.mcpServers?.["walrus-console-mcp"];
  assert.ok(entry && typeof entry.command === "string" && path.isAbsolute(entry.command));
  assert.ok(
    entry.args === undefined ||
      (Array.isArray(entry.args) &&
        (entry.args.length === 0 || (entry.args.length === 1 && entry.args[0] === "--stdio"))),
  );
  // Repair old scratch registrations before opening Cursor. Preserve unrelated
  // settings; explicit child paths also avoid reliance on desktop shell env.
  entry.args = [...CURSOR_STDIO_ARGS];
  entry.env = { ...entry.env, ...isolation };
  writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
    preserveExistingMode: true,
    precondition: () => {
      assert.equal(fs.readFileSync(configPath, "utf8"), raw, "Cursor config changed; retry.");
    },
  });
}
const args =
  client === "cursor"
    ? ["--new-window", "--user-data-dir", path.join(root, "cursor-ui"), path.join(root, "allowed")]
    : [];
let env: NodeJS.ProcessEnv = { ...process.env, ...isolation };
if (client === "codex") {
  // Codex filters the environment inherited by MCP subprocesses; parent XDG
  // variables alone do not reach the server. Session overrides preserve the
  // scratch profile without changing its persisted registration.
  for (const [key, value] of Object.entries(isolation)) {
    args.push("-c", `mcp_servers.walrus-console-mcp.env.${key}=${JSON.stringify(value)}`);
  }
}
if (mode === "--existing-login") {
  const cursor = JSON.parse(fs.readFileSync(path.join(root, ".cursor", "mcp.json"), "utf8"));
  const entry = cursor.mcpServers?.["walrus-console-mcp"];
  assert.ok(entry && typeof entry.command === "string" && path.isAbsolute(entry.command));
  assert.ok(
    Array.isArray(entry.args) &&
      (entry.args.length === 0 || (entry.args.length === 1 && entry.args[0] === "--stdio")),
  );
  // Authentication belongs to the normal Claude profile. Only the MCP child
  // receives scratch paths. No global registration or credential file is copied.
  env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CONSOLE_|WALRUS_)/.test(key)) delete env[key];
  }
  args.push(
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({
      mcpServers: { "walrus-console-mcp": { command: entry.command, args: [], env: isolation } },
    }),
  );
}
const invocation = commandInvocation(client, args, { env });
const result = spawnSync(invocation.file, invocation.args, {
  env,
  cwd: path.join(root, "allowed"),
  stdio: "inherit",
  windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
