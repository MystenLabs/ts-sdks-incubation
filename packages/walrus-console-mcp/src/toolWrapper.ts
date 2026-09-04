import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatToolError, redactString } from "./redaction";
import { unwrapFiberFailure } from "./runtime";

/**
 * The single error boundary every MCP tool handler passes through.
 *
 * Lives here rather than in `bin/console-mcp.ts` so the contract it produces is
 * assertable without importing the entrypoint, which runs the redaction wiring
 * and the `install`/`config` argv branches as import side effects.
 */

/**
 * A tool result in the shape the MCP SDK expects back from a handler.
 *
 * Aliased from the SDK's own `CallToolResult` rather than redeclared: the SDK
 * type carries an index signature and a mutable `content` array, and a
 * hand-written structural copy silently stops being assignable to
 * `registerTool` when either detail changes.
 *
 * `isError` lives on that type and is set on failures only — the MCP spec reads
 * a missing flag as `false`, and emitting `isError: false` on every success adds
 * noise to a protocol message that is routinely read by hand while debugging.
 */
export type McpToolResult = CallToolResult;

/**
 * Wrap a tool handler so any throw — an Effect failure surfaced by `runPromise`,
 * a missing credential, an API error, a filesystem error — becomes a readable,
 * redacted text result flagged with `isError` instead of a silent "Result".
 *
 * `isError` is not cosmetic: without it a client sees a *successful* tool call
 * whose text happens to describe a failure, so it cannot branch on the outcome
 * and an agent reads the error prose as a result.
 *
 * `extra` is the MCP SDK's per-request context and is passed through rather than
 * dropped, because it carries the request's `AbortSignal`. A handler that ignores
 * it keeps uploading, decrypting, polling, and writing files long after the
 * caller cancelled and disconnected.
 */
export function safeTool<Args, Extra, T>(
  toolName: string,
  handler: (args: Args, extra: Extra) => Promise<T>,
) {
  return async (args: Args, extra: Extra): Promise<McpToolResult> => {
    try {
      const result = await handler(args, extra);
      const raw = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text: redactString(raw) }] };
    } catch (error) {
      // runPromise wraps failures in a FiberFailure whose message is the generic
      // "An error has occurred" — unwrap it so the typed error (and its fields,
      // for tagged errors) reaches the log and the tool output.
      const unwrapped = unwrapFiberFailure(error);

      console.error(`[console-mcp ERROR] Tool "${toolName}" failed:`);
      console.error(unwrapped);

      return {
        content: [
          {
            type: "text" as const,
            text: formatToolError(toolName, unwrapped),
          },
        ],
        isError: true,
      };
    }
  };
}
