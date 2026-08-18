import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConsoleApiError,
  KeyActivationError,
  PayloadTooLargeError,
  SpaceMismatchError,
  UnsupportedFileTypeError,
} from "../src/console/errors";
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

/**
 * COMG-602 contract at the MCP boundary.
 *
 * The API client classifying a 415/413 into a dedicated tag is only half the
 * job — the tag and its fields have to survive `formatToolError`, which is the
 * last thing that runs before text reaches the agent. These are the errors that
 * caught the regression: unlike every older tagged error, they declare a
 * non-empty `message`, so a `message`-first `describeError` reduced them to a
 * bare sentence and the branching contract never left the process.
 */
describe("formatToolError preserves the upload-rejection contract", () => {
  it("surfaces every UnsupportedFileTypeError field, not just the message", () => {
    const text = formatToolError(
      "upload_file",
      new UnsupportedFileTypeError({
        message: "This file type is not accepted.",
        fileName: "virus.exe",
        layer: "server",
        code: "unsupported_file_type",
      }),
    );

    expect(text).toContain("UnsupportedFileTypeError");
    expect(text).toContain("virus.exe");
    expect(text).toContain("server");
    expect(text).toContain("unsupported_file_type");
    // The human-readable message is a field, so it rides along in the JSON.
    expect(text).toContain("This file type is not accepted.");
  });

  it("surfaces the byte count on a PayloadTooLargeError so the agent can size a retry", () => {
    const text = formatToolError(
      "upload_file",
      new PayloadTooLargeError({
        message: "Payload too large.",
        fileName: "huge.bin",
        bytes: 12345,
        code: "payload_too_large",
      }),
    );

    expect(text).toContain("PayloadTooLargeError");
    expect(text).toContain("huge.bin");
    expect(text).toContain("12345");
    expect(text).toContain("payload_too_large");
  });

  // The AC in prose: "deny, size-limit, and transport failures are distinct to
  // the caller". Distinct at the ConsoleApiClient layer is not enough — assert
  // it where the agent actually reads, on all three at once.
  it("keeps deny / size-cap / transport failures distinguishable in tool output", () => {
    const deny = formatToolError(
      "upload_file",
      new UnsupportedFileTypeError({
        message: "This file type is not accepted.",
        fileName: "a.exe",
        layer: "server",
      }),
    );
    const tooBig = formatToolError(
      "upload_file",
      new PayloadTooLargeError({ message: "Payload too large.", fileName: "a.bin", bytes: 9 }),
    );
    const transport = formatToolError(
      "upload_file",
      new ConsoleApiError({ message: "Upload failed with status 500", status: 500 }),
    );

    // Each must name its own tag — `not.toContain` alone is satisfied by output
    // that names no tag at all, which is exactly the bug being guarded against.
    expect(deny).toContain("UnsupportedFileTypeError");
    expect(tooBig).toContain("PayloadTooLargeError");
    expect(transport).toContain("ConsoleApiError");

    expect(tooBig).not.toContain("UnsupportedFileTypeError");
    expect(transport).not.toContain("UnsupportedFileTypeError");
    expect(transport).not.toContain("PayloadTooLargeError");
  });

  // Regression guard, stated generically: any tagged error that declares a
  // message must still carry its tag. Flipping the branch order in
  // `describeError` fails here rather than only in the two cases above.
  it("does not collapse a message-bearing tagged error to its bare message", () => {
    const error = new ConsoleApiError({
      message: "Upload failed with status 403",
      code: "mirror_missing_grant",
      status: 403,
    });
    const text = formatToolError("upload_file", error);

    expect(text).toContain("ConsoleApiError");
    // The retry code that ConsoleStorageService keys on has to be visible too.
    expect(text).toContain("mirror_missing_grant");
  });

  it("still redacts secrets that ride inside a message-bearing tagged error", () => {
    registerSecret("hbr_super_secret_key_value");
    const text = formatToolError(
      "upload_file",
      new UnsupportedFileTypeError({
        message: "rejected while using hbr_super_secret_key_value",
        fileName: "a.exe",
        layer: "server",
      }),
    );

    expect(text).not.toContain("hbr_super_secret_key_value");
    expect(text).toContain("«redacted»");
  });
});
