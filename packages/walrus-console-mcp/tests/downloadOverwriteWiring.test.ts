import { describe, expect, it } from "vitest";
import { toolRegistrationBlock } from "./toolSource";

// COMG-790 — `tests/downloadOverwrite.test.ts` proves the service refuses to
// replace an existing file unless told to, but that is only a real control if
// bin/console-mcp.ts actually offers `overwrite` and passes it down. The block
// is read as text, with comments stripped; see `tests/toolSource.ts` for why
// both of those matter.

describe("download_file overwrite wiring (COMG-790)", () => {
  const block = toolRegistrationBlock("download_file");

  it("offers overwrite as an optional boolean", () => {
    expect(block).toMatch(/overwrite:\s*z\s*\.boolean\(\)\s*\.optional\(\)/);
  });

  // Matched on tokens rather than whole sentences: the description is the only
  // thing an agent reads before deciding to pass the flag, so it has to carry
  // these facts, but a copy-edit that keeps them should not fail this file.
  it("tells the caller the default is off and that the file being replaced is the user's", () => {
    expect(block).toMatch(/default/i);
    expect(block).toMatch(/\buser\b/i);
  });

  it("passes it to the service rather than dropping it", () => {
    // Without this the schema would advertise a flag that changes nothing, and
    // every download would still refuse an existing destination.
    expect(block).toMatch(/storage\.downloadFile\([\s\S]*overwrite \?\? false,[\s\S]*\)/);
  });

  it("says in the description that an existing file is not replaced", () => {
    expect(block).toMatch(/destPath/);
    expect(block).toMatch(/overwrite: true/);
  });
  // The annotation is what an MCP client keys its approval UX on, and nothing
  // else in the tree asserts it — a revert to `false` would ship green.
  it("is annotated destructive", () => {
    expect(block).toMatch(/destructiveHint:\s*true/);
  });
});
