import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALLOWED_DIRS_ENV,
  allowedDirsFromEnv,
  isWithinRoots,
  type RootsCapableServer,
  resolvePathWithinRoots,
  rootsToDirs,
  toRealPath,
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
      resolvePathWithinRoots(fakeServer(null), join("/tmp", "anywhere.txt"), "Source", NO_ENV),
    ).rejects.toThrow(new RegExp(ALLOWED_DIRS_ENV));
  });

  it("fails closed when the client advertises roots support but declares none", async () => {
    await expect(
      resolvePathWithinRoots(fakeServer([]), join("/tmp", "anywhere.txt"), "Source", NO_ENV),
    ).rejects.toThrow(new RegExp(ALLOWED_DIRS_ENV));
  });

  it("fails closed when listRoots() errors and there is no env fallback", async () => {
    await expect(
      resolvePathWithinRoots(fakeServerListRootsThrows(), "/etc/hosts", "Source", NO_ENV),
    ).rejects.toThrow(new RegExp(ALLOWED_DIRS_ENV));
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
});
