#!/usr/bin/env node
import * as fs from "node:fs";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";
import { DEFAULT_CONSOLE_API_BASE_URL, isAllowedBaseUrl } from "../src/baseUrl.js";
import { getClients, selectClients } from "../src/clients.js";
import { type ConfigFileData, loadConfigFile, saveConfigFile } from "../src/configFile.js";
import { registerSecret } from "../src/redaction.js";

/** The npm package this installer registers. The server *name* used in agent
 * configs stays unversioned; only the npx package argument gets pinned. */
const PACKAGE_NAME = "walrus-console-mcp";

/**
 * Read this installer's own version from package.json (shipped at the package
 * root, one level above dist/install.js — and above bin/install.ts in dev).
 * Returns null if it can't be read, in which case callers fall back to the
 * unpinned name rather than guessing a version.
 */
export function getPackageVersion(): string | null {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      version?: string;
    };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * The npm spec written into every generated config/command, pinned to the
 * running installer's version (`walrus-console-mcp@1.2.3`). Pinning stops a
 * bad `latest` release from silently breaking every already-installed user —
 * upgrades become an explicit re-install instead of an automatic `npx` float.
 */
export function packageSpec(version = getPackageVersion()): string {
  return version ? `${PACKAGE_NAME}@${version}` : PACKAGE_NAME;
}

/**
 * Interactive 2-step installer for walrus-console-mcp.
 *
 * Step 1 — Auth:   Prompt for API key + service key, validate against the live API.
 * Step 2 — Register: Detect installed agents and register the pinned launcher
 *                    with the ones the user ticks (see src/clients.ts).
 *
 * Runs in the terminal via: npx walrus-console-mcp install
 * Uses only Node.js built-ins (readline, fs, fetch) — zero extra dependencies.
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

/** readline.Interface exposes these at runtime but not in its public types. */
type MaskableInterface = readline.Interface & {
  line: string;
  output?: NodeJS.WritableStream;
  _writeToOutput?: (stringToWrite: string) => void;
};

/**
 * Build the redraw for a masked line: clear the row, jump to column 0, then
 * re-render the (colored) prompt followed by one bullet per typed character.
 * Pure so it can be unit-tested; the escape codes are the only I/O concern.
 */
export function maskedLine(question: string, length: number): string {
  return `\x1b[2K\x1b[0G${question}${"•".repeat(length)}`;
}

/**
 * Like `prompt`, but never echoes the typed characters — each keystroke is
 * redrawn as a bullet so secrets don't leak via screen-share or screenshots.
 * Backspace/paste still work because we rebuild from readline's current `line`.
 * Falls back to a plain prompt when stdout is not a TTY (pipes, CI, tests):
 * there is no terminal echo to hide, and the escape codes would pollute output.
 */
export function promptMasked(rl: readline.Interface, question: string): Promise<string> {
  if (!process.stdout.isTTY) return prompt(rl, question);

  const rli = rl as MaskableInterface;
  const output = rli.output ?? process.stdout;
  const original = rli._writeToOutput?.bind(rli);
  let muted = false;

  return new Promise((resolve) => {
    // While muted, ignore whatever readline wants to echo and redraw the masked
    // line instead. The prompt string itself is written before we mute, so it
    // renders normally.
    rli._writeToOutput = (stringToWrite) => {
      if (!muted) {
        output.write(stringToWrite);
        return;
      }
      output.write(maskedLine(question, rli.line.length));
    };

    rl.question(question, (answer) => {
      muted = false;
      if (original) rli._writeToOutput = original;
      else delete rli._writeToOutput;
      output.write("\n");
      resolve(answer.trim());
    });

    muted = true;
  });
}

function print(msg: string) {
  process.stdout.write(`${msg}\n`);
}

// ─── Style helpers ────────────────────────────────────────────────────────────
// Flat/minimal vocabulary: a uniform symbol set + a 5-space gutter under a step.
const PAD = "     ";
const accent = (s: string) => styleText("cyan", s);
const ok = (msg: string) => `${styleText("green", "✔")} ${msg}`;
const fail = (msg: string) => `${styleText("red", "✖")} ${msg}`;
const warn = (msg: string) => `${styleText("yellow", "!")} ${msg}`;
const info = (msg: string) => styleText("dim", `· ${msg}`);

/** Section header: cyan `n/total` + bold label. */
function printStep(n: number, total: number, label: string) {
  print(`${accent(`${n}/${total}`)}  ${styleText("bold", label)}`);
}

/** A content line indented under the current step. */
function line(msg: string) {
  print(`${PAD}${msg}`);
}

/** A dim secondary line (e.g. a path) nested one level deeper. */
function detail(msg: string) {
  print(`${PAD}   ${styleText("dim", `→ ${msg}`)}`);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Run an async task while showing a one-line spinner under the current step.
 * Clears its line when done so the caller can print the result. Falls back to a
 * static line when stdout is not a TTY (piped output, CI, tests).
 */
async function withSpinner<T>(label: string, task: () => Promise<T>): Promise<T> {
  if (!process.stdout.isTTY) {
    line(info(`${label}…`));
    return task();
  }
  let i = 0;
  const render = () => {
    const frame = styleText("cyan", SPINNER_FRAMES[i] ?? "");
    process.stdout.write(`\r${PAD}${frame} ${styleText("dim", `${label}…`)}`);
    i = (i + 1) % SPINNER_FRAMES.length;
  };
  render();
  const timer = setInterval(render, 80);
  try {
    return await task();
  } finally {
    clearInterval(timer);
    process.stdout.write("\r\x1b[K"); // return to col 0 and clear the line
  }
}

// 24-bit truecolor — explicit RGB so the gradient renders identically across
// terminals, instead of named ANSI colors that each theme remaps differently.
const rgb = (r: number, g: number, b: number, s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;

function printBanner() {
  // Vertical gradient: blue → light blue → purple → white.
  const lines: [number, number, number, string][] = [
    [229, 230, 252, " __      ___   _    ___ _   _ ___    ___ ___  _  _ ___  ___  _    ___ "],
    [
      191,
      191,
      228,
      " \\ \\    / /_\\ | |  | _ \\ | | / __|  / __/ _ \\| \\| / __|/ _ \\| |  | __|",
    ],
    [
      191,
      215,
      239,
      "  \\ \\/\\/ / _ \\| |__|   / |_| \\__ \\ | (_| (_) | .` \\__ \\ (_) | |__| _| ",
    ],
    [
      175,
      212,
      250,
      "   \\_/\\_/_/ \\_\\____|_|_\\\\___/|___/  \\___\\___/|_|\\_|___/\\___/|____|___|",
    ],
  ];
  print("");
  for (const [r, g, b, art] of lines) print(rgb(r, g, b, art));
  print("");
}

// ─── Step 1: Auth ───────────────────────────────────────────────────────────

/**
 * Validate an API key by calling GET /api/v1/spaces.
 * Returns true if the server responds with 200.
 */
export async function validateApiKey(apiKey: string, baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/spaces`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Basic format check for a Sui private key.
 * We cannot validate it against the API (it never leaves the machine).
 */
export function isValidServiceKeyFormat(key: string): boolean {
  return key.startsWith("suiprivkey1") && key.length > 20;
}

async function stepAuth(
  rl: readline.Interface,
): Promise<{ apiKey: string; servicePrivateKey: string; baseUrl: string }> {
  printStep(1, 2, "AUTHENTICATE");
  print("");
  line(`Get credentials at ${accent("https://testnet.harbor.walrus.xyz/")} → Settings → API Keys`);
  print("");

  // API Key (required). The base URL is not prompted — almost everyone uses the
  // testnet default. Power users override it with the CONSOLE_API_BASE_URL env
  // var (also honored by the server's config layer), no install-time question.
  let apiKey = "";
  const baseUrl = resolveInstallBaseUrl();

  while (true) {
    apiKey = await promptMasked(
      rl,
      `${PAD}${accent("CONSOLE_API_KEY")} ${styleText("dim", "(hbr_…)")}: `,
    );
    // Register before validateApiKey — its fetch error can embed the Bearer header.
    registerSecret(apiKey);
    if (!apiKey) {
      line(fail("API key is required."));
      continue;
    }
    if (!apiKey.startsWith("hbr_")) {
      line(fail("API key should start with 'hbr_'."));
      continue;
    }

    const valid = await withSpinner("validating", () => validateApiKey(apiKey, baseUrl));
    if (valid) {
      line(ok("API key verified"));
      break;
    }
    line(fail("Validation failed — check the key or your connection."));
  }
  print("");

  // Service Private Key (optional)
  const servicePrivateKey = await promptMasked(
    rl,
    `${PAD}${styleText("yellow", "[optional]")} ${accent("CONSOLE_SERVICE_PRIVATE_KEY")} ${styleText("dim", "(suiprivkey1…) — Enter to skip")}: `,
  );
  registerSecret(servicePrivateKey);
  if (servicePrivateKey) {
    if (isValidServiceKeyFormat(servicePrivateKey)) {
      line(ok("Service key format looks good"));
    } else {
      line(warn("Service key format unexpected — saved anyway; check it if tools fail"));
    }
  } else {
    line(info("Service key skipped — add it later to enable upload/download"));
  }

  // Save to config file
  const configData: ConfigFileData = { apiKey };
  if (servicePrivateKey) configData.servicePrivateKey = servicePrivateKey;
  if (baseUrl !== DEFAULT_CONSOLE_API_BASE_URL) configData.baseUrl = baseUrl;
  saveConfigFile(configData);
  line(ok("Credentials saved"));
  detail("~/.config/walrus-console-mcp/config.json");
  print("");

  return { apiKey, servicePrivateKey, baseUrl };
}

// ─── Step 2: Register ───────────────────────────────────────────────────────

/**
 * Register the pinned launcher with the agents the user ticks. Detects every
 * supported client, presents an interactive checklist (detected ones
 * pre-ticked), then registers each selection — shelling out to its `mcp add`
 * CLI or merging its JSON config, per the client. A per-client failure is
 * caught and shown with a manual-command fallback so the rest still proceed.
 */
async function stepRegister(spec: string): Promise<void> {
  printStep(2, 2, "REGISTER");
  print("");
  line(
    styleText(
      "dim",
      "Select clients to configure  (↑/↓ move · space toggle · a all · enter confirm)",
    ),
  );
  print("");

  const selected = await selectClients(getClients());

  if (selected === null) {
    print("");
    line(info("Registration cancelled — your saved credentials are untouched."));
    return;
  }
  if (selected.length === 0) {
    print("");
    line(info("No clients selected — nothing registered."));
    return;
  }

  print("");
  for (const client of selected) {
    try {
      client.register(spec);
      line(ok(`${client.label} configured`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      line(warn(`${client.label} not configured — ${msg}`));
      detail(`run manually: ${client.manualHint(spec)}`);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Resolve the base URL from the env override (or the testnet default) and reject
 * an off-policy value. Called at the very start of runInstall — before any
 * readline/prompt machinery — so the rejection surfaces cleanly instead of being
 * swallowed by readline's `close`→cancel handler, and before any key-bearing
 * fetch could leak the API key to a disallowed host.
 */
export function resolveInstallBaseUrl(): string {
  const { CONSOLE_API_BASE_URL } = process.env;
  const baseUrl = CONSOLE_API_BASE_URL || DEFAULT_CONSOLE_API_BASE_URL;
  if (!isAllowedBaseUrl(baseUrl)) {
    throw new Error(
      `CONSOLE_API_BASE_URL is not an allowed Console endpoint: ${baseUrl}. ` +
        `It must be https to a walrus.xyz host, or http(s) to localhost.`,
    );
  }
  return baseUrl;
}

export async function runInstall(): Promise<void> {
  printBanner();

  // Fail fast on a bad base-URL override, before readline is created (see
  // resolveInstallBaseUrl) so the error is not swallowed as a "cancel".
  resolveInstallBaseUrl();

  // Check if already configured
  const existing = loadConfigFile();
  if (existing.apiKey) {
    print(
      warn(`Existing config found (${existing.apiKey.slice(0, 12)}…) — re-running overwrites it.`),
    );
    print("");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Tracks which step we're in so the readline `close` handler only treats an
  // early stdin end as a cancel *during auth* — we deliberately close `rl` after
  // auth to hand stdin to the Register step's raw-mode tickbox.
  let phase: "auth" | "register" | "done" = "auth";
  const cancel = () => {
    print("");
    print(info("Installation cancelled."));
    process.exit(0);
  };
  rl.on("SIGINT", cancel);
  // If stdin ends before auth finishes (Ctrl-D, a non-interactive shell, a pipe
  // that ran dry) the pending prompt would never resolve, leaving the top-level
  // await unsettled — Node would warn and exit 13 (a red block in Warp). Exit
  // cleanly. Once we're past auth, closing `rl` is intentional, not a cancel.
  rl.on("close", () => {
    if (phase === "auth") cancel();
  });

  try {
    await stepAuth(rl);
    // Free stdin from readline so the tickbox can take raw keypresses.
    phase = "register";
    rl.close();
    await stepRegister(packageSpec());
    phase = "done";
  } finally {
    rl.close();
  }

  print("");
  print(ok(`Done. Restart your agent, then run ${accent("ping_console")}.`));
  print("");
}
