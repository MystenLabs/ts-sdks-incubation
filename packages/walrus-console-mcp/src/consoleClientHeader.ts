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
