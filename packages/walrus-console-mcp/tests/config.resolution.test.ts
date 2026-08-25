import { ConfigProvider, Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONSOLE_API_BASE_URL } from "../src/baseUrl";
import {
  type ConsoleConfig,
  getKeyAdminAddress,
  getWebAccountAddress,
  resolvedBaseUrl,
  resolvedOptionalAddress,
  resolvedString,
} from "../src/config";

// Drive resolvedString through a custom ConfigProvider so we control the "env" without
// touching process.env. Mirrors process.env semantics: a missing map key = unset var,
// an "" value = an exported-but-empty var.
const run = (env: Record<string, string>, fileValue: string | undefined, fallback = "") =>
  Effect.runPromise(
    resolvedString("CONSOLE_API_KEY", fileValue, fallback).pipe(
      Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env)))),
    ),
  );

describe("resolvedString — env → file → fallback priority", () => {
  it("a non-empty env var wins over a saved file value", async () => {
    expect(await run({ CONSOLE_API_KEY: "hbr_env" }, "hbr_file")).toBe("hbr_env");
  });

  it("an empty env var falls through to the saved file value (review #3: no shadowing)", async () => {
    expect(await run({ CONSOLE_API_KEY: "" }, "hbr_file")).toBe("hbr_file");
  });

  it("a whitespace-only env var falls through to the saved file value", async () => {
    expect(await run({ CONSOLE_API_KEY: "   " }, "hbr_file")).toBe("hbr_file");
  });

  it("an unset env var uses the saved file value", async () => {
    expect(await run({}, "hbr_file")).toBe("hbr_file");
  });

  it("missing everywhere resolves to the fallback without throwing (review #4)", async () => {
    expect(await run({}, undefined, "")).toBe("");
    expect(await run({ CONSOLE_API_KEY: "" }, undefined, "https://fallback")).toBe(
      "https://fallback",
    );
  });

  it("trims surrounding whitespace on the resolved value", async () => {
    expect(await run({ CONSOLE_API_KEY: "  hbr_env  " }, undefined)).toBe("hbr_env");
  });
});

describe("resolvedString — management key resolution", () => {
  const runAdmin = (env: Record<string, string>, fileValue: string | undefined) =>
    Effect.runPromise(
      resolvedString("CONSOLE_ADMIN_KEY", fileValue, "").pipe(
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env)))),
      ),
    );

  it("uses the saved file value when the env var is unset", async () => {
    expect(await runAdmin({}, "hbradm_file")).toBe("hbradm_file");
  });

  it("an exported-but-empty CONSOLE_ADMIN_KEY does not shadow the file value", async () => {
    expect(await runAdmin({ CONSOLE_ADMIN_KEY: "" }, "hbradm_file")).toBe("hbradm_file");
  });

  it("a set env var still wins over the file", async () => {
    expect(await runAdmin({ CONSOLE_ADMIN_KEY: "hbradm_env" }, "hbradm_file")).toBe("hbradm_env");
  });

  it("absent everywhere resolves to the empty string", async () => {
    expect(await runAdmin({}, undefined)).toBe("");
  });
});

describe("resolvedBaseUrl — allowlist enforcement", () => {
  const runBaseUrl = (env: Record<string, string>, fileValue: string | undefined) =>
    Effect.runPromise(
      resolvedBaseUrl(fileValue).pipe(
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env)))),
      ),
    );

  it("uses the default when nothing is set", async () => {
    expect(await runBaseUrl({}, undefined)).toBe(DEFAULT_CONSOLE_API_BASE_URL);
  });

  it("accepts an allowed env override", async () => {
    expect(await runBaseUrl({ CONSOLE_API_BASE_URL: "http://localhost:3000" }, undefined)).toBe(
      "http://localhost:3000",
    );
  });

  it("fails config construction for a disallowed env override", async () => {
    await expect(
      runBaseUrl({ CONSOLE_API_BASE_URL: "https://evil.com" }, undefined),
    ).rejects.toThrow(/CONSOLE_API_BASE_URL/);
  });

  it("fails config construction for a disallowed file value", async () => {
    await expect(runBaseUrl({}, "https://evil.com")).rejects.toThrow(/CONSOLE_API_BASE_URL/);
  });
});

describe("resolvedOptionalAddress — Sui address pins (webAccountAddress/keyAdminAddress)", () => {
  const WEB_ACCOUNT_ENV = `0x${"1".repeat(64)}`;
  const WEB_ACCOUNT_FILE = `0x${"2".repeat(64)}`;

  const run = (env: Record<string, string>, fileValue: string | undefined) =>
    Effect.runPromise(
      resolvedOptionalAddress("CONSOLE_WEB_ACCOUNT_ADDRESS", fileValue).pipe(
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env)))),
      ),
    );

  it("a valid env address wins over a saved file value", async () => {
    expect(await run({ CONSOLE_WEB_ACCOUNT_ADDRESS: WEB_ACCOUNT_ENV }, WEB_ACCOUNT_FILE)).toBe(
      WEB_ACCOUNT_ENV,
    );
  });

  it("falls back to the file value when the env var is unset", async () => {
    expect(await run({}, WEB_ACCOUNT_FILE)).toBe(WEB_ACCOUNT_FILE);
  });

  it("resolves to the empty string (absent) when neither source has a value", async () => {
    expect(await run({}, undefined)).toBe("");
  });

  it("fails config construction for a malformed env address (a typo is not absence)", async () => {
    await expect(run({ CONSOLE_WEB_ACCOUNT_ADDRESS: "not-an-address" }, undefined)).rejects.toThrow(
      /CONSOLE_WEB_ACCOUNT_ADDRESS/,
    );
  });
});

describe("getWebAccountAddress / getKeyAdminAddress", () => {
  const baseCfg = {
    apiKey: Redacted.make(""),
    servicePrivateKey: Redacted.make(""),
    adminKey: Redacted.make(""),
    adminServicePrivateKey: Redacted.make(""),
    baseUrl: DEFAULT_CONSOLE_API_BASE_URL,
    webAccountAddress: "",
    keyAdminAddress: "",
  } satisfies ConsoleConfig;

  it('returns undefined when the pin resolved to "" (absent)', () => {
    expect(getWebAccountAddress(baseCfg)).toBeUndefined();
    expect(getKeyAdminAddress(baseCfg)).toBeUndefined();
  });

  it("returns the address when the pin is present", () => {
    const addr = `0x${"3".repeat(64)}`;
    expect(getWebAccountAddress({ ...baseCfg, webAccountAddress: addr })).toBe(addr);
    expect(getKeyAdminAddress({ ...baseCfg, keyAdminAddress: addr })).toBe(addr);
  });
});
