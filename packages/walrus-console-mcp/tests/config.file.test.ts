import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let originalEnv: NodeJS.ProcessEnv;

/** Write a config file into a temp XDG dir, then import src/config.ts fresh. */
async function loadConfigModuleWith(data: Record<string, string>) {
  const dir = path.join(tmpDir, "walrus-console-mcp");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(data), "utf-8");
  vi.resetModules();
  return await import("../src/config.js");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-config-file-test-"));
  originalEnv = { ...process.env };
  // Strip the real credentials so only the file can supply a value.
  const {
    CONSOLE_API_KEY: _a,
    CONSOLE_SERVICE_PRIVATE_KEY: _b,
    CONSOLE_ADMIN_KEY: _c,
    CONSOLE_ADMIN_SERVICE_PRIVATE_KEY: _d,
    ...rest
  } = process.env;
  process.env = { ...rest, XDG_CONFIG_HOME: tmpDir };
});

afterEach(() => {
  process.env = originalEnv;
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ConsoleConfig — management key from the config file", () => {
  it("resolves both halves from the saved file when no env vars are set", async () => {
    const mod = await loadConfigModuleWith({
      adminKey: "hbradm_from_file",
      adminServicePrivateKey: "suiprivkey1_from_file",
    });
    const cfg = await Effect.runPromise(mod.ConsoleConfig);

    expect(mod.getRawAdminKey(cfg)).toBe("hbradm_from_file");
    expect(mod.getRawAdminServiceKey(cfg)).toBe("suiprivkey1_from_file");
    expect(mod.hasAdminCredential(cfg)).toBe(true);
  });

  it("hasAdminCredential is false when the file has only one half", async () => {
    const mod = await loadConfigModuleWith({ adminKey: "hbradm_alone" });
    const cfg = await Effect.runPromise(mod.ConsoleConfig);

    expect(mod.getRawAdminKey(cfg)).toBe("hbradm_alone");
    expect(mod.getRawAdminServiceKey(cfg)).toBe("");
    expect(mod.hasAdminCredential(cfg)).toBe(false);
  });

  it("an env var still overrides the saved file value", async () => {
    process.env = { ...process.env, CONSOLE_ADMIN_KEY: "hbradm_from_env" };
    const mod = await loadConfigModuleWith({ adminKey: "hbradm_from_file" });
    const cfg = await Effect.runPromise(mod.ConsoleConfig);

    expect(mod.getRawAdminKey(cfg)).toBe("hbradm_from_env");
  });
});
