import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "../src/atomicWrite.js";
import {
  type ConfigFileData,
  getAdminConfigFilePath,
  getConfigDir,
  getConfigFilePath,
  loadConfigFile,
  loadConfigFileOrEmpty,
  mergeConfigFile,
  saveConfigFile,
} from "../src/configFile.js";

/**
 * Spies on `writeFileAtomic` (`{ spy: true }` keeps every call's real
 * behaviour by default) so the C1 regression test below can fail one
 * specific write in a two-write sequence with `mockImplementationOnce`,
 * the same seam `mintedCredentialStore.test.ts` uses — see its doc comment
 * for why this replaced `chmod`-based failure injection.
 */
vi.mock("../src/atomicWrite.js", { spy: true });

// Use a temp directory so tests don't touch the real ~/.config
let tmpDir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-mcp-test-"));
  originalEnv = { ...process.env };
  // Point XDG_CONFIG_HOME at our temp dir so getConfigDir resolves there
  process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
});

afterEach(() => {
  process.env = originalEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // A leaked `mockImplementationOnce` from a test that failed before
  // consuming it would otherwise fail the NEXT write in the NEXT test —
  // `mockReset` clears the once-queue and, because this is a real spy,
  // falls back to the original `writeFileAtomic` rather than a permanent
  // no-op.
  vi.mocked(writeFileAtomic).mockReset();
});

describe("getConfigDir", () => {
  it("uses XDG_CONFIG_HOME when set", () => {
    const dir = getConfigDir();
    expect(dir).toBe(path.join(tmpDir, "walrus-console-mcp"));
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    const { XDG_CONFIG_HOME: _xdgConfigHome, ...envWithoutXdg } = process.env;
    process.env = envWithoutXdg;
    const dir = getConfigDir();
    expect(dir).toBe(path.join(os.homedir(), ".config", "walrus-console-mcp"));
  });
});

describe("loadConfigFile", () => {
  it("returns empty object when file does not exist", () => {
    const result = loadConfigFile();
    expect(result).toEqual({});
  });

  it("throws a path-named error when the file contains invalid JSON", () => {
    // A parse failure must NOT resolve to {}: the write path merges over the
    // result, so a phantom empty object would silently wipe every saved
    // credential the corrupt file still holds. Refuse loudly instead.
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "not json", "utf-8");
    expect(() => loadConfigFile()).toThrow(/could not be parsed/i);
    expect(() => loadConfigFile()).toThrow(getConfigFilePath());
  });

  it("throws a path-named error when the file cannot be read (non-ENOENT)", () => {
    // Put a *directory* where the config file belongs so readFileSync fails with
    // EISDIR — a non-ENOENT read error on every platform, no chmod/root games.
    const dir = getConfigDir();
    fs.mkdirSync(path.join(dir, "config.json"), { recursive: true });
    expect(() => loadConfigFile()).toThrow(/could not be read/i);
    expect(() => loadConfigFile()).toThrow(getConfigFilePath());
  });

  it("loadConfigFileOrEmpty returns {} on a corrupt file instead of throwing (review bug_002)", () => {
    // The read-only boot and redaction-wiring paths, and the install/config repair
    // commands, must not be taken down by a corrupt file — they use the safe
    // wrapper, which warns and falls back to {} so env credentials still apply.
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json", "utf-8");
    expect(() => loadConfigFile()).toThrow(); // the fail-stop reader still throws
    expect(loadConfigFileOrEmpty()).toEqual({}); // the safe wrapper does not
  });

  it("ignores non-string fields", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ apiKey: 123, servicePrivateKey: true, baseUrl: null }),
      "utf-8",
    );
    const result = loadConfigFile();
    expect(result).toEqual({
      apiKey: undefined,
      servicePrivateKey: undefined,
      baseUrl: undefined,
    });
  });

  it("ignores an off-policy baseUrl (defense in depth against a tampered file)", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ apiKey: "hbr_x", baseUrl: "https://evil.com" }),
      "utf-8",
    );
    const result = loadConfigFile();
    expect(result.apiKey).toBe("hbr_x");
    expect(result.baseUrl).toBeUndefined();
  });

  it("keeps an allowed baseUrl", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ baseUrl: "https://api.testnet.console.walrus.xyz" }),
      "utf-8",
    );
    expect(loadConfigFile().baseUrl).toBe("https://api.testnet.console.walrus.xyz");
  });
});

describe("saveConfigFile", () => {
  it("creates directory and file with config data", () => {
    const data: ConfigFileData = {
      apiKey: "hbr_test123",
      servicePrivateKey: "suiprivkey1_abc",
      baseUrl: "https://api.testnet.console.walrus.xyz",
    };
    saveConfigFile(data);

    const dir = getConfigDir();
    expect(fs.existsSync(dir)).toBe(true);

    const filePath = path.join(dir, "config.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.v).toBe(1);
    expect(parsed.apiKey).toBe("hbr_test123");
    expect(parsed.servicePrivateKey).toBe("suiprivkey1_abc");
    expect(parsed.baseUrl).toBe("https://api.testnet.console.walrus.xyz");
    // One JSON value plus the trailing newline — pasteable into the one-line installer prompt.
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trimEnd().includes("\n")).toBe(false);
  });

  it("overwrites existing config file", () => {
    saveConfigFile({ apiKey: "hbr_old" });
    saveConfigFile({ apiKey: "hbr_new", servicePrivateKey: "suiprivkey1_new" });

    const result = loadConfigFile();
    expect(result.apiKey).toBe("hbr_new");
    expect(result.servicePrivateKey).toBe("suiprivkey1_new");
  });
});

describe("round-trip: save then load", () => {
  it("loadConfigFile returns what saveConfigFile wrote", () => {
    const data: ConfigFileData = {
      apiKey: "hbr_roundtrip",
      servicePrivateKey: "suiprivkey1_roundtrip",
    };
    saveConfigFile(data);
    const loaded = loadConfigFile();
    expect(loaded.apiKey).toBe("hbr_roundtrip");
    expect(loaded.servicePrivateKey).toBe("suiprivkey1_roundtrip");
    expect(loaded.baseUrl).toBeUndefined();
  });
});

describe("management key fields", () => {
  it("round-trips adminKey and adminServicePrivateKey", () => {
    saveConfigFile({ adminKey: "hbradm_abc", adminServicePrivateKey: "suiprivkey1_admin" });
    const loaded = loadConfigFile();
    expect(loaded.adminKey).toBe("hbradm_abc");
    expect(loaded.adminServicePrivateKey).toBe("suiprivkey1_admin");
  });

  it("ignores non-string admin fields", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ adminKey: 42, adminServicePrivateKey: { nested: true } }),
      "utf-8",
    );
    const loaded = loadConfigFile();
    expect(loaded.adminKey).toBeUndefined();
    expect(loaded.adminServicePrivateKey).toBeUndefined();
  });
});

describe("address pin fields", () => {
  const WEB_ACCOUNT_ADDRESS = `0x${"a".repeat(64)}`;
  const KEY_ADMIN_ADDRESS = `0x${"b".repeat(64)}`;

  it("round-trips webAccountAddress and keyAdminAddress", () => {
    saveConfigFile({ webAccountAddress: WEB_ACCOUNT_ADDRESS, keyAdminAddress: KEY_ADMIN_ADDRESS });
    const loaded = loadConfigFile();
    expect(loaded.webAccountAddress).toBe(WEB_ACCOUNT_ADDRESS);
    expect(loaded.keyAdminAddress).toBe(KEY_ADMIN_ADDRESS);
  });

  it("ignores a non-address webAccountAddress on load", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ webAccountAddress: "not-an-address" }),
      "utf-8",
    );
    expect(loadConfigFile().webAccountAddress).toBeUndefined();
  });

  // Symmetric guard on the second address field — same isValidSuiAddress check,
  // exercised on the other property so both trust anchors are covered.
  it("ignores a non-address keyAdminAddress on load", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ keyAdminAddress: "0xnothex" }),
      "utf-8",
    );
    expect(loadConfigFile().keyAdminAddress).toBeUndefined();
  });
});

describe("allowedDirs field", () => {
  it("round-trips a list of absolute directories", () => {
    saveConfigFile({ allowedDirs: [tmpDir, path.join(tmpDir, "nested")] });
    expect(loadConfigFile().allowedDirs).toEqual([tmpDir, path.join(tmpDir, "nested")]);
  });

  it("ignores a non-array allowedDirs", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ allowedDirs: "/not/an/array" }),
      "utf-8",
    );
    expect(loadConfigFile().allowedDirs).toBeUndefined();
  });

  it("drops non-strings and blanks, and omits an empty result", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ allowedDirs: [tmpDir, 12, "  ", "", { x: 1 }] }),
      "utf-8",
    );
    expect(loadConfigFile().allowedDirs).toEqual([tmpDir]);
  });

  it("mergeConfigFile can set allowedDirs without clobbering credentials", () => {
    saveConfigFile({ apiKey: "hbr_keep" });
    mergeConfigFile({ allowedDirs: [tmpDir] });
    const loaded = loadConfigFile();
    expect(loaded.apiKey).toBe("hbr_keep");
    expect(loaded.allowedDirs).toEqual([tmpDir]);
  });
});

describe("mergeConfigFile", () => {
  it("adds admin fields without clobbering the working key", () => {
    saveConfigFile({
      apiKey: "hbr_keep",
      servicePrivateKey: "suiprivkey1_keep",
      // Must be allowlisted: the merge reloads through loadConfigFile, which
      // drops an off-policy baseUrl (see the case below).
      baseUrl: "https://api.mainnet.console.walrus.xyz",
    });
    const merged = mergeConfigFile({
      adminKey: "hbradm_new",
      adminServicePrivateKey: "suiprivkey1_new",
    });

    expect(merged.apiKey).toBe("hbr_keep");
    expect(merged.servicePrivateKey).toBe("suiprivkey1_keep");
    expect(merged.baseUrl).toBe("https://api.mainnet.console.walrus.xyz");
    expect(merged.adminKey).toBe("hbradm_new");

    const reloaded = loadConfigFile();
    expect(reloaded.apiKey).toBe("hbr_keep");
    expect(reloaded.adminKey).toBe("hbradm_new");
  });

  // The merge reloads the file first, so a baseUrl written before the allowlist
  // existed (or edited in by hand) is dropped rather than carried forward.
  it("drops an off-policy baseUrl already on disk instead of preserving it", () => {
    saveConfigFile({ apiKey: "hbr_keep" });
    fs.writeFileSync(
      getConfigFilePath(),
      JSON.stringify({ apiKey: "hbr_keep", baseUrl: "https://evil.com" }),
      "utf-8",
    );

    const merged = mergeConfigFile({ adminKey: "hbradm_new" });

    expect(merged.apiKey).toBe("hbr_keep");
    expect(merged.adminKey).toBe("hbradm_new");
    expect(merged.baseUrl).toBeUndefined();
  });

  it("overwrites only the fields it is given", () => {
    saveConfigFile({ apiKey: "hbr_old", adminKey: "hbradm_old" });
    mergeConfigFile({ apiKey: "hbr_new" });
    const loaded = loadConfigFile();
    expect(loaded.apiKey).toBe("hbr_new");
    expect(loaded.adminKey).toBe("hbradm_old");
  });

  it("works when no config file exists yet", () => {
    const merged = mergeConfigFile({ adminKey: "hbradm_first" });
    expect(merged.adminKey).toBe("hbradm_first");
    expect(loadConfigFile().adminKey).toBe("hbradm_first");
  });
});

describe("mergeConfigFile — clearing fields", () => {
  // Removing a saved field cannot be expressed through `updates`: the type is
  // exactOptionalPropertyTypes, so `{ baseUrl: undefined }` does not typecheck,
  // and omitting the key means "preserve" by design. Clearing therefore has to be
  // its own explicit argument — used when rotating an API key away from its old
  // signer, and when a resolved base URL falls back to the default.
  it("removes a listed key that was previously saved", () => {
    saveConfigFile({ apiKey: "hbr_key", baseUrl: "http://localhost:3000" });

    const merged = mergeConfigFile({}, ["baseUrl"]);

    expect(merged.baseUrl).toBeUndefined();
    expect(loadConfigFile().baseUrl).toBeUndefined();
    // Clearing one field must not disturb the others.
    expect(loadConfigFile().apiKey).toBe("hbr_key");
  });

  it("is a no-op when the listed key was never set", () => {
    saveConfigFile({ apiKey: "hbr_key" });

    expect(() => mergeConfigFile({}, ["baseUrl"])).not.toThrow();
    expect(loadConfigFile().apiKey).toBe("hbr_key");
  });

  it("clears a stale field while writing a new value for another", () => {
    saveConfigFile({ apiKey: "hbr_old", servicePrivateKey: "suiprivkey1old" });

    mergeConfigFile({ apiKey: "hbr_new" }, ["servicePrivateKey"]);

    expect(loadConfigFile().apiKey).toBe("hbr_new");
    expect(loadConfigFile().servicePrivateKey).toBeUndefined();
  });

  it("applies the clear after the update, so a key in both ends up cleared", () => {
    saveConfigFile({ baseUrl: "http://localhost:3000" });

    mergeConfigFile({ baseUrl: "https://api.staging.walrus.xyz" }, ["baseUrl"]);

    expect(loadConfigFile().baseUrl).toBeUndefined();
  });

  it("preserves every field when nothing is listed", () => {
    saveConfigFile({ apiKey: "hbr_key", baseUrl: "http://localhost:3000" });

    mergeConfigFile({ adminKey: "hbradm_key" });

    const after = loadConfigFile();
    expect(after.apiKey).toBe("hbr_key");
    expect(after.baseUrl).toBe("http://localhost:3000");
    expect(after.adminKey).toBe("hbradm_key");
  });
});

describe("admin credential file separation", () => {
  it("writes adminKey/adminServicePrivateKey to admin.json, never to config.json", () => {
    saveConfigFile({
      apiKey: "hbr_working",
      adminKey: "hbradm_secret",
      adminServicePrivateKey: "suiprivkey1_admin_secret",
    });

    const onDiskConfig = JSON.parse(fs.readFileSync(getConfigFilePath(), "utf-8"));
    expect(onDiskConfig.apiKey).toBe("hbr_working");
    expect(onDiskConfig.adminKey).toBeUndefined();
    expect(onDiskConfig.adminServicePrivateKey).toBeUndefined();

    const onDiskAdmin = JSON.parse(fs.readFileSync(getAdminConfigFilePath(), "utf-8"));
    expect(onDiskAdmin.adminKey).toBe("hbradm_secret");
    expect(onDiskAdmin.adminServicePrivateKey).toBe("suiprivkey1_admin_secret");

    // The public read contract is unchanged: both fields still come back
    // merged into one object, regardless of which file they live in.
    const loaded = loadConfigFile();
    expect(loaded.apiKey).toBe("hbr_working");
    expect(loaded.adminKey).toBe("hbradm_secret");
    expect(loaded.adminServicePrivateKey).toBe("suiprivkey1_admin_secret");
  });

  it("mergeConfigFile also routes admin fields to admin.json, not config.json", () => {
    saveConfigFile({ apiKey: "hbr_working" });
    mergeConfigFile({ adminKey: "hbradm_via_merge" });

    const onDiskConfig = JSON.parse(fs.readFileSync(getConfigFilePath(), "utf-8"));
    expect(onDiskConfig.adminKey).toBeUndefined();

    const onDiskAdmin = JSON.parse(fs.readFileSync(getAdminConfigFilePath(), "utf-8"));
    expect(onDiskAdmin.adminKey).toBe("hbradm_via_merge");
  });

  it("clearing adminKey removes it from admin.json, not just from the merged object", () => {
    saveConfigFile({ apiKey: "hbr_working", adminKey: "hbradm_old" });

    mergeConfigFile({}, ["adminKey"]);

    const onDiskAdmin = JSON.parse(fs.readFileSync(getAdminConfigFilePath(), "utf-8"));
    expect(onDiskAdmin.adminKey).toBeUndefined();
    expect(loadConfigFile().adminKey).toBeUndefined();
  });

  it("a legacy config.json with inline admin fields still reads correctly (no admin.json yet)", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        apiKey: "hbr_legacy",
        adminKey: "hbradm_legacy",
        adminServicePrivateKey: "suiprivkey1_legacy",
      }),
      "utf-8",
    );

    const loaded = loadConfigFile();
    expect(loaded.apiKey).toBe("hbr_legacy");
    expect(loaded.adminKey).toBe("hbradm_legacy");
    expect(loaded.adminServicePrivateKey).toBe("suiprivkey1_legacy");
  });

  it("self-heals a legacy config.json on the next write: admin fields relocate to admin.json", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ apiKey: "hbr_legacy", adminKey: "hbradm_legacy" }),
      "utf-8",
    );

    // Any write at all — not a dedicated migration step — triggers the split,
    // because mergeConfigFile reads the full (merged) state and saveConfigFile
    // always routes admin fields to admin.json from then on.
    mergeConfigFile({});

    const onDiskConfig = JSON.parse(fs.readFileSync(getConfigFilePath(), "utf-8"));
    expect(onDiskConfig.adminKey).toBeUndefined();
    expect(onDiskConfig.apiKey).toBe("hbr_legacy");

    const onDiskAdmin = JSON.parse(fs.readFileSync(getAdminConfigFilePath(), "utf-8"));
    expect(onDiskAdmin.adminKey).toBe("hbradm_legacy");
    expect(loadConfigFile().adminKey).toBe("hbradm_legacy");
  });

  // security review, C8: this exact migration used to happen with zero
  // sign it occurred — an operator asking only to add an allowed-dirs folder
  // had their management credential relocated with nothing printed about it.
  it("warns once when an unrelated write migrates a legacy inline admin pair (C8)", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ apiKey: "hbr_legacy", adminKey: "hbradm_legacy" }),
      "utf-8",
    );

    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // An unrelated write — not a credential change — is what the C8 review
      // fixture used, precisely because it should be the LEAST expected
      // trigger for a credential to move.
      mergeConfigFile({ allowedDirs: [os.tmpdir()] });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(getAdminConfigFilePath());
      // The default notice keeps the `[console-mcp]` prefix a plain script or
      // --silent run expects on stderr.
      expect(warn.mock.calls[0]?.[0]).toContain("[console-mcp]");

      // The very next write finds admin.json already there and stays silent.
      warn.mockClear();
      mergeConfigFile({ allowedDirs: [os.tmpdir()] });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // The interactive `install`/`config` panels print their own bordered lines
  // and pass this instead of letting the notice fall through to the default
  // console.error — a bare stderr write mid-render breaks the panel's `│`
  // border (see the doc comment on mergeConfigFile's `onNotice` param). This
  // proves the seam those callers rely on: a custom `onNotice` receives
  // exactly the migration message, unprefixed, and console.error is never
  // touched at all.
  it("routes the migration notice through a custom onNotice instead of console.error", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ apiKey: "hbr_legacy", adminKey: "hbradm_legacy" }),
      "utf-8",
    );

    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const onNotice = vi.fn();
    try {
      mergeConfigFile({ allowedDirs: [os.tmpdir()] }, [], onNotice);
      expect(warn).not.toHaveBeenCalled();
      expect(onNotice).toHaveBeenCalledTimes(1);
      expect(onNotice.mock.calls[0]?.[0]).toContain(getAdminConfigFilePath());
      // Unprefixed: the caller's own line-printer supplies its own framing
      // (a bullet inside a bordered panel row), not the bare-stderr prefix.
      expect(onNotice.mock.calls[0]?.[0]).not.toContain("[console-mcp]");
    } finally {
      warn.mockRestore();
    }
  });

  // The same migration trigger must NOT fire the notice when the admin pair
  // is a deliberately NEW credential this call itself is writing — that is
  // an ordinary save, not a migration, and warning about it would be noise
  // (or actively misleading: nothing was "moved", it was configured for the
  // first time).
  it("does not warn when writing a brand-new admin credential (not a migration)", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mergeConfigFile({ adminKey: "hbradm_new", adminServicePrivateKey: "suiprivkey1_new" });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // security review, C15: unlike the "brand-new credential" case above,
  // there WAS a legacy pair here (`before.adminKey` came from config.json's
  // inline fallback, since admin.json doesn't exist yet) — this call is
  // rotating it, not configuring one for the first time. The relocation to
  // admin.json still happens on this exact save, so the compatibility
  // warning (an older binary won't see it there) is exactly as relevant as
  // in the C8 test above; only requiring `updates.adminKey === undefined`
  // wrongly treated "rotated while migrating" the same as "brand-new".
  it("warns on the first post-upgrade write even when that write is itself a rotation (C15)", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ apiKey: "hbr_legacy", adminKey: "hbradm_old" }),
      "utf-8",
    );

    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mergeConfigFile({ adminKey: "hbradm_rotated", adminServicePrivateKey: "suiprivkey1_new" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(getAdminConfigFilePath());
    } finally {
      warn.mockRestore();
    }

    const onDiskAdmin = JSON.parse(fs.readFileSync(getAdminConfigFilePath(), "utf-8"));
    expect(onDiskAdmin.adminKey).toBe("hbradm_rotated");
  });

  it("admin.json wins when an inline admin field left in config.json agrees with it", () => {
    saveConfigFile({ apiKey: "hbr_x", adminKey: "hbradm_current" });
    // A duplicate left by a C1 partial-write recovery: config.json still
    // carries the same value admin.json holds. Which one "wins" is not
    // observable here, but the read must still succeed and return it.
    const configPath = getConfigFilePath();
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...onDisk, adminKey: "hbradm_current" }),
      "utf-8",
    );

    expect(loadConfigFile().adminKey).toBe("hbradm_current");
  });

  // security review, C7: a management key rotated with a binary that
  // predates this split writes the WHOLE pair inline into config.json (it has
  // no concept of admin.json), so the inline value ends up NEWER than
  // admin.json's. The old unconditional "admin.json always wins" precedence
  // discarded that rotation on the very next unrelated write — mergeConfigFile
  // reads through loadConfigFile, splitAdminFields strips the inline pair
  // before saving config.json, and the superseded admin.json value is all
  // that survives in either file. Verified by reproducing exactly that: write
  // a disagreeing inline value, then perform an unrelated merge and confirm
  // the ROTATED (inline) value is what ends up in admin.json.
  it("keeps a disagreeing inline admin field, letting the next write migrate a rotation instead of discarding it (C7)", () => {
    saveConfigFile({ apiKey: "hbr_x", adminKey: "hbradm_superseded" });
    const configPath = getConfigFilePath();
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    // Simulate an older binary rotating the key: it knows only config.json, so
    // the new value lands inline there, while admin.json still holds the old one.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...onDisk, adminKey: "hbradm_rotated" }),
      "utf-8",
    );

    // The read alone must prefer the inline (newer) value...
    expect(loadConfigFile().adminKey).toBe("hbradm_rotated");

    // ...and an unrelated write must migrate it into admin.json rather than
    // overwrite it with the superseded value — the exact failure C7 reported.
    mergeConfigFile({ allowedDirs: [os.tmpdir()] });

    const onDiskAdmin = JSON.parse(fs.readFileSync(getAdminConfigFilePath(), "utf-8"));
    expect(onDiskAdmin.adminKey).toBe("hbradm_rotated");
    const onDiskConfigAfter = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(onDiskConfigAfter.adminKey).toBeUndefined();
  });

  // security review, C12 (introduced by the C7 fix above, 8b9f4d5c) and
  // C17 (the mtime-based fix that originally closed C12 — mtimes survive a
  // directory copy unreliably, e.g. `cp -R` or `rsync` without `-t` can tie
  // or reorder them independently of which file was genuinely written more
  // recently): "inline wins whenever present" cannot tell C7's case
  // (config.json genuinely rotated by an older binary) from a C1
  // partial-write failure (admin.json's write succeeded; config.json's
  // failed write left a now-superseded inline pair behind). Both look
  // identical to `applyAdminFile` as "inline present, differs from
  // admin.json". Reproduced through the real `mergeConfigFile` →
  // `saveConfigFile` path (not hand-written files) so `admin.json` actually
  // records the `supersedes` digest a real rotation would, and the second
  // (config.json) write genuinely fails via the same `vi.mock` seam the C1
  // test above uses — no mtime manipulation anywhere.
  it("admin.json (with the matching supersedes digest) wins over a stale inline duplicate left by a failed second write, not the reverse (C12)", async () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    const configPath = getConfigFilePath();
    const adminPath = getAdminConfigFilePath();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        apiKey: "hbr_x",
        adminKey: "hbradm_superseded",
        adminServicePrivateKey: "suiprivkey1_superseded",
      }),
      "utf-8",
    );

    const { writeFileAtomic: realWriteFileAtomic } =
      await vi.importActual<typeof import("../src/atomicWrite.js")>("../src/atomicWrite.js");
    vi.mocked(writeFileAtomic)
      .mockImplementationOnce(realWriteFileAtomic) // admin.json: real write, succeeds
      .mockImplementationOnce(() => {
        // config.json: fails, leaving the OLD inline pair on disk
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      });
    expect(() =>
      mergeConfigFile({
        adminKey: "hbradm_rotated",
        adminServicePrivateKey: "suiprivkey1_rotated",
      }),
    ).toThrow();

    // Precondition: exactly the duplicated state C1 promises to leave behind.
    expect(JSON.parse(fs.readFileSync(adminPath, "utf-8")).adminKey).toBe("hbradm_rotated");
    expect(JSON.parse(fs.readFileSync(configPath, "utf-8")).adminKey).toBe("hbradm_superseded");

    expect(loadConfigFile().adminKey).toBe("hbradm_rotated");

    // The next unrelated write must not resurrect the stale duplicate — it
    // should keep the fresher admin.json value and self-heal by stripping
    // the leftover inline copy.
    mergeConfigFile({ allowedDirs: [os.tmpdir()] });
    const onDiskAdmin = JSON.parse(fs.readFileSync(adminPath, "utf-8"));
    expect(onDiskAdmin.adminKey).toBe("hbradm_rotated");
    const onDiskConfigAfter = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(onDiskConfigAfter.adminKey).toBeUndefined();
  });

  // C17's actual repro: a directory copy (cp -R, rsync without -t…) can tie
  // or reorder the two files' mtimes regardless of which was really written
  // last. Proves the fix no longer looks at mtime at all — explicitly
  // stamping admin.json OLDER than config.json (the opposite of what C12's
  // fix relied on) must not change the outcome.
  it("still picks admin.json correctly even when a directory copy makes it look OLDER than the stale inline duplicate (C17)", async () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    const configPath = getConfigFilePath();
    const adminPath = getAdminConfigFilePath();
    fs.writeFileSync(
      configPath,
      JSON.stringify({ apiKey: "hbr_x", adminKey: "hbradm_superseded" }),
      "utf-8",
    );
    const { writeFileAtomic: realWriteFileAtomic } =
      await vi.importActual<typeof import("../src/atomicWrite.js")>("../src/atomicWrite.js");
    vi.mocked(writeFileAtomic)
      .mockImplementationOnce(realWriteFileAtomic)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      });
    expect(() => mergeConfigFile({ adminKey: "hbradm_rotated" })).toThrow();

    // Simulate a `cp -R`-style copy that rewrites both mtimes in write order,
    // making admin.json look OLDER than the stale inline duplicate — the
    // exact inversion that broke the mtime-based fix.
    const past = new Date(Date.now() - 60_000);
    const now = new Date();
    fs.utimesSync(adminPath, past, past);
    fs.utimesSync(configPath, now, now);

    expect(loadConfigFile().adminKey).toBe("hbradm_rotated");
  });

  it("ignores non-string admin fields in admin.json", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "admin.json"),
      JSON.stringify({ adminKey: 42, adminServicePrivateKey: { nested: true } }),
      "utf-8",
    );
    const loaded = loadConfigFile();
    expect(loaded.adminKey).toBeUndefined();
    expect(loaded.adminServicePrivateKey).toBeUndefined();
  });

  it("throws a path-named error when admin.json contains invalid JSON", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "admin.json"), "not json", "utf-8");
    expect(() => loadConfigFile()).toThrow(/could not be parsed/i);
    expect(() => loadConfigFile()).toThrow(getAdminConfigFilePath());
  });

  // security review, C14: `null`, an array, or a bare primitive all parse
  // as valid JSON but are not a config object — the old code treated that the
  // SAME as a missing file (silent `{}`), which is exactly the "phantom {}
  // from a corrupt file" the fail-loud discipline exists to prevent (see
  // `readJsonFileOrThrow`'s own doc comment). Left uncaught, a save right
  // after would treat the file as never having held anything and overwrite
  // it with no error and no warning at all — worse than the loud "corrupt
  // JSON" case, which at least stops the write.
  it("throws, rather than silently reading as empty, when admin.json is valid JSON but not an object (C14)", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "admin.json"), "null", "utf-8");
    expect(() => loadConfigFile()).toThrow(/does not contain a json object/i);
    expect(() => loadConfigFile()).toThrow(getAdminConfigFilePath());
  });

  it("throws, rather than silently reading as empty, when config.json is a JSON array (C14)", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "[1,2,3]", "utf-8");
    expect(() => loadConfigFile()).toThrow(/does not contain a json object/i);
    expect(() => loadConfigFile()).toThrow(getConfigFilePath());
  });

  it("a non-object admin.json does not get silently overwritten by the next save (C14)", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "admin.json"), "null", "utf-8");
    expect(() => mergeConfigFile({ allowedDirs: [os.tmpdir()] })).toThrow(
      /does not contain a json object/i,
    );
    // The write must not have happened — the operator still has a chance to
    // hand-repair the file instead of finding it silently replaced.
    expect(fs.readFileSync(path.join(dir, "admin.json"), "utf-8")).toBe("null");
  });

  it("loadConfigFileOrEmpty keeps a healthy config.json when admin.json is corrupt", () => {
    // The two files degrade independently: admin.json corruption must not
    // discard a perfectly healthy working key that has nothing to do with
    // it. loadConfigFile (the write-path reader) still throws on either
    // file, same as before — mergeConfigFile must never RMW over a damaged
    // one.
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ apiKey: "hbr_ok" }), "utf-8");
    fs.writeFileSync(path.join(dir, "admin.json"), "{ not json", "utf-8");
    expect(() => loadConfigFile()).toThrow();
    expect(loadConfigFileOrEmpty()).toEqual({ apiKey: "hbr_ok" });
  });

  // security review, C13: degradation must work in BOTH directions. The
  // C2 test above proves a corrupt admin.json doesn't discard a healthy
  // config.json; this is the mirror case, which used to return {} and drop
  // a perfectly healthy admin.json purely because the UNRELATED config.json
  // failed to parse — the same bug C2 fixed, just on the other file.
  it("loadConfigFileOrEmpty keeps a healthy admin.json when config.json itself is corrupt (C13)", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json", "utf-8");
    fs.writeFileSync(
      path.join(dir, "admin.json"),
      JSON.stringify({ adminKey: "hbradm_ok" }),
      "utf-8",
    );
    expect(loadConfigFileOrEmpty()).toEqual({ adminKey: "hbradm_ok" });
  });

  it("loadConfigFileOrEmpty returns {} when both files are corrupt", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json", "utf-8");
    fs.writeFileSync(path.join(dir, "admin.json"), "{ also not json", "utf-8");
    expect(loadConfigFileOrEmpty()).toEqual({});
  });

  it("supports a custom onNotice for its own warnings, not just mergeConfigFile's (C18)", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json", "utf-8");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const onNotice = vi.fn();
    try {
      loadConfigFileOrEmpty(onNotice);
      expect(warn).not.toHaveBeenCalled();
      expect(onNotice).toHaveBeenCalledTimes(1);
      expect(onNotice.mock.calls[0]?.[0]).toContain(getConfigFilePath());
      expect(onNotice.mock.calls[0]?.[0]).not.toContain("[console-mcp]");
    } finally {
      warn.mockRestore();
    }
  });

  // security review, C16b: every independent loadConfigFileOrEmpty caller
  // (server startup, each interactive step's pre-write check, base-URL
  // resolution…) used to re-read and re-warn about the same corrupt file, so
  // one `config` run could print the identical warning 3-4 times. A distinct
  // file gets its own warning; the SAME file, read repeatedly, warns once.
  it("warns about a given corrupt file at most once per process (C16b)", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json", "utf-8");
    const onNotice = vi.fn();
    loadConfigFileOrEmpty(onNotice);
    loadConfigFileOrEmpty(onNotice);
    loadConfigFileOrEmpty(onNotice);
    expect(onNotice).toHaveBeenCalledTimes(1);
  });

  it("does not create admin.json on a host that never configured a management key", () => {
    // Writing an empty admin.json unconditionally would (a) give every host a
    // file that can fail to parse, turning admin.json corruption from a
    // provisioning-host problem into a fleet-wide one, and (b) destroy the
    // file's value as a signal for "does this host hold a management
    // credential?", which the README's worker-host guidance relies on.
    saveConfigFile({ apiKey: "hbr_only" });
    expect(fs.existsSync(getAdminConfigFilePath())).toBe(false);
    expect(loadConfigFile()).toEqual({ apiKey: "hbr_only" });
  });

  it("still writes an empty admin.json when clearing an existing one", () => {
    // The whole-file-replacement contract config.json has is preserved for
    // admin.json too: a caller that explicitly clears the admin pair gets a
    // real (empty) file back, not a stale one with the old secret still on
    // disk.
    saveConfigFile({ apiKey: "hbr_only", adminKey: "hbradm_old" });
    expect(fs.existsSync(getAdminConfigFilePath())).toBe(true);

    mergeConfigFile({}, ["adminKey"]);

    const onDiskAdmin = JSON.parse(fs.readFileSync(getAdminConfigFilePath(), "utf-8"));
    expect(onDiskAdmin.adminKey).toBeUndefined();
  });

  it("survives a failure on the second (config.json) write during a legacy migration", async () => {
    // admin.json is written FIRST, config.json second: if the second write
    // fails, the pair is still safely on disk in admin.json rather than lost
    // entirely. Reproduce the reviewer's exact scenario on a legacy
    // (pre-split) config.json that still carries the admin pair inline —
    // only the SECOND writeFileAtomic call (config.json) fails; the first
    // (admin.json) runs for real via `vi.importActual`.
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ apiKey: "hbr_legacy", adminKey: "hbradm_legacy" }),
      "utf-8",
    );
    const { writeFileAtomic: realWriteFileAtomic } =
      await vi.importActual<typeof import("../src/atomicWrite.js")>("../src/atomicWrite.js");
    vi.mocked(writeFileAtomic)
      .mockImplementationOnce(realWriteFileAtomic)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      });

    expect(() => mergeConfigFile({ apiKey: "hbr_L2" })).toThrow();

    // The credential must still be recoverable from disk — either file is
    // fine, since loadConfigFile merges them and admin.json (written first,
    // and unaffected by config.json's failed write) already has it.
    expect(loadConfigFile().adminKey).toBe("hbradm_legacy");
    const onDiskAdmin = JSON.parse(fs.readFileSync(getAdminConfigFilePath(), "utf-8"));
    expect(onDiskAdmin.adminKey).toBe("hbradm_legacy");
  });

  // security review, N1 [High] (introduced by the C17 digest fix):
  // digesting the RESOLVED `before` pair instead of config.json's actual
  // on-disk inline pair only agrees on the first attempt. On a retry after
  // an earlier failed config.json write, `before` already resolves to the
  // value THIS save is about to write again (admin.json succeeded last
  // time), so digesting it records the wrong "superseded" value — the next
  // read then treats the real stale inline leftover as a genuinely newer
  // rotation and loses the rotated key on the following save.
  it("N1: retrying a rotation whose config.json write keeps failing still keeps the rotated key", async () => {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(
      getConfigFilePath(),
      JSON.stringify({
        apiKey: "hbr_x",
        adminKey: "hbradm_superseded",
        adminServicePrivateKey: "suiprivkey1_superseded",
      }),
      "utf-8",
    );
    const { writeFileAtomic: realWriteFileAtomic } =
      await vi.importActual<typeof import("../src/atomicWrite.js")>("../src/atomicWrite.js");
    const failConfigWrite = () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    };
    // Two attempts, each admin.json write real and each config.json write
    // failing — a persistent failure (an immutable flag, an ACL, a
    // read-only file), not a one-off.
    vi.mocked(writeFileAtomic)
      .mockImplementationOnce(realWriteFileAtomic)
      .mockImplementationOnce(failConfigWrite)
      .mockImplementationOnce(realWriteFileAtomic)
      .mockImplementationOnce(failConfigWrite);
    const rotate = () =>
      mergeConfigFile({
        adminKey: "hbradm_rotated",
        adminServicePrivateKey: "suiprivkey1_rotated",
      });
    expect(rotate).toThrow();
    expect(rotate).toThrow();
    expect(loadConfigFile().adminKey).toBe("hbradm_rotated");
  });

  // security review, N2 [Low] (introduced by the C17 digest fix): the
  // `supersedes` marker used to outlive the save it protects. Right after a
  // successful rotation OLD -> NEW, admin.json kept `supersedes: H(OLD)`
  // indefinitely — so if the operator then deliberately rolled back to OLD
  // with the older, pre-split installed binary (README.md points
  // management-key setup at that installed launcher), the inline OLD still
  // matched the digest and was wrongly treated as the C12 leftover this
  // save had already resolved, rather than as the rollback it actually is,
  // and got discarded on the next save.
  it("N2: an older binary's rollback to the previous pair is honoured", () => {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    const configPath = getConfigFilePath();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        apiKey: "hbr_x",
        adminKey: "hbradm_previous",
        adminServicePrivateKey: "suiprivkey1_previous",
      }),
      "utf-8",
    );
    mergeConfigFile({ adminKey: "hbradm_rotated", adminServicePrivateKey: "suiprivkey1_rotated" });
    // The installed pre-split binary rolls back: it writes the previous pair
    // inline, the only way it knows how to write anything.
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...onDisk,
        adminKey: "hbradm_previous",
        adminServicePrivateKey: "suiprivkey1_previous",
      }),
      "utf-8",
    );
    expect(loadConfigFile().adminKey).toBe("hbradm_previous");
  });
});
