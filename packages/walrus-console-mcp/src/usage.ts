/**
 * `--help` for the two CLI verbs.
 *
 * Plain strings, no colour and no imports. A usage screen gains nothing from
 * either, and keeping this module free of both means the two verbs can answer
 * `--help` without pulling in anything that could fail first.
 *
 * tests/usage.test.ts asserts that every flag `parseArgs` accepts appears here,
 * so a new flag cannot ship undocumented.
 */

/** The flag names that mean "print usage and do nothing else". */
export function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

/**
 * True when usage was asked for, anywhere in the arguments.
 *
 * `valueFlags` are the flags that consume the token after them (pass
 * `VALUE_TAKING_FLAGS` from src/cliArgs.ts). A help flag sitting in one of
 * those positions is a bad value, not a request: `install --allowed-dirs -h`
 * has to stay the error it always was rather than quietly exiting 0.
 */
export function wantsHelp(argv: readonly string[], valueFlags: readonly string[] = []): boolean {
  return argv.some((arg, i) => {
    if (!isHelpFlag(arg)) return false;
    const previous = argv[i - 1];
    // `--flag=value` carries its value inline and never consumes what follows.
    return previous === undefined || previous.includes("=") || !valueFlags.includes(previous);
  });
}

const CREDENTIAL_FLAGS = `  --credential-bundle <json>   The whole bundle the Console reveals once, after
                               a key mint: key, signer and both address pins.
  --api-key <key>              Everyday key: buckets, upload, download.
  --service-key <key>          Sui signer that goes with the API key.
  --admin-key <key>            Management key: mints keys via generate_api_key.
  --admin-signer <key>         Sui signer that goes with the management key.
  --owner-address <0x...>      Pin the owner a created bucket is granted to.
  --key-admin-address <0x...>  Pin its Key-Admin manager.
  --allowed-dirs <dir>         A folder upload and download may use. Repeatable.`;

const SILENT_FLAG = `  --silent                     Do not prompt. Take the values from the flags and
                               the environment, write them, exit.`;

const HELP_FLAG = `  -h, --help                   Print this screen.`;

const ENVIRONMENT = `Environment (read under --silent only)
  CONSOLE_CREDENTIAL_BUNDLE, CONSOLE_API_KEY, CONSOLE_SERVICE_PRIVATE_KEY,
  CONSOLE_ADMIN_KEY, CONSOLE_ADMIN_SERVICE_PRIVATE_KEY, CONSOLE_MCP_ALLOWED_DIRS

  Prefer these over the flags for a scripted install: a flag lands in the shell
  history and in the output of ps.`;

export const INSTALL_USAGE = `Set up walrus-console-mcp: save credentials, choose the folders upload and
download may use, then register the launcher with the agents you tick.

Usage
  walrus-console-mcp install [flags]

Flags
${CREDENTIAL_FLAGS}
${SILENT_FLAG}
  --no-register                Save the credentials, skip the agent step.
${HELP_FLAG}

${ENVIRONMENT}

Example
  walrus-console-mcp install --allowed-dirs ~/Documents

After it finishes, restart your agent. A session that was already running will
not see the tools until it is restarted.`;

export const CONFIG_USAGE = `Change the saved credentials, or the folders upload and download may use, on a
machine that is already set up. Agent registration is untouched: it records the
launch command only, never a key, so changing a key does not change it.

Usage
  walrus-console-mcp config [flags]

Flags
${CREDENTIAL_FLAGS}
${SILENT_FLAG}
${HELP_FLAG}

${ENVIRONMENT}

Example
  walrus-console-mcp config --silent --allowed-dirs ~/Documents`;

export const ROOT_USAGE = `walrus-console-mcp: the MCP server for Walrus Console.

Usage
  walrus-console-mcp            Serve over stdio. This is what an agent runs,
                                and it is not meant to be typed by hand.
  walrus-console-mcp install    Save credentials, pick folders, register agents.
  walrus-console-mcp config     Change credentials or folders later.
  walrus-console-mcp --import-bundle <base64url>
                                Serve, first saving the credential bundle an
                                Add to Cursor link carries.

  walrus-console-mcp install --help
  walrus-console-mcp config --help
                                The flags for that command.`;
