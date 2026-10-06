import { describe, expect, it } from "vitest";
import {
  MAX_FILE_NAME_LENGTH,
  checkFileNameLength,
  truncateFileName,
} from "../src/fileNameLimit.js";

/** True when `s` survives a UTF-8 round trip, i.e. holds no lone surrogate. */
const isWellFormed = (s: string) => Buffer.from(s, "utf8").toString("utf8") === s;

describe("checkFileNameLength", () => {
  it("accepts a name at the limit", () => {
    const name = `${"a".repeat(MAX_FILE_NAME_LENGTH - 4)}.txt`;
    expect(checkFileNameLength(name)).toBeNull();
  });

  it("refuses one character over, naming the limit", () => {
    const name = `${"a".repeat(MAX_FILE_NAME_LENGTH - 3)}.txt`;
    expect(checkFileNameLength(name)).toMatchObject({ length: 256, limit: 255 });
  });

  it("accepts a name long only in UTF-8 bytes — refusing it would regress a same-OS download that already worked", () => {
    // 200 two-byte characters: 200 UTF-16 units (under the limit), 400 UTF-8
    // bytes (over it). Refusing here would break a Windows/exFAT destination,
    // where this name has always been legal, to guard a name that has moved
    // onto a UTF-8-backed filesystem — a gap this check deliberately leaves
    // open rather than closing at the cost of a regression.
    const name = "é".repeat(200);
    expect(checkFileNameLength(name)).toBeNull();
  });

  it("refuses a name that is over the limit by every measure, ASCII included", () => {
    const name = `${"a".repeat(300)}.txt`;
    expect(checkFileNameLength(name)).toMatchObject({ length: 304, limit: 255 });
  });
});

describe("truncateFileName", () => {
  it("leaves a name that fits untouched", () => {
    expect(truncateFileName("report.pdf")).toBe("report.pdf");
  });

  it("keeps the extension and cuts the stem to fit", () => {
    const out = truncateFileName(`${"b".repeat(300)}.txt`);
    expect(out).toBe(`${"b".repeat(251)}.txt`);
  });

  it("does not keep an 'extension' that is really most of the name", () => {
    const out = truncateFileName(`name.${"c".repeat(300)}`);
    expect(out).toHaveLength(MAX_FILE_NAME_LENGTH);
    expect(out.startsWith("name.")).toBe(true);
  });

  it("keeps a ~30-character extension and drops one at ~40", () => {
    // MAX_KEPT_EXTENSION = 32: pins the boundary itself, not just "some big
    // number" and "some small number" either side of it.
    const kept = `.${"e".repeat(29)}`; // 30 bytes, under the cap
    const dropped = `.${"e".repeat(39)}`; // 40 bytes, over it
    expect(truncateFileName(`${"a".repeat(300)}${kept}`).endsWith(kept)).toBe(true);
    expect(truncateFileName(`${"a".repeat(300)}${dropped}`).endsWith(dropped)).toBe(false);
  });

  it("never splits a surrogate pair", () => {
    const out = truncateFileName(`${"😀".repeat(140)}.txt`);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);
    expect(out.endsWith(".txt")).toBe(true);
    expect(isWellFormed(out)).toBe(true);
  });

  it("never splits a multi-byte character", () => {
    const out = truncateFileName(`${"é".repeat(200)}.txt`);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);
    expect(out.endsWith(".txt")).toBe(true);
    expect(isWellFormed(out)).toBe(true);
    expect(checkFileNameLength(out)).toBeNull();
  });

  it("fits under BOTH measures, not just the one it was cut by", () => {
    // The suggestion has to be safe on whichever filesystem it actually lands
    // on, not only the byte-counted one it was truncated against.
    const out = truncateFileName(`${"é".repeat(300)}.txt`);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);
    expect(out.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);
  });

  it("drops a trailing dot or space the cut exposed, so the suggestion names the file Windows would actually create", () => {
    // Windows silently strips a trailing "." or " " from the final path
    // component, so a suggestion ending in one names a file that is not the
    // one that gets created.
    const dot = truncateFileName(`${"a".repeat(254)}.${"c".repeat(40)}`);
    expect(dot.endsWith(".")).toBe(false);
    const space = truncateFileName(`${"a".repeat(253)} .${"c".repeat(40)}`);
    expect(space.endsWith(" ")).toBe(false);
    expect(space.endsWith(".")).toBe(false);
  });

  it("drops a trailing dot even when it comes from a trivial KEPT extension, not just the cut stem", () => {
    // The input's own extname is a bare "." here (nothing follows it), so
    // `kept` is "." — stripping only the stem before reattaching it would
    // leave the assembled result ending in that dot regardless.
    const out = truncateFileName(`${"a".repeat(300)}.`);
    expect(out.endsWith(".")).toBe(false);
    // One shorter than the budget, not equal to it: the dot that filled the
    // last byte is exactly what got dropped.
    expect(out).toHaveLength(MAX_FILE_NAME_LENGTH - 1);
    expect(out).toBe("a".repeat(MAX_FILE_NAME_LENGTH - 1));
  });

  it("strips a lone surrogate already present in the input rather than passing it through", () => {
    const name = `${"a".repeat(240)}\uD800${"a".repeat(20)}.txt`;
    const out = truncateFileName(name);
    expect(isWellFormed(out)).toBe(true);
    expect(out.endsWith(".txt")).toBe(true);
  });
});
