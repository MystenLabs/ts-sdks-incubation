import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IMPORTED_BUNDLE_PLACEHOLDER,
  SAFE_NPX_PREFIX_ARG,
  stripBundleFromConfig,
} from "../src/cursorEntry.js";

/**
 * The prefix rewrite is only worth anything if real npm honours it, so this
 * runs the rewritten args through the real `npx` instead of asserting on their
 * shape. A package of the fixture's name is planted in the workspace's
 * `node_modules`; its bin leaves a marker when it runs. `--offline` keeps npm
 * away from the registry: with a safe prefix the fixture name cannot resolve
 * at all, so npx fails, which is the expected outcome, and with an unsafe one
 * npx finds the planted copy and runs it.
 */

const FIXTURE = "@walrus-console-mcp-test/shadow-fixture";
const BUNDLE = "eyJ2IjoxfQ";

let root: string;
let workspace: string;
let home: string;
let marker: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-npx-guard-"));
  workspace = path.join(root, "workspace");
  home = path.join(root, "home");
  marker = path.join(root, "FIXTURE_RAN");
  const pkg = path.join(workspace, "node_modules", ...FIXTURE.split("/"));
  fs.mkdirSync(pkg, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(workspace, "package.json"), '{"name":"ws","version":"1.0.0"}');
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: FIXTURE, version: "1.0.0", bin: { "shadow-fixture": "bin.js" } }),
  );
  fs.writeFileSync(
    path.join(pkg, "bin.js"),
    `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
  );
  // npm links bins on install; a hand-planted package needs its own shim.
  const bin = path.join(workspace, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  const target = path.join(pkg, "bin.js");
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "shadow-fixture.cmd"), `@node "${target}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, "shadow-fixture"), `#!/bin/sh\nexec node "${target}" "$@"\n`);
    fs.chmodSync(path.join(bin, "shadow-fixture"), 0o755);
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Run `npx` with `args` from the workspace; report whether the fixture ran. */
function fixtureRuns(args: readonly string[]): boolean {
  fs.rmSync(marker, { force: true });
  // Cursor expands `${userHome}`; stand in for it with a directory outside the workspace.
  const expanded = args.map((arg) => arg.replace("${userHome}", home));
  const win = process.platform === "win32";
  // An inherited prefix setting would decide the outcome instead of the args.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "npm_config_prefix"),
  );
  spawnSync(win ? "npx.cmd" : "npx", win ? expanded.map((a) => `"${a}"`) : expanded, {
    cwd: workspace,
    env,
    shell: win,
    stdio: "ignore",
    timeout: 60_000,
  });
  return fs.existsSync(marker);
}

/** The args the strip leaves for an npx entry launched with `before`. */
function hardened(before: readonly string[]): string[] {
  const args = [...before, "--offline", "-y", FIXTURE, "--import-bundle", BUNDLE];
  const result = stripBundleFromConfig({ mcpServers: { w: { command: "npx", args } } }, BUNDLE);
  const servers = result?.config["mcpServers"] as Record<string, { args: string[] }>;
  const out = servers["w"]?.args ?? [];
  expect(out.at(-1)).toBe(IMPORTED_BUNDLE_PLACEHOLDER);
  return out;
}

describe("the npx prefix rewrite, run through real npx", () => {
  it("control: the planted package runs when nothing stops npx resolving it", () => {
    expect(fixtureRuns(["--offline", "-y", FIXTURE])).toBe(true);
  }, 90_000);

  it.each([
    ["no prefix", []],
    ["a prefix naming the workspace", ["--prefix=."]],
    ["the -C shorthand", ["-C", "."]],
    ["an abbreviation npm expands", ["--prefi=."]],
    ["a safe prefix then an unsafe one", [SAFE_NPX_PREFIX_ARG, "--prefix=."]],
    ["npm's negated form", ["--no-prefix"]],
    ["a negation after a safe prefix", [SAFE_NPX_PREFIX_ARG, "--no-prefix"]],
  ])(
    "never runs the workspace package after rewriting %s",
    (_label, before) => {
      expect(fixtureRuns(hardened(before))).toBe(false);
    },
    90_000,
  );
});
