import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "../src/atomicWrite.js";
import { getConfigDir } from "../src/configFile.js";
import type { MintedSecrets } from "../src/console/KeyAdminService";
import {
  mintedCredentialFilePath,
  persistMintedCredential,
} from "../src/console/mintedCredentialStore.js";

/**
 * Spies on `writeFileAtomic` (`{ spy: true }` keeps every other call's real
 * behaviour — `spyOn(container, "writeFileAtomic").mockImplementation(original)`,
 * per `@vitest/mocker`) so a single test can fail the NEXT write with
 * `mockImplementationOnce` instead of `chmod`ing the config dir. `chmod 0o500`
 * is a no-op under root (root ignores DAC entirely), which made the old version
 * of these tests pass locally and fail in a privileged container — see m2 in
 * `docs/pr44-major-findings-verification.md`. This seam has no such
 * dependency: it fails the call regardless of who is running the process.
 */
vi.mock("../src/atomicWrite.js", { spy: true });

afterEach(() => {
  // A leaked `mockImplementationOnce` from a test that failed before consuming
  // it would otherwise fail the NEXT write in the NEXT test — `mockReset`
  // clears the once-queue and, because this is a real spy, falls back to the
  // original `writeFileAtomic` rather than a permanent no-op.
  vi.mocked(writeFileAtomic).mockReset();
});

/**
 * The expected filename for a given raw `keyId`, computed independently of
 * `mintedCredentialFilePath` (not by calling it) so these tests verify the
 * actual naming scheme — SHA-256 hex digest of the full raw string — rather
 * than just that the function agrees with itself.
 */
function expectedSegment(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

let tmpDir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-minted-test-"));
  originalEnv = { ...process.env };
  process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
});

afterEach(() => {
  process.env = originalEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const CREDENTIAL: MintedSecrets = {
  apiKey: "hbr_minted_once",
  privateKey: "suiprivkey1child",
  permission: "read_write",
  spaceId: "sp_1",
  keyId: "key_1",
  privateBuckets: [{ bucketId: "b1", groupId: "g1" }],
};

describe("persistMintedCredential", () => {
  it("writes the secrets to a 0600 file under minted-keys/ and returns a pointer instead of them", () => {
    const redacted = persistMintedCredential(CREDENTIAL);

    const expectedPath = mintedCredentialFilePath(CREDENTIAL.keyId);
    expect(redacted.credentialFile).toBe(expectedPath);
    expect(expectedPath).toBe(
      path.join(getConfigDir(), "minted-keys", `${expectedSegment("key_1")}.json`),
    );
    expect("apiKey" in redacted).toBe(false);
    expect("privateKey" in redacted).toBe(false);
    expect(redacted.keyId).toBe("key_1");
    expect(redacted.privateBuckets).toEqual([{ bucketId: "b1", groupId: "g1" }]);

    const mode = fs.statSync(expectedPath).mode & 0o777;
    expect(mode).toBe(0o600);

    const written = JSON.parse(fs.readFileSync(expectedPath, "utf-8"));
    expect(written.apiKey).toBe("hbr_minted_once");
    expect(written.privateKey).toBe("suiprivkey1child");
    expect(typeof written.mintedAt).toBe("string");
  });

  it("confines a hostile keyId to the minted-keys directory", () => {
    const hostile = { ...CREDENTIAL, keyId: "../../../etc/passwd" };
    const redacted = persistMintedCredential(hostile);

    expect(path.dirname(redacted.credentialFile)).toBe(path.join(getConfigDir(), "minted-keys"));
    expect(fs.existsSync(redacted.credentialFile)).toBe(true);
  });

  it("throws rather than silently succeeding when the write fails", () => {
    const configDir = getConfigDir();
    fs.mkdirSync(configDir, { recursive: true });
    vi.mocked(writeFileAtomic).mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });

    expect(() => persistMintedCredential(CREDENTIAL)).toThrow();
  });

  it("refuses to overwrite an existing credential file for a repeated keyId (Finding 7)", () => {
    // A hostile or buggy Console handing back the SAME keyId for a second mint
    // must not be able to silently destroy the first mint's one-time secrets —
    // writeFileAtomic's normal rename-over-any-existing-file behavior would do
    // exactly that. persistMintedCredential must refuse the second write instead.
    const first = persistMintedCredential(CREDENTIAL);
    const secondAttempt: MintedSecrets = {
      ...CREDENTIAL,
      apiKey: "hbr_minted_second_should_never_land",
      privateKey: "suiprivkey1child_should_never_land",
    };

    expect(() => persistMintedCredential(secondAttempt)).toThrow(
      /refusing to overwrite|already been persisted/i,
    );

    // The file on disk must still hold the FIRST call's secrets, untouched.
    const written = JSON.parse(fs.readFileSync(first.credentialFile, "utf-8"));
    expect(written.apiKey).toBe(CREDENTIAL.apiKey);
    expect(written.privateKey).toBe(CREDENTIAL.privateKey);
  });

  it("is not blocked by a stale temp a crashed process left behind (F4, after M6)", () => {
    // This used to assert that a leftover temp threw EEXIST from `open(…, "wx")`
    // — a real hazard while the temp name was a pure function of destination +
    // pid, so a crashed process whose pid got reused collided with the next
    // attempt. M6 gave every attempt a random nonce, which removes the collision
    // itself rather than reporting it well: a leftover simply cannot occupy the
    // name the next attempt picks. The guard that distinguishes a temp-open
    // EEXIST from a link() EEXIST stays as defence, but nothing can reach it
    // through a planted temp any more, so the assertion is now the stronger one:
    // the write SUCCEEDS despite the leftover.
    const filePath = mintedCredentialFilePath(CREDENTIAL.keyId);
    const stale = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.tmp`, // the pre-M6 name shape
    );
    fs.mkdirSync(path.dirname(stale), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stale, "stale leftover from a crashed process");

    const result = persistMintedCredential(CREDENTIAL);

    expect(fs.existsSync(filePath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(result.credentialFile, "utf-8"));
    expect(written.apiKey).toBe(CREDENTIAL.apiKey);
    // The leftover is untouched — it was never this attempt's to clean up.
    expect(fs.readFileSync(stale, "utf-8")).toBe("stale leftover from a crashed process");
  });
});

describe("safePathSegment collision safety", () => {
  it("produces a deterministic, fixed-length filename for a normal short keyId", () => {
    // Filename READABILITY is no longer a property of safePathSegment (see its
    // doc comment) — it now always emits the 64-hex-character SHA-256 digest
    // of the full raw string, so "key_1" no longer round-trips to "key_1.json".
    const p = mintedCredentialFilePath("key_1");
    expect(p).toBe(path.join(getConfigDir(), "minted-keys", `${expectedSegment("key_1")}.json`));
    expect(path.basename(p, ".json")).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic: the same input always names the same file.
    expect(mintedCredentialFilePath("key_1")).toBe(p);
  });

  it("does not collide on two codepoints whose old variable-width hex escapes had different widths", () => {
    // This is the concrete case that broke the round-1 (marker + truncation)
    // fix: under the escape scheme `` `~${codePointAt(0).toString(16).padStart(2,"0")}` ``,
    // U+001F escaped to "~1f" (2 hex digits) and U+01F6 escaped to
    // "~1f6" (3 hex digits — padStart(2, "0") enforces only a MINIMUM
    // width). With no delimiter marking where an escape ends, raw U+001F
    // followed by a literal "6", and raw U+01F6 alone, both produced the
    // identical path segment "~1f6" — confirmed by direct execution
    // before this fix. A full-string hash has no such variable-width
    // ambiguity.
    //
    // keyId1/keyId2 are written with explicit \u escapes rather than a
    // pasted literal character, so the non-printable U+001F survives
    // verbatim in source instead of risking silent loss in transcription
    // (an editing tool once turned a pasted U+001F into an empty string
    // here — caught only by the codePointAt assertions below).
    const keyId1 = "\u001f" + "6";
    const keyId2 = "\u01f6";
    expect(Array.from(keyId1, (c) => c.codePointAt(0))).toEqual([0x1f, 0x36]);
    expect(keyId2.codePointAt(0)).toBe(0x1f6);
    expect(mintedCredentialFilePath(keyId1)).not.toBe(mintedCredentialFilePath(keyId2));
  });

  it("does not let two keyIds that collided under an ambiguous escape marker collide now", () => {
    // Regression coverage carried over from the marker-collision bug: an
    // early version used "_" as both the escape marker and an allowed
    // pass-through character, so these two different raw strings both
    // escaped to the literal filename "A_20B.json". A hash of the full
    // string has no marker to collide with.
    const pathA = mintedCredentialFilePath("A B");
    const pathB = mintedCredentialFilePath("A_20B");
    expect(pathA).not.toBe(pathB);
  });

  it("does not let two long, similar keyIds collide", () => {
    // Regression coverage carried over from the truncation-collision bug: two
    // long raw strings sharing a long common prefix used to be able to share
    // the same truncated escaped prefix. Hashing the full string (there is no
    // truncation left to bound) means length no longer matters.
    const base = "x".repeat(250);
    const keyId1 = `${base}-one`;
    const keyId2 = `${base}-two`;
    expect(mintedCredentialFilePath(keyId1)).not.toBe(mintedCredentialFilePath(keyId2));
  });

  it("does not let a keyId collide with a longer keyId that has it as a prefix", () => {
    const base = "y".repeat(250);
    const short = mintedCredentialFilePath(base);
    const long = mintedCredentialFilePath(`${base}-extra-tail`);
    expect(short).not.toBe(long);
  });

  it("persists two long, similar keyIds to two separate files", () => {
    const base = "z".repeat(250);
    const credentialOne: MintedSecrets = { ...CREDENTIAL, keyId: `${base}-one` };
    const credentialTwo: MintedSecrets = {
      ...CREDENTIAL,
      apiKey: "hbr_minted_second",
      keyId: `${base}-two`,
    };

    const redactedOne = persistMintedCredential(credentialOne);
    const redactedTwo = persistMintedCredential(credentialTwo);

    expect(redactedOne.credentialFile).not.toBe(redactedTwo.credentialFile);
    const writtenOne = JSON.parse(fs.readFileSync(redactedOne.credentialFile, "utf-8"));
    const writtenTwo = JSON.parse(fs.readFileSync(redactedTwo.credentialFile, "utf-8"));
    expect(writtenOne.apiKey).toBe("hbr_minted_once");
    expect(writtenTwo.apiKey).toBe("hbr_minted_second");
  });
});
