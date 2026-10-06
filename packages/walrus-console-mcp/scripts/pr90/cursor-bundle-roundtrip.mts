import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

// Boundary probe: the generated Cursor link's entry drives a real child MCP
// server, real loopback auth probe, config writes, cleanup, and restart. It
// never opens Cursor, accesses the user's home, or calls the live Console API.
// PR90_TEST_SOURCE_ROOT selects another checkout for a baseline comparison.
// PR90_BUNDLE_SOURCE_CLI=1 starts its source CLI rather than built dist.
// PR90_EXPECT_LEGACY_SYMLINK=1 explicitly expects the pre-fix symlink defect.
const harnessRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceRoot = process.env["PR90_TEST_SOURCE_ROOT"] ?? harnessRoot;
const sourceCli = process.env["PR90_BUNDLE_SOURCE_CLI"] === "1";
const legacySymlink = process.env["PR90_EXPECT_LEGACY_SYMLINK"] === "1";
const tsx = path.join(harnessRoot, "node_modules", "tsx", "dist", "loader.mjs");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-cursor-bundle-roundtrip-"));
const fixture = JSON.parse(
  fs.readFileSync(path.join(harnessRoot, "tests/fixtures/pr90/bundle-cursor-config.json"), "utf8"),
);
const key = "hbr_syntheticCursorRoundtripFixture0123456789";
const replacementKey = "hbr_syntheticDifferentSavedFixture0123456789";
const signer = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)).getSecretKey();
const bundle = {
  v: 1,
  apiKey: key,
  servicePrivateKey: signer,
  webAccountAddress: `0x${"a".repeat(64)}`,
  keyAdminAddress: `0x${"b".repeat(64)}`,
};
const encodedBundle = Buffer.from(JSON.stringify(bundle)).toString("base64url");
let fixtureStatus = 200;
let requests: { path: string; credential: "bundle" | "existing" | "unexpected" }[] = [];
const api = http.createServer((req, res) => {
  const credential =
    req.headers.authorization === `Bearer ${key}`
      ? "bundle"
      : req.headers.authorization === `Bearer ${replacementKey}`
        ? "existing"
        : "unexpected";
  requests.push({ path: req.url ?? "", credential });
  // Unexpected traffic is recorded without echoing Authorization.
  const status = req.method === "GET" && req.url === "/api/v1/spaces" ? fixtureStatus : 404;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(status === 200 ? { data: [] } : { error: "synthetic fixture outage" }));
});
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
const address = api.address();
assert(address !== null && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;
type Entry = { command: string; args: string[]; env?: Record<string, string> };

function isolatedEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    APPDATA: path.join(home, "AppData"),
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    CONSOLE_API_BASE_URL: baseUrl,
  };
}

function createEntry(home: string): Entry {
  const bundleFile = path.join(home, "synthetic-bundle.json");
  fs.writeFileSync(bundleFile, JSON.stringify(bundle), { mode: 0o600 });
  // Capture the credential-bearing link in memory, never print it.
  const link = execFileSync(
    process.execPath,
    [
      "--import",
      tsx,
      path.join(sourceRoot, "scripts/cursor-link.mts"),
      "--bundle-file",
      bundleFile,
    ],
    { cwd: sourceRoot, env: isolatedEnv(home), encoding: "utf8" },
  ).trim();
  const url = new URL(link);
  assert.equal(url.protocol, "cursor:");
  assert.equal(url.searchParams.get("name"), "walrus-console-mcp");
  const entry = JSON.parse(
    Buffer.from(url.searchParams.get("config")!, "base64").toString(),
  ) as Entry;
  assert.equal(entry.args.at(-1), encodedBundle);
  assert.equal(entry.env?.["CONSOLE_API_BASE_URL"], baseUrl);
  if (sourceCli) {
    entry.command = process.execPath;
    entry.args = [
      "--import",
      tsx,
      path.join(sourceRoot, "bin/console-mcp.ts"),
      ...entry.args.slice(1),
    ];
  }
  return entry;
}

function writeCursor(
  home: string,
  entry: Entry,
  symlink = false,
): { configPath: string; target: string } {
  const configPath = path.join(home, ".cursor/mcp.json");
  const target = symlink ? path.join(home, "dotfiles/cursor-mcp.json") : configPath;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify({
      ...fixture,
      mcpServers: { ...fixture.mcpServers, "walrus-console-mcp": entry },
    }),
    { mode: 0o640 },
  );
  if (symlink) fs.symlinkSync(target, configPath);
  return { configPath, target };
}

function readEntry(configPath: string): Entry {
  return JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers["walrus-console-mcp"] as Entry;
}

function readSaved(home: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(home, ".config/walrus-console-mcp/config.json"), "utf8"),
  );
}

async function start(home: string, entry: Entry, expectToolSuccess = true) {
  const stderr: string[] = [];
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env: { ...isolatedEnv(home), ...entry.env },
    cwd: home,
    stderr: "pipe",
  });
  const client = new Client({ name: "synthetic-cursor-bundle-roundtrip", version: "1.0.0" });
  // Pipe exists when transport starts; attach immediately after start through
  // an override so import-time diagnostics are captured too.
  const originalStart = transport.start.bind(transport);
  transport.start = async () => {
    await originalStart();
    transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  };
  try {
    await client.connect(transport, { timeout: 15000 });
    const tools = await client.listTools({}, { timeout: 10000 });
    assert(tools.tools.some((tool) => tool.name === "list_spaces"));
    let toolPassed: boolean | null = null;
    if (expectToolSuccess) {
      const result = await client.callTool({ name: "list_spaces", arguments: {} }, undefined, {
        timeout: 10000,
      });
      assert.notEqual(result.isError, true);
      toolPassed = true;
    }
    const logs = stderr.join("");
    for (const secret of [key, replacementKey, signer, encodedBundle])
      assert(!logs.includes(secret));
    return { initialized: true, toolPassed, logs };
  } finally {
    await client.close();
  }
}

function checkCleanup(home: string, configPath: string) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const cleaned = readEntry(configPath);
  assert.equal(cleaned.args.at(-1), "-");
  assert(!JSON.stringify(config).includes(encodedBundle));
  for (const [name, entry] of Object.entries(fixture.mcpServers))
    assert.deepEqual(config.mcpServers[name], entry);
  assert.equal(config.fixtureNote, fixture.fixtureNote);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o640);
  const saved = readSaved(home);
  assert.equal(saved.apiKey, key);
  assert.equal(saved.servicePrivateKey, signer);
  assert.equal(saved.baseUrl, baseUrl);
  assert.equal(saved.webAccountAddress, bundle.webAccountAddress);
  assert.equal(saved.keyAdminAddress, bundle.keyAdminAddress);
  assert.equal(
    fs.statSync(path.join(home, ".config/walrus-console-mcp/config.json")).mode & 0o777,
    0o600,
  );
  return cleaned;
}

const results: Record<string, unknown>[] = [];
try {
  for (const symlink of [false, true]) {
    const home = path.join(scratch, symlink ? "symlink" : "regular");
    fs.mkdirSync(home);
    requests = [];
    const { configPath, target } = writeCursor(home, createEntry(home), symlink);
    const first = await start(home, readEntry(configPath));
    const cleaned = checkCleanup(home, configPath);
    assert(first.logs.includes("saved the credential bundle"));
    assert(first.logs.includes("removed the credential bundle"));
    const beforeRestart = fs.readFileSync(
      path.join(home, ".config/walrus-console-mcp/config.json"),
      "utf8",
    );
    const restarted = await start(home, cleaned);
    assert(!restarted.logs.includes("saved the credential bundle"));
    assert.equal(
      fs.readFileSync(path.join(home, ".config/walrus-console-mcp/config.json"), "utf8"),
      beforeRestart,
    );
    assert.equal(requests.length, 3); // first probe, first tool, restart tool
    assert(requests.every((request) => request.credential === "bundle"));
    const keptSymlink = fs.lstatSync(configPath).isSymbolicLink();
    const backingTargetCleaned = !fs.readFileSync(target, "utf8").includes(encodedBundle);
    assert.equal(keptSymlink, symlink && !legacySymlink);
    assert.equal(backingTargetCleaned, !symlink || !legacySymlink);
    assert.equal(fs.statSync(target).mode & 0o777, 0o640);
    results.push({
      scenario: symlink ? "symlink-global" : "regular-global",
      firstInitialized: first.initialized,
      restartInitialized: restarted.initialized,
      toolsWorked: first.toolPassed && restarted.toolPassed,
      savedCredentialsAndPins: true,
      visibleEntryCleaned: true,
      otherEntriesAndModePreserved: true,
      keptSymlink,
      backingTargetCleaned,
      loopbackRequests: requests.length,
    });
  }

  const deferredHome = path.join(scratch, "deferred");
  fs.mkdirSync(deferredHome);
  requests = [];
  const deferredPath = writeCursor(deferredHome, createEntry(deferredHome)).configPath;
  fixtureStatus = 503;
  const deferred = await start(deferredHome, readEntry(deferredPath), false);
  assert(deferred.logs.includes("could not import the credential bundle yet"));
  assert.equal(readEntry(deferredPath).args.at(-1), encodedBundle);
  assert(!fs.existsSync(path.join(deferredHome, ".config/walrus-console-mcp/config.json")));
  fixtureStatus = 200;
  const recovered = await start(deferredHome, readEntry(deferredPath));
  const recoveredEntry = checkCleanup(deferredHome, deferredPath);
  const recoveredRestart = await start(deferredHome, recoveredEntry);
  assert.equal(requests.length, 4); // outage probe, retry probe + tool, restart tool
  results.push({
    scenario: "503-then-retry",
    deferredInitialized: deferred.initialized,
    preservedBundleForRetry: true,
    noDeferredCredentialWrite: true,
    retryImported: recovered.toolPassed,
    restartToolWorked: recoveredRestart.toolPassed,
    loopbackRequests: requests.length,
  });

  const keptHome = path.join(scratch, "kept-existing");
  fs.mkdirSync(keptHome);
  requests = [];
  const keptPath = writeCursor(keptHome, createEntry(keptHome)).configPath;
  const savedPath = path.join(keptHome, ".config/walrus-console-mcp/config.json");
  fs.mkdirSync(path.dirname(savedPath), { recursive: true });
  const savedBefore = JSON.stringify({
    apiKey: replacementKey,
    servicePrivateKey: signer,
    baseUrl,
  });
  fs.writeFileSync(savedPath, savedBefore, { mode: 0o600 });
  const kept = await start(keptHome, readEntry(keptPath));
  assert(kept.logs.includes("an install link never replaces a saved key"));
  assert.equal(fs.readFileSync(savedPath, "utf8"), savedBefore);
  assert.equal(readEntry(keptPath).args.at(-1), "-");
  const keptRestart = await start(keptHome, readEntry(keptPath));
  assert.equal(requests.length, 2); // tools only; bundle is never probed
  assert(requests.every((request) => request.credential === "existing"));
  results.push({
    scenario: "different-saved-key",
    initialized: kept.initialized,
    restartToolWorked: keptRestart.toolPassed,
    existingConfigBytePreserved: true,
    discardedBundleCleaned: true,
    noBundleProbe: true,
    loopbackRequests: requests.length,
  });

  process.stdout.write(
    JSON.stringify(
      { sourceRoot, launch: sourceCli ? "source-cli" : "built-dist", results },
      null,
      2,
    ) + "\n",
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    api.close((error) => (error ? reject(error) : resolve())),
  );
  fs.rmSync(scratch, { recursive: true, force: true });
}
