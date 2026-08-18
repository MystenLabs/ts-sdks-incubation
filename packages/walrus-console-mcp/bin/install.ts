#!/usr/bin/env node
import * as fs from "node:fs";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";
import { DEFAULT_CONSOLE_API_BASE_URL, isAllowedBaseUrl } from "../src/baseUrl.js";
import { parseArgs } from "../src/cliArgs.js";
import { getClients, selectClients } from "../src/clients.js";
import { loadConfigFile, mergeConfigFile } from "../src/configFile.js";
import {
  type CredentialChoice,
  collectCredentials,
  probeKey,
  validateSilent,
} from "../src/credentials.js";
import { registerSecret } from "../src/redaction.js";
import {
  clampVisible,
  panelBottom,
  panelRow,
  panelTop,
  panelWidth,
  selectOne,
  visibleWidth,
  wrapVisible,
} from "../src/tui.js";

/**
 * The npm package this installer registers. MUST stay identical to the `name`
 * in package.json — a config pointing at any other spec cannot resolve, and an
 * unclaimed name is a dependency-confusion target: whatever `npx` fetches is
 * launched with access to the credentials in ~/.config/walrus-console-mcp.
 * `tests/install.test.ts` pins the two together.
 *
 * Distinct from `SERVER_NAME` (src/clients.ts), the unscoped key this server is
 * registered under in agent configs. Only the npx argument carries the scope
 * and the version pin.
 */
export const PACKAGE_NAME = "@mysten-incubation/walrus-console-mcp";

/**
 * Resolve the base URL from the env override (or the testnet default) and reject
 * an off-policy value. Not prompted for — power users override it with the
 * CONSOLE_API_BASE_URL env var (also honored by the server's config layer).
 *
 * Called at the very start of runInstall — before any readline/prompt machinery —
 * so the rejection surfaces cleanly instead of being swallowed by readline's
 * `close`→cancel handler, and before any key-bearing fetch could leak the API key
 * to a disallowed host. Shared by the interactive and silent paths so a
 * non-default value is validated and persisted identically in either branch.
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
 * running installer's version (`@mysten-incubation/walrus-console-mcp@1.2.3`).
 * Pinning stops a
 * bad `latest` release from silently breaking every already-installed user —
 * upgrades become an explicit re-install instead of an automatic `npx` float.
 */
export function packageSpec(version = getPackageVersion()): string {
  return version ? `${PACKAGE_NAME}@${version}` : PACKAGE_NAME;
}

/**
 * Interactive 3-step installer for walrus-console-mcp.
 *
 * Step 1 — Choose:    Pick which credential to configure (API key, management
 *                     key, or both — see src/credentials.ts).
 * Step 2 — Auth:      Prompt for the chosen key(s), validate against the live API.
 * Step 3 — Register:  Detect installed agents and register the pinned launcher
 *                     with the ones the user ticks (see src/clients.ts).
 *
 * Also supports a non-interactive path (`--api-key`/`--admin-key`/`--silent`
 * flags or CONSOLE_* env vars — see src/cliArgs.ts) for scripted installs.
 *
 * Runs in the terminal via: npx -y @mysten-incubation/walrus-console-mcp install
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

// visibleWidth and clampVisible moved to src/tui.ts, where the panel primitives
// need them for border math. visibleWidth is re-exported here so
// tests/install.test.ts keeps its import; fold this away once #13 lands and the
// two CLI entry points are deduplicated.
export { visibleWidth };

/** Columns held back for bullets, so a wide prompt can't starve the feedback. */
const MIN_MASK = 4;

/**
 * Build the redraw for a masked line: clear the row, jump to column 0, then
 * re-render the (colored) prompt followed by one bullet per typed character.
 *
 * The whole line — prompt included — is kept inside the terminal width. The
 * single-line clear (`\x1b[2K`) only erases the row the cursor is on, so
 * anything that wraps leaves its earlier rows untouched and every keystroke
 * stacks another copy. Clamping the bullets alone isn't enough: on a terminal
 * narrower than the prompt itself the prompt wraps on its own, which is why it
 * gets truncated too, holding back `MIN_MASK` columns so there is still
 * feedback that a keystroke registered. Pure so it can be unit-tested; the
 * escape codes are the only I/O concern.
 */
export function maskedLine(
  question: string,
  length: number,
  columns: number = process.stdout.columns || 80,
): string {
  const budget = Math.max(0, columns - 1); // leave the last cell; writing it wraps
  const prompt = clampVisible(question, Math.max(0, budget - MIN_MASK));
  const maxBullets = Math.max(0, budget - visibleWidth(prompt));
  const bullets = "•".repeat(Math.min(length, maxBullets));
  return `\x1b[2K\x1b[0G${prompt}${bullets}`;
}

/**
 * The same redraw, but inside a closed panel: pad out to the right border, draw
 * it, then walk the cursor back so it sits after the last bullet rather than
 * outside the box.
 *
 * This is only possible because every prompt is masked. A masked prompt already
 * repaints its entire line on each keystroke, so there is a moment where we own
 * the whole row and can put a border at the end of it. An echoing prompt has
 * the terminal appending characters at the cursor, with nowhere to hang a
 * trailing border — which is why `collectCredentials` asks for masked input
 * everywhere (see src/credentials.ts).
 */
export const MASK_WIDTH = 16;

export function maskedPanelLine(
  question: string,
  length: number,
  width: number,
  border = (s: string) => styleText("dim", s),
): string {
  const used = visibleWidth(question); // question already carries the left border
  // -2 leaves a column of margin, so the field reads as "•••• │" rather than
  // crowding the border. Every other row has that margin from padding.
  const room = Math.max(0, width - used - 2);
  // A fixed-width field, not one bullet per character. Bullet counts otherwise
  // leak the secret's length to anyone reading the screen — and these lengths
  // identify the credential (hbr_ 36, hbradm_ 39, suiprivkey1 70). Empty still
  // renders empty, so there's feedback that the first keystroke registered.
  const bullets = "•".repeat(length === 0 ? 0 : Math.min(MASK_WIDTH, room));
  const pad = Math.max(0, width - used - bullets.length - 1);
  const back = pad + 1; // step back over the padding and the border itself
  return `\x1b[2K\x1b[0G${question}${bullets}${" ".repeat(pad)}${border("│")}\x1b[${back}D`;
}

/**
 * Like `prompt`, but never echoes the typed characters — each keystroke is
 * redrawn as a bullet so secrets don't leak via screen-share or screenshots.
 * Backspace/paste still work because we rebuild from readline's current `line`.
 * Falls back to a plain prompt when stdout is not a TTY (pipes, CI, tests):
 * there is no terminal echo to hide, and the escape codes would pollute output.
 */
/**
 * `panelWidth` closes the row with a right border; omit it (non-panel callers,
 * narrow terminals) and the line is drawn flat against the terminal width.
 */
export function promptMasked(
  rl: readline.Interface,
  question: string,
  panelWidth?: number,
): Promise<string> {
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
      output.write(
        panelWidth === undefined
          ? maskedLine(question, rli.line.length)
          : maskedPanelLine(question, rli.line.length, panelWidth),
      );
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

/** A content line indented under the current step (flat fallback). */
function line(msg: string) {
  print(`${PAD}${msg}`);
}

/**
 * Vertical gap between steps. One blank line reads as "these belong together",
 * which is wrong — each panel is a separate screen the user is done with.
 */
function gap() {
  print("");
  print("");
}

/** A dim secondary line (e.g. a path) nested one level deeper. */
function detail(msg: string) {
  print(`${PAD}   ${styleText("dim", `→ ${msg}`)}`);
}

/**
 * Writer for a step whose content streams — prompt, spinner, result, prompt
 * again — drawn as a fully closed panel.
 *
 * Streaming does not require an open right side: the height is only needed for
 * the *bottom* border, which is printed at the end anyway, and each row can be
 * padded to the border as it arrives. The one genuinely hard row is the live
 * prompt, and `maskedPanelLine` handles that (see the note there).
 *
 * `width === null` means the terminal is too narrow to frame anything, so every
 * method degrades to the flat indented style.
 */
function streamPanel(label: string, step: string) {
  const width = panelWidth();
  if (width === null) {
    print(`${accent(step)}  ${styleText("bold", label)}`);
    return {
      line,
      blank: () => print(""),
      close: () => {},
      prefix: PAD,
      width: undefined,
    };
  }
  print(panelTop(styleText("bold", label), width, accent(step)));
  return {
    // Wrapped rather than clamped: some validator messages are longer than any
    // sane panel width, and truncating one mid-sentence loses the point of it.
    // Wrapping is safe here because this panel is never redrawn — only a
    // redrawing panel needs its row count to match the terminal's.
    // Continuations indent two further so they read as one message.
    // -7 not -5: continuations indent four, and panelRow keeps a column of
    // margin before the border. Wrapping to the first line's budget lets the
    // deeper-indented continuations overflow and get clamped instead.
    line: (msg: string) => {
      const [first, ...rest] = wrapVisible(msg, width - 7);
      print(panelRow(`  ${first ?? ""}`, width));
      for (const l of rest) print(panelRow(`    ${l}`, width));
    },
    blank: () => print(panelRow("", width)),
    close: () => print(panelBottom(width)),
    /** Prefix the spinner prints after, so it lands inside the border. */
    prefix: `${styleText("dim", "│")}  `,
    /** Panel width, for the masked prompt and the spinner's right border. */
    width,
  };
}

/** A closed summary panel — fixed content, so it can be framed on both sides. */
function printSummaryPanel(label: string, rows: string[]) {
  const width = panelWidth();
  if (width === null) {
    for (const r of rows) line(r);
    return;
  }
  print(panelTop(styleText("bold", label), width));
  print(panelRow("", width));
  for (const r of rows) print(panelRow(`  ${r}`, width));
  print(panelRow("", width));
  print(panelBottom(width));
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Run an async task while showing a one-line spinner under the current step.
 * Clears its line when done so the caller can print the result. Falls back to a
 * static line when stdout is not a TTY (piped output, CI, tests).
 */
async function withSpinner<T>(
  label: string,
  task: () => Promise<T>,
  prefix: string = PAD,
  width?: number,
): Promise<T> {
  if (!process.stdout.isTTY) {
    line(info(`${label}…`));
    return task();
  }
  let i = 0;
  const render = () => {
    const frame = styleText("cyan", SPINNER_FRAMES[i] ?? "");
    const body = `${prefix}${frame} ${styleText("dim", `${label}…`)}`;
    // Close the row when we're inside a panel, so the border doesn't blink out
    // for as long as validation takes.
    const tail =
      width === undefined
        ? ""
        : `${" ".repeat(Math.max(0, width - visibleWidth(body) - 1))}${styleText("dim", "│")}`;
    process.stdout.write(`\r${body}${tail}`);
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

// ─── Step 1: Choose ─────────────────────────────────────────────────────────

const CHOICES: { choice: CredentialChoice; label: string; hint: string }[] = [
  { choice: "api", label: "API key", hint: "everyday key — buckets, upload, download" },
  { choice: "admin", label: "Management key", hint: "mints API keys via generate_api_key" },
  { choice: "both", label: "Both", hint: "" },
];

/**
 * Ask which credential the user is configuring. The chooser is a statement of
 * intent: the auth step then only accepts a key of that type (see
 * `mismatchMessage`). Returns null if the user cancels.
 */
export async function chooseCredentials(notice?: string): Promise<CredentialChoice | null> {
  const index = await selectOne(
    CHOICES.map(({ label, hint }) => ({ label, hint })),
    {
      title: "CHOOSE CREDENTIALS",
      step: "1/3",
      notice,
      hint: "↑/↓ move   enter select   esc cancel",
    },
  );
  if (index === null) return null;
  gap();
  return CHOICES[index]?.choice ?? "api";
}

// ─── Step 2: Auth ───────────────────────────────────────────────────────────

// Re-exported for tests/install.test.ts; the real implementation now lives in
// src/credentials.ts alongside the other format checks.
export { isValidServiceKeyFormat } from "../src/credentials.js";

async function stepAuth(rl: readline.Interface, choice: CredentialChoice): Promise<void> {
  const rail = streamPanel("AUTHENTICATE", "2/3");
  const gutter = rail.prefix;
  rail.blank();
  rail.line(`Get your key at ${accent("testnet.console.walrus.xyz")} → Integrations`);
  rail.blank();

  const baseUrl = resolveInstallBaseUrl();

  const updates = await collectCredentials(choice, {
    // Register each secret the moment it is typed, before collectCredentials
    // probes it: a probe's fetch error can embed the Bearer header, and the
    // redaction layer can only scrub values it already knows about.
    ask: async (question, opts) => {
      const value =
        opts?.masked === false
          ? await prompt(rl, `${gutter}${accent(question)}`)
          : await promptMasked(rl, `${gutter}${accent(question)}`, rail.width);
      registerSecret(value);
      return value;
    },
    ok: (msg) => rail.line(ok(msg)),
    fail: (msg) => rail.line(fail(msg)),
    warn: (msg) => rail.line(warn(msg)),
    info: (msg) => rail.line(info(msg)),
    probe: (kind, key) =>
      withSpinner("validating", () => probeKey(kind, key, baseUrl), gutter, rail.width),
  });

  if (baseUrl !== DEFAULT_CONSOLE_API_BASE_URL) updates.baseUrl = baseUrl;
  mergeConfigFile(updates);
  rail.blank();
  rail.line(styleText("dim", "saved → ~/.config/walrus-console-mcp/config.json"));
  rail.blank();
  rail.close();
  gap();
}

// ─── Step 3: Register ───────────────────────────────────────────────────────

/**
 * Register the pinned launcher with the agents the user ticks. Detects every
 * supported client, presents an interactive checklist (detected ones
 * pre-ticked), then registers each selection — shelling out to its `mcp add`
 * CLI or merging its JSON config, per the client. A per-client failure is
 * caught and shown with a manual-command fallback so the rest still proceed.
 */
async function stepRegister(spec: string): Promise<number> {
  const selected = await selectClients(getClients(), {
    title: "REGISTER",
    step: "3/3",
    hint: "↑/↓ move   space toggle   a all   enter confirm",
  });

  if (selected === null) {
    print("");
    line(info("Registration cancelled — your saved credentials are untouched."));
    return 0;
  }
  if (selected.length === 0) {
    print("");
    line(info("No clients selected — nothing registered."));
    return 0;
  }

  print("");
  let configured = 0;
  for (const client of selected) {
    try {
      client.register(spec);
      line(ok(`${client.label} configured`));
      configured++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      line(warn(`${client.label} not configured — ${msg}`));
      detail(`run manually: ${client.manualHint(spec)}`);
    }
  }
  gap();
  return configured;
}

/** Silent mode does not run the interactive checklist; point at the manual path. */
function stepRegisterSilentNote(): void {
  print(info("Skipped agent registration — run `walrus-console-mcp install` to configure agents."));
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function runInstall(argv: string[] = []): Promise<void> {
  const args = parseArgs(argv, process.env);
  if (args.errors.length > 0) {
    for (const err of args.errors) print(fail(err));
    process.exit(1);
  }

  // Silent: no banner, no chooser, no prompts. Validate, save, exit.
  if (args.silent) {
    const baseUrl = resolveInstallBaseUrl();
    // Flag- and env-supplied secrets never pass through the interactive `ask`
    // wrapper, so register them here — before validateSilent probes them and a
    // fetch error can embed the Bearer header.
    for (const value of Object.values(args.values)) {
      if (value) registerSecret(value);
    }
    const { updates, errors } = await validateSilent(args.values, (kind, key) =>
      probeKey(kind, key, baseUrl),
    );
    if (errors.length > 0) {
      for (const err of errors) print(fail(err));
      process.exit(1);
    }
    // Persist a non-default base URL exactly as the interactive path does, so the
    // saved config points at the same API the key was just validated against.
    if (baseUrl !== DEFAULT_CONSOLE_API_BASE_URL) updates.baseUrl = baseUrl;
    mergeConfigFile(updates);
    print(ok("Credentials saved"));
    if (args.register) stepRegisterSilentNote();
    process.exit(0);
  }

  // util.styleText strips ANSI unless it detects a color-capable stream; some
  // terminals under-report, leaving the whole TUI monochrome while the raw-code
  // banner still shows. Force color when we're interactive (respecting NO_COLOR).
  const { NO_COLOR, FORCE_COLOR } = process.env;
  if (process.stdout.isTTY && !NO_COLOR && !FORCE_COLOR) {
    Object.assign(process.env, { FORCE_COLOR: "3" });
  }

  printBanner();

  // Fail fast on a bad base-URL override, before readline is created (see
  // resolveInstallBaseUrl) so the error is not swallowed as a "cancel".
  resolveInstallBaseUrl();

  // Shown inside step 1's panel rather than above it, where it's competing with
  // the banner for attention. The key preview is gone: it never told the user
  // anything step 2 doesn't, and it doesn't fit the panel width.
  const existing = loadConfigFile();
  const notice = existing.apiKey ? "overwriting existing config" : undefined;

  // The chooser needs raw keypresses, the prompts need readline — so the
  // readline interface is created only after the chooser has resolved and
  // released stdin.
  const choice = await chooseCredentials(notice);
  if (choice === null) {
    print("");
    print(info("Installation cancelled."));
    return;
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

  let configured = 0;
  try {
    await stepAuth(rl, choice);
    // Free stdin from readline so the tickbox can take raw keypresses.
    phase = "register";
    rl.close();
    if (args.register) configured = await stepRegister(packageSpec());
    phase = "done";
  } finally {
    rl.close();
  }

  printSummaryPanel("DONE", [
    ok("Credentials saved"),
    ...(args.register
      ? [ok(`${configured} ${configured === 1 ? "agent" : "agents"} configured`)]
      : []),
    "",
    `Restart your agent, then run ${accent("ping_console")}`,
    `Change a key later:  ${accent("walrus-console-mcp config")}`,
  ]);
  // Trailing gap so the shell prompt doesn't come back flush against the panel.
  gap();
}
