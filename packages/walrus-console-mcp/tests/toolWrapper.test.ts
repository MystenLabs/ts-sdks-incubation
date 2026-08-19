import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleApiError } from "../src/console/errors";
import { clearSecrets, registerSecret } from "../src/redaction";
import { type McpToolResult, safeTool } from "../src/toolWrapper";

/**
 * `safeTool` is the single boundary every MCP tool handler passes through, so the
 * error contract it produces is the error contract of all 17 tools.
 */

const runtime = ManagedRuntime.make(Layer.empty);

/** Stand-in for the MCP SDK's per-request context, which carries the signal. */
const noExtra = { signal: new AbortController().signal } as never;

/**
 * The SDK's content block is a union (text / image / audio / resource); every
 * result `safeTool` produces is the text variant, so narrow once here instead
 * of casting at each assertion.
 */
function textOf(result: McpToolResult): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error(`expected a text block, got ${block?.type}`);
  return block.text;
}

afterEach(() => {
  clearSecrets();
  vi.restoreAllMocks();
});

describe("safeTool success results", () => {
  it("serialises an object result as pretty JSON", async () => {
    const tool = safeTool("demo", async () => ({ ok: true, count: 2 }));
    const result = await tool({}, noExtra);

    expect(result.content).toEqual([{ type: "text", text: '{\n  "ok": true,\n  "count": 2\n}' }]);
  });

  it("passes a string result through untouched", async () => {
    const tool = safeTool("demo", async () => "plain text");
    expect(textOf(await tool({}, noExtra))).toBe("plain text");
  });

  it("does not mark a success as an error", async () => {
    const tool = safeTool("demo", async () => ({ ok: true }));
    expect((await tool({}, noExtra)).isError).toBeUndefined();
  });

  it("redacts registered secrets from a successful result", async () => {
    registerSecret("hbr_supersecret");
    const tool = safeTool("demo", async () => ({ key: "hbr_supersecret" }));

    expect(textOf(await tool({}, noExtra))).not.toContain("hbr_supersecret");
  });
});

describe("safeTool failure results", () => {
  it("marks a thrown failure with isError so clients can detect it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tool = safeTool("demo", async () => {
      throw new ConsoleApiError({ message: "bucket not found", status: 404 });
    });

    const result = await tool({}, noExtra);

    // Without this flag the MCP client sees a *successful* tool call whose text
    // happens to describe a failure, and cannot branch on it.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("bucket not found");
  });

  it("marks an Effect/runPromise rejection with isError too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tool = safeTool("demo", async () =>
      runtime.runPromise(Effect.fail(new ConsoleApiError({ message: "denied", status: 403 }))),
    );

    const result = await tool({}, noExtra);

    expect(result.isError).toBe(true);
    // The FiberFailure's own message is the useless "An error has occurred";
    // isError must not come at the cost of losing the unwrapped detail.
    expect(textOf(result)).toContain("denied");
    expect(textOf(result)).not.toBe("An error has occurred");
  });

  it("redacts registered secrets from an error result", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    registerSecret("hbr_leaky");
    const tool = safeTool("demo", async () => {
      throw new ConsoleApiError({ message: "auth failed for hbr_leaky" });
    });

    const result = await tool({}, noExtra);

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain("hbr_leaky");
  });
});

describe("cancellation (F10)", () => {
  it("hands the MCP request's extra to the handler", async () => {
    // The signal lives on `extra`, the second argument the MCP SDK passes. The
    // wrapper used to accept only `args`, so it was dropped before any handler
    // could see it.
    let seen: unknown;
    const tool = safeTool("demo", async (_args: unknown, extra: unknown) => {
      seen = extra;
      return { ok: true };
    });
    const extra = { signal: new AbortController().signal };

    await tool({}, extra as never);

    expect(seen).toBe(extra);
  });

  it("aborting the request interrupts the effect instead of leaving it running", async () => {
    const controller = new AbortController();
    let completed = false;

    const tool = safeTool("demo", async (_args: unknown, extra: { signal: AbortSignal }) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          yield* Effect.sleep("5 seconds");
          completed = true;
          return "done";
        }),
        { signal: extra.signal },
      );
    });

    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    const result = await tool({}, { signal: controller.signal } as never);

    expect(result.isError).toBe(true);
    // Without propagation the work runs to completion after the caller is gone —
    // for a real transfer that means uploads, decryption, and file writes
    // continuing minutes after cancellation.
    expect(completed).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
