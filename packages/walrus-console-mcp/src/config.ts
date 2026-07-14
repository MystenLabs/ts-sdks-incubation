import { Config, Context, Layer, Redacted } from "effect";
import { loadConfigFile } from "./configFile.js";

/**
 * Console MCP configuration loaded from env + optional config file (XDG).
 * All secrets are redacted (never appear in logs/spans).
 * Matches console/api Config patterns + Effect best practices.
 *
 * Priority: env var → config file → hardcoded default.
 * The config file (~/.config/walrus-console-mcp/config.json) is written by
 * `walrus-console-mcp install` and read once at layer construction time.
 *
 * We expose both the raw Config *and* a Context.Tag so services can `yield* ConsoleConfig`.
 */

// Read the config file once at module load (synchronous, no I/O per-request).
const fileConfig = loadConfigFile();

/**
 * Resolve a string setting with priority: non-empty env var → non-empty config-file
 * value → fallback.
 *
 * Effect's Config treats an empty ("") env var as PRESENT, so an exported-but-blank
 * `CONSOLE_API_KEY=` would otherwise shadow a valid installer-saved key. `validate`
 * turns empty/whitespace into a config error so `orElse` reaches the file value.
 * Nothing here throws when every source is empty — it resolves to `fallback`, so the
 * config layer always builds and ping_console can report missing credentials instead
 * of failing startup.
 */
export const resolvedString = (envName: string, fileValue: string | undefined, fallback: string) =>
  Config.string(envName).pipe(
    Config.validate({ message: `${envName} is empty`, validation: (s) => s.trim().length > 0 }),
    Config.orElse(() => Config.succeed(fileValue && fileValue.length > 0 ? fileValue : fallback)),
    Config.map((s) => s.trim()),
  );

export const ConsoleConfig = Config.all({
  apiKey: resolvedString("CONSOLE_API_KEY", fileConfig.apiKey, "").pipe(Config.map(Redacted.make)),
  servicePrivateKey: resolvedString(
    "CONSOLE_SERVICE_PRIVATE_KEY",
    fileConfig.servicePrivateKey,
    "",
  ).pipe(Config.map(Redacted.make)),
  // Key-Admin credential (hbradm_) + its on-chain signer seed. Env-only, loaded only on
  // the provisioning host; both default to "" so absence never fails runtime startup, and
  // hasAdminCredential() guards the empty case. A working key cannot mint — generate_api_key
  // requires both of these.
  adminKey: Config.redacted("CONSOLE_ADMIN_KEY").pipe(Config.withDefault(Redacted.make(""))),
  adminServicePrivateKey: Config.redacted("CONSOLE_ADMIN_SERVICE_PRIVATE_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  baseUrl: resolvedString(
    "CONSOLE_API_BASE_URL",
    fileConfig.baseUrl,
    "https://api.testnet.harbor.walrus.xyz",
  ),
});

export type ConsoleConfig = Config.Config.Success<typeof ConsoleConfig>;

export class ConsoleConfigTag extends Context.Tag("ConsoleConfig")<
  ConsoleConfigTag,
  ConsoleConfig
>() {}

export const ConsoleConfigLive = Layer.effect(
  ConsoleConfigTag,
  ConsoleConfig.pipe(Config.map((cfg) => cfg as ConsoleConfig)),
);

// Raw (sensitive) value helpers — only call inside redacted scopes or when building headers/keys
const unwrap = (v: string | Redacted.Redacted<string>): string =>
  typeof v === "string" ? v : Redacted.value(v);

export const getRawApiKey = (cfg: ConsoleConfig): string => Redacted.value(cfg.apiKey);
export const getRawServiceKey = (cfg: ConsoleConfig): string => unwrap(cfg.servicePrivateKey);

// Admin (Key-Admin) credential getters — mirror the working-key helpers above.
export const getRawAdminKey = (cfg: ConsoleConfig): string => unwrap(cfg.adminKey);
export const getRawAdminServiceKey = (cfg: ConsoleConfig): string =>
  unwrap(cfg.adminServicePrivateKey);

/** True only when BOTH halves of the Key-Admin credential are present. */
export const hasAdminCredential = (cfg: ConsoleConfig): boolean =>
  getRawAdminKey(cfg) !== "" && getRawAdminServiceKey(cfg) !== "";
