import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const repository = fileURLToPath(new URL("../../", import.meta.url));

/** Child-only environment: never changes the developer's client profiles. */
export function installProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "walrus client profile "));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CONSOLE_|WALRUS_)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    APPDATA: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    LOCALAPPDATA: path.join(root, "data"),
    CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
    CODEX_HOME: path.join(root, ".codex"),
    PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
  });
  const launcher = path.join(
    root,
    "data",
    "walrus-console-mcp",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "walrus-console-mcp.cmd" : "walrus-console-mcp",
  );
  const allowed = path.join(root, "allowed");
  fs.mkdirSync(allowed);
  function executable(name: string, source: string) {
    const script = path.join(bin, `${name}.cjs`);
    fs.writeFileSync(script, source);
    if (process.platform === "win32") {
      fs.writeFileSync(
        path.join(bin, `${name}.cmd`),
        `@"${process.execPath}" "%~dp0${name}.cjs" %*\r\n`,
      );
    } else {
      fs.writeFileSync(
        path.join(bin, name),
        `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$(dirname "$0")/${name}.cjs" "$@"\n`,
        { mode: 0o755 },
      );
    }
  }
  function run(args: string[]) {
    return spawnSync(
      process.execPath,
      ["--import", "tsx", path.join(repository, "bin", "console-mcp.ts"), ...args],
      { cwd: repository, env, encoding: "utf8", timeout: 180_000 },
    );
  }
  /** Swap only the npm package source; production installation and client registration run unchanged. */
  function localPackage(tarball: string) {
    // A configured global prefix need not contain npm (notably on Windows CI).
    // Locate the installed CLI beside Node or its PATH shim instead.
    const dirs = (process.env["PATH"] ?? "").split(path.delimiter);
    const candidates = [
      path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ];
    for (const dir of dirs) {
      candidates.push(path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"));
      try {
        const resolved = fs.realpathSync(path.join(dir, "npm"));
        if (path.basename(resolved) === "npm-cli.js") candidates.push(resolved);
      } catch {
        /* npm may be a .cmd shim, handled by its adjacent installation above. */
      }
    }
    const npmCli = candidates.find((file) => fs.existsSync(file));
    if (!npmCli) throw new Error("Cannot locate the installed npm CLI beside Node or on PATH.");
    executable(
      "npm",
      `const cp = require('node:child_process'); const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(path.join(root, "npm-args.json"))}, JSON.stringify(args));
if(args[0] !== 'install' || !args.at(-1).startsWith('@mysten-incubation/walrus-console-mcp@')) process.exit(90);
args[args.length-1] = ${JSON.stringify(tarball)};
const result = cp.spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(npmCli)}, ...args], {stdio:'inherit', env:process.env});
process.exit(result.status ?? 91);`,
    );
  }
  return {
    root,
    env,
    launcher,
    allowed,
    executable,
    run,
    localPackage,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
