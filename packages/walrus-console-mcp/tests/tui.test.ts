import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  clampVisible,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  panelBottom,
  panelRow,
  panelTop,
  panelWidth,
  railLine,
  renderRadioLines,
  selectOne,
  stripAnsi,
  visibleWidth,
  wrapVisible,
} from "../src/tui.js";

const ITEMS = [
  { label: "API key", hint: "everyday key" },
  { label: "Management key", hint: "mints API keys" },
  { label: "Both", hint: "" },
];

const CYAN = `${String.fromCharCode(27)}[36m`;
const RESET = `${String.fromCharCode(27)}[39m`;

describe("panelWidth", () => {
  it("leaves a column of margin either side, up to the cap", () => {
    expect(panelWidth(60)).toBe(58);
    expect(panelWidth(200)).toBe(MAX_PANEL_WIDTH);
  });

  it("returns null below the floor, so callers fall back to flat output", () => {
    expect(panelWidth(MIN_PANEL_WIDTH + 2)).toBe(MIN_PANEL_WIDTH);
    expect(panelWidth(MIN_PANEL_WIDTH + 1)).toBeNull();
    expect(panelWidth(20)).toBeNull();
  });
});

describe("panel borders", () => {
  it("draws a top rail of exactly the requested width", () => {
    for (const width of [MIN_PANEL_WIDTH, 56, MAX_PANEL_WIDTH]) {
      expect(visibleWidth(panelTop("CHOOSE CREDENTIALS", width, "1/3"))).toBe(width);
      expect(visibleWidth(panelTop("DONE", width))).toBe(width);
    }
  });

  it("keeps the width right when the label and step carry colour", () => {
    const label = `${CYAN}CHOOSE CREDENTIALS${RESET}`;
    const step = `${CYAN}1/3${RESET}`;
    expect(visibleWidth(panelTop(label, 56, step))).toBe(56);
  });

  it("puts the step on the rail and drops it when absent", () => {
    expect(stripAnsi(panelTop("REGISTER", 40, "3/3"))).toBe(`╭─ REGISTER ${"─".repeat(21)} 3/3 ─╮`);
    expect(stripAnsi(panelTop("DONE", 40))).toBe(`╭─ DONE ${"─".repeat(31)}╮`);
  });

  it("closes at the same width as it opened", () => {
    expect(visibleWidth(panelBottom(56))).toBe(56);
  });
});

describe("panelRow", () => {
  it("pads content out to the border", () => {
    expect(visibleWidth(panelRow("  hello", 56))).toBe(56);
    expect(visibleWidth(panelRow("", 56))).toBe(56);
  });

  it("pads to the border even when the content is styled", () => {
    expect(visibleWidth(panelRow(`  ${CYAN}hello${RESET}`, 56))).toBe(56);
  });

  it("clamps over-long content and keeps a space before the right border", () => {
    const row = panelRow(`  ${"x".repeat(200)}`, 56);
    expect(visibleWidth(row)).toBe(56);
    expect(stripAnsi(row).endsWith("… │")).toBe(true);
  });
});

describe("railLine", () => {
  it("has a left border only, so short content is not padded", () => {
    expect(stripAnsi(railLine("  hi", 56))).toBe("│  hi");
  });

  it("still clamps, so a long line cannot wrap and break the redraw count", () => {
    expect(visibleWidth(railLine(`  ${"x".repeat(200)}`, 56))).toBe(56);
  });
});

describe("wrapVisible", () => {
  it("leaves text that already fits on one line", () => {
    expect(wrapVisible("short enough", 40)).toEqual(["short enough"]);
  });

  it("breaks at word boundaries, never exceeding the width", () => {
    const long =
      "Provisioning host only — this key mints credentials. Don't copy the config to workers.";
    const lines = wrapVisible(long, 40);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
    expect(lines.join(" ")).toBe(long);
  });

  it("clamps a single word too long to break", () => {
    const [only] = wrapVisible("x".repeat(80), 20);
    expect(visibleWidth(only ?? "")).toBe(20);
  });

  it("does not count colour toward the width", () => {
    const [only] = wrapVisible(`${CYAN}four words fit here${RESET}`, 20);
    expect(only).toBe(`${CYAN}four words fit here${RESET}`);
  });
});

describe("wrapVisible and colour", () => {
  const ESCAPE = String.fromCharCode(27);

  // A styled run with a space in it splits across lines: the opening escape
  // lands on one line and the reset on the next, so the first line stays
  // "open" and its padding and right border take the colour. clampVisible
  // already closes the same hole for the truncating case.
  it("closes a style it had to split", () => {
    const lines = wrapVisible(`Change a key later: ${CYAN}walrus-console-mcp config${RESET}`, 24);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      if (line.includes(ESCAPE)) expect(line.endsWith(`${ESCAPE}[0m`)).toBe(true);
    }
  });

  it("leaves plain text alone", () => {
    expect(wrapVisible("one two three", 7)).toEqual(["one two", "three"]);
  });
});

describe("clampVisible", () => {
  it("leaves short strings alone", () => {
    expect(clampVisible("hello", 10)).toBe("hello");
  });

  it("measures visible columns, not bytes, so colour does not shorten content", () => {
    expect(clampVisible(`${CYAN}hello${RESET}`, 10)).toBe(`${CYAN}hello${RESET}`);
  });

  it("never cuts mid-escape, and resets style at the truncation point", () => {
    const clamped = clampVisible(`${CYAN}${"x".repeat(50)}${RESET}`, 10);
    expect(visibleWidth(clamped)).toBe(10);
    expect(clamped.startsWith(CYAN)).toBe(true);
    expect(clamped.endsWith(`${String.fromCharCode(27)}[0m`)).toBe(true);
  });
});

describe("renderRadioLines", () => {
  it("marks the focused row and fills exactly one radio", () => {
    const lines = renderRadioLines(ITEMS, 1);
    expect(lines[0]).toBe("  ○ API key          everyday key");
    expect(lines[1]).toBe("❯ ◉ Management key   mints API keys");
    expect(lines[2]).toBe("  ○ Both");
  });

  it("starts every hint at the same column, padded to the widest label", () => {
    const lines = renderRadioLines(ITEMS, 0);
    expect(lines[0]?.indexOf("everyday key")).toBe(lines[1]?.indexOf("mints API keys"));
  });

  it("omits the trailing padding for a row with no hint", () => {
    expect(renderRadioLines(ITEMS, 0)[2]).toBe("  ○ Both");
  });
});

describe("selectOne", () => {
  it("non-TTY resolves the first option without rendering", async () => {
    expect(await selectOne(ITEMS, { isTTY: false })).toBe(0);
  });

  it("arrow keys move and Enter selects", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = selectOne(ITEMS, { input, output, isTTY: true });

    input.write("\x1b[B"); // down -> Management key
    input.write("\r"); // enter selects
    expect(await pending).toBe(1);
  });

  it("wraps around at the ends", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = selectOne(ITEMS, { input, output, isTTY: true });

    input.write("\x1b[A"); // up from the first row wraps to the last
    input.write("\r");
    expect(await pending).toBe(2);
  });

  it("Ctrl-C cancels and returns null", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = selectOne(ITEMS, { input, output, isTTY: true });
    input.write("\x03");
    expect(await pending).toBeNull();
  });
});

/**
 * COMG-1036 item 4. A beta user saw the File access tip as
 * "Some agents don't share workspace folders. Pick directories uplo..." on a
 * wide terminal: the panel caps at MAX_PANEL_WIDTH and panelRow clamps, so the
 * tip lost its second half no matter how much room the terminal had.
 */
describe("selector notice", () => {
  /** Verbatim from bin/install.ts's File access step. */
  const FILE_ACCESS_TIP =
    "Some agents don't share workspace folders. Pick directories upload and download may use.";

  const collect = () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    return { stream, text: () => chunks.join("") };
  };

  /** Draw the panel at `columns`, then send `keys` and settle. */
  const draw = async (columns: number, keys: string[] = ["\r"]) => {
    const input = new PassThrough();
    const out = collect();
    const pending = selectOne(ITEMS, {
      input,
      output: out.stream,
      isTTY: true,
      columns,
      title: "FILE ACCESS",
      notice: FILE_ACCESS_TIP,
      hint: "up/down move   enter select   esc back",
    });
    for (const key of keys) input.write(key);
    await pending;
    return out.text();
  };

  it("shows the whole tip at 80 columns", async () => {
    const out = stripAnsi(await draw(80));
    expect(out).toContain("Some agents don't share workspace folders.");
    expect(out).toContain("download may use.");
    expect(out).not.toContain("…");
  });

  // Reproduced under `script -q /dev/null`: a pty with no window size reports
  // isTTY true and columns 0. The selector read that as a real width and fell
  // back to unframed rows, which drop the title and the notice entirely, while
  // the AUTHENTICATE panel a step later still framed at 72.
  it("frames, and keeps the tip, on a terminal that reports zero columns", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: 0, configurable: true });
    try {
      const input = new PassThrough();
      const out = collect();
      const pending = selectOne(ITEMS, {
        input,
        output: out.stream,
        isTTY: true,
        title: "FILE ACCESS",
        notice: FILE_ACCESS_TIP,
      });
      input.write("\r");
      await pending;
      const text = stripAnsi(out.text());
      expect(text).toContain("FILE ACCESS");
      expect(text).toContain("download may use.");
    } finally {
      if (original) Object.defineProperty(process.stdout, "columns", original);
      else delete (process.stdout as { columns?: number }).columns;
    }
  });

  it("still shows all of it on the narrowest panel we draw", async () => {
    const out = stripAnsi(await draw(MIN_PANEL_WIDTH + 2));
    expect(out).toContain("download may use.");
    expect(out).not.toContain("…");
  });

  // Built with RegExp rather than written as literals, matching src/tui.ts: an
  // escape character inside a regex literal is a lint error (no-control-regex).
  const ESC = String.fromCharCode(27);
  const ANY_ESCAPE = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");
  const ROW_ERASE = new RegExp(`${ESC}\\[2K`, "g");
  const CURSOR_UP = new RegExp(`${ESC}\\[(\\d+)A`);

  // stripAnsi drops colour only; the renderer also emits erase and cursor
  // escapes, and counting those as printable columns would fail every line.
  const printable = (text: string): string => stripAnsi(text).replace(ANY_ESCAPE, "");

  // The redraw contract: every line has to fit the terminal, or one row
  // occupies two and the cursor-up count walks the panel down the screen.
  it("never emits a line wider than the terminal", async () => {
    // MIN_PANEL_WIDTH + 1 is the unframed branch, which returns the notice and
    // the hint as plain lines. Without it in this loop the 90-column notice went
    // out raw and the redraw arithmetic was wrong at every unframed width.
    for (const columns of [MIN_PANEL_WIDTH + 1, MIN_PANEL_WIDTH + 2, 80, 200]) {
      const out = await draw(columns);
      for (const line of printable(out).split("\n")) {
        expect(line.length).toBeLessThanOrEqual(columns);
      }
    }
  });

  // The other half of the same contract: render() must return a constant count,
  // so the cursor-up on the second draw matches what the first one wrote.
  // Two things, because asserting the cursor-up against runSelector's own count
  // only pins runSelector: the redraw has to move up by what the FIRST render
  // wrote, and the SECOND render has to write that same number again. A notice
  // whose height depended on the cursor would pass the first and fail this.
  it("draws the same number of rows on every render, and rewinds exactly that far", async () => {
    const out = await draw(80, ["\x1b[B", "\r"]);
    const up = CURSOR_UP.exec(out);
    if (up === null) throw new Error("the arrow key did not trigger a redraw");
    const first = out.slice(0, up.index);
    const second = out.slice(up.index + up[0].length);
    const rows = (text: string) => (text.match(ROW_ERASE) ?? []).length;
    expect(rows(first)).toBe(Number(up[1]));
    expect(rows(second)).toBe(rows(first));
  });

  // The unframed fallback used to return the option rows and nothing else, so a
  // terminal too narrow to frame got a File access menu with no tip and no key
  // hints: the one screen where the explanation matters most.
  it("keeps the tip and the key hints when it is too narrow to frame", async () => {
    const text = stripAnsi(await draw(MIN_PANEL_WIDTH + 1));
    expect(text).not.toContain("\u256d");
    expect(text).toContain("Some agents don't share workspace folders.");
    expect(text).toContain("download may use.");
    expect(text).toContain("esc back");
  });
});
