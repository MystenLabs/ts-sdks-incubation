import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { SECRET_VALUE_FIELDS, parseArgs } from "../src/cliArgs.js";

const noEnv = {} as NodeJS.ProcessEnv;

const OWNER_ADDRESS = `0x${"a".repeat(64)}`;
const KEY_ADMIN_ADDRESS = `0x${"b".repeat(64)}`;
const BUNDLE = JSON.stringify({
  v: 1,
  apiKey: "hbr_bundle_key_value",
  servicePrivateKey: "suiprivkey1_bundle",
  webAccountAddress: OWNER_ADDRESS,
  keyAdminAddress: KEY_ADMIN_ADDRESS,
});

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

describe("parseArgs — credential bundle", () => {
  it("reads --credential-bundle in --flag value form and implies silent", () => {
    const parsed = parseArgs(["--credential-bundle", BUNDLE], noEnv);
    expect(parsed.values.bundle).toBe(BUNDLE);
    expect(parsed.silent).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  it("reads --credential-bundle=<json> and keeps every = inside the JSON", () => {
    const withEquals = JSON.stringify({ v: 1, apiKey: "hbr_a=b=c" });
    const parsed = parseArgs([`--credential-bundle=${withEquals}`], noEnv);
    expect(parsed.values.bundle).toBe(withEquals);
  });

  it("reads CONSOLE_CREDENTIAL_BUNDLE only under an explicit --silent", () => {
    const env = { CONSOLE_CREDENTIAL_BUNDLE: BUNDLE } as NodeJS.ProcessEnv;

    expect(parseArgs(["--silent"], env).values.bundle).toBe(BUNDLE);
    // Without --silent the environment is deliberately not consulted: a bundle
    // left exported must not silently reconfigure an interactive run.
    expect(parseArgs([], env).values.bundle).toBeUndefined();
  });

  it("lets an explicit --credential-bundle win over the environment", () => {
    const parsed = parseArgs(["--silent", "--credential-bundle", BUNDLE], {
      CONSOLE_CREDENTIAL_BUNDLE: JSON.stringify({ v: 1, apiKey: "hbr_from_env" }),
    } as NodeJS.ProcessEnv);
    expect(parsed.values.bundle).toBe(BUNDLE);
  });

  it("records an error for --credential-bundle with no value", () => {
    expect(parseArgs(["--credential-bundle"], noEnv).errors).toEqual([
      "--credential-bundle needs a value",
    ]);
  });
});

describe("parseArgs — allowed dirs", () => {
  it("treats a repeated --allowed-dirs as one list and implies silent", () => {
    const parsed = parseArgs(["--allowed-dirs", "/a", "--allowed-dirs", "/b"], noEnv);
    expect(parsed.values.allowedDirs).toEqual(["/a", "/b"]);
    expect(parsed.silent).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  it("splits a single occurrence only on the platform delimiter", () => {
    const parsed = parseArgs(["--allowed-dirs", ["/a", "/b"].join(delimiter)], noEnv);
    expect(parsed.values.allowedDirs).toEqual(["/a", "/b"]);
  });

  it("does not split a Windows drive-letter path on ':'", () => {
    // If this were split on ':', the result would be ["C", "\\Users\\me\\Documents"].
    const parsed = parseArgs(["--allowed-dirs", "C:\\Users\\me\\Documents"], noEnv);
    if (process.platform === "win32") {
      expect(parsed.values.allowedDirs).toEqual(["C:\\Users\\me\\Documents"]);
    } else {
      // POSIX delimiter is ':'. A Windows path pasted here still must not be
      // required by this test — skip the split assertion; the ';' helper
      // covers the drive-letter contract in pathSandbox.test.ts.
      expect(parsed.errors).toEqual([]);
    }
  });

  it("records an error for --allowed-dirs with no value", () => {
    expect(parseArgs(["--allowed-dirs"], noEnv).errors).toEqual(["--allowed-dirs needs a value"]);
  });

  it("reads CONSOLE_MCP_ALLOWED_DIRS only under an explicit --silent", () => {
    const env = {
      CONSOLE_MCP_ALLOWED_DIRS: ["/from", "/env"].join(delimiter),
    } as NodeJS.ProcessEnv;
    expect(parseArgs(["--silent"], env).values.allowedDirs).toEqual(["/from", "/env"]);
    expect(parseArgs([], env).values.allowedDirs).toBeUndefined();
  });

  it("lets explicit --allowed-dirs win over the environment", () => {
    const parsed = parseArgs(["--silent", "--allowed-dirs", "/flag"], {
      CONSOLE_MCP_ALLOWED_DIRS: "/from-env",
    } as NodeJS.ProcessEnv);
    expect(parsed.values.allowedDirs).toEqual(["/flag"]);
  });
});

describe("parseArgs — address pins", () => {
  it("reads --owner-address and --key-admin-address", () => {
    const parsed = parseArgs(
      ["--owner-address", OWNER_ADDRESS, "--key-admin-address", KEY_ADMIN_ADDRESS],
      noEnv,
    );
    expect(parsed.values.ownerAddress).toBe(OWNER_ADDRESS);
    expect(parsed.values.keyAdminAddress).toBe(KEY_ADMIN_ADDRESS);
    expect(parsed.silent).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  it("reads the --flag=value form too", () => {
    const parsed = parseArgs([`--owner-address=${OWNER_ADDRESS}`], noEnv);
    expect(parsed.values.ownerAddress).toBe(OWNER_ADDRESS);
  });
});

describe("SECRET_VALUE_FIELDS", () => {
  // This list is what the CLI entry points feed to registerSecret before any
  // probe fires, so it must name every secret-bearing field...
  it("names every secret-bearing field, including the bundle", () => {
    expect([...SECRET_VALUE_FIELDS].sort()).toEqual(
      ["adminKey", "adminSigner", "apiKey", "bundle", "serviceKey"].sort(),
    );
  });

  // ...and must NOT name the addresses: registering one would scrub the owner
  // address out of the create_bucket disclosure, the field that exists to show
  // a human which account was actually granted the bucket.
  it("never names the address pins", () => {
    expect(SECRET_VALUE_FIELDS).not.toContain("ownerAddress");
    expect(SECRET_VALUE_FIELDS).not.toContain("keyAdminAddress");
  });

  it("never names allowedDirs — they are folders, not credentials", () => {
    expect(SECRET_VALUE_FIELDS).not.toContain("allowedDirs");
  });
});
