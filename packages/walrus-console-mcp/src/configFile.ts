import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isValidSuiAddress } from "@mysten/sui/utils";
import { writeFileAtomic } from "./atomicWrite.js";
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
  /** Key-Admin (management) bearer — `hbradm_…`. Provisioning hosts only. */
  adminKey?: string;
  /** Key-Admin on-chain signer seed — `suiprivkey1…`. Provisioning hosts only. */
  adminServicePrivateKey?: string;
  baseUrl?: string;
  /**
   * Sui address pinned as the created bucket's owner (the web account). Not a
   * secret — it identifies a recipient, not a credential — but the server
   * cannot write it, so a malformed value is treated as tampering, not intent
   * (see the `isValidSuiAddress` guard in `loadConfigFile`).
   */
  webAccountAddress?: string;
  /**
   * Sui address pinned as the created bucket's manager (Key-Admin). Same
   * non-secret, unwritable-trust-anchor treatment as `webAccountAddress`.
   */
  keyAdminAddress?: string;
  /**
   * Directories `upload_file` / `download_file` may touch when the MCP client
   * does not advertise filesystem roots. Absolute paths, persisted as a JSON
   * array so a Windows `C:\…` drive letter is never a separator. Not a secret.
   */
  allowedDirs?: string[];
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
 *
 * ONLY a genuinely missing file resolves to `{}`. Every other failure — a
 * permissions problem, an I/O error, or unparseable bytes — throws a path-named
 * error instead of collapsing to an empty object.
 *
 * The distinction is load-bearing: `mergeConfigFile` reads through here and then
 * writes the whole file back, so a phantom `{}` from a *corrupt* file would
 * silently wipe every credential that file still holds. The write path must fail
 * loudly (see `mergeConfigFile`); the server read path catches this at startup so
 * a broken file cannot crash a correctly env-configured server (see `config.ts`).
 */
export function loadConfigFile(): ConfigFileData {
  const filePath = getConfigFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(
      `The config file at ${filePath} could not be read (${(err as Error).message}). ` +
        `Fix the file's permissions and re-run, or remove it to start fresh.`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `The config file at ${filePath} could not be parsed as JSON (${(err as Error).message}). ` +
        `Repair the file and re-run, or remove it to start fresh.`,
    );
  }
  // `null`, arrays, and primitives are valid JSON but not a config object;
  // reading fields off them would throw or yield nonsense, so treat as empty.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  // Build conditionally so absent fields are OMITTED, not set to `undefined`:
  // `exactOptionalPropertyTypes` forbids an explicit `undefined` on an optional.
  const config: ConfigFileData = {};
  const apiKey = parsed["apiKey"];
  if (typeof apiKey === "string") config.apiKey = apiKey;
  const servicePrivateKey = parsed["servicePrivateKey"];
  if (typeof servicePrivateKey === "string") config.servicePrivateKey = servicePrivateKey;
  const adminKey = parsed["adminKey"];
  if (typeof adminKey === "string") config.adminKey = adminKey;
  const adminServicePrivateKey = parsed["adminServicePrivateKey"];
  if (typeof adminServicePrivateKey === "string")
    config.adminServicePrivateKey = adminServicePrivateKey;
  // Ignore an off-policy baseUrl from the file (defense in depth): a tampered
  // config.json must not redirect the Bearer key to a foreign host.
  const baseUrl = parsed["baseUrl"];
  if (typeof baseUrl === "string" && isAllowedBaseUrl(baseUrl)) config.baseUrl = baseUrl;
  // Same defense-in-depth as baseUrl above: these are unwritable trust anchors,
  // so an invalid address in a tampered/hand-edited file is dropped rather than
  // trusted — a bad value here would otherwise pin the wrong recipient.
  const webAccountAddress = parsed["webAccountAddress"];
  if (typeof webAccountAddress === "string" && isValidSuiAddress(webAccountAddress))
    config.webAccountAddress = webAccountAddress;
  const keyAdminAddress = parsed["keyAdminAddress"];
  if (typeof keyAdminAddress === "string" && isValidSuiAddress(keyAdminAddress))
    config.keyAdminAddress = keyAdminAddress;
  // Keep only non-empty strings. A tampered file that puts a number or a nested
  // object here must not become a sandbox root, and an empty array is "unset".
  const allowedDirs = parsed["allowedDirs"];
  if (Array.isArray(allowedDirs)) {
    const dirs = allowedDirs
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (dirs.length > 0) config.allowedDirs = dirs;
  }
  return config;
}

/**
 * Startup-safe wrapper around `loadConfigFile`: a corrupt or unreadable file
 * warns to stderr and resolves to `{}` instead of throwing.
 *
 * `loadConfigFile` is deliberately fail-stop so the *write* path can never merge
 * over a damaged file and wipe it. But the read-only boot and redaction-wiring
 * paths must not be taken down by a broken file when credentials are also
 * available from the environment — and the `install` / `config` commands, which
 * exist to *repair* such a file, must still run. Those callers use this instead.
 */
export function loadConfigFileOrEmpty(): ConfigFileData {
  try {
    return loadConfigFile();
  } catch (err) {
    console.error(
      `[console-mcp] ${(err as Error).message} Continuing without the file — ` +
        `environment credentials (if any) still apply.`,
    );
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
  // Compact JSON: the installer bundle prompt is one readline, so a pretty-
  // printed file would paste only `{` and fail as invalid JSON.
  writeFileAtomic(getConfigFilePath(), `${JSON.stringify({ v: 1, ...data })}\n`, {
    mode: 0o600,
    mkdirMode: 0o700,
  });
}

/**
 * Merge `updates` into the saved config and persist the result.
 *
 * `saveConfigFile` replaces the whole file, so writing a partial payload would
 * silently drop every credential the caller did not supply — configuring a
 * management key would erase the working key. Every CLI write goes through here.
 *
 * Omitting a key from `updates` therefore means "preserve", which leaves no way
 * to *remove* a saved value — and `exactOptionalPropertyTypes` rightly rejects
 * `{ key: undefined }` as a stand-in. `clear` is that missing operation: it names
 * the fields to drop, so replacing an API key can discard the previous key's
 * signer instead of silently pairing the new key with a mismatched one.
 */
export function mergeConfigFile(
  updates: Partial<ConfigFileData>,
  clear: readonly (keyof ConfigFileData)[] = [],
): ConfigFileData {
  const lock = acquireLock();
  try {
    // Both the load and the save must sit inside the lock: holding it only over
    // the write would still let two processes read the same prior file and have
    // the later one's whole-file replacement drop the earlier one's field.
    const merged: ConfigFileData = { ...loadConfigFile(), ...updates };
    // Applied after the spread so `clear` always wins over `updates` — a caller
    // that both writes and clears the same key means "remove it".
    for (const key of clear) delete merged[key];
    saveConfigFile(merged);
    return merged;
  } finally {
    releaseLock(lock);
  }
}

const LOCK_FILENAME = `.${CONFIG_FILENAME}.lock`;
/**
 * How long a lock whose holder is *still running* may be held before a later run
 * treats it as leaked.
 *
 * A dead holder's lock is reclaimed on sight — nothing can be inside the
 * critical section. A live holder is the opposite case: the section is a read
 * plus a rename, so a long hold means that process is stalled, not finished, and
 * a stall is not rare (a laptop suspended mid-merge, a wedged network home
 * directory, a paused process). Taking the lock from it reopens the very
 * lost-update race the lock closes, so age alone must not be enough.
 *
 * The one thing that can leave a live pid holding forever is pid reuse after a
 * SIGKILL, and this threshold exists only to unwedge that. It therefore sits far
 * above any plausible stall: a run that collides now hits the loud timeout in
 * `acquireLock`, and only a run started much later heals the leak.
 */
const LOCK_LIVE_HOLDER_STALE_MS = 10 * 60_000;
const LOCK_ATTEMPTS = 100;
const LOCK_RETRY_MS = 20;

interface ConfigLock {
  path: string;
  /**
   * Identifies this hold specifically. A pid cannot: it is recycled after a
   * crash, and a retry of the same command reuses it exactly.
   */
  nonce: string;
}

function getLockFilePath(): string {
  return path.join(getConfigDir(), LOCK_FILENAME);
}

/** Block the thread briefly. The whole config path is synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering one.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Delete the lock if whoever holds it can no longer be inside the critical
 * section. Returns whether it was reclaimed.
 *
 * Without this a SIGKILL between acquire and release would wedge every later
 * `install`/`config` run — and `config` is the command you reach for when the
 * setup is already broken, so a permanently stuck lock would be worse than the
 * race it prevents.
 *
 * Aliveness is what decides, not age. A holder that is still running is still
 * mid-merge however long it has been there, and reclaiming from it would put two
 * read-merge-writes over the same file — one of them losing a credential.
 */
function reclaimIfStale(lockPath: string): boolean {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    const holder = JSON.parse(raw) as { pid?: number; at?: number };
    if (typeof holder.pid === "number" && isProcessAlive(holder.pid)) {
      const age = Date.now() - (holder.at ?? 0);
      if (age < LOCK_LIVE_HOLDER_STALE_MS) return false;
    }
  } catch {
    // Missing, unreadable, or truncated (a crash between create and write):
    // nothing here can be trusted to name a live holder, so treat it as stale.
  }
  try {
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the exclusive config lock.
 *
 * The holder record is written to a private temp file and then `link()`ed into
 * place. link() is the atomic primitive here: it fails with EEXIST rather than
 * overwriting, so exactly one process wins, and — unlike open(…, "wx") followed
 * by a write — the lock file is never observable in a half-written state. That
 * gap matters: a rival that reads an empty lock cannot tell it from a corrupt
 * one, would declare it stale, and both processes would proceed.
 *
 * Throws rather than proceeding unlocked if the lock cannot be taken — silently
 * losing a credential is worse than a loud failure the user can retry.
 */
function acquireLock(): ConfigLock {
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  const lockPath = getLockFilePath();
  const tmpPath = `${lockPath}.${process.pid}.tmp`;
  const nonce = randomUUID();

  try {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      fs.writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, nonce, at: Date.now() }), {
        encoding: "utf-8",
        mode: 0o600,
      });
      try {
        fs.linkSync(tmpPath, lockPath);
        return { path: lockPath, nonce };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // Reclaiming frees the name immediately, so retry without sleeping.
        if (!reclaimIfStale(lockPath)) sleepSync(LOCK_RETRY_MS);
      }
    }
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }

  throw new Error(
    `Timed out waiting for the config lock at ${lockPath}. ` +
      `Another walrus-console-mcp process is still writing; retry, or delete that file if none is running.`,
  );
}

/**
 * Drop the lock, but only while it is still the hold we took.
 *
 * A reclaim hands the name to somebody else, and deleting by path alone would
 * then remove *that* process's lock and let a third one merge beside it — one
 * misjudged hold turning into an unbounded cascade. Matching the nonce keeps the
 * damage to the pair that already overlapped. Declining to delete leaks nothing
 * for long: once this process exits, its pid reads as dead and the next run
 * reclaims on sight.
 *
 * The read and the unlink are not one operation, so a reclaim landing between
 * them still slips through. That window is microseconds, against the minutes a
 * lock must age before anyone may take it from a live holder.
 */
function releaseLock(lock: ConfigLock): void {
  try {
    const holder = JSON.parse(fs.readFileSync(lock.path, "utf-8")) as { nonce?: string };
    if (holder.nonce !== lock.nonce) return;
  } catch {
    // Gone already, or unreadable — either way not provably ours to delete. Our
    // own record can never be the unreadable one: link() publishes it whole.
    return;
  }
  fs.rmSync(lock.path, { force: true });
}
