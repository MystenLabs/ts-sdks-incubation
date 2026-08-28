/**
 * Supply-chain pinning guard: fails if npm-shrinkwrap.json is missing, or no
 * longer agrees with package.json's `dependencies` ranges.
 *
 * Regenerate with `pnpm shrinkwrap:generate` after any `dependencies` change,
 * and commit the result.
 */
import { readFileSync } from "node:fs";
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

if (failures.length > 0) {
  console.error(
    `\ncheck:shrinkwrap failed\n\n${failures.join("\n\n")}\n\n` +
      `  Regenerate with \`pnpm shrinkwrap:generate\` and commit the result.\n`,
  );
  process.exit(1);
}

console.log(
  `check:shrinkwrap passed — npm-shrinkwrap.json agrees with package.json's dependencies`,
);
