import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomicWrite.js";
import { getConfigDir } from "./configFile.js";
import { withFileLock } from "./fileLock.js";
import { toRealPath } from "./pathSandbox.js";

/**
 * Removes the credential bundle from the Cursor `mcp.json` entry an Add to
 * Cursor link wrote.
 *
 * The link can only add a `{command, args}` entry, so the bundle arrives as an
 * argument and sits in `~/.cursor/mcp.json` in plain text until something takes
 * it out. Once `--import-bundle` has handled it, this replaces it with
 * `IMPORTED_BUNDLE_PLACEHOLDER`. Cursor notices the file change and restarts the
 * server from the cleaned entry, so no later start carries the secret.
 */

/** The flag an Add to Cursor entry passes the base64url bundle under. */
export const IMPORT_BUNDLE_FLAG = "--import-bundle";

/**
 * What the bundle is replaced with once handled. A start that finds it knows
 * there is nothing to import.
 */
export const IMPORTED_BUNDLE_PLACEHOLDER = "-";

/**
 * The argument that stops `npx` resolving the package through the workspace.
 *
 * Plain `npx -y <pkg>@<version>` prefers a same-named package in the working
 * directory or any ancestor `node_modules`, and reads a workspace `.npmrc`
 * that can point `registry` and `cache` somewhere else. With an explicit
 * prefix npm does neither. It must name a directory that exists, and Cursor
 * expands `${userHome}` in `args`, so the entry needs no path Console could not
 * know. Kept literal: expanding it here would pin one machine's home into a
 * file the user may sync to another.
 */
export const SAFE_NPX_PREFIX_ARG = "--prefix=${userHome}";

export type StripOutcome =
  /** The bundle was replaced in these entries; `hardened` gained the prefix. */
  | { kind: "stripped"; entries: string[]; hardened: string[] }
  /**
   * The file exists, but no entry carries this bundle. `cleanedEntry`: some
   * entry already holds the placeholder, as a twin copy's strip leaves it.
   */
  | { kind: "not-found"; cleanedEntry: boolean }
  /** There is no Cursor config at that path. */
  | { kind: "missing-file" }
  /** The file could not be read or parsed, so it was left untouched. */
  | { kind: "unreadable"; reason: string };

interface ServerEntry extends Record<string, unknown> {
  command?: unknown;
  args?: unknown;
}

/** Whether `command` launches npx, spelled bare or as a path, on any OS. */
function isNpxCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const base = path.basename(command.replace(/\\/g, "/")).toLowerCase();
  return base === "npx" || base === "npx.cmd" || base === "npx.exe";
}

/**
 * Replace `bundle` in one entry's args. Matches the value both as the token
 * after the flag and in the `--import-bundle=<value>` spelling, and nowhere
 * else: the value is a secret, so a match anywhere is ours to remove, but the
 * flag spelling is what keeps a placeholder usable on the next start.
 */
function replaceBundleArg(args: readonly unknown[], bundle: string): unknown[] | null {
  const inline = `${IMPORT_BUNDLE_FLAG}=${bundle}`;
  let found = false;
  const next = args.map((arg) => {
    if (arg === bundle) {
      found = true;
      return IMPORTED_BUNDLE_PLACEHOLDER;
    }
    if (arg === inline) {
      found = true;
      return `${IMPORT_BUNDLE_FLAG}=${IMPORTED_BUNDLE_PLACEHOLDER}`;
    }
    return arg;
  });
  return found ? next : null;
}

/** Whether any entry passes the placeholder to `--import-bundle`. */
function hasCleanedEntry(config: Record<string, unknown>): boolean {
  const servers = config["mcpServers"];
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return false;
  return Object.values(servers as Record<string, unknown>).some((value) => {
    const args = (value as ServerEntry | null)?.args;
    if (!Array.isArray(args)) return false;
    return args.some(
      (arg, i) =>
        arg === `${IMPORT_BUNDLE_FLAG}=${IMPORTED_BUNDLE_PLACEHOLDER}` ||
        (arg === IMPORT_BUNDLE_FLAG && args[i + 1] === IMPORTED_BUNDLE_PLACEHOLDER),
    );
  });
}

/**
 * npx flags that take no value: the subset of npm's boolean configs an MCP
 * launch line plausibly carries. A boolean missing here makes the scan below
 * read the next token as its value, which can only push the end of the
 * npm-option region later, and that region never reaches past
 * `--import-bundle`.
 */
const NPX_SWITCHES = new Set(["yes", "y", "no-install", "quiet", "q", "offline", "prefer-offline"]);

/** npx flags that always take a value, even one starting with `-` (as in `npx-cli.js`). */
const NPX_OPTS = new Set(["package", "p", "call", "c", "cache", "userconfig", "shell"]);

/**
 * Whether a flag (dashes removed) sets npm's prefix: `prefix`, the `-C`
 * shorthand, or an abbreviation npm still expands (`--prefi`; `--pref` is
 * ambiguous with `prefer-*`, so npm refuses it).
 */
function isPrefixKey(key: string): boolean {
  return key === "C" || (key.length >= "prefi".length && "prefix".startsWith(key));
}

/**
 * Whether a flag (dashes removed) is npm's negation of the prefix
 * (`--no-prefix`, or an abbreviation of it). npm reads `--no-<key>` as that
 * config set to false and takes no value for it; a negated prefix cancels a
 * safe one given earlier, so it is never safe.
 */
function isNegatedPrefixKey(key: string): boolean {
  return key.startsWith("no-") && isPrefixKey(key.slice("no-".length));
}

/**
 * Whether a prefix keeps npx out of the workspace: the literal `${userHome}`
 * Cursor expands, or a path absolute by THIS OS's rules. npm resolves the
 * prefix by those same rules, so `C:\project` is a directory inside the
 * workspace on macOS and Linux. Any other `${...}` is refused,
 * `${workspaceFolder}` being exactly the directory to avoid.
 */
function isSafePrefix(value: unknown): boolean {
  return value === "${userHome}" || (typeof value === "string" && path.isAbsolute(value));
}

/**
 * Give an npx entry the safe prefix unless every prefix npm will see is safe.
 *
 * Only the npm options before the package spec count: npx hands everything
 * after the first positional to the server. The scan follows `npx-cli.js`:
 * `--` or a positional ends it, `--key=value` is one token, and a flag that is
 * not a known switch takes the next token as its value when it is a known
 * value-taker or that token does not start with `-`. It also stops at
 * `--import-bundle`, which always follows the spec, so a misread never edits
 * the bundle or what follows it.
 *
 * Every prefix there must be safe, not just one: npm keeps the last, so an
 * unsafe one anywhere overrides a safe one. Otherwise every prefix arg in the
 * region is removed and `SAFE_NPX_PREFIX_ARG` goes first.
 */
function hardenNpxArgs(args: readonly unknown[]): { args: unknown[]; changed: boolean } {
  const bundleAt = args.findIndex(
    (arg) =>
      typeof arg === "string" &&
      (arg === IMPORT_BUNDLE_FLAG || arg.startsWith(`${IMPORT_BUNDLE_FLAG}=`)),
  );
  const stop = bundleAt === -1 ? args.length : bundleAt;

  const prefixArgs = new Set<number>();
  let allSafe = true;
  for (let i = 0; i < stop; i++) {
    const arg = args[i];
    if (typeof arg !== "string" || arg === "--" || !arg.startsWith("-")) break;
    const eq = arg.indexOf("=");
    const key = (eq === -1 ? arg : arg.slice(0, eq)).replace(/^-+/, "");
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const next = i + 1 < stop ? args[i + 1] : undefined;
    if (isNegatedPrefixKey(key)) {
      prefixArgs.add(i);
      allSafe = false;
      continue;
    }
    const takesNext =
      inlineValue === undefined &&
      !NPX_SWITCHES.has(key) &&
      next !== undefined &&
      (NPX_OPTS.has(key) || !String(next).startsWith("-"));
    if (isPrefixKey(key)) {
      prefixArgs.add(i);
      if (takesNext) prefixArgs.add(i + 1);
      allSafe &&= isSafePrefix(inlineValue ?? (takesNext ? next : undefined));
    }
    if (takesNext) i++;
  }
  if (prefixArgs.size > 0 && allSafe) return { args: [...args], changed: false };
  return {
    args: [SAFE_NPX_PREFIX_ARG, ...args.filter((_, i) => !prefixArgs.has(i))],
    changed: true,
  };
}

/**
 * Pure half of `stripBundleFromCursorConfig`: returns the rewritten config, or
 * null when no entry carries `bundle`.
 *
 * Entries are found by the bundle value, not the server name. The name is
 * whatever the link chose, and a user can rename it; the value identifies the
 * one entry that started this process.
 *
 * An npx entry without a safe `--prefix` also gains `SAFE_NPX_PREFIX_ARG`. The
 * placeholder closes the secret, but not the launch: every later start of a
 * plain `npx -y` entry can still run a workspace package, which then reads the
 * credentials this import just saved. Only entries that carried the bundle are
 * touched, so this never edits another server's launch command.
 */
export function stripBundleFromConfig(
  config: Record<string, unknown>,
  bundle: string,
): { config: Record<string, unknown>; entries: string[]; hardened: string[] } | null {
  const servers = config["mcpServers"];
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return null;

  const entries: string[] = [];
  const hardened: string[] = [];
  // No prototype: a plain `{}` turns an assignment to `__proto__` into a
  // prototype change, which would drop a server of that name from the file.
  const nextServers: Record<string, unknown> = Object.create(null);
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    nextServers[name] = value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as ServerEntry;
    if (!Array.isArray(entry.args)) continue;
    let args = replaceBundleArg(entry.args, bundle);
    if (args === null) continue;
    entries.push(name);
    if (isNpxCommand(entry.command)) {
      const result = hardenNpxArgs(args);
      args = result.args;
      if (result.changed) hardened.push(name);
    }
    nextServers[name] = { ...entry, args };
  }
  if (entries.length === 0) return null;
  return { config: { ...config, mcpServers: nextServers }, entries, hardened };
}

/**
 * Remove `bundle` from the Cursor config at `configPath`, atomically and under
 * a lock.
 *
 * The lock is ours, in our own config directory. Cursor's agent worker starts
 * its own copy of this server beside the IDE's, so two copies can arrive here
 * with the same bundle, and without the lock both would read the file and the
 * later rename would win over nothing but its own twin. Cursor itself never
 * takes this lock. Resolve config symlinks and atomically replace their backing
 * file, preserving its mode. Recheck the resolved path and original bytes before
 * publishing; a concurrent edit aborts cleanup rather than losing settings. A
 * narrow check-to-rename race remains (as in `jsonFileClient`), since rename
 * offers no compare-and-swap operation.
 *
 * Never throws for a file it cannot parse: the file belongs to Cursor, and
 * rewriting one this code does not understand would destroy every other
 * server in it. The caller reports the outcome instead.
 */
export function stripBundleFromCursorConfig(configPath: string, bundle: string): StripOutcome {
  return withFileLock(path.join(getConfigDir(), ".cursor-mcp.json.lock"), () => {
    let target: string;
    let raw: string;
    try {
      // Atomic rename must address the backing file, never the config link.
      target = toRealPath(configPath);
      if (!fs.statSync(target).isFile()) {
        return { kind: "unreadable", reason: "it is not a regular file" };
      }
      raw = fs.readFileSync(target, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing-file" };
      return { kind: "unreadable", reason: (err as Error).message };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // No parser message: it quotes the input, and the input holds the bundle.
      return { kind: "unreadable", reason: "it is not valid JSON" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "unreadable", reason: "it does not contain a JSON object" };
    }
    const result = stripBundleFromConfig(parsed as Record<string, unknown>, bundle);
    if (result === null) {
      return {
        kind: "not-found",
        cleanedEntry: hasCleanedEntry(parsed as Record<string, unknown>),
      };
    }
    const changed = new Error("it changed during credential cleanup; restart the server to retry");
    try {
      writeFileAtomic(target, `${JSON.stringify(result.config, null, 2)}\n`, {
        mode: 0o600,
        // Cursor's file, Cursor's mode.
        preserveExistingMode: true,
        precondition: () => {
          try {
            // Cursor does not take our lock. Abort if it saved new settings or
            // the link no longer names the file we read. Check the type before
            // reading so a non-regular replacement (e.g. a FIFO) is refused.
            if (
              toRealPath(configPath) !== target ||
              !fs.statSync(target).isFile() ||
              fs.readFileSync(target, "utf-8") !== raw
            ) {
              throw changed;
            }
          } catch {
            // Do not echo file content in an error: it still carries the bundle.
            throw changed;
          }
        },
      });
    } catch (err) {
      if (err === changed) return { kind: "unreadable", reason: changed.message };
      throw err;
    }
    return { kind: "stripped", entries: result.entries, hardened: result.hardened };
  });
}
