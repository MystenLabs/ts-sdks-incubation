/**
 * Print an Add to Cursor install link for a credential bundle, to test
 * `--import-bundle` by hand. Development only; Console builds the real link.
 *
 *   pnpm build
 *   tsx scripts/cursor-link.mts --bundle-file ./bundle.json
 *   CONSOLE_CREDENTIAL_BUNDLE='{"v":1,…}' tsx scripts/cursor-link.mts
 *
 * By default the entry starts this checkout's dist/console-mcp.js with the
 * running node, because a published version without `--import-bundle` would
 * ignore the flag. `--published <version>` builds the npx entry Console ships
 * instead. `CONSOLE_API_BASE_URL`, when set, is copied into the entry's env so
 * the probe can reach a local Console; it is not a secret.
 * `--allowed-dirs-env <value>` sets `CONSOLE_MCP_ALLOWED_DIRS` in the entry's
 * env, kept literal so Cursor can expand a variable such as
 * `${workspaceFolder}`. Cursor advertises no MCP roots, so without it, or
 * folders saved by `config`, upload and download refuse every path. The
 * variable beats folders saved by `config` for as long as the entry carries
 * it, so a link that sets it also fixes the folders until `mcp.json` is edited.
 *
 * The server name defaults to the installer's, so a link install and a later
 * installer run that ticks Cursor share one entry instead of adding two.
 *
 * The bundle is read from a file or the environment, never from argv, so it
 * stays out of shell history. The printed link carries it: treat it like the
 * bundle itself.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_NAME } from "../src/clients.js";
import { SAFE_NPX_PREFIX_ARG } from "../src/cursorEntry.js";
import { ALLOWED_DIRS_ENV } from "../src/pathSandbox.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const bundleFile = flag("--bundle-file");
const raw = bundleFile
  ? fs.readFileSync(bundleFile, "utf-8")
  : (process.env["CONSOLE_CREDENTIAL_BUNDLE"] ?? "");
if (raw.trim() === "") {
  console.error("Pass --bundle-file <path> or set CONSOLE_CREDENTIAL_BUNDLE.");
  process.exit(1);
}
// Compact, as Console will encode it; also refuses a file that is not JSON.
const bundle = Buffer.from(JSON.stringify(JSON.parse(raw)), "utf-8").toString("base64url");

const published = flag("--published");
const entry: { command: string; args: string[]; env?: Record<string, string> } = published
  ? {
      command: "npx",
      args: [
        SAFE_NPX_PREFIX_ARG,
        "-y",
        `@mysten-incubation/walrus-console-mcp@${published}`,
        "--import-bundle",
        bundle,
      ],
    }
  : {
      command: process.execPath,
      args: [
        path.resolve(fileURLToPath(import.meta.url), "..", "..", "dist", "console-mcp.js"),
        "--import-bundle",
        bundle,
      ],
    };
const env: Record<string, string> = {};
const baseUrl = process.env["CONSOLE_API_BASE_URL"];
if (baseUrl) env["CONSOLE_API_BASE_URL"] = baseUrl;
const allowedDirs = flag("--allowed-dirs-env");
if (allowedDirs) env[ALLOWED_DIRS_ENV] = allowedDirs;
if (Object.keys(env).length > 0) entry.env = env;

const name = flag("--name") ?? SERVER_NAME;
const config = Buffer.from(JSON.stringify(entry), "utf-8").toString("base64");
process.stdout.write(
  `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}` +
    `&config=${encodeURIComponent(config)}\n`,
);
