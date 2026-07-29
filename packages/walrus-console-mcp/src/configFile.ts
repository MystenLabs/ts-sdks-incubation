import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isAllowedBaseUrl } from "./baseUrl.js";

/**
 * Persistent config file for walrus-console-mcp.
 *
 * Location: ~/.config/walrus-console-mcp/config.json
 * (respects XDG_CONFIG_HOME on Linux)
 *
 * The install CLI writes here; the Effect config layer reads
 * from here as a fallback when env vars are not set.
 */

export interface ConfigFileData {
  apiKey?: string;
  servicePrivateKey?: string;
  baseUrl?: string;
}

const APP_NAME = "walrus-console-mcp";
const CONFIG_FILENAME = "config.json";

/**
 * Returns the config directory path.
 * - Linux:  $XDG_CONFIG_HOME/walrus-console-mcp  (default ~/.config/walrus-console-mcp)
 * - macOS:  ~/.config/walrus-console-mcp
 * - Windows: %APPDATA%/walrus-console-mcp
 */
export function getConfigDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    const { APPDATA } = process.env;
    const appData = APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, APP_NAME);
  }
  // macOS + Linux: use XDG_CONFIG_HOME or ~/.config
  const { XDG_CONFIG_HOME } = process.env;
  const xdg = XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, APP_NAME);
}

/** Full path to the config file. */
export function getConfigFilePath(): string {
  return path.join(getConfigDir(), CONFIG_FILENAME);
}

/**
 * Load the persisted config file.
 * Returns an empty object if the file doesn't exist or is unreadable.
 */
export function loadConfigFile(): ConfigFileData {
  const filePath = getConfigFilePath();
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
      servicePrivateKey:
        typeof parsed.servicePrivateKey === "string" ? parsed.servicePrivateKey : undefined,
      // Ignore an off-policy baseUrl from the file (defense in depth): a
      // tampered config.json must not redirect the Bearer key to a foreign host.
      baseUrl:
        typeof parsed.baseUrl === "string" && isAllowedBaseUrl(parsed.baseUrl)
          ? parsed.baseUrl
          : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Save config to the persistent file.
 * Creates the directory (0o700) and file (0o600) with restrictive permissions
 * so credentials are not world-readable.
 *
 * Writes to a same-directory temp file created 0o600, then renames it over the
 * target. This avoids the write-then-chmod window where the plaintext
 * credentials briefly existed under a looser mode (writeFileSync's `mode` is
 * ignored when overwriting an existing file), and makes the replacement atomic —
 * a crash mid-write leaves the old file intact, never a half-written or
 * loose-perm one. The rename also relaxes any legacy loose mode, since it
 * replaces the inode.
 */
export function saveConfigFile(data: ConfigFileData): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const filePath = getConfigFilePath();
  const content = `${JSON.stringify(data, null, 2)}\n`;

  // "wx" fails if a stale temp somehow exists rather than silently reusing it;
  // fchmod pins 0o600 even under a hostile umask that would loosen the open mode.
  const tmpPath = path.join(dir, `.${CONFIG_FILENAME}.${process.pid}.tmp`);
  const fd = fs.openSync(tmpPath, "wx", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, content, "utf-8");
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}
