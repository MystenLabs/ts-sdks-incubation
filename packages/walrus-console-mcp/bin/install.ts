#!/usr/bin/env node
import * as fs from "node:fs";
import * as readline from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";
import { DEFAULT_CONSOLE_API_BASE_URL, isAllowedBaseUrl } from "../src/baseUrl.js";
import { SECRET_VALUE_FIELDS, parseArgs } from "../src/cliArgs.js";
import { getClients, selectClients } from "../src/clients.js";
import { installServer } from "../src/installDir.js";
import { type ConfigFileData, loadConfigFile, mergeConfigFile } from "../src/configFile.js";
import { validateAllowedDirectory } from "../src/pathSandbox.js";
import {
  type CredentialChoice,
  type CredentialWrite,
  collectCredentials,
  isEmptyWrite,
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
 * The npm package this installer installs. MUST stay identical to the `name` in
 * package.json — a spec pointing anywhere else cannot resolve, and an unclaimed
 * name is a dependency-confusion target: whatever npm fetches is launched with
 * access to the credentials in ~/.config/walrus-console-mcp.
 * `tests/install.test.ts` pins the two together.
 *
 * Distinct from `SERVER_NAME` (src/clients.ts), the unscoped key this server is
 * registered under in agent configs. Only this spec carries the scope and the
 * version pin — and it is consumed by `installServer` at install time, never
 * written into a config. What goes into a config is the resulting absolute
 * launcher path; see src/installDir.ts.
 */
export const PACKAGE_NAME = "@mysten-incubation/walrus-console-mcp";

/**
 * Resolve the base URL as env override → saved config → testnet default, and
 * reject an off-policy value. Not prompted for — power users override it with the
 * CONSOLE_API_BASE_URL env var.
 *
 * The order deliberately MIRRORS the server's own resolution (`resolvedBaseUrl`
 * in src/config.ts). It has to: this function picks the host the credential is
 * probed against and then persisted alongside, so an installer that skipped the
 * saved value would validate a rotated key against testnet while the config kept
 * pointing at a local or staging deployment — either rejecting a perfectly good
 * credential, or blessing one against a service it will never talk to.
 *
 * `loadConfigFile` already drops an off-policy saved `baseUrl`, so a hostile
 * config file falls through to the default rather than being adopted here; the
 * check below is what rejects an off-policy *env* value.
 *
 * Called at the very start of runInstall — before any readline/prompt machinery —
 * so the rejection surfaces cleanly instead of being swallowed by readline's
 * `close`→cancel handler, and before any key-bearing fetch could leak the API key
 * to a disallowed host. Shared by the interactive and silent paths so the value is
 * validated and persisted identically in either branch.
 */
export function resolveInstallBaseUrl(): string {
  const { CONSOLE_API_BASE_URL } = process.env;
  const baseUrl = CONSOLE_API_BASE_URL || loadConfigFile().baseUrl || DEFAULT_CONSOLE_API_BASE_URL;
  if (!isAllowedBaseUrl(baseUrl)) {
    throw new Error(
      `CONSOLE_API_BASE_URL is not an allowed Console endpoint: ${baseUrl}. ` +
        `It must be https to a walrus.xyz host, or http(s) to localhost.`,
    );
  }
  return baseUrl;
}

/**
 * Record which deployment the credential was just validated against.
 *
 * Writes the resolved URL when it is non-default, and CLEARS any saved value
 * when it is the default. The clear is the half that matters: persisting only
 * non-default values (the previous behaviour) left a stale staging/local URL in
 * the config whenever the resolved URL was the default, so the key was probed
 * against testnet and then used against the stale host.
 *
 * Keeping the default implicit rather than pinning it is deliberate — a config
 * that hardcodes today's default would not follow `DEFAULT_CONSOLE_API_BASE_URL`
 * if it ever moves.
 */
export function applyResolvedBaseUrl(
  updates: Partial<ConfigFileData>,
  baseUrl: string,
): (keyof ConfigFileData)[] {
  if (baseUrl === DEFAULT_CONSOLE_API_BASE_URL) return ["baseUrl"];
  updates.baseUrl = baseUrl;
  return [];
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
 * The npm spec handed to `installServer`, pinned to the running installer's
 * version (`@mysten-incubation/walrus-console-mcp@1.2.3`).
 *
 * Pinning stops a bad `latest` release from silently breaking every
 * already-installed user: upgrades are an explicit re-install, never a float.
 * That was already true when the spec was written into configs and launched
 * through npx; now the pin is resolved once, at install time, and what the
 * config records is where it landed.
 */
export function packageSpec(version = getPackageVersion()): string {
  return version ? `${PACKAGE_NAME}@${version}` : PACKAGE_NAME;
}

/**
 * Interactive 4-step installer for walrus-console-mcp.
 *
 * Step 1 — Choose:    Pick which credential to configure (API key, management
 *                     key, or both — see src/credentials.ts).
 * Step 2 — Auth:      Prompt for the chosen key(s), validate against the live API.
 * Step 3 — Files:     Pick directories upload/download may use when the agent
 *                     does not advertise MCP roots (see src/pathSandbox.ts).
 * Step 4 — Register:  Detect installed agents and register the pinned launcher
 *                     with the ones the user ticks (see src/clients.ts).
 *
 * Also supports a non-interactive path (`--api-key`/`--admin-key`/`--silent`
 * flags or CONSOLE_* env vars — see src/cliArgs.ts) for scripted installs.
 *
 * Runs in the terminal via: npx -y @mysten-incubation/walrus-console-mcp install
 * Uses only Node.js built-ins (readline, fs, fetch) — zero extra dependencies.
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * A plain, echoing prompt. Exported so bin/configure.ts shares one
 * implementation for the values that are deliberately NOT masked — a y/N
 * confirmation and the two address pins.
 */
export function prompt(rl: readline.Interface, question: string): Promise<string> {
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
 * Masked prompts already repaint the whole row on each keystroke, so there is a
 * moment where we own the line and can hang a border at the end of it. Echoing
 * prompts get the same treatment via `echoPanelLine` — they hijack readline's
 * echo the same way, because a native echo has nowhere to put the trailing
 * border and a 66-character Sui address on the same line as a long question
 * walks straight through the AUTHENTICATE box.
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
 * Echoing counterpart of `maskedPanelLine`: the typed characters are shown, the
 * row is padded to the right border, and the cursor is walked back to sit after
 * the last character.
 *
 * Unlike the masked field, the value itself must never be truncated — a pin
 * confirmation that showed `0xaaa…` has not confirmed an address (same rule as
 * `showRow`). When question + value cannot fit, this drops the border rather
 * than the value.
 */
export function echoPanelLine(
  question: string,
  typed: string,
  width: number,
  border = (s: string) => styleText("dim", s),
): string {
  const used = visibleWidth(question) + visibleWidth(typed);
  if (used > width - 2) {
    return `\x1b[2K\x1b[0G${question}${typed}`;
  }
  const pad = Math.max(0, width - used - 1);
  return `\x1b[2K\x1b[0G${question}${typed}${" ".repeat(pad)}${border("│")}\x1b[${pad + 1}D`;
}

/**
 * Hijack readline's echo and repaint the row ourselves. Used by both the
 * masked field and the echoing panel prompt: native echo cannot draw a trailing
 * border, and a wrapped row would leave fragments that `\x1b[2K` cannot clear.
 */
function promptWithRedraw(
  rl: readline.Interface,
  question: string,
  paint: (typed: string) => string,
): Promise<string> {
  const rli = rl as MaskableInterface;
  const output = rli.output ?? process.stdout;
  const original = rli._writeToOutput?.bind(rli);
  let muted = false;

  return new Promise((resolve) => {
    rli._writeToOutput = (stringToWrite) => {
      if (!muted) {
        output.write(stringToWrite);
        return;
      }
      output.write(paint(rli.line));
    };

    // Mute first so the prompt write itself goes through `paint` — otherwise
    // the right border is missing until the first keystroke.
    muted = true;
    rl.question(question, (answer) => {
      muted = false;
      if (original) rli._writeToOutput = original;
      else delete rli._writeToOutput;
      output.write("\n");
      resolve(answer.trim());
    });
  });
}

/**
 * Like `prompt`, but never echoes the typed characters — each keystroke is
 * redrawn as a bullet so secrets don't leak via screen-share or screenshots.
 * Backspace/paste still work because we rebuild from readline's current `line`.
 * Falls back to a plain prompt when stdout is not a TTY (pipes, CI, tests):
 * there is no terminal echo to hide, and the escape codes would pollute output.
 *
 * `panelWidth` closes the row with a right border; omit it (non-panel callers,
 * narrow terminals) and the line is drawn flat against the terminal width.
 */
export function promptMasked(
  rl: readline.Interface,
  question: string,
  panelWidth?: number,
): Promise<string> {
  if (!process.stdout.isTTY) return prompt(rl, question);
  return promptWithRedraw(rl, question, (typed) =>
    panelWidth === undefined
      ? maskedLine(question, typed.length)
      : maskedPanelLine(question, typed.length, panelWidth),
  );
}

/**
 * Echoing prompt inside a closed panel. Without a panel width (narrow
 * terminals, tests, pipes) this is just `prompt` — native echo is the right
 * fallback when there is no box to keep closed.
 */
export function promptEcho(
  rl: readline.Interface,
  question: string,
  panelWidth?: number,
): Promise<string> {
  if (!process.stdout.isTTY || panelWidth === undefined) return prompt(rl, question);
  return promptWithRedraw(rl, question, (typed) => echoPanelLine(question, typed, panelWidth));
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
 * padded to the border as it arrives. Live prompts are the hard row:
 * `maskedPanelLine` for secrets, `echoPanelLine` for unmasked values.
 *
 * `width === null` means the terminal is too narrow to frame anything, so every
 * method degrades to the flat indented style.
 */
/**
 * Render one value verbatim — never wrapped, never clamped — for a panel of
 * `width` (or `null` when no panel is being drawn).
 *
 * Every other panel row goes through `wrapVisible`, which CLAMPS a single token
 * wider than the rail: a 66-character Sui address renders as `0xaa…`. An
 * operator who confirms a prefix has not confirmed an address, so when the row
 * cannot hold the value this drops the BORDER rather than the value.
 *
 * The single home for that rule — `bin/configure.ts` renders its address rows
 * through this same function, so the two entry points cannot drift.
 */
export function showRow(msg: string, width: number | null): string {
  // panelRow clamps its content to width - 3, and the indent costs 2.
  if (width === null || visibleWidth(msg) > width - 5) return `${PAD}${msg}`;
  return panelRow(`  ${msg}`, width);
}

/** Exported for tests/install.test.ts, which asserts `show` cannot truncate. */
export function streamPanel(label: string, step: string) {
  const width = panelWidth();
  if (width === null) {
    print(`${accent(step)}  ${styleText("bold", label)}`);
    return {
      line,
      show: (msg: string) => print(showRow(msg, null)),
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
    /** A value printed verbatim — see `showRow` for why it may break the border. */
    show: (msg: string) => print(showRow(msg, width)),
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

/**
 * Kept in sync by hand with the copy in bin/configure.ts — the two entry points
 * offer the same credential types, and a choice added to one but not the other
 * is unreachable from that command.
 *
 * The bundle leads because it is the only option that provisions the address
 * pins as well as the key, and `create_bucket` refuses outright until the owner
 * pin exists. A key minted before the bundle format existed still takes the
 * "API key" path and enters its pins by hand.
 */
const CHOICES: { choice: CredentialChoice; label: string; hint: string }[] = [
  {
    choice: "bundle",
    label: "Credential bundle",
    hint: "one paste — key, signer and the address pins",
  },
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
      step: "1/4",
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

/**
 * The one-line summary of what a write actually persisted.
 *
 * "Credentials saved" is a claim, and two flows can now make it false: a
 * declined bundle confirmation writes nothing at all, and an address-pin-only
 * run (`--owner-address`) writes no credential. Shared with bin/configure.ts so
 * both commands report the same truth.
 */
export function savedLabel(write: CredentialWrite): string {
  if (isEmptyWrite(write)) return "Nothing saved — the config file is unchanged";
  const { apiKey, servicePrivateKey, adminKey, adminServicePrivateKey } = write.updates;
  return apiKey || servicePrivateKey || adminKey || adminServicePrivateKey
    ? "Credentials saved"
    : "Configuration saved";
}

/** The same summary as a status row — a tick only when something was written. */
const savedRow = (write: CredentialWrite): string =>
  isEmptyWrite(write) ? warn(savedLabel(write)) : ok(savedLabel(write));

/** Affirmative answers to a `[y/N]` question. Bare Enter is No. */
const isAffirmative = (answer: string): boolean => {
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
};

/**
 * Loud on purpose: Home as a sandbox root lets the model read/write anything
 * under the user's profile, which is the opposite of the fail-closed default.
 */
export const HOME_DIR_WARNING =
  "Home is broad — this server may read and write anything in your home directory.";

export interface AllowedDirChoice {
  id: "cwd" | "documents" | "downloads" | "home" | "custom" | "skip";
  label: string;
  hint: string;
  path?: string;
}

/** Preset radio rows for the File access step. `path` is omitted for custom/skip. */
export function allowedDirChoices(cwd: string, home: string): AllowedDirChoice[] {
  return [
    { id: "cwd", path: cwd, label: "This folder", hint: cwd },
    {
      id: "documents",
      path: join(home, "Documents"),
      label: "Documents",
      hint: join(home, "Documents"),
    },
    {
      id: "downloads",
      path: join(home, "Downloads"),
      label: "Downloads",
      hint: join(home, "Downloads"),
    },
    { id: "home", path: home, label: "Home", hint: "your whole home directory — broad" },
    { id: "custom", label: "Custom path…", hint: "type a folder this server may read and write" },
    {
      id: "skip",
      label: "Skip",
      hint: "only works if your agent shares workspace folders",
    },
  ];
}

/** Injectable seams so stepAllowedDirs is unit-testable without a TTY. */
export interface StepAllowedDirsDeps {
  select?: typeof selectOne;
  ask?: (question: string) => Promise<string>;
  cwd?: string;
  home?: string;
  step?: string;
  merge?: typeof mergeConfigFile;
}

/**
 * Pick directories upload/download may use when the MCP client advertises no
 * filesystem roots. Persists `allowedDirs` in the shared config file — not in
 * each agent's launch env — so `config` can change them without re-registering.
 *
 * A skip or cancel writes nothing (credentials from the previous step stay).
 */
export async function stepAllowedDirs(deps: StepAllowedDirsDeps = {}): Promise<CredentialWrite> {
  const select = deps.select ?? selectOne;
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? homedir();
  const merge = deps.merge ?? mergeConfigFile;
  const step = deps.step ?? "3/4";
  const choices = allowedDirChoices(cwd, home);

  const index = await select(
    choices.map(({ label, hint }) => ({ label, hint })),
    {
      title: "FILE ACCESS",
      step,
      notice:
        "Some agents don't share workspace folders. Pick directories upload and download may use.",
      hint: "↑/↓ move   enter select   esc cancel",
    },
  );

  if (index === null) {
    print("");
    line(
      info("File access skipped — upload/download will fail on agents that don't share folders."),
    );
    gap();
    return { updates: {}, clear: [] };
  }

  const picked = choices[index];
  if (!picked || picked.id === "skip") {
    print("");
    line(
      info("File access skipped — set later with walrus-console-mcp config --allowed-dirs <dir>"),
    );
    gap();
    return { updates: {}, clear: [] };
  }

  print("");
  if (picked.id === "home") line(warn(HOME_DIR_WARNING));

  const ask =
    deps.ask ??
    (async (question: string) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await prompt(rl, `${PAD}${accent(question)}`);
      } finally {
        rl.close();
      }
    });

  const dirs: string[] = [];
  const accept = (raw: string): boolean => {
    const result = validateAllowedDirectory(raw);
    if ("error" in result) {
      line(fail(result.error));
      return false;
    }
    if (!dirs.includes(result.dir)) {
      dirs.push(result.dir);
      line(ok(result.dir));
    }
    return true;
  };

  if (picked.id === "custom") {
    while (true) {
      const typed = await ask("Folder: ");
      if (!typed.trim()) {
        line(fail("This value is required."));
        continue;
      }
      if (accept(typed)) break;
    }
  } else if (picked.path) {
    if (!accept(picked.path)) {
      line(info("Nothing saved — pick an existing folder with --allowed-dirs, or re-run."));
      gap();
      return { updates: {}, clear: [] };
    }
  }

  while (isAffirmative(await ask("Add another directory? [y/N]: "))) {
    const typed = await ask("Folder: ");
    if (!typed.trim()) {
      line(info("Nothing added."));
      continue;
    }
    accept(typed);
  }

  if (dirs.length === 0) {
    gap();
    return { updates: {}, clear: [] };
  }

  merge({ allowedDirs: dirs });
  line(styleText("dim", "saved → ~/.config/walrus-console-mcp/config.json"));
  gap();
  return { updates: { allowedDirs: dirs }, clear: [] };
}

async function stepAuth(
  rl: readline.Interface,
  choice: CredentialChoice,
): Promise<CredentialWrite> {
  const rail = streamPanel("AUTHENTICATE", "2/4");
  const gutter = rail.prefix;
  rail.blank();
  rail.line(`Get your key at ${accent("testnet.console.walrus.xyz")} → Integrations`);
  rail.blank();

  const baseUrl = resolveInstallBaseUrl();

  const write = await collectCredentials(
    choice,
    {
      ask: async (question, opts) => {
        const masked = opts?.masked !== false;
        const value = masked
          ? await promptMasked(rl, `${gutter}${accent(question)}`, rail.width)
          : await promptEcho(rl, `${gutter}${accent(question)}`, rail.width);
        // Register each secret the moment it is typed, before collectCredentials
        // probes it: a probe's fetch error can embed the Bearer header, and the
        // redaction layer can only scrub values it already knows about.
        //
        // Only the MASKED values. An unmasked prompt is deliberately a non-secret
        // (a y/N answer, an address pin), and registering an address would scrub
        // it out of the create_bucket disclosure — the field that exists to show
        // a human which account was actually granted the bucket.
        if (masked) registerSecret(value);
        return value;
      },
      ok: (msg) => rail.line(ok(msg)),
      fail: (msg) => rail.line(fail(msg)),
      warn: (msg) => rail.line(warn(msg)),
      info: (msg) => rail.line(info(msg)),
      show: (msg) => rail.show(msg),
      probe: (kind, key) =>
        withSpinner("validating", () => probeKey(kind, key, baseUrl), gutter, rail.width),
    },
    // Read fresh rather than reusing an earlier snapshot: `config` may have been
    // run in between, and a stale view would clear a signer that is no longer stale.
    loadConfigFile(),
  );

  rail.blank();
  if (isEmptyWrite(write)) {
    // Nothing was confirmed (a declined bundle). Do not touch the file at all —
    // not even for the base-URL bookkeeping a successful auth implies.
    rail.line(info(savedLabel(write)));
  } else {
    const { updates, clear } = write;
    mergeConfigFile(updates, [...clear, ...applyResolvedBaseUrl(updates, baseUrl)]);
    rail.line(styleText("dim", "saved → ~/.config/walrus-console-mcp/config.json"));
  }
  rail.blank();
  rail.close();
  gap();
  return write;
}

// ─── Step 3: Register ───────────────────────────────────────────────────────

/**
 * How the Register step ended. `configured` only carries a meaningful count on
 * `"installed"`; the others are zero. The distinction matters because the old
 * `return 0` collapsed a *failed server install* into the same value as
 * "cancelled" / "nothing ticked", so a scripted install couldn't tell a real
 * failure from a deliberate no-op.
 */
export type RegisterOutcome = "installed" | "install-failed" | "cancelled" | "none-selected";
export interface RegisterResult {
  outcome: RegisterOutcome;
  configured: number;
}

/** Injectable seams so stepRegister's outcomes are unit-testable. */
interface StepRegisterDeps {
  select?: typeof selectClients;
  install?: typeof installServer;
}

/**
 * The process exit code implied by a Register outcome. Only a failed server
 * install is a hard error — the credentials were still saved (auth completed),
 * but nothing usable was registered, so a scripted caller must see a non-zero
 * exit. Cancelling the checklist or ticking no clients is a normal exit.
 */
export function registerExitCode(outcome: RegisterOutcome): number {
  return outcome === "install-failed" ? 1 : 0;
}

/**
 * Register the launcher with the agents the user ticks. Detects every supported
 * client, presents an interactive checklist (detected ones pre-ticked), then
 * registers each selection — shelling out to its `mcp add` CLI or merging its
 * JSON config, per the client. A per-client failure is caught and shown with a
 * manual-command fallback so the rest still proceed.
 *
 * The install happens FIRST, once, before any client is touched. Two reasons:
 * the absolute launcher path is what gets registered (see src/installDir.ts, and
 * why `npx` is not usable here), and if the install fails there is nothing worth
 * writing — a config naming a launcher that does not exist fails at every future
 * startup, inside the agent, far from anything that can fix it.
 *
 * Returns a discriminated `RegisterResult` rather than a bare count so
 * `runInstall` can set a non-zero exit code (and print a FAILED panel) when the
 * server install threw, without conflating that with a user cancel.
 */
export async function stepRegister(
  spec: string,
  deps: StepRegisterDeps = {},
): Promise<RegisterResult> {
  const select = deps.select ?? selectClients;
  const install = deps.install ?? installServer;

  const selected = await select(getClients(), {
    title: "REGISTER",
    step: "4/4",
    hint: "↑/↓ move   space toggle   a all   enter confirm",
  });

  if (selected === null) {
    print("");
    line(info("Registration cancelled — your saved credentials are untouched."));
    return { outcome: "cancelled", configured: 0 };
  }
  if (selected.length === 0) {
    print("");
    line(info("No clients selected — nothing registered."));
    return { outcome: "none-selected", configured: 0 };
  }

  print("");
  let command: string;
  try {
    line(info(`Installing ${spec}…`));
    command = install(spec);
    line(ok(`Installed → ${command}`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    line(fail(`Could not install the server — ${msg}`));
    // Deliberately no npx fallback. Falling back would re-introduce exactly the
    // workspace-shadowing problem the private install exists to remove, and would
    // do it silently, on the path where something already went wrong.
    detail("Nothing was registered. Fix the install error above and re-run.");
    gap();
    return { outcome: "install-failed", configured: 0 };
  }

  let configured = 0;
  for (const client of selected) {
    try {
      client.register(command);
      line(ok(`${client.label} configured`));
      configured++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      line(warn(`${client.label} not configured — ${msg}`));
      detail(`run manually: ${client.manualHint(command)}`);
    }
  }
  gap();
  return { outcome: "installed", configured };
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
    // fetch error can embed the Bearer header. Only the secret-bearing fields:
    // registering an address pin would scrub it out of the create_bucket
    // disclosure (see SECRET_VALUE_FIELDS).
    for (const field of SECRET_VALUE_FIELDS) {
      registerSecret(args.values[field]);
    }
    const { updates, clear, errors, warnings } = await validateSilent(
      args.values,
      (kind, key) => probeKey(kind, key, baseUrl),
      loadConfigFile(),
    );
    if (errors.length > 0) {
      for (const err of errors) print(fail(err));
      process.exit(1);
    }
    // Persist the resolved base URL exactly as the interactive path does, so the
    // saved config points at the same API the key was just validated against.
    mergeConfigFile(updates, [...clear, ...applyResolvedBaseUrl(updates, baseUrl)]);
    print(ok(savedLabel({ updates, clear })));
    // After the saved line: they describe what the just-written config costs,
    // not a reason it failed. Exit code is unaffected.
    for (const warning of warnings) print(warn(warning));
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

  let register: RegisterResult | null = null;
  let authWrite: CredentialWrite = { updates: {}, clear: [] };
  let allowedWrite: CredentialWrite = { updates: {}, clear: [] };
  try {
    authWrite = await stepAuth(rl, choice);
    // Free stdin from readline so the File access radio and the Register
    // tickbox can take raw keypresses.
    phase = "register";
    rl.close();
    allowedWrite = await stepAllowedDirs();
    if (args.register) register = await stepRegister(packageSpec());
    phase = "done";
  } finally {
    rl.close();
  }

  if (register && register.outcome === "install-failed") {
    // Auth completed, so the credentials ARE saved — but the server install
    // failed and nothing was registered. Surface that to a scripted caller with
    // a non-zero exit (propagated out of bin/console-mcp.ts) and say so plainly,
    // rather than printing a green DONE panel over a failure.
    process.exitCode = registerExitCode(register.outcome);
    printSummaryPanel("FAILED", [
      savedRow(authWrite),
      fail("Server install failed — nothing was registered"),
      "",
      `Fix the install error above, then run ${accent("walrus-console-mcp install")}`,
    ]);
    // Trailing gap so the shell prompt doesn't come back flush against the panel.
    gap();
    return;
  }

  const configured = register?.configured ?? 0;
  printSummaryPanel("DONE", [
    savedRow(authWrite),
    ...(isEmptyWrite(allowedWrite) ? [] : [ok("File access folders saved")]),
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
