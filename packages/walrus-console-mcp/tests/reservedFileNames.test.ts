import { describe, expect, it } from "vitest";
import { WINDOWS_RESERVED_BASENAMES, checkWindowsReservedName } from "../src/reservedFileNames.js";

/**
 * Windows reserves CON, PRN, AUX, NUL, COM1-9, LPT1-9, and the superscript-
 * digit spellings COM¹/COM²/COM³/LPT¹/LPT²/LPT³ as device names, checked on
 * every platform since a file named on one OS can be downloaded, synced, or
 * opened on Windows later.
 */

describe("checkWindowsReservedName", () => {
  it("flags every name in the reserved list, bare", () => {
    for (const name of WINDOWS_RESERVED_BASENAMES) {
      expect(checkWindowsReservedName(name)).toEqual({ reserved: name, suggestion: `_${name}` });
    }
  });

  it("flags a reserved name with an extension", () => {
    expect(checkWindowsReservedName("NUL.txt")).toEqual({
      reserved: "NUL",
      suggestion: "_NUL.txt",
    });
  });

  it("flags a reserved name with a compound extension", () => {
    expect(checkWindowsReservedName("CON.tar.gz")).toEqual({
      reserved: "CON",
      suggestion: "_CON.tar.gz",
    });
  });

  it("is case-insensitive", () => {
    expect(checkWindowsReservedName("nul.txt")).toEqual({
      reserved: "NUL",
      suggestion: "_nul.txt",
    });
    expect(checkWindowsReservedName("Con")).toEqual({ reserved: "CON", suggestion: "_Con" });
    expect(checkWindowsReservedName("cOm3.log")).toEqual({
      reserved: "COM3",
      suggestion: "_cOm3.log",
    });
  });

  it("does not flag a name that merely starts with a reserved word", () => {
    // The whole segment before the first dot must match, not a prefix of it.
    expect(checkWindowsReservedName("CONSOLE.txt")).toBeNull();
    expect(checkWindowsReservedName("NULL.txt")).toBeNull();
    expect(checkWindowsReservedName("COM10.txt")).toBeNull();
    expect(checkWindowsReservedName("LPT10")).toBeNull();
    expect(checkWindowsReservedName("AUXILIARY")).toBeNull();
  });

  it("does not flag a reserved word that is not the FIRST dot-segment", () => {
    expect(checkWindowsReservedName("report.NUL")).toBeNull();
    expect(checkWindowsReservedName("archive.CON.txt")).toBeNull();
  });

  it("does not flag COM0 or LPT0, which are not reserved", () => {
    expect(checkWindowsReservedName("COM0")).toBeNull();
    expect(checkWindowsReservedName("LPT0")).toBeNull();
  });

  it("flags the superscript-digit spellings Windows also recognizes", () => {
    // ¹ ² ³ (U+00B9, U+00B2, U+00B3) have no case of their own; only the
    // "COM"/"LPT" prefix needs the case-insensitivity check.
    expect(checkWindowsReservedName("COM¹.txt")).toEqual({
      reserved: "COM¹",
      suggestion: "_COM¹.txt",
    });
    expect(checkWindowsReservedName("lpt³")).toEqual({
      reserved: "LPT³",
      suggestion: "_lpt³",
    });
  });

  it("does not flag an ordinary name", () => {
    expect(checkWindowsReservedName("report.pdf")).toBeNull();
    expect(checkWindowsReservedName("readme")).toBeNull();
  });

  it("does not flag a dotfile with no name before the dot", () => {
    expect(checkWindowsReservedName(".nul")).toBeNull();
    expect(checkWindowsReservedName(".gitignore")).toBeNull();
  });

  it("does not flag an empty string", () => {
    expect(checkWindowsReservedName("")).toBeNull();
  });
});
