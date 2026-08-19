import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/atomicWrite.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-atomic-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const modeOf = (p: string) => fs.statSync(p).mode & 0o777;

describe("writeFileAtomic", () => {
  it("creates a new file with the requested mode", () => {
    const target = path.join(dir, "new.json");

    writeFileAtomic(target, "hello", { mode: 0o600 });

    expect(fs.readFileSync(target, "utf-8")).toBe("hello");
    expect(modeOf(target)).toBe(0o600);
  });

  it("replaces an existing file's contents", () => {
    const target = path.join(dir, "existing.json");
    fs.writeFileSync(target, "old");

    writeFileAtomic(target, "new", { mode: 0o600 });

    expect(fs.readFileSync(target, "utf-8")).toBe("new");
  });

  it("preserves the mode of a file it did not create", () => {
    // A third-party client's config is not ours to re-permission: rename replaces
    // the inode, so without this the write would silently tighten (or loosen) the
    // mode the owning application chose.
    const target = path.join(dir, "foreign.json");
    fs.writeFileSync(target, "old", { mode: 0o644 });
    fs.chmodSync(target, 0o644);

    writeFileAtomic(target, "new", { mode: 0o600, preserveExistingMode: true });

    expect(modeOf(target)).toBe(0o644);
  });

  it("tightens an existing loose mode by default", () => {
    // The credential file relies on this: a legacy world-readable config must come
    // back as 0600 on the next write, not keep the mode it was found with.
    const target = path.join(dir, "ours.json");
    fs.writeFileSync(target, "old");
    fs.chmodSync(target, 0o644);

    writeFileAtomic(target, "new", { mode: 0o600 });

    expect(modeOf(target)).toBe(0o600);
  });

  it("writes binary content byte-for-byte", () => {
    const target = path.join(dir, "blob.bin");
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);

    writeFileAtomic(target, bytes, { mode: 0o600 });

    expect(new Uint8Array(fs.readFileSync(target))).toEqual(bytes);
  });

  it("leaves no temp file behind on success", () => {
    writeFileAtomic(path.join(dir, "clean.json"), "x", { mode: 0o600 });

    expect(fs.readdirSync(dir)).toEqual(["clean.json"]);
  });

  it("leaves the original intact and no temp behind when the write fails", () => {
    const target = path.join(dir, "keep.json");
    fs.writeFileSync(target, "original");

    // A directory where the content should be forces a failure mid-write.
    expect(() =>
      writeFileAtomic(target, { bad: true } as unknown as string, { mode: 0o600 }),
    ).toThrow();

    expect(fs.readFileSync(target, "utf-8")).toBe("original");
    expect(fs.readdirSync(dir)).toEqual(["keep.json"]);
  });

  it("creates the parent directory when asked", () => {
    const target = path.join(dir, "nested", "deep", "file.json");

    writeFileAtomic(target, "x", { mode: 0o600, mkdirMode: 0o700 });

    expect(fs.readFileSync(target, "utf-8")).toBe("x");
    expect(modeOf(path.dirname(target))).toBe(0o700);
  });

  it("writes the temp file in the destination directory, not the system tmpdir", () => {
    // A cross-device rename is not atomic (and fails outright on many systems),
    // so the temp file has to be a sibling of the target.
    const target = path.join(dir, "sibling.json");
    let observed: string[] = [];

    writeFileAtomic(target, "x", {
      mode: 0o600,
      onTempCreated: () => {
        observed = fs.readdirSync(dir);
      },
    });

    expect(observed.some((f) => f.includes("sibling.json") && f !== "sibling.json")).toBe(true);
  });
});
