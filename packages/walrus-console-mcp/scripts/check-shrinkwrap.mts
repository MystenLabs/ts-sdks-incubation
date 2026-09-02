/**
 * Supply-chain pinning guard: fails if npm-shrinkwrap.json is missing, no
 * longer agrees with package.json's `dependencies` ranges, pins a direct
 * dependency to a different version than the one installed under node_modules
 * (i.e. the one the workspace lockfile resolved and the tests ran against),
 * or ships ANY package — transitives included — at a version the workspace's
 * resolved runtime closure does not contain. The shipped graph must be the
 * graph the tests ran against, all the way down.
 *
 * Regenerate with `pnpm shrinkwrap:generate` after any `dependencies` change,
 * and commit the result.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { findStaleDependencies } from "./shrinkwrapStaleness.mjs";

interface ShrinkwrapPackage {
  readonly version?: string;
}
interface Shrinkwrap {
  readonly packages?: Readonly<Record<string, ShrinkwrapPackage>>;
}

/** Direct dependencies live at `packages["node_modules/<name>"]` with no further nesting. */
function directDependencyVersions(shrinkwrap: Shrinkwrap): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const [key, value] of Object.entries(shrinkwrap.packages ?? {})) {
    const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
    if (match && typeof value.version === "string") {
      versions[match[1]!] = value.version;
    }
  }
  return versions;
}

const failures: string[] = [];

let shrinkwrap: Shrinkwrap;
try {
  shrinkwrap = JSON.parse(readFileSync("npm-shrinkwrap.json", "utf8")) as Shrinkwrap;
} catch (err) {
  console.error(
    `\ncheck:shrinkwrap failed\n\n` +
      `npm-shrinkwrap.json is missing or unreadable (${
        err instanceof Error ? err.message : String(err)
      }).\n` +
      `  Generate it with \`pnpm shrinkwrap:generate\` and commit the result.\n`,
  );
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies?: Record<string, string>;
};

const { missing, outOfRange } = findStaleDependencies(
  pkg.dependencies ?? {},
  directDependencyVersions(shrinkwrap),
);

if (missing.length > 0) {
  failures.push(
    `npm-shrinkwrap.json does not pin: ${missing.join(", ")}.\n` +
      `  package.json declares these as dependencies but the shrinkwrap has no entry for them.`,
  );
}
if (outOfRange.length > 0) {
  failures.push(
    outOfRange
      .map(
        (d) =>
          `npm-shrinkwrap.json pins ${d.name}@${d.pinned}, which does not satisfy package.json's ${d.range}.`,
      )
      .join("\n"),
  );
}

const pinned = directDependencyVersions(shrinkwrap);
const drifted: string[] = [];
for (const name of Object.keys(pkg.dependencies ?? {})) {
  const manifest = path.join("node_modules", name, "package.json");
  if (!existsSync(manifest)) continue; // not installed here; the range check above still applies
  const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version?: string };
  if (typeof version === "string" && pinned[name] !== undefined && pinned[name] !== version) {
    drifted.push(`${name}: shrinkwrap pins ${pinned[name]}, node_modules has ${version}`);
  }
}
if (drifted.length > 0) {
  failures.push(
    `npm-shrinkwrap.json pins direct dependencies to versions other than the installed ones:\n  ` +
      drifted.join("\n  ") +
      `\n  The shipped graph must be the graph the tests ran against.`,
  );
}

// THE FULL-GRAPH CHECK. Every package the shrinkwrap ships, at any nesting
// depth, must carry a version the workspace's resolved runtime closure
// contains — a transitive the registry moved to a newer in-range version is
// exactly the drift this guard exists to catch.
function workspaceClosureVersions(): Map<string, Set<string>> {
  const out = execFileSync("pnpm", ["list", "--prod", "--depth", "Infinity", "--json"], {
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
  return versions;
}

const closure = workspaceClosureVersions();
const graphDrift: string[] = [];
for (const [key, value] of Object.entries(shrinkwrap.packages ?? {})) {
  if (key === "" || typeof value.version !== "string") continue;
  const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  const tested = closure.get(name);
  // A name absent from the pnpm closure is npm-only graph shape (e.g. a
  // platform-specific optional package pnpm skipped on this host) — the
  // version-drift guard has nothing to compare it against.
  if (tested === undefined) continue;
  if (!tested.has(value.version)) {
    graphDrift.push(
      `${name}: shrinkwrap ships ${value.version}, workspace tested ${[...tested].sort().join(", ")}`,
    );
  }
}
if (graphDrift.length > 0) {
  failures.push(
    `npm-shrinkwrap.json ships packages at versions the tested workspace graph does not contain:\n  ` +
      graphDrift.join("\n  ") +
      `\n  The shipped graph must be the graph the tests ran against — transitives included.`,
  );
}

if (failures.length > 0) {
  console.error(
    `\ncheck:shrinkwrap failed\n\n${failures.join("\n\n")}\n\n` +
      `  Regenerate with \`pnpm shrinkwrap:generate\` and commit the result.\n`,
  );
  process.exit(1);
}

console.log(
  `check:shrinkwrap passed — npm-shrinkwrap.json matches package.json and the tested runtime graph`,
);
