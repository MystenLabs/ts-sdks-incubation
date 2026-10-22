import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [mode, expectedVersion] = process.argv.slice(2);
assert.ok(mode === "accept" || mode === "reject", "Specify accept or reject");
assert.equal(process.versions.node, expectedVersion, "The requested runtime must actually run");

const configHome = mkdtempSync(join(tmpdir(), "walrus-runtime-check-"));
try {
  for (const args of [[], ["--help"], ["install", "--help"], ["config", "--help"]]) {
    const result = spawnSync(process.execPath, ["dist/console-mcp.js", ...args], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, XDG_CONFIG_HOME: configHome, APPDATA: configHome },
      input:
        args.length === 0 && mode === "accept"
          ? JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "runtime-check", version: "1.0.0" },
              },
            }) + "\n"
          : "",
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    if (mode === "reject") {
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "", "Refusal must not corrupt MCP stdout");
      assert.match(result.stderr, /needs a supported patched Node version/);
      assert.ok(result.stderr.includes(expectedVersion));
      for (const floor of ["22.23.4", "24.22.1", "26.12.1"]) {
        assert.ok(result.stderr.includes(floor));
      }
      assert.doesNotMatch(result.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND|styleText/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      if (args.length === 0) {
        const response = JSON.parse(result.stdout.trim());
        assert.equal(response.id, 1);
        assert.equal(response.result.serverInfo.name, "console-mcp");
      } else {
        assert.match(result.stdout, /Usage/i);
      }
    }
  }
} finally {
  rmSync(configHome, { recursive: true, force: true });
}
console.log(`Node ${expectedVersion} ${mode} checks passed`);
