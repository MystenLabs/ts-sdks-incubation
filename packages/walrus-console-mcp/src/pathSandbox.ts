import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * MCP "roots" path sandboxing.
 *
 * MCP clients can advertise a set of filesystem "roots" (file:// URIs) that
 * scope which directories a server is allowed to touch. Console's upload_file
 * (localPath) and download_file (destPath) read/write the local disk, so we
 * confine those paths to the client's declared roots when they exist.
 *
 * Policy: **enforce-when-present, fail-open-when-absent.** If the client
 * declares roots, a path outside every root is rejected. If the client does
 * not support roots (or lists none), we allow the path and log a notice — this
 * keeps the server usable with clients that haven't adopted roots yet.
 */

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
 * An empty `rootDirs` returns false — callers decide whether "no roots" means
 * fail-open (allow) or fail-closed (deny). Containment is checked on resolved
 * absolute paths with a separator boundary, so `/srv/data-evil` is NOT treated
 * as being inside `/srv/data`.
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

/** Fetch the client's roots as absolute dirs, or [] if unsupported/empty/errored. */
async function listRootDirs(server: RootsCapableServer, label: string): Promise<string[]> {
  try {
    const { roots } = await server.listRoots();
    return rootsToDirs(roots);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[console-mcp] Failed to list MCP roots (${message}) — ${label} path not sandboxed`,
    );
    return [];
  }
}

/**
 * Resolve a user-supplied path to an absolute path and confine it to the
 * client's declared roots. Returns the absolute path the tool should actually
 * read/write.
 *
 * Resolution rules — the key portability guarantee:
 *   - `~` is expanded to the user's home directory.
 *   - An absolute path is used as-is.
 *   - A RELATIVE path is resolved against the user's first workspace root
 *     (the directory the MCP client advertises), **never** the server's own
 *     `process.cwd()` — which is the console-mcp repo and would otherwise trap
 *     every relative path inside the repo regardless of where the user works.
 *   - With no roots advertised, a relative path falls back to `process.cwd()`.
 *
 * Sandbox policy is unchanged: **enforce-when-present, fail-open-when-absent.**
 */
export async function resolvePathWithinRoots(
  server: RootsCapableServer,
  candidatePath: string,
  label: string,
): Promise<string> {
  const expanded = expandTilde(candidatePath);
  const caps = server.getClientCapabilities();
  const rootDirs = caps?.roots ? await listRootDirs(server, label) : [];

  // Anchor relative paths to the user's workspace, not the server's cwd.
  const workspace = rootDirs[0];
  const resolved =
    isAbsolute(expanded) || workspace === undefined
      ? resolve(expanded)
      : resolve(workspace, expanded);

  if (!caps?.roots) {
    console.error(
      `[console-mcp] Client does not support MCP roots — ${label} path not sandboxed: ${resolved}`,
    );
    return resolved;
  }
  if (rootDirs.length === 0) {
    console.error(
      `[console-mcp] Client declared no usable roots — ${label} path not sandboxed: ${resolved}`,
    );
    return resolved;
  }
  if (!isWithinRoots(resolved, rootDirs)) {
    throw new Error(
      `${label} path "${candidatePath}" resolves to "${resolved}", which is outside the ` +
        `allowed workspace roots (${rootDirs.join(", ")}). Use a path inside your workspace ` +
        `or adjust your MCP client's roots.`,
    );
  }
  return resolved;
}
