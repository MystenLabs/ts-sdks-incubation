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

/**
 * Exact versions of the ENTIRE runtime closure as the pnpm workspace resolved
 * it — the graph the tests actually ran against. Fed to npm as `overrides`:
 * without this, npm re-resolves every transitive from its registry range, so
 * any transitive (Noble, jose, `@mysten/bcs`, …) can drift to a newer
 * in-range version the tests never exercised, even while every direct dep is
 * pinned.
 *
 * A name the workspace resolves to MORE than one version (different majors
 * required by different parents) cannot be expressed as a flat npm override;
 * those are skipped with a warning and left to npm's per-range resolution —
 * check-shrinkwrap.mts still verifies the outcome landed inside the
 * workspace's version set.
 */
function workspaceRuntimeClosure(): Record<string, string> {
  const out = execFileSync("pnpm", ["list", "--prod", "--depth", "Infinity", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  interface ListedDep {
    version?: string;
    dependencies?: Record<string, ListedDep>;
  }
  const [top] = JSON.parse(out) as { dependencies?: Record<string, ListedDep> }[];
  const versions = new Map<string, Set<string>>();
  const walk = (deps: Record<string, ListedDep> | undefined): void => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      if (typeof info.version === "string") {
        let set = versions.get(name);
        if (set === undefined) versions.set(name, (set = new Set()));
        set.add(info.version);
      }
      walk(info.dependencies);
    }
  };
  walk(top?.dependencies);
  const pinned: Record<string, string> = {};
  for (const [name, set] of versions) {
    if (set.size === 1) {
      pinned[name] = [...set][0]!;
    } else {
      console.warn(
        `not overriding ${name}: workspace resolves it to ${[...set].sort().join(" and ")} ` +
          `(per-parent majors) — left to npm's per-range resolution`,
      );
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
  const overrides = workspaceRuntimeClosure();
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
