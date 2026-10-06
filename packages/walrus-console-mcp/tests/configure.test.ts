import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConfigure } from "../bin/configure.js";
import { parseArgs } from "../src/cliArgs.js";
import { stepAllowedDirs } from "../bin/install.js";
import {
  getAdminConfigFilePath,
  loadConfigFile,
  type mergeConfigFile,
  saveConfigFile,
} from "../src/configFile.js";
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

  // security review, C11: `resolveInstallBaseUrl` and the pre-write read
  // passed to `validateSilent` as `existing` both used to call `loadConfigFile`
  // bare — a pure read, evaluated as a plain function argument before
  // `validateSilent` ever runs, so a corrupt admin.json threw there and masked
  // whatever `validateSilent` would otherwise have reported. The actual WRITE
  // (`mergeConfigFile`'s own internal load) stays correctly fail-stop on a
  // genuinely corrupt admin.json — the review itself calls that "deliberate
  // and right" — so this only fixes the reads that ran BEFORE any write
  // decision exists, not the write itself. What's testable post-fix: a
  // wrong-key-type error unrelated to admin.json now surfaces correctly
  // instead of being pre-empted by the admin file's own corruption.
  it("surfaces a real validation error instead of an unrelated admin.json corruption (C11)", async () => {
    fs.mkdirSync(path.dirname(getAdminConfigFilePath()), { recursive: true });
    fs.writeFileSync(getAdminConfigFilePath(), '{ "adminKey": "hbradm_TRUNC', "utf-8");
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await runConfigure(["--admin-key", "hbr_wrong_type", "--admin-signer", VALID_SIGNER]);
    } finally {
      process.stdout.write = original;
    }
    expect(code).toBe(1);
    const out = chunks.join("");
    expect(out).toMatch(/everyday API key/i); // validateSilent's real error
    expect(out).not.toMatch(/could not be parsed as JSON/); // the masked one
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

// security review, "test gap": before `RunConfigureDeps.collect` existed,
// the interactive credential branch's onNotice wiring (loadConfigFileOrEmpty
// at the pre-write read, and the saved-line label ignoring
// `migratedLegacyAdmin`) had no test at all — a revert of either left the
// whole suite green, catchable only by a live terminal run. The `collect`
// seam drives this branch without a real prompt/probe sequence.
describe("runConfigure — interactive credential branch (onNotice wiring)", () => {
  /** The index of the `api` row in the chooser. */
  const API_ROW = 1;

  function openReadline() {
    return readline.createInterface({ input: new PassThrough(), output: new PassThrough() });
  }

  it("routes the pre-write loadConfigFileOrEmpty's warning through the panel, not console.error", async () => {
    const dir = path.join(tmpDir, "walrus-console-mcp");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{ not valid json", "utf-8");
    // Without this, `resolveInstallBaseUrl()` at the top of `runConfigure`
    // (unconditional, no onNotice) reads this same corrupt file first and
    // consumes the per-path dedup (C16b) before the panel's own read runs —
    // isolating THIS call site needs that earlier one to short-circuit
    // instead (see resolveInstallBaseUrl's own `CONSOLE_API_BASE_URL || …`).
    process.env["CONSOLE_API_BASE_URL"] = "https://api.console.walrus.xyz";

    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const rl = openReadline();
    try {
      await runConfigure([], {
        select: async () => API_ROW,
        createReadline: () => rl,
        collect: async () => ({ updates: {}, clear: [] }),
      });
      expect(warn).not.toHaveBeenCalled();
      expect(chunks.join("")).toContain("could not be parsed as JSON");
    } finally {
      process.stdout.write = original;
      rl.close();
      warn.mockRestore();
    }
  });

  it("names admin.json in the saved line when this write migrates a legacy inline pair as a side effect", async () => {
    const dir = path.join(tmpDir, "walrus-console-mcp");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ adminKey: "hbradm_legacy", adminServicePrivateKey: VALID_SIGNER }),
      "utf-8",
    );

    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const rl = openReadline();
    try {
      // Only a working-key write — no admin field in `updates` — yet the
      // legacy pair already on disk still needs to migrate into admin.json.
      await runConfigure([], {
        select: async () => API_ROW,
        createReadline: () => rl,
        collect: async () => ({ updates: { apiKey: "hbr_new" }, clear: [] }),
      });
      expect(chunks.join("")).toContain("config.json + admin.json");
      expect(fs.existsSync(getAdminConfigFilePath())).toBe(true);
    } finally {
      process.stdout.write = original;
      rl.close();
    }
  });
});

/**
 * COMG-1036 item 3. A beta user picked the wrong credential type and found no
 * way out of the prompts but Ctrl-C and a fresh run. Steps 1 and 2 are a loop
 * now: `back` at any prompt, and esc on the File access row, return to the menu.
 */
describe("runConfigure — back to the menu (COMG-1036)", () => {
  /** Row indices in CHOICES: bundle, api, admin, both, paths. */
  const API_ROW = 1;
  const PATHS_ROW = 4;

  /**
   * Back only means anything where the menu can be drawn, and `runConfigure`
   * checks `process.stdout.isTTY` for exactly that. A vitest worker's stdout is
   * not a terminal, so these tests have to say they are simulating one; the
   * non-TTY branch has its own test at the end of this block.
   */
  let ttyDescriptor: PropertyDescriptor | undefined;
  beforeEach(() => {
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });
  afterEach(() => {
    if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  });

  const capture = () => {
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
  };

  /** A readline over pipes, plus the handle the test types into. */
  const pipeReadline = () => {
    const input = new PassThrough();
    const rl = readline.createInterface({ input, output: new PassThrough() });
    return { input, rl };
  };

  it('typing "back" at a prompt redraws the menu and writes nothing', async () => {
    const { input, rl } = pipeReadline();
    const rows: number[] = [];
    const out = capture();
    let code: number;
    try {
      code = await runConfigure([], {
        // Second visit cancels, so the run ends instead of looping forever.
        select: async () => {
          rows.push(rows.length);
          return rows.length === 1 ? API_ROW : null;
        },
        createReadline: () => rl,
        collect: async (_choice, prompts) => {
          const pending = prompts.ask("API key: ");
          // Only safe after `ask` has returned: rl.question is registered
          // synchronously inside it, and a line written before that is emitted
          // to nobody.
          input.write("back\n");
          await pending;
          throw new Error("ask resolved instead of unwinding");
        },
      });
    } finally {
      out.restore();
      rl.close();
    }
    // The menu was drawn a second time, which is the whole point.
    expect(rows.length).toBe(2);
    expect(code).toBe(0);
    expect(loadConfigFile()).toEqual({});
    expect(out.text()).toContain("Back to the menu");
  });

  it("advertises the affordance inside the panel, before the first prompt", async () => {
    const { input, rl } = pipeReadline();
    let visits = 0;
    const out = capture();
    try {
      await runConfigure([], {
        select: async () => {
          visits++;
          return visits === 1 ? API_ROW : null;
        },
        createReadline: () => rl,
        collect: async (_choice, prompts) => {
          const pending = prompts.ask("API key: ");
          input.write("back\n");
          await pending;
          throw new Error("ask resolved instead of unwinding");
        },
      });
    } finally {
      out.restore();
      rl.close();
    }
    expect(out.text()).toContain('Type "back" at any prompt');
  });

  it("carries on with whichever row is picked next", async () => {
    const { input, rl } = pipeReadline();
    const picks = [API_ROW, PATHS_ROW];
    let allowedDirsCalls = 0;
    const out = capture();
    let code: number;
    try {
      code = await runConfigure([], {
        select: async () => picks.shift() ?? null,
        createReadline: () => rl,
        collect: async (_choice, prompts) => {
          const pending = prompts.ask("API key: ");
          input.write("back\n");
          await pending;
          throw new Error("ask resolved instead of unwinding");
        },
        allowedDirs: async () => {
          allowedDirsCalls++;
          return { updates: { allowedDirs: ["/tmp"] }, clear: [] };
        },
      });
    } finally {
      out.restore();
      rl.close();
    }
    expect(allowedDirsCalls).toBe(1);
    expect(code).toBe(0);
  });

  // The doc on BackRequested says unwinding mid-prompt leaves the saved config
  // untouched. That holds because collectCredentials writes nothing, but it is
  // only worth anything if `back` works at a prompt other than the first.
  it("unwinds from a later prompt, after earlier answers were accepted", async () => {
    const { input, rl } = pipeReadline();
    let asked = 0;
    let visits = 0;
    const out = capture();
    let code: number;
    try {
      code = await runConfigure([], {
        select: async () => {
          visits++;
          return visits === 1 ? API_ROW : null;
        },
        createReadline: () => rl,
        collect: async (_choice, prompts) => {
          for (const answer of ["hbr_first_answer", "y", "back"]) {
            asked++;
            const pending = prompts.ask(`answer ${asked}: `);
            input.write(`${answer}\n`);
            await pending;
          }
          throw new Error("the third answer resolved instead of unwinding");
        },
      });
    } finally {
      out.restore();
      rl.close();
    }
    expect(asked).toBe(3);
    expect(visits).toBe(2);
    expect(code).toBe(0);
    expect(loadConfigFile()).toEqual({});
  });

  // The catch is `instanceof BackRequested` or rethrow. Without the rethrow a
  // probe failure would be reported as a cheerful "Back to the menu" and the
  // loop would re-enter the step rather than surfacing it.
  it("reports a real failure as a failure, not as a back", async () => {
    const { rl } = pipeReadline();
    const out = capture();
    let thrown: unknown;
    let visits = 0;
    try {
      await runConfigure([], {
        // Bounded: without the rethrow the error reads as a back, and the loop
        // re-enters the step forever. A stub that answers for ever would turn
        // that regression into a hung CI job instead of a failure.
        select: async () => {
          if (++visits > 2) throw new Error("the error was swallowed as a back");
          return API_ROW;
        },
        createReadline: () => rl,
        collect: async () => {
          throw new Error("probe exploded");
        },
      });
    } catch (err) {
      thrown = err;
    } finally {
      out.restore();
      rl.close();
    }
    expect(visits).toBe(1);
    expect((thrown as Error | undefined)?.message).toBe("probe exploded");
    expect(out.text()).not.toContain("Back to the menu");
    // And not as a cancel either: `phase` is set before the instanceof check,
    // so the deliberate rl.close() below does not print over the real message.
    expect(out.text()).not.toContain("Cancelled");
  });

  // Without a terminal, selectOne resolves the first row without drawing
  // anything, so looping would re-enter the same step with the menu never
  // shown and no exit but Ctrl-C.
  it("stops, and says why, when there is no terminal to draw the menu on", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    const { input, rl } = pipeReadline();
    let visits = 0;
    const out = capture();
    let code: number;
    try {
      code = await runConfigure([], {
        select: async () => {
          visits++;
          return API_ROW;
        },
        createReadline: () => rl,
        collect: async (_choice, prompts) => {
          const pending = prompts.ask("API key: ");
          input.write("back\n");
          await pending;
          throw new Error("ask resolved instead of unwinding");
        },
      });
    } finally {
      out.restore();
      rl.close();
    }
    expect(visits).toBe(1);
    expect(code).toBe(0);
    expect(out.text()).toContain("needs a terminal");
  });

  it("treats esc on the File access row as back, not as the end of the run", async () => {
    let visits = 0;
    let sawBackFlag: boolean | undefined;
    const out = capture();
    let code: number;
    try {
      code = await runConfigure([], {
        select: async () => {
          visits++;
          return visits === 1 ? PATHS_ROW : null;
        },
        allowedDirs: async (deps) => {
          sawBackFlag = deps?.back;
          return { updates: {}, clear: [], backRequested: true };
        },
      });
    } finally {
      out.restore();
    }
    // `config` reaches this step from a menu, so esc has somewhere to return to.
    expect(sawBackFlag).toBe(true);
    expect(visits).toBe(2);
    expect(code).toBe(0);
  });

  // The test above fabricates `backRequested`; this one makes the real step
  // produce it. Only the selector is faked, so the production branch that turns
  // esc into a back under `deps.back` is the thing being exercised.
  it("and the real step is what produces that, end to end", async () => {
    let visits = 0;
    const out = capture();
    let code: number;
    try {
      code = await runConfigure([], {
        select: async () => {
          visits++;
          return visits === 1 ? PATHS_ROW : null;
        },
        allowedDirs: (deps) =>
          stepAllowedDirs({
            ...deps,
            select: async () => null,
            cwd: tmpDir,
            home: tmpDir,
            merge: (() => {}) as unknown as typeof mergeConfigFile,
          }),
      });
    } finally {
      out.restore();
    }
    expect(visits).toBe(2);
    expect(code).toBe(0);
    // Back prints nothing: the menu it returns to is drawn straight after.
    expect(out.text()).not.toContain("File access skipped");
  });
});
