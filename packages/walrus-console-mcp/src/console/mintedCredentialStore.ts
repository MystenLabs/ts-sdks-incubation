import { createHash } from "node:crypto";
import * as path from "node:path";
import { writeFileAtomic } from "../atomicWrite.js";
import { getConfigDir } from "../configFile.js";
import type { GenerateApiKeyResult, MintedSecrets } from "./KeyAdminService";

/**
 * Where a mint's one-time secrets are written, so the MCP transcript never
 * has to carry them.
 *
 * `generateApiKey` calls `persistMintedCredential` immediately after a mint
 * succeeds, before anything else runs — see `KeyAdminService.generateApiKey`.
 * Its result (`apiKey`/`privateKey`) would otherwise flow straight into
 * `safeTool`'s `JSON.stringify` and into whatever a client logs, forwards to
 * a model, or persists as part of a tool-call transcript. `apiKey` and
 * `privateKey` are shown ONCE by design (see `MintedSecrets`), so putting
 * them on that path is strictly worse than a raw credential in a shell
 * history.
 *
 * Mirrors `anchorStore.ts`: one JSON file under `getConfigDir()`, mode 0600,
 * parent directory 0700. Unlike anchors.json this is NOT a read-modify-write
 * map — a mint's `keyId` is unique and a caller is explicitly told never to
 * retry a mint (see `GenerateApiKeyOutcome`), so every credential gets its
 * OWN file under `minted-keys/`.
 */

const MINTED_KEYS_DIRNAME = "minted-keys";

/**
 * A filesystem-safe, COLLISION-FREE representation of an untrusted string,
 * for use as a single path segment: the hex-encoded SHA-256 digest of the
 * FULL raw string, and nothing else.
 *
 * `keyId` is server-controlled (it comes back from `createApiKey`'s
 * response, which is Zod-validated at the parse boundary in
 * `ConsoleApiClient.ts` — this module no longer has to defend against it
 * being some other type, only against it being adversarial content), not
 * something this client generates — a malicious or compromised Console
 * backend could choose it adversarially. Filename READABILITY was never a
 * real requirement here (see the module doc comment: the goal is confining
 * a hostile `keyId` to `minted-keys/` and never colliding with another
 * mint, not legibility), so this hashes instead of trying to preserve an
 * escaped, human-readable form.
 *
 * That escaping approach — perhaps the obvious first design — went through
 * THREE collision bugs, each fixed in isolation without closing the
 * underlying problem, before it was abandoned for a hash:
 *
 * 1. THE ESCAPE MARKER ITSELF colliding with an allowed pass-through
 *    character. An early version used `_` as both the escape marker and a
 *    pass-through character, so raw `"A B"` (one literal space) and raw
 *    `"A_20B"` (four literal characters `_`, `2`, `0`, `B`) both escaped to
 *    `"A_20B"`.
 * 2. TRUNCATION. Bounding the escaped output to a max length meant two
 *    different long raw strings could share the same truncated prefix.
 * 3. VARIABLE-WIDTH HEX ESCAPES, found after both of the above were fixed.
 *    The escape was `` `~${codePointAt(0).toString(16).padStart(2,"0")}` ``
 *    — `padStart(2, "0")` enforces only a MINIMUM of two hex digits, not a
 *    FIXED width, and a codepoint >= 0x100 needs 3+. With no delimiter
 *    marking where an escape ends, `~1f` (escaped U+001F) immediately
 *    followed by a literal `6` was byte-for-byte identical to `~1f6`
 *    (escaped U+01F6): raw U+001F followed by a literal "6", and raw
 *    "Ƕ" (U+01F6) alone, both produced the path segment `~1f6` —
 *    confirmed by direct execution.
 *
 * A cryptographic hash has none of these failure modes: SHA-256 is a
 * fixed-length (64 hex characters, always), effectively-injective map over
 * its full output, so two different raw `keyId` values landing on the same
 * digest requires an actual hash collision — cryptographically negligible,
 * including against an adversarial `keyId`. There is also nothing left to
 * bound or truncate: the output length never varies with the input.
 */
function safePathSegment(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** One minted credential, as written to disk. */
export interface PersistedMintedCredential extends MintedSecrets {
  readonly v: 1;
  readonly mintedAt: string;
}

/** Absolute path a mint with this `keyId` is written to. */
export function mintedCredentialFilePath(keyId: string): string {
  return path.join(getConfigDir(), MINTED_KEYS_DIRNAME, `${safePathSegment(keyId)}.json`);
}

/**
 * Write a mint's one-time secrets to a private file and return a pointer to
 * it in place of the secrets themselves. Throws on a write failure —
 * `KeyAdminService.generateApiKey` catches that itself and turns it into a
 * `stage: "persist"` outcome; there is no other caller and no separate
 * "must not throw" boundary to route through.
 *
 * Refuses to overwrite an existing file for the same `keyId` by publishing
 * with `writeFileAtomic`'s `exclusive: true` (a `link()`, which fails with
 * `EEXIST` rather than overwriting — see `atomicWrite.ts`) instead of a
 * separate `existsSync` pre-check, which would leave its own TOCTOU gap
 * between the check and the write. `keyId` is server-controlled — a
 * hostile or buggy Console handing back the SAME `keyId` for a second mint
 * would otherwise be able to destroy the first mint's one-time secrets
 * permanently, even though the first key is still live and usable at
 * Console.
 */
export function persistMintedCredential(secrets: MintedSecrets): GenerateApiKeyResult {
  const filePath = mintedCredentialFilePath(secrets.keyId);
  const record: PersistedMintedCredential = {
    v: 1,
    mintedAt: new Date().toISOString(),
    ...secrets,
  };
  try {
    writeFileAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
      mkdirMode: 0o700,
      exclusive: true,
    });
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    // `writeFileAtomic` can raise EEXIST from TWO different syscalls, and
    // they mean opposite things. `link()` (`syscall: "link"`) reporting
    // EEXIST means `filePath` itself already exists — the real "this keyId
    // was already persisted" case this refusal exists for. But the temp file
    // is opened with `wx` (`syscall: "open"`) BEFORE the link is even
    // attempted, and that can also throw EEXIST — a stale sibling temp left
    // by a crashed process whose pid got reused. That case means NOTHING was
    // written to `filePath` and the secrets are gone, which is the opposite
    // of "already persisted once"; reporting it as a duplicate-keyId refusal
    // would send an operator looking for secrets that were never saved
    // anywhere. Only the `syscall: "link"` case gets the friendlier message;
    // everything else (including an `open`-syscall EEXIST) propagates as-is.
    if (errno.code === "EEXIST" && errno.syscall === "link") {
      throw new Error(
        `refusing to overwrite an existing credential file at ${filePath} — this keyId has already ` +
          `been persisted once`,
      );
    }
    throw err;
  }
  const { apiKey: _apiKey, privateKey: _privateKey, ...rest } = secrets;
  return { ...rest, credentialFile: filePath };
}
