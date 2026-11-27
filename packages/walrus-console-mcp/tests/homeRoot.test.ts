import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_DIRS_ENV,
  homeRootRefusal,
  isHomeDirectory,
  type RootsCapableServer,
  resolvePathWithinRoots,
  selectAllowedDirs,
  toRealPath,
  validateAllowedDirectory,
} from "../src/pathSandbox";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, realpath: vi.fn(fs.realpath) };
});

/**
 * A sandbox root equal to the home directory makes the sandbox the whole account, so it is refused
 * with a named message wherever a root enters: the installer's write path and the runtime selection.
 * `HOME` / `USERPROFILE` point at a temp dir so `os.homedir()` is a directory the test owns.
 */
const NO_ENV: NodeJS.ProcessEnv = {};

function fakeServer(rootDirs: readonly string[] | null): RootsCapableServer {
  return {
    getClientCapabilities: () => (rootDirs === null ? {} : { roots: {} }),
    listRoots: async () => ({
      roots: (rootDirs ?? []).map((dir) => ({ uri: pathToFileURL(dir).href })),
    }),
  };
}

let scratch: string;
let home: string;
let documents: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "walrus-mcp-homeroot-"));
  home = join(scratch, "home");
  documents = join(home, "Documents");
  mkdirSync(documents, { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe("isHomeDirectory", () => {
  it("matches the same directory, ignoring a trailing separator", () => {
    expect(isHomeDirectory(`${home}/`, home, "linux")).toBe(true);
  });

  it("does not match a subdirectory or a sibling with the same prefix", () => {
    expect(isHomeDirectory(documents, home, "linux")).toBe(false);
    expect(isHomeDirectory(`${home}-other`, home, "linux")).toBe(false);
  });

  it("compares case-insensitively on win32 only", () => {
    expect(isHomeDirectory("/Users/ALICE", "/users/alice", "win32")).toBe(true);
    expect(isHomeDirectory("/Users/ALICE", "/users/alice", "linux")).toBe(false);
  });
});

describe("validateAllowedDirectory — the installer's write path", () => {
  it.each(["~", "~/"])("refuses %s with a named message", (input) => {
    const result = validateAllowedDirectory(input);

    expect(result).toEqual({ error: homeRootRefusal(input) });
    expect((result as { error: string }).error).toMatch(/your home directory/);
  });

  it("refuses the expanded home path", () => {
    expect(validateAllowedDirectory(home)).toEqual({ error: homeRootRefusal(home) });
  });

  it("refuses a symlink that resolves to the home directory", () => {
    const link = join(scratch, "link-to-home");
    symlinkSync(home, link);

    expect(validateAllowedDirectory(link)).toEqual({ error: homeRootRefusal(link) });
  });

  it("refuses the real Home directory when Home is configured as a symlink", () => {
    const link = join(scratch, "home-alias");
    symlinkSync(home, link, "dir");
    vi.stubEnv("HOME", link);
    vi.stubEnv("USERPROFILE", link);

    expect(validateAllowedDirectory(home)).toEqual({ error: homeRootRefusal(home) });
  });

  it("accepts a subdirectory of the home directory", () => {
    expect(validateAllowedDirectory("~/Documents")).toEqual({ dir: toRealPath(documents) });
  });
});

const summary = (selected: Awaited<ReturnType<typeof selectAllowedDirs>>) => ({
  source: selected.source,
  rootDirs: selected.rootDirs,
  refusedRoots: selected.refusedRoots,
});

describe("selectAllowedDirs — the runtime selection", () => {
  it("drops a client root equal to home and names it", async () => {
    const selected = await selectAllowedDirs(fakeServer([home]), "Dest", NO_ENV, []);

    expect(summary(selected)).toEqual({ source: "file", rootDirs: [], refusedRoots: [home] });
  });

  it("refuses a differently cased Home root on win32 when Home cannot be canonicalized", async () => {
    const workspace = toRealPath(home);
    const reportedHome = join(dirname(workspace), "HOME");
    vi.stubEnv("HOME", reportedHome);
    vi.stubEnv("USERPROFILE", reportedHome);
    vi.stubEnv("XDG_CONFIG_HOME", scratch);
    vi.stubEnv("APPDATA", scratch);
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

    // Keep the configured spelling even on case-insensitive test filesystems.
    // With no Home identity available, the refusal must come from comparing paths.
    await vi.mocked(realpath).withImplementation(
      (path, options) =>
        path === reportedHome
          ? Promise.reject(new Error("Home canonicalization unavailable"))
          : fs.realpath(path, options),
      async () => {
        const server = fakeServer([workspace]);
        expect(summary(await selectAllowedDirs(server, "Dest", NO_ENV, [], "win32"))).toEqual({
          source: "file",
          rootDirs: [],
          refusedRoots: [workspace],
        });
        expect((await selectAllowedDirs(server, "Dest", NO_ENV, [], "linux")).rootDirs).toEqual([
          workspace,
        ]);
      },
    );
  });

  it("drops an env root equal to home", async () => {
    const env = { [ALLOWED_DIRS_ENV]: "~" };

    const selected = await selectAllowedDirs(fakeServer(null), "Dest", env, []);

    expect(summary(selected)).toEqual({ source: "file", rootDirs: [], refusedRoots: [home] });
  });

  it("drops a saved root equal to home", async () => {
    const selected = await selectAllowedDirs(fakeServer(null), "Dest", NO_ENV, [home]);

    expect(summary(selected)).toEqual({ source: "file", rootDirs: [], refusedRoots: [home] });
  });

  it("keeps the other roots when one is home", async () => {
    const selected = await selectAllowedDirs(fakeServer([home, documents]), "Dest", NO_ENV, []);

    expect(summary(selected)).toEqual({
      source: "clientRoots",
      rootDirs: [toRealPath(documents)],
      refusedRoots: [home],
    });
  });

  it("drops real Home and uses a saved subfolder when Home is configured as a symlink", async () => {
    const link = join(scratch, "home-alias");
    symlinkSync(home, link, "dir");
    vi.stubEnv("HOME", link);
    vi.stubEnv("USERPROFILE", link);

    const selected = await selectAllowedDirs(fakeServer([home]), "Dest", NO_ENV, [documents]);

    expect(summary(selected)).toEqual({
      source: "file",
      rootDirs: [toRealPath(documents)],
      refusedRoots: [home],
    });
  });

  it("keeps a broad saved ancestor out of a session that declared an unusable root", async () => {
    const missing = join(scratch, "missing-workspace");
    const selected = await selectAllowedDirs(fakeServer([missing]), "Dest", NO_ENV, [scratch]);

    expect(selected.rootDirs).toEqual([]);
  });

  it("reports no refused roots when none is home", async () => {
    const selected = await selectAllowedDirs(fakeServer([documents]), "Dest", NO_ENV, []);

    expect(summary(selected)).toEqual({
      source: "clientRoots",
      rootDirs: [toRealPath(documents)],
      refusedRoots: undefined,
    });
    expect(selected).not.toHaveProperty("refusedRoots");
  });
});

describe("resolvePathWithinRoots — a home root", () => {
  it("refuses with the named message when home is the only root", async () => {
    await expect(
      resolvePathWithinRoots(fakeServer([home]), join(home, "x.txt"), "Dest", NO_ENV, []),
    ).rejects.toThrow(/your home directory, which would make the sandbox your whole account/);
  });

  it("does not let home widen the sandbox when another root is allowed", async () => {
    await expect(
      resolvePathWithinRoots(
        fakeServer([home, documents]),
        join(home, ".ssh", "id_rsa"),
        "Dest",
        NO_ENV,
        [],
      ),
    ).rejects.toThrow(/outside the/);
  });

  it("names the dropped home root in the outside-roots error", async () => {
    await expect(
      resolvePathWithinRoots(
        fakeServer([home, documents]),
        join(home, "x.txt"),
        "Dest",
        NO_ENV,
        [],
      ),
    ).rejects.toThrow(/outside the[\s\S]*is your home directory/);
  });

  it("still serves a subdirectory of home", async () => {
    const out = await resolvePathWithinRoots(
      fakeServer([documents]),
      join(documents, "notes.txt"),
      "Dest",
      NO_ENV,
      [],
    );

    expect(out).toBe(toRealPath(join(documents, "notes.txt")));
  });
});
