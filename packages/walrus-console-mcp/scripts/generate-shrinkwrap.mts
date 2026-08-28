/**
 * Regenerate npm-shrinkwrap.json from package.json's own dependency ranges,
 * resolved by npm against the live registry — independent of the pnpm
 * workspace this repo otherwise uses for local development.
 *
 * Run after any `dependencies` change and commit the result:
 *   pnpm shrinkwrap:generate
 *
 * Uses a throwaway directory rather than running npm in place: this repo's
 * own node_modules is a pnpm-managed symlink forest, so running `npm install`
 * against it directly would fight pnpm's link layout instead of producing
 * the fresh-resolution tree npm computes for an end user's `npm install <spec>`.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "walrus-console-mcp-shrinkwrap-"));

try {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
  };
  writeFileSync(
    path.join(tmp, "package.json"),
    JSON.stringify({ name: pkg.name, version: pkg.version, dependencies: pkg.dependencies ?? {} }),
  );

  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
    cwd: tmp,
    stdio: "inherit",
  });
  execFileSync("npm", ["shrinkwrap"], { cwd: tmp, stdio: "inherit" });

  cpSync(path.join(tmp, "npm-shrinkwrap.json"), path.join(ROOT, "npm-shrinkwrap.json"));
  console.log(`npm-shrinkwrap.json regenerated at ${path.join(ROOT, "npm-shrinkwrap.json")}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
