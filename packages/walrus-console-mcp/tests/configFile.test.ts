import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ConfigFileData,
  getConfigDir,
  getConfigFilePath,
  loadConfigFile,
  loadConfigFileOrEmpty,
  mergeConfigFile,
  saveConfigFile,
} from "../src/configFile.js";

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
