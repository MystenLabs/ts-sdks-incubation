import type { KeyServerConfig } from "@mysten/seal";

import { SealProxyError } from "./errors";
import type { SuiNetwork } from "./packageConfig";

/**
 * Seal key server configuration, resolved per Sui network.
 *
 * Two facts drive everything in this file, and they pull in opposite directions:
 *
 * 1. The committee object ID is an on-chain identifier published by Seal that decides who can
 *    release decryption keys for our users' data. It is bound into every ciphertext at encrypt
 *    time, so it is a trust boundary and lives in reviewed, versioned code — never in env.
 * 2. Requests never reach Seal's aggregator directly. Mainnet's aggregator requires an
 *    Enoki-issued `X-API-Key`, and neither a browser bundle nor a published npm package can
 *    hold one, so COMG-580 put the key behind the Console API: the client posts its signed
 *    `fetch_key` to `${baseUrl}/api/v1/seal/aggregator`, the API adds the key and forwards it.
 *    That endpoint is the same on every network — the API picks the upstream gateway itself
 *    from `SEAL_AGGREGATOR_URL_MAINNET` / `_TESTNET`, so nothing here has to know which is in
 *    play, and no Seal credential exists on this side at all.
 *
 * So the aggregator is *transport* and follows `CONSOLE_API_BASE_URL`, while the committee is
 * *trust* and is pinned below. Mirrors console `frontend/src/lib/seal/config.ts` (COMG-511) so
 * the MCP and the web app encrypt against the same committee and stay mutually decryptable.
 *
 * Values: https://seal-docs.wal.app/Pricing#verified-decentralized-key-servers
 */

/** Path the Console API mounts its Seal `fetch_key` proxy on (harbor `api/src/api/routes/seal.ts`). */
const AGGREGATOR_PROXY_PATH = "/api/v1/seal/aggregator";

/**
 * Header the proxy authenticates. Unlike the frontend — which rides a session cookie and needs
 * @mysten/seal ≥ 1.4.0's `fetch` option to send it — the MCP already authenticates every
 * Console call with a Bearer key, and the SDK has spelled arbitrary headers as
 * `apiKeyName`/`apiKey` since well before then. The proxy accepts either
 * (`requireSessionOrApiKey`), so no SDK bump is needed here.
 */
const AUTH_HEADER = "Authorization";

interface SealNetworkConfig {
  /**
   * Decentralized (committee) KeyServer object ID.
   *
   * Stable across committee rotation: `try_finalize_for_rotation` moves this very object to the
   * new committee and mutates its member list in place, leaving the object ID and the aggregate
   * public key untouched — so rotation never invalidates existing ciphertext. The ID changes only
   * if the committee is replaced wholesale, which is a trust-boundary change that belongs in a PR.
   */
  readonly committeeObjectId: string;
}

const SEAL_NETWORK_CONFIGS: Record<SuiNetwork, SealNetworkConfig> = {
  testnet: {
    committeeObjectId: "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98",
  },
  mainnet: {
    committeeObjectId: "0x686098f1439237fff9f36b99c7329683c22979d2005c2465cb891acb012a7595",
  },
};

export interface ResolvedSealConfig {
  readonly serverConfigs: KeyServerConfig[];
  /** Shares required to decrypt — see the derivation note in `resolveSealConfig`. */
  readonly threshold: number;
}

/**
 * Build the SealClient key server configuration for a network.
 *
 * `consoleBaseUrl` is the already-allowlisted `CONSOLE_API_BASE_URL` (see `baseUrl.ts`), and
 * `consoleApiKey` the Bearer key sent to it. There is deliberately **no** separate aggregator
 * override env var: it would be a second, un-allowlisted way to choose where a live
 * `Authorization: Bearer` header gets sent, which is exactly the redirection `isAllowedBaseUrl`
 * exists to prevent. Pointing the MCP at a different deployment is what `CONSOLE_API_BASE_URL`
 * is for, and the aggregator follows it for free.
 */
export function resolveSealConfig(
  network: SuiNetwork,
  consoleBaseUrl: string,
  consoleApiKey: string,
): ResolvedSealConfig {
  const networkConfig = SEAL_NETWORK_CONFIGS[network];
  if (!networkConfig) {
    throw new Error(
      `Seal is not configured for Sui network "${network}" — only testnet and mainnet have a committee key server.`,
    );
  }

  // Trailing slashes are against the documented base-URL convention, but a config file or env
  // var can still carry one; strip it so the SDK's `${url}/v1/fetch_key` stays single-slashed.
  const aggregatorUrl = `${consoleBaseUrl.replace(/\/+$/, "")}${AGGREGATOR_PROXY_PATH}`;

  const serverConfigs: KeyServerConfig[] = [
    {
      objectId: networkConfig.committeeObjectId,
      aggregatorUrl,
      weight: 1,
      // Omitted rather than sent empty when unset: the SDK only attaches the header when both
      // halves are truthy, so an unconfigured MCP gets a clean 401 from the proxy instead of a
      // malformed `Authorization: Bearer ` that is harder to read in a log.
      ...(consoleApiKey ? { apiKeyName: AUTH_HEADER, apiKey: `Bearer ${consoleApiKey}` } : {}),
    },
  ];

  return {
    serverConfigs,
    // All-of-N over the configured entries. With a single committee that is 1: the threshold
    // that matters is enforced inside the committee (testnet 3-of-5, mainnet 5-of-8), not here.
    threshold: serverConfigs.reduce((total, { weight }) => total + weight, 0),
  };
}

/**
 * Prefix the Console API puts on every locally generated `fetch_key` failure (harbor
 * `api/src/api/middleware/seal-sdk-error-envelope.middleware.ts`, COMG-511).
 *
 * Matching on the message rather than the HTTP status is deliberate and load-bearing.
 * `SealAPIError.assertResponse` calls `#generate(error, message, requestId)` without the
 * status whenever the body parses as JSON, which the proxy's always does, so `status` is
 * `undefined` on every real response and only ever set for a non-JSON body. Probed against
 * `@mysten/seal` 1.3.8 with the proxy's own bodies:
 *
 *   503 not_configured -> GeneralError  status=undefined  message="console:not_configured"
 *   429 rate limited   -> GeneralError  status=undefined  message="console:TooManyRequestsError"
 *   502 upstream       -> GeneralError  status=undefined  message="console:upstream_error"
 *   403 access denied  -> NoAccessError status=undefined  (Seal's own copy, untouched)
 *
 * The last row is why a denial never reaches this function: Seal names it, so the SDK
 * builds a typed `NoAccessError` and the `console:` prefix is absent.
 */
const CONSOLE_ERROR_PREFIX = "console:";

/**
 * Console codes reachable on `POST /api/v1/seal/aggregator/v1/fetch_key`, mapped to what a
 * caller should do. Sourced from harbor `domain/shared/errors.ts` and `routes/seal.ts`, not
 * invented here.
 *
 * Derive new entries from the **emitter**, not from the api-key middleware's
 * `mapFailureToResponseCode`. What lands on the wire is `respondWithProxyError`'s
 * `code: err.code ?? err._tag`, so a tagged error that declares no `code` contributes its
 * bare `_tag` — a value the mapper never returns and which is easy to miss by reading the
 * mapper alone (`UnknownError` below). The mirror of that mistake is reading
 * `getFailureHint`, whose values (`invalid_key`, `key_revoked`, ...) are audit reasons that
 * never reach the wire at all.
 *
 * A `Map`, not an object literal: the key is a string this MCP does not control, and an
 * object lookup for a code like `constructor` or `toString` resolves through
 * `Object.prototype` and returns an inherited function instead of `undefined`, defeating the
 * `?? "unknown"` fallback below.
 */
const CONDITION_BY_CODE = new Map<string, SealProxyError["condition"]>(
  Object.entries<SealProxyError["condition"]>({
    // Proxy-side outages.
    not_configured: "disabled",
    TooManyRequestsError: "rate_limited",
    upstream_error: "unavailable",
    upstream_unavailable: "unavailable",
    // `catchAllDefect` promotes every unexpected defect in the proxy handler to this tag,
    // which declares no `code` — so the tag itself is the wire code on a 500.
    UnknownError: "unavailable",
    // Only synthesized when the aggregator answers 401, which harbor remaps to a 502. Its own
    // comment is explicit that a 401 there is always Kong rejecting the Console's Enoki key,
    // so this is a permanent server-side misconfiguration, not a transient outage.
    aggregator_auth_failed: "misconfigured",
    // This MCP's own credentials.
    unauthorized: "credential",
    read_only_api_key: "credential",
    api_key_registering: "credential",
    api_key_revoking: "credential",
    api_key_revoked: "credential",
    api_key_not_usable: "credential",
    mirror_missing_grant: "credential",
    bucket_not_in_scope: "credential",
    sessionkey_address_mismatch: "credential",
    // Wire-contract drift.
    invalid_request: "request",
  }),
);

const GUIDANCE: Record<SealProxyError["condition"], string> = {
  disabled:
    "The Console deployment has its Seal fetch_key proxy switched off, so private files cannot be decrypted there. Nothing to fix on this side; ask whoever operates that Console to enable it.",
  rate_limited: "The Console rate limiter refused this fetch_key request. Retry after a pause.",
  unavailable:
    "The Console could not reach Seal's key-server aggregator. Transient; retry, and escalate if it persists.",
  misconfigured:
    "The Console's own credential for Seal's key-server aggregator was rejected upstream. Retrying will not clear it and there is nothing to fix on this side; ask whoever operates that Console to check the aggregator key.",
  credential:
    "The Console rejected this MCP's credentials for fetch_key. Check that CONSOLE_API_KEY is active and has the scope for this bucket, and that CONSOLE_SERVICE_PRIVATE_KEY is the signer registered for it.",
  request:
    "The Console rejected the fetch_key request body, which means this MCP and that Console disagree on the wire contract. Upgrade the MCP, or point it at a matching Console.",
  unknown:
    "The Console rejected this fetch_key request with a code this MCP build does not recognise. Treat the code below as the source of truth.",
};

/** Pull a `console:<code>` token out of an error, following one level of `cause`. */
function consoleErrorCode(cause: unknown): string | undefined {
  for (
    let node = cause, depth = 0;
    node instanceof Error && depth < 2;
    node = node.cause, depth++
  ) {
    if (node.message.startsWith(CONSOLE_ERROR_PREFIX)) {
      const code = node.message.slice(CONSOLE_ERROR_PREFIX.length).trim();
      if (code) return code;
    }
  }
  return undefined;
}

/**
 * COMG-605 — classify a `SealClient.decrypt` failure that came from the Console proxy.
 *
 * Returns `undefined` for anything else, so Seal's own typed errors (`NoAccessError`,
 * `InvalidPTBError`, ...) and local faults keep their existing handling. Pure, so it is
 * testable without a live backend, and reusable by any future call site that wraps
 * `SealClient` (encrypt does not reach the aggregator today).
 */
export function interpretSealProxyFailure(cause: unknown): SealProxyError | undefined {
  const code = consoleErrorCode(cause);
  if (code === undefined) return undefined;
  const condition = CONDITION_BY_CODE.get(code) ?? "unknown";
  return new SealProxyError({
    message: `Seal fetch_key failed at the Console proxy (${code}). ${GUIDANCE[condition]}`,
    cause,
    condition,
    code,
  });
}
