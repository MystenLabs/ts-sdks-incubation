import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_DIRS_ENV,
  allowedDirsFromConfig,
  allowedDirsFromEnv,
  isWithinRoots,
  type RootsCapableServer,
  resolvePathWithinRoots,
  rootsToDirs,
  readFileWithinRoot,
  splitAllowedDirList,
  toRealPath,
  validateAllowedDirectory,
} from "../src/pathSandbox";

/** Empty env so tests never pick up a developer's real CONSOLE_MCP_ALLOWED_DIRS. */
const NO_ENV: NodeJS.ProcessEnv = {};

/** Fake MCP server advertising a fixed set of roots (or none). */
function fakeServer(rootDirs: readonly string[] | null): RootsCapableServer {
  return {
    getClientCapabilities: () => (rootDirs === null ? {} : { roots: {} }),
    listRoots: async () => ({
      roots: (rootDirs ?? []).map((dir) => ({ uri: pathToFileURL(dir).href })),
    }),
  };
}

/** Fake server that advertises roots support but fails when asked to list them. */
function fakeServerListRootsThrows(): RootsCapableServer {
  return {
    getClientCapabilities: () => ({ roots: {} }),
    listRoots: async () => {
      throw new Error("client boom");
    },
  };
}

describe("isWithinRoots", () => {
  const root = join("/srv", "data");

  it("allows a file directly inside a root", () => {
    expect(isWithinRoots(join(root, "report.pdf"), [root])).toBe(true);
  });

  it("allows a file in a nested subdirectory", () => {
    expect(isWithinRoots(join(root, "2026", "q1", "report.pdf"), [root])).toBe(true);
  });

  it("allows the root path itself", () => {
    expect(isWithinRoots(root, [root])).toBe(true);
  });

  it("rejects a path outside every root", () => {
    expect(isWithinRoots(join("/etc", "passwd"), [root])).toBe(false);
  });

  it("rejects a sibling sharing a name prefix (no separator boundary)", () => {
    expect(isWithinRoots(`${root}-evil/secret`, [root])).toBe(false);
  });

  it("rejects parent-traversal that escapes the root", () => {
    expect(isWithinRoots(join(root, "..", "other", "x"), [root])).toBe(false);
  });

  it("allows when the candidate is within any one of several roots", () => {
    const roots = [join("/srv", "a"), join("/srv", "b")];
    expect(isWithinRoots(join("/srv", "b", "file"), roots)).toBe(true);
  });

  it("returns false for an empty root list", () => {
    expect(isWithinRoots(join(root, "x"), [])).toBe(false);
  });
});

describe("rootsToDirs", () => {
  it("converts file:// URIs to absolute paths", () => {
    const dir = join("/srv", "data");
    const dirs = rootsToDirs([{ uri: pathToFileURL(dir).href }]);
    expect(dirs).toEqual([dir]);
  });

  it("skips non-file URI schemes", () => {
    const dir = join("/srv", "data");
    const dirs = rootsToDirs([{ uri: "https://example.com/x" }, { uri: pathToFileURL(dir).href }]);
    expect(dirs).toEqual([dir]);
  });

  it("returns an empty list when no roots are file URIs", () => {
    expect(rootsToDirs([{ uri: "https://example.com" }])).toEqual([]);
  });
});

describe("splitAllowedDirList", () => {
  it("splits on the supplied delimiter and drops blanks", () => {
    expect(splitAllowedDirList("a;;b;  ;c", ";")).toEqual(["a", "b", "c"]);
  });

  it("does not split a Windows drive-letter path on ':'", () => {
    // Production on win32 uses path.delimiter === ';'. Passing ';' here so the
    // assertion holds on POSIX CI too: C:\… must stay one entry.
    expect(splitAllowedDirList("C:\\Users\\me\\Documents", ";")).toEqual([
      "C:\\Users\\me\\Documents",
    ]);
  });

  it("splits two Windows paths on ';'", () => {
    expect(splitAllowedDirList("C:\\Users\\me\\Documents;C:\\Users\\me\\Downloads", ";")).toEqual([
      "C:\\Users\\me\\Documents",
      "C:\\Users\\me\\Downloads",
    ]);
  });
});

describe("validateAllowedDirectory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "walrus-allowed-dir-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the canonical path of an existing directory", () => {
    const result = validateAllowedDirectory(dir);
    expect(result).toEqual({ dir: toRealPath(dir) });
  });

  it("rejects a missing path", () => {
    const result = validateAllowedDirectory(join(dir, "nope"));
    expect(result).toMatchObject({ error: expect.stringMatching(/does not exist/) });
  });

  it("rejects a file", () => {
    const file = join(dir, "file.txt");
    writeFileSync(file, "x");
    const result = validateAllowedDirectory(file);
    expect(result).toMatchObject({ error: expect.stringMatching(/not a directory/) });
  });

  it("rejects a blank path", () => {
    expect(validateAllowedDirectory("   ")).toMatchObject({
      error: expect.stringMatching(/empty/),
    });
  });
});

describe("allowedDirsFromConfig", () => {
  it("returns [] when allowedDirs is absent", () => {
    expect(allowedDirsFromConfig({})).toEqual([]);
  });

  it("expands ~ and resolves entries", () => {
    expect(allowedDirsFromConfig({ allowedDirs: ["~"] })).toEqual([homedir()]);
  });

  it("drops blank entries", () => {
    expect(allowedDirsFromConfig({ allowedDirs: ["  ", ""] })).toEqual([]);
  });
});

describe("allowedDirsFromEnv", () => {
  it("returns [] when the var is unset", () => {
    expect(allowedDirsFromEnv({})).toEqual([]);
  });

  it("returns [] for a blank / whitespace-only value", () => {
    expect(allowedDirsFromEnv({ [ALLOWED_DIRS_ENV]: "   " })).toEqual([]);
  });

  it("splits on the platform delimiter and drops blank entries", () => {
    const a = join("/srv", "a");
    const b = join("/srv", "b");
    const value = [a, "", b].join(delimiter);
    expect(allowedDirsFromEnv({ [ALLOWED_DIRS_ENV]: value })).toEqual([a, b]);
  });

  it("expands a leading ~ entry to the home directory", () => {
    expect(allowedDirsFromEnv({ [ALLOWED_DIRS_ENV]: "~" })).toEqual([homedir()]);
  });
});

describe("resolvePathWithinRoots (synthetic roots)", () => {
  const workspace = join("/home", "me", "project");

  it("anchors a relative path to the workspace root, not the server cwd", async () => {
    const out = await resolvePathWithinRoots(
      fakeServer([workspace]),
      "report.pdf",
      "Source",
      NO_ENV,
    );
    expect(out).toBe(toRealPath(join(workspace, "report.pdf")));
  });

  it("anchors a relative subdir path to the workspace root", async () => {
    const out = await resolvePathWithinRoots(
      fakeServer([workspace]),
      "docs/q1.pdf",
      "Source",
      NO_ENV,
    );
    expect(out).toBe(toRealPath(join(workspace, "docs", "q1.pdf")));
  });

  it("passes an absolute path inside the root through (canonicalized)", async () => {
    const abs = join(workspace, "a", "b.txt");
    expect(await resolvePathWithinRoots(fakeServer([workspace]), abs, "Source", NO_ENV)).toBe(
      toRealPath(abs),
    );
  });

  it("expands a leading ~ to the home directory", async () => {
    const out = await resolvePathWithinRoots(
      fakeServer([homedir()]),
      "~/notes.txt",
      "Dest",
      NO_ENV,
    );
    expect(out).toBe(toRealPath(join(homedir(), "notes.txt")));
  });

  it("rejects an absolute path outside every root", async () => {
    await expect(
      resolvePathWithinRoots(fakeServer([workspace]), "/etc/passwd", "Source", NO_ENV),
    ).rejects.toThrow(/outside the/);
  });

  it("rejects a relative path that traverses out of the workspace", async () => {
    await expect(
      resolvePathWithinRoots(fakeServer([workspace]), "../secret", "Source", NO_ENV),
    ).rejects.toThrow(/outside the/);
  });

  it("fails closed when the client does not support roots and no env fallback", async () => {
    await expect(
      resolvePathWithinRoots(fakeServer(null), join("/tmp", "anywhere.txt"), "Source", NO_ENV, []),
    ).rejects.toThrow(new RegExp(ALLOWED_DIRS_ENV));
  });

  it("fails closed when the client advertises roots support but declares none", async () => {
    await expect(
      resolvePathWithinRoots(fakeServer([]), join("/tmp", "anywhere.txt"), "Source", NO_ENV, []),
    ).rejects.toThrow(new RegExp(ALLOWED_DIRS_ENV));
  });

  it("fails closed when listRoots() errors and there is no env fallback", async () => {
    await expect(
      resolvePathWithinRoots(fakeServerListRootsThrows(), "/etc/hosts", "Source", NO_ENV, []),
    ).rejects.toThrow(new RegExp(ALLOWED_DIRS_ENV));
  });

  it("the fail-closed message names config --allowed-dirs as well as the env var", async () => {
    await expect(
      resolvePathWithinRoots(fakeServer(null), join("/tmp", "anywhere.txt"), "Source", NO_ENV, []),
    ).rejects.toThrow(/config --allowed-dirs/);
  });
});

describe("resolvePathWithinRoots (real filesystem: symlinks + env fallback)", () => {
  let base: string;
  let allowed: string;
  let outside: string;

  beforeAll(() => {
    // Canonicalize the temp base up front — os.tmpdir() is symlinked on macOS.
    base = toRealPath(mkdtempSync(join(tmpdir(), "wcm-sandbox-")));
    allowed = join(base, "allowed");
    outside = join(base, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "top secret");
    // A symlink INSIDE the allowed root that escapes it.
    symlinkSync(join(outside, "secret.txt"), join(allowed, "link-to-secret"), "file");
    symlinkSync(outside, join(allowed, "link-to-outside"), "dir");
    // DANGLING links: the target does not exist yet, so realpathSync() fails on
    // these exactly as it does on a plain nonexistent path. One escapes, one
    // does not; the sandbox must tell them apart.
    symlinkSync(join(outside, "not-created-yet.txt"), join(allowed, "dangling-out"), "file");
    symlinkSync(join(allowed, "not-created-yet.txt"), join(allowed, "dangling-in"), "file");
    // A symlink cycle — no canonical path exists at all.
    symlinkSync(join(allowed, "loop-b"), join(allowed, "loop-a"), "file");
    symlinkSync(join(allowed, "loop-a"), join(allowed, "loop-b"), "file");
    // A LIVE symlink pointing inside the root. Guards the boundary of the
    // dangling-link rejection: only BROKEN links are refused.
    writeFileSync(join(allowed, "target.txt"), "inside");
    symlinkSync(join(allowed, "target.txt"), join(allowed, "live-in"), "file");
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("rejects reading through a symlinked file that escapes the root", async () => {
    await expect(
      resolvePathWithinRoots(
        fakeServer([allowed]),
        join(allowed, "link-to-secret"),
        "Source",
        NO_ENV,
      ),
    ).rejects.toThrow(/outside the/);
  });

  it("rejects writing into a symlinked directory that escapes the root", async () => {
    // Destination file does not exist yet; the symlinked parent must still be resolved.
    await expect(
      resolvePathWithinRoots(
        fakeServer([allowed]),
        join(allowed, "link-to-outside", "new.txt"),
        "Destination",
        NO_ENV,
      ),
    ).rejects.toThrow(/outside the/);
  });

  // Regression: realpathSync() throws for BOTH "no such path" and "dangling
  // symlink". Treating them alike re-appended the link's own name to its real
  // parent, so `allowed/dangling-out` canonicalized to `allowed/dangling-out`,
  // passed containment, and writeFile then followed the link into `outside`.
  //
  // Asserts only that it rejects, deliberately NOT the wording: what matters is
  // that no approved path is handed back, and a message-coupled assertion turns
  // any rephrasing into a spurious failure that reads like a security break.
  it("rejects a dangling symlink whose target is outside the root", async () => {
    await expect(
      resolvePathWithinRoots(
        fakeServer([allowed]),
        join(allowed, "dangling-out"),
        "Destination",
        NO_ENV,
      ),
    ).rejects.toThrow();
  });

  // A DELIBERATE trade, not an oversight. This link points somewhere legitimate
  // — inside the root — and an earlier implementation resolved it and allowed
  // the write. Resolving needs recursion (links can chain), recursion needs a
  // depth cap to survive cycles, and the cap needs a `depth` parameter that
  // `paths.map(toRealPath)` would silently fill with the array index. Rejecting
  // buys all of that back for one narrow case: a pre-existing broken link whose
  // target's parent directory already exists, used as a download destination.
  // Ordinary destinations are plain paths with no symlink and never reach here
  // (see "allows a not-yet-existing destination under the real root" below).
  it("rejects a dangling symlink even when its target is inside the root", async () => {
    await expect(
      resolvePathWithinRoots(
        fakeServer([allowed]),
        join(allowed, "dangling-in"),
        "Destination",
        NO_ENV,
      ),
    ).rejects.toThrow(/broken symlink/);
  });

  // The rejection is scoped to BROKEN links only. Widening it to "reject every
  // symlink" would be a plausible-looking simplification and would break macOS
  // outright — /tmp -> /private/tmp, /var, and symlinked home directories are
  // all live links that must still resolve. This test fails if anyone tries it.
  it("still follows a live symlink that stays inside the root", async () => {
    const out = await resolvePathWithinRoots(
      fakeServer([allowed]),
      join(allowed, "live-in"),
      "Source",
      NO_ENV,
    );
    expect(out).toBe(join(allowed, "target.txt"));
  });

  // Names the target so the user can act on it, rather than only saying "no".
  it("names the broken link's target in the rejection", async () => {
    await expect(
      resolvePathWithinRoots(
        fakeServer([allowed]),
        join(allowed, "dangling-in"),
        "Destination",
        NO_ENV,
      ),
    ).rejects.toThrow(/not-created-yet\.txt/);
  });

  // Every link in a cycle is dangling, so the first hop is rejected — no depth
  // counter needed, and no hang.
  it("rejects a symlink cycle instead of hanging", async () => {
    await expect(
      resolvePathWithinRoots(fakeServer([allowed]), join(allowed, "loop-a"), "Destination", NO_ENV),
    ).rejects.toThrow(/broken symlink/);
  });

  it("allows a not-yet-existing destination under the real root", async () => {
    const out = await resolvePathWithinRoots(
      fakeServer([allowed]),
      join(allowed, "newsub", "new.txt"),
      "Destination",
      NO_ENV,
    );
    expect(out).toBe(join(allowed, "newsub", "new.txt"));
  });

  it("uses CONSOLE_MCP_ALLOWED_DIRS when the client provides no roots", async () => {
    const env = { [ALLOWED_DIRS_ENV]: allowed };
    const out = await resolvePathWithinRoots(
      fakeServer(null),
      join(allowed, "ok.txt"),
      "Source",
      env,
    );
    expect(out).toBe(join(allowed, "ok.txt"));

    await expect(
      resolvePathWithinRoots(fakeServer(null), join(outside, "secret.txt"), "Source", env),
    ).rejects.toThrow(/outside the/);
  });

  it("uses CONSOLE_MCP_ALLOWED_DIRS when the client declares empty roots", async () => {
    const env = { [ALLOWED_DIRS_ENV]: allowed };
    const out = await resolvePathWithinRoots(
      fakeServer([]),
      join(allowed, "ok.txt"),
      "Source",
      env,
    );
    expect(out).toBe(join(allowed, "ok.txt"));
  });

  it("honors multiple directories joined with the platform delimiter", async () => {
    const env = { [ALLOWED_DIRS_ENV]: [outside, allowed].join(delimiter) };
    const out = await resolvePathWithinRoots(
      fakeServer(null),
      join(allowed, "ok.txt"),
      "Source",
      env,
    );
    expect(out).toBe(join(allowed, "ok.txt"));
  });

  it("uses saved allowedDirs when the client provides no roots and env is empty", async () => {
    const out = await resolvePathWithinRoots(
      fakeServer(null),
      join(allowed, "ok.txt"),
      "Source",
      NO_ENV,
      [allowed],
    );
    expect(out).toBe(join(allowed, "ok.txt"));
  });

  it("lets CONSOLE_MCP_ALLOWED_DIRS beat the saved config list", async () => {
    const env = { [ALLOWED_DIRS_ENV]: allowed };
    await expect(
      resolvePathWithinRoots(fakeServer(null), join(outside, "secret.txt"), "Source", env, [
        outside,
      ]),
    ).rejects.toThrow(/outside the/);
  });

  it("lets client roots beat the saved config list", async () => {
    await expect(
      resolvePathWithinRoots(fakeServer([allowed]), join(outside, "secret.txt"), "Source", NO_ENV, [
        outside,
      ]),
    ).rejects.toThrow(/outside the/);
  });
});

describe("readFileWithinRoot — reading the file that was validated", () => {
  // resolvePathWithinRoots validates a PATH and returns a string; every read that
  // follows re-walks that path, so anything that swaps the final component in
  // between is read instead. O_NOFOLLOW closes that: the open fails rather than
  // following a symlink planted after the check.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "walrus-sandbox-read-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a regular file", () => {
    const target = join(dir, "data.bin");
    writeFileSync(target, "payload");

    expect(readFileWithinRoot(target, { maxBytes: 1024, label: "Source" })).toEqual(
      Buffer.from("payload"),
    );
  });

  it("refuses to read through a symlink swapped in after validation", () => {
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "PRIVATE KEY");
    const target = join(dir, "data.bin");
    writeFileSync(target, "payload");

    // The post-validation swap.
    unlinkSync(target);
    symlinkSync(secret, target);

    expect(() => readFileWithinRoot(target, { maxBytes: 1024, label: "Source" })).toThrow();
  });

  it("rejects a file larger than the cap without buffering it", () => {
    // The size has to come from the OPEN descriptor, not a separate stat() —
    // otherwise the file can grow between the check and the read.
    const target = join(dir, "big.bin");
    writeFileSync(target, Buffer.alloc(4096));

    expect(() => readFileWithinRoot(target, { maxBytes: 1024, label: "Source" })).toThrow(
      /over the 1024-byte limit/,
    );
  });

  it("accepts a file exactly at the cap", () => {
    const target = join(dir, "exact.bin");
    writeFileSync(target, Buffer.alloc(1024));

    expect(readFileWithinRoot(target, { maxBytes: 1024, label: "Source" })).toHaveLength(1024);
  });

  it("names the label and the limit in the size error, so the message is actionable", () => {
    const target = join(dir, "big.bin");
    writeFileSync(target, Buffer.alloc(4096));

    expect(() => readFileWithinRoot(target, { maxBytes: 1024, label: "Source" })).toThrow(/1024/);
  });

  it("refuses a directory", () => {
    expect(() => readFileWithinRoot(dir, { maxBytes: 1024, label: "Source" })).toThrow();
  });
});
