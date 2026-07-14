import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ConfigFileData,
  getConfigDir,
  loadConfigFile,
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
});

describe("saveConfigFile", () => {
  it("creates directory and file with config data", () => {
    const data: ConfigFileData = {
      apiKey: "hbr_test123",
      servicePrivateKey: "suiprivkey1_abc",
      baseUrl: "https://api.testnet.harbor.walrus.xyz",
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
    expect(parsed.baseUrl).toBe("https://api.testnet.harbor.walrus.xyz");
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
