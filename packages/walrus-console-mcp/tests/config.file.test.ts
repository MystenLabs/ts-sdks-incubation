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

describe("ConsoleConfig — read when evaluated, not when the module loads", () => {
  it("sees a config.json written after the module was imported", async () => {
    // The server imports this module statically, so it has loaded before
    // `--import-bundle` writes the file. A module-load read would leave that
    // first start with no credentials.
    vi.resetModules();
    const mod = await import("../src/config.js");
    const dir = path.join(tmpDir, "walrus-console-mcp");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ apiKey: "hbr_written_later" }),
    );

    const cfg = await Effect.runPromise(mod.ConsoleConfig);
    expect(mod.getRawApiKey(cfg)).toBe("hbr_written_later");
  });

  it("registers a key saved after boot for redaction before it can be used", async () => {
    // Boot registers whatever config.json held then. A key switched before the
    // first evaluation must be redacted too, or it reaches a log line in clear.
    vi.resetModules();
    const redaction = await import("../src/redaction.js");
    const mod = await import("../src/config.js");
    const dir = path.join(tmpDir, "walrus-console-mcp");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ apiKey: "hbr_bootTimeKey01" }),
    );
    redaction.registerConfigFileSecrets({ apiKey: "hbr_bootTimeKey01" });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ apiKey: "hbr_switchedLaterKey" }),
    );

    await Effect.runPromise(mod.ConsoleConfig);
    expect(redaction.redactString("Bearer hbr_switchedLaterKey")).toBe(
      `Bearer ${redaction.REDACTION_PLACEHOLDER}`,
    );
    redaction.clearSecrets();
  });
});

describe("ConsoleConfig — corrupt config file at startup (review #5)", () => {
  it("does not crash module load; falls back to env credentials", async () => {
    // config.ts reads the file at module-load time. A corrupt file must not take
    // down a server that is correctly configured through the environment — the
    // read is caught loudly and falls back to env creds.
    //
    //: config.ts now delegates to
    // loadConfigFileOrEmpty, which warns via console.error rather than a raw
    // process.stderr.write — spy on that instead.
    const dir = path.join(tmpDir, "walrus-console-mcp");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json", "utf-8");
    process.env = { ...process.env, CONSOLE_API_KEY: "hbr_env_only" };

    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
    const mod = await import("../src/config.js"); // must not throw at import
    const cfg = await Effect.runPromise(mod.ConsoleConfig);

    expect(mod.getRawApiKey(cfg)).toBe("hbr_env_only");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // security review, C10: config.ts used to wrap loadConfigFile in its own
  // bare try/catch, so a corrupt admin.json — which loadConfigFile now also
  // throws on — discarded a perfectly healthy config.json working key at
  // server startup. Reproduces the exact regression: a healthy config.json
  // (a working key, no env override) alongside a truncated admin.json.
  it("keeps a healthy config.json working key when only admin.json is corrupt", async () => {
    const dir = path.join(tmpDir, "walrus-console-mcp");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ apiKey: "hbr_healthy" }),
      "utf-8",
    );
    fs.writeFileSync(path.join(dir, "admin.json"), '{ "adminKey": "hbradm_TRUNC', "utf-8");

    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
    const mod = await import("../src/config.js");
    const cfg = await Effect.runPromise(mod.ConsoleConfig);

    expect(mod.getRawApiKey(cfg)).toBe("hbr_healthy");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("ConsoleConfig — mismatched credential source (review #6)", () => {
  it("suppresses a file signer when the working bearer comes from env", async () => {
    // An env-supplied bearer paired with a file-supplied signer is almost
    // certainly a mismatched pair (the env key is not the one the file was saved
    // for). Suppress the file signer to "" and warn, rather than sign with it.
    process.env = { ...process.env, CONSOLE_API_KEY: "hbr_env_bearer" };
    const mod = await loadConfigModuleWith({
      apiKey: "hbr_file_bearer",
      servicePrivateKey: "suiprivkey1_file_signer",
    });

    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const cfg = await Effect.runPromise(mod.ConsoleConfig);

    expect(mod.getRawApiKey(cfg)).toBe("hbr_env_bearer");
    expect(mod.getRawServiceKey(cfg)).toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("CONSOLE_SERVICE_PRIVATE_KEY"));
    warn.mockRestore();
  });

  it("suppresses a file admin signer when the admin bearer comes from env", async () => {
    process.env = { ...process.env, CONSOLE_ADMIN_KEY: "hbradm_env_bearer" };
    const mod = await loadConfigModuleWith({
      adminKey: "hbradm_file_bearer",
      adminServicePrivateKey: "suiprivkey1_file_admin_signer",
    });

    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const cfg = await Effect.runPromise(mod.ConsoleConfig);

    expect(mod.getRawAdminKey(cfg)).toBe("hbradm_env_bearer");
    expect(mod.getRawAdminServiceKey(cfg)).toBe("");
    expect(mod.hasAdminCredential(cfg)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("CONSOLE_ADMIN_SERVICE_PRIVATE_KEY"));
    warn.mockRestore();
  });

  it("keeps a file signer when its bearer also comes from the file", async () => {
    // No env bearer → no mismatch → the saved pair resolves intact.
    const mod = await loadConfigModuleWith({
      apiKey: "hbr_file_bearer",
      servicePrivateKey: "suiprivkey1_file_signer",
    });
    const cfg = await Effect.runPromise(mod.ConsoleConfig);

    expect(mod.getRawApiKey(cfg)).toBe("hbr_file_bearer");
    expect(mod.getRawServiceKey(cfg)).toBe("suiprivkey1_file_signer");
  });

  it("suppresses a file BEARER when only the signer comes from env (bug_003 mirror)", async () => {
    // The mirror of the first case: a saved bearer paired with an env-only signer
    // is equally a mismatch. Drop the file bearer to "" and warn, rather than
    // pairing it with an unrelated env signer.
    process.env = { ...process.env, CONSOLE_SERVICE_PRIVATE_KEY: "suiprivkey1_env_signer" };
    const mod = await loadConfigModuleWith({
      apiKey: "hbr_file_bearer",
      servicePrivateKey: "suiprivkey1_file_signer",
    });

    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const cfg = await Effect.runPromise(mod.ConsoleConfig);

    expect(mod.getRawServiceKey(cfg)).toBe("suiprivkey1_env_signer");
    expect(mod.getRawApiKey(cfg)).toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("CONSOLE_API_KEY"));
    warn.mockRestore();
  });
});
