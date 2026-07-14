import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isWithinRoots,
  type RootsCapableServer,
  resolvePathWithinRoots,
  rootsToDirs,
} from "../src/pathSandbox";

/** Fake MCP server advertising a fixed set of roots (or none). */
function fakeServer(rootDirs: readonly string[] | null): RootsCapableServer {
  return {
    getClientCapabilities: () => (rootDirs === null ? {} : { roots: {} }),
    listRoots: async () => ({
      roots: (rootDirs ?? []).map((dir) => ({ uri: pathToFileURL(dir).href })),
    }),
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

  it("returns false for an empty root list (caller decides fail-open)", () => {
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

describe("resolvePathWithinRoots", () => {
  const workspace = join("/home", "me", "project");

  it("anchors a relative path to the workspace root, not the server cwd", async () => {
    const out = await resolvePathWithinRoots(fakeServer([workspace]), "report.pdf", "Source");
    expect(out).toBe(join(workspace, "report.pdf"));
  });

  it("anchors a relative subdir path to the workspace root", async () => {
    const out = await resolvePathWithinRoots(fakeServer([workspace]), "docs/q1.pdf", "Source");
    expect(out).toBe(join(workspace, "docs", "q1.pdf"));
  });

  it("passes an absolute path inside the root through unchanged", async () => {
    const abs = join(workspace, "a", "b.txt");
    expect(await resolvePathWithinRoots(fakeServer([workspace]), abs, "Source")).toBe(abs);
  });

  it("expands a leading ~ to the home directory", async () => {
    const out = await resolvePathWithinRoots(fakeServer([homedir()]), "~/notes.txt", "Dest");
    expect(out).toBe(join(homedir(), "notes.txt"));
  });

  it("rejects an absolute path outside every root", async () => {
    await expect(
      resolvePathWithinRoots(fakeServer([workspace]), "/etc/passwd", "Source"),
    ).rejects.toThrow(/outside the/);
  });

  it("rejects a relative path that traverses out of the workspace", async () => {
    await expect(
      resolvePathWithinRoots(fakeServer([workspace]), "../secret", "Source"),
    ).rejects.toThrow(/outside the/);
  });

  it("fails open (no throw) when the client does not support roots", async () => {
    const abs = join("/tmp", "anywhere.txt");
    expect(await resolvePathWithinRoots(fakeServer(null), abs, "Source")).toBe(abs);
  });
});
