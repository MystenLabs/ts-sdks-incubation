import { cursorConfigPath } from "../src/clients.js";
import {
  type ConfigFileData,
  getConfigDir,
  getConfigFilePath,
  loadConfigFile,
  mergeConfigFileIf,
} from "../src/configFile.js";
import {
  type CredentialBundle,
  type KeyKind,
  type ProbeVerdict,
  parseCredentialBundle,
  NO_KEY_ADMIN_PIN_WARNING,
  NO_OWNER_PIN_WARNING,
  probeKey,
  validateSilent,
} from "../src/credentials.js";
import {
  IMPORT_BUNDLE_FLAG,
  IMPORTED_BUNDLE_PLACEHOLDER,
  type StripOutcome,
  stripBundleFromCursorConfig,
} from "../src/cursorEntry.js";
import { registerSecret } from "../src/redaction.js";
import { applyResolvedBaseUrl, resolveInstallBaseUrl } from "./install.js";

/**
 * `walrus-console-mcp --import-bundle <base64url>`: the first start from an
 * Add to Cursor link.
 *
 * The link cannot write a file or run a command; all it can do is add a
 * `{command, args}` entry to `~/.cursor/mcp.json`. So the bundle arrives here
 * as an argument, is saved through the same checks and the same locked write
 * as `config --credential-bundle --silent`, and is then removed from
 * `mcp.json` (see src/cursorEntry.ts). This runs before the server reads its
 * credentials, and never stops the server from starting: every outcome is one
 * line on stderr, which Cursor shows in the server's output log.
 */

export type ImportOutcome =
  /** The entry carried the placeholder: an earlier start already handled it. */
  | { kind: "placeholder" }
  | { kind: "imported"; warnings: string[] }
  /** This exact bundle is already saved, by a concurrent copy of this server. */
  | { kind: "already-imported" }
  /** A different key is already saved; an install link never replaces one. */
  | { kind: "kept-existing" }
  /** The bundle can never be saved: malformed, or the key was refused. */
  | { kind: "rejected"; reason: string }
  /** Could not be saved this time (Console unreachable, a local write failed). */
  | { kind: "deferred"; reason: string };

export interface ImportDeps {
  /** Validates the key against Console. Defaults to `probeKey`. */
  probe?: (kind: KeyKind, key: string, baseUrl: string) => Promise<ProbeVerdict>;
  /** Cursor's global MCP config. Defaults to `~/.cursor/mcp.json`. */
  cursorConfigPath?: string;
  /** Where the one-line report goes. Defaults to a prefixed `console.error`. */
  log?: (message: string) => void;
}

/**
 * Find the bundle in the server's argv. Returns null when the flag is absent,
 * so the caller can skip this module entirely.
 */
export function parseImportBundleArg(
  argv: readonly string[],
): { value: string; raw: string } | { error: string } | null {
  const index = argv.findIndex(
    (arg) => arg === IMPORT_BUNDLE_FLAG || arg.startsWith(`${IMPORT_BUNDLE_FLAG}=`),
  );
  if (index === -1) return null;
  const arg = argv[index] ?? "";
  const raw =
    arg === IMPORT_BUNDLE_FLAG ? argv[index + 1] : arg.slice(IMPORT_BUNDLE_FLAG.length + 1);
  if (raw === undefined || raw.trim() === "") {
    return { error: `${IMPORT_BUNDLE_FLAG} needs a value` };
  }
  // `raw` is what mcp.json stores and the strip must match; `value` is what
  // decodes. They differ only by surrounding whitespace.
  return { value: raw.trim(), raw };
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Decode the link's base64url into the bundle JSON text.
 *
 * `Buffer.from(…, "base64url")` never fails: it skips characters outside the
 * alphabet and decodes whatever is left, so a mangled or truncated link would
 * reach the JSON parser as quiet garbage. The alphabet and the length are
 * therefore checked first, and the bytes must be valid UTF-8. Messages name
 * what is wrong, never the value.
 */
export function decodeBundleArg(value: string): { json: string } | { error: string } {
  // Padding is not part of base64url, but tolerate it rather than refuse a
  // link built by an encoder that adds it.
  const unpadded = value.replace(/=+$/, "");
  if (!BASE64URL.test(unpadded)) {
    return { error: "the bundle in the link is not base64url" };
  }
  // No whole number of bytes ends one character into a four-character group.
  if (unpadded.length % 4 === 1) {
    return { error: "the bundle in the link is truncated" };
  }
  try {
    const bytes = Buffer.from(unpadded, "base64url");
    return { json: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { error: "the bundle in the link does not decode to text" };
  }
}

/** Whether a key of either kind is already saved. */
function hasSavedKey(saved: ConfigFileData): boolean {
  return saved.apiKey !== undefined || saved.adminKey !== undefined;
}

/** Whether `saved` holds this bundle's exact pair, signer included. */
function holdsPair(saved: ConfigFileData, bundle: CredentialBundle): boolean {
  return bundle.kind === "api"
    ? saved.apiKey === bundle.apiKey && saved.servicePrivateKey === bundle.servicePrivateKey
    : saved.adminKey === bundle.adminKey &&
        saved.adminServicePrivateKey === bundle.adminServicePrivateKey;
}

/**
 * Decide what this bundle may do to the saved config.
 *
 * What a link must never do is replace a key the user already has, so the
 * refusal turns on a saved KEY, not on the file: a config.json holding only
 * folders (`install` with the credential step skipped), or nothing at all,
 * has no key to protect, and refusing there would only strip a one-time
 * bundle and leave the user with no key.
 *
 * A saved copy of this exact pair is finished (every field the write carries
 * is already there: a concurrent copy got here first), half-written
 * (`saveConfigFile` writes admin.json before config.json, so a failed second
 * write leaves the pair without its pins), or carries a field this write would
 * CHANGE. Only the half-written case writes, and the merge then only fills
 * what is missing. A saved field that differs, or that the write would clear,
 * is a pin or host the user may have chosen, so it is kept rather than
 * overwritten by a repair.
 */
export function classifyAgainstSaved(
  saved: ConfigFileData,
  bundle: CredentialBundle,
  write: { updates: Partial<ConfigFileData>; clear: readonly (keyof ConfigFileData)[] },
): "write" | "already-imported" | "kept-existing" {
  if (!hasSavedKey(saved)) return "write";
  if (!holdsPair(saved, bundle)) return "kept-existing";
  let missing = false;
  for (const [field, value] of Object.entries(write.updates)) {
    const current = saved[field as keyof ConfigFileData];
    if (current === undefined) missing = true;
    else if (JSON.stringify(current) !== JSON.stringify(value)) return "kept-existing";
  }
  if (write.clear.some((field) => saved[field] !== undefined)) return "kept-existing";
  return missing ? "write" : "already-imported";
}

/**
 * Save the bundle, without touching `mcp.json`. See `runImportBundle` for the
 * whole first start.
 */
export async function importBundle(value: string, deps: ImportDeps = {}): Promise<ImportOutcome> {
  if (value === IMPORTED_BUNDLE_PLACEHOLDER) return { kind: "placeholder" };

  // Before anything can log: a thrown error below may carry either form.
  registerSecret(value);
  const decoded = decodeBundleArg(value);
  if ("error" in decoded) return { kind: "rejected", reason: decoded.error };
  registerSecret(decoded.json);
  // Parsed before anything that can defer, so a bundle that can never import
  // is always rejected (and stripped), whatever else is wrong with this start.
  const parsed = parseCredentialBundle(decoded.json);
  if ("error" in parsed) return { kind: "rejected", reason: parsed.error };
  const { bundle } = parsed;

  // Checked before the probe as well as inside the write's lock below: a link
  // must not cost a round trip, or send the key anywhere, when it will not be
  // saved. `loadConfigFile`, not the forgiving read: a corrupt file cannot be
  // merged into, and reading it as empty would report no key and then fail.
  let saved: ConfigFileData;
  try {
    saved = loadConfigFile();
  } catch (err) {
    return { kind: "deferred", reason: (err as Error).message };
  }
  if (hasSavedKey(saved) && !holdsPair(saved, bundle)) return { kind: "kept-existing" };

  // A repeat of a bundle already saved needs only the strip, so it is decided
  // here, before the host check and the probe: an outage must not keep a
  // finished bundle in mcp.json. The plan comes from the same validation with
  // a probe that answers locally; the host is left out, since a finished
  // repeat writes nothing and so cannot change it.
  if (hasSavedKey(saved)) {
    const offline = await validateSilent({ bundle: decoded.json }, async () => "ok", {});
    if (offline.errors.length === 0) {
      const early = classifyAgainstSaved(saved, bundle, offline);
      if (early !== "write") return { kind: early };
    }
  }

  let baseUrl: string;
  try {
    baseUrl = resolveInstallBaseUrl(() => {});
  } catch (err) {
    // The environment names a host the allowlist refuses. The bundle parsed,
    // and fixing the environment makes the next start succeed.
    return { kind: "deferred", reason: (err as Error).message };
  }

  // `validateSilent` reports failures as text only, and the retry decision
  // needs to know whether the probe itself could not reach Console.
  let verdict: ProbeVerdict | undefined;
  const probe = deps.probe ?? probeKey;
  const { updates, clear, errors, warnings } = await validateSilent(
    { bundle: decoded.json },
    async (kind, key) => (verdict = await probe(kind, key, baseUrl)),
    {},
  );
  if (errors.length > 0) {
    const reason = errors.join(" ").replace(/^--credential-bundle: /, "");
    // Only an unreachable Console is worth a retry. A refused key fails the
    // same way on every start, and keeping it would only leave the secret in
    // mcp.json.
    return verdict === "unreachable" ? { kind: "deferred", reason } : { kind: "rejected", reason };
  }

  const write = { updates, clear: [...clear, ...applyResolvedBaseUrl(updates, baseUrl)] };
  try {
    // The decision runs inside the config write's own lock, so a `config` or
    // `install` saving at the same moment cannot land between the check and
    // the write, and a second copy of this server sees the first one's write.
    const result = mergeConfigFileIf(
      (before) => classifyAgainstSaved(before, bundle, write) === "write",
      write.updates,
      write.clear,
      () => {},
    );
    if (result.written) {
      // The pin warnings were computed before the merge, against no saved
      // config. A management bundle leaves the saved owner alone, so judge
      // them by what the merge actually wrote.
      const surviving = warnings.filter(
        (warning) =>
          !(warning === NO_OWNER_PIN_WARNING && result.merged.webAccountAddress !== undefined) &&
          !(warning === NO_KEY_ADMIN_PIN_WARNING && result.merged.keyAdminAddress !== undefined),
      );
      return { kind: "imported", warnings: surviving };
    }
    return classifyAgainstSaved(result.before, bundle, write) === "already-imported"
      ? { kind: "already-imported" }
      : { kind: "kept-existing" };
  } catch (err) {
    return { kind: "deferred", reason: (err as Error).message };
  }
}

const PREFIX = "Add to Cursor:";

/** End a reason with a full stop, so the sentence after it reads as one. */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

function reportImport(outcome: ImportOutcome, mcpJson: string, log: (m: string) => void): void {
  switch (outcome.kind) {
    case "placeholder":
      return;
    case "imported":
      log(`${PREFIX} saved the credential bundle from the install link to ${getConfigFilePath()}.`);
      for (const warning of outcome.warnings) log(`${PREFIX} ${warning}`);
      return;
    case "already-imported":
      log(`${PREFIX} the credential bundle was already saved by another copy of this server.`);
      return;
    case "kept-existing":
      log(
        `${PREFIX} did not import the credential bundle: a different key is already saved in ` +
          `${getConfigDir()}, and an install link never replaces a saved key. To switch to this ` +
          "key, run `walrus-console-mcp config`.",
      );
      return;
    case "rejected":
      log(
        `${PREFIX} did not import the credential bundle: ${sentence(outcome.reason)} Nothing was saved.`,
      );
      return;
    case "deferred":
      log(
        `${PREFIX} could not import the credential bundle yet: ${sentence(outcome.reason)} Nothing was ` +
          `saved, and the bundle stays in ${mcpJson} so the next start retries. Turn the server ` +
          "off and on in Cursor's MCP settings to retry now.",
      );
      return;
  }
}

function reportStrip(outcome: StripOutcome, mcpJson: string, log: (m: string) => void): void {
  switch (outcome.kind) {
    case "stripped":
      log(`${PREFIX} removed the credential bundle from ${mcpJson}.`);
      if (outcome.hardened.length > 0) {
        log(
          `${PREFIX} added --prefix to ${outcome.hardened.join(", ")} so npx cannot run a ` +
            "same-named package from an open project.",
        );
      }
      return;
    case "not-found":
    case "missing-file":
      // Started by hand, or from a project-level config. The value is still on
      // this process's command line, so say where it may be.
      log(
        `${PREFIX} the credential bundle was not found in ${mcpJson}. If you added this ` +
          `server by hand, replace the bundle after ${IMPORT_BUNDLE_FLAG} with ` +
          `${IMPORTED_BUNDLE_PLACEHOLDER} wherever you put it.`,
      );
      return;
    case "unreadable":
      log(
        `${PREFIX} could not remove the credential bundle from ${mcpJson}: ${outcome.reason}. ` +
          `Replace the value after ${IMPORT_BUNDLE_FLAG} with ${IMPORTED_BUNDLE_PLACEHOLDER} by hand.`,
      );
      return;
  }
}

/**
 * The whole first start: save the bundle, then take it out of `mcp.json`
 * unless the next start should retry. Never throws.
 */
export async function runImportBundle(
  argv: readonly string[],
  deps: ImportDeps = {},
): Promise<ImportOutcome | null> {
  const log = deps.log ?? ((message: string) => console.error(`[console-mcp] ${message}`));
  const mcpJson = deps.cursorConfigPath ?? cursorConfigPath();
  const arg = parseImportBundleArg(argv);
  if (arg === null) return null;
  if ("error" in arg) {
    log(`${PREFIX} ${sentence(arg.error)}`);
    return { kind: "rejected", reason: arg.error };
  }

  let outcome: ImportOutcome;
  try {
    outcome = await importBundle(arg.value, deps);
  } catch (err) {
    outcome = { kind: "deferred", reason: (err as Error).message };
  }
  reportImport(outcome, mcpJson, log);

  if (outcome.kind === "placeholder" || outcome.kind === "deferred") return outcome;
  try {
    // The raw argument, whitespace and all: that is the string mcp.json holds.
    const strip = stripBundleFromCursorConfig(mcpJson, arg.raw);
    // Cursor's IDE and its agent worker each start a copy from the same entry,
    // and the loser finds it already cleaned. A cleaned entry is evidence of
    // that, not proof: this copy may have been launched from a project's own
    // .cursor/mcp.json, which this code never reads. So the message names both.
    if (outcome.kind === "already-imported" && strip.kind === "not-found" && strip.cleanedEntry) {
      log(
        `${PREFIX} the credential bundle is already removed from ${mcpJson}, most likely by ` +
          "the other copy of this server. If this server is also configured in a project's " +
          `.cursor/mcp.json, replace the bundle after ${IMPORT_BUNDLE_FLAG} there with ` +
          `${IMPORTED_BUNDLE_PLACEHOLDER}.`,
      );
    } else {
      reportStrip(strip, mcpJson, log);
    }
  } catch (err) {
    reportStrip({ kind: "unreadable", reason: (err as Error).message }, mcpJson, log);
  }
  return outcome;
}
