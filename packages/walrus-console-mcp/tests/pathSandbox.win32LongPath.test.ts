import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/atomicWrite";
import {
  allowedDirsFromConfig,
  allowedDirsFromEnv,
  type RootsCapableServer,
  resolvePathWithinRoots,
  stripWin32LongPathPrefix,
  toRealPathAsync,
  validateAllowedDirectory,
} from "../src/pathSandbox";

/**
 * Windows long-path (`\\?\`) destinations. The prefix has to be understood well
 * enough to validate the location it names, without ever turning a path that
 * names some other device into one that looks like it sits inside a root —
 * and roots configured with the same prefix have to keep working too, or a
 * user who reached for it to name a long-path folder locks themselves out of
 * every candidate under it.
 *
 * Backslashes are spelled through `BS` so no layer of escaping can quietly
 * change the paths under test.
 */

const BS = "\\";
const LP = `${BS}${BS}?${BS}`;

describe("stripWin32LongPathPrefix", () => {
  it("unwraps a drive path", () => {
    expect(stripWin32LongPathPrefix(`${LP}C:${BS}Users${BS}me${BS}f.txt`)).toBe(
      `C:${BS}Users${BS}me${BS}f.txt`,
    );
  });

  it("unwraps the forward-slash spelling", () => {
    expect(stripWin32LongPathPrefix("//?/C:/Users/me/f.txt")).toBe("C:/Users/me/f.txt");
  });

  it("unwraps a network share to an ordinary UNC path", () => {
    expect(stripWin32LongPathPrefix(`${LP}UNC${BS}server${BS}share${BS}f.txt`)).toBe(
      `${BS}${BS}server${BS}share${BS}f.txt`,
    );
  });

  it("unwraps the lowercase 'unc' keyword the same way", () => {
    expect(stripWin32LongPathPrefix(`${LP}unc${BS}server${BS}share${BS}f.txt`)).toBe(
      `${BS}${BS}server${BS}share${BS}f.txt`,
    );
  });

  it("uppercases a lowercase drive letter, so it matches a root typed in uppercase", () => {
    // isWithinRoots compares strings literally; a root saved/typed as "C:\..."
    // must not fail to contain a candidate that arrived as "\\?\c:\...".
    expect(stripWin32LongPathPrefix(`${LP}c:${BS}Users${BS}me${BS}f.txt`)).toBe(
      `C:${BS}Users${BS}me${BS}f.txt`,
    );
  });

  it("leaves paths without the prefix untouched", () => {
    for (const p of [
      `C:${BS}Users${BS}me`,
      "/home/me/f.txt",
      "relative/f.txt",
      `${BS}${BS}server${BS}share${BS}f.txt`,
      "~/f.txt",
    ]) {
      expect(stripWin32LongPathPrefix(p)).toBe(p);
    }
  });

  it("refuses a bare drive letter with no trailing separator, rather than returning a drive-relative path", () => {
    // `\\?\C:` (nothing after) used to unwrap to "C:" — a path relative to
    // the CURRENT DIRECTORY on that drive, not its root — which
    // resolvePathWithinRoots would then anchor to the first allowed root
    // instead of refusing.
    for (const p of [`${LP}C:`, `${LP}c:`]) {
      expect(() => stripWin32LongPathPrefix(p)).toThrow(/drive path/);
    }
  });

  it("refuses a malformed UNC form instead of resolving it as something else", () => {
    // A single component ("data") is not `server\share`, and path.win32.resolve
    // does not parse a UNC root with fewer than two components — it falls back
    // to the current drive instead, silently naming a local path.
    expect(() => stripWin32LongPathPrefix(`${LP}UNC${BS}data`)).toThrow(/network share/);
    // Same failure mode for a share built from "..".
    expect(() => stripWin32LongPathPrefix(`${LP}UNC${BS}..`)).toThrow(/network share/);
  });

  it("refuses a UNC form whose unwrap would reintroduce the very prefix it exists to remove", () => {
    // The "server" component here is exactly "?", so the naive rebuild
    // `\\${server}\${share}` is "\\?\C:\allowed\x.txt" — itself a "\\?\..."
    // path. Left unnoticed, resolveCandidateWithinRoots (which calls this
    // function once, not in a loop) would treat that as an ordinary,
    // already-unwrapped path and hand it to `path.win32.resolve`, which
    // parses a leading "\\?\" as its own thing — a confusing "outside the
    // folders" refusal for what was semantically a within-bounds path.
    expect(() => stripWin32LongPathPrefix(`${LP}UNC${BS}?${BS}C:${BS}allowed${BS}x.txt`)).toThrow(
      /must not itself unwrap/,
    );
  });

  it("refuses any other namespace rather than leaving a relative path behind", () => {
    for (const p of [
      `${LP}GLOBALROOT${BS}Device${BS}HarddiskVolume1${BS}f.txt`,
      `${LP}Volume{01234567-89ab-cdef-0123-456789abcdef}${BS}f.txt`,
      LP,
    ]) {
      expect(() => stripWin32LongPathPrefix(p)).toThrow(/drive path/);
    }
  });

  it("refuses a prefix that lost a backslash, and says so", () => {
    expect(() => stripWin32LongPathPrefix(`${BS}?${BS}C:${BS}Users${BS}me`)).toThrow(
      /backslash lost/,
    );
  });
});

/** Fake MCP server advertising a fixed set of roots. */
function fakeServer(rootDirs: readonly string[]): RootsCapableServer {
  return {
    getClientCapabilities: () => ({ roots: {} }),
    listRoots: async () => ({ roots: rootDirs.map((dir) => ({ uri: pathToFileURL(dir).href })) }),
  };
}

// Runs on every CI platform, including Linux, by injecting `platform: "win32"`
// rather than relying on `describe.runIf(process.platform === "win32")` —
// which was the ONLY thing exercising any of this: deleting
// `resolveCandidateWithinRoots`'s call to `stripWin32LongPathPrefix` and
// restoring the plain `expandTilde(candidatePath)` left the entire suite
// green apart from that one Windows-only describe block.
//
// Deliberately message-based, not exact-resolved-path-based: `resolve` /
// `isAbsolute` inside `resolveCandidateWithinRoots` come from `node:path`,
// which is bound to the OS this file actually runs ON, not to the injected
// `platform` argument — that argument only gates whether the strip itself
// runs. A `C:\...` string is genuinely absolute when this test happens to run
// on Windows and genuinely NOT when it runs on Linux, so an assertion on the
// resolved path would silently only hold on one of the two. A message that
// can only ever originate from `stripWin32LongPathPrefix` itself sidesteps
// that entirely: it is thrown, and reaches the caller unchanged, BEFORE
// `resolveCandidateWithinRoots` calls `resolve`/`isAbsolute` on anything.
describe("resolveCandidateWithinRoots calls stripWin32LongPathPrefix when platform is win32 (any OS)", () => {
  const resolveDest = (candidate: string, platform: NodeJS.Platform) =>
    resolvePathWithinRoots(
      fakeServer(["C:\\workspace"]),
      candidate,
      "Destination",
      {},
      [],
      platform,
    );

  it("propagates the strip function's own diagnosis for a malformed prefix", async () => {
    await expect(resolveDest(`${BS}?${BS}C:${BS}workspace${BS}x.txt`, "win32")).rejects.toThrow(
      /backslash lost/,
    );
  });

  it("propagates the strip function's refusal of an unsupported namespace", async () => {
    await expect(
      resolveDest(`${LP}GLOBALROOT${BS}Device${BS}HarddiskVolume1${BS}x.txt`, "win32"),
    ).rejects.toThrow(/drive path/);
  });
});

describe.runIf(process.platform === "win32")(
  "root parsers strip a Windows long-path prefix the same way a candidate does (Windows)",
  () => {
    it("allowedDirsFromEnv strips a prefixed entry", () => {
      expect(allowedDirsFromEnv({ CONSOLE_MCP_ALLOWED_DIRS: `${LP}C:${BS}data` })).toEqual([
        "C:\\data",
      ]);
    });

    it("allowedDirsFromEnv drops (not crashes on) an entry whose prefix cannot be made sense of", () => {
      const good = `${LP}C:${BS}data`;
      const bad = `${LP}GLOBALROOT${BS}Device${BS}HarddiskVolume1`;
      expect(allowedDirsFromEnv({ CONSOLE_MCP_ALLOWED_DIRS: `${bad};${good}` })).toEqual([
        "C:\\data",
      ]);
    });

    it("allowedDirsFromConfig strips a prefixed entry", () => {
      expect(allowedDirsFromConfig({ allowedDirs: [`${LP}C:${BS}data`] })).toEqual(["C:\\data"]);
    });

    it("validateAllowedDirectory strips a prefixed entry before resolving it", () => {
      const dir = mkdtempSync(join(tmpdir(), "wcm-validate-longpath-"));
      try {
        expect(validateAllowedDirectory(`${LP}${dir}`)).toEqual({ dir });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a root configured WITH the prefix still contains a candidate the prefix was stripped FROM", async () => {
      // The bug this closes: isWithinRoots compares strings literally, so a
      // root parsed with "\\?\" still on it could never contain a candidate
      // resolved without it — every candidate under a long-path root refused
      // as "outside the folders", including the user who set that root up
      // specifically to use it.
      // Canonicalized the same way `resolvePathWithinRoots` canonicalizes the
      // candidate: a GitHub-hosted Windows runner's temp dir is an 8.3 short
      // name (`C:\Users\RUNNER~1\…`), which the native async realpath expands
      // — an un-canonicalized `dir` here would compare a short root against a
      // long-expanded candidate and fail for a reason unrelated to this test.
      const dir = await toRealPathAsync(mkdtempSync(join(tmpdir(), "wcm-root-longpath-")));
      try {
        const env = { CONSOLE_MCP_ALLOWED_DIRS: `${LP}${dir}` };
        const out = await resolvePathWithinRoots(
          fakeServer([]), // client declares roots support but none — env must win
          join(dir, "ok.txt"),
          "Destination",
          env,
        );
        expect(out).toBe(join(dir, "ok.txt"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

describe.runIf(process.platform === "win32")(
  "resolvePathWithinRoots with long-path destinations (Windows)",
  () => {
    let base: string;
    let allowed: string;
    let outside: string;

    beforeAll(async () => {
      // Canonicalized the way resolvePathWithinRoots does it. The sync
      // toRealPath keeps 8.3 short names (`C:\Users\RUNNER~1\…` on CI runners)
      // where the native async realpath expands them, so expectations built
      // with the sync one would not match what the sandbox returns.
      base = await toRealPathAsync(mkdtempSync(join(tmpdir(), "wcm-longpath-")));
      allowed = join(base, "allowed");
      outside = join(base, "outside");
      mkdirSync(allowed);
      mkdirSync(outside);
    });

    afterAll(() => {
      rmSync(base, { recursive: true, force: true });
    });

    const resolveDest = (candidate: string) =>
      resolvePathWithinRoots(fakeServer([allowed]), candidate, "Destination", {}, []);

    it("accepts a prefixed destination inside the root, returning the plain canonical path", async () => {
      expect(await resolveDest(`${LP}${join(allowed, "new.txt")}`)).toBe(join(allowed, "new.txt"));
    });

    it("accepts a 252-character file name under folders that do not exist yet", async () => {
      const name = `${"a".repeat(248)}.txt`;
      const dest = join(allowed, "not", "created", "yet", name);

      expect(await resolveDest(`${LP}${dest}`)).toBe(dest);
    });

    it("accepts the forward-slash spelling", async () => {
      const dest = join(allowed, "fwd.txt");

      expect(await resolveDest(`//?/${dest.split(BS).join("/")}`)).toBe(dest);
    });

    it("refuses a prefixed destination outside the root", async () => {
      await expect(resolveDest(`${LP}${join(outside, "x.txt")}`)).rejects.toThrow(/outside the/);
    });

    it("refuses a prefixed destination that traverses out of the root", async () => {
      await expect(resolveDest(`${LP}${allowed}${BS}..${BS}outside${BS}x.txt`)).rejects.toThrow(
        /outside the/,
      );
    });

    it("refuses a prefixed network share that is not an allowed root", async () => {
      await expect(resolveDest(`${LP}UNC${BS}localhost${BS}c$${BS}x.txt`)).rejects.toThrow(
        /outside the/,
      );
    });

    it("refuses a device namespace path instead of anchoring it inside the root", async () => {
      await expect(
        resolveDest(`${LP}GLOBALROOT${BS}Device${BS}HarddiskVolume1${BS}x.txt`),
      ).rejects.toThrow(/cannot be used/);
    });

    it("refuses a prefix that lost a backslash, naming the likely cause", async () => {
      await expect(resolveDest(`${BS}?${BS}${join(allowed, "x.txt")}`)).rejects.toThrow(
        /backslash lost/,
      );
    });

    it("actually writes through a resolved long-path destination and reads the real bytes back", async () => {
      // The string-resolution tests above prove the NAME is accepted; they
      // never touch a byte of disk. This is the download's whole point: a
      // long `\\?\`-prefixed destination has to actually be writable, not
      // merely pass validation.
      const name = `${"long-path-write-check-".padEnd(248, "x")}.txt`;
      const dest = join(allowed, "deep", "nested", "folder", name);

      const resolved = await resolveDest(`${LP}${dest}`);
      expect(resolved).toBe(dest);
      writeFileAtomic(resolved, "written through a long-path destination", {
        mode: 0o600,
        mkdirMode: 0o700,
      });

      expect(readFileSync(dest, "utf-8")).toBe("written through a long-path destination");
    });
  },
);
