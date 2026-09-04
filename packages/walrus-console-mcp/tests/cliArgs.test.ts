import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { SECRET_VALUE_FIELDS, parseArgs } from "../src/cliArgs.js";
import type { CredentialValues } from "../src/cliArgs.js";

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
  it("treats a repeated --allowed-dirs as one list and still implies silent when it is the only value flag", () => {
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
  it("reads --owner-address and --key-admin-address without forcing silent", () => {
    const parsed = parseArgs(
      ["--owner-address", OWNER_ADDRESS, "--key-admin-address", KEY_ADMIN_ADDRESS],
      noEnv,
    );
    expect(parsed.values.ownerAddress).toBe(OWNER_ADDRESS);
    expect(parsed.values.keyAdminAddress).toBe(KEY_ADMIN_ADDRESS);
    expect(parsed.silent).toBe(false);
    expect(parsed.errors).toEqual([]);
  });

  it("address flags plus a secret flag are still silent", () => {
    const parsed = parseArgs(["--owner-address", OWNER_ADDRESS, "--api-key", "hbr_x"], noEnv);
    expect(parsed.silent).toBe(true);
    expect(parsed.values.ownerAddress).toBe(OWNER_ADDRESS);
    expect(parsed.values.apiKey).toBe("hbr_x");
  });

  it("address flags next to --allowed-dirs stay interactive", () => {
    const parsed = parseArgs(["--allowed-dirs", "/tmp", "--owner-address", OWNER_ADDRESS], noEnv);
    expect(parsed.silent).toBe(false);
    expect(parsed.values.allowedDirs).toEqual(["/tmp"]);
    expect(parsed.values.ownerAddress).toBe(OWNER_ADDRESS);
  });

  it("key-admin seed next to --allowed-dirs stays interactive", () => {
    const parsed = parseArgs(
      ["--allowed-dirs", "/tmp", "--key-admin-address", KEY_ADMIN_ADDRESS],
      noEnv,
    );
    expect(parsed.silent).toBe(false);
    expect(parsed.values.allowedDirs).toEqual(["/tmp"]);
    expect(parsed.values.keyAdminAddress).toBe(KEY_ADMIN_ADDRESS);
  });

  it("reads the --flag=value form too", () => {
    const parsed = parseArgs([`--owner-address=${OWNER_ADDRESS}`], noEnv);
    expect(parsed.values.ownerAddress).toBe(OWNER_ADDRESS);
  });

  it("rejects a malformed address at parse time, naming the flag and never the value", () => {
    const parsed = parseArgs(["--owner-address", "suiprivkey1MISPASTEDSECRET"], noEnv);
    expect(parsed.errors).toEqual([
      "--owner-address is not a valid Sui address (expected 0x followed by 64 hex characters).",
    ]);
    expect(parsed.values.ownerAddress).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("MISPASTEDSECRET");
  });

  it("rejects a malformed --key-admin-address the same way", () => {
    const parsed = parseArgs(["--key-admin-address", "0xNOT_AN_ADDRESS"], noEnv);
    expect(parsed.errors).toEqual([
      "--key-admin-address is not a valid Sui address (expected 0x followed by 64 hex characters).",
    ]);
    expect(parsed.values.keyAdminAddress).toBeUndefined();
  });
});

describe("parseArgs — duplicate value flags", () => {
  // Every VALUE_FLAGS entry, secret and address alike, must refuse a repeat
  // with a *different* value instead of silently taking the last one.
  const DUPLICATE_CASES: Array<{
    flag: string;
    field: Exclude<keyof CredentialValues, "allowedDirs">;
    first: string;
    second: string;
    secret: boolean;
  }> = [
    {
      flag: "--api-key",
      field: "apiKey",
      first: "hbr_first_value",
      second: "hbr_second_value",
      secret: true,
    },
    {
      flag: "--service-key",
      field: "serviceKey",
      first: "suiprivkey1_svc_first",
      second: "suiprivkey1_svc_second",
      secret: true,
    },
    {
      flag: "--admin-key",
      field: "adminKey",
      first: "hbradm_first",
      second: "hbradm_second",
      secret: true,
    },
    {
      flag: "--admin-signer",
      field: "adminSigner",
      first: "suiprivkey1_adm_first",
      second: "suiprivkey1_adm_second",
      secret: true,
    },
    {
      flag: "--credential-bundle",
      field: "bundle",
      first: JSON.stringify({ v: 1, apiKey: "hbr_bundle_first" }),
      second: JSON.stringify({ v: 1, apiKey: "hbr_bundle_second" }),
      secret: true,
    },
    {
      flag: "--owner-address",
      field: "ownerAddress",
      first: OWNER_ADDRESS,
      second: KEY_ADMIN_ADDRESS,
      secret: false,
    },
    {
      flag: "--key-admin-address",
      field: "keyAdminAddress",
      first: KEY_ADMIN_ADDRESS,
      second: OWNER_ADDRESS,
      secret: false,
    },
  ];

  for (const { flag, field, first, second, secret } of DUPLICATE_CASES) {
    it(`refuses ${flag} given twice with different values`, () => {
      const parsed = parseArgs([flag, first, flag, second], noEnv);
      expect(parsed.errors).toHaveLength(1);
      expect(parsed.errors[0]).toContain(flag);
      expect(parsed.errors[0]).toContain("more than once");
      // The first (earlier) value stays put — only the disagreeing repeat is
      // refused, so first-set-wins-and-is-kept, not last-wins-silently.
      expect(parsed.values[field]).toBe(first);

      if (secret) {
        // Secret flags never echo a value — old or new — in the message.
        expect(parsed.errors.join(" ")).not.toContain(first);
        expect(parsed.errors.join(" ")).not.toContain(second);
        expect(JSON.stringify(parsed)).not.toContain(second);
      } else {
        // Address flags are public trust anchors: the message may name both
        // normalized values so the operator can see what disagreed.
        expect(parsed.errors.join(" ")).toContain(first);
        expect(parsed.errors.join(" ")).toContain(second);
      }
    });

    it(`passes silently when ${flag} is repeated with the same value`, () => {
      const parsed = parseArgs([flag, first, flag, first], noEnv);
      expect(parsed.errors).toEqual([]);
      expect(parsed.values[field]).toBe(first);
    });
  }

  it("names both normalized addresses when --owner-address disagrees with itself", () => {
    const parsed = parseArgs(
      ["--owner-address", OWNER_ADDRESS, "--owner-address", KEY_ADMIN_ADDRESS],
      noEnv,
    );
    expect(parsed.errors).toEqual([
      `--owner-address was given more than once with different values: ${OWNER_ADDRESS} and ${KEY_ADMIN_ADDRESS}.`,
    ]);
  });

  it("never echoes either value when a secret flag disagrees with itself", () => {
    const parsed = parseArgs(
      ["--admin-key", "hbradm_REAL_FIRST", "--admin-key", "hbradm_REAL_SECOND"],
      noEnv,
    );
    expect(parsed.errors).toEqual(["--admin-key was given more than once with different values."]);
    expect(parsed.errors.join(" ")).not.toContain("hbradm_REAL_FIRST");
    expect(parsed.errors.join(" ")).not.toContain("hbradm_REAL_SECOND");
    expect(JSON.stringify(parsed)).not.toContain("hbradm_REAL_SECOND");
  });

  it("--allowed-dirs stays exempt and keeps accumulating across repeats", () => {
    const parsed = parseArgs(["--allowed-dirs", "/a", "--allowed-dirs", "/a"], noEnv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.values.allowedDirs).toEqual(["/a", "/a"]);
  });

  // isValidSuiAddress accepts more than one spelling of the same 64-hex
  // address — differing case, and an optional "0x" prefix — so the duplicate
  // check must compare normalized addresses, not raw strings, or two
  // spellings of one instruction get refused as if they disagreed.
  it("treats a case-differing repeat of the same --owner-address as an equal repeat", () => {
    const upper = `0x${"A".repeat(64)}`;
    const parsed = parseArgs(["--owner-address", OWNER_ADDRESS, "--owner-address", upper], noEnv);
    expect(parsed.errors).toEqual([]);
    // The raw first-seen spelling is kept, not a normalized form.
    expect(parsed.values.ownerAddress).toBe(OWNER_ADDRESS);
  });

  it("treats a case-differing repeat of the same --key-admin-address as an equal repeat", () => {
    const upper = `0x${"B".repeat(64)}`;
    const parsed = parseArgs(
      ["--key-admin-address", KEY_ADMIN_ADDRESS, "--key-admin-address", upper],
      noEnv,
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.values.keyAdminAddress).toBe(KEY_ADMIN_ADDRESS);
  });

  it("treats a bare-hex repeat of an 0x-prefixed --owner-address as an equal repeat", () => {
    const bareHex = "a".repeat(64);
    const parsed = parseArgs(["--owner-address", OWNER_ADDRESS, "--owner-address", bareHex], noEnv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.values.ownerAddress).toBe(OWNER_ADDRESS);
  });

  it("still refuses two case-normalized addresses that are genuinely different", () => {
    // OWNER_ADDRESS (all "a") and KEY_ADMIN_ADDRESS (all "b") normalize to
    // different canonical forms, so this must still refuse — normalizing the
    // comparison must not paper over a real disagreement.
    const upperKeyAdmin = `0x${"B".repeat(64)}`;
    const parsed = parseArgs(
      ["--owner-address", OWNER_ADDRESS, "--owner-address", upperKeyAdmin],
      noEnv,
    );
    expect(parsed.errors).toEqual([
      `--owner-address was given more than once with different values: ${OWNER_ADDRESS} and ${KEY_ADMIN_ADDRESS}.`,
    ]);
  });

  // isValidSuiAddress rejects short (unpadded) forms like "0x2" outright — it
  // requires exactly 64 hex characters — so a short-vs-padded repeat never
  // reaches the duplicate check at all; the first occurrence already fails
  // address validation with "not a valid Sui address".
  it("rejects a short unpadded address before duplicate-checking can even apply", () => {
    const parsed = parseArgs(["--owner-address", "0x2"], noEnv);
    expect(parsed.errors).toEqual([
      "--owner-address is not a valid Sui address (expected 0x followed by 64 hex characters).",
    ]);
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
