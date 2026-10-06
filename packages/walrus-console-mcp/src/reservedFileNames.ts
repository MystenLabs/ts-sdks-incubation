/**
 * Windows' MS-DOS device names, reserved as a FILE name (not just a bare
 * device open) on every Windows filesystem: `CON.txt`, `con.txt` and `CON`
 * are all the same reservation, whatever comes after the first dot.
 *
 * Checked on every platform, not only win32: a bucket's files are named once
 * and can be downloaded, synced, or zipped onto a different machine than the
 * one that ran `download_file`. A name legal on the platform that wrote it can
 * still be unusable — or, on Windows, silently misdirected to the device it
 * names — on the platform that reads it later.
 */
export const WINDOWS_RESERVED_BASENAMES: ReadonlySet<string> = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  // Windows also recognizes the ISO/IEC 8859-1 superscript digits ¹ ² ³
  // (U+00B9, U+00B2, U+00B3) as digits in COM/LPT names specifically —
  // `echo test > COM¹` fails the same way `echo test > COM1` does. `toUpperCase()`
  // leaves these three code points unchanged, so they compare correctly above.
  "COM¹",
  "COM²",
  "COM³",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
  "LPT¹",
  "LPT²",
  "LPT³",
]);

export interface ReservedFileName {
  /** The reserved token that matched, in its canonical uppercase form (e.g. "NUL"). */
  readonly reserved: string;
  /** A name that would not collide with the reservation, browser-style: an underscore prefix. */
  readonly suggestion: string;
}

/**
 * Check a single path component (a file name, not a full path) against
 * Windows' reserved device names.
 *
 * The reservation is on the part of the name BEFORE THE FIRST DOT, not the
 * whole name and not the extension: `CON`, `CON.txt`, and `CON.tar.gz` are all
 * reserved, but `CONSOLE.txt` is not — matching Windows' own rule, which reads
 * up to the first `.` and ignores everything after it. An empty leading
 * segment (a dotfile like `.NUL`) is never reserved: the something-before-the-
 * dot is what Windows treats as the device name, and there is nothing there.
 *
 * Returns `null` for a name that is fine everywhere.
 */
export function checkWindowsReservedName(name: string): ReservedFileName | null {
  const stem = name.split(".")[0] ?? "";
  if (stem.length === 0) return null;
  const upper = stem.toUpperCase();
  if (!WINDOWS_RESERVED_BASENAMES.has(upper)) return null;
  return { reserved: upper, suggestion: `_${name}` };
}
