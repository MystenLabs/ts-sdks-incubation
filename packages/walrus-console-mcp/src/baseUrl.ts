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
 * Effect. The .mcpb manifest has no base-URL field of its own — an extension
 * install always resolves to this default; testnet needs `CONSOLE_API_BASE_URL`
 * set directly in the environment the server runs in.
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
 * https on the default port, no embedded credentials, and exactly the UGC
 * host for `network`. The minted token URLs never carry an explicit port, so
 * any URL that does is off-shape and refused.
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
  if (url.port !== "") return false;
  return url.hostname.toLowerCase() === UGC_DOWNLOAD_HOSTS[network];
}

/**
 * True for a dotted-quad in `127.0.0.0/8` — the WHOLE IPv4 loopback block
 * (RFC 5735), not just `127.0.0.1`. `127.0.0.2`, `127.1.2.3`, etc. are all
 * genuinely loopback, and matching only the one address is not a security
 * gain: it just means a dev server bound to a different loopback address is
 * wrongly treated as non-loopback.
 */
function isLoopbackIPv4(hostname: string): boolean {
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return match !== null && match.slice(1).every((octet) => Number(octet) <= 255);
}

/** Shared by `isAllowedBaseUrl` and `isLoopbackUrl` below — one definition of "loopback". */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "::1" || host === "[::1]" || isLoopbackIPv4(host);
}

/**
 * True if `raw` parses to a loopback address (localhost, the `127.0.0.0/8`
 * block, or `::1`), independent of scheme.
 *
 * NOT covered, deliberately: alternate encodings a browser or `curl` might
 * still resolve as loopback — IPv4-mapped IPv6 (`::ffff:127.0.0.1`), decimal
 * or octal/hex forms of the address (`2130706433`, `0177.0.0.1`), or a bare
 * `0.0.0.0`. Anything not recognized here falls through to `isAllowedBaseUrl`'s
 * normal allowlist and is refused unless it separately matches an approved
 * host — fails closed, at the cost of a false negative on those forms rather
 * than a false positive.
 *
 * Exported for `safeFetch.ts`: `isAllowedBaseUrl` below
 * answers "may a human point `CONSOLE_API_BASE_URL` here", which rightly
 * says yes for loopback (local dev against a real localhost server) — but
 * that is the wrong question for "may a redirect a SERVER sent us follow to
 * here". Reusing `isAllowedBaseUrl` as-is for both let a compromised or
 * impersonated *production* Console 302 to `127.0.0.1` and still be
 * followed, reaching a service on the developer's own machine — exactly the
 * SSRF the security review exists to close. `safeFetch.ts` uses this to require that a
 * redirect INTO loopback only ever comes FROM loopback.
 */
export function isLoopbackUrl(raw: string): boolean {
  try {
    return isLoopbackHostname(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/**
 * True if `raw` is an allowed Console base URL: https to `walrus.xyz` /
 * `*.walrus.xyz` (boundary-safe suffix), or http(s) to loopback
 * (see `isLoopbackHostname`). Anything unparseable or off-policy is rejected.
 *
 * Answers "may this be configured as `CONSOLE_API_BASE_URL`", not "may a
 * redirect target land here" — see `isLoopbackUrl` above for why those are
 * different questions and `safeFetch.ts` layers an extra check on top of
 * this one for redirects specifically.
 */
export function isAllowedBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const loopback = isLoopbackHostname(host);
  if (url.protocol === "http:") return loopback;
  if (url.protocol !== "https:") return false;
  return loopback || host === "walrus.xyz" || host.endsWith(".walrus.xyz");
}
