import { format, inspect } from "node:util";

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
] as const;

/**
 * Values shorter than this are ignored when registering. A short or empty
 * "secret" (e.g. an unset var defaulting to "") would otherwise match common
 * substrings and redact half the output. Real Console keys are far longer.
 */
const MIN_SECRET_LENGTH = 8;

export const REDACTION_PLACEHOLDER = "«redacted»";

const secrets = new Set<string>();

/** Register a single secret value. No-ops for empty/short/non-string input. */
export function registerSecret(value: unknown): void {
  if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) {
    secrets.add(value);
  }
}

/** Register every known secret env var from the given environment (default: process.env). */
export function registerSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of SECRET_ENV_VARS) {
    registerSecret(env[name]);
  }
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
 * Build the user-facing text for a failed tool call, with secrets scrubbed.
 * Mirrors the previous inline formatting in `safeTool`, but redacted.
 */
export function formatToolError(toolName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? `\n\n${error.stack}` : "";
  return redactString(`**Error in ${toolName}**\n\n${message}${stack}`);
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
