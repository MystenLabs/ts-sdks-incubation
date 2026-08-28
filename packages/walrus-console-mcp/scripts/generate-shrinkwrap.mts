/**
 * Regenerate npm-shrinkwrap.json with every direct dependency pinned to the
 * exact version the pnpm workspace has installed under node_modules, and the
 * transitive graph resolved by npm against the live registry.
 *
 * Direct deps are pinned rather than re-resolved from package.json's ranges so
 * the graph an end user gets from `npm install <spec>` (which honours the
 * shipped shrinkwrap) is the graph this repo's tests actually ran against. A
 * range-only resolution can drift to newer minors than the workspace lockfile
 * pins; check-shrinkwrap.mts fails on that drift.
 *
 * Run after any `dependencies` change (and after `pnpm install` moves a direct
 * dep) and commit the result:
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

/** Exact version of `name` as installed in this package's node_modules. */
function installedVersion(name: string): string {
  const manifest = path.join(ROOT, "node_modules", name, "package.json");
  const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version?: string };
  if (typeof version !== "string") {
    throw new Error(`${manifest} has no version — run \`pnpm install\` first`);
  }
  return version;
}
const tmp = mkdtempSync(path.join(os.tmpdir(), "walrus-console-mcp-shrinkwrap-"));

try {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
  };
  const dependencies = Object.fromEntries(
    Object.keys(pkg.dependencies ?? {}).map((name) => [name, installedVersion(name)]),
  );
  writeFileSync(
    path.join(tmp, "package.json"),
    JSON.stringify({ name: pkg.name, version: pkg.version, dependencies }),
  );

  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
    cwd: tmp,
    stdio: "inherit",
  });
  execFileSync("npm", ["shrinkwrap"], { cwd: tmp, stdio: "inherit" });

  const out = path.join(ROOT, "npm-shrinkwrap.json");
  cpSync(path.join(tmp, "npm-shrinkwrap.json"), out);
  // npm's own JSON layout does not match this repo's prettier config; format
  // it so `pnpm lint` stays green and regenerations diff cleanly.
  execFileSync("pnpm", ["exec", "prettier", "-w", out], { cwd: ROOT, stdio: "inherit" });
  console.log(`npm-shrinkwrap.json regenerated at ${path.join(ROOT, "npm-shrinkwrap.json")}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
