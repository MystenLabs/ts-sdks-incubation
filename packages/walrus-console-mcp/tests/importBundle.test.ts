import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeBundleArg,
  type ImportDeps,
  parseImportBundleArg,
  runImportBundle,
} from "../bin/importBundle.js";
import { getConfigFilePath, loadConfigFile, mergeConfigFile } from "../src/configFile.js";
import { type ProbeVerdict, suiAddressFromServiceKey } from "../src/credentials.js";
import { IMPORTED_BUNDLE_PLACEHOLDER, SAFE_NPX_PREFIX_ARG } from "../src/cursorEntry.js";
import { clearSecrets } from "../src/redaction.js";

const API_KEY = "hbr_linkImportTestKey0123456789abcd";
const SIGNER = Ed25519Keypair.generate().getSecretKey();
const OWNER = `0x${"a".repeat(64)}`;
const KEY_ADMIN = `0x${"b".repeat(64)}`;
const BUNDLE_JSON = JSON.stringify({
  v: 1,
  apiKey: API_KEY,
  servicePrivateKey: SIGNER,
  webAccountAddress: OWNER,
  keyAdminAddress: KEY_ADMIN,
});
const b64 = (text: string) => Buffer.from(text, "utf-8").toString("base64url");
const BUNDLE = b64(BUNDLE_JSON);
const SPEC = "@mysten-incubation/walrus-console-mcp@0.1.0-beta.0";
const OTHER = { command: "node", args: ["/opt/other/server.js"] };

let tmpDir: string;
let mcpJson: string;
let originalEnv: NodeJS.ProcessEnv;
let lines: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-import-bundle-test-"));
  mcpJson = path.join(tmpDir, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(mcpJson), { recursive: true });
  originalEnv = { ...process.env };
  const {
    CONSOLE_API_KEY: _a,
    CONSOLE_SERVICE_PRIVATE_KEY: _b,
    CONSOLE_ADMIN_KEY: _c,
    CONSOLE_ADMIN_SERVICE_PRIVATE_KEY: _d,
    CONSOLE_API_BASE_URL: _e,
    CONSOLE_CREDENTIAL_BUNDLE: _f,
    ...rest
  } = process.env;
  // getConfigDir reads APPDATA on Windows and XDG_CONFIG_HOME elsewhere.
  process.env = { ...rest, XDG_CONFIG_HOME: tmpDir, APPDATA: tmpDir };
  lines = [];
});

afterEach(() => {
  process.env = originalEnv;
  clearSecrets();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeMcpJson(bundle = BUNDLE) {
  fs.writeFileSync(
    mcpJson,
    JSON.stringify({
      mcpServers: {
        other: OTHER,
        "walrus-console": {
          command: "npx",
          args: [SAFE_NPX_PREFIX_ARG, "-y", SPEC, "--import-bundle", bundle],
        },
      },
    }),
  );
}

const readMcpJson = () => fs.readFileSync(mcpJson, "utf-8");

function deps(verdict: ProbeVerdict = "ok"): ImportDeps & { probed: string[] } {
  const probed: string[] = [];
  return {
    probed,
    probe: async (_kind, key) => {
      probed.push(key);
      return verdict;
    },
    cursorConfigPath: mcpJson,
    log: (line) => lines.push(line),
  };
}

const run = (d: ImportDeps, bundle = BUNDLE) => runImportBundle(["--import-bundle", bundle], d);

/** No report line may carry any part of the credential. */
function expectNoSecretInLogs() {
  const text = lines.join("\n");
  for (const secret of [BUNDLE, API_KEY, SIGNER]) expect(text).not.toContain(secret);
}

describe("parseImportBundleArg", () => {
  it("is null without the flag, so the server skips the import entirely", () => {
    expect(parseImportBundleArg([])).toBeNull();
    expect(parseImportBundleArg(["--other"])).toBeNull();
  });

  it("takes the value after the flag, or after =", () => {
    expect(parseImportBundleArg(["--import-bundle", "abc"])).toEqual({ value: "abc", raw: "abc" });
    expect(parseImportBundleArg(["--import-bundle=abc"])).toEqual({ value: "abc", raw: "abc" });
  });

  it("refuses a flag with no value", () => {
    expect(parseImportBundleArg(["--import-bundle"])).toEqual({
      error: "--import-bundle needs a value",
    });
    expect(parseImportBundleArg(["--import-bundle="])).toHaveProperty("error");
  });
});

describe("decodeBundleArg", () => {
  it("decodes base64url, with or without padding", () => {
    expect(decodeBundleArg(BUNDLE)).toEqual({ json: BUNDLE_JSON });
    expect(decodeBundleArg(Buffer.from(BUNDLE_JSON).toString("base64"))).toHaveProperty("json");
  });

  it("refuses characters outside base64url instead of skipping them", () => {
    expect(decodeBundleArg(`${BUNDLE.slice(0, 10)}!${BUNDLE.slice(10)}`)).toEqual({
      error: "the bundle in the link is not base64url",
    });
  });

  it("refuses a length no encoder produces", () => {
    expect(decodeBundleArg(BUNDLE.slice(0, 4 * 10 + 1))).toEqual({
      error: "the bundle in the link is truncated",
    });
  });

  it("refuses bytes that are not UTF-8", () => {
    expect(decodeBundleArg(Buffer.from([0xff, 0xfe, 0xfd]).toString("base64url"))).toHaveProperty(
      "error",
    );
  });
});

describe("runImportBundle", () => {
  it("saves the bundle, strips it from mcp.json, and leaves the other servers alone", async () => {
    writeMcpJson();
    const outcome = await run(deps());

    expect(outcome).toEqual({ kind: "imported", warnings: [] });
    const saved = loadConfigFile();
    expect(saved.apiKey).toBe(API_KEY);
    expect(saved.servicePrivateKey).toBe(SIGNER);
    expect(saved.webAccountAddress).toBe(OWNER);
    expect(saved.keyAdminAddress).toBe(KEY_ADMIN);

    const text = readMcpJson();
    expect(text).not.toContain(BUNDLE);
    const servers = JSON.parse(text).mcpServers;
    expect(servers.other).toEqual(OTHER);
    expect(servers["walrus-console"].args).toEqual([
      SAFE_NPX_PREFIX_ARG,
      "-y",
      SPEC,
      "--import-bundle",
      IMPORTED_BUNDLE_PLACEHOLDER,
    ]);
    expectNoSecretInLogs();
  });

  it.skipIf(process.platform === "win32")("writes config.json owner-only", async () => {
    writeMcpJson();
    await run(deps());
    expect(fs.statSync(getConfigFilePath()).mode & 0o777).toBe(0o600);
  });

  it("does nothing on a start whose entry already carries the placeholder", async () => {
    writeMcpJson(IMPORTED_BUNDLE_PLACEHOLDER);
    const before = readMcpJson();
    const d = deps();

    expect(await run(d, IMPORTED_BUNDLE_PLACEHOLDER)).toEqual({ kind: "placeholder" });
    expect(d.probed).toEqual([]);
    expect(fs.existsSync(getConfigFilePath())).toBe(false);
    expect(readMcpJson()).toBe(before);
    expect(lines).toEqual([]);
  });

  it("keeps a different saved key, logs why, and still strips the bundle", async () => {
    fs.mkdirSync(path.dirname(getConfigFilePath()), { recursive: true });
    const existing = `${JSON.stringify({ v: 1, apiKey: "hbr_theUsersOwnSavedKey0000" })}\n`;
    fs.writeFileSync(getConfigFilePath(), existing);
    writeMcpJson();
    const d = deps();

    expect(await run(d)).toEqual({ kind: "kept-existing" });
    expect(fs.readFileSync(getConfigFilePath(), "utf-8")).toBe(existing);
    // Refused before the probe: the key was never sent anywhere.
    expect(d.probed).toEqual([]);
    expect(readMcpJson()).not.toContain(BUNDLE);
    expect(lines.join("\n")).toContain("never replaces");
    expectNoSecretInLogs();
  });

  it("treats a saved admin.json as an existing config too", async () => {
    fs.mkdirSync(path.dirname(getConfigFilePath()), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(getConfigFilePath()), "admin.json"),
      JSON.stringify({ v: 1, adminKey: "hbradm_theUsersOwnAdminKey00" }),
    );
    writeMcpJson();
    expect(await run(deps())).toEqual({ kind: "kept-existing" });
    expect(fs.existsSync(getConfigFilePath())).toBe(false);
  });

  it("reports an identical saved key as already imported, not as a refusal", async () => {
    writeMcpJson();
    await run(deps());
    writeMcpJson();
    lines = [];

    expect(await run(deps())).toEqual({ kind: "already-imported" });
    expect(readMcpJson()).not.toContain(BUNDLE);
  });

  it("says the other copy cleaned the entry, not that it needs a hand edit", async () => {
    // Cursor's IDE and agent worker both start from the same entry: the loser
    // finds the bundle already saved and the entry already cleaned.
    writeMcpJson();
    await run(deps());
    lines = [];

    expect(await run(deps())).toEqual({ kind: "already-imported" });
    expect(lines.join("\n")).toContain("most likely by the other copy");
    expect(lines.join("\n")).not.toContain("by hand");
  });

  it("keeps the manual guidance when the entry was never cleaned here", async () => {
    // Launched from a project's .cursor/mcp.json: the global file holds no
    // cleaned entry, so nothing shows that another copy did the work.
    writeMcpJson();
    await run(deps());
    fs.writeFileSync(mcpJson, JSON.stringify({ mcpServers: { other: OTHER } }));
    lines = [];

    expect(await run(deps())).toEqual({ kind: "already-imported" });
    expect(lines.join("\n")).toContain("was not found in");
    expect(lines.join("\n")).not.toContain("the other copy");
  });

  it("strips a finished repeat without asking Console, even while Console is down", async () => {
    writeMcpJson();
    await run(deps());
    writeMcpJson();
    const d = deps("unreachable");

    expect(await run(d)).toEqual({ kind: "already-imported" });
    expect(d.probed).toEqual([]);
    expect(readMcpJson()).not.toContain(BUNDLE);
  });

  it.each([
    ["the bundle as its own argument", (b: string) => ["--import-bundle", b]],
    ["the --import-bundle=<value> spelling", (b: string) => [`--import-bundle=${b}`]],
  ])("strips %s even with whitespace around it", async (_label, argsFor) => {
    const padded = ` ${BUNDLE} `;
    fs.writeFileSync(
      mcpJson,
      JSON.stringify({
        mcpServers: {
          "walrus-console": {
            command: "npx",
            args: [SAFE_NPX_PREFIX_ARG, "-y", SPEC, ...argsFor(padded)],
          },
        },
      }),
    );

    expect(await runImportBundle(argsFor(padded), deps())).toEqual({
      kind: "imported",
      warnings: [],
    });
    expect(readMcpJson()).not.toContain(BUNDLE);
  });

  it.each([
    ["an owner pin", { webAccountAddress: `0x${"c".repeat(64)}` }],
    ["a deployment host", { baseUrl: "http://localhost:4000" }],
  ])("does not overwrite %s the saved copy already has", async (_label, field) => {
    // The same pair with its other pin missing: a repair fills gaps only.
    fs.mkdirSync(path.dirname(getConfigFilePath()), { recursive: true });
    const existing = JSON.stringify({
      v: 1,
      apiKey: API_KEY,
      servicePrivateKey: SIGNER,
      ...field,
    });
    fs.writeFileSync(getConfigFilePath(), existing);
    process.env["CONSOLE_API_BASE_URL"] = "http://localhost:2024";
    writeMcpJson();

    expect(await run(deps())).toEqual({ kind: "kept-existing" });
    expect(fs.readFileSync(getConfigFilePath(), "utf-8")).toBe(existing);
    expect(readMcpJson()).not.toContain(BUNDLE);
  });

  it("does not let a bundle without an owner pin clear the saved one", async () => {
    fs.mkdirSync(path.dirname(getConfigFilePath()), { recursive: true });
    const existing = JSON.stringify({
      v: 1,
      apiKey: API_KEY,
      servicePrivateKey: SIGNER,
      webAccountAddress: OWNER,
    });
    fs.writeFileSync(getConfigFilePath(), existing);
    const noOwner = b64(JSON.stringify({ ...JSON.parse(BUNDLE_JSON), webAccountAddress: null }));
    writeMcpJson(noOwner);

    expect(await run(deps(), noOwner)).toEqual({ kind: "kept-existing" });
    expect(fs.readFileSync(getConfigFilePath(), "utf-8")).toBe(existing);
  });

  it.each([
    ["holds only folders", { v: 1, allowedDirs: [os.tmpdir()] }],
    ["is empty", { v: 1 }],
  ])("imports into a config that %s, keeping what it had", async (_label, existing) => {
    fs.mkdirSync(path.dirname(getConfigFilePath()), { recursive: true });
    fs.writeFileSync(getConfigFilePath(), JSON.stringify(existing));
    writeMcpJson();

    expect(await run(deps())).toEqual({ kind: "imported", warnings: [] });
    const saved = loadConfigFile();
    expect(saved.apiKey).toBe(API_KEY);
    expect(saved.allowedDirs).toEqual((existing as { allowedDirs?: string[] }).allowedDirs);
    expect(readMcpJson()).not.toContain(BUNDLE);
  });

  it("keeps the bundle and says what to fix when config.json cannot be parsed", async () => {
    fs.mkdirSync(path.dirname(getConfigFilePath()), { recursive: true });
    fs.writeFileSync(getConfigFilePath(), "{ not json");
    writeMcpJson();
    const d = deps();

    expect((await run(d))?.kind).toBe("deferred");
    expect(d.probed).toEqual([]);
    expect(fs.readFileSync(getConfigFilePath(), "utf-8")).toBe("{ not json");
    expect(readMcpJson()).toContain(BUNDLE);
    expect(lines.join("\n")).toContain("could not be parsed as JSON");
  });

  it("refuses the same key with a different signer", async () => {
    fs.mkdirSync(path.dirname(getConfigFilePath()), { recursive: true });
    const other = Ed25519Keypair.generate().getSecretKey();
    const existing = JSON.stringify({ v: 1, apiKey: API_KEY, servicePrivateKey: other });
    fs.writeFileSync(getConfigFilePath(), existing);
    writeMcpJson();

    expect(await run(deps())).toEqual({ kind: "kept-existing" });
    expect(fs.readFileSync(getConfigFilePath(), "utf-8")).toBe(existing);
  });

  it("does not merge over a key saved while the probe was running", async () => {
    // `config` saving between the pre-check and the write: the decision has to
    // be made again inside the write's own lock.
    writeMcpJson();
    const d = deps();
    d.probe = async () => {
      mergeConfigFile({ apiKey: "hbr_savedDuringTheProbe0000" }, [], () => {});
      return "ok";
    };

    expect(await run(d)).toEqual({ kind: "kept-existing" });
    expect(loadConfigFile().apiKey).toBe("hbr_savedDuringTheProbe0000");
    expect(readMcpJson()).not.toContain(BUNDLE);
  });

  it("finishes a management import whose second file write failed, instead of stripping it", async () => {
    const adminSigner = Ed25519Keypair.generate().getSecretKey();
    const adminBundle = b64(
      JSON.stringify({
        v: 1,
        adminKey: "hbradm_linkImportAdminKey0123456789",
        adminServicePrivateKey: adminSigner,
        webAccountAddress: OWNER,
        keyAdminAddress: suiAddressFromServiceKey(adminSigner),
      }),
    );
    writeMcpJson(adminBundle);
    expect((await run(deps(), adminBundle))?.kind).toBe("imported");
    // admin.json is written first; losing config.json is the failed second write.
    fs.rmSync(getConfigFilePath());
    expect(loadConfigFile().webAccountAddress).toBeUndefined();
    writeMcpJson(adminBundle);

    expect((await run(deps(), adminBundle))?.kind).toBe("imported");
    const saved = loadConfigFile();
    expect(saved.adminKey).toBe("hbradm_linkImportAdminKey0123456789");
    expect(saved.webAccountAddress).toBe(OWNER);
    expect(saved.keyAdminAddress).toBe(suiAddressFromServiceKey(adminSigner));
    expect(readMcpJson()).not.toContain(adminBundle);
  });

  /** A management bundle that names no owner, as Console issues one. */
  function ownerlessAdminBundle(): string {
    const signer = Ed25519Keypair.generate().getSecretKey();
    return b64(
      JSON.stringify({
        v: 1,
        adminKey: "hbradm_linkImportAdminKey0123456789",
        adminServicePrivateKey: signer,
        webAccountAddress: null,
        keyAdminAddress: suiAddressFromServiceKey(signer),
      }),
    );
  }

  it("does not warn about a missing owner when the saved owner survives the import", async () => {
    fs.mkdirSync(path.dirname(getConfigFilePath()), { recursive: true });
    fs.writeFileSync(getConfigFilePath(), JSON.stringify({ v: 1, webAccountAddress: OWNER }));
    const bundle = ownerlessAdminBundle();
    writeMcpJson(bundle);

    expect(await run(deps(), bundle)).toEqual({ kind: "imported", warnings: [] });
    expect(loadConfigFile().webAccountAddress).toBe(OWNER);
    expect(lines.join("\n")).not.toContain("No bucket-owner address");
  });

  it("still warns about a missing owner when none is saved", async () => {
    const bundle = ownerlessAdminBundle();
    writeMcpJson(bundle);

    const outcome = await run(deps(), bundle);
    expect(outcome?.kind).toBe("imported");
    expect(lines.join("\n")).toContain("No bucket-owner address");
  });

  it("rejects a malformed bundle even when the Console host is refused", async () => {
    process.env["CONSOLE_API_BASE_URL"] = "https://evil.example.com";
    const malformed = b64(JSON.stringify({ hello: "world" }));
    writeMcpJson(malformed);

    expect((await run(deps(), malformed))?.kind).toBe("rejected");
    expect(readMcpJson()).not.toContain(malformed);
  });

  it.each([
    ["characters outside base64url", `${BUNDLE}!!`],
    ["a truncated link", BUNDLE.slice(0, Math.floor(BUNDLE.length / 2))],
    ["JSON that is not a bundle", b64(JSON.stringify({ hello: "world" }))],
    ["a bundle with a malformed signer", b64(BUNDLE_JSON.replace(SIGNER, "suiprivkey1broken"))],
  ])("rejects %s, writes nothing, says why, and strips it", async (_label, bundle) => {
    writeMcpJson(bundle);
    const outcome = await run(deps(), bundle);

    expect(outcome?.kind).toBe("rejected");
    expect(fs.existsSync(getConfigFilePath())).toBe(false);
    expect(readMcpJson()).not.toContain(bundle);
    expect(lines[0]).toMatch(/did not import the credential bundle: .+ Nothing was saved\./);
    expectNoSecretInLogs();
  });

  it("rejects a key Console refuses, and strips it: no later start could succeed", async () => {
    writeMcpJson();
    const outcome = await run(deps("invalid"));

    expect(outcome?.kind).toBe("rejected");
    expect(fs.existsSync(getConfigFilePath())).toBe(false);
    expect(readMcpJson()).not.toContain(BUNDLE);
    expectNoSecretInLogs();
  });

  it("keeps the bundle for the next start when Console cannot be reached", async () => {
    writeMcpJson();
    const before = readMcpJson();
    const outcome = await run(deps("unreachable"));

    expect(outcome?.kind).toBe("deferred");
    expect(fs.existsSync(getConfigFilePath())).toBe(false);
    expect(readMcpJson()).toBe(before);
    expect(lines.join("\n")).toContain("next start retries");
    expectNoSecretInLogs();
  });

  it("imports on the retry once Console is reachable again", async () => {
    writeMcpJson();
    await run(deps("unreachable"));
    expect(await run(deps("ok"))).toEqual({ kind: "imported", warnings: [] });
    expect(readMcpJson()).not.toContain(BUNDLE);
  });

  it("defers when the environment names a Console host the allowlist refuses", async () => {
    process.env["CONSOLE_API_BASE_URL"] = "https://evil.example.com";
    writeMcpJson();
    const d = deps();

    expect((await run(d))?.kind).toBe("deferred");
    expect(d.probed).toEqual([]);
    expect(readMcpJson()).toContain(BUNDLE);
  });

  it("still saves when there is no Cursor config to strip, and says where to look", async () => {
    expect(await run(deps())).toEqual({ kind: "imported", warnings: [] });
    expect(loadConfigFile().apiKey).toBe(API_KEY);
    expect(lines.join("\n")).toContain("was not found in");
  });

  it("reports a flag without a value instead of starting silently", async () => {
    const outcome = await runImportBundle(["--import-bundle"], deps());
    expect(outcome).toEqual({ kind: "rejected", reason: "--import-bundle needs a value" });
    expect(lines).toEqual(["Add to Cursor: --import-bundle needs a value."]);
  });

  it("is a no-op without the flag", async () => {
    expect(await runImportBundle([], deps())).toBeNull();
    expect(lines).toEqual([]);
  });
});

// Read as text rather than imported: importing bin/console-mcp.ts starts the
// server (see the same note in tests/usage.test.ts).
describe("the server entry point", () => {
  it("imports the bundle before it reads credentials or starts the transport", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "bin", "console-mcp.ts"), "utf-8");
    const importCall = src.indexOf("await runImportBundle(");
    const credentialRead = src.indexOf("const savedConfig = loadConfigFileOrEmpty()");
    const transport = src.indexOf("StdioServerTransport(");
    expect(importCall).toBeGreaterThan(-1);
    expect(credentialRead).toBeGreaterThan(-1);
    expect(importCall).toBeLessThan(credentialRead);
    expect(importCall).toBeLessThan(transport);
  });
});
