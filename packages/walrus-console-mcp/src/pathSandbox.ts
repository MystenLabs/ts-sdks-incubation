import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
 * `CONSOLE_MCP_ALLOWED_DIRS` env var. If neither yields a usable directory, the
 * path is rejected rather than allowed — an unsandboxed absolute path chosen by
 * the model (e.g. via prompt injection) must never reach `fs`.
 *
 * Containment is checked on **canonical, symlink-resolved** paths (see
 * `toRealPath`): a *live* symlink inside an allowed root that points outside it
 * cannot smuggle a read/write past the boundary, because it is resolved to its
 * real target before the check. The canonical path is returned so the caller's
 * `fs` call operates on the vetted target.
 *
 * A **dangling** symlink — one whose target does not exist yet — is rejected
 * outright rather than resolved. See `toRealPath` for why that trade is worth
 * making. Note this is specifically about *broken* links: ordinary live symlinks
 * are still followed and checked, and must be, or macOS breaks immediately
 * (`/tmp` -> `/private/tmp`, `/var`, symlinked home directories).
 *
 * Residual note: this does not close the check-to-use TOCTOU window — a parent
 * directory swapped for a symlink between this check and the caller's
 * `fs.readFile`/`fs.writeFile` would evade it. Full closure needs O_NOFOLLOW
 * open-based I/O in ConsoleStorageService; out of scope here.
 */

/** Env var naming extra sandbox roots for clients that do not advertise MCP roots. */
export const ALLOWED_DIRS_ENV = "CONSOLE_MCP_ALLOWED_DIRS";

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

/** Expand a leading `~` to the user's home directory. */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Parse `CONSOLE_MCP_ALLOWED_DIRS` (a `path.delimiter`-separated list) into
 * absolute directories. Entries are trimmed, `~`-expanded, and resolved; blank
 * entries are dropped.
 */
export function allowedDirsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[ALLOWED_DIRS_ENV];
  if (!raw) return [];
  return raw
    .split(delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
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
 * Resolve a user-supplied path to a canonical absolute path and confine it to
 * the allowed roots. Returns the symlink-resolved absolute path the tool should
 * actually read/write.
 *
 * Resolution rules:
 *   - `~` is expanded to the user's home directory.
 *   - An absolute path is used as-is.
 *   - A RELATIVE path is resolved against the first allowed root — the user's
 *     workspace, or the first `CONSOLE_MCP_ALLOWED_DIRS` entry — **never** the
 *     server's own `process.cwd()` (the console-mcp repo).
 *
 * Fails closed: with no client roots AND no `CONSOLE_MCP_ALLOWED_DIRS`, the call
 * throws with an actionable message rather than allowing an unsandboxed path.
 */
export async function resolvePathWithinRoots(
  server: RootsCapableServer,
  candidatePath: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const expanded = expandTilde(candidatePath);
  const caps = server.getClientCapabilities();
  const clientRoots = caps?.roots ? await listRootDirs(server, label) : [];
  // Env fallback covers "no roots capability", "capability but zero usable
  // roots", and a listRoots() error (all arrive here as an empty clientRoots).
  const rootDirs = clientRoots.length > 0 ? clientRoots : allowedDirsFromEnv(env);

  const [firstRoot] = rootDirs;
  if (firstRoot === undefined) {
    throw new Error(
      `${label} path "${candidatePath}" cannot be validated: your MCP client did not ` +
        `advertise any filesystem roots. Use a client that provides MCP roots (your ` +
        `workspace folders), or set ${ALLOWED_DIRS_ENV} to a "${delimiter}"-separated list ` +
        `of directories this server may access.`,
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
    realCandidate = toRealPath(resolved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} path "${candidatePath}" cannot be used: ${message}`);
  }
  const realRoots: string[] = [];
  for (const dir of rootDirs) {
    try {
      realRoots.push(toRealPath(dir));
    } catch {
      console.error(`[console-mcp] Ignoring unresolvable sandbox root "${dir}"`);
    }
  }
  if (!isWithinRoots(realCandidate, realRoots)) {
    throw new Error(
      `${label} path "${candidatePath}" resolves to "${realCandidate}", which is outside the ` +
        `allowed roots (${realRoots.join(", ")}). Use a path inside your workspace, or set ` +
        `${ALLOWED_DIRS_ENV} to include its directory.`,
    );
  }
  return realCandidate;
}
