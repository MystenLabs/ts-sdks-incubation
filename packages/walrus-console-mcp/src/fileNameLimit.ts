import * as path from "node:path";

/**
 * The longest single file name (one path component) this server will accept
 * for a download destination.
 *
 * 255 is the practical floor across every filesystem a download can land on:
 * NTFS and exFAT cap a name at 255 UTF-16 code units, ext4 and APFS at 255
 * UTF-8 bytes. The two measures diverge for anything outside plain ASCII — 200
 * non-ASCII characters can be 200 units and 400 bytes at once — and this
 * process has no reliable way to learn which filesystem `destPath` actually
 * resolves to: a Windows path can point at an ext4-backed WSL mount or SMB
 * share, and a POSIX path can point at a mounted NTFS or exFAT volume. See
 * `checkFileNameLength` for how that uncertainty is resolved.
 *
 * The full PATH is a separate concern, handled at the filesystem-call boundary
 * (`src/atomicWrite.ts`'s `forFs`, `src/pathSandbox.ts`'s read helpers): both
 * namespace every absolute path they actually open, link or rename with
 * `path.toNamespacedPath`, which is what lets a long TOTAL path succeed
 * regardless of whether this machine has Windows' `LongPathsEnabled` policy
 * set — most do not, since it defaults off. This module is only about a
 * single COMPONENT: no namespacing changes the 255-per-name ceiling, and on
 * Windows a name over it fails with a bare ENOENT that names neither the
 * cause nor the limit.
 */
export const MAX_FILE_NAME_LENGTH = 255;

export interface FileNameTooLong {
  /** UTF-16 code unit count — the more permissive of the two measures; see the module docstring. */
  readonly length: number;
  readonly limit: number;
  /** The name cut down to fit, extension kept — what a browser would save it as. */
  readonly suggestion: string;
}

/** An extension longer than this is part of the name, not worth preserving. */
const MAX_KEPT_EXTENSION = 32;

/**
 * Shorten `name` to fit `MAX_FILE_NAME_LENGTH`, keeping its extension.
 *
 * Cuts by UTF-8 byte count, not UTF-16 units: UTF-8 never needs fewer bytes
 * than UTF-16 needs units for the same text (1:1 for ASCII, more for
 * everything else), so a result that fits the byte count fits the unit count
 * too — the suggestion is safe on any of the filesystems the module docstring
 * names, not only the one this process happens to be running on.
 *
 * Cuts whole code points (never half of a surrogate pair or a multi-byte UTF-8
 * sequence), drops a now-lone surrogate the cut could have exposed, and drops
 * a trailing run of dots or spaces before the extension is reattached —
 * Windows silently strips those from the final path component, so a
 * suggestion ending in one would name a file different from the one that
 * would actually be created.
 */
export function truncateFileName(name: string): string {
  if (Buffer.byteLength(name, "utf8") <= MAX_FILE_NAME_LENGTH) return name;
  const ext = path.extname(name);
  const kept = ext && Buffer.byteLength(ext, "utf8") <= MAX_KEPT_EXTENSION ? ext : "";
  const stem = Array.from(kept ? name.slice(0, -kept.length) : name);
  let budget = MAX_FILE_NAME_LENGTH - Buffer.byteLength(kept, "utf8");
  const out: string[] = [];
  for (const ch of stem) {
    const cost = Buffer.byteLength(ch, "utf8");
    if (cost > budget) break;
    out.push(ch);
    budget -= cost;
  }
  const truncatedStem = out
    .join("")
    // `Array.from` iterates by code point, correctly keeping every valid
    // surrogate pair together — it never manufactures a lone one. But an
    // ALREADY-unpaired surrogate in the input is itself one code point as far
    // as that iteration is concerned, so it can survive into `out` unchanged.
    // Strip it here rather than pass it on: encoding it to UTF-8 (the actual
    // write) replaces it with U+FFFD, so the suggestion would otherwise name a
    // file different from the one that gets created.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  // Stripped from the FULL assembled name, not just the stem: a `kept`
  // extension that is itself trivial (the input's own extname was a bare "."
  // — `"a".repeat(300) + "."`) would otherwise still leave the result ending
  // in a dot, the exact hazard this strip exists to close.
  return `${truncatedStem}${kept}`.replace(/[. ]+$/, "");
}

/**
 * Null when `name` fits everywhere a download might land; otherwise its
 * UTF-16 length and a name that would fit.
 *
 * Refuses only when the name is over the limit by BOTH measures — which,
 * because UTF-8 never uses fewer bytes than UTF-16 uses units for the same
 * text, reduces to checking the UTF-16 (unit) count alone: it is always the
 * smaller of the two, so a name within it is within the byte count too. A name
 * long only in UTF-8 bytes is deliberately let through: refusing it would
 * regress a same-OS Windows/exFAT download that was working before this check
 * existed, to close a narrower gap — a name that also happens to be moved onto
 * a UTF-8-backed filesystem, like a WSL mount or a Samba share — that was
 * already just as broken beforehand. Undercatching that gap is the accepted
 * trade for never blocking a write that would have succeeded.
 */
export function checkFileNameLength(name: string): FileNameTooLong | null {
  const length = name.length;
  if (length <= MAX_FILE_NAME_LENGTH) return null;
  return { length, limit: MAX_FILE_NAME_LENGTH, suggestion: truncateFileName(name) };
}
