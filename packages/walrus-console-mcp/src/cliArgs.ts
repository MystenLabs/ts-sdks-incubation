/**
 * Flag parsing for the `install` and `config` verbs.
 *
 * Pure: takes argv and an env snapshot, returns a plain result. No process
 * access, no I/O — so silent mode is fully unit-testable.
 */

import { ALLOWED_DIRS_ENV, splitAllowedDirList } from "./pathSandbox.js";

export interface CredentialValues {
  apiKey?: string;
  serviceKey?: string;
  adminKey?: string;
  adminSigner?: string;
  /**
   * The whole `CONSOLE_CREDENTIAL_BUNDLE` JSON the Console key-mint reveal shows
   * once: API key, signer secret, and the two address pins in one value. Kept
   * raw here — `parseCredentialBundle` is the only thing that reads inside it.
   */
  bundle?: string;
  /** `--owner-address`: the Sui address to pin as a created bucket's owner. */
  ownerAddress?: string;
  /** `--key-admin-address`: the Sui address to pin as its Key-Admin manager. */
  keyAdminAddress?: string;
  /**
   * `--allowed-dirs`, accumulated across repeated flags. Each entry is still
   * raw (tilde, relative); `validateAllowedDirectory` turns them into canonical
   * paths before they are written.
   */
  allowedDirs?: string[];
}

/**
 * The `CredentialValues` fields that carry a secret, so a CLI entry point can
 * `registerSecret` every one of them before any probe fires (a fetch error can
 * embed the value it was sent with).
 *
 * The two address fields are deliberately ABSENT. They are public trust anchors,
 * not credentials, and registering one would scrub the owner address out of the
 * `create_bucket` disclosure — the field that exists to show a human which
 * account was actually granted the bucket.
 */
export const SECRET_VALUE_FIELDS = [
  "apiKey",
  "serviceKey",
  "adminKey",
  "adminSigner",
  "bundle",
] as const satisfies readonly (keyof CredentialValues)[];

export interface ParsedArgs {
  /** True when any value flag was given, or --silent was passed. */
  silent: boolean;
  /** `install` only; --no-register turns it off. */
  register: boolean;
  values: CredentialValues;
  errors: string[];
}

const VALUE_FLAGS: Record<string, Exclude<keyof CredentialValues, "allowedDirs">> = {
  "--api-key": "apiKey",
  "--service-key": "serviceKey",
  "--admin-key": "adminKey",
  "--admin-signer": "adminSigner",
  "--credential-bundle": "bundle",
  "--owner-address": "ownerAddress",
  "--key-admin-address": "keyAdminAddress",
};

const ENV_FLAGS: Record<string, keyof CredentialValues> = {
  CONSOLE_API_KEY: "apiKey",
  CONSOLE_SERVICE_PRIVATE_KEY: "serviceKey",
  CONSOLE_ADMIN_KEY: "adminKey",
  CONSOLE_ADMIN_SERVICE_PRIVATE_KEY: "adminSigner",
  // Only ever consulted under an explicit `--silent` (see below). The two
  // address pins have no env entry on purpose: the server already reads
  // CONSOLE_WEB_ACCOUNT_ADDRESS / CONSOLE_KEY_ADMIN_ADDRESS at runtime, and
  // silently copying those into the config file would turn a per-shell override
  // into a persisted pin the operator never asked to write down.
  CONSOLE_CREDENTIAL_BUNDLE: "bundle",
};

/** Parse the arguments that follow the verb. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ParsedArgs {
  const values: CredentialValues = {};
  const errors: string[] = [];
  let explicitSilent = false;
  let register = true;
  let sawValueFlag = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--silent") {
      explicitSilent = true;
      continue;
    }
    if (arg === "--no-register") {
      register = false;
      continue;
    }

    const [name, inlineValue] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];

    const takeValue = (): string | undefined => {
      // Only consume the next token as this flag's value if it isn't itself a
      // flag — otherwise a value flag with a missing value would swallow the
      // following flag (or a secret meant for it) as its value, or worse,
      // leak that secret verbatim into an "Unknown flag" error.
      let value = inlineValue;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i++;
        }
      }
      return value;
    };

    // Repeatable, and split only on `path.delimiter` (never on `:`), so a
    // Windows `C:\Users\…` drive letter is one entry. See src/pathSandbox.ts.
    if (name === "--allowed-dirs") {
      const value = takeValue();
      if (value === undefined || value.trim() === "") {
        errors.push(`${name} needs a value`);
        continue;
      }
      const parts = splitAllowedDirList(value);
      if (parts.length === 0) {
        errors.push(`${name} needs a value`);
        continue;
      }
      values.allowedDirs = [...(values.allowedDirs ?? []), ...parts];
      sawValueFlag = true;
      continue;
    }

    const field = VALUE_FLAGS[name];
    if (!field) {
      // Only interpolate the token when it is flag-shaped (`--something`) — a
      // typo'd flag name is safe to echo back. Anything else (a bare value the
      // caller forgot to attach to a flag, e.g. a pasted secret) must never be
      // interpolated into the message: that is exactly how an unmatched secret
      // token would otherwise leak into the terminal/logs.
      errors.push(
        name.startsWith("--")
          ? `Unknown flag: ${name}`
          : "Unexpected argument. Pass credentials with --credential-bundle, or " +
              "--api-key/--service-key/--admin-key/--admin-signer.",
      );
      continue;
    }

    const value = takeValue();
    if (value === undefined || value.trim() === "") {
      errors.push(`${name} needs a value`);
      continue;
    }
    values[field] = value.trim();
    sawValueFlag = true;
  }

  // --silent with no value flags means "take the credentials from the
  // environment" — the documented safer path, since flags land in shell history
  // and `ps` output. Explicit flags still win per-field.
  if (explicitSilent) {
    for (const [envName, field] of Object.entries(ENV_FLAGS) as [
      string,
      Exclude<keyof CredentialValues, "allowedDirs">,
    ][]) {
      const raw = env[envName];
      if (values[field] === undefined && raw && raw.trim() !== "") {
        values[field] = raw.trim();
      }
    }
    // Same "flags win" rule: an explicit `--allowed-dirs` is the whole list.
    // The env var still uses `path.delimiter` (`;` on Windows).
    if (values.allowedDirs === undefined) {
      const raw = env[ALLOWED_DIRS_ENV];
      if (raw && raw.trim() !== "") {
        const parts = splitAllowedDirList(raw);
        if (parts.length > 0) values.allowedDirs = parts;
      }
    }
  }

  return { silent: explicitSilent || sawValueFlag, register, values, errors };
}
