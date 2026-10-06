import { isAllowedBaseUrl, isLoopbackUrl } from "./baseUrl.js";

/**
 * Bounded, not unlimited: a legitimate redirect chain here is at most one hop
 * (Console → an approved storage/CDN host), so a longer chain is itself
 * suspicious rather than something to patiently keep following.
 *
 * Counts total `fetch()` calls, not redirects followed — the first call is
 * the original request, not a redirect — so this permits at most
 * `MAX_FETCHES - 1` followed redirects. Named for what the loop below
 * actually counts, rather than "MAX_REDIRECTS", which would overstate it by
 * one.
 */
const MAX_FETCHES = 3;

/**
 * Thrown when a redirect target fails the redirect-specific policy below.
 * Named only the HOST, never the full target: the message
 * reaches `ConsoleApiError` verbatim, which an MCP tool result returns to the
 * caller — a hostile Console could otherwise put attacker-chosen text (the
 * rest of the URL: path, query, fragment) in front of whatever's reading the
 * tool output. Mirrors `DisallowedRedirectError`'s own host-only convention
 * in `ConsoleApiClient.ts`.
 */
export class UnapprovedRedirectError extends Error {
  constructor(location: string) {
    super(`Refused to follow a redirect to an unapproved host: ${hostOf(location)}`);
    this.name = "UnapprovedRedirectError";
  }
}

/** The host of `url`, or a fixed placeholder if it doesn't parse. Never throws. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<unparseable Location>";
  }
}

/** Statuses the Fetch spec treats as a redirect. Everything else in [300, 400) — a 300 or a 304 with a stray Location — is not one and is returned to the caller as-is. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * A redirect target must pass `isAllowedBaseUrl`, but that alone is not a safe
 * redirect-target policy: it treats loopback as globally
 * trusted, which is right for "may a human configure `CONSOLE_API_BASE_URL`
 * here" and wrong for "may a server's redirect send
 * us here" — see `isLoopbackUrl`'s own doc comment in `baseUrl.ts`. A
 * redirect INTO loopback is honored only when the CURRENT hop already
 * started there (local dev testing against a real localhost server); a
 * non-loopback hop can never be redirected into loopback.
 */
function isAllowedRedirectTarget(currentUrl: string, nextUrl: string): boolean {
  if (!isAllowedBaseUrl(nextUrl)) return false;
  return !isLoopbackUrl(nextUrl) || isLoopbackUrl(currentUrl);
}

/**
 * Header names a redirect must never carry across an origin change.
 *
 * The first three are credentials. `x-console-client` is not: it is attribution
 * (COMG-1053) and grants nothing. It is stripped anyway because only Console reads
 * it, so forwarding it to a CDN buys nothing, and because it is the one header that
 * would otherwise travel where `Authorization` deliberately does not. Harmless while
 * the value is a static constant; the point is that it stays harmless if it ever
 * stops being one.
 */
const CROSS_ORIGIN_STRIPPED_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-console-client",
];

/**
 * Drop credential-bearing headers on a cross-origin hop.
 * `fetch`'s own `redirect: "follow"` does this per the
 * Fetch spec's HTTP-redirect-fetch algorithm — but this guard always uses
 * `redirect: "manual"` so it can inspect `Location` before connecting
 * anywhere, which means undici's auto-follow (and its header stripping)
 * never runs. Nothing else strips these, so without this function they
 * were replayed verbatim to any origin `isAllowedRedirectTarget` accepts —
 * an *.walrus.xyz CDN, say, has no business receiving the Console API key
 * that only Console itself should see.
 */
function headersForHop(
  headers: RequestInit["headers"],
  currentUrl: string,
  nextUrl: string,
): RequestInit["headers"] {
  if (!headers) return headers;
  if (new URL(currentUrl).origin === new URL(nextUrl).origin) return headers;
  const next = new Headers(headers);
  for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) next.delete(name);
  return next;
}

/**
 * `init` for the next hop. Simplified from the Fetch spec's own method/body
 * rules: 301/302/303 always downgrade to a bodyless GET
 * rather than the spec's method-dependent carve-outs, and 307/308 preserve
 * the method but never the body — so this client never re-POSTs a
 * multipart upload or a JSON body to a redirect target, regardless of the
 * original status/method combination or whether the hop is same-origin. A
 * compromised or impersonated Console could otherwise answer a multipart
 * upload with a 307/308 and receive the request body — the encrypted file
 * bytes — even though `headersForHop` already strips the credential.
 */
/**
 * Drop `Content-Type` once the body it describes is gone. Every branch below
 * discards the body, so a stale `Content-Type: multipart/form-data; …` (or
 * any other) would otherwise ride along on a request that no longer carries
 * what it claims to.
 */
function headersWithoutStaleContentType(headers: RequestInit["headers"]): RequestInit["headers"] {
  if (!headers) return headers;
  const next = new Headers(headers);
  next.delete("content-type");
  return next;
}

function nextHopInit(
  prevInit: RequestInit,
  currentUrl: string,
  nextUrl: string,
  status: number,
): RequestInit {
  const forHop = headersForHop(prevInit.headers, currentUrl, nextUrl);
  const headers = headersWithoutStaleContentType(forHop);
  // Included conditionally, not as `headers: undefined`: exactOptionalPropertyTypes
  // forbids an explicit undefined on RequestInit's optional `headers`.
  const headersPatch = headers === undefined ? {} : { headers };
  if (status === 307 || status === 308) {
    // Method is preserved per spec (that is 307/308's whole reason to exist
    // over 301/302/303), but body is dropped unconditionally — origin does
    // not matter here. A bodyless method carries nothing to exfiltrate, so
    // there is no case where replaying it is the unsafe part.
    const { body: _body, ...rest } = prevInit;
    return { ...rest, ...headersPatch };
  }
  const { method: _method, body: _body, ...rest } = prevInit;
  return { ...rest, ...headersPatch, method: "GET" };
}

/**
 * `fetch`, except a redirect is never followed unless its target passes
 * `isAllowedRedirectTarget`. Contract:
 *
 *  - Manual redirects only (`redirect: "manual"` on every hop) — a hop is
 *    inspected before this ever connects to it, not after.
 *  - Each `Location` must resolve to a URL `isAllowedRedirectTarget` accepts;
 *    anything else throws `UnapprovedRedirectError` before a connection is
 *    made.
 *  - Credential headers (Authorization, Cookie, Proxy-Authorization) are
 *    dropped on a cross-origin hop. The body never survives any redirect
 *    (301/302/303 downgrade to a bodyless GET; 307/308 keep the method but
 *    drop the body too) — see `nextHopInit`.
 *  - Bounded to `MAX_FETCHES` total requests (the original one plus followed
 *    redirects).
 *  - `input` as a `Request` with a body throws — see `requestInitOf`.
 *
 * Typed as `typeof fetch` (not just `(url: string, init) => …`) so it can
 * also be installed as `@effect/platform`'s `FetchHttpClient.Fetch`
 * override — see `runtime.ts`.
 */
export async function fetchWithRedirectGuard(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  let currentUrl = urlOf(input);
  let currentInit = requestInitOf(input, init);
  for (let fetches = 1; ; fetches++) {
    const response = await fetch(currentUrl, { ...currentInit, redirect: "manual" });
    if (!isRedirectStatus(response.status)) return response;
    const location = response.headers.get("location");
    // A redirect status with no Location header is not actionable — return it
    // as-is and let the caller's own status-code handling report the failure.
    if (!location) return response;
    // Never returned to the caller past this point: drop it now rather than
    // leave it dangling on whatever this hop's connection was, which a
    // long-lived MCP process would otherwise hold open indefinitely.
    await response.body?.cancel().catch(() => {});
    // Checked BEFORE computing the next hop, and named against `currentUrl` —
    // the URL that was just actually fetched (and answered with yet another
    // redirect) — rather than the target it points to, which this call never
    // requests.
    if (fetches >= MAX_FETCHES) {
      throw new Error(
        `Too many redirects (> ${MAX_FETCHES - 1}) starting from ${urlOf(input)}; still ` +
          `redirecting at ${currentUrl}`,
      );
    }
    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      // Unparseable is a refusal, not an internal error — otherwise it escapes as
      // a TypeError and the callers' UnapprovedRedirectError checks miss it.
      throw new UnapprovedRedirectError(location);
    }
    if (!isAllowedRedirectTarget(currentUrl, nextUrl)) {
      throw new UnapprovedRedirectError(nextUrl);
    }
    currentInit = nextHopInit(currentInit, currentUrl, nextUrl, response.status);
    currentUrl = nextUrl;
  }
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * `Request` as `input`: both of this client's direct callers and
 * @effect/platform's own internal caller always pass a plain URL string
 * instead, so this only matters for a hypothetical future caller. A
 * bodyless `Request` (e.g. `fetch(new Request(url))`) is honored correctly
 * by forwarding its method/headers; one WITH a body throws rather than
 * silently dropping it, since a `Request`'s body can only be read once and
 * re-deriving the `duplex` option `fetch` requires for a streamed body is
 * not worth supporting for a call shape nothing in this codebase uses.
 */
function requestInitOf(input: string | URL | Request, init: RequestInit | undefined): RequestInit {
  if (!(input instanceof Request)) return init ?? {};
  if (input.body) {
    throw new Error(
      "fetchWithRedirectGuard: a Request object with a body is not supported — call it as " +
        "fetchWithRedirectGuard(url, init) instead.",
    );
  }
  return { method: input.method, headers: input.headers, ...init };
}
