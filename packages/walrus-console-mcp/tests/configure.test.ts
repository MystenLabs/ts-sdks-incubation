import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConfigure } from "../bin/configure.js";
import { parseArgs } from "../src/cliArgs.js";
import { loadConfigFile, saveConfigFile } from "../src/configFile.js";
import { toRealPath } from "../src/pathSandbox.js";

/** A real, decodable signer — validateSilent now actually decodes the value. */
const VALID_SIGNER = Ed25519Keypair.generate().getSecretKey();

const OWNER_ADDRESS = `0x${"a".repeat(64)}`;
const KEY_ADMIN_ADDRESS = `0x${"b".repeat(64)}`;
const STALE_ADDRESS = `0x${"9".repeat(64)}`;
const BUNDLE_API_KEY = "hbr_bundle_key_value";

const bundleJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    v: 1,
    apiKey: BUNDLE_API_KEY,
    servicePrivateKey: VALID_SIGNER,
    webAccountAddress: OWNER_ADDRESS,
    keyAdminAddress: KEY_ADMIN_ADDRESS,
    ...overrides,
  });

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

  it("persists --allowed-dirs without credentials and leaves existing keys", async () => {
    saveConfigFile({ apiKey: "hbr_existing" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-cfg-dirs-"));
    try {
      const code = await runConfigure(["--allowed-dirs", dir]);
      expect(code).toBe(0);
      const saved = loadConfigFile();
      expect(saved.apiKey).toBe("hbr_existing");
      expect(saved.allowedDirs).toEqual([toRealPath(dir)]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 1 for a missing --allowed-dirs path", async () => {
    const code = await runConfigure(["--allowed-dirs", path.join(tmpDir, "missing")]);
    expect(code).toBe(1);
    expect(loadConfigFile()).toEqual({});
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

describe("runConfigure — silent mode, credential bundle", () => {
  // A working key is verified by a 2xx on the data plane (the suite-wide 404
  // stub is the management-probe signal, which a working key never gets).
  beforeEach(() => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));
  });

  it("writes all four fields from one bundle", async () => {
    const code = await runConfigure(["--credential-bundle", bundleJson()]);

    expect(code).toBe(0);
    expect(loadConfigFile()).toMatchObject({
      apiKey: BUNDLE_API_KEY,
      servicePrivateKey: VALID_SIGNER,
      webAccountAddress: OWNER_ADDRESS,
      keyAdminAddress: KEY_ADMIN_ADDRESS,
    });
  });

  it("reads CONSOLE_CREDENTIAL_BUNDLE under --silent", async () => {
    process.env = { ...process.env, CONSOLE_CREDENTIAL_BUNDLE: bundleJson() };

    const code = await runConfigure(["--silent"]);

    expect(code).toBe(0);
    expect(loadConfigFile().webAccountAddress).toBe(OWNER_ADDRESS);
  });

  it("returns 1 and writes nothing for a malformed bundle", async () => {
    const code = await runConfigure(["--credential-bundle", "definitely not json"]);

    expect(code).toBe(1);
    expect(loadConfigFile()).toEqual({});
  });

  it("returns 1 and writes nothing when the bundle's key is rejected", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 401 }));

    const code = await runConfigure(["--credential-bundle", bundleJson()]);

    expect(code).toBe(1);
    expect(loadConfigFile()).toEqual({});
  });

  it("clears a stale owner pin the bundle carries as null", async () => {
    saveConfigFile({ webAccountAddress: STALE_ADDRESS, keyAdminAddress: KEY_ADMIN_ADDRESS });

    const code = await runConfigure([
      "--credential-bundle",
      bundleJson({ webAccountAddress: null }),
    ]);

    expect(code).toBe(0);
    const saved = loadConfigFile();
    expect(saved.webAccountAddress).toBeUndefined();
    expect(saved.keyAdminAddress).toBe(KEY_ADMIN_ADDRESS);
  });

  // The entry point must actually PRINT the warning the validator returns —
  // otherwise a scripted install reports success and produces a config where
  // every create_bucket refuses.
  it("prints the owner warning on a silent --api-key install with no pin", async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    const savedEnv = process.env["CONSOLE_WEB_ACCOUNT_ADDRESS"];
    delete process.env["CONSOLE_WEB_ACCOUNT_ADDRESS"];

    let code: number;
    try {
      code = await runConfigure(["--api-key", "hbr_working_key_value"]);
    } finally {
      process.stdout.write = original;
      if (savedEnv === undefined) delete process.env["CONSOLE_WEB_ACCOUNT_ADDRESS"];
      else process.env["CONSOLE_WEB_ACCOUNT_ADDRESS"] = savedEnv;
    }

    expect(code).toBe(0);
    const out = written.join("");
    expect(out).toContain("Credentials saved");
    expect(out).toContain("create_bucket will REFUSE");
    expect(out).toContain("CONSOLE_WEB_ACCOUNT_ADDRESS");
  });

  it("stays silent on --api-key when CONSOLE_WEB_ACCOUNT_ADDRESS is already set", async () => {
    process.env["CONSOLE_WEB_ACCOUNT_ADDRESS"] = OWNER_ADDRESS;
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    let code: number;
    try {
      code = await runConfigure(["--api-key", "hbr_working_key_value"]);
    } finally {
      process.stdout.write = original;
    }

    expect(code).toBe(0);
    expect(written.join("")).not.toContain("create_bucket will REFUSE");
  });

  it("prints the owner warning alongside the saved line when the bundle has no owner", async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    let code: number;
    try {
      code = await runConfigure(["--credential-bundle", bundleJson({ webAccountAddress: null })]);
    } finally {
      process.stdout.write = original;
    }

    expect(code).toBe(0);
    const out = written.join("");
    expect(out).toContain("Credentials saved");
    expect(out).toContain("create_bucket will REFUSE");
    expect(out).toContain("CONSOLE_WEB_ACCOUNT_ADDRESS");
  });

  it("returns 1 and writes nothing when a bundle is combined with --api-key", async () => {
    const code = await runConfigure([
      "--credential-bundle",
      bundleJson(),
      "--api-key",
      "hbr_some_other_key",
    ]);

    expect(code).toBe(1);
    expect(loadConfigFile()).toEqual({});
  });
});

// Address flags are seeds, not a silent trigger (see the `silent` comment on
// ParsedArgs): a scripted pins-only write has to say `--silent`. Without it the
// same argv seeds the interactive prompts instead, which these tests have no
// terminal to answer.
describe("runConfigure — silent mode, address pins (--silent required)", () => {
  it("persists a bare --owner-address without touching the credentials", async () => {
    saveConfigFile({ apiKey: "hbr_existing", servicePrivateKey: VALID_SIGNER });

    const code = await runConfigure(["--silent", "--owner-address", OWNER_ADDRESS]);

    expect(code).toBe(0);
    expect(loadConfigFile()).toMatchObject({
      apiKey: "hbr_existing",
      servicePrivateKey: VALID_SIGNER,
      webAccountAddress: OWNER_ADDRESS,
    });
  });

  it("persists both address flags together", async () => {
    const code = await runConfigure([
      "--silent",
      "--owner-address",
      OWNER_ADDRESS,
      "--key-admin-address",
      KEY_ADMIN_ADDRESS,
    ]);

    expect(code).toBe(0);
    expect(loadConfigFile()).toMatchObject({
      webAccountAddress: OWNER_ADDRESS,
      keyAdminAddress: KEY_ADMIN_ADDRESS,
    });
  });

  it("returns 1 and writes nothing for a malformed address", async () => {
    const code = await runConfigure(["--owner-address", "0xNOT_AN_ADDRESS"]);

    expect(code).toBe(1);
    expect(loadConfigFile()).toEqual({});
  });
});

// The "File access folders" menu branch. `--allowed-dirs` beside an address seed
// stays interactive on purpose (see ParsedArgs.silent), so this branch is the
// only thing that can honour the flag — and it must not silently swallow the
// address seeds that came with it.
describe("runConfigure — File access folders branch", () => {
  /** The index of the `paths` row in the chooser. */
  const PATHS_ROW = 4;

  /** Collect stdout so a panel does not pollute the test report. */
  function captureStdout(): { text: () => string; restore: () => void } {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    return {
      text: () => chunks.join(""),
      restore: () => {
        process.stdout.write = original;
      },
    };
  }

  it("saves the seeded folders without opening the picker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-cfg-seed-"));
    const capture = captureStdout();
    let code: number;
    try {
      code = await runConfigure(["--allowed-dirs", dir, "--owner-address", OWNER_ADDRESS], {
        select: async () => PATHS_ROW,
      });
    } finally {
      capture.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(code).toBe(0);
    expect(loadConfigFile().allowedDirs).toEqual([toRealPath(dir)]);
  });

  // The address seeds are a credential-step input; this branch never reaches
  // that step. Dropping them silently is what made the flag look honoured.
  it("says the address seeds were not applied and how to apply them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-cfg-seed-"));
    const capture = captureStdout();
    let code: number;
    try {
      code = await runConfigure(
        [
          "--allowed-dirs",
          dir,
          "--owner-address",
          OWNER_ADDRESS,
          "--key-admin-address",
          KEY_ADMIN_ADDRESS,
        ],
        { select: async () => PATHS_ROW },
      );
    } finally {
      capture.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(code).toBe(0);
    const out = capture.text();
    expect(out).toContain("--owner-address");
    expect(out).toContain("--key-admin-address");
    // The remedy has to be runnable as printed: `--silent`, both flags, both
    // addresses.
    expect(out).toContain(
      `--silent --owner-address ${OWNER_ADDRESS} --key-admin-address ${KEY_ADMIN_ADDRESS}`,
    );
  });

  it("names only the address seeds that were actually given", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-cfg-seed-"));
    const capture = captureStdout();
    try {
      await runConfigure(["--allowed-dirs", dir, "--owner-address", OWNER_ADDRESS], {
        select: async () => PATHS_ROW,
      });
    } finally {
      capture.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const out = capture.text();
    expect(out).toContain("--owner-address");
    expect(out).not.toContain("--key-admin-address");
  });

  it("returns 1 and writes nothing for a seeded folder that does not exist", async () => {
    const missing = path.join(tmpDir, "no-such-folder");
    const capture = captureStdout();
    let selectCalls = 0;
    let code: number;
    try {
      code = await runConfigure(["--allowed-dirs", missing, "--owner-address", OWNER_ADDRESS], {
        select: async () => {
          selectCalls++;
          return PATHS_ROW;
        },
      });
    } finally {
      capture.restore();
    }
    expect(code).toBe(1);
    expect(loadConfigFile()).toEqual({});
    const out = capture.text();
    expect(out).toContain(missing);
    // Refused before the menu, and refused once — stepAllowedDirs' own guard
    // is still there but is no longer reachable with a bad seed.
    expect(selectCalls).toBe(0);
    expect(out.split(missing).length - 1).toBe(1);
  });

  it("returns 0 without writing when the chooser is cancelled", async () => {
    const capture = captureStdout();
    let code: number;
    try {
      code = await runConfigure(["--allowed-dirs", tmpDir, "--owner-address", OWNER_ADDRESS], {
        select: async () => null,
      });
    } finally {
      capture.restore();
    }
    expect(code).toBe(0);
    expect(loadConfigFile()).toEqual({});
  });
});

// The mirror of the branch above: a credential row never reaches
// stepAllowedDirs, so `config --allowed-dirs /data --owner-address 0x…` used to
// discard the folder flag under a green "Configuration saved".
describe("runConfigure — credential branch with a folder seed", () => {
  /** The index of the `api` row in the chooser. */
  const API_ROW = 1;

  /**
   * A readline over an already-ended pipe: runConfigure treats the close as a
   * cancel (its documented Ctrl-D path), which returns before any prompt — the
   * notice under test is printed before that point.
   */
  const closedReadline = () => {
    const input = new PassThrough();
    input.end();
    return readline.createInterface({ input, output: new PassThrough() });
  };

  it("says --allowed-dirs was not applied and names the command that applies it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-cfg-drop-"));
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await runConfigure(["--allowed-dirs", dir, "--owner-address", OWNER_ADDRESS], {
        select: async () => API_ROW,
        createReadline: closedReadline,
      });
    } finally {
      process.stdout.write = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(code).toBe(0);
    const out = chunks.join("");
    expect(out).toContain("--allowed-dirs not applied");
    expect(out).toContain(`walrus-console-mcp config --allowed-dirs '${dir}'`);
  });

  // The notice above promises a command that runs. A folder with a space in it
  // is the case where an unquoted remedy silently truncates: the shell splits
  // it, parseArgs takes the first word as the folder and rejects the rest with
  // "Unexpected argument", and the operator gets exit 1 on a path they never
  // typed. Round-trip the printed line through a real shell to prove it.
  it.skipIf(process.platform === "win32")(
    "quotes a folder with a space so the printed remedy round-trips",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus cfg space-"));
      const chunks: string[] = [];
      const original = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        await runConfigure(["--allowed-dirs", dir, "--owner-address", OWNER_ADDRESS], {
          select: async () => API_ROW,
          createReadline: closedReadline,
        });
      } finally {
        process.stdout.write = original;
        fs.rmSync(dir, { recursive: true, force: true });
      }
      const marker = "walrus-console-mcp config --allowed-dirs ";
      const line = chunks
        .join("")
        .split("\n")
        .find((l) => l.includes(marker));
      expect(line).toBeDefined();
      const printedArgs = (line as string).slice((line as string).indexOf("--allowed-dirs"));

      // What the shell hands back is the argv the operator would actually get.
      const { execFileSync } = await import("node:child_process");
      const argv = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${printedArgs}`])
        .toString()
        .split("\n")
        .slice(0, -1);

      const parsed = parseArgs(argv, {} as NodeJS.ProcessEnv);
      expect(parsed.errors).toEqual([]);
      expect(parsed.values.allowedDirs).toEqual([dir]);
    },
  );

  // The remedy this branch prints has to be runnable, which is only true if the
  // folder was validated before the menu. Before that hoist the same typo got
  // three different answers: 1 from install, 1 from the paths row, and 0 here
  // plus a `config --allowed-dirs /dta` that fails when the operator runs it.
  it("refuses a bad folder before the menu instead of printing a remedy that fails", async () => {
    const missing = path.join(tmpDir, "no-such-folder");
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let selectCalls = 0;
    let code: number;
    try {
      code = await runConfigure(["--allowed-dirs", missing, "--owner-address", OWNER_ADDRESS], {
        select: async () => {
          selectCalls++;
          return API_ROW;
        },
        createReadline: closedReadline,
      });
    } finally {
      process.stdout.write = original;
    }
    expect(code).toBe(1);
    expect(selectCalls).toBe(0);
    expect(loadConfigFile()).toEqual({});
    const out = chunks.join("");
    expect(out).toContain(missing);
    // No un-runnable remedy: the notice can only name folders that validated.
    expect(out).not.toContain("Apply it with");
  });

  it("stays quiet when no folder seed was given", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runConfigure(["--owner-address", OWNER_ADDRESS], {
        select: async () => API_ROW,
        createReadline: closedReadline,
      });
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join("")).not.toContain("--allowed-dirs");
  });
});
