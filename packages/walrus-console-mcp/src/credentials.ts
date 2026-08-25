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
import { isValidSuiAddress } from "@mysten/sui/utils";
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
 * Version currently understood by `parseCredentialBundle`. Checked for exact
 * equality — a future bundle version must be rejected outright rather than
 * best-effort parsed as if its shape still matched this one.
 */
const CREDENTIAL_BUNDLE_VERSION = 1;

/**
 * The one-time `CONSOLE_CREDENTIAL_BUNDLE` the Console key-mint UI reveals.
 *
 * Field names are the same as `ConfigFileData` so a saved `config.json` (or a
 * reveal JSON) can be pasted without renaming: `apiKey`, `servicePrivateKey`,
 * `webAccountAddress`, `keyAdminAddress`. Extra config keys (`adminKey`,
 * `baseUrl`, …) are ignored. `v` is optional; if present it must be `1`.
 *
 * Both addresses may legitimately be `null` — a later step (not this parser)
 * warns that `create_bucket` refuses until `webAccountAddress` is pinned.
 */
export interface CredentialBundle {
  readonly apiKey: string;
  readonly servicePrivateKey: string;
  readonly webAccountAddress: string | null;
  readonly keyAdminAddress: string | null;
}

export type ParseCredentialBundleResult = { bundle: CredentialBundle } | { error: string };

/**
 * Validate one address field: either JSON `null`, or a string that
 * `isValidSuiAddress` accepts. Anything else is a structural error, named by
 * field but never by value — see `parseCredentialBundle` for why.
 */
function parseNullableAddress(
  value: unknown,
  fieldName: "webAccountAddress" | "keyAdminAddress",
): { address: string | null } | { error: string } {
  if (value === null || value === undefined) return { address: null };
  if (typeof value === "string" && isValidSuiAddress(value)) return { address: value };
  return { error: `bundle ${fieldName} is not null or a valid Sui address` };
}

/** First own-key among `keys` that is present on `obj` (legacy aliases included). */
function pickField(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(obj, key)) return obj[key];
  }
  return undefined;
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
export function parseCredentialBundle(raw: string): ParseCredentialBundleResult {
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

  const apiKey = obj["apiKey"];
  if (typeof apiKey !== "string" || !isValidApiKeyFormat(apiKey)) {
    return { error: "bundle apiKey is not a Console API key" };
  }

  // Also accept `serviceSecret` so already-copied Harbor reveals still parse.
  const servicePrivateKey = pickField(obj, ["servicePrivateKey", "serviceSecret"]);
  if (typeof servicePrivateKey !== "string" || !isValidServiceKeyFormat(servicePrivateKey)) {
    return { error: "bundle servicePrivateKey is not a valid Sui private key" };
  }

  const owner = parseNullableAddress(
    pickField(obj, ["webAccountAddress", "ownerAddress"]),
    "webAccountAddress",
  );
  if ("error" in owner) return owner;

  const keyAdmin = parseNullableAddress(obj["keyAdminAddress"], "keyAdminAddress");
  if ("error" in keyAdmin) return keyAdmin;

  return {
    bundle: {
      apiKey,
      servicePrivateKey,
      webAccountAddress: owner.address,
      keyAdminAddress: keyAdmin.address,
    },
  };
}

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
 */
function registerBundleSecrets(bundle: CredentialBundle): void {
  registerSecret(bundle.apiKey);
  registerSecret(bundle.servicePrivateKey);
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
 * Map a confirmed bundle onto the fields to write and the fields to remove.
 *
 * **The bundle is authoritative for both pins.** An address it carries as `null`
 * means this key has no such address, so any value saved for a PREVIOUS key is
 * cleared rather than left in place: a stale pin is not a harmless leftover, it
 * is the exact mismatch that makes every future `create_bucket` refuse with a
 * message about an address the operator has never seen.
 *
 * That is the opposite of the manual path (`collectAddressPins`), which merges —
 * skipping a prompt there means "leave it alone", because a bare Enter is an
 * absence of instruction, not a statement that no address exists. The bundle IS
 * that statement.
 */
function bundleWrite(bundle: CredentialBundle): CredentialWrite {
  // Same keys as config.json — no rename. A pasted config file writes through.
  const updates: Partial<ConfigFileData> = {
    apiKey: bundle.apiKey,
    servicePrivateKey: bundle.servicePrivateKey,
  };
  const clear: (keyof ConfigFileData)[] = [];

  if (bundle.webAccountAddress !== null) updates.webAccountAddress = bundle.webAccountAddress;
  else clear.push("webAccountAddress");

  if (bundle.keyAdminAddress !== null) updates.keyAdminAddress = bundle.keyAdminAddress;
  else clear.push("keyAdminAddress");

  return { updates, clear };
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
async function collectBundle(deps: CollectDeps): Promise<CredentialWrite> {
  while (true) {
    const raw = (await deps.ask(PROMPTS.bundle, { masked: true })).trim();
    if (!raw) {
      deps.fail("This value is required.");
      continue;
    }

    const parsed = parseCredentialBundle(raw);
    if ("error" in parsed) {
      // parseCredentialBundle's messages name the field, never the value.
      deps.fail(
        `${parsed.error} — paste the whole one-line JSON from the Console key-mint reveal (or from config.json).`,
      );
      continue;
    }

    // Before the probe: its fetch error can embed the Bearer header.
    registerBundleSecrets(parsed.bundle);
    const problem = verdictMessage(await deps.probe("api", parsed.bundle.apiKey), "api");
    if (problem) {
      deps.fail(problem);
      continue;
    }
    deps.ok("API key verified");

    const { webAccountAddress, keyAdminAddress } = parsed.bundle;
    deps.warn("Check these — they decide who ends up owning a bucket this host creates.");
    deps.info("bucket owner (webAccountAddress):");
    deps.show(webAccountAddress ?? "(none in this bundle)");
    deps.info("Key-Admin (keyAdminAddress):");
    deps.show(keyAdminAddress ?? "(none in this bundle)");

    if (!isAffirmative(await deps.ask(PROMPTS.confirmBundle, { masked: false }))) {
      deps.info("Nothing was saved. Re-run and paste the bundle for this account.");
      return { updates: {}, clear: [] };
    }

    if (webAccountAddress === null) deps.warn(NO_OWNER_PIN_WARNING);
    if (keyAdminAddress === null) deps.warn(NO_KEY_ADMIN_PIN_WARNING);
    return bundleWrite(parsed.bundle);
  }
}

/**
 * Run the prompt sequence for the chosen credential type and return the fields
 * to persist and to remove. Re-prompts on every recoverable problem, so it
 * either returns a complete, valid set or never returns (the caller's Ctrl-C
 * handler exits).
 *
 * `existing` is the currently-saved config, needed only to notice that replacing
 * the API key would strand the signer registered for the OLD key.
 */
export async function collectCredentials(
  choice: CredentialChoice,
  deps: CollectDeps,
  existing: ConfigFileData = {},
): Promise<CredentialWrite> {
  // One paste carries the key, its signer and both pins, so this flow shares
  // nothing with the field-by-field prompts below.
  if (choice === "bundle") return collectBundle(deps);

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
    updates.adminServicePrivateKey = await askForSigner("admin", deps);
  }

  // Last, after both credential pairs, so the key/signer prompts stay contiguous
  // and the pins read as their own section. Only offered where a working key was
  // configured: the pins govern `create_bucket`, which a management-only
  // provisioning host never calls.
  if (choice === "api" || choice === "both") {
    await collectAddressPins(updates, deps, existing);
  }

  return { updates, clear };
}

/** The flags whose fields a `--credential-bundle` also supplies. */
const BUNDLE_CONFLICTS: { field: keyof CredentialValues; flag: string }[] = [
  { field: "apiKey", flag: "--api-key" },
  { field: "serviceKey", flag: "--service-key" },
  { field: "ownerAddress", flag: "--owner-address" },
  { field: "keyAdminAddress", flag: "--key-admin-address" },
];

/**
 * Validate one flag-supplied address pin into `updates`.
 *
 * Merge semantics, like the interactive manual path: an address flag SETS its
 * own field and never touches the other pin. Only a bundle is authoritative
 * enough to remove a pin it did not supply.
 *
 * The error names the flag but never the value (see the no-echo precedent in
 * cliArgs.ts): this flag is a plausible place for a mis-pasted secret to land.
 */
function validateAddressFlag(
  value: string | undefined,
  flag: string,
  field: "webAccountAddress" | "keyAdminAddress",
  updates: Partial<ConfigFileData>,
  errors: string[],
): void {
  if (!value) return;
  if (!isValidSuiAddress(value)) {
    errors.push(`${flag} is not a valid Sui address (expected 0x followed by 64 hex characters).`);
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
  const clear: (keyof ConfigFileData)[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

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
      errors: [
        "No credentials given. Pass --credential-bundle/--api-key/--admin-key, " +
          "--allowed-dirs, or set CONSOLE_* and use --silent.",
      ],
    };
  }

  // The bundle REPLACES the working-credential flags — it supplies the same
  // fields — but composes with the management pair below, which it says nothing
  // about. Dropping `--admin-key` silently because a bundle was also passed
  // would be the worst of the three options.
  if (values.bundle) {
    // Two sources of truth for the same fields is not a merge problem, it is an
    // ambiguity: whichever won, the operator asked for something else. Refuse.
    const conflicts = BUNDLE_CONFLICTS.filter(({ field }) => values[field]).map(({ flag }) => flag);
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
      const parsed = parseCredentialBundle(values.bundle);
      if ("error" in parsed) {
        // Prefixed with the flag, not the value — the bundle is a live credential.
        errors.push(`--credential-bundle: ${parsed.error}.`);
      } else {
        // Before the probe, whose fetch error can embed the Bearer header.
        registerBundleSecrets(parsed.bundle);
        const problem = verdictMessage(await probe("api", parsed.bundle.apiKey), "api");
        if (problem) errors.push(problem);
        else {
          // No confirmation step here, and none is missing: passing the bundle on
          // the command line (or exporting it and asking for --silent) IS the
          // deliberate, explicit act the interactive `[y/N]` exists to obtain.
          const write = bundleWrite(parsed.bundle);
          Object.assign(updates, write.updates);
          clear.push(...write.clear);
          // The interactive path says these out loud at exactly this point; a
          // scripted run has no prompt to say them on, so they ride back on the
          // result instead of being dropped.
          if (parsed.bundle.webAccountAddress === null) warnings.push(NO_OWNER_PIN_WARNING);
          if (parsed.bundle.keyAdminAddress === null) warnings.push(NO_KEY_ADMIN_PIN_WARNING);
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
