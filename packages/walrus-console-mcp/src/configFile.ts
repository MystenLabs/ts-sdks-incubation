import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Save config to the persistent file.
 * Creates the directory (0o700) and file (0o600) with restrictive permissions
 * so credentials are not world-readable.
 */
export function saveConfigFile(data: ConfigFileData): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const filePath = getConfigFilePath();
  const content = `${JSON.stringify(data, null, 2)}\n`;

  fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
  // writeFileSync's `mode` only applies when the file is *created*; an overwrite of a
  // pre-existing (looser-perm) config.json keeps its old mode. chmod enforces 0600 either way.
  fs.chmodSync(filePath, 0o600);
}
