/**
 * Flag parsing for the `install` and `config` verbs.
 *
 * Pure: takes argv and an env snapshot, returns a plain result. No process
 * access, no I/O — so silent mode is fully unit-testable.
 */

export interface CredentialValues {
  apiKey?: string;
  serviceKey?: string;
  adminKey?: string;
  adminSigner?: string;
}

export interface ParsedArgs {
  /** True when any value flag was given, or --silent was passed. */
  silent: boolean;
  /** `install` only; --no-register turns it off. */
  register: boolean;
  values: CredentialValues;
  errors: string[];
}

const VALUE_FLAGS: Record<string, keyof CredentialValues> = {
  "--api-key": "apiKey",
  "--service-key": "serviceKey",
  "--admin-key": "adminKey",
  "--admin-signer": "adminSigner",
};

const ENV_FLAGS: Record<string, keyof CredentialValues> = {
  CONSOLE_API_KEY: "apiKey",
  CONSOLE_SERVICE_PRIVATE_KEY: "serviceKey",
  CONSOLE_ADMIN_KEY: "adminKey",
  CONSOLE_ADMIN_SERVICE_PRIVATE_KEY: "adminSigner",
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
          : "Unexpected argument. Pass credentials with --api-key/--service-key/--admin-key/--admin-signer.",
      );
      continue;
    }

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
    for (const [envName, field] of Object.entries(ENV_FLAGS)) {
      const raw = env[envName];
      if (values[field] === undefined && raw && raw.trim() !== "") {
        values[field] = raw.trim();
      }
    }
  }

  return { silent: explicitSilent || sawValueFlag, register, values, errors };
}
