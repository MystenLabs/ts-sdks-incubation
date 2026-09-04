import { isValidSuiAddress } from "@mysten/sui/utils";
import { Config, Context, Layer, Option, Redacted } from "effect";
import { DEFAULT_CONSOLE_API_BASE_URL, isAllowedBaseUrl } from "./baseUrl.js";
import { type ConfigFileData, loadConfigFile } from "./configFile.js";

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

/**
 * Read the config file once at module load (synchronous, no I/O per-request).
 *
 * `loadConfigFile` now throws on a corrupt/unreadable file rather than masking it
 * as `{}` (so the CLI write path stays fail-stop). But this module loads at boot,
 * so a broken file here would crash a server that is configured entirely through
 * the environment. Catch it loudly and fall back to env-only credentials — the
 * env values still resolve, and `ping_console` can report anything missing.
 */
function loadFileConfigForStartup(): ConfigFileData {
  try {
    return loadConfigFile();
  } catch (err) {
    process.stderr.write(
      `warning: ${(err as Error).message} Ignoring the config file; ` +
        `using environment credentials only.\n`,
    );
    return {};
  }
}

const fileConfig = loadFileConfigForStartup();

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

/**
 * Whether the environment supplies a usable value for `envName` — present AND
 * non-empty after trimming. Mirrors `resolvedString`'s notion of "the env wins":
 * an exported-but-blank or whitespace-only var counts as absent, exactly as it
 * does there, so the two agree on which source a value came from.
 */
const envHasValue = (envName: string) =>
  Config.string(envName).pipe(
    Config.option,
    Config.map((opt) => Option.isSome(opt) && opt.value.trim().length > 0),
  );

interface CredentialSource {
  env: string;
  file: string | undefined;
}

/**
 * Resolve a bearer + its signer *as a pair*, keyed on where each half came from.
 *
 * The hazard is a split source: a bearer taken from the environment paired with a
 * signer left over in the saved config file. That file signer almost certainly
 * belongs to a *different* bearer (the one the file was written for), so signing
 * with it would use a mismatched key. When the bearer resolves from env but the
 * one half resolves from env, drop the *other* half if it came from the file and
 * warn — better a missing half that fails a clear check than a mismatched pair
 * that signs with the wrong key. This is symmetric: env-bearer + file-signer AND
 * file-bearer + env-signer are both mismatches. Both-env and both-file are
 * internally consistent and pass through untouched.
 */
const resolvedPair = (bearer: CredentialSource, signer: CredentialSource) =>
  Config.all({
    bearerWithFile: resolvedString(bearer.env, bearer.file, ""),
    bearerFromEnv: envHasValue(bearer.env),
    signerWithFile: resolvedString(signer.env, signer.file, ""),
    signerFromEnv: envHasValue(signer.env),
  }).pipe(
    Config.map(({ bearerWithFile, bearerFromEnv, signerWithFile, signerFromEnv }) => {
      // Sources agree (both env or both file) → nothing to reconcile.
      if (bearerFromEnv === signerFromEnv) {
        return { bearer: bearerWithFile, signer: signerWithFile };
      }
      if (bearerFromEnv) {
        // Bearer from env, signer from the file → drop the (mismatched) file signer.
        if (signer.file !== undefined && signer.file.length > 0) {
          process.stderr.write(
            `warning: ${bearer.env} is set in the environment but ${signer.env} is not; ` +
              `ignoring the saved ${signer.env} from the config file to avoid pairing a ` +
              `key with a signer it does not match. Set ${signer.env} to use it.\n`,
          );
        }
        return { bearer: bearerWithFile, signer: "" };
      }
      // Signer from env, bearer from the file → drop the (mismatched) file bearer.
      if (bearer.file !== undefined && bearer.file.length > 0) {
        process.stderr.write(
          `warning: ${signer.env} is set in the environment but ${bearer.env} is not; ` +
            `ignoring the saved ${bearer.env} from the config file to avoid pairing a ` +
            `signer with a key it does not match. Set ${bearer.env} to use it.\n`,
        );
      }
      return { bearer: "", signer: signerWithFile };
    }),
  );

/**
 * Resolve `CONSOLE_API_BASE_URL` and enforce the base-URL allowlist. A
 * disallowed value fails config construction (and thus every tool) rather than
 * silently redirecting the Bearer API key to an arbitrary host.
 */
export const resolvedBaseUrl = (fileValue: string | undefined) =>
  resolvedString("CONSOLE_API_BASE_URL", fileValue, DEFAULT_CONSOLE_API_BASE_URL).pipe(
    Config.validate({
      message: "CONSOLE_API_BASE_URL must be https to a walrus.xyz host, or http(s) to localhost",
      validation: isAllowedBaseUrl,
    }),
  );

/**
 * Resolve a Sui-address config pin (`CONSOLE_WEB_ACCOUNT_ADDRESS` /
 * `CONSOLE_KEY_ADMIN_ADDRESS`). These are new, non-secret trust anchors — plain
 * strings, not `Redacted` — that a later create-bucket call pins as the owner
 * and manager recipients of the bucket. The server cannot write them, so a
 * malformed ENV value fails config construction rather than resolving to
 * "absent": a typo here would otherwise silently pin the wrong recipient,
 * which is worse than refusing to start. Mirrors `resolvedBaseUrl`'s
 * Config.validate precedent above.
 *
 * A malformed config-FILE value never reaches this validator at all —
 * `loadConfigFile` drops it at load time (the same `isValidSuiAddress` guard
 * used for `baseUrl`, see configFile.ts:104-107) — so only a *present* file
 * value here is already known-valid. `""` (absent everywhere) always passes:
 * it means no pin configured, not an error.
 */
export const resolvedOptionalAddress = (envName: string, fileValue: string | undefined) =>
  resolvedString(envName, fileValue, "").pipe(
    Config.validate({
      message: `${envName} must be a valid Sui address`,
      validation: (s) => s === "" || isValidSuiAddress(s),
    }),
  );

export const ConsoleConfig = Config.all({
  // Working credential: `hbr_` bearer + its on-chain signer seed, resolved as a
  // pair so an env bearer never gets silently paired with a stale file signer.
  working: resolvedPair(
    { env: "CONSOLE_API_KEY", file: fileConfig.apiKey },
    { env: "CONSOLE_SERVICE_PRIVATE_KEY", file: fileConfig.servicePrivateKey },
  ),
  // Key-Admin (management) credential: `hbradm_` bearer + its on-chain signer seed.
  // Resolved env → installer-saved file → "" so a provisioning host can be configured
  // by `walrus-console-mcp config` instead of exported env vars. Both default to ""
  // so absence never fails startup; hasAdminCredential() guards the empty case. Same
  // by-source pairing as the working credential above.
  admin: resolvedPair(
    { env: "CONSOLE_ADMIN_KEY", file: fileConfig.adminKey },
    { env: "CONSOLE_ADMIN_SERVICE_PRIVATE_KEY", file: fileConfig.adminServicePrivateKey },
  ),
  // main's allowlist-enforcing resolver, not the plain string one this branch
  // had: a config-file baseUrl must not redirect the Bearer key to a foreign host.
  baseUrl: resolvedBaseUrl(fileConfig.baseUrl),
  // Trust-anchor pins for the create-bucket owner/manager recipients (COMG-761).
  // Plain strings, not Redacted — these are not secrets. "" = no pin configured.
  webAccountAddress: resolvedOptionalAddress(
    "CONSOLE_WEB_ACCOUNT_ADDRESS",
    fileConfig.webAccountAddress,
  ),
  keyAdminAddress: resolvedOptionalAddress("CONSOLE_KEY_ADMIN_ADDRESS", fileConfig.keyAdminAddress),
}).pipe(
  Config.map(({ working, admin, baseUrl, webAccountAddress, keyAdminAddress }) => ({
    apiKey: Redacted.make(working.bearer),
    servicePrivateKey: Redacted.make(working.signer),
    adminKey: Redacted.make(admin.bearer),
    adminServicePrivateKey: Redacted.make(admin.signer),
    baseUrl,
    webAccountAddress,
    keyAdminAddress,
  })),
);

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

// Address-pin getters — `cfg.webAccountAddress`/`cfg.keyAdminAddress` represent
// "absent" as `""` (see `resolvedOptionalAddress`), the same convention as the
// raw credential getters above. These convert that to `undefined` so callers
// don't have to know the internal sentinel.
export const getWebAccountAddress = (cfg: ConsoleConfig): string | undefined =>
  cfg.webAccountAddress === "" ? undefined : cfg.webAccountAddress;

export const getKeyAdminAddress = (cfg: ConsoleConfig): string | undefined =>
  cfg.keyAdminAddress === "" ? undefined : cfg.keyAdminAddress;
