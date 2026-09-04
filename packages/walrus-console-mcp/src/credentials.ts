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
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import type { CredentialValues } from "./cliArgs.js";
import type { ConfigFileData } from "./configFile.js";
import { validateAllowedDirectory } from "./pathSandbox.js";
import { registerSecret } from "./redaction.js";

export type CredentialChoice = "api" | "admin" | "both" | "bundle";
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

/**
 * Console mints `hbr_` / `hbradm_` plus 32 url-safe base64 chars (`A-Za-z0-9_-`).
 * Tests and older pastes are shorter; a 64-char body is the ceiling. Control
 * characters (CRLF, NUL, BEL) and a megabyte paste used to pass a prefix+length
 * check and then go out as an `Authorization` header.
 */
const KEY_BODY_MIN = 5;
const KEY_BODY_MAX = 64;
const KEY_BODY = /^[A-Za-z0-9_-]+$/;

function isValidPrefixedSecret(key: string, prefix: string): boolean {
  if (!key.startsWith(prefix)) return false;
  const body = key.slice(prefix.length);
  return body.length >= KEY_BODY_MIN && body.length <= KEY_BODY_MAX && KEY_BODY.test(body);
}

/** A working (data-plane) key. `hbradm_` does NOT match `hbr_`, so this is exact. */
export function isValidApiKeyFormat(key: string): boolean {
  return isValidPrefixedSecret(key, API_KEY_PREFIX);
}

/** A management (Key-Admin) key. */
export function isValidAdminKeyFormat(key: string): boolean {
  return isValidPrefixedSecret(key, ADMIN_KEY_PREFIX);
}

/**
 * A Sui private key, checked by actually decoding it (Bech32 + checksum +
 * flag byte), not just eyeballing the `suiprivkey1…` prefix and a minimum
 * length. This catches garbled, truncated, and wrong-thing pastes.
 *
 * ED25519 only. Every signer this server uses goes through
 * `Ed25519Keypair.fromSecretKey` (see SealCryptoService.getKeypair), which would
 * happily build a keypair from secp256k1 bytes and sign under an address nobody
 * registered — so a decodable key of another scheme is a rejection here, where
 * the operator can still read the message, not a plausible wrong pin later.
 *
 * It does NOT catch a structurally valid key that belongs to something else —
 * a different-but-real signer decodes cleanly and is indistinguishable from
 * the right one until it's used. We cannot validate a signer against the API
 * — it never leaves the machine.
 */
export function isValidServiceKeyFormat(key: string): boolean {
  try {
    return decodeSuiPrivateKey(key).scheme === "ED25519";
  } catch {
    return false;
  }
}

/**
 * Same generator as `SealCryptoService.getKeypair` — decode, then Ed25519
 * address. Refuses a non-ED25519 key for the reason on `isValidServiceKeyFormat`:
 * deriving from the wrong scheme returns an address that looks fine and matches
 * nothing. Callers validate with `isValidServiceKeyFormat` first; the throw is
 * the guard for the one that does not.
 */
export function suiAddressFromServiceKey(key: string): string {
  const { scheme, secretKey } = decodeSuiPrivateKey(key);
  if (scheme !== "ED25519") {
    throw new Error(`The service signer must be an ED25519 key; this one is ${scheme}.`);
  }
  return Ed25519Keypair.fromSecretKey(secretKey).toSuiAddress();
}

/** Which kind of key this is, by prefix, or null if it is neither. */
export function keyKindOf(key: string): KeyKind | null {
  if (isValidAdminKeyFormat(key)) return "admin";
  if (isValidApiKeyFormat(key)) return "api";
  return null;
}

/**
 * Version currently understood by `parseCredentialBundle`. Checked for exact
 * equality — a future bundle version must be rejected outright rather than
 * best-effort parsed as if its shape still matched this one.
 */
const CREDENTIAL_BUNDLE_VERSION = 1;

/**
 * The one-time `CONSOLE_CREDENTIAL_BUNDLE` the Console key-mint UI reveals.
 *
 * Field names are the same as `ConfigFileData` so a saved `config.json` (or a
 * reveal JSON) can be pasted without renaming. A working-key bundle carries
 * `apiKey` / `servicePrivateKey`; a management-key bundle carries `adminKey` /
 * `adminServicePrivateKey`. Extra keys of the other kind are ignored on a
 * working bundle (a saved config.json may hold both). `v` is optional; if
 * present it must be `1`.
 *
 * Both addresses may legitimately be `null` — a later step (not this parser)
 * warns that `create_bucket` refuses until `webAccountAddress` is pinned.
 */
export type CredentialBundle =
  | {
      readonly kind: "api";
      readonly apiKey: string;
      readonly servicePrivateKey: string;
      readonly webAccountAddress: string | null;
      readonly keyAdminAddress: string | null;
    }
  | {
      readonly kind: "admin";
      readonly adminKey: string;
      readonly adminServicePrivateKey: string;
      readonly webAccountAddress: string | null;
      readonly keyAdminAddress: string | null;
    };

export type ParseCredentialBundleResult = { bundle: CredentialBundle } | { error: string };

/**
 * Validate one address field: either JSON `null`, or a string that
 * `isValidSuiAddress` accepts. Anything else is a structural error, named by
 * field but never by value — see `parseCredentialBundle` for why.
 */
function parseNullableAddress(
  value: unknown,
  fieldName: "webAccountAddress" | "keyAdminAddress" | "ownerAddress",
): { address: string | null } | { error: string } {
  if (value === null || value === undefined) return { address: null };
  if (typeof value === "string" && isValidSuiAddress(value)) return { address: value };
  return { error: `bundle ${fieldName} is not null or a valid Sui address` };
}

function addressesAgree(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return normalizeSuiAddress(a) === normalizeSuiAddress(b);
}

/**
 * The spellings a working-key signer arrives under. `servicePrivateKey` is the
 * stored name; `serviceSecret` is what the Console emits today (see the note in
 * `parseCredentialBundle`). Named once so the parser and `registerBundleSecrets`
 * cannot drift apart about which field holds that secret.
 */
const SERVICE_KEY_FIELDS = ["servicePrivateKey", "serviceSecret"] as const;

/**
 * First own-key among `keys` that is present on `obj`. The alternatives are
 * live alternate SPELLINGS of one field, not a legacy fallback — the Console
 * emits some of them today (see `parseCredentialBundle`), so order here decides
 * which spelling wins, never which era of paste is still supported.
 */
function pickField(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(obj, key)) return obj[key];
  }
  return undefined;
}

/**
 * Owner pin from a bundle. `webAccountAddress` is the stored name;
 * `ownerAddress` is the Console reveal alias. One field is a rename; both,
 * with different values, is two instructions — refuse rather than let the
 * alias silently lose (or win).
 */
function pickOwnerAddress(
  obj: Record<string, unknown>,
): { address: string | null } | { error: string } {
  const hasCanonical = Object.hasOwn(obj, "webAccountAddress");
  const hasAlias = Object.hasOwn(obj, "ownerAddress");
  if (hasCanonical && hasAlias) {
    const canonical = parseNullableAddress(obj["webAccountAddress"], "webAccountAddress");
    if ("error" in canonical) return canonical;
    const alias = parseNullableAddress(obj["ownerAddress"], "ownerAddress");
    if ("error" in alias) return alias;
    if (!addressesAgree(canonical.address, alias.address)) {
      return {
        error: "bundle has both webAccountAddress and ownerAddress with different values",
      };
    }
    return canonical;
  }
  if (hasCanonical) return parseNullableAddress(obj["webAccountAddress"], "webAccountAddress");
  if (hasAlias) return parseNullableAddress(obj["ownerAddress"], "ownerAddress");
  return { address: null };
}

/**
 * Parse and validate a pasted `CONSOLE_CREDENTIAL_BUNDLE`. A result union, not
 * a throw: the caller (a later installer-prompt task) needs to show the
 * operator a message, not catch an exception.
 *
 * Reuses the format checks already in this file — `isValidApiKeyFormat` for
 * `apiKey`, `isValidServiceKeyFormat` (the real Bech32 decode, not a prefix
 * heuristic) for `servicePrivateKey` — plus `isValidSuiAddress` for the two
 * address fields, the same validator `configFile.ts` uses for its own pinned
 * addresses.
 *
 * Every error string is deliberately generic about WHAT was wrong and silent
 * about the VALUE that was wrong: this bundle carries live credentials, and
 * the error text is exactly the kind of string that ends up in a log file or
 * a terminal scrollback. See the no-echo precedent in `cliArgs.ts` for a
 * possibly-secret token in an argument-parsing error.
 */
/**
 * The parsed bundle PLUS the object it came from. Narrowing to a
 * `CredentialBundle` throws away every field of the other credential pair, and
 * `registerBundleSecrets` needs those, so the two internal callers take this
 * shape and `parseCredentialBundle` narrows it for everyone else — the source
 * object never escapes this module.
 */
type ParsedBundleWithSource = { bundle: CredentialBundle; source: Record<string, unknown> };

function parseBundleWithSource(raw: string): ParsedBundleWithSource | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "bundle is not valid JSON" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "bundle is not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  // `v` is optional (pre-unification config.json has none). A present unknown
  // version is a hard reject — do not best-effort parse a future shape.
  if (Object.hasOwn(obj, "v") && obj["v"] !== CREDENTIAL_BUNDLE_VERSION) {
    return { error: "unsupported bundle version" };
  }

  const owner = pickOwnerAddress(obj);
  if ("error" in owner) return owner;

  const keyAdmin = parseNullableAddress(obj["keyAdminAddress"], "keyAdminAddress");
  if ("error" in keyAdmin) return keyAdmin;

  const apiKey = obj["apiKey"];
  if (apiKey !== undefined) {
    if (typeof apiKey !== "string") {
      return { error: "bundle apiKey is not a Console API key" };
    }
    // Not `mismatchMessage`: its copy tells the operator to re-run and pick a
    // different chooser entry, which is advice about a prompt nobody is standing
    // at. A bundle is JSON, so the fix is the field it should have used.
    if (mismatchMessage("api", apiKey) !== null) {
      return {
        error:
          "bundle apiKey holds a management key (hbradm_…); a management bundle carries it as adminKey",
      };
    }
    if (!isValidApiKeyFormat(apiKey)) {
      return { error: "bundle apiKey is not a Console API key" };
    }

    // `serviceSecret` is not a legacy spelling: at the companion Console PR
    // head, `buildCredentialBundle` emits it (alongside `ownerAddress`) as the
    // CURRENT shape of every working-key reveal, so it is the spelling most
    // fresh pastes arrive in. A one-sided cleanup that deleted it here would
    // break every one of them; aligning the two spellings has to be coordinated
    // with the Console emitter, not done in this file alone.
    const servicePrivateKey = pickField(obj, SERVICE_KEY_FIELDS);
    if (typeof servicePrivateKey !== "string" || !isValidServiceKeyFormat(servicePrivateKey)) {
      return { error: "bundle servicePrivateKey is not a valid Sui private key" };
    }

    return {
      bundle: {
        kind: "api",
        apiKey,
        servicePrivateKey,
        webAccountAddress: owner.address,
        keyAdminAddress: keyAdmin.address,
      },
      source: obj,
    };
  }

  const adminKey = obj["adminKey"];
  if (adminKey !== undefined) {
    if (typeof adminKey !== "string") {
      return { error: "bundle adminKey is not a Console management key" };
    }
    if (mismatchMessage("admin", adminKey) !== null) {
      return {
        error:
          "bundle adminKey holds an everyday API key (hbr_…); a working bundle carries it as apiKey",
      };
    }
    if (!isValidAdminKeyFormat(adminKey)) {
      return { error: "bundle adminKey is not a Console management key" };
    }

    const adminServicePrivateKey = obj["adminServicePrivateKey"];
    if (
      typeof adminServicePrivateKey !== "string" ||
      !isValidServiceKeyFormat(adminServicePrivateKey)
    ) {
      return { error: "bundle adminServicePrivateKey is not a valid Sui private key" };
    }

    return {
      bundle: {
        kind: "admin",
        adminKey,
        adminServicePrivateKey,
        webAccountAddress: owner.address,
        keyAdminAddress: keyAdmin.address,
      },
      source: obj,
    };
  }

  return { error: "bundle apiKey is not a Console API key" };
}

/**
 * Parse and validate a pasted `CONSOLE_CREDENTIAL_BUNDLE`. See
 * `parseBundleWithSource` above for the rules; this drops the source object so
 * no caller outside this module holds the unnarrowed paste.
 */
export function parseCredentialBundle(raw: string): ParseCredentialBundleResult {
  const result = parseBundleWithSource(raw);
  return "error" in result ? result : { bundle: result.bundle };
}

/** Every field of a pasted bundle that can hold a credential, and its validator. */
const BUNDLE_SECRET_FIELDS: readonly {
  keys: readonly string[];
  wellFormed: (value: string) => boolean;
}[] = [
  { keys: ["apiKey"], wellFormed: isValidApiKeyFormat },
  { keys: SERVICE_KEY_FIELDS, wellFormed: isValidServiceKeyFormat },
  { keys: ["adminKey"], wellFormed: isValidAdminKeyFormat },
  { keys: ["adminServicePrivateKey"], wellFormed: isValidServiceKeyFormat },
];

/**
 * Register the two credentials a parsed bundle carries, so redaction knows about
 * them before anything can echo them back.
 *
 * Registering the bundle STRING (which the CLI entry points already do for the
 * flag/env value, and the masked prompt does for a paste) is not enough:
 * `redactString` looks for whole registered values inside the text it is given,
 * so a `Authorization: Bearer hbr_…` header built from a field of the bundle
 * matches nothing. These two do.
 *
 * This is the one place `credentials.ts` reaches for a module-level side effect,
 * and it is deliberate: it MUST happen between the parse and the probe, and a
 * caller cannot do it — only this module has seen inside the bundle. The probe's
 * fetch error is exactly the thing that would otherwise carry the key out.
 *
 * `source` is the object the bundle was parsed FROM, because the parsed bundle
 * is not the whole story: a pasted `config.json` can hold both credential pairs,
 * `apiKey` is tested first, and the narrowing to `kind: "api"` therefore throws
 * `adminKey`/`adminServicePrivateKey` away before this function would ever see
 * them. Registering the bundle string does not cover them either — `redactString`
 * looks for whole registered values inside output, not the other way round.
 * Defense in depth: no current path echoes the discarded pair, but the probe
 * error is one string away from doing so.
 */
function registerBundleSecrets(bundle: CredentialBundle, source: Record<string, unknown>): void {
  // The pair that decided the kind, anchored to the typed bundle so it cannot
  // drift if the field names below ever change.
  if (bundle.kind === "api") {
    registerSecret(bundle.apiKey);
    registerSecret(bundle.servicePrivateKey);
  } else {
    registerSecret(bundle.adminKey);
    registerSecret(bundle.adminServicePrivateKey);
  }

  // Every OTHER secret-shaped field the paste carried. Gated on the same format
  // checks the parser uses, because registering a non-credential is not free:
  // `redactString` matches substrings, so a junk value would scrub that run of
  // text out of every later line of output. `registerSecret` is backed by a Set
  // and no-ops on non-strings, so the overlap with the pair above is harmless.
  //
  // EVERY spelling, not `pickField`: that returns the first key present and
  // never looks at the rest, so a paste carrying both `servicePrivateKey` and
  // `serviceSecret` would leave the second value unregistered — the same leak
  // this sweep closes for the other pair. Redaction is not parsing: here the
  // question is "could this string reach an output channel", and both can.
  // `parseCredentialBundle` still takes the first spelling and is unchanged.
  for (const { keys, wellFormed } of BUNDLE_SECRET_FIELDS) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && wellFormed(value)) registerSecret(value);
    }
  }
}

/** The bearer the probe sends for this bundle. */
function bundleKey(bundle: CredentialBundle): string {
  return bundle.kind === "api" ? bundle.apiKey : bundle.adminKey;
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
  /**
   * Print a value the operator must read character by character — verbatim, with
   * no symbol and no truncation.
   *
   * `info` and friends wrap to the panel's rail, which CLAMPS any single token
   * wider than it: a 66-character Sui address renders as `0xab…` inside a
   * 72-column panel. A trust anchor shown with its tail replaced by an ellipsis
   * is worse than one not shown at all — the operator would confirm a prefix.
   */
  show(msg: string): void;
  probe(kind: KeyKind, key: string): Promise<ProbeVerdict>;
}

const PROMPTS = {
  apiKey: "CONSOLE_API_KEY (hbr_…): ",
  serviceKey: "CONSOLE_SERVICE_PRIVATE_KEY (suiprivkey1…): ",
  adminKey: "CONSOLE_ADMIN_KEY (hbradm_…): ",
  adminSigner: "CONSOLE_ADMIN_SERVICE_PRIVATE_KEY (suiprivkey1…): ",
  keepSigner: "Keep the previous signer? [y/N]: ",
  bundle: "CONSOLE_CREDENTIAL_BUNDLE (paste the whole JSON): ",
  confirmBundle: "Save this key and pin the addresses above? [y/N]: ",
  confirmSeeds: "Pin these addresses? [y/N]: ",
} as const;

/**
 * The prompt for one address pin. What a bare Enter DOES depends on whether one
 * is already saved — "skip" and "keep the saved one" are different promises, and
 * offering the wrong one is how an operator ends up believing they cleared a pin
 * they in fact kept.
 */
const addressPrompt = (label: string, saved: string | undefined) =>
  `${label} Sui address (0x…, Enter to ${saved ? "keep the saved one" : "skip"}): `;

/**
 * The confirmation for a manually entered pin. The address is already on the
 * line above (the unmasked input row) — putting it in this question again
 * overflowed the AUTHENTICATE panel, and printing it a second time via `show`
 * made the same value appear twice. `deps.show` is for values the operator did
 * NOT just type (a saved pin, a bundle).
 */
const confirmPin = (label: string) => `Pin this as the ${label}? [y/N]: `;

/**
 * Affirmative answers to a `[y/N]` question. Everything else — including a bare
 * Enter — is a No, so silence never grants anything.
 */
const isAffirmative = (answer: string): boolean => {
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
};

const ADMIN_WARNING =
  "Provisioning host only — this key mints credentials. Don't copy this file to workers.";

/**
 * Loud, and shared by every provisioning path — interactive AND silent —
 * because it is the difference between a working `create_bucket` and one that
 * refuses every request.
 *
 * Exported so the wording has one home: the silent path returns it through
 * `validateSilent`'s `warnings` for the CLI to print, and an operator who hits
 * this in a script and then again at a prompt must see the same sentence, not
 * two dialects of it.
 */
export const NO_OWNER_PIN_WARNING =
  "No bucket-owner address — create_bucket will REFUSE every request until one is pinned. " +
  "Re-run `walrus-console-mcp config` with the bundle from the Console key-mint reveal, " +
  "or set CONSOLE_WEB_ACCOUNT_ADDRESS.";

/** Same one-home reasoning as `NO_OWNER_PIN_WARNING`. */
export const NO_KEY_ADMIN_PIN_WARNING =
  "No Key-Admin address — this host will fall back to the address its own admin key derives, " +
  "and refuse a management grant it cannot check against anything.";

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
 * Prompt for one optional address pin: unmasked (it is not a secret), validated
 * with the same `isValidSuiAddress` the config loader uses, and then CONFIRMED
 * against the exact value that would be written.
 *
 * The confirmation is the trust step, not a courtesy. There is no API to ask
 * which account should own a bucket — and asking the party you are defending
 * against would be a no-op dressed as a fix — so the only thing standing between
 * a typo'd/hostile paste and a persisted trust anchor is a human re-reading it.
 * A declined confirmation re-prompts rather than skipping, because the usual
 * reason to decline is a mis-paste the operator wants to redo.
 *
 * Returns null when the operator skips (bare Enter) — the caller warns about
 * what that costs.
 *
 * The failure message never repeats the rejected value. An address is not a
 * secret, but this prompt is exactly where a mis-paste puts a signer seed, and
 * a validator error is the kind of string that ends up in a scrollback.
 */
async function askForAddressPin(
  question: string,
  label: string,
  deps: CollectDeps,
): Promise<string | null> {
  while (true) {
    // Copy on its own wrapping line, value on the next: a 66-character address
    // plus "Bucket owner Sui address (0x…, Enter to keep the saved one): "
    // cannot share a 72-column panel row. Empty `ask` is the gutter only.
    deps.info(question.replace(/:\s*$/, ""));
    const value = (await deps.ask("", { masked: false })).trim();
    if (!value) return null;
    if (!isValidSuiAddress(value)) {
      deps.fail("That is not a valid Sui address — expected 0x followed by 64 hex characters.");
      continue;
    }
    if (isAffirmative(await deps.ask(confirmPin(label), { masked: false }))) {
      deps.ok(`${label} pinned`);
      return value;
    }
    deps.info("Not saved — enter the address again, or press Enter to skip.");
  }
}

/**
 * Collect both pins by hand, for keys minted before the bundle format existed.
 *
 * Writes ONLY what the operator confirms. Skipping a prompt leaves whatever is
 * already saved untouched — see the asymmetry note on `bundleWrite` — so the
 * "create_bucket will refuse" warning fires only when nothing is pinned. Saying
 * it over a perfectly good saved pin would send the operator hunting for a
 * problem they do not have.
 */
async function collectAddressPins(
  updates: Partial<ConfigFileData>,
  deps: CollectDeps,
  existing: ConfigFileData,
): Promise<void> {
  // `title` opens the prompt, `label` reads mid-sentence ("the bucket owner").
  const pins = [
    {
      title: "Bucket owner",
      label: "bucket owner",
      field: "webAccountAddress",
      saved: existing.webAccountAddress,
      warning: NO_OWNER_PIN_WARNING,
    },
    {
      title: "Key-Admin",
      label: "Key-Admin",
      field: "keyAdminAddress",
      saved: existing.keyAdminAddress,
      warning: NO_KEY_ADMIN_PIN_WARNING,
    },
  ] as const;

  for (const { title, label, field, saved, warning } of pins) {
    // Already decided this run — seeded from argv (and confirmed), or derived
    // from an admin signer. Asking again would invite a second answer.
    if (updates[field] !== undefined) continue;
    const entered = await askForAddressPin(addressPrompt(title, saved), label, deps);
    if (entered) {
      updates[field] = entered;
    } else if (saved) {
      deps.info(`Keeping the saved ${label}:`);
      deps.show(saved);
    } else {
      deps.warn(warning);
    }
  }
}

/**
 * What to persist after a credential prompt: the fields to write, plus the
 * fields to REMOVE.
 *
 * The removals matter because omitting a field from `updates` means "preserve"
 * (see `mergeConfigFile`), so without this a skipped signer silently keeps the
 * previous key's one.
 */
export interface CredentialWrite {
  updates: Partial<ConfigFileData>;
  clear: (keyof ConfigFileData)[];
}

/**
 * True when a write would change nothing — every field was declined or skipped.
 *
 * The CLI entry points use this to skip `mergeConfigFile` entirely, so a declined
 * confirmation really does leave the file alone rather than rewriting it with the
 * same contents (and, incidentally, applying the base-URL bookkeeping a
 * successful auth implies).
 */
export function isEmptyWrite(write: CredentialWrite): boolean {
  return Object.keys(write.updates).length === 0 && write.clear.length === 0;
}

/**
 * Every write of an admin signer also writes the Key-Admin pin it derives.
 *
 * Runtime already falls back to this derivation when no pin is saved; persisting
 * it at config time is what lets a management-only host provision and a worker
 * host inherit a pin it can check. A pin supplied alongside (a seed flag, or a
 * bundle's `keyAdminAddress`) must agree — the same rule `create_bucket`
 * applies — because the two disagreeing means one of them belongs to a
 * different signer, and quietly preferring either would hide a swap. Rotation
 * is the one overwrite: the new derivation replaces whatever was saved, since
 * the old pin belonged to the old signer.
 */
function applyDerivedAdminPin(
  updates: Partial<ConfigFileData>,
  signer: string,
  pin: string | undefined,
): { derived: string } | { error: string } {
  const derived = suiAddressFromServiceKey(signer);
  if (pin !== undefined && normalizeSuiAddress(pin) !== normalizeSuiAddress(derived)) {
    return {
      error:
        `Key-Admin pin ${normalizeSuiAddress(pin)} does not match the address this admin signer ` +
        `derives (${normalizeSuiAddress(derived)}). One of them is stale — nothing was saved.`,
    };
  }
  updates.adminServicePrivateKey = signer;
  updates.keyAdminAddress = derived;
  return { derived };
}

/**
 * Map a confirmed bundle onto the fields to write and the fields to remove.
 *
 * **A WORKING bundle is authoritative for both pins.** An address it carries as
 * `null` means this key has no such address, so any value saved for a PREVIOUS
 * key is cleared rather than left in place: a stale pin is not a harmless
 * leftover, it is the exact mismatch that makes every future `create_bucket`
 * refuse with a message about an address the operator has never seen.
 *
 * That is the opposite of the manual path (`collectAddressPins`), which merges —
 * skipping a prompt there means "leave it alone", because a bare Enter is an
 * absence of instruction, not a statement that no address exists. A working
 * bundle IS that statement.
 *
 * A MANAGEMENT bundle is not, for either pin, so it clears neither:
 * - it never calls `create_bucket`, so it has nothing to say about the owner —
 *   deleting a saved owner pin here is how a split-credential host (management
 *   bundle for provisioning, `--api-key`/`--service-key` for everyday use) ends
 *   up refusing every create;
 * - its own signer derives the Key-Admin, so `null` there is "not supplied" and
 *   `applyDerivedAdminPin` fills it.
 *
 * Which is why `seeds` reaches this far: an `--owner-address` beside a
 * management bundle is not a second opinion to reconcile, it is the ONLY
 * statement of the owner in the whole invocation, so it is written. Accepting
 * it in `seedDisagreement` and dropping it here would be the worse of the two
 * failures the refusal was guarding against — a silent discard instead of a
 * loud refusal. The Key-Admin seed is deliberately NOT applied here: only the
 * signer can answer that one, and `applyDerivedAdminPin` does it.
 *
 * Deciding all of this here, from the kind, is what keeps the callers from each
 * re-deriving the rule and drifting.
 */
function bundleWrite(bundle: CredentialBundle, seeds: PinSeeds): CredentialWrite {
  // Same keys as config.json — no rename. A pasted config file writes through.
  const updates: Partial<ConfigFileData> = {};
  const clear: (keyof ConfigFileData)[] = [];

  if (bundle.kind === "api") {
    updates.apiKey = bundle.apiKey;
    updates.servicePrivateKey = bundle.servicePrivateKey;
  } else {
    updates.adminKey = bundle.adminKey;
    updates.adminServicePrivateKey = bundle.adminServicePrivateKey;
  }

  if (bundle.webAccountAddress !== null) updates.webAccountAddress = bundle.webAccountAddress;
  else if (bundle.kind === "api") clear.push("webAccountAddress");
  else if (seeds.ownerAddress !== undefined) {
    updates.webAccountAddress = normalizeSuiAddress(seeds.ownerAddress);
  }

  if (bundle.keyAdminAddress !== null) updates.keyAdminAddress = bundle.keyAdminAddress;
  else if (bundle.kind === "api") clear.push("keyAdminAddress");

  return { updates, clear };
}

/**
 * Does a pin still exist once this write lands — because the write sets it, or
 * because the write leaves the saved one alone?
 *
 * The `NO_*_PIN_WARNING`s are statements about the resulting config, not about
 * the bundle, and the two stopped agreeing once a management bundle was allowed
 * to leave a pin it does not own untouched. Warning "create_bucket will REFUSE
 * every request" at a host whose saved owner pin just survived is the same class
 * of false statement as clearing a pin the write had already derived.
 */
function pinSurvives(
  field: "webAccountAddress" | "keyAdminAddress",
  write: CredentialWrite,
  existing: ConfigFileData,
): boolean {
  if (write.updates[field] !== undefined) return true;
  return existing[field] !== undefined && !write.clear.includes(field);
}

/**
 * Paste → parse → probe → SHOW → confirm → write.
 *
 * The bundle travels the same copy-paste channel as the credentials it contains,
 * so it grows no new trusted party: whoever could tamper with the pasted API key
 * could already tamper with everything else in the reveal. What it does add is
 * the two addresses, and those are only worth anything if a human looked at
 * them — hence the unmasked display and the blocking `[y/N]`.
 *
 * A decline writes NOTHING, not even the verified API key: the operator has just
 * said they do not recognise this account, and half-saving it would leave a
 * credential whose pins never arrived.
 */
async function collectBundle(
  deps: CollectDeps,
  seeds: PinSeeds,
  existing: ConfigFileData,
): Promise<CredentialWrite> {
  while (true) {
    const raw = (await deps.ask(PROMPTS.bundle, { masked: true })).trim();
    if (!raw) {
      deps.fail("This value is required.");
      continue;
    }

    const parsed = parseBundleWithSource(raw);
    if ("error" in parsed) {
      // parseCredentialBundle's messages name the field, never the value.
      deps.fail(
        `${parsed.error} — paste the whole one-line JSON from the Console key-mint reveal (or from config.json).`,
      );
      continue;
    }

    // Before the probe, so a bundle for the wrong account costs no round trip:
    // the operator's next act is to paste a different one either way.
    const disagreement = seedDisagreement(parsed.bundle, seeds);
    if (disagreement) {
      deps.fail(disagreement);
      continue;
    }

    // Before the probe: its fetch error can embed the Bearer header.
    registerBundleSecrets(parsed.bundle, parsed.source);
    const bundle = parsed.bundle;
    const probeKind = bundle.kind;
    // Same warning the Management key prompt gives, for the same reason: this
    // paste configures a host that can mint credentials.
    if (probeKind === "admin") deps.warn(ADMIN_WARNING);
    const problem = verdictMessage(await deps.probe(probeKind, bundleKey(bundle)), probeKind);
    if (problem) {
      deps.fail(problem);
      continue;
    }
    deps.ok(probeKind === "api" ? "API key verified" : "Management key verified");

    const write = bundleWrite(bundle, seeds);
    if (bundle.kind === "admin") {
      const pinned = applyDerivedAdminPin(
        write.updates,
        bundle.adminServicePrivateKey,
        // The bundle's own pin when it has one; otherwise the seed, which
        // `seedDisagreement` deliberately left for this comparison because only
        // the signer can answer it.
        bundle.keyAdminAddress ?? seeds.keyAdminAddress,
      );
      // A bundle that disagrees with its own signer cannot be fixed by pasting
      // it again, so this refuses outright rather than re-prompting.
      if ("error" in pinned) {
        deps.fail(pinned.error);
        return { updates: {}, clear: [] };
      }
    }

    deps.warn("Check these — they decide who ends up owning a bucket this host creates.");
    deps.info("bucket owner (webAccountAddress):");
    // The RESOLVED value, matching the Key-Admin line below: an `--owner-address`
    // seeding an owner-less management bundle is written, so showing the bundle's
    // own empty field would make the `[y/N]` confirm a value it never displayed.
    deps.show(write.updates.webAccountAddress ?? "(none in this bundle)");
    deps.info("Key-Admin (keyAdminAddress):");
    deps.show(write.updates.keyAdminAddress ?? "(none in this bundle)");

    if (!isAffirmative(await deps.ask(PROMPTS.confirmBundle, { masked: false }))) {
      deps.info("Nothing was saved. Re-run and paste the bundle for this account.");
      return { updates: {}, clear: [] };
    }

    if (!pinSurvives("webAccountAddress", write, existing)) deps.warn(NO_OWNER_PIN_WARNING);
    if (!pinSurvives("keyAdminAddress", write, existing)) deps.warn(NO_KEY_ADMIN_PIN_WARNING);
    return write;
  }
}

/** Address pins that arrived on the command line (`--owner-address`, `--key-admin-address`). */
export type PinSeeds = {
  ownerAddress?: string | undefined;
  keyAdminAddress?: string | undefined;
};

/**
 * Every complaint about the seed flags, in flag order.
 *
 * A list, not the first problem: two bad flags are two things to fix, and
 * reporting one at a time makes the operator re-run to discover the next. The
 * non-bundle silent branch already names both, and this is what lets the bundle
 * branch match it.
 */
function seedFlagErrors(seeds: PinSeeds): string[] {
  return [
    addressFlagError(seeds.ownerAddress, "--owner-address"),
    addressFlagError(seeds.keyAdminAddress, "--key-admin-address"),
  ].filter((problem): problem is string => problem !== undefined);
}

/**
 * A seed flag and a bundle both name a pin. Equal is one instruction said
 * twice; anything else is two instructions, and choosing one silently would
 * hide exactly the swap the pins exist to catch. The bundle's `null` counts as
 * an answer here: "this key has no Key-Admin" disagrees with a
 * `--key-admin-address`. No seed means the bundle is authoritative, as before.
 */
function seedDisagreement(bundle: CredentialBundle, seeds: PinSeeds): string | undefined {
  const checks = [
    {
      flag: "--owner-address",
      seed: seeds.ownerAddress,
      bundled: bundle.webAccountAddress,
      // Same shape as the Key-Admin case below, for the same reason. A
      // management bundle never calls `create_bucket`, so it makes no claim
      // about the owner (`bundleWrite`'s docblock says so): its `null` is "not
      // supplied", and answering a `--owner-address` with "this key has no such
      // address" states something the bundle never said — then loops on a
      // `continue` that no re-paste of the same bundle can escape. The seed IS
      // the answer here, and `bundleWrite` writes it. A WORKING bundle is still
      // authoritative for the owner, so its `null` remains a real disagreement.
      derivable: bundle.kind === "admin",
    },
    {
      flag: "--key-admin-address",
      seed: seeds.keyAdminAddress,
      bundled: bundle.keyAdminAddress,
      // A management bundle's `null` Key-Admin is "not supplied", not "there is
      // none" — its signer derives the address (see `bundleWrite`). Refusing the
      // seed against that absence rejected the Console's own Connect MCP command,
      // and did it with a `continue` that no paste of the same bundle could
      // escape. `applyDerivedAdminPin` makes the real comparison instead.
      derivable: bundle.kind === "admin",
    },
  ];
  for (const { flag, seed, bundled, derivable } of checks) {
    if (seed === undefined) continue;
    if (bundled === null && derivable) continue;
    if (bundled !== null && normalizeSuiAddress(seed) === normalizeSuiAddress(bundled)) continue;
    return (
      `${flag} is ${normalizeSuiAddress(seed)}, but the bundle says ` +
      `${bundled === null ? "this key has no such address" : normalizeSuiAddress(bundled)}. ` +
      `One of them is stale — nothing was saved.`
    );
  }
  return undefined;
}

/**
 * Run the prompt sequence for the chosen credential type and return the fields
 * to persist and to remove. Re-prompts on every recoverable problem, so it
 * either returns a complete, valid set or never returns (the caller's Ctrl-C
 * handler exits).
 *
 * `existing` is the currently-saved config, needed only to notice that replacing
 * the API key would strand the signer registered for the OLD key. `seeds` are
 * the two address flags: they skip their own prompt but not the confirmation.
 */
export async function collectCredentials(
  choice: CredentialChoice,
  deps: CollectDeps,
  existing: ConfigFileData = {},
  seeds: PinSeeds = {},
): Promise<CredentialWrite> {
  // Before anything is asked, and for EVERY choice: a malformed seed is a bad
  // command line, and no answer to any prompt can fix it — re-prompting would be
  // the inescapable loop C1 removed. Both write paths persist the seed
  // (`bundleWrite` for the bundle choice, the confirmed `seeded` list below for
  // the others) and `normalizeSuiAddress` pads junk rather than refusing it, so
  // an unvalidated seed reaches the config file and is silently dropped on the
  // next read — or, when empty, kept as the zero address. `parseArgs` already
  // checks the real CLI; this keeps the exported function honest on its own,
  // which is the whole reason the bundle path stopped trusting its caller.
  const seedProblems = seedFlagErrors(seeds);
  if (seedProblems.length > 0) {
    for (const problem of seedProblems) deps.fail(problem);
    return { updates: {}, clear: [] };
  }

  // One paste carries the key, its signer and both pins, so this flow shares
  // nothing with the field-by-field prompts below.
  if (choice === "bundle") return collectBundle(deps, seeds, existing);

  const updates: Partial<ConfigFileData> = {};
  const clear: (keyof ConfigFileData)[] = [];

  if (choice === "api" || choice === "both") {
    updates.apiKey = await askForKey("api", deps);
    const signer = await askForSigner("api", deps);
    if (signer) {
      updates.servicePrivateKey = signer;
    } else if (existing.servicePrivateKey) {
      // The API key and its signer are a matched pair — the signer is the address
      // registered for that key. Keeping the old one across a key change produces
      // two halves of two credentials, and that only fails much later, inside
      // Seal, with a message that points nowhere near the real cause.
      //
      // Still worth asking rather than always clearing: re-entering the same key
      // to fix a typo is a normal flow, and there the saved signer is fine.
      // Default (bare Enter) is to clear, since the mismatched pair is the more
      // confusing failure.
      deps.info("The saved signer is only valid if this is the same API key.");
      if (isAffirmative(await deps.ask(PROMPTS.keepSigner, { masked: false }))) {
        deps.info("Keeping the saved signer.");
      } else {
        clear.push("servicePrivateKey");
        deps.info("Saved signer removed — add one later to enable upload/download.");
      }
    }
  }

  if (choice === "admin" || choice === "both") {
    deps.warn(ADMIN_WARNING);
    updates.adminKey = await askForKey("admin", deps);
    const signer = await askForSigner("admin", deps);
    const pinned = applyDerivedAdminPin(updates, signer, seeds.keyAdminAddress);
    if ("error" in pinned) {
      deps.fail(pinned.error);
      return { updates: {}, clear: [] };
    }
    deps.info("Key-Admin (derived from the signer just entered):");
    deps.show(pinned.derived);
  }

  // Seeds: pins that arrived on the command line, validated as addresses at the
  // top of this function. Shown in full and confirmed as a set — the same
  // trust step a pasted bundle gets — because argv came over the same clipboard
  // a bundle would. A Key-Admin seed that a derivation has already checked equal
  // is not asked about again: it was computed, not read.
  const seeded: { label: string; field: "webAccountAddress" | "keyAdminAddress"; value: string }[] =
    [];
  // Deliberately NOT gated on api/both the way `collectAddressPins` is below.
  // That gate exists because there is nothing to ASK a provisioning-only host —
  // it never calls `create_bucket`. A flag is not a question: the operator typed
  // this address, and a host provisioned with a management key may later gain a
  // working one. The cost of saving it is a pin that may sit unused; the cost of
  // gating it is discarding an explicit instruction with no message. The second
  // is worse, so the seed is written whatever the choice.
  if (seeds.ownerAddress !== undefined) {
    seeded.push({ label: "Bucket owner", field: "webAccountAddress", value: seeds.ownerAddress });
  }
  if (seeds.keyAdminAddress !== undefined && updates.keyAdminAddress === undefined) {
    seeded.push({ label: "Key-Admin", field: "keyAdminAddress", value: seeds.keyAdminAddress });
  }
  if (seeded.length > 0) {
    deps.warn(
      "Check these — they came from the install command and decide who ends up owning a bucket this host creates.",
    );
    for (const { label, value } of seeded) {
      deps.info(`${label}:`);
      deps.show(value);
    }
    if (!isAffirmative(await deps.ask(PROMPTS.confirmSeeds, { masked: false }))) {
      deps.info("Nothing was saved. Re-run without the address flags to enter the pins by hand.");
      return { updates: {}, clear: [] };
    }
    for (const { field, value } of seeded) updates[field] = value;
  }

  // Last, after both credential pairs, so the key/signer prompts stay contiguous
  // and the pins read as their own section. Only offered where a working key was
  // configured: the pins govern `create_bucket`, which a management-only
  // provisioning host never calls. Seeded/derived pins skip their prompt.
  if (choice === "api" || choice === "both") {
    await collectAddressPins(updates, deps, existing);
  }

  return { updates, clear };
}

/**
 * The flags a `--credential-bundle` of each kind also supplies. A bundle
 * REPLACES the flags of its own pair and composes with the other pair — a
 * working bundle next to `--admin-key`/`--admin-signer` is the split-credential
 * provisioning host, an admin bundle next to `--api-key`/`--service-key` is the
 * same host set up the other way round. Address flags are not conflicts:
 * `seedDisagreement` decides them.
 */
const BUNDLE_CONFLICTS: Record<
  CredentialBundle["kind"],
  { field: keyof CredentialValues; flag: string }[]
> = {
  api: [
    { field: "apiKey", flag: "--api-key" },
    { field: "serviceKey", flag: "--service-key" },
  ],
  admin: [
    { field: "adminKey", flag: "--admin-key" },
    { field: "adminSigner", flag: "--admin-signer" },
  ],
};

/**
 * The complaint about a flag-supplied address, or undefined when it is absent or
 * valid.
 *
 * Split out of `validateAddressFlag` so the BUNDLE path can run the same check
 * without also writing the value — there the write goes through `bundleWrite`,
 * not straight into `updates`. That path needs it: `normalizeSuiAddress` does
 * not reject junk, it zero-pads it (`0x0000…totally-not-an-address`), and
 * `loadConfigFile` then re-checks `isValidSuiAddress` and silently DROPS the
 * pin. The operator is told an address was saved and every later `create_bucket`
 * refuses — the silent discard this whole flow exists to prevent.
 *
 * Names the flag but never the value (see the no-echo precedent in cliArgs.ts):
 * this flag is a plausible place for a mis-pasted secret to land.
 */
function addressFlagError(value: string | undefined, flag: string): string | undefined {
  // `undefined` is "not supplied"; EMPTY is not. `normalizeSuiAddress("")` is
  // the zero address, and unlike zero-padded junk `isValidSuiAddress` ACCEPTS
  // that, so `loadConfigFile` keeps it — an empty seed would persist as a wrong
  // pin that nothing downstream ever rejects. Refusing is the only reading that
  // does not silently invent an owner. (`isValidSuiAddress("")` is false, so
  // dropping the truthiness check is all this takes.)
  if (value === undefined || isValidSuiAddress(value)) return undefined;
  return `${flag} is not a valid Sui address (expected 0x followed by 64 hex characters).`;
}

/**
 * Validate one flag-supplied address pin into `updates`.
 *
 * Merge semantics, like the interactive manual path: an address flag SETS its
 * own field and never touches the other pin. Only a bundle is authoritative
 * enough to remove a pin it did not supply.
 */
function validateAddressFlag(
  value: string | undefined,
  flag: string,
  field: "webAccountAddress" | "keyAdminAddress",
  updates: Partial<ConfigFileData>,
  errors: string[],
): void {
  // `undefined`, not falsy: an empty flag is refused by `addressFlagError`
  // rather than treated as absent, so every path answers `""` the same way.
  if (value === undefined) return;
  const problem = addressFlagError(value, flag);
  if (problem !== undefined) {
    errors.push(problem);
    return;
  }
  updates[field] = value;
}

/**
 * Validate flag/env-supplied values with no prompting. Returns the fields to
 * save plus any errors; a non-empty `errors` means nothing should be written.
 *
 * `warnings` is the silent path's substitute for the interactive flow's
 * `deps.warn`: something WAS written, and the operator needs to know what it
 * costs them. It exists because a scripted install must not silently produce a
 * config in which every `create_bucket` refuses — the strings are the same
 * constants the prompts use. The CLI entry points print them beside the saved
 * line; they never change the exit code.
 */
export async function validateSilent(
  values: CredentialValues,
  probe: (kind: KeyKind, key: string) => Promise<ProbeVerdict>,
  existing: ConfigFileData = {},
  /**
   * Read for `CONSOLE_WEB_ACCOUNT_ADDRESS` (is a pin resolvable without one
   * being written?) and `CONSOLE_CREDENTIAL_BUNDLE` (did the environment supply
   * the bundle, rather than a flag?). Injected so tests can prove an env-pinned
   * host stays silent; production callers omit it and we read `process.env` —
   * the same object `parseArgs` was handed, which is what makes the second read
   * agree with how `values.bundle` was populated. We do not go through the
   * config layer: this helper runs before that layer is constructed.
   */
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialWrite & { errors: string[]; warnings: string[] }> {
  const updates: Partial<ConfigFileData> = {};
  let clear: (keyof ConfigFileData)[] = [];
  const errors: string[] = [];
  let warnings: string[] = [];

  if (
    !values.apiKey &&
    !values.serviceKey &&
    !values.adminKey &&
    !values.adminSigner &&
    !values.bundle &&
    !values.ownerAddress &&
    !values.keyAdminAddress &&
    !(values.allowedDirs && values.allowedDirs.length > 0)
  ) {
    return {
      updates,
      clear,
      warnings,
      // This list is exactly what the installer reads under `--silent`, in both
      // directions. `CONSOLE_*` was not: `ENV_FLAGS` (src/cliArgs.ts) folds in
      // the five credential variables below, and `parseArgs` folds in
      // CONSOLE_MCP_ALLOWED_DIRS (`ALLOWED_DIRS_ENV`, src/pathSandbox.ts) —
      // which satisfies this same guard on its own, so leaving it out would
      // misdescribe the CLI just as the wildcard did, only in the other
      // direction. CONSOLE_WEB_ACCOUNT_ADDRESS / CONSOLE_KEY_ADMIN_ADDRESS stay
      // absent on purpose: the SERVER reads those at runtime and the installer
      // must not persist them, so the address pins are offered by their flag
      // spelling, which is the only one that reaches this code.
      errors: [
        "No credentials given. Pass --credential-bundle, --api-key/--service-key, " +
          "--admin-key/--admin-signer, --owner-address/--key-admin-address or " +
          "--allowed-dirs — or, with --silent, set CONSOLE_CREDENTIAL_BUNDLE, " +
          "CONSOLE_API_KEY, CONSOLE_SERVICE_PRIVATE_KEY, CONSOLE_ADMIN_KEY, " +
          "CONSOLE_ADMIN_SERVICE_PRIVATE_KEY or CONSOLE_MCP_ALLOWED_DIRS.",
      ],
    };
  }

  // A bundle REPLACES the flags of its own pair — it supplies the same fields —
  // and composes with the other pair, which it says nothing about. Dropping
  // `--admin-key` silently because a working bundle was also passed would be the
  // worst of the three options. The conflict set therefore cannot be chosen
  // until the bundle has been parsed and its kind is known.
  let bundleKind: CredentialBundle["kind"] | null = null;
  if (values.bundle) {
    const parsed = parseBundleWithSource(values.bundle);
    if ("error" in parsed) {
      // Prefixed with the flag, not the value — the bundle is a live credential.
      errors.push(`--credential-bundle: ${parsed.error}.`);
    } else {
      bundleKind = parsed.bundle.kind;
      // Two sources of truth for the same fields is not a merge problem, it is an
      // ambiguity: whichever won, the operator asked for something else. Refuse.
      const conflicts = BUNDLE_CONFLICTS[bundleKind]
        .filter(({ field }) => values[field])
        .map(({ flag }) => flag);
      if (conflicts.length > 0) {
        // The bundle may have been passed by nobody. `parseArgs` folds
        // CONSOLE_CREDENTIAL_BUNDLE into this field whenever `--silent` is in
        // effect, so an operator who exported it during install and later runs
        // `config --api-key hbr_… --silent` to swap keys reaches this refusal
        // having typed no `--credential-bundle` — and a message naming that flag
        // sends them searching their own command line for it. The remedy is to
        // unset the variable, which the message can only say if it knows the
        // variable is what supplied the value. `env` is the same snapshot
        // `parseArgs` read, so this is that read repeated rather than a guess.
        //
        // The refusal itself stays: it is tempting to let explicit flags simply
        // beat an env-sourced bundle, but the branch below is all-or-nothing —
        // a bundle takes the whole write and the individual flags are not
        // consulted at all — so "exempting" the env bundle would silently discard
        // the `--api-key` the operator did type and save the bundle's old key
        // instead. A refusal that names the right knob is the smaller failure.
        const fromEnv = (env["CONSOLE_CREDENTIAL_BUNDLE"] ?? "").trim() === values.bundle;
        errors.push(
          fromEnv
            ? `CONSOLE_CREDENTIAL_BUNDLE is set in this environment, and \`--silent\` reads it as ` +
                `--credential-bundle — which already carries the values ${conflicts.join(", ")} ` +
                `supplies. Unset CONSOLE_CREDENTIAL_BUNDLE, or drop ${conflicts.join(", ")}: one ` +
                `source or the other, not both.`
            : `--credential-bundle already carries the values ${conflicts.join(", ")} supplies. ` +
                `Pass one or the other, not both.`,
        );
      } else {
        // An address flag beside a bundle is a second statement of the same pin,
        // not a conflict: equal proceeds, anything else refuses (see
        // `seedDisagreement`).
        // One seeds object for both the check and the write: `bundleWrite`
        // applies the owner seed a management bundle cannot answer for itself,
        // so the two must be looking at the same values.
        const seeds: PinSeeds = {
          ownerAddress: values.ownerAddress,
          keyAdminAddress: values.keyAdminAddress,
        };
        // Validated with the same check the non-bundle branch uses, and BEFORE
        // the comparison: `seedDisagreement` normalizes both sides, so a junk
        // seed would otherwise be reported (and, for an owner-less management
        // bundle, written) as zero-padded nonsense. Both flags are reported,
        // matching the non-bundle branch — the comparison only runs once both
        // are well-formed, because there is nothing meaningful to compare
        // against a malformed one.
        const seedProblems = seedFlagErrors(seeds);
        if (seedProblems.length === 0) {
          const disagreement = seedDisagreement(parsed.bundle, seeds);
          if (disagreement) seedProblems.push(disagreement);
        }
        if (seedProblems.length > 0) errors.push(...seedProblems);
        else {
          // Before the probe, whose fetch error can embed the Bearer header.
          registerBundleSecrets(parsed.bundle, parsed.source);
          const probeKind = parsed.bundle.kind;
          const problem = verdictMessage(
            await probe(probeKind, bundleKey(parsed.bundle)),
            probeKind,
          );
          if (problem) errors.push(problem);
          else {
            const write = bundleWrite(parsed.bundle, seeds);
            if (parsed.bundle.kind === "admin") {
              const pinned = applyDerivedAdminPin(
                write.updates,
                parsed.bundle.adminServicePrivateKey,
                // Bundle first, then the flag `seedDisagreement` left for the
                // signer to answer — see `collectBundle`.
                parsed.bundle.keyAdminAddress ?? values.keyAdminAddress,
              );
              if ("error" in pinned) errors.push(pinned.error);
            }
            Object.assign(updates, write.updates);
            clear.push(...write.clear);
            if (!pinSurvives("webAccountAddress", write, existing)) {
              warnings.push(NO_OWNER_PIN_WARNING);
            }
            if (!pinSurvives("keyAdminAddress", write, existing)) {
              warnings.push(NO_KEY_ADMIN_PIN_WARNING);
            }
          }
        }
      }
    }
  } else {
    validateAddressFlag(
      values.ownerAddress,
      "--owner-address",
      "webAccountAddress",
      updates,
      errors,
    );
    validateAddressFlag(
      values.keyAdminAddress,
      "--key-admin-address",
      "keyAdminAddress",
      updates,
      errors,
    );
  }

  // The working pair: from flags when there is no bundle, or beside an ADMIN
  // bundle, which says nothing about the working key. A working bundle already
  // refused these flags as a conflict.
  if (bundleKind !== "api") {
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
    } else if (values.apiKey && existing.servicePrivateKey) {
      // Same matched-pair reasoning as the interactive path, minus the question:
      // --silent has no channel to ask on. Clearing is the right default of the
      // two, because a retained mismatched signer does not fail here — it fails
      // later inside Seal, far from anything that names the cause.
      clear.push("servicePrivateKey");
    }
  }

  // The management pair, symmetric: never beside an admin bundle (refused above).
  if (bundleKind !== "admin" && (values.adminKey || values.adminSigner)) {
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
        // The pin to check is whatever THIS write has already resolved, not the
        // flag: `validateAddressFlag` puts `--key-admin-address` there, and a
        // working bundle beside this pair puts the bundle's own pin there. Both
        // are a second source naming the same address, and both must agree —
        // reading the flag alone let a bundle's pin be replaced by the
        // derivation with no comparison and no message.
        const pinned = applyDerivedAdminPin(updates, values.adminSigner, updates.keyAdminAddress);
        if ("error" in pinned) errors.push(pinned.error);
        // The bundle branch queued both of these for a `null` pin, and this block
        // has just answered it. `mergeConfigFile` applies `clear` after
        // `updates`, so the queued clear would delete the address just derived;
        // the queued warning would tell the operator this host has no Key-Admin
        // immediately after saving one.
        else {
          clear = clear.filter((field) => field !== "keyAdminAddress");
          warnings = warnings.filter((warning) => warning !== NO_KEY_ADMIN_PIN_WARNING);
        }
      }
    }
  }

  if (values.allowedDirs && values.allowedDirs.length > 0) {
    const dirs: string[] = [];
    for (const raw of values.allowedDirs) {
      const result = validateAllowedDirectory(raw);
      if ("error" in result) errors.push(`--allowed-dirs: ${result.error}`);
      else if (!dirs.includes(result.dir)) dirs.push(result.dir);
    }
    if (errors.length === 0) updates.allowedDirs = dirs;
  }

  // Warnings are dropped alongside the write they described: nothing was saved,
  // so there is no state for them to warn about, and the errors are the message.
  if (errors.length > 0) {
    return { updates: {}, clear: [], errors, warnings: [] };
  }

  // A silent `--api-key` install is the common path, and this branch is what
  // made it refuse `create_bucket` when no owner pin is present. Warn only
  // when we just wrote a working key AND no pin is resolvable from the write,
  // the saved file (unless this write is clearing it), or the env. An
  // env-configured host must stay silent — that is a pin, just not one this
  // helper persists. The bundle path already emits this warning when the
  // bundle's owner is null; skip it there so the operator sees it once.
  if (updates.apiKey && !values.bundle && !warnings.includes(NO_OWNER_PIN_WARNING)) {
    const fromWrite = Boolean(updates.webAccountAddress);
    const fromFile = !clear.includes("webAccountAddress") && Boolean(existing.webAccountAddress);
    const fromEnv = (env["CONSOLE_WEB_ACCOUNT_ADDRESS"] ?? "").trim().length > 0;
    if (!fromWrite && !fromFile && !fromEnv) {
      warnings.push(NO_OWNER_PIN_WARNING);
    }
  }

  return { updates, clear, errors, warnings };
}
