/**
 * Tells Console which surface a request came from. An API key is shared by every
 * headless client, so without this an MCP upload is indistinguishable from a
 * direct API integration in Console's analytics (COMG-1053). It is attribution,
 * never authorization — Console grants nothing on the strength of it.
 *
 * Its own module, with no imports, because `credentials.ts` needs the pair and it
 * is reached from `bin/install.ts` and `bin/configure.ts`. Importing it from
 * `ConsoleApiClient.ts` instead pulled Effect, `@effect/platform` and Zod into the
 * CLI's eager chunk for two strings: measured at +64 KB and roughly +610 ms on
 * every `install` and `configure` run.
 */
export const CLIENT_HEADER = "X-Console-Client";
export const CLIENT_HEADER_VALUE = "mcp";

// Two facts about a running MCP server travel as separate headers, both sent only
// by the long-running server. `X-Console-Client` cannot carry either:
// the installer's probe sends it too, so it would light before a harness ever
// started the server.

/** Env var the installer writes into each harness's server entry; the `.mcpb` sets `mcpb`. */
export const CLIENT_LABEL_ENV = "WALRUS_MCP_CLIENT";
/** The install-target label: which harness the server was registered into. */
export const TARGET_HEADER = "X-Console-Client-Target";
/** Runtime marker: the running server made this call. Whether or not a label is set. */
export const RUNTIME_HEADER = "X-Console-Client-Runtime";
export const RUNTIME_HEADER_VALUE = "1";
/** The name the harness reports in its `clientInfo` during initialize. */
export const REPORTED_NAME_HEADER = "X-Console-Client-Name";

/** Printable ASCII, bounded: a header value that fails this would make `fetch` throw. */
const HEADER_TOKEN = /^[\x20-\x7e]{1,64}$/;

let runtimeAttribution = false;
let reportedName: string | undefined;

/** Called once by the long-running server at startup. Nothing else turns this on. */
export function enableRuntimeAttribution(): void {
  runtimeAttribution = true;
}

/** Records the harness's `clientInfo.name`, from the server's initialize hook. */
export function setReportedClientName(name: string | undefined): void {
  reportedName = name;
}

/**
 * The attribution headers for one authenticated Console call. Empty outside the
 * running server, so the installer and any other process never sends them, whatever
 * its environment holds: a shell that inherits `WALRUS_MCP_CLIENT` still probes clean.
 */
export function runtimeClientHeaders(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (!runtimeAttribution) return {};
  const headers: Record<string, string> = { [RUNTIME_HEADER]: RUNTIME_HEADER_VALUE };
  const label = env[CLIENT_LABEL_ENV];
  if (label !== undefined && HEADER_TOKEN.test(label)) headers[TARGET_HEADER] = label;
  if (reportedName !== undefined && HEADER_TOKEN.test(reportedName)) {
    headers[REPORTED_NAME_HEADER] = reportedName;
  }
  return headers;
}
