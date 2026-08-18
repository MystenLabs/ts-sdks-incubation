import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cliArgs.js";

const noEnv = {} as NodeJS.ProcessEnv;

describe("parseArgs", () => {
  it("defaults to interactive with registration on", () => {
    const parsed = parseArgs([], noEnv);
    expect(parsed.silent).toBe(false);
    expect(parsed.register).toBe(true);
    expect(parsed.values).toEqual({});
    expect(parsed.errors).toEqual([]);
  });

  it("reads value flags in --flag value form", () => {
    const parsed = parseArgs(["--admin-key", "hbradm_x", "--admin-signer", "suiprivkey1_y"], noEnv);
    expect(parsed.values.adminKey).toBe("hbradm_x");
    expect(parsed.values.adminSigner).toBe("suiprivkey1_y");
    expect(parsed.silent).toBe(true);
  });

  it("reads value flags in --flag=value form", () => {
    const parsed = parseArgs(["--api-key=hbr_x", "--service-key=suiprivkey1_y"], noEnv);
    expect(parsed.values.apiKey).toBe("hbr_x");
    expect(parsed.values.serviceKey).toBe("suiprivkey1_y");
    expect(parsed.silent).toBe(true);
  });

  it("--no-register turns registration off without implying silent", () => {
    const parsed = parseArgs(["--no-register"], noEnv);
    expect(parsed.register).toBe(false);
    expect(parsed.silent).toBe(false);
  });

  it("--silent alone reads the CONSOLE_* environment", () => {
    const parsed = parseArgs(["--silent"], {
      CONSOLE_API_KEY: "hbr_env",
      CONSOLE_SERVICE_PRIVATE_KEY: "suiprivkey1_env",
      CONSOLE_ADMIN_KEY: "hbradm_env",
      CONSOLE_ADMIN_SERVICE_PRIVATE_KEY: "suiprivkey1_adminenv",
    } as NodeJS.ProcessEnv);

    expect(parsed.silent).toBe(true);
    expect(parsed.values).toEqual({
      apiKey: "hbr_env",
      serviceKey: "suiprivkey1_env",
      adminKey: "hbradm_env",
      adminSigner: "suiprivkey1_adminenv",
    });
  });

  it("explicit flags win over the environment under --silent", () => {
    const parsed = parseArgs(["--silent", "--admin-key", "hbradm_flag"], {
      CONSOLE_ADMIN_KEY: "hbradm_env",
    } as NodeJS.ProcessEnv);
    expect(parsed.values.adminKey).toBe("hbradm_flag");
  });

  it("ignores empty and whitespace-only environment values", () => {
    const parsed = parseArgs(["--silent"], {
      CONSOLE_API_KEY: "   ",
      CONSOLE_ADMIN_KEY: "",
    } as NodeJS.ProcessEnv);
    expect(parsed.values).toEqual({});
  });

  it("records an error for an unknown flag", () => {
    const parsed = parseArgs(["--nope"], noEnv);
    expect(parsed.errors).toEqual(["Unknown flag: --nope"]);
  });

  it("names a mistyped flag but never echoes a bare secret token that follows it", () => {
    const parsed = parseArgs(["--admin-secret", "suiprivkey1REALSECRETVALUE"], noEnv);
    expect(parsed.errors.join(" ")).toContain("--admin-secret");
    expect(parsed.errors.join(" ")).not.toContain("suiprivkey1REALSECRETVALUE");
  });

  it("never echoes a bare secret token passed with no flag at all", () => {
    const parsed = parseArgs(["hbradm_BARE_SECRET_TOKEN"], noEnv);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors.join(" ")).not.toContain("hbradm_BARE_SECRET_TOKEN");
  });

  it("records an error for a value flag with no value", () => {
    const parsed = parseArgs(["--admin-key"], noEnv);
    expect(parsed.errors).toEqual(["--admin-key needs a value"]);
  });

  it("does not swallow a following flag as a value, and never leaks a real value into an error", () => {
    const parsed = parseArgs(["--admin-signer", "--admin-key", "hbradm_REALSECRET"], noEnv);
    expect(parsed.errors).toContain("--admin-signer needs a value");
    expect(parsed.values.adminKey).toBe("hbradm_REALSECRET");
    expect(parsed.errors.join(" ")).not.toContain("hbradm_REALSECRET");
  });

  it("a missing value before --silent still lets --silent take effect", () => {
    const parsed = parseArgs(["--admin-key", "--silent"], noEnv);
    expect(parsed.errors).toContain("--admin-key needs a value");
    expect(parsed.silent).toBe(true);
  });

  it("a --flag=value with = in the value keeps the full value", () => {
    const parsed = parseArgs(["--admin-signer=suiprivkey1_a=b=c"], noEnv);
    expect(parsed.values.adminSigner).toBe("suiprivkey1_a=b=c");
  });
});
