import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * `bin/console-mcp.ts` read as TEXT, not imported: importing it starts the real
 * stdio server as a side effect. Same reasoning as `manifestSync.test.ts` and
 * `deleteConfirmWiring.test.ts`.
 */
export const TOOL_SRC = readFileSync(
  fileURLToPath(new URL("../bin/console-mcp.ts", import.meta.url)),
  "utf-8",
);

/**
 * The `registerTool("<toolName>", …)` call, up to (not including) the next
 * `registerTool(` call, **with comments stripped**.
 *
 * Both parts matter and neither is optional:
 *
 * - `\s*` between the paren and the name — rather than a hardcoded newline and
 *   two spaces — keeps this as tolerant of incidental reformatting as
 *   `manifestSync.test.ts`'s own regex.
 * - Stripping comments before matching is what stops a wiring assertion from
 *   being satisfied by *commented-out* wiring. That is not hypothetical: the
 *   COMG-790 review verified that exact mutant survived before the strip was
 *   added.
 *
 * Lives here rather than in a test file because it had been copied verbatim
 * into two of them (`comg1039DownloadDest`, `downloadOverwriteWiring`) and the
 * rationale above only existed in one — the drift the PR #69 review called out.
 */
export function toolRegistrationBlock(toolName: string, src: string = TOOL_SRC): string {
  const match = new RegExp(`registerTool\\(\\s*"${toolName}"`).exec(src);
  if (!match) throw new Error(`registerTool("${toolName}", ...) not found`);
  const nextCallStart = src.indexOf("registerTool(", match.index + 1);
  return src
    .slice(match.index, nextCallStart === -1 ? undefined : nextCallStart)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}
