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
 *    `.<basename>.<pid>.<12-hex-char nonce>.tmp` sitting next to the target
 *    with no live process holding that pid.
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
   * client-registration file, the anchors file, and a downloaded file all
   * want. Only a caller that must never clobber an existing file (a minted
   * credential, keyed by a value it does not control) should set this.
   *
   * Not every filesystem supports hard links — exFAT/FAT, and some network or
   * container mounts, reject `link()` outright regardless of whether
   * `filePath` exists. When that happens, the publish step falls back to an
   * `existsSync` check plus `rename()` — the same pattern a caller would have
   * hand-rolled before `exclusive` existed. That fallback's check-then-write
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

/** Async-write options: everything the sync writer takes, plus cancellation. */
export interface AsyncAtomicWriteOptions extends AtomicWriteOptions {
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
 */
function atomicTempPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
}

export function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions,
): void {
  const dir = path.dirname(filePath);
  if (options.mkdirMode !== undefined) {
    fs.mkdirSync(dir, { recursive: true, mode: options.mkdirMode });
  }

  const mode = (options.preserveExistingMode ? existingMode(filePath) : undefined) ?? options.mode;

  const tmpPath = atomicTempPath(filePath);
  const fd = fs.openSync(tmpPath, "wx", mode);
  try {
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, content);
    // Durability before the rename: without it a crash can land the rename while
    // the data is still only in the page cache, producing an atomically-renamed
    // empty file — the exact outcome the temp+rename was meant to prevent.
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
  fs.closeSync(fd);

  options.onTempCreated?.(tmpPath);

  if (options.exclusive) {
    try {
      // The mode carries over via the shared inode — no separate fchmod needed.
      fs.linkSync(tmpPath, filePath);
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
        if (fs.existsSync(filePath)) {
          fs.rmSync(tmpPath, { force: true });
          // Shaped exactly like the EEXIST link() itself would have thrown —
          // same `code`, and `syscall: "link"` in particular, since
          // `persistMintedCredential` discriminates on that to tell "the
          // destination already exists" apart from "the temp collided" (see
          // its own comment). Whichever path produced it, this really is the
          // same fact link() would have reported: filePath already exists.
          const eexist = new Error(
            `EEXIST: file already exists, link '${tmpPath}' -> '${filePath}'`,
          ) as NodeJS.ErrnoException;
          eexist.code = "EEXIST";
          eexist.syscall = "link";
          eexist.path = tmpPath;
          throw eexist;
        }
        try {
          fs.renameSync(tmpPath, filePath);
        } catch (renameErr) {
          fs.rmSync(tmpPath, { force: true });
          throw renameErr;
        }
        return;
      }
      fs.rmSync(tmpPath, { force: true });
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
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Orphaned temp sibling: a cosmetic leftover, not a correctness
      // problem — the destination is fully and correctly published either way.
    }
    return;
  }

  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
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
  // No async caller wants exclusive-create (the transfer paths always mean to
  // replace); a loud rejection here is better than silently ignoring the
  // option and overwriting anyway. Checked first, before anything touches the
  // filesystem.
  if (options.exclusive) {
    throw new Error("writeFileAtomicAsync does not support the exclusive option");
  }

  const dir = path.dirname(filePath);
  if (options.mkdirMode !== undefined) {
    await fsp.mkdir(dir, { recursive: true, mode: options.mkdirMode });
  }

  const mode =
    (options.preserveExistingMode ? await existingModeAsync(filePath) : undefined) ?? options.mode;

  const tmpPath = atomicTempPath(filePath);
  const handle = await fsp.open(tmpPath, "wx", mode);
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
    await fsp.rm(tmpPath, { force: true });
    throw err;
  }
  await handle.close();

  options.onTempCreated?.(tmpPath);

  // Checked at the last moment before anything becomes visible at the
  // destination: if the transfer was cancelled while we were writing, discard the
  // temp rather than renaming a file nobody is waiting for anymore.
  if (options.signal?.aborted) {
    await fsp.rm(tmpPath, { force: true });
    const aborted = new Error("The write was aborted before the file could be published.");
    aborted.name = "AbortError";
    throw aborted;
  }

  try {
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    await fsp.rm(tmpPath, { force: true });
    throw err;
  }
}

function existingMode(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return undefined;
  }
}

async function existingModeAsync(filePath: string): Promise<number | undefined> {
  try {
    return (await fsp.stat(filePath)).mode & 0o777;
  } catch {
    return undefined;
  }
}
