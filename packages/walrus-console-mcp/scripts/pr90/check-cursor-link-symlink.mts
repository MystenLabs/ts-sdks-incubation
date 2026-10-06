import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// An explicit regression probe, separate from the green registration suite.
// No real credential or API: the cleanup routine matches this inert marker.
const root =
  process.env["PR90_TEST_SOURCE_ROOT"] ?? fileURLToPath(new URL("../../", import.meta.url));
const { stripBundleFromCursorConfig } = await import(
  pathToFileURL(path.join(root, "src/cursorEntry.ts")).href
);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-cursor-link-symlink-"));
const savedEnv = { ...process.env };
process.env["XDG_CONFIG_HOME"] = dir;
process.env["APPDATA"] = dir;
try {
  const marker = "fixture-only-bundle-marker";
  const target = path.join(dir, "dotfiles-mcp.json");
  const link = path.join(dir, "mcp.json");
  fs.writeFileSync(
    target,
    JSON.stringify({
      mcpServers: {
        fixture: { command: "/fixture/launcher", args: ["--import-bundle", marker] },
        other: { command: "node", args: [] },
      },
    }),
  );
  fs.symlinkSync(target, link);
  const result = stripBundleFromCursorConfig(link, marker);
  const linkedConfig = JSON.parse(fs.readFileSync(link, "utf-8"));
  const targetConfig = JSON.parse(fs.readFileSync(target, "utf-8"));
  const keptSymlink = fs.lstatSync(link).isSymbolicLink();
  const cleanedTarget = targetConfig.mcpServers.fixture.args[1] === "-";
  console.log(
    JSON.stringify({
      result,
      keptSymlink,
      cleanedTarget,
      cleanedVisibleConfig: linkedConfig.mcpServers.fixture.args[1] === "-",
      otherEntryKept: linkedConfig.mcpServers.other.command === "node",
    }),
  );
  if (!keptSymlink || !cleanedTarget) process.exitCode = 1;
} finally {
  process.env = savedEnv;
  fs.rmSync(dir, { recursive: true, force: true });
}
