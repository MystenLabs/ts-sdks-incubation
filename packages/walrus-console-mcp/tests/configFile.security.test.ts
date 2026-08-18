import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getConfigFilePath,
  loadConfigFile,
  mergeConfigFile,
  saveConfigFile,
} from "../src/configFile";
import {
  clearSecrets,
  REDACTION_PLACEHOLDER,
  redactString,
  registerSecret,
} from "../src/redaction";

// Isolate all filesystem writes to a throwaway XDG dir so we never touch the real
// ~/.config/walrus-console-mcp/config.json. A narrowed view of process.env lets us use
// dot access (satisfies both tsc's noPropertyAccessFromIndexSignature and biome's useLiteralKeys).
const env = process.env as { XDG_CONFIG_HOME?: string };
let tmpHome: string;
let prevXdg: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "wcm-cfg-"));
  prevXdg = env.XDG_CONFIG_HOME;
  env.XDG_CONFIG_HOME = tmpHome;
});

afterEach(() => {
  if (prevXdg === undefined) delete env.XDG_CONFIG_HOME;
  else env.XDG_CONFIG_HOME = prevXdg;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  clearSecrets();
});

describe("saveConfigFile — file permissions (review #1)", () => {
  it("tightens a pre-existing world-readable config back to 0600 on overwrite", () => {
    const filePath = getConfigFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{}\n");
    fs.chmodSync(filePath, 0o644); // simulate a loose config left by a prior run
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o644);

    saveConfigFile({ apiKey: "hbr_test", servicePrivateKey: "suiprivkey1x" });

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("creates a brand-new config file as 0600", () => {
    saveConfigFile({ apiKey: "hbr_new_key" });
    expect(fs.statSync(getConfigFilePath()).mode & 0o777).toBe(0o600);
  });

  it("keeps 0600 when merging admin fields into a pre-existing loose-permission file", () => {
    saveConfigFile({ apiKey: "hbr_x" });
    const filePath = getConfigFilePath();
    fs.chmodSync(filePath, 0o644);

    mergeConfigFile({ adminKey: "hbradm_y", adminServicePrivateKey: "suiprivkey1_z" });

    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("leaves no temp file behind after an atomic save", () => {
    saveConfigFile({ apiKey: "hbr_new_key" });
    const dir = path.dirname(getConfigFilePath());
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("round-trips content through the atomic overwrite path", () => {
    saveConfigFile({ apiKey: "hbr_old" });
    saveConfigFile({ apiKey: "hbr_new", servicePrivateKey: "suiprivkey1new" });
    const loaded = loadConfigFile();
    expect(loaded.apiKey).toBe("hbr_new");
    expect(loaded.servicePrivateKey).toBe("suiprivkey1new");
    expect(fs.statSync(getConfigFilePath()).mode & 0o777).toBe(0o600);
  });
});

describe("config-file credentials are redactable (review #2)", () => {
  it("a key loaded from the config file can be scrubbed from output once registered", () => {
    saveConfigFile({
      apiKey: "hbr_secretsauce_longenough",
      servicePrivateKey: "suiprivkey1verysecretvalue",
    });
    const loaded = loadConfigFile();
    registerSecret(loaded.apiKey);
    registerSecret(loaded.servicePrivateKey);

    const out = redactString(
      `request failed with key ${loaded.apiKey} and signer ${loaded.servicePrivateKey}`,
    );

    expect(out).not.toContain("hbr_secretsauce_longenough");
    expect(out).not.toContain("suiprivkey1verysecretvalue");
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });
});
