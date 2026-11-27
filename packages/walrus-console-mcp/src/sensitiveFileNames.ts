/**
 * File names a download must not create under an allowed root, besides any name that starts with a
 * dot. Every dotfile is refused outright (`.env`, `.npmrc`, `.ssh/*`, `.git/*`, `.aws/*`), so this
 * list holds only the credential names that do not begin with one. Lowercase: matching ignores case.
 */
export const SENSITIVE_DOWNLOAD_BASENAMES: ReadonlySet<string> = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ecdsa_sk",
  "id_ed25519",
  "id_ed25519_sk",
  "authorized_keys",
  "known_hosts",
  "_netrc",
]);

export interface SensitiveDownloadPath {
  /** The path component that matched, as the caller wrote it. */
  readonly segment: string;
  readonly reason: "dotfile" | "sensitive_name";
}

/**
 * Windows ignores trailing dots and spaces and an NTFS stream suffix, so `.env.`, `.env ` and
 * `.env::$DATA` all open `.env`. Stripped before matching on win32 only; elsewhere they are
 * distinct names.
 */
function canonicalSegment(segment: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return segment;
  return segment.replace(/:.*$/, "").replace(/[. ]+$/, "");
}

/**
 * Check the path components below an allowed root, not just the file name: a download to
 * `<root>/.ssh/id_rsa` or `<root>/.git/config` has an innocent basename under a refused directory.
 * Also refuses dotfiles in any additional segments covered by the saved-folder policy.
 * Returns an offending component, or `null` when the path is fine.
 */
export function checkSensitiveDownloadPath(
  segmentsBelowRoot: readonly string[],
  platform: NodeJS.Platform = process.platform,
  savedFolderSegments: readonly string[] = [],
): SensitiveDownloadPath | null {
  const isDotfile = (segment: string) =>
    segment.startsWith(".") && segment !== "." && segment !== "..";
  const savedDotfile = savedFolderSegments.find(isDotfile);
  if (savedDotfile !== undefined) return { segment: savedDotfile, reason: "dotfile" };
  for (const segment of segmentsBelowRoot) {
    if (isDotfile(segment)) {
      return { segment, reason: "dotfile" };
    }
    const canonical = canonicalSegment(segment, platform);
    if (canonical === "" || canonical === "." || canonical === "..") continue;
    if (SENSITIVE_DOWNLOAD_BASENAMES.has(canonical.toLowerCase())) {
      return { segment, reason: "sensitive_name" };
    }
  }
  return null;
}
