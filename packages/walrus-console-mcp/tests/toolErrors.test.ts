import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { KeyActivationError, SpaceMismatchError } from "../src/console/errors";
import { clearSecrets, formatToolError, registerSecret } from "../src/redaction";
import { unwrapFiberFailure } from "../src/runtime";

/** Minimal runtime so we can reproduce exactly what runPromise rejects with. */
const testRuntime = ManagedRuntime.make(Layer.empty);

afterEach(() => {
  clearSecrets();
});

async function rejectionOf(effect: Effect.Effect<never, unknown>): Promise<unknown> {
  try {
    await testRuntime.runPromise(effect);
    throw new Error("expected the effect to fail");
  } catch (error) {
    return error;
  }
}

describe("unwrapFiberFailure", () => {
  it("recovers the original tagged error from a runPromise rejection", async () => {
    const original = new KeyActivationError({ keyId: "key-1", status: "pending" });
    const caught = await rejectionOf(Effect.fail(original));

    // Sanity: the raw rejection hides the useful data behind a generic message.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("An error has occurred");

    expect(unwrapFiberFailure(caught)).toBe(original);
  });

  it("recovers the defect from a died fiber", async () => {
    const defect = new Error("boom");
    const caught = await rejectionOf(Effect.die(defect));
    expect(unwrapFiberFailure(caught)).toBe(defect);
  });

  it("passes non-Effect errors through unchanged", () => {
    const plain = new Error("plain failure");
    expect(unwrapFiberFailure(plain)).toBe(plain);
    expect(unwrapFiberFailure("string error")).toBe("string error");
  });
});

describe("formatToolError with tagged errors", () => {
  it("surfaces the fields of a message-less tagged error", () => {
    const error = new KeyActivationError({
      keyId: "key-1",
      status: "pending",
      progress: { granted: 2, total: 5 },
    });
    const text = formatToolError("get_file_status", error);

    expect(text).toContain("KeyActivationError");
    expect(text).toContain("key-1");
    expect(text).toContain("pending");
    expect(text).not.toContain("An error has occurred");
  });

  it("renders the full runPromise round-trip readably", async () => {
    const original = new SpaceMismatchError({ requested: "space-a", minted: "space-b" });
    const caught = await (async () => {
      try {
        await testRuntime.runPromise(Effect.fail(original));
        throw new Error("expected failure");
      } catch (error) {
        return error;
      }
    })();

    const text = formatToolError("upload_file", unwrapFiberFailure(caught));
    expect(text).toContain("SpaceMismatchError");
    expect(text).toContain("space-a");
    expect(text).toContain("space-b");
  });

  it("still redacts secrets that appear in tagged-error fields", () => {
    registerSecret("hbr_super_secret_key_value");
    const error = new KeyActivationError({
      keyId: "hbr_super_secret_key_value",
      status: "pending",
    });
    const text = formatToolError("get_file_status", error);
    expect(text).not.toContain("hbr_super_secret_key_value");
    expect(text).toContain("«redacted»");
  });

  it("keeps message-bearing errors unchanged", () => {
    const text = formatToolError("ping_console", new Error("connection refused"));
    expect(text).toContain("**Error in ping_console**");
    expect(text).toContain("connection refused");
  });
});
