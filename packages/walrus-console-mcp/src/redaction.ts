import { format, inspect } from "node:util";
import type { ConfigFileData } from "./configFile.js";

/**
 * Credential safety guardrail.
 *
 * The server unwraps its configured secrets (the Bearer API key, the service
 * private key) into plain strings to build HTTP headers and decode keypairs.
 * From that point a secret can ride along inside an error and surface in two
 * places the user/operator sees:
 *
 *   - **Tool output** — `safeTool` returns `error.message` + `error.stack`.
 *   - **Logs (stderr)** — `console.error(error)`.
 *
 * The most concrete leak is an `@effect/platform` transport error
 * (`RequestError`/`ResponseError`): it carries the originating request, whose
 * headers include `Authorization: Bearer <CONSOLE_API_KEY>`. A single failed
 * fetch would otherwise print the key.
 *
 * Defence is a single source of truth: register the raw secret VALUES once at
 * startup, then scrub any registered value out of every string that leaves the
 * process — both tool output (`formatToolError` / `redactString`) and logs
 * (`installLogRedaction`). We match on the value itself, so it does not matter
 * which field of which error the secret hid in.
 */

/** Environment variables whose values are treated as secrets. */
export const SECRET_ENV_VARS = [
  "CONSOLE_API_KEY",
  "CONSOLE_SERVICE_PRIVATE_KEY",
  // Present on hosts that also mint keys (Key-Admin). Harmless to list when unset.
  "CONSOLE_ADMIN_KEY",
  "CONSOLE_ADMIN_SERVICE_PRIVATE_KEY",
  // The one-time provisioning bundle: it carries a live API key AND its signer
  // secret in one string, so the whole value is a secret. Registering it does
  // NOT cover the two credentials inside it — redaction matches whole registered
  // values inside output, not the other way round — so `parseCredentialBundle`'s
  // callers register those separately before probing (see src/credentials.ts).
  //
  // The two ADDRESS env vars (CONSOLE_WEB_ACCOUNT_ADDRESS /
  // CONSOLE_KEY_ADMIN_ADDRESS) are deliberately NOT listed. They are public
  // trust anchors, and registering one would scrub the owner address out of the
  // create_bucket disclosure — the field that exists to show a human which
  // account was actually granted the bucket.
  "CONSOLE_CREDENTIAL_BUNDLE",
] as const;

/**
 * Values whose trimmed length is below this are ignored when registering. A short
 * or empty "secret" (e.g. an unset var defaulting to "") would otherwise match
 * common substrings and redact half the output. Real Console keys are far longer.
 */
const MIN_SECRET_LENGTH = 8;

export const REDACTION_PLACEHOLDER = "«redacted»";

const secrets = new Set<string>();

/**
 * Register a single secret value. No-ops for empty/short/non-string input.
 *
 * The TRIMMED form is what gets registered, because it is what reaches the wire:
 * `resolvedString` (src/config.ts) trims the resolved credential before it
 * becomes an `Authorization: Bearer` header, while the env var and the config
 * file are read untrimmed. Registering the padded form would therefore watch for
 * a string that never appears while the real credential passed through unredacted.
 * Registering only the trimmed form is enough — a padded value contains it, and
 * `redactString` matches on substrings, so the secret body is caught either way.
 *
 * Measuring the length after trimming also keeps a whitespace-only value out of
 * the set. Eight spaces would otherwise register as a "secret" and scrub that run
 * of whitespace from every line of output.
 */
export function registerSecret(value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return;
  secrets.add(trimmed);
}

/** Register every known secret env var from the given environment (default: process.env). */
export function registerSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of SECRET_ENV_VARS) {
    registerSecret(env[name]);
  }
}

/**
 * Register the secret-bearing fields of an installer-saved config file.
 *
 * Env-sourced credentials are covered by `registerSecretsFromEnv`; file-sourced
 * ones are not, and an unregistered management key can leak into stderr or tool
 * error output. `baseUrl` is deliberately excluded — it is not a secret, and
 * registering it would scrub every URL from the logs.
 */
export function registerConfigFileSecrets(cfg: ConfigFileData): void {
  registerSecret(cfg.apiKey);
  registerSecret(cfg.servicePrivateKey);
  registerSecret(cfg.adminKey);
  registerSecret(cfg.adminServicePrivateKey);
}

/** Drop all registered secrets. Intended for tests; harmless in production. */
export function clearSecrets(): void {
  secrets.clear();
}

/** Replace every registered secret value found in `text` with the placeholder. */
export function redactString(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) {
      // split/join replaces ALL occurrences without regex-escaping the secret.
      out = out.split(secret).join(REDACTION_PLACEHOLDER);
    }
  }
  return out;
}

/**
 * Render an arbitrary value to a string (Errors keep their stack; objects are
 * deep-inspected like `console` would) and redact it. Used for anything that is
 * not already a plain string.
 */
export function redactValue(input: unknown): string {
  const text =
    typeof input === "string" ? input : inspect(input, { depth: 6, breakLength: Infinity });
  return redactString(text);
}

/**
 * Human-readable body for an error. Tagged errors (Data.TaggedError) carry
 * their data in fields, and their `toJSON` yields those fields + `_tag` without
 * the stack — so a tagged error is always serialized whole.
 *
 * **The `_tag` check must stay ahead of the `message` check.** `Data.TaggedError`
 * extends `Error`, so a tagged error that declares a `message` field satisfies
 * `error instanceof Error && message !== ""` and would exit through the plain
 * branch, discarding `_tag` and every sibling field. That silently disarms any
 * contract built on those fields: `UnsupportedFileTypeError` and
 * `PayloadTooLargeError` (COMG-602) exist so an agent can tell a permanent
 * rejection from a transient one, and they reached the tool boundary as the
 * bare strings "This file type is not accepted." / "Payload too large." —
 * indistinguishable from each other and from a 500. The older tagged errors
 * only escaped this because they happen to leave `.message` empty.
 *
 * Nothing is lost by serializing first: `message` is itself a field, so it
 * survives inside the JSON. Untagged errors (a plain `Error`, an `@effect/platform`
 * transport error) still render as their message.
 */
function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    try {
      // `undefined` when a hand-rolled `toJSON` opts out; treat it as a miss
      // rather than printing the string "undefined" at the tool boundary.
      const json = JSON.stringify(error);
      if (json !== undefined) return json;
    } catch {
      // Unserializable (circular field) — fall through to the message/String path.
    }
  }
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return String(error);
}

/**
 * Build the user-facing text for a failed tool call, with secrets scrubbed.
 * Mirrors the previous inline formatting in `safeTool`, but redacted.
 */
export function formatToolError(toolName: string, error: unknown): string {
  const stack = error instanceof Error && error.stack ? `\n\n${error.stack}` : "";
  return redactString(`**Error in ${toolName}**\n\n${describeError(error)}${stack}`);
}

/** Console methods we wrap. */
type ConsoleMethod = "log" | "error" | "warn" | "info" | "debug";
const CONSOLE_METHODS: readonly ConsoleMethod[] = ["log", "error", "warn", "info", "debug"];

/** Marker so a console is only patched once even if install runs twice. */
const PATCHED = Symbol.for("console-mcp.log-redaction-installed");

type PatchableConsole = Record<ConsoleMethod, (...args: unknown[]) => void> & {
  [PATCHED]?: boolean;
};

/**
 * Wrap `console.*` so every logged line is run through `redactString` first.
 * Uses `util.format` to reproduce exactly what the console would have printed
 * (including deep object/Error rendering), then scrubs registered secrets.
 *
 * This is the backstop that makes "raw credentials never appear in logs" hold
 * even for errors thrown by third-party code (e.g. an HTTP request error that
 * embeds the Authorization header).
 */
export function installLogRedaction(target: Console = console): void {
  const con = target as unknown as PatchableConsole;
  if (con[PATCHED]) return;
  for (const method of CONSOLE_METHODS) {
    const original = con[method].bind(con);
    con[method] = (...args: unknown[]) => {
      original(redactString(format(...args)));
    };
  }
  con[PATCHED] = true;
}
