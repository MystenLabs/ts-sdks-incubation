/**
 * Console API base-URL policy.
 *
 * The API key is attached as `Authorization: Bearer <key>` to every request, so
 * an attacker who can set `CONSOLE_API_BASE_URL` (env) or write it into the
 * config file could redirect the live key to a host they control. Confine the
 * base URL to https on a walrus.xyz host, or http(s) to loopback for local
 * dev.
 *
 * Dependency-free on purpose: the installer imports this without pulling in
 * Effect. Keep `DEFAULT_CONSOLE_API_BASE_URL` in sync with the default in
 * `manifest.json` (`user_config.console_api_base_url.default`), which cannot
 * import it — asserted by tests/manifestSync.test.ts.
 */

/**
 * Canonical Console API deployments, one per Sui network. `resolveSuiNetwork`
 * exact-matches these hosts before falling back to its heuristic, so a user on
 * the defaults never depends on hostname guessing.
 *
 * No trailing slash: callers append absolute paths (`${baseUrl}/api/v1/...` and
 * `HttpClientRequest.prependUrl`), so one here would produce `//api/v1/...`.
 * The deployed API tolerates the double slash, but the URLs it logs and reports
 * would carry it.
 */
export const CONSOLE_API_BASE_URLS = {
  mainnet: "https://api.console.walrus.xyz",
  testnet: "https://api.testnet.console.walrus.xyz",
} as const;

/**
 * The Console web apps users visit to mint API keys, keyed by the same
 * networks. The installer derives its "get your key at ..." guidance from the
 * RESOLVED base URL through this map, so pointing `CONSOLE_API_BASE_URL` at
 * testnet also switches the on-screen directions to the testnet Console.
 */
export const CONSOLE_WEB_URLS = {
  mainnet: "https://console.walrus.xyz",
  testnet: "https://testnet.console.walrus.xyz",
} as const;

/**
 * Mainnet: the published package targets real users; testnet is the staging/QA
 * environment, opted into via `CONSOLE_API_BASE_URL`.
 */
export const DEFAULT_CONSOLE_API_BASE_URL = CONSOLE_API_BASE_URLS.mainnet;

/**
 * User-content download hosts (COMG-817).
 *
 * Once the Console activates `UGC_HOST`, the Bearer download endpoint stops
 * serving file bytes and answers 307 to a short-lived token URL on the
 * network's user-content host. That is the ONLY redirect the MCP follows:
 * https, a single hop, to exactly this host for the session's network, and
 * never carrying the Authorization header — the token in the URL is the whole
 * grant. Hosts are pinned per network rather than suffix-matched so a testnet
 * session cannot be bounced to a sibling host.
 */
export const UGC_DOWNLOAD_HOSTS = {
  testnet: "testnet-files.walrususercontent.com",
  mainnet: "files.walrususercontent.com",
} as const;

/**
 * True if `raw` is the one redirect target the download path may follow:
 * https, no embedded credentials, and exactly the UGC host for `network`.
 */
export function isAllowedUgcRedirectUrl(
  raw: string,
  network: keyof typeof UGC_DOWNLOAD_HOSTS,
): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  // Minted token URLs are always default-port https; an explicit port is
  // off-shape (and `hostname` comparison alone would not catch it).
  if (url.port !== "") return false;
  return url.hostname.toLowerCase() === UGC_DOWNLOAD_HOSTS[network];
}

/**
 * True if `raw` is an allowed Console base URL: https to `walrus.xyz` /
 * `*.walrus.xyz` (boundary-safe suffix), or http(s) to loopback
 * (localhost / 127.0.0.1 / ::1). Anything unparseable or off-policy is rejected.
 */
export function isAllowedBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (url.protocol === "http:") return loopback;
  if (url.protocol !== "https:") return false;
  return loopback || host === "walrus.xyz" || host.endsWith(".walrus.xyz");
}
