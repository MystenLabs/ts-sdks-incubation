import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * Atomic, mode-pinned file replacement.
 *
 * Extracted from `saveConfigFile`, which needed all of this for the credential
 * file and is no longer the only writer that does: registering an MCP entry in a
 * third-party client's config and writing a decrypted download both replace a
 * file whose previous contents matter.
 *
 * The shape is deliberate on three counts:
 *
 *  - **Temp file, then rename.** A direct write can truncate the target and then
 *    fail — on a full disk, on a SIGTERM, or against a competing writer — leaving
 *    an empty or half-written file where a good one used to be. `rename` within a
 *    directory is atomic, so an observer sees either the old file or the new one.
 *  - **Sibling temp, not the system tmpdir.** A rename across filesystems is not
 *    atomic and usually fails outright (EXDEV).
 *  - **`wx` plus `fchmod`.** `wx` refuses to silently adopt a file that is
 *    already there, and `fchmod` pins the mode even under a umask that would
 *    loosen the open mode — `writeFileSync`'s `mode` is ignored when the file
 *    already exists. Each attempt's temp name carries a random nonce (M6, see
 *    `atomicTempPath`), so `wx` is no longer what stands between two attempts
 *    on the same destination and a collision — it now only ever meets a name
 *    nobody else could be using. The flip side: a temp left by a process that
 *    crashed before rename no longer blocks (or gets silently reused by) the
 *    next attempt — it just accumulates. Spot one by its shape:
 *    `.walrus-console-mcp.<pid>.<12-hex-char nonce>.tmp` sitting next to the
 *    target with no live process holding that pid. That shape is fixed
 *    regardless of destination (see the doc comment on `atomicTempPath`), so
 *    it says a write was interrupted somewhere under this directory, not
 *    which file it was for — narrowing that down means checking every
 *    non-`.tmp` sibling for one that looks unfinished.
 *
 * Because `rename` replaces the inode, the caller must say whose mode wins; see
 * `preserveExistingMode`.
 */
export interface AtomicWriteOptions {
  /** Mode to create the replacement with. */
  mode: number;
  /**
   * Keep the mode of an existing target instead of applying `mode`.
   *
   * Off by default, which is what a file we own wants: `rename` replaces the
   * inode, so forcing the mode is also what tightens a legacy world-readable
   * credential file back to 0600 on the next write.
   *
   * On for a file some OTHER application owns — an editor's MCP config — where
   * the mode is that application's choice and silently changing it is a bug of
   * its own.
   */
  preserveExistingMode?: boolean;
  /**
   * Ceiling the resulting mode is masked against, applied after
   * `preserveExistingMode`.
   *
   * Preserving an existing mode is meant to stop a replacement from
   * re-permissioning a file its owner deliberately tightened. On its own it
   * also carries LOOSENING across, which is the wrong direction when the
   * content being published is more sensitive than what it replaces: a
   * decrypted download landing on a `0o644` file would become `0o644`, where a
   * download to a fresh path is `0o600`. With `maxMode: 0o600` the preserved
   * mode can only tighten: `0o400` stays `0o400`, `0o644` becomes `0o600`.
   */
  maxMode?: number;
  /** When set, create the parent directory (recursively) with this mode. */
  mkdirMode?: number;
  /**
   * Test seam: invoked with this attempt's temp path after the temp file
   * exists but before the rename. The argument exists so a test driving two
   * overlapping attempts on the same destination can tell their temps apart;
   * a callback that ignores it (`() => {...}`) still compiles.
   */
  onTempCreated?: (tmpPath: string) => void;
  /**
   * Last check before publishing: runs after the temp is written and fsync'd
   * (and after `onTempCreated`), immediately before the rename or link, and
   * again before each rename retried on a Windows lock. If it throws, nothing is
   * published, the temp is removed, and the error is rethrown unchanged.
   * Synchronous only: the return type rules out an async function, whose
   * rejection would arrive after the publish.
   *
   * For a caller that merged into a file it read earlier and must not publish
   * over a newer version (see `jsonFileClient`). It narrows the window between
   * that check and the rename to a few syscalls; it cannot close it, since
   * `rename()` has no compare-and-swap form.
   */
  precondition?: () => undefined;
  /**
   * Publish via `link()` instead of `rename()`, so the write fails with
   * `EEXIST` rather than silently overwriting an existing file at `filePath`.
   *
   * `rename()` has no "fail if the destination exists" mode — it always
   * replaces. `link()` does, atomically, in the same one syscall: it creates
   * a second name for the already-`fsync`'d temp's inode and fails outright
   * if `filePath` already exists, so there is no window where a caller could
   * observe (or race) a check-then-write. This is the same primitive
   * `configFile.ts`'s `acquireLock()` already uses to publish its lock file
   * for exactly this reason — see its doc comment.
   *
   * Off by default: `rename()`-and-overwrite is what the config file, the
   * client-registration file and the anchors file want — this process owns
   * each of those paths, so replacing one is the point. A caller should set
   * this when the destination is not its own to replace: a minted credential,
   * keyed by a value it does not control, and a download, whose destination
   * the agent chose (COMG-790, set unless the user passes `overwrite`).
   *
   * Not every filesystem supports hard links — exFAT/FAT, and some network or
   * container mounts, reject `link()` outright regardless of whether
   * `filePath` exists. When that happens, the publish step falls back to an
   * existence check plus `rename()` — the same pattern a caller would have
   * hand-rolled before `exclusive` existed. The check is `lstat`, not
   * `existsSync`: `existsSync` follows the link, so a DANGLING symlink at the
   * destination reads as free and `rename()` replaces it, while `link()` on
   * the same destination refuses it `EEXIST`. Both writers use `lstat` so the
   * fallback and the hard-link path agree on what "already there" means. That fallback's check-then-write
   * is a real, narrow TOCTOU window (a concurrent write for the SAME
   * destination between the check and the rename), but the alternative —
   * failing every exclusive write outright on such a filesystem — would mean
   * the one-time secrets `exclusive` exists to protect are lost every time
   * instead of merely re-checked with a small race window. Accepting the
   * narrow window beats losing the secrets.
   *
   * Which errors trigger the fallback is decided by EXCLUSION, not an
   * enumerated allowlist: anything other than `EEXIST` falls back — `EEXIST`
   * is the one outcome deliberately surfaced (the destination genuinely
   * already exists) as a real refusal. An allowlist was tried first
   * (`EPERM`/`ENOTSUP`/`EXDEV`) and found unreliable across platforms:
   * Linux's `link(2)` reports `ENOTSUP` for a filesystem with no hard-link
   * support, but macOS reports `EOPNOTSUPP` for the identical condition — a
   * DIFFERENT errno Node surfaces as `code: "UNKNOWN"` rather than
   * translating — so the allowlist missed the very platform it was written
   * to cover. There is no reliable way to enumerate every non-`EEXIST` errno
   * a hard-link-incapable environment can produce across every OS/filesystem/
   * container/network-mount combination, so exclusion is the only match rule
   * that cannot silently miss the next one.
   */
  exclusive?: boolean;
}

/** Async-write options: everything the sync writer takes except `precondition`, plus cancellation. */
// `exclusive` works here too, on the same `link()`-or-fallback shape as the
// sync writer. A download is the caller that needs it: the destination is
// chosen by the agent, so an existing file there must never be replaced unless
// the user asked for that in the same call (COMG-790).
export interface AsyncAtomicWriteOptions extends Omit<AtomicWriteOptions, "precondition"> {
  /**
   * When aborted before the rename, the temp is dropped and NOTHING is published
   * at the destination. This is why a cancelled download leaves no half-written
   * plaintext where a good file used to be — the target is untouched.
   */
  signal?: AbortSignal;
}

/**
 * The sibling temp path one write ATTEMPT uses before renaming over `filePath`.
 *
 * Internal only (M6): the old name was `.<basename>.<pid>.tmp`, a pure
 * function of destination + pid, so two attempts on the same destination —
 * a retry racing an abandoned write, or genuinely concurrent callers —
 * computed the IDENTICAL temp path. Every cleanup in the writers below
 * (`rm(tmpPath, {force: true})` on a failed write, an abort before rename, a
 * failed rename) had no ownership check, so the second attempt either failed
 * `open(…, "wx")` with EEXIST or had its temp deleted out from under it by
 * the first attempt's cleanup. Calling this fresh, with a random nonce, on
 * every attempt makes each one's temp unique, so nothing outside this module
 * needs to remove it either: an interrupted transfer now waits for the
 * write's own promise to settle (`tryPromiseSettling`, M8), and every abort
 * path in the writers below drops only the temp its own call created.
 *
 * The name carries nothing of the destination's own name. Filesystems cap a
 * single name at 255 (UTF-16 units on NTFS, bytes on ext4/APFS), and a
 * destination already near that cap — Console accepts file names up to 255
 * characters — would push `.<basename>.<pid>.<nonce>.tmp` over it, failing the
 * temp open before a byte is written (on Windows as a bare ENOENT). A fixed-shape
 * name stays about 50 characters whatever the target is called, so the only
 * name that has to fit is the one the caller asked for.
 */
function atomicTempPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.walrus-console-mcp.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
}

/**
 * Windows only: prefix an absolute path with `\\?\` (or `\\?\UNC\` for a UNC
 * path) so the actual `CreateFile` call bypasses MAX_PATH — regardless of
 * whether this machine has the `LongPathsEnabled` registry policy set. It
 * defaults OFF and stays off unless an administrator opts in, so a user's own
 * machine cannot be assumed to have it: verified on a fresh Windows 11 install
 * with the key absent (`0`), a plain `fs.writeFile` to an unremarkable ~350
 * character absolute path fails with a bare ENOENT — the exact failure this
 * module exists to prevent — while the same write through this wrapper
 * succeeds. A no-op on every other platform (`path.posix.toNamespacedPath`
 * returns its argument unchanged), and idempotent if a path already carries
 * the prefix.
 *
 * Applied ONLY at the boundary to an actual `fs`/`fsp` call below — never to a
 * path used for `path.dirname`/`path.basename`, an `onTempCreated` callback,
 * or an error message. Those must keep showing the plain spelling: it is what
 * `resolveDownloadDestWithinRoots` already validated and what a caller passed
 * in, and `path.dirname`/`basename` on an already-namespaced string would be
 * computing over a different value than the rest of this module does.
 */
const forFs = (p: string): string => path.toNamespacedPath(p);

export function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions,
): void {
  const dir = path.dirname(filePath);
  if (options.mkdirMode !== undefined) {
    fs.mkdirSync(forFs(dir), { recursive: true, mode: options.mkdirMode });
  }

  const mode =
    ((options.preserveExistingMode ? existingMode(filePath) : undefined) ?? options.mode) &
    (options.maxMode ?? 0o777);

  const tmpPath = atomicTempPath(filePath);
  const fd = fs.openSync(forFs(tmpPath), "wx", mode);
  try {
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, content);
    // Durability before the rename: without it a crash can land the rename while
    // the data is still only in the page cache, producing an atomically-renamed
    // empty file — the exact outcome the temp+rename was meant to prevent.
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(forFs(tmpPath), { force: true });
    throw err;
  }
  fs.closeSync(fd);

  options.onTempCreated?.(tmpPath);

  const { precondition } = options;
  if (precondition) {
    try {
      precondition();
    } catch (err) {
      dropTempBestEffort(tmpPath);
      throw err;
    }
  }

  if (options.exclusive) {
    try {
      // The mode carries over via the shared inode — no separate fchmod needed.
      fs.linkSync(forFs(tmpPath), forFs(filePath));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Inverted rather than an enumerated allowlist: `EEXIST` is the ONLY
      // outcome being deliberately surfaced (the destination genuinely
      // already exists), so everything else falls back. An allowlist here
      // already proved unreliable in practice — this file originally listed
      // `EPERM`/`ENOTSUP`/`EXDEV` for "this filesystem cannot do hard links",
      // but macOS's `link(2)` reports `EOPNOTSUPP` for that exact condition,
      // a DIFFERENT errno than Linux's `ENOTSUP`, which Node surfaces as
      // `code: "UNKNOWN"` rather than translating — so the allowlist missed
      // the very platform it was meant to cover. See the `exclusive` doc
      // comment for why falling through to reject unconditionally on a
      // filesystem that cannot do better would be worse than the narrow
      // TOCTOU window below.
      if (code !== "EEXIST") {
        if (pathExistsSync(filePath)) {
          fs.rmSync(forFs(tmpPath), { force: true });
          throw eexistFor(tmpPath, filePath);
        }
        // Retried like the plain path below: a filesystem without hard links
        // (exFAT, some SMB shares) is exactly where a scanner holding the
        // just-written temp surfaces as a transient EPERM, and the only copy of
        // a minted credential is in that temp. The retry widens the TOCTOU
        // window above by at most ~1.3s, and only on Windows, while locked.
        try {
          // The failed link and existence check happened after the first check.
          // Recheck before the fallback's first rename, as well as its retries.
          precondition?.();
          renameSyncWithRetry(tmpPath, filePath, precondition);
        } catch (renameErr) {
          dropTempBestEffort(tmpPath);
          throw renameErr;
        }
        return;
      }
      fs.rmSync(forFs(tmpPath), { force: true });
      throw err;
    }
    // Unlike rename(), link() leaves the original name (the temp) in place —
    // it added a second name for the same inode rather than moving it. The
    // file is ALREADY published at this point (the link() above succeeded),
    // so this cleanup is deliberately best-effort: `{ force: true }` only
    // swallows ENOENT, not e.g. EACCES on a directory whose permissions
    // tightened between the two calls, or a mount that rejects unlink. A
    // thrown error here must NOT be allowed to look like a write failure —
    // a caller as far away as `persistMintedCredential` cannot tell "the temp
    // could not be removed" from "nothing was ever written", and reporting
    // secrets as unrecoverable when they are sitting right at `filePath` is
    // the worst direction that message can be wrong in.
    try {
      fs.rmSync(forFs(tmpPath), { force: true });
    } catch {
      // Orphaned temp sibling: a cosmetic leftover, not a correctness
      // problem — the destination is fully and correctly published either way.
    }
    return;
  }

  try {
    renameSyncWithRetry(tmpPath, filePath, precondition);
  } catch (err) {
    dropTempBestEffort(tmpPath);
    throw err;
  }
}

/**
 * Remove an unpublished temp on the way out of a failed publish. Best-effort:
 * the error being rethrown (a failed rename, or a precondition's veto the caller
 * acts on) is the one that matters, and a cleanup failure must not replace it.
 */
function dropTempBestEffort(tmpPath: string): void {
  try {
    fs.rmSync(forFs(tmpPath), { force: true });
  } catch {
    // An orphaned temp; see the module comment for how to spot one.
  }
}

/** Errors Windows raises for a destination that is locked or not replaceable right now. */
function isWindowsLockError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/** Backoff between rename attempts on Windows: ~1.3s in total before giving up. */
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640];

/**
 * `renameSync`, retried on Windows while the destination is transiently locked.
 *
 * On Windows a rename over an existing file fails with EPERM/EACCES/EBUSY while
 * any other process has it open without FILE_SHARE_DELETE — Defender and the
 * search indexer both do this to a file that was just written, and an agent
 * reading its config at the same moment does too. The lock clears in
 * milliseconds, so a short retry turns a spurious "operation not permitted" into
 * a successful save. graceful-fs and write-file-atomic retry for the same reason.
 *
 * POSIX has no such transient state: EPERM/EACCES there is a real permission
 * error, so it fails immediately as before.
 *
 * When the retries run out the error is thrown and the destination is left as
 * it was. There is deliberately no write-in-place fallback: writing through
 * the destination name follows a symlink or hard link planted there, keeps the
 * existing file's mode instead of pinning the requested one, and truncates the
 * file before the first byte lands — so a failure mid-write would leave an
 * empty or partial credential file where an intact one used to be.
 */
function renameSyncWithRetry(from: string, to: string, beforeRetry?: () => void): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(forFs(from), forFs(to));
      return;
    } catch (err) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (process.platform !== "win32" || !isWindowsLockError(err) || delay === undefined) {
        throw err;
      }
      // A synchronous sleep: every caller of the sync writer is synchronous by
      // design (the config lock), so yielding to the event loop is not an option.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      // The lock holder is often the app saving this very file.
      beforeRetry?.();
    }
  }
}

/**
 * Async, signal-aware sibling of `writeFileAtomic`, for the transfer paths (a
 * decrypted download) rather than the config/installer paths.
 *
 * Same temp-then-rename shape, and the same `wx` + `fchmod` + `fsync`-before-
 * `rename` guarantees, on `node:fs/promises` so it does not block the event loop
 * while a large payload is written. The one addition is the `signal` check
 * immediately before the rename: an aborted transfer must NOT publish a
 * half-wanted file, so the temp is dropped and the destination left untouched.
 * The sync writer is kept for the config/installer callers, whose lock is
 * deliberately synchronous.
 */
export async function writeFileAtomicAsync(
  filePath: string,
  content: string | Uint8Array,
  options: AsyncAtomicWriteOptions,
): Promise<void> {
  const dir = path.dirname(filePath);
  if (options.mkdirMode !== undefined) {
    await fsp.mkdir(forFs(dir), { recursive: true, mode: options.mkdirMode });
  }

  const mode =
    ((options.preserveExistingMode ? await existingModeAsync(filePath) : undefined) ??
      options.mode) & (options.maxMode ?? 0o777);

  const tmpPath = atomicTempPath(filePath);
  const handle = await fsp.open(forFs(tmpPath), "wx", mode);
  try {
    await handle.chmod(mode);
    // Thread the signal into the write itself (Node's FileHandle.writeFile takes
    // one, like the sibling read in pathSandbox) so a cancel aborts mid-write
    // instead of pushing the whole payload to disk before the post-write check.
    await handle.writeFile(content, options.signal ? { signal: options.signal } : {});
    // Durability before the rename, exactly as the sync writer: fsync so a crash
    // cannot land the rename over data still only in the page cache.
    await handle.sync();
  } catch (err) {
    await handle.close();
    await fsp.rm(forFs(tmpPath), { force: true });
    throw err;
  }
  await handle.close();

  options.onTempCreated?.(tmpPath);

  // Checked at the last moment before anything becomes visible at the
  // destination: if the transfer was cancelled while we were writing, discard the
  // temp rather than renaming a file nobody is waiting for anymore.
  if (options.signal?.aborted) {
    await fsp.rm(forFs(tmpPath), { force: true });
    const aborted = new Error("The write was aborted before the file could be published.");
    aborted.name = "AbortError";
    throw aborted;
  }

  if (options.exclusive) {
    try {
      // The mode carries over via the shared inode, exactly as in the sync
      // writer, so no separate chmod is needed here either.
      await fsp.link(forFs(tmpPath), forFs(filePath));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Same exclusion rule as the sync writer: `EEXIST` is the one outcome
      // surfaced as a real refusal, everything else means this filesystem
      // cannot do hard links and falls back. See the `exclusive` doc comment
      // for why an enumerated allowlist was tried and abandoned.
      if (code !== "EEXIST") {
        if (await pathExistsAsync(filePath)) {
          await fsp.rm(forFs(tmpPath), { force: true });
          throw eexistFor(tmpPath, filePath);
        }
        try {
          await fsp.rename(forFs(tmpPath), forFs(filePath));
        } catch (renameErr) {
          await fsp.rm(forFs(tmpPath), { force: true });
          throw renameErr;
        }
        return;
      }
      await fsp.rm(forFs(tmpPath), { force: true });
      throw err;
    }
    // `link()` leaves the temp name in place; the destination is already
    // published, so failing to remove it must not read as a write failure.
    try {
      await fsp.rm(forFs(tmpPath), { force: true });
    } catch {
      // Cosmetic leftover. The destination is correctly published either way.
    }
    return;
  }

  try {
    await fsp.rename(forFs(tmpPath), forFs(filePath));
  } catch (err) {
    await fsp.rm(forFs(tmpPath), { force: true });
    throw err;
  }
}

/**
 * The error `link()` itself raises when the destination exists, rebuilt for the
 * fallback path so a caller cannot tell the two apart. `syscall: "link"` in
 * particular is load-bearing: `persistMintedCredential` discriminates on it.
 */
function eexistFor(tmpPath: string, filePath: string): NodeJS.ErrnoException {
  const eexist = new Error(
    `EEXIST: file already exists, link '${tmpPath}' -> '${filePath}'`,
  ) as NodeJS.ErrnoException;
  eexist.code = "EEXIST";
  eexist.syscall = "link";
  eexist.path = tmpPath;
  return eexist;
}

/**
 * `lstat`, not `stat`: `link()` fails `EEXIST` when the destination IS a
 * symlink, dangling or not, and this check stands in for that call on a
 * filesystem that cannot hard-link. Following the link would answer "free" for
 * a dangling one and rename over it instead of refusing.
 */
function pathExistsSync(filePath: string): boolean {
  try {
    fs.lstatSync(forFs(filePath));
    return true;
  } catch {
    return false;
  }
}
async function pathExistsAsync(filePath: string): Promise<boolean> {
  try {
    await fsp.lstat(forFs(filePath));
    return true;
  } catch {
    return false;
  }
}

function existingMode(filePath: string): number | undefined {
  try {
    return fs.statSync(forFs(filePath)).mode & 0o777;
  } catch {
    return undefined;
  }
}

async function existingModeAsync(filePath: string): Promise<number | undefined> {
  try {
    return (await fsp.stat(forFs(filePath))).mode & 0o777;
  } catch {
    return undefined;
  }
}
