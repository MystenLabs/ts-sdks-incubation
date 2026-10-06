import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { lstat, open as openFileAsync, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
  toNamespacedPath,
} from "node:path";
import { fileURLToPath } from "node:url";
import { type ConfigFileData, loadConfigFileOrEmpty } from "./configFile.js";
import { checkWindowsReservedName } from "./reservedFileNames.js";
import { MAX_TRANSFER_BYTES_ENV } from "./transferLimits.js";

/**
 * MCP "roots" path sandboxing.
 *
 * MCP clients can advertise a set of filesystem "roots" (file:// URIs) that
 * scope which directories a server is allowed to touch. Console's upload_file
 * (localPath) and download_file (destPath) read/write the local disk, so we
 * confine those paths to the allowed roots.
 *
 * Policy: **fail closed.** The allowed roots are the client's declared MCP roots
 * if it advertises any, otherwise the directories listed in the
 * `CONSOLE_MCP_ALLOWED_DIRS` env var, otherwise `allowedDirs` saved in the
 * installer config file. If none of those yields a usable directory, the path is
 * rejected rather than allowed — an unsandboxed absolute path chosen by the
 * model (e.g. via prompt injection) must never reach `fs`.
 *
 * Containment is checked on **canonical, symlink-resolved** paths (see
 * `toRealPathAsync`, the async twin of `toRealPath` that the request path uses
 * so this resolution no longer blocks the event loop the way the synchronous
 * `toRealPath` did — it is not itself cancellable, since `fs/promises`
 * `realpath`/`lstat`/`readlink` take no `AbortSignal`): a *live* symlink inside
 * an allowed root that points outside it cannot smuggle a read/write past the
 * boundary, because it is resolved to its real target before the check. The
 * canonical path is returned so the caller's `fs` call operates on the vetted
 * target.
 *
 * A **dangling** symlink — one whose target does not exist yet — is rejected
 * outright rather than resolved. See `toRealPath` for why that trade is worth
 * making. Note this is specifically about *broken* links: ordinary live
 * symlinks are still followed and checked by {@link resolvePathWithinRoots}
 * (upload, macOS `/tmp` → `/private/tmp`). {@link resolveDownloadDestWithinRoots}
 * (COMG-1039) additionally refuses a dest whose **final component** is a live
 * symlink so `download_file` cannot write through it.
 *
 * Residual note: this does not close the check-to-use TOCTOU window — a parent
 * directory swapped for a symlink between this check and the caller's
 * `fs.readFile`/`fs.writeFile` would evade it. The final path component IS
 * protected downstream (reads open with O_NOFOLLOW; writes go to a sibling temp
 * then rename), but a swap of an ANCESTOR directory between this check and the
 * open is not closed — see the scope note on `readFileWithinRoot` below.
 */

/** Env var naming extra sandbox roots for clients that do not advertise MCP roots. */
export const ALLOWED_DIRS_ENV = "CONSOLE_MCP_ALLOWED_DIRS";

// COMG-847: both allowed-roots errors below share these two fragments. Hoisted
// so a future wording change (or CLI rename) happens once instead of drifting
// between the two throw sites the way the surrounding prose already did once.
const CONFIG_CMD = "walrus-console-mcp config";
const CONFIG_ALLOWED_DIRS_HINT = `${CONFIG_CMD} --allowed-dirs <dir>`;
// Review on PR #58: "also works" undersold this — the env var BEATS the saved
// list (README's own wording), it doesn't merely coexist with it. Only ever
// surfaced when the env var isn't already the active source (see
// `describeAllowedDirsRemedy`), so this is always describing something the
// reader could still opt into, not restating what already happened.
const HAND_RUN_ENV_HINT = `Running the server by hand? ${ALLOWED_DIRS_ENV} beats any saved folders when set, as a "${delimiter}"-separated list.`;

/**
 * POSIX single-quoting for a path printed inside a copy-pasteable command. A
 * single quote cannot appear inside single quotes, so an embedded one closes
 * the string, escapes itself, and reopens it — the shape `'\''`. Shared with
 * `bin/configure.ts`'s own "--allowed-dirs not applied" notice, which needs
 * the identical round-trip command for the identical reason.
 */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Which source actually determined the current `rootDirs` — see `selectAllowedDirs`. */
export type AllowedDirsSource = "clientRoots" | "env" | "file";

/**
 * How to widen the sandbox to include a folder, branching on which source won
 * (COMG-847 review on PR #58). Client roots and the env var both beat the
 * saved `allowedDirs` list outright — recommending `config --allowed-dirs`
 * while either of those is the reason the call is refused would print a
 * remedy that changes nothing. And once the saved list IS the winning source,
 * `config --allowed-dirs` REPLACES it rather than adding to it (`validateSilent`
 * assigns the whole array), so naming a bare `<dir>` placeholder there would
 * have the reader silently discard every folder they already had — the
 * round-trip command below carries the existing ones forward instead.
 */
function describeAllowedDirsRemedy(
  source: AllowedDirsSource,
  realRoots: readonly string[],
): string {
  switch (source) {
    case "clientRoots":
      return (
        "Your MCP client's advertised workspace folders are the sandbox right now, so " +
        `\`${CONFIG_ALLOWED_DIRS_HINT}\` would not change this — open (or add) the target ` +
        "folder in your client's workspace, then retry."
      );
    case "env":
      return (
        `\`${ALLOWED_DIRS_ENV}\` is set and beats the saved folder list, so \`${CONFIG_ALLOWED_DIRS_HINT}\` ` +
        `would not change this — add the folder to ${ALLOWED_DIRS_ENV} instead (a ` +
        `"${delimiter}"-separated list), then retry.`
      );
    case "file": {
      // `--allowed-dirs` is repeatable and each call REPLACES the saved list
      // (never appends), so the only remedy that does not silently drop the
      // folders already saved is one that names every one of them plus the
      // new one — matching the round-trip command bin/configure.ts already
      // prints for the same reason (its "--allowed-dirs not applied" notice).
      const roundTrip = [
        CONFIG_CMD,
        ...realRoots.map((dir) => `--allowed-dirs ${shellQuote(dir)}`),
        "--allowed-dirs <dir>",
      ].join(" ");
      return `Add its folder without dropping the others already saved: \`${roundTrip}\`. (${HAND_RUN_ENV_HINT})`;
    }
  }
}

interface Root {
  readonly uri: string;
  readonly name?: string | undefined;
}

/** Minimal slice of the MCP `Server` we depend on (keeps this unit testable). */
export interface RootsCapableServer {
  getClientCapabilities(): { readonly roots?: unknown } | undefined;
  listRoots(): Promise<{ readonly roots: readonly Root[] }>;
}

/**
 * Convert MCP roots to absolute directory paths. Only `file:` URIs are
 * meaningful for local sandboxing; any other scheme is ignored.
 */
export function rootsToDirs(roots: readonly Root[]): string[] {
  const dirs: string[] = [];
  for (const root of roots) {
    if (!root.uri.startsWith("file:")) continue;
    try {
      dirs.push(resolve(fileURLToPath(root.uri)));
    } catch {
      // Malformed file:// URI — skip rather than crash the whole check.
    }
  }
  return dirs;
}

/**
 * True if `candidate` resolves to a location inside (or equal to) any of
 * `rootDirs`. Pure and synchronous so it can be unit-tested directly.
 *
 * Containment is checked on resolved absolute paths with a separator boundary,
 * so `/srv/data-evil` is NOT treated as being inside `/srv/data`. Callers are
 * expected to pass symlink-resolved paths (see `toRealPath`); an empty
 * `rootDirs` returns false.
 */
export function isWithinRoots(candidate: string, rootDirs: readonly string[]): boolean {
  const resolved = resolve(candidate);
  for (const dir of rootDirs) {
    const root = resolve(dir);
    if (resolved === root || resolved.startsWith(root + sep)) return true;
  }
  return false;
}

/**
 * Undo the Windows long-path prefix on a candidate path, or refuse it.
 *
 * `\\?\` tells Win32 to skip path normalization, and it is what users reach for
 * to get past MAX_PATH. It is not needed here: `src/atomicWrite.ts` and this
 * file's own read helpers apply it themselves, at the actual `fs` call, via
 * `path.toNamespacedPath` — see `forFs` there for why (in short: a user's own
 * machine cannot be assumed to have Windows' `LongPathsEnabled` policy set, so
 * something in this codebase has to add the prefix back for the write to
 * reliably succeed; it happens right before the syscall instead of here). The
 * sandbox itself must never see the prefix: its containment check compares
 * normalized paths, and the prefixed spelling of a path inside a root does not
 * start with that root.
 *
 * Only the two forms that name an ordinary location are unwrapped:
 * `\\?\C:\…` becomes `C:\…` (its drive letter uppercased — `isWithinRoots`
 * compares strings literally, so `\\?\c:\…` and a root typed `C:\…` must not
 * silently fail to match just because of how the user cased the drive letter)
 * and `\\?\UNC\server\share\…` becomes `\\server\share\…`, requiring both a
 * server and a share component; a name with only one, or one built from `..`,
 * is refused rather than resolved into whatever `path.resolve` happens to make
 * of it. Every other namespace (`\\?\GLOBALROOT\…`, `\\?\Volume{…}\…`) is
 * refused outright. Stripping the prefix from one of those would leave a
 * RELATIVE path, which `resolvePathWithinRoots` anchors to the first allowed
 * root — so a path naming some other device would come back approved as a
 * file inside the sandbox. The UNC form's requirement of a real server AND
 * share also closes the one way the unwrap could otherwise reintroduce that
 * same prefix (a "server" of literally `?`, unwrapping to `\\?\...` again) —
 * checked for good measure, since the two components alone do not make that
 * geometrically impossible for every input.
 *
 * `\?\C:\…` — the prefix with one backslash lost, typically to JSON escaping — is
 * refused with that diagnosis. Win32 reads it as a rooted path on the current
 * drive (`C:\?\C:\…`), which can never exist since `?` is not a legal file-name
 * character, so rejecting it loses nothing and says what went wrong.
 *
 * The result is validated like any other path. The caller writes to the
 * canonical path that validation returns, never to the prefixed input.
 */
export function stripWin32LongPathPrefix(p: string): string {
  const prefixed = /^[\\/]{2}\?[\\/]([\s\S]*)$/.exec(p);
  if (prefixed) {
    const rest = prefixed[1] ?? "";
    // Requires a separator after the drive letter — `\\?\C:` alone (no
    // trailing `\`) must NOT unwrap to the drive-RELATIVE string "C:", which
    // `resolvePathWithinRoots` would then anchor to the first allowed root
    // instead of refusing.
    const drive = /^([A-Za-z]):[\\/]/.exec(rest);
    if (drive) return `${(drive[1] as string).toUpperCase()}${rest.slice(1)}`;
    // Both a server AND a share are required, each at least one character and
    // neither a separator: `UNC\data` (one component) and `UNC\..` are
    // refused rather than silently resolved as something else by
    // `path.win32.resolve`, which does not parse a UNC root with fewer than
    // two components and falls back to the current drive instead.
    const unc = /^UNC[\\/]([^\\/]+)[\\/]([^\\/]+)((?:[\\/][\s\S]*)?)$/i.exec(rest);
    if (unc) {
      const [, server, share, tail] = unc;
      const rebuilt = `\\\\${server}\\${share}${tail}`;
      if (/^[\\/]{2}\?[\\/]/.test(rebuilt)) {
        throw new Error(
          'the Windows "\\\\?\\UNC\\…" form must not itself unwrap to another "\\\\?\\…" path; ' +
            "give a real server and share name.",
        );
      }
      return rebuilt;
    }
    throw new Error(
      'the Windows "\\\\?\\" prefix is only accepted before a drive path ("\\\\?\\C:\\…") ' +
        'or a network share ("\\\\?\\UNC\\server\\share\\…").',
    );
  }
  if (/^[\\/]\?(?:[\\/]|$)/.test(p)) {
    throw new Error(
      'it starts with "\\?\\", which looks like the Windows long-path prefix "\\\\?\\" with a ' +
        'backslash lost (often to JSON escaping). Use "\\\\?\\C:\\…", or just "C:\\…" — long ' +
        "paths work without the prefix.",
    );
  }
  return p;
}

/** Expand a leading `~` to the user's home directory. */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Split a raw allowed-dirs string on `delim` (default: `path.delimiter`).
 *
 * Callers that need Windows-safe parsing of a *single* path must pass `";"`
 * (or not split at all): splitting on `:` would cut a `C:\…` drive letter.
 * Repeatable `--allowed-dirs` flags never go through this with `:`.
 */
export function splitAllowedDirList(raw: string, delim: string = delimiter): string[] {
  return raw
    .split(delim)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Confirm `input` names an existing directory and return its canonical path.
 *
 * Used by the installer / `config --allowed-dirs` *write* path so we refuse to
 * persist a file, a missing folder, or a dangling symlink. The runtime sandbox
 * is looser (a download destination may not exist yet); this is not that check.
 *
 * `platform` is injectable so a test can exercise the win32-only `\\?\`
 * handling below deterministically on any CI runner, the same way
 * `resolveCandidateWithinRoots` does for the request path.
 */
export function validateAllowedDirectory(
  input: string,
  platform: NodeJS.Platform = process.platform,
): { dir: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: "Directory path is empty." };
  // A saved/typed root gets the identical `\\?\` treatment a download/upload
  // CANDIDATE gets in `resolveCandidateWithinRoots` — see `stripWin32LongPathPrefix`'s
  // docstring, and the comment on `allowedDirsFromEnv`/`allowedDirsFromConfig`
  // below for what goes wrong if a root keeps the prefix a candidate loses.
  let unprefixed: string;
  try {
    unprefixed = platform === "win32" ? stripWin32LongPathPrefix(trimmed) : trimmed;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const resolved = resolve(expandTilde(unprefixed));
  let real: string;
  try {
    real = toRealPath(resolved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message };
  }
  try {
    if (!statSync(real).isDirectory()) {
      return { error: `"${trimmed}" is not a directory.` };
    }
  } catch {
    return { error: `"${trimmed}" does not exist — create the folder first, then re-run.` };
  }
  return { dir: real };
}

/**
 * Strip a Windows long-path prefix from one raw ALLOWED-DIR entry, or drop it.
 *
 * A root has to go through the identical unwrap a candidate gets in
 * `resolveCandidateWithinRoots`, and for the same reason stated on
 * `stripWin32LongPathPrefix`: `isWithinRoots`'s containment check is a literal
 * string comparison, so a root parsed WITH the prefix still on it can never
 * contain a candidate the prefix was stripped FROM — which would silently lock
 * out exactly the user who reached for the prefix to configure a long-path
 * folder in the first place, with every candidate under it refused as
 * "outside the folders this server can access."
 *
 * Unlike a candidate, a bad entry here is dropped with a warning rather than
 * thrown: this parses a LIST with no per-entry error channel, and one
 * unparseable root must not take the rest of the list down with it — the same
 * trade `resolveCandidateWithinRoots` already makes for a root that fails to
 * canonicalize.
 */
function stripRootPrefix(p: string, platform: NodeJS.Platform): string | null {
  if (platform !== "win32") return p;
  try {
    return stripWin32LongPathPrefix(p);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[console-mcp] Ignoring an allowed directory that could not be used: ${message}`);
    return null;
  }
}

/**
 * Parse `CONSOLE_MCP_ALLOWED_DIRS` (a `path.delimiter`-separated list) into
 * absolute directories. Entries are trimmed, `~`-expanded, and resolved; blank
 * entries are dropped. `platform` is injectable — see `validateAllowedDirectory`.
 */
export function allowedDirsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const raw = env[ALLOWED_DIRS_ENV];
  if (!raw) return [];
  return splitAllowedDirList(raw)
    .map((p) => stripRootPrefix(p, platform))
    .filter((p): p is string => p !== null)
    .map((p) => resolve(expandTilde(p)));
}

/**
 * Absolute directories from a saved config's `allowedDirs` array. Non-strings
 * and blanks are dropped; `~` is expanded. Does not require the directories to
 * exist — a folder deleted after install should fail the path check, not crash
 * config load. `platform` is injectable — see `validateAllowedDirectory`.
 */
export function allowedDirsFromConfig(
  file: ConfigFileData = loadConfigFileOrEmpty(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const raw = file.allowedDirs;
  if (!raw) return [];
  return raw
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => stripRootPrefix(p, platform))
    .filter((p): p is string => p !== null)
    .map((p) => resolve(expandTilde(p)));
}

/**
 * The target of `p` if it is a symlink, else undefined.
 *
 * `lstatSync` inspects the link itself rather than following it, so it succeeds
 * exactly where `realpathSync` throws. That is what lets a genuinely nonexistent
 * path be told apart from a DANGLING symlink — the two are indistinguishable
 * from `realpathSync`'s error alone. The target is read only to name it in the
 * rejection message; nothing resolves through it.
 *
 * Note the `catch` carries two meanings, not one — see the comment on it before
 * reading the caller's walk-up as exhaustively safe.
 */
function readLinkTarget(p: string): string | undefined {
  try {
    if (!lstatSync(p).isSymbolicLink()) return undefined;
    return readlinkSync(p);
  } catch {
    // Two different states, deliberately given the same answer: the path does
    // not exist at all, or it cannot be stat'ed (EACCES). Both report "not a
    // symlink" and the caller walks up, re-appending the segment lexically —
    // structurally the same shape as the dangling-link bug this file guards.
    //
    // Sound for EACCES because of what lstat needs: search permission on the
    // PARENT, not on the path itself. If that is denied here, the eventual
    // writeFile through the same parent is denied too. So the walk-up can hand
    // back a lexical path that passes containment, but nothing can ever be
    // written through it — the failure is closed rather than an escape.
    // Confirmed against a fixture: an out-of-sandbox symlink inside a 000
    // directory is approved by the check and then refused EACCES by the write.
    return undefined;
  }
}

/**
 * Async twin of {@link readLinkTarget} (`fsp.lstat`/`readlink` instead of the
 * `*Sync` calls), so `toRealPathAsync` never blocks the event loop while it
 * walks up a path (M9). Same two states folded into the same "not a symlink"
 * answer, for the same reason — see the sync version's comment above before
 * treating this catch as exhaustively safe.
 */
async function readLinkTargetAsync(p: string): Promise<string | undefined> {
  try {
    if (!(await lstat(p)).isSymbolicLink()) return undefined;
    return await readlink(p);
  } catch {
    return undefined;
  }
}

/**
 * Canonical (symlink-free) absolute form of `p`. When the full path does not
 * exist yet — the common case for a download destination — the deepest EXISTING
 * ancestor is realpath-resolved and the not-yet-created suffix re-appended, so a
 * symlinked parent directory cannot redirect the write outside the sandbox.
 *
 * Throws on a **dangling** symlink anywhere along the path. `realpathSync` fails
 * identically for "no such path" and "dangling link", and treating them alike is
 * the bug this guards: the link's own name gets re-appended to its real parent,
 * producing a path that sits inside the root while the eventual `writeFile`
 * follows the link out of it.
 *
 * Rejecting rather than resolving the target is a deliberate trade. Resolving
 * needs recursion (a link may point at another link), which needs a depth cap to
 * terminate cycles, which needs a `depth` parameter — and that parameter is a
 * quiet hazard, since `paths.map(toRealPath)` would feed the array index into it
 * and TypeScript accepts it silently. Rejecting costs one narrow case: a
 * pre-existing broken link, whose target's parent directory already exists, used
 * as a download destination. Ordinary destinations are plain paths that hold no
 * symlink at all and never reach this branch. Cycles fall out for free — every
 * link in a cycle is dangling, so the first hop is rejected with no counter.
 *
 * Plain `realpathSync` (not `.native`) is used so results stay free of Windows
 * `\\?\` prefixes that would break the separator-boundary check in
 * `isWithinRoots`.
 */
export function toRealPath(p: string): string {
  const resolved = resolve(p);
  let existing = resolved;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(existing);
      return suffix.length === 0 ? real : join(real, ...suffix);
    } catch {
      const target = readLinkTarget(existing);
      if (target !== undefined) {
        throw new Error(
          `"${existing}" is a broken symlink (it points at "${target}", which does not exist). ` +
            `Point it at an existing location, or remove the link and use a real path.`,
        );
      }
      const parent = dirname(existing);
      if (parent === existing) return resolved; // reached the fs root; nothing exists (defensive)
      suffix.unshift(basename(existing));
      existing = parent;
    }
  }
}

/**
 * Async twin of {@link toRealPath} (`fsp.realpath` instead of `realpathSync`).
 *
 * `resolvePathWithinRoots` runs on the MCP request path, inside the fiber
 * `runPromise` drives — canonicalizing there with the synchronous `toRealPath`
 * blocked the whole event loop (every other in-flight request, the transport's
 * heartbeat, cancellation itself) for as long as `realpathSync` took to answer,
 * which is unbounded against a stalled network mount (M9). This does the same
 * walk-up-on-ENOENT resolution and the same dangling-symlink rejection as
 * {@link toRealPath} — see its docstring for the depth-cap hazard that rules
 * out resolving through a broken link and the cycle argument, both unchanged
 * here.
 *
 * One thing does NOT carry over from that docstring: the "plain, not `.native`"
 * choice has no async equivalent to make. `fsp.realpath` calls straight into
 * the native binding; unlike the sync `fs.realpath`/`realpathSync`, there is no
 * separate JS-implemented walk to pick instead. The `\\?\` prefix still does
 * not appear in this function's output on Windows, for an unrelated reason:
 * libuv's Windows `realpath` strips it from the underlying
 * `GetFinalPathNameByHandleW` result before returning, regardless of which
 * layer called in. `isWithinRoots`'s containment check still depends on that
 * absence — it is just not this function's own doing.
 *
 * `toRealPath` itself stays exported: `validateAllowedDirectory`, the
 * installer, `cliArgs.ts`, and `credentials.ts` all canonicalize paths outside
 * the request path, where synchronous is fine.
 */
export async function toRealPathAsync(p: string): Promise<string> {
  const resolved = resolve(p);
  let existing = resolved;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = await realpath(existing);
      return suffix.length === 0 ? real : join(real, ...suffix);
    } catch {
      const target = await readLinkTargetAsync(existing);
      if (target !== undefined) {
        throw new Error(
          `"${existing}" is a broken symlink (it points at "${target}", which does not exist). ` +
            `Point it at an existing location, or remove the link and use a real path.`,
        );
      }
      const parent = dirname(existing);
      if (parent === existing) return resolved; // reached the fs root; nothing exists (defensive)
      suffix.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** Fetch the client's roots as absolute dirs, or [] if unsupported/empty/errored. */
async function listRootDirs(server: RootsCapableServer, label: string): Promise<string[]> {
  try {
    const { roots } = await server.listRoots();
    return rootsToDirs(roots);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[console-mcp] Failed to list MCP roots (${message}) — falling back to ${ALLOWED_DIRS_ENV} for ${label}`,
    );
    return [];
  }
}

/**
 * Read a file that `resolvePathWithinRoots` has already vetted, re-checking
 * containment at the moment of the open.
 *
 * Path validation and path-based I/O are two separate walks of the same path, and
 * anything that swaps the final component in between is read instead of the file
 * that was checked. `O_NOFOLLOW` closes that: if the target is a symlink at open
 * time — planted after validation, or racing it — the open fails with ELOOP
 * rather than reading through it.
 *
 * The size limit is enforced from the OPEN DESCRIPTOR's `fstat`, not a separate
 * `stat()` on the path, for the same reason: a stat-then-read pair can be raced,
 * and it would also be measuring a file we are not necessarily about to read.
 * Reading via `readFileSync(fd)` after the check means the bytes and the size
 * come from one descriptor.
 *
 * NOTE on scope: this closes swaps of the FINAL component. A swap of an ancestor
 * directory between validation and open is not closed here — that needs
 * `openat2(RESOLVE_NO_SYMLINKS)` or descriptor-relative traversal, which Node
 * exposes on no platform. Exploiting it requires a process already able to write
 * inside the sandbox roots and win a race, which is a strictly weaker position
 * than simply reading the credential file directly.
 */
export function readFileWithinRoot(
  realPath: string,
  opts: { maxBytes: number; label: string },
): Buffer {
  let fd: number;
  try {
    // toNamespacedPath: a no-op everywhere but win32, where it is what makes
    // this open succeed on a long path regardless of the machine's
    // LongPathsEnabled policy — see the identical reasoning on `forFs` in
    // src/atomicWrite.ts. `realPath` itself (used in every message below)
    // stays the plain, already-validated spelling.
    fd = openSync(toNamespacedPath(realPath), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new Error(
        `${opts.label} path "${realPath}" is a symbolic link now but was not when it was ` +
          `validated. Refusing to read it.`,
      );
    }
    throw new Error(`${opts.label} path "${realPath}" could not be opened: ${String(error)}`);
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`${opts.label} path "${realPath}" is not a regular file.`);
    }
    if (stat.size > opts.maxBytes) {
      throw new Error(
        `${opts.label} file is ${stat.size} bytes, over the ${opts.maxBytes}-byte limit. ` +
          `The server holds the plaintext and its ciphertext in memory at once, so an ` +
          `oversized transfer can take down the whole MCP process. Split or compress it, ` +
          `or raise ${MAX_TRANSFER_BYTES_ENV}.`,
      );
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Async, optionally cancellable sibling of `readFileWithinRoot`, for the transfer
 * path (a source-file upload) where blocking the event loop on a large read is
 * not acceptable.
 *
 * Identical protections: `O_NOFOLLOW` so a symlink swapped in after validation
 * fails the open with ELOOP rather than being read through, and the size limit
 * taken from the OPEN descriptor's `fstat` so the bytes and the size come from one
 * handle and cannot be raced apart. The read itself takes the caller's
 * `AbortSignal`, so a cancelled MCP request stops it instead of buffering a file
 * nobody is waiting for.
 */
export async function readFileWithinRootAsync(
  realPath: string,
  opts: { maxBytes: number; label: string; signal?: AbortSignal },
): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof openFileAsync>>;
  try {
    handle = await openFileAsync(
      toNamespacedPath(realPath),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new Error(
        `${opts.label} path "${realPath}" is a symbolic link now but was not when it was ` +
          `validated. Refusing to read it.`,
      );
    }
    throw new Error(`${opts.label} path "${realPath}" could not be opened: ${String(error)}`);
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`${opts.label} path "${realPath}" is not a regular file.`);
    }
    if (stat.size > opts.maxBytes) {
      throw new Error(
        `${opts.label} file is ${stat.size} bytes, over the ${opts.maxBytes}-byte limit. ` +
          `The server holds the plaintext and its ciphertext in memory at once, so an ` +
          `oversized transfer can take down the whole MCP process. Split or compress it, ` +
          `or raise ${MAX_TRANSFER_BYTES_ENV}.`,
      );
    }
    return await handle.readFile(opts.signal ? { signal: opts.signal } : {});
  } finally {
    await handle.close();
  }
}

/**
 * The sandbox's allowed folders and which source supplied them: client MCP
 * roots, else `CONSOLE_MCP_ALLOWED_DIRS`, else the saved `allowedDirs`. Empty
 * `rootDirs` (with `source: "file"`) means nothing is configured: fail closed.
 *
 * Shared by `resolveCandidateWithinRoots` and `ping_console` so the two cannot
 * drift. A `listRoots()` failure falls through to the next source rather than
 * throwing (see `listRootDirs`). Folders are absolute, not yet canonicalized.
 * Parameters as on {@link resolvePathWithinRoots}; `label` only names the
 * caller in `listRootDirs`' stderr line.
 */
export async function selectAllowedDirs(
  server: RootsCapableServer,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  fileAllowedDirs?: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<{ source: AllowedDirsSource; rootDirs: string[] }> {
  const caps = server.getClientCapabilities();
  const clientRoots = caps?.roots ? await listRootDirs(server, label) : [];
  // Env, then the installer-saved list, cover "no roots capability", "capability
  // but zero usable roots", and a listRoots() error (all arrive here as empty
  // clientRoots). Client roots still win outright when present.
  const envDirs = allowedDirsFromEnv(env, platform);
  const fileDirs =
    fileAllowedDirs !== undefined
      ? [...fileAllowedDirs]
      : allowedDirsFromConfig(loadConfigFileOrEmpty(), platform);
  const source: AllowedDirsSource =
    clientRoots.length > 0 ? "clientRoots" : envDirs.length > 0 ? "env" : "file";
  const rootDirs = source === "clientRoots" ? clientRoots : source === "env" ? envDirs : fileDirs;
  return { source, rootDirs };
}

/**
 * Shared containment walk for {@link resolvePathWithinRoots} and
 * {@link resolveDownloadDestWithinRoots}. `absPath` is the tilde-expanded,
 * relative-anchored path before realpath; `realCandidate` is the canonical
 * path after containment. Upload still needs live in-root follow (macOS
 * `/tmp` → `/private/tmp`); download refuses a dest whose final component
 * is a symlink on top of this result.
 */
async function resolveCandidateWithinRoots(
  server: RootsCapableServer,
  candidatePath: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  fileAllowedDirs?: readonly string[],
  // Injectable so a test can drive the win32-only `\\?\` handling below (here
  // AND in the root parsers it calls) deterministically on any CI runner.
  // Without this, deleting the whole strip step below and the suite stays
  // green: the ONLY thing that exercises it is the `describe.runIf(win32)`
  // block in tests/pathSandbox.win32LongPath.test.ts, i.e. one CI job.
  platform: NodeJS.Platform = process.platform,
): Promise<{ realCandidate: string; absPath: string }> {
  let unprefixed: string;
  try {
    unprefixed = platform === "win32" ? stripWin32LongPathPrefix(candidatePath) : candidatePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} path "${candidatePath}" cannot be used: ${message}`);
  }
  const expanded = expandTilde(unprefixed);
  const { source, rootDirs } = await selectAllowedDirs(
    server,
    label,
    env,
    fileAllowedDirs,
    platform,
  );

  const [firstRoot] = rootDirs;
  if (firstRoot === undefined) {
    // COMG-847: lead with the command a Console user actually has — installed
    // via `npx ... install`, they never set an env var and have no way to act
    // on being told to. `${ALLOWED_DIRS_ENV}` stays present (a hand-run server
    // still needs it), but as a secondary hint, never the only instruction.
    // Says "no roots are available", not "your client didn't advertise any" —
    // this branch is also reached when a client that DOES support roots had
    // `listRoots()` throw or return empty (see `listRootDirs` below), so the
    // stronger claim would send that user chasing the wrong fix.
    throw new Error(
      `${label} path "${candidatePath}" cannot be used: no folders are set up yet for this ` +
        `server to access, and no filesystem roots are available from your MCP client either. ` +
        `Run \`${CONFIG_ALLOWED_DIRS_HINT}\` to add one, or use a client that advertises MCP ` +
        `roots (your open workspace folders). (${HAND_RUN_ENV_HINT})`,
    );
  }

  // Anchor relative paths to the first allowed root, not the server's cwd.
  const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(firstRoot, expanded);

  // The candidate is held to a stricter standard than the roots. If it cannot be
  // canonicalized the whole call fails — it is the thing being vetted, so there
  // is nothing to fall back to. A ROOT that cannot be canonicalized is merely
  // dropped: `isWithinRoots` is an OR across roots, so a shorter list can only
  // ever accept fewer paths, and an empty list rejects everything.
  let realCandidate: string;
  try {
    realCandidate = await toRealPathAsync(resolved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} path "${candidatePath}" cannot be used: ${message}`);
  }
  const realRoots: string[] = [];
  for (const dir of rootDirs) {
    try {
      realRoots.push(await toRealPathAsync(dir));
    } catch {
      console.error(`[console-mcp] Ignoring unresolvable sandbox root "${dir}"`);
    }
  }
  if (!isWithinRoots(realCandidate, realRoots)) {
    // COMG-847: name the refused path and the folders that ARE allowed today.
    // The remedy is delegated to `describeAllowedDirsRemedy`, branched on
    // `source` — review on PR #58 found the original single remedy
    // (`config --allowed-dirs`) was a no-op whenever client roots or the env
    // var was the actual winning source (both beat the saved list outright),
    // and wrong advice in the one source it does affect: `--allowed-dirs`
    // REPLACES the saved list, so "add its folder" silently dropped every
    // folder already there instead.
    throw new Error(
      `${label} path "${candidatePath}" resolves to "${realCandidate}", which is outside the ` +
        `folders this server can access. Allowed folders: ${realRoots.join(", ") || "none"}. ` +
        `${describeAllowedDirsRemedy(source, realRoots)}`,
    );
  }
  return { realCandidate, absPath: resolved };
}

/**
 * Resolve a user-supplied path to a canonical absolute path and confine it to
 * the allowed roots. Returns the symlink-resolved absolute path the tool should
 * actually **read** (`upload_file`). Download dests use
 * {@link resolveDownloadDestWithinRoots} so a dest whose final component is a
 * symlink is refused rather than followed.
 *
 * Resolution rules:
 *   - `~` is expanded to the user's home directory.
 *   - An absolute path is used as-is.
 *   - A RELATIVE path is resolved against the first allowed root — the user's
 *     workspace, or the first `CONSOLE_MCP_ALLOWED_DIRS` / saved `allowedDirs`
 *     entry — **never** the server's own `process.cwd()` (the console-mcp repo).
 *
 * Fails closed: with no client roots AND no `CONSOLE_MCP_ALLOWED_DIRS` AND no
 * saved `allowedDirs`, the call throws with an actionable message rather than
 * allowing an unsandboxed path.
 *
 * `fileAllowedDirs` is the saved-config fallback. Omit it to read
 * `~/.config/walrus-console-mcp/config.json`; pass `[]` in tests so a
 * developer's real config cannot un-fail-close the suite.
 *
 * `platform` is injectable — see `resolveCandidateWithinRoots`.
 */
export async function resolvePathWithinRoots(
  server: RootsCapableServer,
  candidatePath: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  fileAllowedDirs?: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const { realCandidate } = await resolveCandidateWithinRoots(
    server,
    candidatePath,
    label,
    env,
    fileAllowedDirs,
    platform,
  );
  return realCandidate;
}

/**
 * COMG-1039: download dest resolver. Same containment as
 * {@link resolvePathWithinRoots}, then refuses a dest whose final component is
 * a symlink — including when the target is inside the roots and including
 * `overwrite: true`. Do not follow the link and do not rename over it; the
 * agent must give a real file path. Upload keeps {@link resolvePathWithinRoots}
 * so live in-root links (macOS `/tmp` → `/private/tmp`) still resolve.
 *
 * Containment still realpath's, so an outside-root target keeps the existing
 * outside-roots error rather than this symlink message. A missing dest
 * (`ENOENT`) is allowed; other `lstat` errors are not treated as "not a
 * symlink".
 *
 * `platform` is injectable — see `resolveCandidateWithinRoots`.
 */
export async function resolveDownloadDestWithinRoots(
  server: RootsCapableServer,
  candidatePath: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  fileAllowedDirs?: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const { realCandidate, absPath } = await resolveCandidateWithinRoots(
    server,
    candidatePath,
    label,
    env,
    fileAllowedDirs,
    platform,
  );

  // Checked before any lstat, and on every platform, not only win32. Windows
  // reserves these as device names for the whole segment before the first dot,
  // no matter the extension. It does not mean the write fails outright: a
  // plain write CREATES an ordinary file holding real bytes on macOS and
  // Linux (there is no such reservation there at all), and on Windows the
  // namespaced form this server writes through (`forFs` in
  // src/atomicWrite.ts) explicitly disables the "cooked" path parsing that
  // maps a name like `NUL.txt` to the device — so it too lands a real file on
  // disk. The problem is what happens AFTER that: every ordinary Windows tool
  // (Explorer, cmd.exe, most other programs) still goes through cooked
  // parsing, so none of them can open, rename or delete a file with this name
  // again. Checked unconditionally because the bucket this name came from can
  // be downloaded again, or the resulting file synced, onto a Windows machine
  // later — a name that behaves normally on macOS or Linux today can still
  // become effectively stuck there tomorrow.
  //
  // Checked against `absPath` — the caller's own path, before symlink
  // resolution — not `realCandidate`: a caller-named `ok.txt` that happens to
  // be a symlink TO `NUL.txt` is a symlink problem, refused a few lines below
  // with a message that actually says so. Checking the resolved target here
  // instead would misattribute that refusal to a reserved name the caller
  // never typed.
  const reserved = checkWindowsReservedName(basename(absPath));
  if (reserved) {
    throw new Error(
      `${label} path "${candidatePath}" ends in "${basename(absPath)}", which Windows ` +
        `reserves as the ${reserved.reserved} device name. Most Windows programs cannot open, ` +
        `move or delete a file with this name. Choose a different name, for example ` +
        `"${reserved.suggestion}".`,
    );
  }

  const st = await lstat(absPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} path "${candidatePath}" cannot be used: ${message}`);
  });
  if (st === undefined) {
    return realCandidate;
  }
  if (st.isSymbolicLink()) {
    throw new Error(
      `${label} path "${candidatePath}" is a symlink to "${realCandidate}". ` +
        `Refusing to write through a symlink; give a real file path.`,
    );
  }
  if (st.isDirectory()) {
    throw new Error(
      `${label} path "${candidatePath}" is a directory. Give a path that names a file inside it.`,
    );
  }
  if (!st.isFile()) {
    throw new Error(
      `${label} path "${candidatePath}" is not a regular file. Give a real file path.`,
    );
  }
  return realCandidate;
}
