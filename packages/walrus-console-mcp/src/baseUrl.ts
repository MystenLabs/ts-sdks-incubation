/**
 * Console API base-URL policy.
 *
 * The API key is attached as `Authorization: Bearer <key>` to every request, so
 * an attacker who can set `CONSOLE_API_BASE_URL` (env) or write it into the
 * config file could redirect the live key to a host they control. Confine the
 * base URL to https on a walrus.xyz host, the reviewed COMG-746/761 staging
 * host, or http(s) to loopback for local dev.
 *
 * Dependency-free on purpose: the installer imports this without pulling in
 * Effect. Keep `DEFAULT_CONSOLE_API_BASE_URL` in sync with the default in
 * `manifest.json` (`user_config.base_url.default`), which cannot import it.
 */

/**
 * No trailing slash: callers append absolute paths (`${baseUrl}/api/v1/...` and
 * `HttpClientRequest.prependUrl`), so one here would produce `//api/v1/...`.
 * The deployed API tolerates the double slash, but the URLs it logs and reports
 * would carry it.
 */
export const DEFAULT_CONSOLE_API_BASE_URL = "https://api.testnet.console.walrus.xyz";

/**
 * True if `raw` is an allowed Console base URL: https to `walrus.xyz` /
 * `*.walrus.xyz` (boundary-safe suffix), https to the COMG-746/761 staging
 * host `api.testnet.patestation.org` (exact match), or http(s) to loopback
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
  // `api.testnet.patestation.org` is the COMG-746/761 staging Console API
  // (authored `members` + `space-signers`). Exact host, not a suffix: a
  // look-alike `*.patestation.org.evil.com` must not inherit this.
  return (
    loopback ||
    host === "walrus.xyz" ||
    host.endsWith(".walrus.xyz") ||
    host === "api.testnet.patestation.org"
  );
}
