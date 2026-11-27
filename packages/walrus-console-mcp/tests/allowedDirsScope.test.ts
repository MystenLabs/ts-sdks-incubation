import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stepAllowedDirs } from "../bin/install.js";
import { runConfigure } from "../bin/configure.js";
import { parseArgs } from "../src/cliArgs.js";
import { getConfigFilePath, loadConfigFile, mergeConfigFile } from "../src/configFile.js";
import { validateSilent } from "../src/credentials.js";
import {
  ALLOWED_DIRS_ENV,
  resolvePathWithinRoots,
  resolveDownloadDestWithinRoots,
  selectAllowedDirs,
  type RootsCapableServer,
} from "../src/pathSandbox.js";

let root: string;
let saved: string;
let workspace: string;
let server: RootsCapableServer;
const noRoots: RootsCapableServer = {
  getClientCapabilities: () => ({}),
  listRoots: async () => ({ roots: [] }),
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "walrus-scope-")));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CONSOLE_")) vi.stubEnv(key, "");
  }
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("APPDATA", join(root, "config"));
  mkdirSync(join(root, "config", "walrus-console-mcp"), { recursive: true });
  saved = join(root, "saved");
  workspace = join(root, "workspace");
  mkdirSync(saved);
  mkdirSync(workspace);
  server = {
    getClientCapabilities: () => ({ roots: {} }),
    listRoots: async () => ({ roots: [{ uri: pathToFileURL(workspace).href }] }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function configure(scope?: unknown) {
  writeFileSync(
    getConfigFilePath(),
    JSON.stringify({
      allowedDirs: [saved],
      ...(scope === undefined ? {} : { allowedDirsScope: scope }),
    }),
  );
}

describe("saved folder scopes", () => {
  it.each([undefined, "fallback", "invalid", null, true, { shared: true }])(
    "does not expand saved grants with scope %j in a workspace session",
    async (scope) => {
      configure(scope);
      expect((await selectAllowedDirs(server, "Source", {})).rootDirs).toEqual([workspace]);
      await expect(
        resolvePathWithinRoots(server, join(saved, "source.txt"), "Source", {}),
      ).rejects.toThrow(/fallback scope/);
      await expect(
        resolveDownloadDestWithinRoots(server, join(saved, "new.txt"), "Destination", {}),
      ).rejects.toThrow(/fallback scope/);
    },
  );

  it("keeps legacy saved folders available without workspace or environment grants", async () => {
    configure();
    expect((await selectAllowedDirs(noRoots, "Source", {})).rootDirs).toEqual([saved]);
  });

  it("restores a saved fallback folder when the workspace directory disappears", async () => {
    configure("fallback");
    expect((await selectAllowedDirs(server, "Source", {})).rootDirs).toEqual([workspace]);
    rmSync(workspace, { recursive: true });

    expect(await selectAllowedDirs(server, "Source", {})).toMatchObject({
      source: "file",
      rootDirs: [saved],
    });
    await expect(
      resolveDownloadDestWithinRoots(server, "new.txt", "Destination", {}),
    ).resolves.toBe(join(saved, "new.txt"));
  });

  it("uses saved fallback folders when the environment entry is a regular file", async () => {
    configure();
    const envPath = join(workspace, "not-a-folder.txt");
    writeFileSync(envPath, "fixture");

    expect(
      await selectAllowedDirs(noRoots, "Source", { [ALLOWED_DIRS_ENV]: envPath }),
    ).toMatchObject({ source: "file", rootDirs: [saved] });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "uses saved fallback folders when the workspace cannot be traversed",
    async () => {
      configure();
      chmodSync(workspace, 0o600);
      try {
        expect(await selectAllowedDirs(server, "Source", {})).toMatchObject({
          source: "file",
          rootDirs: [saved],
        });
      } finally {
        chmodSync(workspace, 0o700);
      }
    },
  );

  it("uses ordinary saved fallback folders when workspace lookup is unavailable", async () => {
    const home = join(workspace, "home");
    mkdirSync(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const unreachable: RootsCapableServer = {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => {
        throw new Error("MCP roots request timed out");
      },
    };
    expect(await selectAllowedDirs(unreachable, "Source", {}, [workspace, saved])).toMatchObject({
      source: "file",
      rootDirs: [saved],
    });
  });

  it("keeps broad saved folders inactive when a declared environment path cannot be parsed", async () => {
    const home = join(workspace, "home");
    mkdirSync(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const env = { [ALLOWED_DIRS_ENV]: "\\\\?\\unsupported\\folder" };

    expect(
      await selectAllowedDirs(noRoots, "Source", env, [workspace, saved], "win32"),
    ).toMatchObject({
      source: "file",
      rootDirs: [saved],
    });
  });

  it("reports unavailable folders when a configured directory has become a file", async () => {
    configure();
    rmSync(saved, { recursive: true });
    writeFileSync(saved, "fixture");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      resolveDownloadDestWithinRoots(noRoots, "new.txt", "Destination", {}),
    ).rejects.toThrow(/none of the configured folders are available/);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`"${saved}": expected a directory`));
  });

  it("suppresses fallback folders when an environment grant exists", async () => {
    configure();
    expect(
      (await selectAllowedDirs(noRoots, "Source", { [ALLOWED_DIRS_ENV]: workspace })).rootDirs,
    ).toEqual([workspace]);
  });

  it("reloads scope on the next request and preserves independent grants on downgrade", async () => {
    configure();
    expect((await selectAllowedDirs(server, "Source", {})).rootDirs).toEqual([workspace]);
    configure("shared");
    expect((await selectAllowedDirs(server, "Source", {})).rootDirs).toEqual([workspace, saved]);
    await expect(
      resolvePathWithinRoots(server, join(saved, "source.txt"), "Source", {}),
    ).resolves.toBe(join(saved, "source.txt"));
    await expect(
      resolveDownloadDestWithinRoots(server, join(saved, "new.txt"), "Destination", {}),
    ).resolves.toBe(join(saved, "new.txt"));
    configure("fallback");
    expect((await selectAllowedDirs(server, "Source", {})).rootDirs).toEqual([workspace]);
    expect(
      (await selectAllowedDirs(server, "Source", { [ALLOWED_DIRS_ENV]: saved })).rootDirs,
    ).toEqual([workspace, saved]);
  });

  it.each(["shared", "fallback"])("preserves %s scope across unrelated config writes", (scope) => {
    configure(scope);
    mergeConfigFile({ webAccountAddress: `0x${"a".repeat(64)}` });
    expect(loadConfigFile()).toMatchObject({ allowedDirs: [saved], allowedDirsScope: scope });
  });

  it("does not mark a legacy list shared during unrelated writes", () => {
    configure();
    mergeConfigFile({ webAccountAddress: `0x${"a".repeat(64)}` });
    expect(loadConfigFile()).not.toHaveProperty("allowedDirsScope");
  });
});

describe("scope configuration", () => {
  it("does not echo a flag-shaped malformed scope value", () => {
    const value = "--sensitive-pasted-value";
    const parsed = parseArgs(["--allowed-dirs", saved, "--allowed-dirs-scope", value], {});
    expect(parsed.errors.join(" ")).toContain("must be shared or fallback");
    expect(parsed.errors.join(" ")).not.toContain(value);
  });

  it.each(["shared", "fallback"])(
    "saves explicit %s scope through the real CLI configuration handler",
    async (scope) => {
      expect(await runConfigure(["--allowed-dirs", saved, "--allowed-dirs-scope", scope])).toBe(0);
      expect(loadConfigFile()).toMatchObject({ allowedDirs: [saved], allowedDirsScope: scope });
    },
  );

  it("defaults an unscoped replacement to fallback even after a shared list", async () => {
    configure("shared");
    expect(await runConfigure(["--allowed-dirs", workspace])).toBe(0);
    expect(loadConfigFile()).toMatchObject({
      allowedDirs: [workspace],
      allowedDirsScope: "fallback",
    });
  });

  it("does not infer shared scope from imported environment folders", async () => {
    const parsed = parseArgs(["--silent"], { [ALLOWED_DIRS_ENV]: saved });
    const write = await validateSilent(
      parsed.values,
      async () => {
        throw new Error("no credential probe expected");
      },
      {},
      {},
    );
    expect(write.errors).toEqual([]);
    expect(write.updates).toMatchObject({ allowedDirs: [saved], allowedDirsScope: "fallback" });
  });

  it("requires the complete explicit folder list with a scope flag", () => {
    expect(parseArgs(["--allowed-dirs-scope", "shared"], {}).errors.join(" ")).toMatch(
      /--allowed-dirs/,
    );
    expect(
      parseArgs(["--silent", "--allowed-dirs-scope", "shared"], {
        [ALLOWED_DIRS_ENV]: saved,
      }).errors.join(" "),
    ).toMatch(/--allowed-dirs/);
  });

  it("rejects invalid and conflicting scope flags without saving or echoing invalid values", async () => {
    configure();
    const invalid = "sensitive-pasted-value";
    const parsed = parseArgs(["--allowed-dirs", saved, "--allowed-dirs-scope", invalid], {});
    expect(parsed.errors.join(" ")).toMatch(/shared.*fallback/);
    expect(parsed.errors.join(" ")).not.toContain(invalid);
    expect(
      await runConfigure([
        "--allowed-dirs",
        saved,
        "--allowed-dirs-scope=shared",
        "--allowed-dirs-scope=fallback",
      ]),
    ).toBe(1);
    expect(loadConfigFile()).not.toHaveProperty("allowedDirsScope");
  });

  it("lets the user review the existing list and explicitly share it", async () => {
    configure();
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await stepAllowedDirs({
      select: async (choices) =>
        choices.findIndex((choice) => choice.label === "Review saved folders"),
      ask: async (question) => (question.startsWith("Scope") ? "shared" : "n"),
    });
    expect(loadConfigFile()).toMatchObject({ allowedDirs: [saved], allowedDirsScope: "shared" });
    const printed = output.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(printed).toContain(saved);
    expect(printed).toContain("unrelated projects");
  });

  it("cancelling scope selection leaves the existing list unchanged", async () => {
    configure("shared");
    const write = await stepAllowedDirs({
      cwd: workspace,
      select: async () => 0,
      ask: async (question) => (question.startsWith("Scope") ? "back" : "n"),
      back: true,
    });
    expect(write.backRequested).toBe(true);
    expect(loadConfigFile()).toMatchObject({ allowedDirs: [saved], allowedDirsScope: "shared" });
  });
});
