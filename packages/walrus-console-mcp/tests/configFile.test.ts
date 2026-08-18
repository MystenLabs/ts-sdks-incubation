import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ConfigFileData,
  getConfigDir,
  getConfigFilePath,
  loadConfigFile,
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

  it("returns empty object when file contains invalid JSON", () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "not json", "utf-8");
    const result = loadConfigFile();
    expect(result).toEqual({});
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
    expect(parsed.apiKey).toBe("hbr_test123");
    expect(parsed.servicePrivateKey).toBe("suiprivkey1_abc");
    expect(parsed.baseUrl).toBe("https://api.testnet.console.walrus.xyz");
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
