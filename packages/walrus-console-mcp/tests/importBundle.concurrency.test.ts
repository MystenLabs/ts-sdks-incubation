import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMPORTED_BUNDLE_PLACEHOLDER, SAFE_NPX_PREFIX_ARG } from "../src/cursorEntry.js";

/**
 * Cursor's agent worker starts its own copy of the server beside the IDE's, so
 * one Add to Cursor link can start two processes with the same bundle at once.
 * These drive real child processes, because an in-process test cannot observe
 * an inter-process race — the thing under test is the locking, not the import.
 */

const REPO_ROOT = path.resolve(__dirname, "..");
const MODULE = pathToFileURL(path.join(REPO_ROOT, "bin", "importBundle.ts")).href;
const API_KEY = "hbr_concurrentImportKey0123456789";
const BUNDLE = Buffer.from(
  JSON.stringify({
    v: 1,
    apiKey: API_KEY,
    servicePrivateKey: Ed25519Keypair.generate().getSecretKey(),
    webAccountAddress: `0x${"a".repeat(64)}`,
    keyAdminAddress: `0x${"b".repeat(64)}`,
  }),
).toString("base64url");
const OTHERS = {
  first: { command: "node", args: ["/opt/first/server.js"], env: { FIRST_TOKEN: "unrelated" } },
  last: { command: "npx", args: ["-y", "some-other-mcp"] },
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-import-race-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runImportBundle — copies started together", () => {
  it("writes config.json once and leaves mcp.json valid, with every other server untouched", async () => {
    const mcpJson = path.join(tmpDir, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(mcpJson), { recursive: true });
    fs.writeFileSync(
      mcpJson,
      JSON.stringify({
        mcpServers: {
          first: OTHERS.first,
          "walrus-console": {
            command: "npx",
            args: [SAFE_NPX_PREFIX_ARG, "-y", "pkg@1", "--import-bundle", BUNDLE],
          },
          last: OTHERS.last,
        },
      }),
    );

    // Far enough ahead that every child has loaded before any of them starts.
    const startAt = Date.now() + 5000;
    const script = path.join(tmpDir, "race.mts");
    fs.writeFileSync(
      script,
      `import { runImportBundle } from ${JSON.stringify(MODULE)};\n` +
        `while (Date.now() < ${startAt}) {}\n` +
        `const outcome = await runImportBundle(["--import-bundle", ${JSON.stringify(BUNDLE)}], {\n` +
        `  probe: async () => "ok",\n` +
        `  cursorConfigPath: ${JSON.stringify(mcpJson)},\n` +
        `  log: () => {},\n` +
        `});\n` +
        `process.stdout.write(outcome.kind);\n`,
    );

    const {
      CONSOLE_API_BASE_URL: _url,
      CONSOLE_API_KEY: _key,
      CONSOLE_SERVICE_PRIVATE_KEY: _signer,
      ...env
    } = process.env;
    const copies = [0, 1, 2].map(
      () =>
        new Promise<{ code: number | null; kind: string }>((resolve) => {
          const child = spawn(process.execPath, ["--import", "tsx", script], {
            cwd: REPO_ROOT,
            env: { ...env, XDG_CONFIG_HOME: tmpDir, APPDATA: tmpDir },
            stdio: ["ignore", "pipe", "inherit"],
          });
          let kind = "";
          child.stdout.on("data", (chunk: Buffer) => (kind += chunk.toString()));
          child.on("exit", (code) => resolve({ code, kind }));
        }),
    );
    const results = await Promise.all(copies);

    expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
    const kinds = results.map((r) => r.kind).sort();
    expect(kinds).toEqual(["already-imported", "already-imported", "imported"]);

    const configDir = path.join(tmpDir, "walrus-console-mcp");
    const saved = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf-8"));
    expect(saved.apiKey).toBe(API_KEY);
    expect(fs.readdirSync(configDir).filter((n) => n.includes("lock"))).toEqual([]);

    const text = fs.readFileSync(mcpJson, "utf-8");
    expect(text).not.toContain(BUNDLE);
    const servers = JSON.parse(text).mcpServers;
    expect(Object.keys(servers)).toEqual(["first", "walrus-console", "last"]);
    expect(servers.first).toEqual(OTHERS.first);
    expect(servers.last).toEqual(OTHERS.last);
    expect(servers["walrus-console"].args.at(-1)).toBe(IMPORTED_BUNDLE_PLACEHOLDER);
  }, 60_000);
});
