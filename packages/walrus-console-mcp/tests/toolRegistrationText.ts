/**
 * Shared text-scan helpers for asserting how `bin/console-mcp.ts` wires a
 * tool's `inputSchema`, without importing that file — which starts the real
 * stdio server as a side effect (same reasoning as manifestSync.test.ts).
 *
 * Originally introduced for the COMG-826 confirm-gate wiring check
 * (tests/deleteConfirmWiring.test.ts) and factored out here once a second
 * tool (generate_api_key, COMG-1054) needed the identical check.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const CONSOLE_MCP_SRC = fs.readFileSync(
  path.join(__dirname, "..", "bin", "console-mcp.ts"),
  "utf-8",
);

/**
 * The full `registerTool("name", { ... })` call for one tool, up to (not
 * including) the next `registerTool(` call. `\s*` between the paren and the
 * name (not a hardcoded newline + 2 spaces) matches manifestSync.test.ts's
 * own regex, so both stay equally tolerant of incidental reformatting.
 */
export function toolRegistrationBlock(src: string, toolName: string): string {
  const match = new RegExp(`registerTool\\(\\s*"${toolName}"`).exec(src);
  if (!match) throw new Error(`registerTool("${toolName}", ...) not found`);
  const nextCallStart = src.indexOf("registerTool(", match.index + 1);
  return src.slice(match.index, nextCallStart === -1 ? undefined : nextCallStart);
}

/**
 * The balanced `{ ... }` object literal that follows `key:` in `text`, found
 * by brace-counting rather than a regex that stops at the first `}` — every
 * field so far is brace-free, but this shouldn't quietly start matching past
 * the object's actual close if that changes.
 */
export function balancedObjectAfter(text: string, key: string): string {
  const keyIndex = text.indexOf(key);
  if (keyIndex === -1) throw new Error(`"${key}" not found`);
  const braceStart = text.indexOf("{", keyIndex);
  let depth = 0;
  let i = braceStart;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
      i++;
      break;
    }
  }
  return text.slice(braceStart, i);
}

/**
 * The `inputSchema: { ... }` object literal within one tool's registration
 * block. Narrower than matching the whole registration block (review finding
 * on PR #44): a mention of a field name in the handler body or in a comment
 * must NOT satisfy a check against this, only one that is actually part of
 * the schema the SDK validates against.
 */
export function inputSchemaBlockOf(src: string, toolName: string): string {
  return balancedObjectAfter(toolRegistrationBlock(src, toolName), "inputSchema:");
}
