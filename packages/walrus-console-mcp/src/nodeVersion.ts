/**
 * The runtime floor check.
 *
 * package.json `engines.node`, manifest.json `compatibility.runtimes.node`,
 * both tsdown `target`s and the CI matrix all already state this floor, and
 * tests/nodeVersion.test.ts pins every one of them to the constant below. They
 * disagreed once before (manifest >=22 against engines >=24), which is the
 * reason the number has one home now.
 *
 * 22, not 24, since #74: the strictest runtime dependency is `@mysten/sui`,
 * which declares `>=22`, and the 24 came from the ts-sdks-incubation pnpm
 * workspace rather than from anything this package runs. 18 and 20 are EOL. What was missing was
 * anything that *enforces* it. npm's EBADENGINE is a warning that scrolls past
 * during install, so the first real symptom arrives much later and names
 * neither the requirement nor the running version. Reproduced on Node 18.20.4:
 *
 *   SyntaxError: The requested module 'node:util' does not provide an export
 *   named 'styleText'
 *
 * Deliberately dependency-free: this module has to run on the versions it
 * exists to refuse, so it may not import anything that might not be there. The
 * syntax floor it can actually defend is around Node 14 (`??` is ES2020) and in
 * practice Node 16, since bin/console-mcp.ts uses top-level await. That is far
 * below anything anyone has reported, which is the point. For the
 * same reason it must never import `styleText` to colour its own message, which
 * is the export whose absence produces the error quoted above.
 */

/** The lowest Node major this package supports. One number, four declarations. */
export const MIN_NODE_MAJOR = 22;

/**
 * Major version of a `process.versions.node` string ("24.1.0"), or null when it
 * cannot be read as one. Null fails OPEN: a runtime whose version we cannot
 * parse is one we cannot judge, and refusing to start on a guess is worse than
 * running on a host that turns out to be fine.
 */
export function nodeMajor(version: string): number | null {
  const match = /^(\d+)\./.exec(version.trim());
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : null;
}

/**
 * The refusal for `version`, or null when it is supported. Pure, so the wording
 * is asserted in tests without spawning a process.
 */
export function unsupportedNodeMessage(
  version: string = process.versions.node,
  min: number = MIN_NODE_MAJOR,
): string | null {
  const major = nodeMajor(version);
  if (major === null || major >= min) return null;
  return (
    `walrus-console-mcp needs Node ${min} or newer. This is Node v${version}.\n` +
    `Install Node ${min}+ from https://nodejs.org/en/download, then run the command again.`
  );
}

export interface AssertNodeDeps {
  /** Where the refusal goes. See the note below on why it is never stdout. */
  write?: (text: string) => void;
  exit?: (code: number) => void;
}

/**
 * Print the refusal and exit 1, or return and let the caller continue.
 *
 * stderr, never stdout: on the server path stdout carries the MCP JSON-RPC
 * stream, and a plain-text line written there is a protocol error rather than a
 * message anyone reads.
 */
export function assertSupportedNode(
  version: string = process.versions.node,
  deps: AssertNodeDeps = {},
): void {
  const message = unsupportedNodeMessage(version);
  if (message === null) return;
  (deps.write ?? ((text: string) => void process.stderr.write(text)))(`${message}\n`);
  (deps.exit ?? ((code: number) => process.exit(code)))(1);
}
