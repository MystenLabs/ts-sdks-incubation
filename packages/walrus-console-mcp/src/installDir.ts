import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CommandRunner } from "./clients.js";

/**
 * A private installation of the MCP server, owned by this installer.
 *
 * Registering `npx -y <spec>` as the launch command looks convenient and is a
 * credential-theft primitive. `npx` resolves the name against the CURRENT
 * WORKING DIRECTORY first, so an agent started inside a project that happens to
 * ship a package of the same name launches that package instead — under our MCP
 * identity, with read access to the Console credentials in
 * ~/.config/walrus-console-mcp. It does not take a hostile project to hit this:
 * it is exactly how a name collision in this very package was first noticed,
 * where the local checkout shadowed the published one.
 *
 * So the installer resolves the package ONCE, at install time, into a directory
 * it controls, and registers the absolute path of the resulting bin. Nothing is
 * resolved at launch time, so there is nothing left to shadow.
 */

const APP_NAME = "walrus-console-mcp";

/** The bin name declared in this package's `package.json`. */
const BIN_NAME = "walrus-console-mcp";

/**
 * Where the private installation lives.
 *
 * Under the XDG *data* directory, not config: this is an installed artifact that
 * can be deleted and recreated by re-running the installer, not user-authored
 * state. Windows gets LOCALAPPDATA for the same reason — machine-local, not
 * roaming.
 */
export function resolveInstallRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, APP_NAME);
  }
  const xdgDataHome = env["XDG_DATA_HOME"];
  if (xdgDataHome) return path.join(xdgDataHome, APP_NAME);
  return path.join(os.homedir(), ".local", "share", APP_NAME);
}

/**
 * The absolute path of the installed launcher.
 *
 * npm writes a `.cmd` shim on Windows; the extensionless shell script elsewhere.
 */
export function serverBinPath(root: string, platform: NodeJS.Platform = process.platform): string {
  const file = platform === "win32" ? `${BIN_NAME}.cmd` : BIN_NAME;
  return path.join(root, "node_modules", ".bin", file);
}

export interface InstallServerOptions {
  root?: string;
  run?: CommandRunner;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * Install `spec` into the private root and return the absolute launcher path.
 *
 * `--prefix <root>` is what makes this safe: npm treats that directory as the
 * project, so the caller's cwd — and any package it might shadow us with — is
 * never consulted.
 *
 * Throws rather than returning a best-effort path. A config pointing at a
 * launcher that does not exist fails at every future startup, with an error that
 * surfaces inside the agent rather than here where it can still be acted on.
 */
export function installServer(spec: string, opts: InstallServerOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const root = opts.root ?? resolveInstallRoot(opts.env, platform);
  const run = opts.run ?? defaultRunner;

  fs.mkdirSync(root, { recursive: true });

  try {
    // `--global-style` is deliberately NOT used: a plain local install under the
    // prefix is what puts the bin shim at node_modules/.bin.
    run("npm", ["install", "--prefix", root, "--no-audit", "--no-fund", spec]);
  } catch (error) {
    throw new Error(
      `${spec} could not be installed into ${root}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const binPath = serverBinPath(root, platform);
  if (!fs.existsSync(binPath)) {
    throw new Error(
      `npm reported success but no ${BIN_NAME} launcher appeared at ${binPath}. ` +
        `Refusing to register a launch command that would not start.`,
    );
  }
  return binPath;
}

const defaultRunner: CommandRunner = (bin, args) => {
  // Inherit stdio: an npm install is slow enough that silence reads as a hang,
  // and its failure output is the only useful diagnostic when it does fail.
  execFileSync(bin, args, { stdio: "inherit" });
};
