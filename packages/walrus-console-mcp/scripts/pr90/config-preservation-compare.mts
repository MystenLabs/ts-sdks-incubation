import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Differential probe at the registry and cleanup boundaries. Only disposable
// files and an inert marker; no API calls or access to the user's config.
const root = fileURLToPath(new URL("../../", import.meta.url));
const baseline = process.argv[2];
assert(baseline && path.isAbsolute(baseline), "Supply an absolute pre-fix checkout path");
const fixtureDir = path.join(root, "tests/fixtures/pr90");
const cases = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, "config-preservation-cases.json"), "utf8"),
) as {
  registration: {
    name: string;
    policy: string;
    raw?: string;
    fixture?: boolean;
    symlink?: boolean;
  }[];
  cleanup: string[];
};
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pr90-config-compare-"));
const marker = "fixture-only-bundle-marker";
const launcher = "/fixture/walrus-console-mcp";
const env = (home: string, sourceRoot: string) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("CONSOLE_") && key !== "NODE_OPTIONS",
    ),
  ),
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  APPDATA: path.join(home, ".config"),
  PR90_TEST_SOURCE_ROOT: sourceRoot,
});
const cleanupSource = `
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { stripBundleFromCursorConfig } = await import(pathToFileURL(join(process.argv[1], "src/cursorEntry.ts")).href);
console.log(JSON.stringify(stripBundleFromCursorConfig(process.argv[2], "fixture-only-bundle-marker")));
`;
const results: { area: string; scenario: string; intentionalChange: boolean }[] = [];

try {
  for (const id of ["cursor", "antigravity"]) {
    for (const fixture of cases.registration) {
      const observations: unknown[] = [];
      for (const [version, sourceRoot] of [
        ["before", baseline],
        ["after", root],
      ]) {
        const home = path.join(scratch, id, fixture.name, version!);
        const configPath = path.join(
          home,
          ...(id === "cursor" ? [".cursor", "mcp.json"] : [".gemini", "config", "mcp_config.json"]),
        );
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.mkdirSync(path.join(home, ".gemini/config"), { recursive: true });
        fs.writeFileSync(path.join(home, ".gemini/config/.migrated"), "");
        const raw = fixture.fixture
          ? fs.readFileSync(path.join(fixtureDir, `${id}.json`), "utf8")
          : fixture.raw;
        const target = fixture.symlink ? path.join(home, "dotfiles.json") : configPath;
        if (raw !== undefined) fs.writeFileSync(target, raw, { mode: 0o640 });
        if (fixture.symlink)
          fs.symlinkSync(path.relative(path.dirname(configPath), target), configPath);
        const run = () => {
          const output = execFileSync(
            process.execPath,
            ["--import", "tsx", path.join(fixtureDir, "register-path.mts"), id, "direct", launcher],
            { cwd: root, env: env(home, sourceRoot!), encoding: "utf8", timeout: 15000 },
          );
          const line = output.split("\n").find((line) => line.startsWith("PR90_RESULT="));
          assert(line);
          return JSON.parse(line.slice("PR90_RESULT=".length));
        };
        const outcome = run();
        const refuses =
          fixture.policy === "refuse" || (fixture.policy === "non-object" && version === "after");
        if (refuses) {
          assert.equal(
            typeof outcome.error,
            "string",
            `${id}/${fixture.name}/${version} must refuse`,
          );
          assert.equal(fs.readFileSync(target, "utf8"), raw);
          if (fixture.policy === "non-object")
            assert.match(outcome.error, /top-level.*not an object/);
        } else {
          assert.equal(outcome.error, undefined, `${id}/${fixture.name}/${version}`);
          const before =
            fixture.policy === "non-object" || raw === undefined ? {} : JSON.parse(raw);
          assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), {
            ...before,
            mcpServers: {
              ...before.mcpServers,
              "walrus-console-mcp": { command: launcher, args: [] },
            },
          });
          const once = fs.readFileSync(target, "utf8");
          assert.equal(run().error, undefined);
          assert.equal(fs.readFileSync(target, "utf8"), once, "registration must be idempotent");
        }
        if (raw !== undefined) assert.equal(fs.statSync(target).mode & 0o777, 0o640);
        if (fixture.symlink) assert(fs.lstatSync(configPath).isSymbolicLink());
        observations.push({ refused: refuses, text: fs.readFileSync(target, "utf8") });
      }
      const intentionalChange = fixture.policy === "non-object";
      if (!intentionalChange)
        assert.deepEqual(
          observations[0],
          observations[1],
          `${id}/${fixture.name} changed unexpectedly`,
        );
      results.push({ area: `${id}-registration`, scenario: fixture.name, intentionalChange });
    }
  }

  for (const scenario of cases.cleanup) {
    const observations: unknown[] = [];
    for (const [version, sourceRoot] of [
      ["before", baseline],
      ["after", root],
    ]) {
      const home = path.join(scratch, "cleanup", scenario, version!);
      const configPath = path.join(home, ".cursor/mcp.json");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const linked = ["absolute", "relative", "chain", "directory", "dangling"].includes(scenario);
      const target = linked ? path.join(home, "dotfiles/mcp.json") : configPath;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const entry = {
        command: "/fixture/server",
        args: [
          "--import-bundle",
          scenario === "already-cleaned" ? "-" : scenario === "not-found" ? "other-marker" : marker,
        ],
      };
      const seeded = {
        keep: true,
        mcpServers: { other: { command: "node", args: [] }, fixture: entry },
      };
      const raw =
        scenario === "non-object"
          ? "null\n"
          : scenario === "invalid-json"
            ? "{ unfinished"
            : JSON.stringify(seeded);
      if (!["missing", "dangling", "non-regular"].includes(scenario))
        fs.writeFileSync(target, raw, { mode: 0o640 });
      if (scenario === "non-regular") fs.mkdirSync(configPath);
      let linkPath = configPath;
      let destination = target;
      if (scenario === "relative") destination = path.relative(path.dirname(configPath), target);
      if (scenario === "chain") {
        destination = path.join(home, "intermediate.json");
        fs.symlinkSync(target, destination);
      }
      if (scenario === "directory") {
        fs.rmdirSync(path.dirname(configPath));
        linkPath = path.dirname(configPath);
        destination = path.dirname(target);
      }
      if (linked) fs.symlinkSync(destination, linkPath);
      const outcome = JSON.parse(
        execFileSync(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", cleanupSource, sourceRoot!, configPath],
          { cwd: root, env: env(home, sourceRoot!), encoding: "utf8", timeout: 15000 },
        ),
      );
      if (scenario === "missing") assert.equal(outcome.kind, "missing-file");
      else if (scenario === "dangling") {
        assert.equal(outcome.kind, version === "before" ? "missing-file" : "unreadable");
        assert.equal(fs.readlinkSync(configPath), destination);
        assert(!fs.existsSync(target));
      } else if (["non-regular", "non-object", "invalid-json"].includes(scenario)) {
        assert.equal(outcome.kind, "unreadable");
        if (scenario === "non-regular") assert(fs.statSync(configPath).isDirectory());
        else assert.equal(fs.readFileSync(target, "utf8"), raw);
      } else if (["not-found", "already-cleaned"].includes(scenario)) {
        assert.deepEqual(outcome, {
          kind: "not-found",
          cleanedEntry: scenario === "already-cleaned",
        });
        assert.equal(fs.readFileSync(target, "utf8"), raw);
      } else {
        assert.deepEqual(outcome, { kind: "stripped", entries: ["fixture"], hardened: [] });
        assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
          ...seeded,
          mcpServers: {
            ...seeded.mcpServers,
            fixture: { ...entry, args: ["--import-bundle", "-"] },
          },
        });
        const legacyBreak =
          version === "before" && ["absolute", "relative", "chain"].includes(scenario);
        assert.equal(fs.readFileSync(target, "utf8").includes(marker), legacyBreak);
        if (linked) assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), !legacyBreak);
        assert.equal(fs.statSync(target).mode & 0o777, 0o640);
      }
      // Error wording may differ, but refusal and byte preservation must agree.
      observations.push({
        kind: outcome.kind,
        cleanedEntry: outcome.cleanedEntry,
        visibleText: fs.statSync(configPath, { throwIfNoEntry: false })?.isFile()
          ? fs.readFileSync(configPath, "utf8")
          : null,
      });
    }
    const intentionalChange = ["absolute", "relative", "chain", "dangling"].includes(scenario);
    if (!intentionalChange)
      assert.deepEqual(
        observations[0],
        observations[1],
        `cleanup/${scenario} changed unexpectedly`,
      );
    results.push({ area: "cursor-cleanup", scenario, intentionalChange });
  }
  console.log(
    JSON.stringify(
      {
        passed: true,
        scenarios: results.length,
        sourceRuns: results.length * 2,
        intentionalChanges: results.filter((result) => result.intentionalChange),
        unchangedScenarios: results.filter((result) => !result.intentionalChange).length,
        unexpectedDifferences: 0,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
