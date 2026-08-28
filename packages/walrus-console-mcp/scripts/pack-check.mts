/**
 * Packaging guard.
 *
 * `dist/` is gitignored and `bin` is a hand-maintained string, so nothing else
 * in this repo proves the package npm would publish can actually start. That is
 * a real failure class here, not a hypothetical: the installer once registered
 * an unscoped package name that resolved to nothing, so every generated agent
 * config pointed at a spec that could not launch. A package that installs
 * cleanly and cannot run looks healthy from every angle except the only one
 * that matters.
 *
 * Uses `npm pack --dry-run --json`, which reports the exact file list npm would
 * publish without writing a tarball or shelling out to `tar`. Paths come back
 * unprefixed (`LICENSE`, `dist/console-mcp.js`) — there is no `package/`
 * prefix to strip.
 *
 * Requires `pnpm build` to have run first, so it is the last step in CI.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * The top-level entries the tarball is expected to contain.
 *
 * Deliberately hardcoded rather than derived from `files` in package.json.
 * Deriving it would make the assertion tautological — it would agree with
 * whatever `files` happens to say, including a mistake. Hardcoding means a
 * legitimate change to the published set has to be made here too, as a
 * deliberate act. `package.json` is always included by npm regardless of
 * `files`, so it belongs in this list.
 */
const EXPECTED_TOP_LEVEL = ["LICENSE", "README.md", "dist", "npm-shrinkwrap.json", "package.json"];

interface PackFile {
  readonly path: string;
}

interface PackReport {
  readonly files: readonly PackFile[];
}

/**
 * Parse npm's `--json` stdout.
 *
 * npm routes notices to stderr under `--json`, but that is a behaviour worth
 * tolerating rather than trusting: if anything non-JSON leads the stream, parse
 * from the first `[` instead of failing on it.
 */
function parsePackReport(stdout: string): PackReport[] {
  try {
    return JSON.parse(stdout) as PackReport[];
  } catch {
    const start = stdout.indexOf("[");
    if (start === -1) {
      throw new Error(`npm pack --json produced no JSON array:\n${stdout}`);
    }
    return JSON.parse(stdout.slice(start)) as PackReport[];
  }
}

function packedPaths(): string[] {
  // --ignore-scripts: `npm pack` would otherwise run the `prepare` lifecycle,
  // which this check does not need — `dist/` is built by the preceding step —
  // and which only adds a way for the guard to fail for unrelated reasons.
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [report] = parsePackReport(stdout);
  if (report === undefined) {
    throw new Error("npm pack --json reported no package");
  }
  return report.files.map((file) => file.path);
}

/** `bin` is either a bare string or a map of command name to path. */
function binTargets(bin: unknown): string[] {
  if (typeof bin === "string") return [bin];
  if (typeof bin === "object" && bin !== null) {
    return Object.values(bin as Record<string, string>);
  }
  return [];
}

/**
 * Strip a leading `./`. Both `./dist/x.js` and `dist/x.js` are valid in `bin`
 * and mean the same file, while npm reports the packed path in only one of
 * those forms — so the comparison has to be made on a normalised path.
 */
function normalise(p: string): string {
  return p.replace(/^\.\//, "");
}

const failures: string[] = [];

const paths = packedPaths();
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  bin?: unknown;
};

// 1. The published file set is what we expect it to be.
const topLevel = [...new Set(paths.map((p) => p.split("/")[0]))].sort();
const expected = [...EXPECTED_TOP_LEVEL].sort();
if (topLevel.join() !== expected.join()) {
  failures.push(
    `Published top-level entries changed.\n` +
      `  expected: ${expected.join(", ")}\n` +
      `  actual:   ${topLevel.join(", ")}\n` +
      `  If this change is intended, update EXPECTED_TOP_LEVEL in this script.`,
  );
}

// 2. Every `bin` target actually ships. This is the one that catches a package
//    that installs and then cannot start.
const packed = new Set(paths.map(normalise));
for (const target of binTargets(pkg.bin)) {
  if (!packed.has(normalise(target))) {
    failures.push(
      `bin target "${target}" is not in the published files.\n` +
        `  Installing this package would produce a command that cannot start.\n` +
        `  Check the "bin" path, the "files" list, and that the build ran.`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\npack:check failed\n\n${failures.join("\n\n")}\n`);
  process.exit(1);
}

console.log(`pack:check passed — ${paths.length} files, bin target ships`);
