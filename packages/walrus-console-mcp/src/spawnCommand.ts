import { execFileSync, type StdioOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Run an external command (`npm`, `claude`, `codex`, `gemini`) by name, in a way
 * that works on Windows too.
 *
 * `execFileSync("npm", …)` is fine on macOS and Linux and fails on Windows with
 * `spawnSync npm ENOENT`: there `npm` — like every CLI installed
 * through npm — is a batch script, `npm.cmd`, and `CreateProcess` only runs real
 * executables. Naming the `.cmd` does not help either: since the fix for
 * CVE-2024-27980 Node refuses to spawn a batch file without a shell (`EINVAL`).
 *
 * `{ shell: true }` is the usual answer and is not used here. Node joins the
 * arguments with spaces and hands the result to `cmd.exe` unquoted, so the
 * install root — `C:\Users\<name>\AppData\Local\…`, where `<name>` may contain a
 * space or an `&` — would be split or, worse, run as a second command.
 *
 * Instead, on Windows the command is resolved against PATH/PATHEXT up front and:
 *  - a real executable is spawned directly, by absolute path;
 *  - a batch file is run through `cmd.exe /d /v:off /s /c` with every argument
 *    quoted and caret-escaped, so it reaches the target program exactly as passed.
 *
 * Resolving to an absolute path has a second benefit: `cmd.exe` and libuv both
 * search the current directory before PATH, and this installer exists precisely
 * so the caller's working directory cannot substitute what gets run (see
 * src/installDir.ts). So nothing is ever handed to either by bare name: PATH
 * entries that are not fully qualified are skipped, a command that resolves
 * nowhere is refused rather than passed through, and `cmd.exe` itself is named
 * by absolute path.
 */

export interface CommandInvocation {
  file: string;
  args: string[];
  /** Set for the `cmd.exe` route, whose command line is already fully quoted. */
  windowsVerbatimArguments?: boolean;
}

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Test seam: whether `p` is an existing regular file. */
  isFile?: (p: string) => boolean;
}

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Read an environment variable the way Windows names it: case-insensitively.
 *
 * `process.env` already behaves that way on Windows, but a caller-built env
 * object is a plain object and can carry both `Path` and `PATH`. The exact
 * upper-case spelling wins, so the answer never depends on key insertion order.
 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env)
    .filter((k) => k.toUpperCase() === name)
    .sort()[0];
  return key === undefined ? undefined : env[key];
}

/**
 * True for `C:\…` and `\\server\share\…` only. `path.win32.isAbsolute` also
 * accepts `\tools`, which is relative to the current drive, so it does not
 * rule out a path that depends on where the process happens to be running.
 */
const isFullyQualified = (p: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);

/** Split a PATH value on `;`, keeping a `;` that sits inside double quotes. */
function splitPathList(value: string): string[] {
  const dirs: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ";" && !quoted) {
      dirs.push(current);
      current = "";
    } else current += ch;
  }
  dirs.push(current);
  return dirs.map((d) => d.trim()).filter(Boolean);
}

const DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

/** Extensions `CreateProcess` or `cmd.exe` can run no matter what PATHEXT says. */
const RUNNABLE_EXTENSIONS = new Set([".com", ".exe", ".bat", ".cmd"]);

/**
 * The absolute path Windows would run for `bin`, or null when nothing on PATH
 * matches.
 *
 * Only PATHEXT extensions are tried. An extensionless match is skipped on
 * purpose: npm installs a POSIX `sh` script named plain `npm` next to `npm.cmd`,
 * and spawning that fails exactly like the bug this module fixes. PATHEXT
 * entries without a leading dot are dropped for the same reason: `EXE` would
 * turn `npm` into `npmEXE`.
 */
export function resolveWindowsCommand(bin: string, opts: ResolveOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const exists = opts.isFile ?? isFile;
  const fromEnv = (envValue(env, "PATHEXT") ?? "")
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e.startsWith(".") && e.length > 1);
  const exts = fromEnv.length > 0 ? fromEnv : DEFAULT_PATHEXT;

  // A name that already carries a runnable extension (`npm.cmd`, or the absolute
  // launcher path `…\walrus-console-mcp.cmd`) is taken as-is.
  const ownExt = path.win32.extname(bin).toLowerCase();
  const hasOwnExt = RUNNABLE_EXTENSIONS.has(ownExt) || exts.some((e) => e.toLowerCase() === ownExt);
  const candidates = (base: string): string[] =>
    hasOwnExt ? [base] : exts.map((ext) => base + ext);

  if (isFullyQualified(bin)) {
    return candidates(bin).find(exists) ?? null;
  }

  for (const dir of splitPathList(envValue(env, "PATH") ?? "")) {
    if (!isFullyQualified(dir)) continue;
    const hit = candidates(path.win32.join(dir, bin)).find(exists);
    if (hit) return hit;
  }
  return null;
}

const NUL = String.fromCharCode(0);

/** A line break or NUL: no quoting carries either through `cmd.exe`. */
const unpassable = (s: string): boolean => /[\r\n]/.test(s) || s.includes(NUL);

/** Characters `cmd.exe` treats specially outside quotes. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Quote one argument for `cmd.exe /d /v:off /s /c "<line>"` running a batch file.
 *
 * Two layers, per https://qntm.org/cmd:
 *  1. MSVCRT quoting, so the program's own argv parser gets the string back:
 *     wrap in quotes, backslash-escape embedded quotes, double any backslashes
 *     that precede a quote or the closing quote.
 *  2. Caret-escape every metacharacter — the quotes included, so `cmd.exe`
 *     never enters its own quoted state and every caret stays live. Done twice,
 *     because the line is parsed twice: once by `cmd /c`, and again when the
 *     batch file expands `%*`. Single-escaped, the real quotes in `a"b&c`
 *     would toggle cmd's quote state and the `&` would become a command
 *     separator.
 *
 * This is qntm's original, NOT what cross-spawn does today. cross-spawn 7.0.6
 * replaced the greedy `(\\*)` with a lazy lookahead to avoid a ReDoS, and that
 * mangles every run of two or more backslashes before a quote or the end of the
 * argument. Do not "align" this with cross-spawn. The greedy form is quadratic
 * on a pathological run of backslashes, which is unreachable here: the
 * arguments are a pinned package spec, env-derived paths, and fixed CLI flags.
 *
 * cross-spawn double-escapes only for `node_modules/.bin/*.cmd`. Doing it for
 * every batch file is right for the targets here: `npm.cmd` and npm's cmd-shim
 * both forward `%*` on a plain top-level line.
 *
 * A newline cannot survive `cmd.exe` in any form, and NUL cannot be passed at all,
 * so both are refused rather than silently truncating the command.
 */
export function quoteCmdArgument(arg: string): string {
  if (unpassable(arg)) {
    throw new Error("An argument containing a line break or NUL cannot be passed through cmd.exe");
  }
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/** Escape the batch file's own path, which is not re-parsed by `%*`. */
function quoteCmdCommand(file: string): string {
  if (unpassable(file)) {
    throw new Error("A command path containing a line break or NUL cannot be run through cmd.exe");
  }
  return file.replace(CMD_META, "^$1");
}

/**
 * The absolute path of `cmd.exe`: `COMSPEC` when it is fully qualified,
 * otherwise `%SystemRoot%\System32\cmd.exe`. Never the bare name, which would
 * hand the lookup back to a search that starts in the current directory — and a
 * curated environment block (a service, a CI agent, an IDE task runner) can
 * easily lack `COMSPEC`.
 */
function cmdExePath(env: NodeJS.ProcessEnv): string {
  const comspec = envValue(env, "COMSPEC");
  if (comspec && isFullyQualified(comspec)) return comspec;
  const systemRoot = envValue(env, "SYSTEMROOT");
  const root = systemRoot && isFullyQualified(systemRoot) ? systemRoot : "C:\\Windows";
  return path.win32.join(root, "System32", "cmd.exe");
}

/**
 * What to hand `execFileSync` so `bin args…` runs on `platform`. Pure; exported
 * for tests.
 *
 * Off Windows this is the identity: macOS and Linux keep spawning `bin` exactly
 * as before. On Windows a `bin` that resolves nowhere throws ENOENT naming it,
 * rather than being passed through to a lookup that searches the current
 * directory first.
 */
export function commandInvocation(
  bin: string,
  args: readonly string[],
  opts: ResolveOptions = {},
): CommandInvocation {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return { file: bin, args: [...args] };

  const resolved = resolveWindowsCommand(bin, opts);
  if (resolved === null) {
    const error = new Error(
      `"${bin}" was not found as a runnable file on PATH. It is not looked up in the ` +
        `current directory, so the working directory cannot substitute a different program.`,
    ) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }

  const ext = path.win32.extname(resolved).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { file: resolved, args: [...args] };

  const env = opts.env ?? process.env;
  const line = [quoteCmdCommand(resolved), ...args.map(quoteCmdArgument)].join(" ");
  return {
    file: cmdExePath(env),
    // /d: skip AutoRun commands from the registry. /v:off: no delayed
    // expansion, whatever the registry says, so `!` means what the escaping
    // above assumes. /s: strip exactly the outer quotes below and take
    // everything between them verbatim.
    args: ["/d", "/v:off", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/** Run `bin args…` to completion, throwing on a spawn failure or non-zero exit. */
export function runCommand(
  bin: string,
  args: readonly string[],
  opts: { stdio?: StdioOptions } = {},
): void {
  const { file, args: argv, windowsVerbatimArguments } = commandInvocation(bin, args);
  execFileSync(file, argv, {
    stdio: opts.stdio ?? "ignore",
    ...(windowsVerbatimArguments ? { windowsVerbatimArguments } : {}),
  });
}
