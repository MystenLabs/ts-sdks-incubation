import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RootsCapableServer, resolveDownloadDestWithinRoots } from "../src/pathSandbox";
import {
  checkSensitiveDownloadPath,
  SENSITIVE_DOWNLOAD_BASENAMES,
} from "../src/sensitiveFileNames";

const NO_ENV: NodeJS.ProcessEnv = {};

describe("SENSITIVE_DOWNLOAD_BASENAMES", () => {
  it("is the one list of non-dot credential names, all lowercase", () => {
    expect([...SENSITIVE_DOWNLOAD_BASENAMES].sort()).toEqual([
      "_netrc",
      "authorized_keys",
      "id_dsa",
      "id_ecdsa",
      "id_ed25519",
      "id_rsa",
      "known_hosts",
    ]);
    for (const name of SENSITIVE_DOWNLOAD_BASENAMES) expect(name).toBe(name.toLowerCase());
  });
});

describe("checkSensitiveDownloadPath", () => {
  it.each([[".env"], [".ENV"], [".npmrc"], [".gitignore"], [".hidden"]])(
    "refuses the dotfile %s",
    (name) => {
      expect(checkSensitiveDownloadPath([name], "linux")).toEqual({
        segment: name,
        reason: "dotfile",
      });
    },
  );

  it.each([[[".ssh", "id_rsa"]], [[".git", "config"]], [["a", "b", ".aws", "credentials"]]])(
    "refuses a file under a dot directory: %j",
    (segments) => {
      expect(checkSensitiveDownloadPath(segments, "linux")?.reason).toBe("dotfile");
    },
  );

  it.each([
    ["id_rsa"],
    ["ID_RSA"],
    ["id_ed25519"],
    ["authorized_keys"],
    ["known_hosts"],
    ["_netrc"],
  ])("refuses the credential name %s", (name) => {
    expect(checkSensitiveDownloadPath(["keys", name], "linux")).toEqual({
      segment: name,
      reason: "sensitive_name",
    });
  });

  it.each([["notes.txt"], ["report.final.pdf"], ["my.env"], ["env.txt"], ["id_rsa.pub.txt"]])(
    "accepts the ordinary name %s",
    (name) => {
      expect(checkSensitiveDownloadPath(["docs", name], "linux")).toBeNull();
    },
  );

  it("accepts a path with no components", () => {
    expect(checkSensitiveDownloadPath([], "linux")).toBeNull();
  });

  it.each([[".env."], [".env "], [".env::$DATA"], ["id_rsa."], ["ID_RSA::$DATA"]])(
    "sees through the Windows spelling %s",
    (name) => {
      expect(checkSensitiveDownloadPath([name], "win32")).not.toBeNull();
    },
  );

  it("does not apply the Windows spellings on other platforms", () => {
    expect(checkSensitiveDownloadPath(["id_rsa."], "linux")).toBeNull();
  });
});

function fakeServer(rootDirs: readonly string[]): RootsCapableServer {
  return {
    getClientCapabilities: () => ({ roots: {} }),
    listRoots: async () => ({ roots: rootDirs.map((dir) => ({ uri: pathToFileURL(dir).href })) }),
  };
}

describe("resolveDownloadDestWithinRoots — sensitive destinations", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "walrus-mcp-sensitive-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const resolveDest = (dest: string, base: string = root) =>
    resolveDownloadDestWithinRoots(fakeServer([base]), dest, "Destination", NO_ENV, []);

  it.each([[".env"], [".npmrc"], [".git/config"], [".ssh/id_rsa"], ["docs/.aws/credentials"]])(
    "refuses %s inside an allowed root, naming the offending component",
    async (rel) => {
      await expect(resolveDest(join(root, rel))).rejects.toThrow(/is refused: "\./);
    },
  );

  it("refuses a credential name that is not a dotfile", async () => {
    await expect(resolveDest(join(root, "keys", "id_ed25519"))).rejects.toThrow(
      /"id_ed25519" is a name used for credentials/,
    );
  });

  it("refuses a destination reached through a symlinked directory named like a dotdir", async () => {
    mkdirSync(join(root, "safe"));
    symlinkSync(join(root, "safe"), join(root, ".cfg"));

    await expect(resolveDest(join(root, ".cfg", "x.txt"))).rejects.toThrow(/is refused: "\.cfg"/);
  });

  it("refuses an innocent path whose directory is a symlink to a dot directory", async () => {
    mkdirSync(join(root, ".ssh"));
    symlinkSync(join(root, ".ssh"), join(root, "shortcut"));

    await expect(resolveDest(join(root, "shortcut", "notes.txt"))).rejects.toThrow(
      /is refused: "\.ssh"/,
    );
  });

  it("accepts an ordinary destination", async () => {
    await expect(resolveDest(join(root, "docs", "report.pdf"))).resolves.toContain("report.pdf");
  });

  it.each([
    ["outer root first", (outer: string, inner: string) => [outer, inner]],
    ["inner root first", (outer: string, inner: string) => [inner, outer]],
  ])(
    "accepts a destination under a dot-named inner root listed with its parent (%s)",
    async (_n, order) => {
      const inner = join(root, ".work");
      mkdirSync(inner);
      const server = fakeServer(order(root, inner));
      await expect(
        resolveDownloadDestWithinRoots(
          server,
          join(inner, "report.pdf"),
          "Destination",
          NO_ENV,
          [],
        ),
      ).resolves.toContain("report.pdf");
    },
  );

  it("accepts a destination when the root itself sits under a dot directory", async () => {
    const hiddenBase = join(root, ".walrus-out");
    mkdirSync(hiddenBase);

    await expect(resolveDest(join(hiddenBase, "report.pdf"), hiddenBase)).resolves.toContain(
      "report.pdf",
    );
  });
});
