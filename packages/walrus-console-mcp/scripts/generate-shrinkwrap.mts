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
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/**
 * Exact versions of every TRANSITIVE `@mysten/*` package the workspace
 * resolved for our direct deps, gathered from the pnpm store next to each
 * direct dep's real location. Fed to npm as `overrides`: without this, npm
 * re-resolves transitives from the registry ranges, so a first-party
 * transitive (e.g. `@mysten/bcs`) can drift to a version the tests never ran
 * against even while every direct dep is pinned.
 */
function workspaceMystenTransitives(directDeps: string[]): Record<string, string> {
  const pinned: Record<string, string> = {};
  for (const dep of directDeps) {
    const real = realpathSync(path.join(ROOT, "node_modules", dep));
    // .pnpm/<pkg>@<v>/node_modules/<pkg> — siblings are its resolved deps.
    const siblings = path.join(real, "..", "..");
    const mysten = path.join(siblings, "@mysten");
    let entries: string[];
    try {
      entries = readdirSync(mysten);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = `@mysten/${name}`;
      if (full === dep) continue;
      const { version } = JSON.parse(
        readFileSync(path.join(mysten, name, "package.json"), "utf8"),
      ) as { version?: string };
      if (typeof version !== "string") continue;
      const prior = pinned[full];
      if (prior !== undefined && prior !== version) {
        throw new Error(
          `workspace resolves ${full} to both ${prior} and ${version} — align the workspace first`,
        );
      }
      pinned[full] = version;
    }
  }
  return pinned;
}
const tmp = mkdtempSync(path.join(os.tmpdir(), "walrus-console-mcp-shrinkwrap-"));

try {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
  };
  const directDeps = Object.keys(pkg.dependencies ?? {});
  const dependencies = Object.fromEntries(directDeps.map((name) => [name, installedVersion(name)]));
  const overrides = workspaceMystenTransitives(directDeps);
  writeFileSync(
    path.join(tmp, "package.json"),
    JSON.stringify({ name: pkg.name, version: pkg.version, dependencies, overrides }),
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
