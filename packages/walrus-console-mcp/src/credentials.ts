/**
 * Credential formats, identification and live validation for the CLI.
 *
 * Kept free of I/O beyond an injectable `fetch` so every rule here is unit
 * testable without a terminal or a network. The one exception is
 * `decodeSuiPrivateKey`: it's a pure decode (no I/O), but pulls in
 * `@mysten/sui`, which is already a runtime dependency of this package (see
 * SealCryptoService) and is on the CLI's load path regardless — so using the
 * real decoder here instead of a hand-rolled prefix/length heuristic costs
 * nothing extra and catches garbled/truncated/wrong-thing pastes that the
 * heuristic could not.
 */

import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import type { CredentialValues } from "./cliArgs.js";
import type { ConfigFileData } from "./configFile.js";

export type CredentialChoice = "api" | "admin" | "both";
export type KeyKind = "api" | "admin";
export type ProbeVerdict = "ok" | "invalid" | "wrong-scope" | "unreachable";

export const API_KEY_PREFIX = "hbr_";
export const ADMIN_KEY_PREFIX = "hbradm_";
export const SERVICE_KEY_PREFIX = "suiprivkey1";

/**
 * The probe id for a management key. Any well-formed UUID works — the point is
 * that it does not exist, so an authenticated caller gets 404 rather than data.
 * The nil UUID is explicitly allowed by the API's `z.string().uuid()` validator.
 */
const PROBE_KEY_ID = "00000000-0000-0000-0000-000000000000";

/** A working (data-plane) key. `hbradm_` does NOT match `hbr_`, so this is exact. */
export function isValidApiKeyFormat(key: string): boolean {
  return key.startsWith(API_KEY_PREFIX) && key.length > 8;
}

/** A management (Key-Admin) key. */
export function isValidAdminKeyFormat(key: string): boolean {
  return key.startsWith(ADMIN_KEY_PREFIX) && key.length > 11;
}

/**
 * A Sui private key, checked by actually decoding it (Bech32 + checksum +
 * flag byte), not just eyeballing the `suiprivkey1…` prefix and a minimum
 * length. This catches garbled, truncated, and wrong-thing pastes.
 *
 * It does NOT catch a structurally valid key that belongs to something else —
 * a different-but-real signer decodes cleanly and is indistinguishable from
 * the right one until it's used. We cannot validate a signer against the API
 * — it never leaves the machine.
 */
export function isValidServiceKeyFormat(key: string): boolean {
  try {
    decodeSuiPrivateKey(key);
    return true;
  } catch {
    return false;
  }
}

/** Which kind of key this is, by prefix, or null if it is neither. */
export function keyKindOf(key: string): KeyKind | null {
  if (isValidAdminKeyFormat(key)) return "admin";
  if (isValidApiKeyFormat(key)) return "api";
  return null;
}

/**
 * The chooser is a statement of intent, so a key of the other type is rejected
 * rather than silently routed to the other slot: accepting a minting credential
 * when the user asked for an everyday key is a surprise that matters.
 * Returns null when the key matches the expected kind (or is unrecognizable —
 * the caller's format check reports that case).
 */
export function mismatchMessage(expected: KeyKind, key: string): string | null {
  const actual = keyKindOf(key);
  if (actual === null || actual === expected) return null;
  return expected === "api"
    ? `That's a management key. This step expects an everyday API key (${API_KEY_PREFIX}…). ` +
        `Re-run and choose "Management key", or paste your ${API_KEY_PREFIX} key.`
    : `That's an everyday API key. This step expects a management key (${ADMIN_KEY_PREFIX}…). ` +
        `Re-run and choose "API key", or paste your ${ADMIN_KEY_PREFIX} key.`;
}

/**
 * Turn a probe response status into a verdict.
 *
 * A working key is validated by a successful data-plane read. A management key
 * cannot read the data plane at all, so it is validated on a control-plane route
 * it *is* allowed to reach — `GET /api/v1/api-keys/{PROBE_KEY_ID}` for an id that
 * deliberately does not exist. Reaching the missing-resource 404 means the request
 * passed both authentication and the `key_admin` scope guard, which is the whole
 * signal. Confirmed live: valid management key → 404, working key → 403,
 * revoked key → 401.
 *
 * Only statuses that actually demonstrate that are accepted. An earlier version
 * returned "ok" for everything except 401/403, so a 500 or a 429 — which say
 * nothing about the credential — read as "verified", and the CLI persisted an
 * unusable key that failed later at mint time. Upstream failures are their own
 * verdict (retry), and any other unexpected status is not accepted either.
 */
const UPSTREAM_FAILURE = (status: number) => status === 429 || status >= 500;

export function classifyProbe(kind: KeyKind, status: number): ProbeVerdict {
  if (status === 401) return "invalid";
  if (status === 403) return "wrong-scope";
  // Checked before the success cases: an outage must never read as a verdict
  // about the key itself, in either direction.
  if (UPSTREAM_FAILURE(status)) return "unreachable";
  if (status >= 200 && status < 300) return "ok";
  // The management probe's success signal is the deliberate miss; a working key
  // has no such case — it is validated by the 2xx above.
  if (kind === "admin" && status === 404) return "ok";
  return "invalid";
}

/** Validate a key against the live API. Never throws; network failure is a verdict. */
export async function probeKey(
  kind: KeyKind,
  key: string,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeVerdict> {
  const path = kind === "api" ? "/api/v1/spaces" : `/api/v1/api-keys/${PROBE_KEY_ID}`;
  try {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    return classifyProbe(kind, res.status);
  } catch {
    return "unreachable";
  }
}

/** I/O the collection flow needs, injected so the flow itself stays testable. */
export interface CollectDeps {
  ask(question: string, opts?: { masked?: boolean }): Promise<string>;
  ok(msg: string): void;
  fail(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;
  probe(kind: KeyKind, key: string): Promise<ProbeVerdict>;
}

const PROMPTS = {
  apiKey: "CONSOLE_API_KEY (hbr_…): ",
  serviceKey: "CONSOLE_SERVICE_PRIVATE_KEY (suiprivkey1…): ",
  adminKey: "CONSOLE_ADMIN_KEY (hbradm_…): ",
  adminSigner: "CONSOLE_ADMIN_SERVICE_PRIVATE_KEY (suiprivkey1…): ",
} as const;

const ADMIN_WARNING =
  "Provisioning host only — this key mints credentials. Don't copy this file to workers.";

const verdictMessage = (verdict: ProbeVerdict, kind: KeyKind): string | null => {
  switch (verdict) {
    case "ok":
      return null;
    case "invalid":
      return "Key rejected — check the value and try again.";
    case "wrong-scope":
      return kind === "admin"
        ? "That key authenticated but is not a management key (revoked, or from another account)."
        : "That key authenticated but lacks data-plane access.";
    case "unreachable":
      // Covers a thrown fetch and an upstream 429/5xx alike. Deliberately does
      // not blame the key: in both cases we learned nothing about it, and the
      // old wording sent people hunting for a bad paste during an outage.
      return "Couldn't verify — Console is unreachable or erroring. Try again in a moment.";
  }
};

/** Prompt for one key until it is the right type and the probe accepts it. */
async function askForKey(kind: KeyKind, deps: CollectDeps): Promise<string> {
  const question = kind === "api" ? PROMPTS.apiKey : PROMPTS.adminKey;
  const isValidFormat = kind === "api" ? isValidApiKeyFormat : isValidAdminKeyFormat;
  const expectedPrefix = kind === "api" ? API_KEY_PREFIX : ADMIN_KEY_PREFIX;

  while (true) {
    const value = (await deps.ask(question, { masked: true })).trim();
    if (!value) {
      deps.fail("This value is required.");
      continue;
    }
    const mismatch = mismatchMessage(kind, value);
    if (mismatch) {
      deps.fail(mismatch);
      continue;
    }
    if (!isValidFormat(value)) {
      deps.fail(`Expected a key starting with '${expectedPrefix}'.`);
      continue;
    }
    const problem = verdictMessage(await deps.probe(kind, value), kind);
    if (problem) {
      deps.fail(problem);
      continue;
    }
    deps.ok(kind === "api" ? "API key verified" : "Management key verified");
    return value;
  }
}

/** Prompt for a signer seed. Required for the management pair, optional for the working pair. */
async function askForSigner(kind: KeyKind, deps: CollectDeps): Promise<string> {
  const question = kind === "api" ? PROMPTS.serviceKey : PROMPTS.adminSigner;
  while (true) {
    const value = (await deps.ask(question, { masked: true })).trim();
    if (!value) {
      if (kind === "api") {
        deps.info("Service key skipped — add it later to enable upload/download");
        return "";
      }
      deps.fail("The management signer is required — half a credential cannot mint.");
      continue;
    }
    if (!isValidServiceKeyFormat(value)) {
      deps.fail(
        `That doesn't decode as a valid ${SERVICE_KEY_PREFIX}… key — check the value and try again.`,
      );
      continue;
    }
    deps.ok("Signer format looks good");
    return value;
  }
}

/**
 * Run the prompt sequence for the chosen credential type and return only the
 * fields to persist. Re-prompts on every recoverable problem, so it either
 * returns a complete, valid set or never returns (the caller's Ctrl-C handler
 * exits).
 */
export async function collectCredentials(
  choice: CredentialChoice,
  deps: CollectDeps,
): Promise<Partial<ConfigFileData>> {
  const updates: Partial<ConfigFileData> = {};

  if (choice === "api" || choice === "both") {
    updates.apiKey = await askForKey("api", deps);
    const signer = await askForSigner("api", deps);
    if (signer) updates.servicePrivateKey = signer;
  }

  if (choice === "admin" || choice === "both") {
    deps.warn(ADMIN_WARNING);
    updates.adminKey = await askForKey("admin", deps);
    updates.adminServicePrivateKey = await askForSigner("admin", deps);
  }

  return updates;
}

/**
 * Validate flag/env-supplied values with no prompting. Returns the fields to
 * save plus any errors; a non-empty `errors` means nothing should be written.
 */
export async function validateSilent(
  values: CredentialValues,
  probe: (kind: KeyKind, key: string) => Promise<ProbeVerdict>,
): Promise<{ updates: Partial<ConfigFileData>; errors: string[] }> {
  const updates: Partial<ConfigFileData> = {};
  const errors: string[] = [];

  if (!values.apiKey && !values.serviceKey && !values.adminKey && !values.adminSigner) {
    return {
      updates,
      errors: [
        "No credentials given. Pass --api-key/--admin-key, or set CONSOLE_* and use --silent.",
      ],
    };
  }

  if (values.apiKey) {
    const mismatch = mismatchMessage("api", values.apiKey);
    if (mismatch) errors.push(mismatch);
    else if (!isValidApiKeyFormat(values.apiKey))
      errors.push(`--api-key must start with '${API_KEY_PREFIX}'.`);
    else {
      const problem = verdictMessage(await probe("api", values.apiKey), "api");
      if (problem) errors.push(problem);
      else updates.apiKey = values.apiKey;
    }
  }
  if (values.serviceKey) {
    if (!isValidServiceKeyFormat(values.serviceKey))
      errors.push(`--service-key does not decode as a valid ${SERVICE_KEY_PREFIX}… key.`);
    else updates.servicePrivateKey = values.serviceKey;
  }

  if (values.adminKey || values.adminSigner) {
    const beforeAdminErrors = errors.length;

    // Check the key's own type/format first, independent of whether its pair
    // partner is present — a wrong-type key is a rejection, not something the
    // "half a pair" message should shadow.
    if (values.adminKey) {
      const mismatch = mismatchMessage("admin", values.adminKey);
      if (mismatch) errors.push(mismatch);
      else if (!isValidAdminKeyFormat(values.adminKey))
        errors.push(`--admin-key must start with '${ADMIN_KEY_PREFIX}'.`);
    } else {
      errors.push("CONSOLE_ADMIN_KEY is missing — the management pair must be set together.");
    }
    if (!values.adminSigner) {
      errors.push(
        "CONSOLE_ADMIN_SERVICE_PRIVATE_KEY is missing — the management pair must be set together.",
      );
    } else if (!isValidServiceKeyFormat(values.adminSigner)) {
      errors.push(
        `CONSOLE_ADMIN_SERVICE_PRIVATE_KEY does not decode as a valid ${SERVICE_KEY_PREFIX}… key.`,
      );
    }

    if (values.adminKey && values.adminSigner && errors.length === beforeAdminErrors) {
      const problem = verdictMessage(await probe("admin", values.adminKey), "admin");
      if (problem) errors.push(problem);
      else {
        updates.adminKey = values.adminKey;
        updates.adminServicePrivateKey = values.adminSigner;
      }
    }
  }

  return errors.length > 0 ? { updates: {}, errors } : { updates, errors };
}
