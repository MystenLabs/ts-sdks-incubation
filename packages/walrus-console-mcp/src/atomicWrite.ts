import * as fs from "node:fs";
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

  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
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

function existingMode(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return undefined;
  }
}
