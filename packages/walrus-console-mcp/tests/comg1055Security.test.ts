import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveDownloadDestWithinRoots,
  resolvePathWithinRoots,
  type RootsCapableServer,
} from "../src/pathSandbox";

const noRoots: RootsCapableServer = {
  getClientCapabilities: () => ({}),
  listRoots: async () => ({ roots: [] }),
};
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "comg1055-security-")));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config-home"));
  vi.stubEnv("APPDATA", join(root, "config-home"));
  mkdirSync(join(root, "config-home", "walrus-console-mcp"), { recursive: true });
  writeFileSync(join(root, "config-home", "walrus-console-mcp", "config.json"), "{}");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("COMG-1055 config-directory exclusion", () => {
  it("refuses reading its own config even when an allowed ancestor contains it", async () => {
    await expect(
      resolvePathWithinRoots(
        noRoots,
        join(root, "config-home", "walrus-console-mcp", "config.json"),
        "Source",
        {},
        [root],
      ),
    ).rejects.toThrow(/config directory/);
  });
  it("refuses config writes through a symlink alias even with a broad allowed folder", async () => {
    symlinkSync(join(root, "config-home"), join(root, "alias"), "dir");
    await expect(
      resolveDownloadDestWithinRoots(
        noRoots,
        join(root, "alias", "walrus-console-mcp", "admin.json"),
        "Destination",
        {},
        [root],
      ),
    ).rejects.toThrow(/config directory/);
  });

  it("canonicalizes a symlinked XDG config directory before comparing a direct target", async () => {
    symlinkSync(join(root, "config-home"), join(root, "xdg-alias"), "dir");
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg-alias"));
    vi.stubEnv("APPDATA", join(root, "xdg-alias"));
    await expect(
      resolvePathWithinRoots(
        noRoots,
        join(root, "config-home", "walrus-console-mcp", "config.json"),
        "Source",
        {},
        [root],
      ),
    ).rejects.toThrow(/config directory/);
  });

  it("fails closed if the protected config directory is a broken symlink", async () => {
    rmSync(join(root, "config-home", "walrus-console-mcp"), { recursive: true });
    symlinkSync(join(root, "missing"), join(root, "config-home", "walrus-console-mcp"), "dir");
    await expect(
      resolvePathWithinRoots(noRoots, join(root, "ordinary.txt"), "Source", {}, [root]),
    ).rejects.toThrow(/broken symlink/);
  });

  it("refuses hidden-file writes granted only by a saved folder", async () => {
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    await expect(
      resolveDownloadDestWithinRoots(
        noRoots,
        join(root, "repo", ".git", "config"),
        "Destination",
        {},
        [root],
      ),
    ).rejects.toThrow(/hidden files/);
  });
  it("keeps saved Home out of a workspace session and refuses it outright when nothing else is allowed", async () => {
    const workspace: RootsCapableServer = {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({ roots: [{ uri: pathToFileURL(root).href }] }),
    };
    const candidate = join(homedir(), "comg1055-not-created.txt");
    await expect(
      resolvePathWithinRoots(workspace, candidate, "Source", {}, [homedir()]),
    ).rejects.toThrow(/outside the/);
    await expect(
      resolvePathWithinRoots(noRoots, candidate, "Source", {}, [homedir()]),
    ).rejects.toThrow(/is your home directory/);
    await expect(
      resolvePathWithinRoots(workspace, candidate, "Source", {}, [dirname(homedir())]),
    ).rejects.toThrow(/outside the/);
  });

  it("protects config even when the filesystem root is explicitly allowed", async () => {
    await expect(
      resolvePathWithinRoots(
        noRoots,
        join(root, "config-home", "walrus-console-mcp", "config.json"),
        "Source",
        {},
        [parse(root).root],
      ),
    ).rejects.toThrow(/config directory/);
  });
  it("refuses a miscased config path on case-insensitive filesystems", async ({ skip }) => {
    const candidate = join(root, "CONFIG-HOME", "WALRUS-CONSOLE-MCP", "CONFIG.JSON");
    try {
      realpathSync(candidate);
    } catch {
      skip();
      return;
    }
    await expect(resolvePathWithinRoots(noRoots, candidate, "Source", {}, [root])).rejects.toThrow(
      /config directory/,
    );
  });
});
