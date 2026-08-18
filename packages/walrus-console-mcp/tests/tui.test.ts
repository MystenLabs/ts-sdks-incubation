import { PassThrough } from "node:stream";
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
