import { describe, expect, it } from "vitest";
import { findStaleDependencies, satisfiesRange } from "../scripts/shrinkwrapStaleness.mjs";

describe("satisfiesRange", () => {
  it("accepts a pinned version inside a caret range", () => {
    expect(satisfiesRange("^3.22.1", "3.25.0")).toBe(true);
  });

  it("rejects a pinned version below a caret range's floor", () => {
    expect(satisfiesRange("^3.22.1", "3.22.0")).toBe(false);
  });

  it("rejects a pinned major version bump past a caret range", () => {
    expect(satisfiesRange("^3.22.1", "4.0.0")).toBe(false);
  });

  it("treats a 0.x caret range as pinning the minor version", () => {
    expect(satisfiesRange("^0.97.1", "0.97.9")).toBe(true);
    expect(satisfiesRange("^0.97.1", "0.98.0")).toBe(false);
  });

  it("accepts an exact pin only when it matches exactly", () => {
    expect(satisfiesRange("1.47.0", "1.47.0")).toBe(true);
    expect(satisfiesRange("1.47.0", "1.47.1")).toBe(false);
  });

  it("fails closed on a range form it does not recognise", () => {
    expect(satisfiesRange("~1.2.3", "1.2.9")).toBe(false);
  });

  it("rejects a prerelease-tagged pinned version against a caret range (Finding 4)", () => {
    // Per semver, a prerelease has LOWER precedence than its base version and
    // does not satisfy a range unless the range explicitly opts into
    // prereleases (which this function deliberately does not). Before the
    // fix, pinnedMatch's regex had no trailing `$` anchor, so it matched only
    // the leading numeric prefix and silently ignored the "-alpha.0" suffix.
    expect(satisfiesRange("^3.22.1", "3.22.1-alpha.0")).toBe(false);
  });

  it("rejects a prerelease-tagged pinned version against an exact pin (Finding 4)", () => {
    expect(satisfiesRange("1.47.0", "1.47.0-beta.1")).toBe(false);
  });

  it("fails closed on a compound/OR range instead of matching its leading alternative (Finding 5)", () => {
    // Before the fix, caretMatch's regex had no trailing `$` anchor, so for a
    // compound range like "^3.22.1 || ^4.0.0" it matched only the leading
    // "^3.22.1" and evaluated the WHOLE compound range as if it were just its
    // first alternative. 3.25.0 satisfies the truncated "^3.22.1" alone, so
    // the buggy version returns `true` here — a false PASS for an
    // unrecognised range that should fail closed.
    expect(satisfiesRange("^3.22.1 || ^4.0.0", "3.25.0")).toBe(false);
  });
});

describe("findStaleDependencies", () => {
  it("reports a dependency the shrinkwrap does not pin at all", () => {
    const result = findStaleDependencies({ effect: "^3.22.1" }, {});
    expect(result.missing).toEqual(["effect"]);
    expect(result.outOfRange).toEqual([]);
  });

  it("reports a dependency pinned outside its package.json range", () => {
    const result = findStaleDependencies({ effect: "^3.22.1" }, { effect: "2.0.0" });
    expect(result.outOfRange).toEqual([{ name: "effect", range: "^3.22.1", pinned: "2.0.0" }]);
  });

  it("reports nothing when every dependency is pinned in range", () => {
    const result = findStaleDependencies(
      { effect: "^3.22.1", zod: "^3.24.4" },
      { effect: "3.22.5", zod: "3.24.4" },
    );
    expect(result).toEqual({ missing: [], outOfRange: [] });
  });
});
