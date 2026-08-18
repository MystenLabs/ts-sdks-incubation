import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConfigure } from "../bin/configure.js";
import { loadConfigFile, saveConfigFile } from "../src/configFile.js";

/** A real, decodable signer — validateSilent now actually decodes the value. */
const VALID_SIGNER = Ed25519Keypair.generate().getSecretKey();

let tmpDir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-configure-test-"));
  originalEnv = { ...process.env };
  process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
  // Every probe succeeds unless a test overrides it.
  vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
});

afterEach(() => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runConfigure — silent mode", () => {
  it("writes the management pair and returns 0", async () => {
    const code = await runConfigure([
      "--admin-key",
      "hbradm_management_key",
      "--admin-signer",
      VALID_SIGNER,
    ]);
    expect(code).toBe(0);
    const saved = loadConfigFile();
    expect(saved.adminKey).toBe("hbradm_management_key");
    expect(saved.adminServicePrivateKey).toBe(VALID_SIGNER);
  });

  it("preserves an existing working key", async () => {
    saveConfigFile({ apiKey: "hbr_existing", servicePrivateKey: "suiprivkey1_existing" });
    await runConfigure(["--admin-key", "hbradm_management_key", "--admin-signer", VALID_SIGNER]);
    const saved = loadConfigFile();
    expect(saved.apiKey).toBe("hbr_existing");
    expect(saved.servicePrivateKey).toBe("suiprivkey1_existing");
    expect(saved.adminKey).toBe("hbradm_management_key");
  });

  it("returns 1 and writes nothing for half a management credential", async () => {
    const code = await runConfigure(["--admin-key", "hbradm_management_key"]);
    expect(code).toBe(1);
    expect(loadConfigFile()).toEqual({});
  });

  it("returns 1 and writes nothing when the key type is wrong", async () => {
    const code = await runConfigure([
      "--admin-key",
      "hbr_wrong_type",
      "--admin-signer",
      VALID_SIGNER,
    ]);
    expect(code).toBe(1);
    expect(loadConfigFile()).toEqual({});
  });

  it("returns 1 when a rejected key fails the probe", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 401 }));
    const code = await runConfigure([
      "--admin-key",
      "hbradm_management_key",
      "--admin-signer",
      VALID_SIGNER,
    ]);
    expect(code).toBe(1);
    expect(loadConfigFile()).toEqual({});
  });

  it("reads the environment under --silent", async () => {
    process.env = {
      ...process.env,
      CONSOLE_ADMIN_KEY: "hbradm_from_env",
      CONSOLE_ADMIN_SERVICE_PRIVATE_KEY: VALID_SIGNER,
    };
    const code = await runConfigure(["--silent"]);
    expect(code).toBe(0);
    expect(loadConfigFile().adminKey).toBe("hbradm_from_env");
  });

  it("returns 1 when --silent has nothing to read", async () => {
    expect(await runConfigure(["--silent"])).toBe(1);
  });

  it("persists a non-default CONSOLE_API_BASE_URL alongside the saved credentials", async () => {
    process.env = {
      ...process.env,
      CONSOLE_API_BASE_URL: "https://api.staging.console.walrus.xyz",
    };
    const code = await runConfigure([
      "--admin-key",
      "hbradm_management_key",
      "--admin-signer",
      VALID_SIGNER,
    ]);
    expect(code).toBe(0);
    expect(loadConfigFile().baseUrl).toBe("https://api.staging.console.walrus.xyz");
  });

  it("does not write a baseUrl when CONSOLE_API_BASE_URL is unset (default stays implicit)", async () => {
    const code = await runConfigure([
      "--admin-key",
      "hbradm_management_key",
      "--admin-signer",
      VALID_SIGNER,
    ]);
    expect(code).toBe(0);
    expect(loadConfigFile().baseUrl).toBeUndefined();
  });
});
