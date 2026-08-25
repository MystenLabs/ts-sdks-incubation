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
 *  - **`wx` plus `fchmod`.** `wx` refuses to reuse a stale temp rather than
 *    silently adopting it, and `fchmod` pins the mode even under a umask that
 *    would loosen the open mode — `writeFileSync`'s `mode` is ignored when the
 *    file already exists.
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
  /** Test seam: invoked after the temp file exists but before the rename. */
  onTempCreated?: () => void;
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
 * The sibling temp path a write uses before renaming over `filePath`. Exported so
 * a caller that abandons the write (an interrupted transfer) can remove the same
 * temp the writer would have.
 */
export function atomicTempPath(filePath: string): string {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
}

/** Best-effort removal of a write's temp file. Never throws. */
export async function removeAtomicTemp(filePath: string): Promise<void> {
  await fsp.rm(atomicTempPath(filePath), { force: true }).catch(() => {});
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

  options.onTempCreated?.();

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

  options.onTempCreated?.();

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
