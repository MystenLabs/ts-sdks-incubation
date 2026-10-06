import * as readline from "node:readline";
import { styleText } from "node:util";

/**
 * Terminal chrome for the CLI: bordered panels plus the one raw-mode keypress
 * loop that every selector runs on.
 *
 * The panel vocabulary is deliberately small — a closed box for fixed-height
 * screens that redraw on each keypress, and an open left rail for steps whose
 * height isn't known when the top border is drawn (see `bin/install.ts` step 2).
 * Everything is inline in scrollback; there is no alt-buffer and no reflow on
 * resize, because a printed border can't be redrawn after the fact.
 */

const ESC = String.fromCharCode(27);
const ANSI_SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Drop SGR (color) escapes — for measuring, and for asserting in tests. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_SGR, "");
}

/** Visible width of a string, ignoring ANSI SGR (color) escape codes. */
export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

/**
 * Truncate to `max` visible columns, appending an ellipsis. Colour escapes are
 * copied through without counting toward the width, and a reset is appended if
 * any were seen — slicing a styled string naively can cut mid-escape and leak
 * the code into the rest of the line.
 */
export function clampVisible(s: string, max: number): string {
  if (max <= 0) return "";
  if (visibleWidth(s) <= max) return s;

  let out = "";
  let count = 0;
  let styled = false;
  for (let i = 0; i < s.length; ) {
    if (s[i] === ESC) {
      const match = new RegExp(`^${ESC}\\[[0-9;]*m`).exec(s.slice(i));
      if (match?.[0]) {
        out += match[0];
        i += match[0].length;
        styled = true;
        continue;
      }
    }
    if (count >= max - 1) break;
    out += s[i];
    count++;
    i++;
  }
  return `${out}…${styled ? `${ESC}[0m` : ""}`;
}

/** Widest panel we'll draw, and the width below which we stop drawing them. */
export const MAX_PANEL_WIDTH = 72;
export const MIN_PANEL_WIDTH = 44;

/**
 * Panel width for a terminal of `columns`, or null when the terminal is too
 * narrow to frame anything — callers fall back to flat indented output. A box
 * that wraps is worse than no box.
 */
export function panelWidth(columns: number = process.stdout.columns || 80): number | null {
  const width = Math.min(columns - 2, MAX_PANEL_WIDTH);
  return width < MIN_PANEL_WIDTH ? null : width;
}

const border = (s: string) => styleText("dim", s);

/**
 * Top rail: `╭─ LABEL ────…──── 1/3 ─╮`, padded to exactly `width` visible
 * columns. `label` and `step` may already carry colour; the fill is measured
 * with `visibleWidth` so styling never skews the border.
 */
export function panelTop(label: string, width: number, step = ""): string {
  const tailLen = step ? 1 + visibleWidth(step) + 3 : 2;
  const fill = Math.max(1, width - 3 - visibleWidth(label) - 1 - tailLen);
  const dashes = `${" "}${"─".repeat(fill)}`;
  return step
    ? `${border("╭─ ")}${label}${border(dashes)} ${step}${border(" ─╮")}`
    : `${border("╭─ ")}${label}${border(`${dashes}─╮`)}`;
}

/** Bottom rail of a closed panel. */
export function panelBottom(width: number): string {
  return border(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

/** Bottom rail of an open panel, carrying a summary: `╰─ saved → …`. */
export function closeWith(text: string): string {
  return `${border("╰─ ")}${text}`;
}

/** A content row inside a closed panel, clamped and padded to the border. */
export function panelRow(content = "", width: number): string {
  const inner = Math.max(0, width - 2);
  const clamped = clampVisible(content, inner - 1);
  const pad = " ".repeat(Math.max(0, inner - visibleWidth(clamped)));
  return `${border("│")}${clamped}${pad}${border("│")}`;
}

/** A content line on an open rail — left border only, so no padding is needed. */
export function railLine(content = "", width: number): string {
  return `${border("│")}${clampVisible(content, Math.max(0, width - 1))}`;
}

/**
 * Break text onto lines of at most `max` visible columns, at word boundaries.
 * Splitting on spaces can't cut an escape sequence (they contain none), so
 * styled text survives; a single word longer than `max` is clamped instead.
 *
 * What may NOT be done is hand a terminal one string it then soft-wraps: that
 * string occupies two rows while the redraw counts it as one. Splitting into
 * separate rows, each inside the width, is fine, which is what `radioPanelLines`
 * below and `printSummaryPanel` in bin/install.ts do. The open rail has no such
 * constraint at all, being never redrawn, and having no right border it has
 * nowhere to truncate *to*.
 *
 * Each returned line closes any style it opened. A styled run with a space in
 * it (`accent("walrus-console-mcp config")`) otherwise splits with its opening
 * escape on one line and its reset on the next, and the colour bleeds through
 * the padding and the border of the first. `clampVisible` already does this for
 * the truncating case; wrapping needs it for the same reason.
 */
export function wrapVisible(text: string, max: number): string[] {
  if (max <= 0 || visibleWidth(text) <= max) return [text];

  const lines: string[] = [];
  let current = "";
  const push = (line: string) => lines.push(line.includes(ESC) ? `${line}${ESC}[0m` : line);
  for (const word of text.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (visibleWidth(candidate) <= max) {
      current = candidate;
      continue;
    }
    if (current) push(current);
    current = visibleWidth(word) <= max ? word : clampVisible(word, max);
  }
  if (current) push(current);
  return lines.length > 0 ? lines : [""];
}

/** The dim key-hint line that sits *below* a panel, outside its border. */
export function hintLine(text: string): string {
  return `   ${styleText("dim", text)}`;
}

/** A readable input that may be a raw-capable TTY (process.stdin or a mock). */
type KeyInput = NodeJS.EventEmitter & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
  resume?: () => void;
  pause?: () => void;
};

export interface SelectorOptions {
  input?: KeyInput;
  output?: NodeJS.WritableStream;
  /** Force interactive mode; defaults to output.isTTY. */
  isTTY?: boolean;
  /** Terminal width used for panel sizing; defaults to process.stdout.columns. */
  columns?: number;
}

/** What a key handler asks the loop to do next. */
export type KeyAction<T> = { done: T } | { cancel: true } | { redraw: true } | undefined;

export interface SelectorSpec<T> {
  /** Lines for the current state. Must return the same count every call. */
  render: () => string[];
  /** Handle one keypress. Returning undefined ignores it without redrawing. */
  onKey: (key: readline.Key) => KeyAction<T>;
}

/**
 * The single raw-mode redraw loop. Previously this lived twice — once in
 * `selectOne`, once in `selectClients` — and the copies had already drifted
 * apart (different cursor glyphs, different confirm handling). Callers now
 * supply only a renderer and a key handler.
 *
 * Redrawing moves the cursor up by the number of lines last written, so every
 * line must fit the terminal width: a wrapped line occupies two rows and the
 * count goes wrong. `panelRow`/`railLine` clamp for exactly this reason.
 *
 * Ctrl-C always cancels, before the spec's own handler sees the key.
 */
export function runSelector<T>(
  spec: SelectorSpec<T>,
  opts: SelectorOptions = {},
): Promise<T | null> {
  const input: KeyInput = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  return new Promise((resolve) => {
    let rendered = 0;

    const render = () => {
      if (rendered > 0) output.write(`${ESC}[${rendered}A`);
      const lines = spec.render();
      for (const l of lines) output.write(`${ESC}[2K${l}\n`);
      rendered = lines.length;
    };

    const useRaw = input.isTTY === true && typeof input.setRawMode === "function";
    readline.emitKeypressEvents(input as NodeJS.ReadableStream);
    if (useRaw) input.setRawMode?.(true);
    input.resume?.();

    const cleanup = () => {
      input.off("keypress", onKey);
      if (useRaw) input.setRawMode?.(false);
      input.pause?.();
    };

    const onKey = (_str: string, key: readline.Key | undefined) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        cleanup();
        resolve(null);
        return;
      }
      const action = spec.onKey(key);
      if (!action) return;
      if ("cancel" in action) {
        cleanup();
        resolve(null);
        return;
      }
      if ("done" in action) {
        cleanup();
        resolve(action.done);
        return;
      }
      render();
    };

    input.on("keypress", onKey);
    render();
  });
}

// ─── Single-choice radio list ───────────────────────────────────────────────

export interface RadioItem {
  label: string;
  hint: string;
}

export interface SelectOneOptions extends SelectorOptions {
  /** Panel title. Omitted renders bare rows with no frame. */
  title?: string;
  /** Step counter shown on the top rail, e.g. "1/3". */
  step?: string;
  /** A one-line warning shown above the options, inside the panel. */
  notice?: string | undefined;
  /** Key hints drawn under the panel. */
  hint?: string;
}

/**
 * Render the radio list as plain lines (no ANSI): a cursor marker, the radio
 * state, the label padded for alignment, then the hint. Pure so it can be
 * unit-tested; the interactive loop adds colour.
 */
export function renderRadioLines(items: RadioItem[], cursor: number): string[] {
  const width = Math.max(0, ...items.map((it) => it.label.length));
  return items.map((it, i) => {
    const marker = i === cursor ? "❯" : " ";
    const dot = i === cursor ? "◉" : "○";
    const row = `${marker} ${dot} ${it.label.padEnd(width)}`;
    return it.hint ? `${row}   ${it.hint}` : row.trimEnd();
  });
}

/** Colour one radio row: focused goes cyan, hints stay dim either way. */
function paintRadioRow(line: string, hint: string | undefined, focused: boolean): string {
  const withDimHint =
    hint && line.endsWith(hint) ? `${line.slice(0, -hint.length)}${styleText("dim", hint)}` : line;
  return focused ? styleText("cyan", withDimHint) : withDimHint;
}

/**
 * Lay the radio list out inside a panel: options stacked with their hints on a
 * second line, a blank row between each. Falls back to the bare rows when the
 * caller gave no title or the terminal is too narrow to frame.
 */
function radioPanelLines(
  items: RadioItem[],
  cursor: number,
  opts: SelectOneOptions,
  width: number | null,
): string[] {
  if (!opts.title || width === null) {
    // No frame, but the notice and the key hints still have to arrive: the File
    // access tip is the step's only explanation, and the hint line is where
    // `esc back` / `esc skip` is stated. Dropping them left a terminal too
    // narrow to frame with a menu that explained nothing.
    const rows = renderRadioLines(items, cursor).map((line, i) =>
      paintRadioRow(line, items[i]?.hint, i === cursor),
    );
    // Sized against the TERMINAL here, not the panel: `runSelector` rewinds by
    // the number of lines it wrote, so one string the terminal then soft-wraps
    // walks the menu down the screen on every keypress. The notice is 90
    // printable columns, so unwrapped it wraps at every width this branch runs
    // at (under MIN_PANEL_WIDTH + 2), not just the narrow ones. `||` not `??`,
    // matching panelWidth: a pty with no window size reports 0.
    const cols = opts.columns || process.stdout.columns || 80;
    const head = opts.notice
      ? [...wrapVisible(`${styleText("yellow", "!")} ${opts.notice}`, cols), ""]
      : [];
    return [
      ...head,
      ...rows,
      ...(opts.hint ? ["", clampVisible(styleText("dim", opts.hint), cols)] : []),
    ];
  }

  const lines = [
    panelTop(styleText("bold", opts.title), width, styleText("cyan", opts.step ?? "")),
  ];
  lines.push(panelRow("", width));
  if (opts.notice) {
    // Split across rows rather than clamped. A notice is the one row here that
    // carries a sentence, and at 72 columns (the widest panel we draw, reached
    // on any terminal of 74 or more) the File access tip lost its second half
    // to the ellipsis: "Pick directories uplo…".
    //
    // This does not break the redraw contract above. That rule forbids emitting
    // a row the TERMINAL then soft-wraps, because one string would occupy two
    // rows while counting as one. Each line below is its own panelRow, already
    // inside the width, and both the notice and the width are fixed for the
    // life of the selector, so `render()` still returns a constant count.
    //
    // -7: the `  ! ` prefix costs 4 and panelRow keeps a column of margin before
    // the border. Continuations indent 4 to sit under the first word.
    const [first, ...rest] = wrapVisible(opts.notice, width - 7);
    lines.push(panelRow(`  ${styleText("yellow", "!")} ${first ?? ""}`, width));
    for (const l of rest) lines.push(panelRow(`    ${l}`, width));
    lines.push(panelRow("", width));
  }
  items.forEach((item, i) => {
    const focused = i === cursor;
    const marker = focused ? "❯" : " ";
    const dot = focused ? "◉" : "○";
    const head = `  ${marker} ${dot}  ${item.label}`;
    lines.push(panelRow(focused ? styleText("cyan", head) : head, width));
    if (item.hint) lines.push(panelRow(`       ${styleText("dim", item.hint)}`, width));
    lines.push(panelRow("", width));
  });
  lines.push(panelBottom(width));
  if (opts.hint) lines.push(hintLine(opts.hint));
  return lines;
}

/**
 * Present the list and resolve the chosen index. Non-TTY (CI, pipes, tests
 * without `isTTY`) resolves 0 — the default option — without drawing anything.
 * Resolves null if the user cancels (Ctrl-C / Esc).
 */
export function selectOne(items: RadioItem[], opts: SelectOneOptions = {}): Promise<number | null> {
  const output = opts.output ?? process.stdout;
  const isTTY = opts.isTTY ?? (output as { isTTY?: boolean }).isTTY === true;

  if (!isTTY || items.length === 0) return Promise.resolve(items.length === 0 ? null : 0);

  // `panelWidth`'s own default, not `?? 80`: a pty with no window size reports
  // `columns` as 0, and `0 ?? 80` is 0, which sizes the panel to nothing and
  // drops the frame, the title and the notice while every other panel in the
  // same run still frames at 72. Passing `undefined` through lets panelWidth
  // apply `|| 80` once, in one place.
  const width = panelWidth(opts.columns);
  let cursor = 0;

  return runSelector<number>(
    {
      render: () => radioPanelLines(items, cursor, opts, width),
      onKey: (key) => {
        if (key.name === "escape") return { cancel: true };
        switch (key.name) {
          case "up":
          case "k":
            cursor = (cursor - 1 + items.length) % items.length;
            return { redraw: true };
          case "down":
          case "j":
            cursor = (cursor + 1) % items.length;
            return { redraw: true };
          case "space":
          case "return":
          case "enter":
            return { done: cursor };
          default:
            return undefined;
        }
      },
    },
    opts,
  );
}
