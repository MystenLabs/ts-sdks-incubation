import { describe, expect, it } from "vitest";
import { confirmDestructive } from "../src/toolSchemas";

// the security review — the server-enforced gate on delete_bucket/delete_file must
// actually refuse anything but a literal `true`, not just document that it
// should be passed.

describe("confirmDestructive", () => {
  it("accepts exactly `true`", () => {
    expect(confirmDestructive.safeParse(true).success).toBe(true);
  });

  it("rejects `false`", () => {
    expect(confirmDestructive.safeParse(false).success).toBe(false);
  });

  it("rejects a missing value", () => {
    expect(confirmDestructive.safeParse(undefined).success).toBe(false);
  });

  it("rejects a truthy non-boolean (a prompt-injected agent guessing at the shape)", () => {
    expect(confirmDestructive.safeParse("true").success).toBe(false);
    expect(confirmDestructive.safeParse(1).success).toBe(false);
  });
});
