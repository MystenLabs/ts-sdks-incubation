import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isValidSuiAddress } from "@mysten/sui/utils";
import { writeFileAtomic } from "./atomicWrite.js";
import { isAllowedBaseUrl } from "./baseUrl.js";
import { withFileLock } from "./fileLock.js";

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
 * The Key-Admin pair lives in its own file, not `config.json`:
 * it is a strictly more powerful credential than an everyday working key (it
 * can mint new working keys), so a leak/backup/log-scrape of the everyday
 * config file must not also hand over the admin pair. Same directory, same
 * 0600/0700 permission discipline as `config.json` — see `saveConfigFile`.
 */
const ADMIN_CONFIG_FILENAME = "admin.json";

/**
 * The subset of `ConfigFileData` that lives in `admin.json`, not `config.json`.
 * A plain union, not an `as const` array indexed via `(typeof X)[number]`
 *: nothing at runtime loops over the field
 * list — `splitAdminFields` below writes each field out by name, on purpose
 * — so an array would ship unused and imply a dynamic relationship the code
 * then argues against.
 */
type AdminField = "adminKey" | "adminServicePrivateKey";
type AdminFileData = Partial<Pick<ConfigFileData, AdminField>>;

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

/** Full path to the Key-Admin credential file — see `ADMIN_CONFIG_FILENAME`. */
export function getAdminConfigFilePath(): string {
  return path.join(getConfigDir(), ADMIN_CONFIG_FILENAME);
}

/**
 * Read and JSON-parse a config-directory file with the fail-loud-on-corruption,
 * fail-empty-on-ENOENT discipline `loadConfigFile` and `loadAdminFile` both need:
 * ONLY a genuinely missing file resolves to `{}`. Every other failure — a
 * permissions problem, an I/O error, unparseable bytes, or JSON that parses
 * but isn't an object (`null`, an array, a bare string/number) — throws a
 * path-named error instead of collapsing to an empty object.
 *
 * The distinction is load-bearing: `mergeConfigFile` reads through both loaders
 * and then writes the whole file back, so a phantom `{}` from a *corrupt* file
 * would silently wipe every credential that file still holds. That is exactly
 * as true for non-object JSON as for unparseable JSON — treating `null` as `{}` used to let a save overwrite it with nothing
 * printed at all, worse than the loud "could not be parsed" case, which at
 * least stops the write. `label` names the file in the thrown error (e.g.
 * "config file", "admin credential file").
 */
function readJsonFileOrThrow(filePath: string, label: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(
      `The ${label} at ${filePath} could not be read (${(err as Error).message}). ` +
        `Fix the file's permissions and re-run, or remove it to start fresh.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // No parser-message interpolation here: V8's
    // SyntaxError embeds a fragment of the offending input (e.g. `"...dminKey":
    // hbradm_SUP"... is not valid JSON`), and this message reaches stderr
    // before registerConfigFileSecrets has anything registered to redact —
    // bin/console-mcp.ts calls it WITH the result of this very read. The path
    // and the repair-or-remove advice below are all an operator needs.
    throw new Error(
      `The ${label} at ${filePath} could not be parsed as JSON. ` +
        `Repair the file and re-run, or remove it to start fresh.`,
    );
  }
  // `null`, arrays, and primitives are valid JSON but not a config object
  // (C14): treat this the same as unparseable JSON, not as an empty file —
  // see this function's own doc comment for why silently returning `{}`
  // here would be worse than the error it dodges.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const found = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
    throw new Error(
      `The ${label} at ${filePath} does not contain a JSON object (found ${found}). ` +
        `Repair the file and re-run, or remove it to start fresh.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Parse config.json's own fields out of its already-loaded JSON object —
 * everything `ConfigFileData` carries except the admin pair's *file*
 * precedence, which callers apply themselves (see `loadConfigFile` and
 * `loadConfigFileOrEmpty`, which need different failure behavior for that
 * step but share this one). The admin fields ARE read here too, but only as
 * the legacy inline fallback for a config.json written before the
 * admin.json split existed — see the comment at the call sites.
 */
function parseConfigFields(parsed: Record<string, unknown>): ConfigFileData {
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
 * SHA-256 digest of an admin pair, or `undefined` for an empty one — used to
 * compare a pair by VALUE without handling the secrets themselves as strings
 * any more than assembling them into one buffer to hash. Field-order-stable
 * (always `adminKey` then `adminServicePrivateKey`) and treats a missing
 * field as `""`, so the digest is a pure function of the pair's two values.
 *
 * Takes the two fields as plain `string | undefined` arguments rather than an
 * `AdminFileData` object: callers often have each field as its own possibly-
 * undefined value (e.g. `config.adminKey`), and building an object literal
 * from those would assign an explicit `undefined` to an optional property,
 * which `exactOptionalPropertyTypes` rejects.
 */
function digestAdminPair(
  adminKey: string | undefined,
  adminServicePrivateKey: string | undefined,
): string | undefined {
  if (adminKey === undefined && adminServicePrivateKey === undefined) return undefined;
  return createHash("sha256")
    .update(`${adminKey ?? ""}\n${adminServicePrivateKey ?? ""}`)
    .digest("hex");
}

/**
 * Apply `admin.json`'s pair onto `config` in place.
 *
 * `config` already carries whatever `adminKey`/`adminServicePrivateKey`
 * `parseConfigFields` read inline from `config.json` (see its own comment) —
 * that inline read exists for two cases, and they need OPPOSITE precedence
 *:
 *
 *   - A config.json written before this split existed, or a C1 partial-write
 *     duplicate left behind by an interrupted save. Here the inline value is
 *     either EQUAL to admin.json's, or a now-SUPERSEDED leftover from before
 *     admin.json's current value was written (admin.json is written first —
 *     see `saveConfigFile` — so a failure on the second, config.json write
 *     leaves the OLD inline pair sitting there while admin.json already
 *     holds the new one). admin.json must win here.
 *   - A management key ROTATED with a binary that predates this split. That
 *     binary writes the whole pair inline into config.json (it has no
 *     concept of admin.json), so the inline value now DIFFERS from — and is
 *     NEWER than — whatever admin.json still holds. Inline must win here, or
 *     the rotation gets silently discarded on the very next unrelated write:
 *     `mergeConfigFile` reads through `loadConfigFile`, `splitAdminFields`
 *     strips the inline pair before the config.json write, and the
 *     superseded admin.json value is what survives in both files.
 *
 * Both produce the exact same shape — "inline present, differs from
 * admin.json" — so field presence alone can't tell them apart (C7's original
 * fix tried "inline always wins when present" and got the second case
 * backwards: C12). Comparing each file's mtime instead (C12's original fix)
 * doesn't hold up either (C17): copying the config directory with `cp -R` or
 * `rsync` (no `-t`) can tie or reorder the two files' mtimes independently of
 * which one was genuinely written more recently, flipping the precedence.
 *
 * What's actually load-bearing is PROVENANCE, not timing: `admin.json`
 * records, in `supersedes`, a digest of the exact pair it replaced the last
 * time it was written (see `saveConfigFile`). If the inline pair currently in
 * `config` digests to that same value, it IS that replaced pair — a leftover
 * duplicate, not a new rotation — so admin.json wins and the leftover is
 * discarded on the next successful write. Any other inline value (including
 * no recorded `supersedes` at all, e.g. an admin.json created before this
 * field existed) couldn't have been what THIS admin.json's last write
 * replaced, so it must be a genuinely newer value an older binary wrote —
 * inline wins, and it migrates into admin.json on the next write.
 */
function applyAdminFile(config: ConfigFileData, adminFile: AdminFileOnDisk): void {
  const inlineDigest = digestAdminPair(config.adminKey, config.adminServicePrivateKey);
  const inlineIsStaleDuplicate =
    inlineDigest !== undefined && inlineDigest === adminFile.supersedes;
  if (inlineIsStaleDuplicate) {
    // The inline pair is exactly what admin.json's last write superseded —
    // admin.json's current value (however that resolves, clear included)
    // is what survives, not the stale duplicate.
    if (adminFile.adminKey !== undefined) config.adminKey = adminFile.adminKey;
    else delete config.adminKey;
    if (adminFile.adminServicePrivateKey !== undefined) {
      config.adminServicePrivateKey = adminFile.adminServicePrivateKey;
    } else delete config.adminServicePrivateKey;
    return;
  }
  if (config.adminKey === undefined && adminFile.adminKey !== undefined) {
    config.adminKey = adminFile.adminKey;
  }
  if (
    config.adminServicePrivateKey === undefined &&
    adminFile.adminServicePrivateKey !== undefined
  ) {
    config.adminServicePrivateKey = adminFile.adminServicePrivateKey;
  }
}

/**
 * Load the persisted config file. See `readJsonFileOrThrow` for the
 * fail-loud/fail-empty discipline this and `loadAdminFile` share; the write
 * path must fail loudly (see `mergeConfigFile`) on EITHER file, admin.json
 * included, so a merge can never RMW over a damaged one and silently wipe
 * it. `loadConfigFileOrEmpty` below is the read path, and degrades the two
 * files independently instead.
 */
export function loadConfigFile(): ConfigFileData {
  const parsed = readJsonFileOrThrow(getConfigFilePath(), "config file");
  const config = parseConfigFields(parsed);
  applyAdminFile(config, loadAdminFile());
  return config;
}

/**
 * `AdminFileData` plus the on-disk-only `supersedes` digest `applyAdminFile`
 * and `saveConfigFile` use for precedence — never
 * part of the public `ConfigFileData` shape, since nothing outside this file
 * needs to see it.
 */
type AdminFileOnDisk = AdminFileData & { supersedes?: string };

/**
 * Load `admin.json`, with the exact same fail-loud-on-corruption /
 * fail-empty-on-ENOENT discipline as `loadConfigFile` above — for the same
 * reason: `mergeConfigFile` reads through here too, and a phantom `{}` from a
 * corrupt admin file would silently wipe the Key-Admin credential on the next
 * unrelated write.
 */
function loadAdminFile(): AdminFileOnDisk {
  const parsed = readJsonFileOrThrow(getAdminConfigFilePath(), "admin credential file");
  const admin: AdminFileOnDisk = {};
  const adminKey = parsed["adminKey"];
  if (typeof adminKey === "string") admin.adminKey = adminKey;
  const adminServicePrivateKey = parsed["adminServicePrivateKey"];
  if (typeof adminServicePrivateKey === "string")
    admin.adminServicePrivateKey = adminServicePrivateKey;
  const supersedes = parsed["supersedes"];
  if (typeof supersedes === "string") admin.supersedes = supersedes;
  return admin;
}

/**
 * Warns at most once per file path per process:
 * `loadConfigFileOrEmpty` is called independently by every read site
 * (server startup, each interactive step's pre-write check, `resolveInstall
 * BaseUrl`…), so a single corrupt file used to print the identical warning
 * repeatedly within one run — a `config` call could print it 3-4 times, one
 * interactive `install` up to 6 — which reads like a loop instead of one
 * problem. Keyed by path, not message: the message for a given broken file
 * doesn't change within a run, and re-computing it just to compare strings
 * would waste the very read that's already failing.
 */
const warnedPaths = new Set<string>();
function warnOncePerPath(filePath: string, notice: () => void): void {
  if (warnedPaths.has(filePath)) return;
  warnedPaths.add(filePath);
  notice();
}

/**
 * Startup-safe wrapper around `loadConfigFile`: a corrupt or unreadable file
 * warns instead of throwing, and resolves to `{}` instead of failing.
 *
 * `loadConfigFile` is deliberately fail-stop so the *write* path can never merge
 * over a damaged file and wipe it. But the read-only boot and redaction-wiring
 * paths must not be taken down by a broken file when credentials are also
 * available from the environment — and the `install` / `config` commands, which
 * exist to *repair* such a file, must still run. Those callers use this instead.
 *
 * config.json and admin.json degrade INDEPENDENTLY, in BOTH directions
 *: before the admin/config split, one
 * broken file could only ever wipe itself. A single
 * `try { loadConfigFile() } catch { return {} }` here would regress that —
 * either file's corruption would discard the OTHER one's perfectly healthy
 * content, purely because `loadConfigFile` merges both into one
 * throw-or-succeed call. C2 fixed this for a corrupt admin.json (it must not
 * drop a healthy config.json); C13 is the mirror bug this had introduced —
 * a corrupt config.json used to `return {}` immediately, discarding a
 * healthy admin.json too, before ever trying to read it. Both files are
 * now attempted independently, and only a file that itself fails to parse
 * contributes nothing.
 *
 * `onNotice` is the same seam `mergeConfigFile`
 * takes: it defaults to a prefixed `console.error`, right for a script,
 * `--silent` run, or server boot, but the interactive `install`/`config`
 * panels call this mid-render too (a pre-write existence check, a base-URL
 * resolution) — a bare `console.error` there tears the panel's `│` border
 * exactly like an un-routed migration notice would.
 */
export function loadConfigFileOrEmpty(
  onNotice: (message: string) => void = (message) => console.error(`[console-mcp] ${message}`),
): ConfigFileData {
  let config: ConfigFileData;
  try {
    config = parseConfigFields(readJsonFileOrThrow(getConfigFilePath(), "config file"));
  } catch (err) {
    warnOncePerPath(getConfigFilePath(), () =>
      onNotice(
        `${(err as Error).message} Continuing without config.json — ` +
          `environment credentials and a healthy admin.json (if any) still apply.`,
      ),
    );
    config = {};
  }
  try {
    applyAdminFile(config, loadAdminFile());
  } catch (err) {
    warnOncePerPath(getAdminConfigFilePath(), () =>
      onNotice(
        `${(err as Error).message} Continuing without the Key-Admin ` +
          `credential — everything else read from config.json (if any) still applies.`,
      ),
    );
  }
  return config;
}

/**
 * Best-effort peek at admin.json's CURRENT on-disk pair, for `saveConfigFile`
 * callers that don't pass their own `supersededPair`. Never throws: a missing, corrupt, or malformed file just means there
 * is nothing to record as superseded, which is also correct behavior for a
 * first-ever write (nothing came before it) — `loadConfigFile`'s fail-stop
 * discipline is what makes a genuinely corrupt admin.json abort the save
 * before `saveConfigFile` is ever reached in the normal `mergeConfigFile`
 * path anyway.
 */
function bestEffortCurrentAdminPair(adminPath: string): AdminFileData {
  try {
    const parsed = JSON.parse(fs.readFileSync(adminPath, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const pair: AdminFileData = {};
    if (typeof parsed.adminKey === "string") pair.adminKey = parsed.adminKey;
    if (typeof parsed.adminServicePrivateKey === "string") {
      pair.adminServicePrivateKey = parsed.adminServicePrivateKey;
    }
    return pair;
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
 *
 * `supersededPair` is embedded in the new
 * admin.json as a digest, for `applyAdminFile` to recognize a stale inline
 * duplicate by VALUE instead of by file mtime (mtimes survive a directory
 * copy unreliably — see `applyAdminFile`'s doc comment). `mergeConfigFile`
 * passes config.json's own inline pair — the one this write strips, and
 * exactly what a failed config.json write leaves behind (N1) — which is the
 * value a C12 leftover duplicate would still equal. Once config.json is
 * written, the marker is removed again (N2). Direct callers (mostly tests)
 * that don't pass one fall back to whatever is CURRENTLY on disk at
 * admin.json, a reasonable best effort when there is no merge-level
 * "before" to hand in.
 */
export function saveConfigFile(data: ConfigFileData, supersededPair?: AdminFileData): void {
  const { admin, rest } = splitAdminFields(data);
  const adminPath = getAdminConfigFilePath();
  const adminIsEmpty = admin.adminKey === undefined && admin.adminServicePrivateKey === undefined;
  const priorPair = supersededPair ?? bestEffortCurrentAdminPair(adminPath);
  const supersedes = digestAdminPair(priorPair.adminKey, priorPair.adminServicePrivateKey);
  // admin.json is written FIRST, config.json second.
  // The two writes are each individually atomic, but the PAIR is not — nothing
  // rolls the first back if the second fails (ENOSPC, EIO, EPERM, a SIGTERM/
  // OOM/power-loss between the two renames). Admin-first means a failure on
  // the second write leaves the pair DUPLICATED (still readable from
  // config.json's legacy inline fields, which loadConfigFile falls back to)
  // rather than DESTROYED. Duplication is a confidentiality regression that
  // the next successful save cleans up; destruction is unrecoverable.
  //
  // Skipped entirely when `admin` is empty AND no admin.json exists yet
  // (C4): writing an empty `{"v":1}` on every host that never configured a
  // management key would (a) turn a corrupt-admin.json read failure from a
  // provisioning-host problem into a fleet-wide one, since every host would
  // now have a file that can fail to parse, and (b) destroy the file's value
  // as a signal — "does this host hold a management credential?" is no
  // longer answerable by the file's existence, which the README's "do not
  // copy this file to worker hosts" guidance leans on. Still written when
  // *clearing* an existing file, preserving saveConfigFile's whole-file-
  // replacement contract for admin.json too.
  if (!adminIsEmpty || fs.existsSync(adminPath)) {
    const onDisk: Record<string, unknown> = { v: 1, ...admin };
    if (supersedes !== undefined) onDisk["supersedes"] = supersedes;
    writeFileAtomic(adminPath, `${JSON.stringify(onDisk)}\n`, {
      mode: 0o600,
      mkdirMode: 0o700,
    });
  }
  // Compact JSON: the installer bundle prompt is one readline, so a pretty-
  // printed file would paste only `{` and fail as invalid JSON.
  writeFileAtomic(getConfigFilePath(), `${JSON.stringify({ v: 1, ...rest })}\n`, {
    mode: 0o600,
    mkdirMode: 0o700,
  });
  // config.json is written now, so this save can no longer leave a stale
  // inline pair behind — drop the `supersedes`
  // marker. Left in place, it would keep matching that same superseded pair
  // indefinitely, so a LATER, legitimate inline value that happens to equal
  // it — an older binary rolling back to exactly the pair this save just
  // replaced — would be misread as the C12 leftover this save already
  // resolved, rather than as the rollback it actually is, and get discarded
  // on the next save. Once this write's own config.json is down, any inline
  // pair from now on was written by someone else afterward and must win,
  // rollback included.
  if (supersedes !== undefined && fs.existsSync(adminPath)) {
    writeFileAtomic(adminPath, `${JSON.stringify({ v: 1, ...admin })}\n`, {
      mode: 0o600,
      mkdirMode: 0o700,
    });
  }
}

/**
 * Splits a partial `ConfigFileData` into its admin-only and everything-else
 * halves. Written out field-by-field, not looped over `AdminField`
 * dynamically: a dynamic `obj[key] = obj[key]` assignment across a union key
 * defeats `exactOptionalPropertyTypes`' narrowing, and there are only two
 * fields to split.
 */
function splitAdminFields<T extends Partial<ConfigFileData>>(
  data: T,
): { admin: AdminFileData; rest: Omit<T, AdminField> } {
  const { adminKey, adminServicePrivateKey, ...rest } = data;
  const admin: AdminFileData = {};
  if (adminKey !== undefined) admin.adminKey = adminKey;
  if (adminServicePrivateKey !== undefined) admin.adminServicePrivateKey = adminServicePrivateKey;
  return { admin, rest: rest as Omit<T, AdminField> };
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
 *
 * `onNotice` routes the migration notice below (and any future one) through
 * whatever the caller uses for output. It defaults to a prefixed
 * `console.error`, right for a plain script or a `--silent` run — but the
 * interactive `bin/configure.ts` / `bin/install.ts` panels stream their own
 * content line-by-line with a `│`-bordered `railed`/`rail.line` helper, and a
 * bare `console.error` call from inside here writes straight to stderr
 * mid-render: unaccounted for by that helper's line bookkeeping, it breaks
 * out of the panel border instead of appearing as a bordered row. Those
 * callers pass their own line-printer so the notice stays inside the box.
 */
export function mergeConfigFile(
  updates: Partial<ConfigFileData>,
  clear: readonly (keyof ConfigFileData)[] = [],
  onNotice: (message: string) => void = (message) => console.error(`[console-mcp] ${message}`),
): ConfigFileData {
  const result = mergeConfigFileIf(() => true, updates, clear, onNotice);
  // `decide` always says yes, so the merge always runs.
  return result.written ? result.merged : result.before;
}

/**
 * `mergeConfigFile`, but only if `decide` agrees after seeing the saved config.
 *
 * `decide` runs inside the same lock and against the same read as the write,
 * so "is something already saved?" and "save this" are one critical section.
 * Checking first and then calling `mergeConfigFile` leaves a gap in which
 * another process (`config`, `install`) can save, and this write would then
 * merge over it.
 */
export function mergeConfigFileIf(
  decide: (before: ConfigFileData) => boolean,
  updates: Partial<ConfigFileData>,
  clear: readonly (keyof ConfigFileData)[] = [],
  onNotice: (message: string) => void = (message) => console.error(`[console-mcp] ${message}`),
): { written: true; merged: ConfigFileData } | { written: false; before: ConfigFileData } {
  return withFileLock(path.join(getConfigDir(), `.${CONFIG_FILENAME}.lock`), () => {
    // Both the load and the save must sit inside the lock: holding it only over
    // the write would still let two processes read the same prior file and have
    // the later one's whole-file replacement drop the earlier one's field.
    //
    // One read of config.json (not `loadConfigFile()`, which would read it a
    // second time) gives both `inline` — config.json's own admin fields,
    // exactly what a failed config.json write leaves on disk — and `before`,
    // the resolved view `merged` is built from. Reading twice deadlocks
    // `configFile.concurrency.test.ts`, whose FIFO releases exactly one read
    // per writer.
    const inline = parseConfigFields(readJsonFileOrThrow(getConfigFilePath(), "config file"));
    const before: ConfigFileData = { ...inline };
    applyAdminFile(before, loadAdminFile());
    if (!decide(before)) return { written: false as const, before };
    const merged: ConfigFileData = { ...before, ...updates };
    // Applied after the spread so `clear` always wins over `updates` — a caller
    // that both writes and clears the same key means "remove it".
    for (const key of clear) delete merged[key];

    // security review, C8 and C15: the split's migration trigger is any
    // write at all, not a dedicated step — `config --allowed-dirs ~/Downloads`
    // relocates the Key-Admin pair just as surely as rotating it would, and
    // previously did so with no sign it had happened. Fires exactly once per
    // host: this is true precisely when `before` still carries a LEGACY
    // inline pair (from config.json, since `!fs.existsSync(adminPath)` rules
    // out `before.adminKey` having come from admin.json) and no `admin.json`
    // exists yet to have supplied it instead. The next save finds
    // `admin.json` already there and stays silent.
    //
    // Deliberately does NOT also require `updates.adminKey === undefined`
    // (C15): that extra condition meant a ROTATION of the legacy pair — the
    // first post-upgrade write itself supplying a new value — was silently
    // treated the same as a genuinely BRAND-NEW credential and skipped the
    // notice, even though the relocation (and the older-binary visibility
    // gap it causes) happens exactly the same either way. What actually
    // distinguishes "brand new" is `before.adminKey === undefined` — nothing
    // existed to relocate — which the first half of this condition already
    // covers.
    const migratingLegacyAdminPair =
      (before.adminKey !== undefined || before.adminServicePrivateKey !== undefined) &&
      !fs.existsSync(getAdminConfigFilePath());
    if (migratingLegacyAdminPair) {
      onNotice(
        `Moving the Key-Admin credential out of config.json into its own file ` +
          `(${getAdminConfigFilePath()}), triggered by this save. A server binary ` +
          `older than this CLI will not see it there until upgraded — see the CHANGELOG's ` +
          `Compatibility note if generate_api_key on this host loses its credential.`,
      );
    }

    // Passed as `supersededPair`: digests
    // the INLINE pair this save strips out of config.json, not the resolved
    // `before` — those two only agree on the FIRST attempt. On a retry after
    // an earlier failed config.json write (persistent EPERM/ENOSPC/a
    // read-only file), `before` already resolves to the value THIS save is
    // about to write again (admin.json succeeded last time), while the
    // stale value still sitting inline in config.json is what a further
    // failed write actually leaves behind. Digesting `before` there would
    // record the wrong "superseded" value, so the next read would treat the
    // real stale leftover as a genuinely newer rotation and lose the
    // rotated key. `inline` is exactly what's on disk right now, retry or
    // not. Built conditionally (like `parseConfigFields`) so an absent field
    // stays OMITTED rather than an explicit `undefined` —
    // `exactOptionalPropertyTypes` rejects the latter.
    const supersededPair: AdminFileData = {};
    if (inline.adminKey !== undefined) supersededPair.adminKey = inline.adminKey;
    if (inline.adminServicePrivateKey !== undefined) {
      supersededPair.adminServicePrivateKey = inline.adminServicePrivateKey;
    }
    saveConfigFile(merged, supersededPair);
    return { written: true as const, merged };
  });
}
