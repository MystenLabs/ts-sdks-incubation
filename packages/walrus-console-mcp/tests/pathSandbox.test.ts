import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_DIRS_ENV,
  allowedDirsFromConfig,
  allowedDirsFromEnv,
  isWithinRoots,
  type RootsCapableServer,
  resolveDownloadDestWithinRoots,
  resolvePathWithinRoots,
  rootsToDirs,
  readFileWithinRoot,
  selectAllowedDirs,
  splitAllowedDirList,
  toRealPath,
  toRealPathAsync,
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

/** Capture one rejection's message — mirrors `rejectionOf` in tests/toolErrors.test.ts,
 * so an assertion needing several substrings of the same message doesn't re-run the
 * (async, filesystem-touching) call once per substring. */
async function rejectionMessageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error("expected the call to reject");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

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

  // COMG-847: names the refused path and the folders that ARE allowed. This
  // fixture's client advertises roots, so per review on PR #58 the remedy
  // must NOT tell the reader to run `config --allowed-dirs` as if it would
  // fix things — client roots beat the saved list outright, so that command
  // would be a no-op here. It's still fine for the message to name the
  // command while explaining why (see the "would not change this" case
  // below); what must not appear is the file-source round-trip remedy, which
  // only makes sense when the saved list is the thing actually in effect.
  it("names the refused path and the allowed folders when rejecting a path outside client-advertised roots", async () => {
    const message = await rejectionMessageOf(
      resolvePathWithinRoots(fakeServer([workspace]), "/etc/passwd", "Source", NO_ENV),
    );
    expect(message).toContain('"/etc/passwd"');
    expect(message).toContain(toRealPath(workspace));
    expect(message).toMatch(/workspace folders are the sandbox/);
    expect(message).not.toMatch(/Add its folder without dropping/);
  });

  // COMG-847 review (PR #58, finding 1): the ONLY source `config --allowed-dirs`
  // can actually change is the saved-file fallback — client roots and the env
  // var both beat it outright (see `describeAllowedDirsRemedy`). This is the
  // real "npx ... install" story: no client roots, no env var, just a saved
  // list — the remedy must be actionable here, and per finding 2 it must
  // carry the folder that's ALREADY saved forward (`config --allowed-dirs`
  // replaces the list rather than appending to it).
  it("recommends the round-trip config --allowed-dirs command, naming the folder already saved, when the saved list is the active source", async () => {
    const message = await rejectionMessageOf(
      resolvePathWithinRoots(fakeServer(null), "/etc/passwd", "Source", NO_ENV, [workspace]),
    );
    expect(message).toContain('"/etc/passwd"');
    expect(message).toContain(toRealPath(workspace));
    expect(message).toMatch(/Add its folder without dropping the others already saved/);
    // The existing folder must be carried forward, not just a bare placeholder.
    expect(message).toMatch(/config --allowed-dirs '.*' --allowed-dirs <dir>/);
  });

  // COMG-847 review (PR #58, finding 3): the env var beats the saved list too,
  // so the same no-op problem applies to it — the remedy here must point at
  // the env var itself, not at a `config --allowed-dirs` command it would
  // silently override.
  it("points at CONSOLE_MCP_ALLOWED_DIRS, not config --allowed-dirs, when the env var is the active source", async () => {
    const env = { [ALLOWED_DIRS_ENV]: workspace };
    const message = await rejectionMessageOf(
      resolvePathWithinRoots(fakeServer(null), "/etc/passwd", "Source", env, []),
    );
    expect(message).toContain('"/etc/passwd"');
    expect(message).toMatch(new RegExp(`${ALLOWED_DIRS_ENV}.*beats the saved folder list`));
    expect(message).not.toMatch(/Add its folder without dropping/);
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

// The one source-selection step the sandbox and `ping_console` share: client
// roots, then the env var, then the saved list.
describe("selectAllowedDirs", () => {
  const rootsDir = resolve("/srv", "client-root");
  const envDir = resolve("/srv", "env-dir");
  const fileDir = resolve("/srv", "file-dir");
  const env: NodeJS.ProcessEnv = { [ALLOWED_DIRS_ENV]: envDir };

  it("client roots win over both the env var and the saved list", async () => {
    expect(await selectAllowedDirs(fakeServer([rootsDir]), "Source", env, [fileDir])).toEqual({
      source: "clientRoots",
      rootDirs: [rootsDir],
    });
  });

  it("a roots-capable client that declares no roots falls through to the env var", async () => {
    expect(await selectAllowedDirs(fakeServer([]), "Source", env, [fileDir])).toEqual({
      source: "env",
      rootDirs: [envDir],
    });
  });

  it("the env var wins over the saved list", async () => {
    expect(await selectAllowedDirs(fakeServer(null), "Source", env, [fileDir])).toEqual({
      source: "env",
      rootDirs: [envDir],
    });
  });

  it("the saved list is the fallback when neither client roots nor the env var yields a folder", async () => {
    expect(await selectAllowedDirs(fakeServer(null), "Source", NO_ENV, [fileDir])).toEqual({
      source: "file",
      rootDirs: [fileDir],
    });
  });

  // ping_console is "safe to call first": a client whose roots/list request
  // fails must not make it throw, only fall through to the next source.
  it("a listRoots() failure falls through to the next source instead of throwing", async () => {
    expect(await selectAllowedDirs(fakeServerListRootsThrows(), "Source", env, [fileDir])).toEqual({
      source: "env",
      rootDirs: [envDir],
    });
    expect(
      await selectAllowedDirs(fakeServerListRootsThrows(), "Source", NO_ENV, [fileDir]),
    ).toEqual({ source: "file", rootDirs: [fileDir] });
  });

  it("nothing configured anywhere yields an empty list", async () => {
    expect(await selectAllowedDirs(fakeServer(null), "Source", NO_ENV, [])).toEqual({
      source: "file",
      rootDirs: [],
    });
  });
});

// M9: `resolvePathWithinRoots` now resolves candidates and roots through
// `toRealPathAsync` instead of the synchronous `toRealPath`, so request-path
// canonicalization no longer blocks the event loop. These cases exercise the
// symlink-resolution behavior directly against BOTH implementations — sync
// `toRealPath` (still exported and used by `validateAllowedDirectory`, the
// installer, `cliArgs.ts`, `credentials.ts`, and other tests on non-request
// paths) and the new `toRealPathAsync` — so a divergence between the two
// (wrong message, different rejection, different suffix handling) fails here
// instead of only showing up once `resolvePathWithinRoots` is wired to one of
// them. `call` below folds a synchronous throw into a rejected promise so the
// same assertions work for both implementations.
describe.each([
  ["toRealPath", toRealPath],
  ["toRealPathAsync", toRealPathAsync],
] as const)("%s", (_name, resolveFn) => {
  let base: string;
  let allowed: string;
  let outside: string;

  // Wraps `resolveFn` so a synchronous throw (from `toRealPath`) and an async
  // rejection (from `toRealPathAsync`) both surface as a rejected promise —
  // an `async` function catches a synchronous throw in its body and turns it
  // into a rejection automatically.
  const call = async (p: string): Promise<string> => resolveFn(p);

  beforeAll(() => {
    base = toRealPath(mkdtempSync(join(tmpdir(), "wcm-realpath-")));
    allowed = join(base, "allowed");
    outside = join(base, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    symlinkSync(join(outside, "not-created-yet.txt"), join(allowed, "dangling-out"), "file");
    symlinkSync(join(allowed, "not-created-yet.txt"), join(allowed, "dangling-in"), "file");
    symlinkSync(join(allowed, "loop-b"), join(allowed, "loop-a"), "file");
    symlinkSync(join(allowed, "loop-a"), join(allowed, "loop-b"), "file");
    writeFileSync(join(allowed, "target.txt"), "inside");
    symlinkSync(join(allowed, "target.txt"), join(allowed, "live-in"), "file");
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("resolves a live symlink to its real target", async () => {
    expect(await call(join(allowed, "live-in"))).toBe(join(allowed, "target.txt"));
  });

  it("resolves a not-yet-existing suffix under an existing directory", async () => {
    expect(await call(join(allowed, "newsub", "new.txt"))).toBe(join(allowed, "newsub", "new.txt"));
  });

  it("rejects a dangling symlink and names its target", async () => {
    await expect(call(join(allowed, "dangling-in"))).rejects.toThrow(/not-created-yet\.txt/);
  });

  it("rejects a dangling symlink whose target is outside the allowed dir the same as one inside it", async () => {
    await expect(call(join(allowed, "dangling-out"))).rejects.toThrow(/broken symlink/);
  });

  it("rejects a symlink cycle instead of hanging", async () => {
    await expect(call(join(allowed, "loop-a"))).rejects.toThrow(/broken symlink/);
  });
});

// The two implementations must fail identically, not merely "similarly" — a
// caller (resolvePathWithinRoots) wraps whichever one throws with the same
// `${label} path "..." cannot be used: ${message}` template, so any drift here
// would leak into the tool-facing error text depending only on which twin is
// in use.
describe("toRealPath vs toRealPathAsync — message parity", () => {
  let dir: string;
  let danglingLink: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wcm-realpath-parity-"));
    danglingLink = join(dir, "dangling");
    symlinkSync(join(dir, "does-not-exist.txt"), danglingLink, "file");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws byte-identical messages for a broken symlink", async () => {
    let syncMessage: string | undefined;
    try {
      toRealPath(danglingLink);
    } catch (error) {
      syncMessage = error instanceof Error ? error.message : String(error);
    }
    let asyncMessage: string | undefined;
    try {
      await toRealPathAsync(danglingLink);
    } catch (error) {
      asyncMessage = error instanceof Error ? error.message : String(error);
    }
    expect(syncMessage).toBeDefined();
    expect(asyncMessage).toBe(syncMessage);
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

  // The rejection is scoped to BROKEN links only for resolvePathWithinRoots
  // (upload). Widening THAT to "reject every symlink" would break macOS —
  // /tmp -> /private/tmp, /var, and symlinked home directories are live links
  // that must still resolve. download_file uses resolveDownloadDestWithinRoots
  // instead (COMG-1039) and refuses a dest whose final component is a live
  // symlink; the next test pins that split.
  it("still follows a live symlink that stays inside the root", async () => {
    const out = await resolvePathWithinRoots(
      fakeServer([allowed]),
      join(allowed, "live-in"),
      "Source",
      NO_ENV,
    );
    expect(out).toBe(join(allowed, "target.txt"));
  });

  it("refuses a reserved device name before any lstat, on this platform whatever it is", async () => {
    // Checked ahead of the symlink/directory/regular-file checks below, which
    // all need the destination to be lstat-able — a reserved name never
    // reaches that far.
    await expect(
      resolveDownloadDestWithinRoots(
        fakeServer([allowed]),
        join(allowed, "NUL.txt"),
        "Destination",
        NO_ENV,
      ),
    ).rejects.toThrow(/reserves as the NUL device/);
  });

  it("refuses a reserved name case-insensitively and without an extension", async () => {
    await expect(
      resolveDownloadDestWithinRoots(
        fakeServer([allowed]),
        join(allowed, "com3"),
        "Destination",
        NO_ENV,
      ),
    ).rejects.toThrow(/reserves as the COM3 device/);
  });

  it("suggests an underscore-prefixed alternative, browser-style", async () => {
    await expect(
      resolveDownloadDestWithinRoots(
        fakeServer([allowed]),
        join(allowed, "con.txt"),
        "Destination",
        NO_ENV,
      ),
    ).rejects.toThrow(/"_con\.txt"/);
  });

  it("does not flag an ordinary name that merely contains a reserved word", async () => {
    const out = await resolveDownloadDestWithinRoots(
      fakeServer([allowed]),
      join(allowed, "console-report.txt"),
      "Destination",
      NO_ENV,
    );
    expect(out).toBe(join(allowed, "console-report.txt"));
  });

  it("does not flag a reserved name that is not the final path component", async () => {
    // "NUL" as an ANCESTOR directory, not the file itself: only the file
    // being written to is checked, so this must still resolve. A path with
    // no reserved word anywhere in it (e.g. "newsub/report.txt") would pass
    // this test even if the check mistakenly scanned every path segment —
    // it has to be a real reserved word placed somewhere other than the
    // final component to actually exercise the "final component only" scope.
    const out = await resolveDownloadDestWithinRoots(
      fakeServer([allowed]),
      join(allowed, "NUL", "report.txt"),
      "Destination",
      NO_ENV,
    );
    expect(out).toBe(join(allowed, "NUL", "report.txt"));
  });

  it("still refuses a reserved name outside the root as outside the root, not as reserved", async () => {
    // Containment is checked first inside resolveCandidateWithinRoots, so an
    // attacker cannot use a reserved-looking name to learn anything about
    // folders they are not allowed to write to.
    await expect(
      resolveDownloadDestWithinRoots(
        fakeServer([allowed]),
        join(outside, "NUL.txt"),
        "Destination",
        NO_ENV,
      ),
    ).rejects.toThrow(/outside the/);
  });

  it("flags a caller-named symlink by the symlink error, not the reserved-name error of its target", async () => {
    // `innocuous-name.txt` is not itself reserved; it happens to be a live
    // symlink to `NUL.txt`. Checking the resolved TARGET's name here (rather
    // than the name the caller actually typed) would misreport this as "path
    // innocuous-name.txt ends in NUL.txt" — nonsensical, since it does not —
    // and would suppress the symlink refusal a few lines below, which is the
    // actual problem. Named distinctly from "ok.txt": this describe shares one
    // `allowed` directory across every test via `beforeAll`, and several later
    // tests reuse "ok.txt" as an ordinary, non-symlink destination.
    writeFileSync(join(allowed, "NUL.txt"), "reserved target");
    symlinkSync(join(allowed, "NUL.txt"), join(allowed, "symlink-to-reserved.txt"), "file");

    await expect(
      resolveDownloadDestWithinRoots(
        fakeServer([allowed]),
        join(allowed, "symlink-to-reserved.txt"),
        "Destination",
        NO_ENV,
      ),
    ).rejects.toThrow(/Refusing to write through a symlink/);
  });

  it("refuses a live dest symlink even when the target stays inside the root", async () => {
    await expect(
      resolveDownloadDestWithinRoots(
        fakeServer([allowed]),
        join(allowed, "live-in"),
        "Destination",
        NO_ENV,
      ),
    ).rejects.toThrow(/Refusing to write through a symlink/);
    expect(
      await resolvePathWithinRoots(
        fakeServer([allowed]),
        join(allowed, "live-in"),
        "Source",
        NO_ENV,
      ),
    ).toBe(join(allowed, "target.txt"));
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
