import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic, writeFileAtomicAsync } from "../src/atomicWrite.js";

/**
 * A dedicated file, not a `-t` filter into `atomicWrite.test.ts`: the Windows
 * CI job used to select these three tests with
 * `vitest run tests/atomicWrite.test.ts -t "long file name"`, and a `-t` that
 * matches nothing exits 0 with every test skipped — renaming the `describe`
 * title there would have silently dropped the only Windows-specific coverage
 * of this fix. A missing FILE, unlike a missing title match, fails the run.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-atomic-longname-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("atomic writes with a long file name", () => {
  // Console accepts file names up to 255 characters. The temp sibling must not
  // be what pushes a legal destination name over the filesystem's 255 cap.
  const longName = `extreme_long_filename_test_${"a".repeat(252 - 27 - 4)}.txt`;

  it("uses a short temp name that carries nothing of the target's name", () => {
    let tmpPath = "";

    writeFileAtomic(path.join(dir, longName), "x", {
      mode: 0o600,
      onTempCreated: (p) => {
        tmpPath = p;
      },
    });

    expect(longName).toHaveLength(252);
    expect(path.basename(tmpPath).length).toBeLessThan(64);
    expect(path.basename(tmpPath)).not.toContain("extreme_long_filename");
  });

  it("matches the exact documented shape, so a stale leftover is recognizable and a shape change is noticed here", () => {
    // The header comment on atomicTempPath in src/atomicWrite.ts tells an
    // operator to spot a leftover by this exact shape. Nothing previously
    // pinned it: dropping the leading dot, dropping the ".tmp" suffix, or
    // renaming "walrus-console-mcp" all left the rest of the suite green.
    let tmpPath = "";

    writeFileAtomic(path.join(dir, longName), "x", {
      mode: 0o600,
      onTempCreated: (p) => {
        tmpPath = p;
      },
    });

    expect(path.basename(tmpPath)).toMatch(/^\.walrus-console-mcp\.\d+\.[0-9a-f]{12}\.tmp$/);
  });

  it("writes a 252-character file name synchronously", () => {
    writeFileAtomic(path.join(dir, longName), "sync", { mode: 0o600 });

    expect(fs.readFileSync(path.join(dir, longName), "utf-8")).toBe("sync");
    expect(fs.readdirSync(dir)).toEqual([longName]);
  });

  it("writes a 252-character file name asynchronously", async () => {
    await writeFileAtomicAsync(path.join(dir, longName), "async", { mode: 0o600 });

    expect(fs.readFileSync(path.join(dir, longName), "utf-8")).toBe("async");
    expect(fs.readdirSync(dir)).toEqual([longName]);
  });
});
