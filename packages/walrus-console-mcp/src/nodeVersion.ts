// This guard must run before application imports on the old runtimes it rejects.
// Keep it dependency-free and use syntax those runtimes can parse.
const NODE_SECURITY_FLOORS = [
  { major: 22, minor: 23, patch: 4 },
  { major: 24, minor: 22, patch: 1 },
  { major: 26, minor: 12, patch: 1 },
] as const;

export const NODE_VERSION_RANGE = NODE_SECURITY_FLOORS.map(
  ({ major, minor, patch }) => `>=${major}.${minor}.${patch} <${major + 1}.0.0`,
).join(" || ");

export function unsupportedNodeMessage(version: string = process.versions.node): string | null {
  // Build metadata does not affect precedence. Prereleases cannot establish compliance.
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (match && match[0] === version) {
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    const floor = NODE_SECURITY_FLOORS.find((floor) => floor.major === major);
    if (
      floor &&
      Number.isSafeInteger(minor) &&
      Number.isSafeInteger(patch) &&
      (minor > floor.minor || (minor === floor.minor && patch >= floor.patch))
    ) {
      return null;
    }
  }
  return (
    `walrus-console-mcp needs a supported patched Node version (${NODE_VERSION_RANGE}). ` +
    `Detected Node version ${JSON.stringify(version)}.\n` +
    "Use a stable release on one of these supported lines. " +
    "Update the Node executable used by your MCP host, then restart the host or MCP process. " +
    "Download Node from https://nodejs.org/en/download."
  );
}

export interface AssertNodeDeps {
  write?: (text: string) => void;
  exit?: (code: number) => void;
}

export function assertSupportedNode(
  version: string = process.versions.node,
  deps: AssertNodeDeps = {},
): void {
  const message = unsupportedNodeMessage(version);
  if (message === null) return;
  // stdout carries the MCP JSON-RPC stream.
  (deps.write ?? ((text: string) => void process.stderr.write(text)))(`${message}\n`);
  (deps.exit ?? ((code: number) => process.exit(code)))(1);
}
