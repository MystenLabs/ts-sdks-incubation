import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPackageVersion,
  isValidServiceKeyFormat,
  MASK_WIDTH,
  PACKAGE_NAME,
  echoPanelLine,
  maskedLine,
  maskedPanelLine,
  packageSpec,
  promptEcho,
  promptMasked,
  registerExitCode,
  resolveInstallBaseUrl,
  runInstall,
  savedLabel,
  showRow,
  allowedDirChoices,
  HOME_DIR_WARNING,
  stepAllowedDirs,
  stepAuth,
  stepRegister,
  streamPanel,
  visibleWidth,
} from "../bin/install.js";
import { DEFAULT_CONSOLE_API_BASE_URL } from "../src/baseUrl.js";
import type { Client } from "../src/clients.js";
import { loadConfigFile, saveConfigFile } from "../src/configFile.js";
import type { PinSeeds } from "../src/credentials.js";
import { toRealPath } from "../src/pathSandbox.js";
import { panelWidth, wrapVisible } from "../src/tui.js";

/** A real, decodable signer — `isValidServiceKeyFormat` now actually decodes the value. */
const VALID_SIGNER = Ed25519Keypair.generate().getSecretKey();

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-install-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("isValidServiceKeyFormat", () => {
  it("accepts a real generated suiprivkey1 key", () => {
    expect(isValidServiceKeyFormat(VALID_SIGNER)).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidServiceKeyFormat("")).toBe(false);
  });

  it("rejects a key without suiprivkey1 prefix", () => {
    expect(isValidServiceKeyFormat("hbr_not_a_service_key")).toBe(false);
  });

  it("rejects a key that is too short", () => {
    expect(isValidServiceKeyFormat("suiprivkey1abc")).toBe(false);
  });

  it("rejects a garbled key that only looks right (prefix + length)", () => {
    expect(isValidServiceKeyFormat(`suiprivkey1${"x".repeat(59)}`)).toBe(false);
  });
});

describe("maskedLine", () => {
  it("renders one bullet per typed character after the prompt", () => {
    expect(maskedLine("Key: ", 3)).toBe("\x1b[2K\x1b[0GKey: •••");
  });

  it("renders no bullets for an empty input", () => {
    expect(maskedLine("Key: ", 0)).toBe("\x1b[2K\x1b[0GKey: ");
  });

  it("never echoes the secret itself — output length is independent of content", () => {
    const short = maskedLine("Key: ", 4);
    const long = maskedLine("Key: ", 40);
    expect(short).not.toContain("hbr_");
    expect(long.length).toBeGreaterThan(short.length);
  });

  it("clamps bullets so a long paste can never exceed the terminal width", () => {
    const columns = 20;
    const body = maskedLine("Key: ", 100, columns).replace("\x1b[2K\x1b[0G", "");
    expect(visibleWidth(body)).toBeLessThanOrEqual(columns - 1);
    expect(body.startsWith("Key: ")).toBe(true);
  });

  it("measures the prompt width ignoring ANSI color codes", () => {
    const colored = `\x1b[36mKey:\x1b[39m `; // 5 visible chars, wrapped in color codes
    const body = maskedLine(colored, 100, 20).replace("\x1b[2K\x1b[0G", "");
    expect(visibleWidth(body)).toBeLessThanOrEqual(19);
  });

  // Regression: clamping only the bullets left the prompt itself to wrap when it
  // was wider than the terminal. The redraw clears one physical row, so the
  // rows above it kept their fragments and every keystroke stacked another.
  const WIDER_THAN_TERMINAL = "CONSOLE_SERVICE_PRIVATE_KEY (suiprivkey1…): "; // 44 visible

  it("truncates a prompt wider than the terminal so the redraw cannot wrap", () => {
    const body = maskedLine(WIDER_THAN_TERMINAL, 3, 20).replace("\x1b[2K\x1b[0G", "");
    expect(visibleWidth(body)).toBeLessThanOrEqual(19);
  });

  it("still masks typed characters when the prompt is wider than the terminal", () => {
    const body = maskedLine(WIDER_THAN_TERMINAL, 3, 20).replace("\x1b[2K\x1b[0G", "");
    expect(body).toContain("•");
  });

  it("closes the color when it truncates a styled prompt, so it cannot bleed", () => {
    const ESC = String.fromCharCode(27);
    const body = maskedLine(`${ESC}[36m${WIDER_THAN_TERMINAL}${ESC}[39m`, 3, 20).replace(
      "\x1b[2K\x1b[0G",
      "",
    );
    expect(body).toContain(`${ESC}[0m`);
  });

  // Regression: step 2 draws inside a panel, but this sized itself against the
  // terminal, so on a wide terminal a pasted key's bullets ran past the border.
  it("stays inside the panel when given the panel width, not the terminal width", () => {
    const width = panelWidth(140); // wide terminal, panel capped at MAX_PANEL_WIDTH
    expect(width).not.toBeNull();
    if (width === null) return;

    const question = `│  CONSOLE_ADMIN_SERVICE_PRIVATE_KEY (suiprivkey1…): `;
    const body = maskedLine(question, 200, width).replace("\x1b[2K\x1b[0G", "");
    expect(visibleWidth(body)).toBeLessThanOrEqual(width);

    // Without the width it sizes against the terminal and overflows the panel.
    const unbounded = maskedLine(question, 200, 140).replace("\x1b[2K\x1b[0G", "");
    expect(visibleWidth(unbounded)).toBeGreaterThan(width);
  });
});

describe("maskedPanelLine", () => {
  const WIDTH = 72;
  // Built rather than written literally: a raw escape in a regex trips
  // biome's noControlCharactersInRegex, as it does everywhere else here.
  const ESC = String.fromCharCode(27);
  const CURSOR_BACK = new RegExp(`${ESC}\\[(\\d+)D$`);
  const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
  const strip = (s: string) => s.replace(`${ESC}[2K${ESC}[0G`, "").replace(CURSOR_BACK, "");
  const plain = (s: string) => strip(s).replace(SGR, "");

  it("closes the row at exactly the panel width, whatever the paste length", () => {
    for (const length of [0, 4, 36, 70, 500]) {
      const row = plain(maskedPanelLine("│  API key: ", length, WIDTH));
      expect(row.length).toBe(WIDTH);
      expect(row.endsWith("│")).toBe(true);
    }
  });

  it("parks the cursor after the field, not outside the box", () => {
    // The trailing cursor-left must cover the padding plus the border itself,
    // or the next keystroke lands to the right of the panel.
    const raw = maskedPanelLine("│  API key: ", 4, WIDTH);
    const back = CURSOR_BACK.exec(raw);
    expect(back).not.toBeNull();

    const beforeCursor = plain(raw).length - Number(back?.[1] ?? 0);
    expect(beforeCursor).toBe(visibleWidth("│  API key: ") + MASK_WIDTH);
  });

  it("never echoes the secret", () => {
    const row = maskedPanelLine("│  API key: ", 36, WIDTH);
    expect(row).not.toContain("hbr_");
  });

  // The field is fixed-width on purpose: a bullet-per-character run publishes
  // the secret's length, and these lengths identify the credential type
  // (hbr_ 36, hbradm_ 39, suiprivkey1 70).
  it("renders an identical field for every non-empty length", () => {
    const rows = [1, 36, 39, 70, 500].map((n) => plain(maskedPanelLine("│  Key: ", n, WIDTH)));
    expect(new Set(rows).size).toBe(1);
    expect(rows[0]).toContain("•".repeat(MASK_WIDTH));
  });

  it("renders no bullets while the field is empty, so the first keystroke shows", () => {
    const empty = plain(maskedPanelLine("│  Key: ", 0, WIDTH));
    expect(empty).not.toContain("•");
    expect(plain(maskedPanelLine("│  Key: ", 1, WIDTH))).not.toBe(empty);
  });

  it("shrinks the field rather than overflowing when the label is long", () => {
    const long = `│  ${"CONSOLE_ADMIN_SERVICE_PRIVATE_KEY (suiprivkey1…)"}: `;
    const row = plain(maskedPanelLine(long, 500, WIDTH));
    expect(row.length).toBe(WIDTH);
    expect(row.endsWith("│")).toBe(true);
  });
});

describe("echoPanelLine", () => {
  const WIDTH = 72;
  const ESC = String.fromCharCode(27);
  const CURSOR_BACK = new RegExp(`${ESC}\\[(\\d+)D$`);
  const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
  const strip = (s: string) => s.replace(`${ESC}[2K${ESC}[0G`, "").replace(CURSOR_BACK, "");
  const plain = (s: string) => strip(s).replace(SGR, "");
  const ADDRESS = `0x${"a".repeat(64)}`;

  it("closes the row at exactly the panel width when the value fits", () => {
    const row = plain(echoPanelLine("│  Pin this as the bucket owner? [y/N]: ", "y", WIDTH));
    expect(row.length).toBe(WIDTH);
    expect(row.endsWith("│")).toBe(true);
  });

  it("parks the cursor after the typed text, not outside the box", () => {
    const question = "│  Pin this as the bucket owner? [y/N]: ";
    const raw = echoPanelLine(question, "y", WIDTH);
    const back = CURSOR_BACK.exec(raw);
    expect(back).not.toBeNull();
    const beforeCursor = plain(raw).length - Number(back?.[1] ?? 0);
    expect(beforeCursor).toBe(visibleWidth(question) + 1);
  });

  // The load-bearing case from the AUTHENTICATE screenshot: a 66-char Sui
  // address on a gutter-only row must stay inside the box. A question that
  // already contains the address cannot.
  it("frames a 66-character address when the question is only the gutter", () => {
    const row = plain(echoPanelLine("│  ", ADDRESS, WIDTH));
    expect(row.length).toBe(WIDTH);
    expect(row.endsWith("│")).toBe(true);
    expect(row).toContain(ADDRESS);
  });

  it("drops the border rather than clamping when the value cannot fit", () => {
    const question = `│  Pin ${ADDRESS} as the bucket owner? [y/N]: `;
    const row = plain(echoPanelLine(question, "y", WIDTH));
    expect(row).toContain(ADDRESS);
    expect(row.endsWith("│")).toBe(false);
  });
});

describe("visibleWidth", () => {
  it("ignores ANSI SGR color codes", () => {
    expect(visibleWidth("\x1b[36mKey:\x1b[39m")).toBe(4);
  });

  it("counts a plain string as-is", () => {
    expect(visibleWidth("hello")).toBe(5);
  });
});

describe("promptMasked", () => {
  const secret = "hbr_super_secret_value";

  it("returns the typed secret but never echoes it to the terminal", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let echoed = "";
    output.on("data", (chunk) => {
      echoed += chunk.toString();
    });

    // Force the TTY path so masking is exercised (PassThrough is not a TTY).
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });

    const rl = readline.createInterface({ input, output, terminal: true });
    try {
      const pending = promptMasked(rl, "KEY: ");
      // Simulate the user typing the secret and pressing Enter.
      input.write(`${secret}\n`);
      const result = await pending;

      expect(result).toBe(secret);
      // The plaintext secret must never appear in what the terminal rendered.
      expect(echoed).not.toContain(secret);
      // Each character should have been redrawn as a bullet.
      expect(echoed).toContain("•");
    } finally {
      rl.close();
      if (originalIsTTY === undefined) {
        Object.defineProperty(process.stdout, "isTTY", {
          value: undefined,
          configurable: true,
        });
      } else {
        Object.defineProperty(process.stdout, "isTTY", {
          value: originalIsTTY,
          configurable: true,
        });
      }
    }
  });

  it("falls back to a plain echoed prompt when stdout is not a TTY", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rl = readline.createInterface({ input, output });
    // process.stdout.isTTY is false/undefined under the test runner.
    const pending = promptMasked(rl, "KEY: ");
    input.write(`${secret}\n`);
    const result = await pending;
    rl.close();
    expect(result).toBe(secret);
  });

  // Readline sizes the cursor from prompt + the REAL line. A 400-character
  // bundle paste wraps to several terminal rows, but we only paint 16 bullets
  // on one row. Delete then sends CSI nA for the phantom wrap, walking the
  // cursor out of the AUTHENTICATE box. TERM must not be "dumb" or readline
  // skips that refresh entirely.
  it("does not walk the cursor up when a wrapping paste is deleted", async () => {
    const prevTerm = process.env["TERM"];
    process.env["TERM"] = "xterm-256color";

    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode: (m: boolean) => void;
    };
    input.isTTY = true;
    input.setRawMode = () => {};

    const output = new PassThrough() as PassThrough & {
      isTTY: boolean;
      columns: number;
    };
    output.isTTY = true;
    output.columns = 80;
    let echoed = "";
    output.on("data", (chunk) => {
      echoed += chunk.toString();
    });

    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });

    const rl = readline.createInterface({ input, output, terminal: true });
    try {
      const pending = promptMasked(rl, "│  BUNDLE: ", 72);
      input.write("x".repeat(400));
      input.write("\x7f");
      input.write("\x7f");
      input.write("\r");
      const result = await pending;

      expect(result.length).toBe(398);
      // Paint still reached the real stream — a silent discard of everything
      // would also have no cursor-up, and a blank prompt row.
      expect(echoed).toContain("•");
      const esc = String.fromCharCode(27);
      expect(echoed).toContain(`${esc}[2K`);
      expect(echoed).not.toMatch(new RegExp(`${esc}\\[\\d*A`));
      // _refreshLine always emits clearScreenDown + CHA; those must not hit the TTY.
      expect(echoed).not.toMatch(new RegExp(`${esc}\\[\\d*J`));
      expect(echoed).not.toMatch(new RegExp(`${esc}\\[(?:[1-9]\\d*)G`));
    } finally {
      rl.close();
      if (prevTerm === undefined) delete process.env["TERM"];
      else process.env["TERM"] = prevTerm;
      if (originalIsTTY === undefined) {
        Object.defineProperty(process.stdout, "isTTY", {
          value: undefined,
          configurable: true,
        });
      } else {
        Object.defineProperty(process.stdout, "isTTY", {
          value: originalIsTTY,
          configurable: true,
        });
      }
    }
  });
});

/**
 * Cursor row the terminal ends on after replaying `bytes` at `columns` wide.
 * Only vertical position matters here, so this tracks the cursor rather than
 * the screen — with the deferred wrap real terminals use (filling the last
 * column parks the cursor there until the next character), because an eager
 * wrap reports damage that no terminal actually shows.
 */
function finalRow(bytes: string, columns: number): number {
  // Built, not a literal: an ESC in a regex literal trips no-control-regex.
  const csiPattern = new RegExp(`^${String.fromCharCode(27)}\\[([0-9;]*)([A-Za-z])`);
  let row = 0;
  let col = 0;
  let pending = false;
  let i = 0;
  while (i < bytes.length) {
    const csi = csiPattern.exec(bytes.slice(i));
    if (csi) {
      const arg = csi[1] ?? "";
      const n = arg === "" ? 0 : Number.parseInt(arg.split(";")[0] ?? "0", 10);
      if (csi[2] !== "m") pending = false;
      if (csi[2] === "A") row = Math.max(0, row - (n || 1));
      else if (csi[2] === "B") row += n || 1;
      else if (csi[2] === "G") col = Math.max(0, (n || 1) - 1);
      else if (csi[2] === "D") col = Math.max(0, col - (n || 1));
      else if (csi[2] === "C") col = Math.min(columns - 1, col + (n || 1));
      i += csi[0].length;
      continue;
    }
    const ch = bytes[i];
    if (ch === "\n") {
      row++;
      col = 0;
      pending = false;
    } else if (ch === "\r") {
      col = 0;
      pending = false;
    } else {
      if (pending) {
        row++;
        col = 0;
        pending = false;
      }
      if (col === columns - 1) pending = true;
      else col++;
    }
    i++;
  }
  return row;
}

describe("promptEcho", () => {
  // A 66-character Sui address must never be truncated (see `echoPanelLine`),
  // so on a narrow terminal the painted row is wider than the terminal and
  // wraps. `\x1b[2K\x1b[0G` at the head of each paint only clears the row the
  // cursor is on — the continuation row, once wrapped — so without an explicit
  // walk back to the top of the block every keystroke redraws one row lower and
  // the address smears down the screen.
  it("repaints in place when the value is wider than the terminal", async () => {
    const prevTerm = process.env["TERM"];
    process.env["TERM"] = "xterm-256color";
    const columns = 60;
    const address = `0x${"a".repeat(64)}`;

    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode: (m: boolean) => void;
    };
    input.isTTY = true;
    input.setRawMode = () => {};

    const output = new PassThrough() as PassThrough & {
      isTTY: boolean;
      columns: number;
    };
    output.isTTY = true;
    output.columns = columns;
    let echoed = "";
    output.on("data", (chunk) => {
      echoed += chunk.toString();
    });

    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    const rl = readline.createInterface({ input, output, terminal: true });
    try {
      // panelWidth(60) — the panel still fits, it is the value that does not.
      const pending = promptEcho(rl, "\u001b[2m│\u001b[22m  ", 58);
      for (const ch of address) input.write(ch);
      input.write("\r");
      const result = await pending;

      expect(result).toBe(address);
      // 3-column gutter + 66 = 69 columns, so the block is exactly two rows;
      // the trailing newline lands us on the third. Anything more is smear.
      expect(finalRow(echoed, columns)).toBe(2);
    } finally {
      rl.close();
      if (prevTerm === undefined) delete process.env["TERM"];
      else process.env["TERM"] = prevTerm;
      Object.defineProperty(process.stdout, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });

  // `[kMoveCursor]` writes Left/Right movement straight to the interface's
  // output, which is the discard stream while we own the row — so the caret
  // only follows the insertion point if the paint puts it there.
  it("walks the caret back to the insertion point", async () => {
    const prevTerm = process.env["TERM"];
    process.env["TERM"] = "xterm-256color";

    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode: (m: boolean) => void;
    };
    input.isTTY = true;
    input.setRawMode = () => {};

    const output = new PassThrough() as PassThrough & {
      isTTY: boolean;
      columns: number;
    };
    output.isTTY = true;
    output.columns = 80;
    let echoed = "";
    output.on("data", (chunk) => {
      echoed += chunk.toString();
    });

    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    const rl = readline.createInterface({ input, output, terminal: true });
    try {
      const pending = promptEcho(rl, "│  ", 72);
      input.write("abcdef");
      await new Promise((r) => setTimeout(r, 10));
      const beforeArrows = echoed.length;
      input.write("\u001b[D");
      input.write("\u001b[D");
      await new Promise((r) => setTimeout(r, 10));
      // The arrows must have produced a repaint of their own; without one the
      // caret is stranded at the end of the echoed value.
      const onArrows = echoed.slice(beforeArrows);
      expect(onArrows).toContain("\u001b[2K");
      expect(onArrows.endsWith("\u001b[2D")).toBe(true);

      input.write("\r");
      expect(await pending).toBe("abcdef");
    } finally {
      rl.close();
      if (prevTerm === undefined) delete process.env["TERM"];
      else process.env["TERM"] = prevTerm;
      Object.defineProperty(process.stdout, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });
});

describe("PACKAGE_NAME", () => {
  // A spec that doesn't match the published name can't resolve, and an
  // unclaimed name is squattable — whatever npx fetches runs with access to the
  // stored credentials. Pin the two together so they can never drift.
  it("is the name this package actually publishes under", () => {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name?: string };
    expect(PACKAGE_NAME).toBe(pkg.name);
  });

  it("is scoped, not a bare unclaimed name", () => {
    expect(PACKAGE_NAME.startsWith("@")).toBe(true);
  });
});

describe("packageSpec", () => {
  it("pins the given version", () => {
    expect(packageSpec("1.2.3")).toBe(`${PACKAGE_NAME}@1.2.3`);
  });

  it("falls back to the unpinned name when the version is unknown", () => {
    expect(packageSpec(null)).toBe(PACKAGE_NAME);
  });

  it("reads this package's real version by default", () => {
    expect(packageSpec()).toMatch(new RegExp(`^${PACKAGE_NAME}@\\d+\\.\\d+\\.\\d+`));
  });
});

describe("getPackageVersion", () => {
  it("returns this package's semver-shaped version", () => {
    expect(getPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// Client detection + registration (Claude Desktop, Cursor, Claude Code, Codex,
// Gemini) lives in src/clients.ts and is covered by tests/clients.test.ts.

describe("allowedDirChoices", () => {
  it("builds presets from cwd and home, never POSIX literals", () => {
    const cwd = path.join(tmpDir, "project");
    const home = path.join(tmpDir, "home");
    const choices = allowedDirChoices(cwd, home);
    expect(choices.map((c) => c.id)).toEqual([
      "cwd",
      "documents",
      "downloads",
      "home",
      "custom",
      "skip",
    ]);
    expect(choices[0]?.path).toBe(cwd);
    expect(choices[1]?.path).toBe(path.join(home, "Documents"));
    expect(choices[2]?.path).toBe(path.join(home, "Downloads"));
    expect(choices[3]?.path).toBe(home);
    expect(choices[4]?.path).toBeUndefined();
    expect(choices[5]?.path).toBeUndefined();
  });
});

describe("stepAllowedDirs", () => {
  it("persists the cwd preset and does not ask for a custom path", async () => {
    const merged: unknown[] = [];
    const write = await stepAllowedDirs({
      cwd: tmpDir,
      home: tmpDir,
      select: async () => 0,
      ask: async () => "",
      merge: (updates) => {
        merged.push(updates);
        return { ...updates };
      },
    });
    expect(write.updates.allowedDirs).toEqual([toRealPath(tmpDir)]);
    expect(merged).toEqual([{ allowedDirs: [toRealPath(tmpDir)] }]);
  });

  it("writes nothing on skip", async () => {
    let merged = false;
    const write = await stepAllowedDirs({
      cwd: tmpDir,
      home: tmpDir,
      select: async () => 5,
      merge: () => {
        merged = true;
        return {};
      },
    });
    expect(write.updates).toEqual({});
    expect(merged).toBe(false);
  });

  it("writes nothing when the radio is cancelled", async () => {
    const write = await stepAllowedDirs({
      cwd: tmpDir,
      home: tmpDir,
      select: async () => null,
      merge: () => {
        throw new Error("must not persist");
      },
    });
    expect(write.updates).toEqual({});
  });

  it("accepts a custom path and an extra directory", async () => {
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-extra-dir-"));
    try {
      const answers = [extra, "n"];
      const write = await stepAllowedDirs({
        cwd: tmpDir,
        home: tmpDir,
        select: async () => 4, // custom
        ask: async () => answers.shift() ?? "",
        merge: (updates) => updates,
      });
      expect(write.updates.allowedDirs).toEqual([toRealPath(extra)]);
    } finally {
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });

  it("warns when Home is chosen", () => {
    expect(HOME_DIR_WARNING).toMatch(/home directory/i);
  });
});

describe("stepRegister outcome and exit code", () => {
  const spec = "@scope/pkg@1.0.0";

  const fakeClient = (over: Partial<Client> = {}): Client => ({
    id: "fake",
    label: "Fake Agent",
    detect: () => true,
    register: () => {},
    manualHint: () => "fake --add",
    ...over,
  });

  // The load-bearing case: auth succeeded (credentials saved) but the server
  // install threw, so nothing was registered. This MUST map to a non-zero exit
  // — the old `return 0` made it indistinguishable from a deliberate cancel.
  it("reports install-failed with a non-zero exit code when the server install throws", async () => {
    const result = await stepRegister(spec, {
      select: async () => [fakeClient()],
      install: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    expect(result.outcome).toBe("install-failed");
    expect(result.configured).toBe(0);
    expect(registerExitCode(result.outcome)).toBe(1);
  });

  it("reports installed and a zero exit code when registration succeeds", async () => {
    let registered = "";
    const result = await stepRegister(spec, {
      select: async () => [
        fakeClient({
          register: (cmd) => {
            registered = cmd;
          },
        }),
      ],
      install: () => "/abs/launcher",
    });
    expect(result.outcome).toBe("installed");
    expect(result.configured).toBe(1);
    expect(registered).toBe("/abs/launcher");
    expect(registerExitCode(result.outcome)).toBe(0);
  });

  it("keeps a zero exit code when the checklist is cancelled", async () => {
    const result = await stepRegister(spec, { select: async () => null });
    expect(result.outcome).toBe("cancelled");
    expect(registerExitCode(result.outcome)).toBe(0);
  });

  it("keeps a zero exit code when no client is ticked", async () => {
    const result = await stepRegister(spec, { select: async () => [] });
    expect(result.outcome).toBe("none-selected");
    expect(registerExitCode(result.outcome)).toBe(0);
  });
});

// The anti-clamping guarantee, tested against the RENDERER rather than the
// caller. `collectBundle` calling `deps.show` with an untruncated string says
// nothing about whether the thing on the other end truncates it — and the whole
// point of the seam is that an operator confirming `0xaaa…` has confirmed a
// prefix, not an address. Anyone routing `show` back through the wrapping
// closure (`line`) must fail here.
describe("showRow — a pinned address is never clamped", () => {
  const ADDRESS = `0x${"a".repeat(64)}`; // 66 visible columns
  const strip = (s: string) =>
    s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

  it("keeps the full address at every panel width, and when there is no panel", () => {
    // Wide (the panel caps at MAX_PANEL_WIDTH), narrow, and the flat fallback.
    for (const columns of [140, 80, 74, 60, 50]) {
      const width = panelWidth(columns);
      expect(strip(showRow(ADDRESS, width))).toContain(ADDRESS);
    }
    expect(strip(showRow(ADDRESS, null))).toContain(ADDRESS);
  });

  it("frames the value when the row can hold it", () => {
    const width = panelWidth(140);
    expect(width).not.toBeNull();
    if (width === null) return;
    const row = showRow(ADDRESS, width);
    expect(visibleWidth(row)).toBe(width);
    expect(strip(row).endsWith("│")).toBe(true);
  });

  it("drops the border rather than the value when the row cannot", () => {
    // 48-column panel: 2 indent + 66 address is far past what panelRow keeps.
    const width = panelWidth(50);
    expect(width).not.toBeNull();
    if (width === null) return;
    const row = showRow(ADDRESS, width);
    expect(strip(row)).toContain(ADDRESS);
    expect(strip(row)).not.toContain("│");
  });

  // The contrast that makes the seam necessary: the wrapping path used by every
  // other panel line truncates this exact value at every width we draw at.
  it("is not what the wrapping path would have produced", () => {
    for (const columns of [140, 80, 60]) {
      const width = panelWidth(columns);
      if (width === null) continue;
      const [first] = wrapVisible(`· ${ADDRESS}`, width - 7);
      expect(String(first)).not.toContain(ADDRESS);
    }
  });
});

describe("streamPanel().show", () => {
  const ADDRESS = `0x${"b".repeat(64)}`;

  /** Capture what the panel writes, at a chosen terminal width. */
  const captureShow = (columns: number): string => {
    const written: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      streamPanel("AUTHENTICATE", "2/4").show(ADDRESS);
    } finally {
      process.stdout.write = originalWrite;
      Object.defineProperty(process.stdout, "columns", {
        value: originalColumns,
        configurable: true,
      });
    }
    return written.join("");
  };

  // The seam is only worth having if the panel's own `show` is wired to it.
  it("prints the address verbatim on a wide terminal", () => {
    expect(captureShow(140)).toContain(ADDRESS);
  });

  it("prints the address verbatim on a narrow one", () => {
    expect(captureShow(50)).toContain(ADDRESS);
  });

  it("prints it verbatim even when the terminal is too narrow to draw a panel", () => {
    expect(captureShow(30)).toContain(ADDRESS);
  });
});

// The summary line is a claim about what reached the disk, and two flows can
// make the old unconditional "Credentials saved" false: a declined bundle
// confirmation writes nothing, and --owner-address writes no credential.
describe("savedLabel", () => {
  it("says credentials were saved when a credential was written", () => {
    expect(savedLabel({ updates: { apiKey: "hbr_x" }, clear: [] })).toBe("Credentials saved");
    expect(savedLabel({ updates: { adminKey: "hbradm_x" }, clear: [] })).toBe("Credentials saved");
  });

  it("does not claim a credential for an address-pin-only write", () => {
    const label = savedLabel({ updates: { webAccountAddress: `0x${"a".repeat(64)}` }, clear: [] });
    expect(label).toBe("Configuration saved");
  });

  it("does not claim a credential for an allowedDirs-only write", () => {
    expect(savedLabel({ updates: { allowedDirs: ["/tmp"] }, clear: [] })).toBe(
      "Configuration saved",
    );
  });

  it("says nothing was saved for an empty write", () => {
    expect(savedLabel({ updates: {}, clear: [] })).toContain("Nothing saved");
  });

  // A clear-only write still touches the file, so it is not "nothing saved".
  it("treats a clear-only write as a real change", () => {
    expect(savedLabel({ updates: {}, clear: ["webAccountAddress"] })).toBe("Configuration saved");
  });
});

describe("resolveInstallBaseUrl", () => {
  // The installer probes a credential against this URL and then persists it, so
  // the order here must match the SERVER's order (src/config.ts `resolvedBaseUrl`:
  // env → saved file → default). Any divergence validates a key against one
  // deployment and then runs against another.
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    envBackup = { ...process.env };
    process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
    delete process.env["CONSOLE_API_BASE_URL"];
  });

  afterEach(() => {
    process.env = envBackup;
  });

  it("falls back to the mainnet default when nothing is set", () => {
    expect(resolveInstallBaseUrl()).toBe(DEFAULT_CONSOLE_API_BASE_URL);
  });

  it("prefers the env override over everything", () => {
    saveConfigFile({ baseUrl: "http://localhost:3000" });
    process.env["CONSOLE_API_BASE_URL"] = "https://api.staging.walrus.xyz";

    expect(resolveInstallBaseUrl()).toBe("https://api.staging.walrus.xyz");
  });

  it("uses the saved deployment when no env override is set", () => {
    // Rotating a key for a saved local/staging deployment must probe THAT
    // deployment. Probing testnet instead either rejects a valid credential or
    // validates it against a service it will never talk to.
    saveConfigFile({ baseUrl: "http://localhost:3000" });

    expect(resolveInstallBaseUrl()).toBe("http://localhost:3000");
  });

  it("ignores an off-policy saved value rather than trusting the file", () => {
    // loadConfigFile already drops an off-policy baseUrl; assert the installer
    // ends up on the default rather than inheriting an attacker-written host.
    fs.mkdirSync(path.join(tmpDir, "walrus-console-mcp"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "walrus-console-mcp", "config.json"),
      JSON.stringify({ baseUrl: "https://evil.example.com" }),
    );

    expect(resolveInstallBaseUrl()).toBe(DEFAULT_CONSOLE_API_BASE_URL);
  });

  it("still rejects an off-policy env override", () => {
    process.env["CONSOLE_API_BASE_URL"] = "https://evil.example.com";

    expect(() => resolveInstallBaseUrl()).toThrow(/not an allowed Console endpoint/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seeded file access and the runInstall wiring.
//
// `--allowed-dirs` typed next to an address seed deliberately does NOT force
// silent mode (see ParsedArgs.silent), so the only thing that can honour it is
// the interactive path. These tests pin that it is honoured — and that the
// entry point actually hands the flags to the steps that consume them.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ADDRESS = `0x${"a".repeat(64)}`;
const KEY_ADMIN_ADDRESS = `0x${"b".repeat(64)}`;

/** Collect everything written to stdout so a panel does not pollute the report. */
function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

describe("stepAllowedDirs — --allowed-dirs seed", () => {
  it("saves every seeded directory and never opens the picker", async () => {
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-seed-dir-"));
    const capture = captureStdout();
    try {
      const merged: unknown[] = [];
      let selectCalls = 0;
      const write = await stepAllowedDirs({
        cwd: tmpDir,
        home: tmpDir,
        seed: [tmpDir, extra],
        select: async () => {
          selectCalls++;
          return 0;
        },
        ask: async () => {
          throw new Error("must not prompt for a folder when the flag supplied one");
        },
        merge: (updates) => {
          merged.push(updates);
          return { ...updates };
        },
      });
      expect(write.updates.allowedDirs).toEqual([toRealPath(tmpDir), toRealPath(extra)]);
      expect(merged).toEqual([{ allowedDirs: [toRealPath(tmpDir), toRealPath(extra)] }]);
      expect(selectCalls).toBe(0);
      // The operator must be able to see what was saved, and that the flag is
      // why the picker never appeared.
      const out = capture.text();
      expect(out).toContain(toRealPath(extra));
      expect(out).toContain("--allowed-dirs");
    } finally {
      capture.restore();
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });

  it("dedupes a directory the seed names twice", async () => {
    const capture = captureStdout();
    try {
      const write = await stepAllowedDirs({
        cwd: tmpDir,
        home: tmpDir,
        seed: [tmpDir, tmpDir],
        select: async () => {
          throw new Error("must not open the picker");
        },
        merge: (updates) => ({ ...updates }),
      });
      expect(write.updates.allowedDirs).toEqual([toRealPath(tmpDir)]);
    } finally {
      capture.restore();
    }
  });

  // The load-bearing refusal: a bad folder must NOT fall through to the picker,
  // or the operator answers a question they already answered on the command
  // line and never learns the flag was wrong.
  it("refuses a seeded directory that does not exist and names it", async () => {
    const missing = path.join(tmpDir, "not-a-folder");
    const capture = captureStdout();
    let selectCalls = 0;
    try {
      const write = await stepAllowedDirs({
        cwd: tmpDir,
        home: tmpDir,
        seed: [missing],
        select: async () => {
          selectCalls++;
          return 0;
        },
        merge: () => {
          throw new Error("must not persist a rejected seed");
        },
      });
      expect(write.updates).toEqual({});
      expect(write.seedRejected).toBe(true);
      expect(selectCalls).toBe(0);
      expect(capture.text()).toContain(missing);
    } finally {
      capture.restore();
    }
  });

  it("reports every bad entry, not just the first", async () => {
    const missingA = path.join(tmpDir, "missing-a");
    const missingB = path.join(tmpDir, "missing-b");
    const capture = captureStdout();
    try {
      const write = await stepAllowedDirs({
        cwd: tmpDir,
        home: tmpDir,
        seed: [missingA, missingB],
        select: async () => {
          throw new Error("must not open the picker");
        },
        merge: () => {
          throw new Error("must not persist a rejected seed");
        },
      });
      expect(write.seedRejected).toBe(true);
      const out = capture.text();
      expect(out).toContain(missingA);
      expect(out).toContain(missingB);
    } finally {
      capture.restore();
    }
  });

  it("still opens the picker when the seed is empty", async () => {
    const capture = captureStdout();
    try {
      let selectCalls = 0;
      const write = await stepAllowedDirs({
        cwd: tmpDir,
        home: tmpDir,
        seed: [],
        select: async () => {
          selectCalls++;
          return 5; // skip
        },
        merge: () => ({}),
      });
      expect(selectCalls).toBe(1);
      expect(write.updates).toEqual({});
    } finally {
      capture.restore();
    }
  });
});

describe("stepAuth", () => {
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    envBackup = { ...process.env };
    process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
    delete process.env["CONSOLE_API_BASE_URL"];
  });

  afterEach(() => {
    process.env = envBackup;
  });

  // stepAuth is the only consumer of the two address seeds on the interactive
  // path; if it stops forwarding them the pins are silently dropped.
  it("forwards both address seeds to the credential collector", async () => {
    const seen: PinSeeds[] = [];
    const rl = readline.createInterface({
      input: new PassThrough(),
      output: new PassThrough(),
    });
    const capture = captureStdout();
    try {
      await stepAuth(
        rl,
        "api",
        { ownerAddress: OWNER_ADDRESS, keyAdminAddress: KEY_ADMIN_ADDRESS },
        {
          collect: async (_choice, _deps, _existing, seeds) => {
            seen.push(seeds ?? {});
            return { updates: {}, clear: [] };
          },
        },
      );
    } finally {
      capture.restore();
      rl.close();
    }
    expect(seen).toEqual([{ ownerAddress: OWNER_ADDRESS, keyAdminAddress: KEY_ADMIN_ADDRESS }]);
  });
});

describe("runInstall", () => {
  /** `runInstall` exits rather than returning a code; make that observable. */
  class ExitSignal extends Error {
    constructor(readonly code: number) {
      super(`process.exit(${code})`);
    }
  }

  let envBackup: NodeJS.ProcessEnv;
  let exitBackup: typeof process.exit;

  beforeEach(() => {
    envBackup = { ...process.env };
    process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("CONSOLE_")) delete process.env[key];
    }
    exitBackup = process.exit;
    process.exit = ((code?: number) => {
      throw new ExitSignal(code ?? 0);
    }) as typeof process.exit;
    // Every probe reports a management key unless a test overrides it.
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
  });

  afterEach(() => {
    process.env = envBackup;
    process.exit = exitBackup;
    vi.unstubAllGlobals();
  });

  /** Run the silent path and report the exit code it asked for. */
  async function runSilent(argv: string[]): Promise<{ code: number; out: string }> {
    const capture = captureStdout();
    try {
      await runInstall(argv);
    } catch (err) {
      if (err instanceof ExitSignal) return { code: err.code, out: capture.text() };
      throw err;
    } finally {
      capture.restore();
    }
    throw new Error("runInstall returned without exiting");
  }

  describe("silent mode", () => {
    it("writes the management pair and exits 0", async () => {
      const { code } = await runSilent([
        "--admin-key",
        "hbradm_management_key",
        "--admin-signer",
        VALID_SIGNER,
      ]);
      expect(code).toBe(0);
      const saved = loadConfigFile();
      expect(saved.adminKey).toBe("hbradm_management_key");
      expect(saved.adminServicePrivateKey).toBe(VALID_SIGNER);
    });

    it("writes both address pins from the flags", async () => {
      const { code } = await runSilent([
        "--silent",
        "--owner-address",
        OWNER_ADDRESS,
        "--key-admin-address",
        KEY_ADMIN_ADDRESS,
      ]);
      expect(code).toBe(0);
      expect(loadConfigFile()).toMatchObject({
        webAccountAddress: OWNER_ADDRESS,
        keyAdminAddress: KEY_ADMIN_ADDRESS,
      });
    });

    // The warning is the whole point of the silent working-key path: without a
    // pin every create_bucket refuses, and a scripted install would otherwise
    // report success and leave that to be discovered at runtime.
    it("prints the owner warning for a working key with no pin", async () => {
      vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));
      const { code, out } = await runSilent(["--api-key", "hbr_working_key_value"]);
      expect(code).toBe(0);
      expect(out).toContain("Credentials saved");
      expect(out).toContain("create_bucket will REFUSE");
      expect(out).toContain("CONSOLE_WEB_ACCOUNT_ADDRESS");
    });

    it("writes nothing and exits 1 when the probe rejects the key", async () => {
      vi.stubGlobal("fetch", async () => new Response("", { status: 401 }));
      const { code } = await runSilent([
        "--admin-key",
        "hbradm_management_key",
        "--admin-signer",
        VALID_SIGNER,
      ]);
      expect(code).toBe(1);
      expect(loadConfigFile()).toEqual({});
    });

    it("writes nothing and exits 1 on a bad flag", async () => {
      const { code } = await runSilent(["--owner-address", "0xNOT_AN_ADDRESS"]);
      expect(code).toBe(1);
      expect(loadConfigFile()).toEqual({});
    });

    it("persists a seeded --allowed-dirs without credentials", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-install-dirs-"));
      try {
        const { code } = await runSilent(["--allowed-dirs", dir]);
        expect(code).toBe(0);
        expect(loadConfigFile().allowedDirs).toEqual([toRealPath(dir)]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("interactive wiring", () => {
    /** A readline over detached pipes: the wiring test must not touch a TTY. */
    const pipeReadline = () =>
      readline.createInterface({ input: new PassThrough(), output: new PassThrough() });

    it("forwards both address seeds to the auth step and the folder seed to file access", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-install-seed-"));
      const seedsSeen: PinSeeds[] = [];
      const dirSeeds: (readonly string[] | undefined)[] = [];
      const capture = captureStdout();
      try {
        await runInstall(
          [
            "--owner-address",
            OWNER_ADDRESS,
            "--key-admin-address",
            KEY_ADMIN_ADDRESS,
            "--allowed-dirs",
            dir,
            "--no-register",
          ],
          {
            choose: async () => "api",
            createReadline: pipeReadline,
            auth: async (_rl, _choice, seeds) => {
              seedsSeen.push(seeds);
              return { updates: {}, clear: [] };
            },
            allowedDirs: async (deps) => {
              dirSeeds.push(deps.seed);
              return { updates: {}, clear: [] };
            },
          },
        );
      } finally {
        capture.restore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
      expect(seedsSeen).toEqual([
        { ownerAddress: OWNER_ADDRESS, keyAdminAddress: KEY_ADMIN_ADDRESS },
      ]);
      expect(dirSeeds).toEqual([[dir]]);
    });

    // The acceptance check: `install --allowed-dirs /does/not/exist
    // --owner-address 0x…` must refuse before anything is written. The auth step
    // persists as soon as a key is confirmed, so a folder checked at step 3
    // leaves a key and a pin on disk and refuses afterwards.
    it("refuses a bad --allowed-dirs before the chooser and writes nothing", async () => {
      const missing = path.join(tmpDir, "no-such-folder");
      const exitCodeBackup = process.exitCode;
      const capture = captureStdout();
      let seenExitCode: typeof process.exitCode;
      let chooseCalls = 0;
      let authCalls = 0;
      try {
        await runInstall(["--allowed-dirs", missing, "--owner-address", OWNER_ADDRESS], {
          choose: async () => {
            chooseCalls++;
            return "api";
          },
          createReadline: pipeReadline,
          auth: async () => {
            authCalls++;
            return { updates: { apiKey: "hbr_x" }, clear: [] };
          },
          allowedDirs: async () => ({ updates: {}, clear: [] }),
        });
        seenExitCode = process.exitCode;
      } finally {
        capture.restore();
        process.exitCode = exitCodeBackup;
      }
      expect(seenExitCode).toBe(1);
      expect(chooseCalls).toBe(0);
      expect(authCalls).toBe(0);
      // Nothing on disk: not the key, not the pin the seed carried.
      expect(loadConfigFile()).toEqual({});
      // The whole path, not a clamped prefix, and only once.
      const out = capture.text();
      expect(out).toContain(missing);
      expect(out.split(missing).length - 1).toBe(1);
    });

    // An address seed is what keeps a --allowed-dirs argv interactive; without
    // one it is a silent run, which validateSilent already covers.
    it("names every bad folder in the preflight, not just the first", async () => {
      const missingA = path.join(tmpDir, "missing-a");
      const missingB = path.join(tmpDir, "missing-b");
      const exitCodeBackup = process.exitCode;
      const capture = captureStdout();
      let seenExitCode: typeof process.exitCode;
      let chooseCalls = 0;
      try {
        await runInstall(
          [
            "--allowed-dirs",
            missingA,
            "--allowed-dirs",
            missingB,
            "--owner-address",
            OWNER_ADDRESS,
          ],
          {
            choose: async () => {
              chooseCalls++;
              return "api";
            },
            createReadline: pipeReadline,
          },
        );
        seenExitCode = process.exitCode;
      } finally {
        capture.restore();
        process.exitCode = exitCodeBackup;
      }
      const out = capture.text();
      expect(out).toContain(missingA);
      expect(out).toContain(missingB);
      // The refusal is the point, not just the text of it.
      expect(seenExitCode).toBe(1);
      expect(chooseCalls).toBe(0);
      expect(loadConfigFile()).toEqual({});
    });

    it("registers nothing and skips the auth step when the chooser is cancelled", async () => {
      let authCalls = 0;
      let registerCalls = 0;
      const capture = captureStdout();
      try {
        await runInstall([], {
          choose: async () => null,
          createReadline: pipeReadline,
          auth: async () => {
            authCalls++;
            return { updates: {}, clear: [] };
          },
          register: async () => {
            registerCalls++;
            return { outcome: "none-selected", configured: 0 };
          },
        });
      } finally {
        capture.restore();
      }
      expect(authCalls).toBe(0);
      expect(registerCalls).toBe(0);
    });

    // The credentials really were saved, so this is not a FAILED run — but the
    // summary must not imply the folders were saved when they were refused.
    it("says in the summary that a refused folder seed was not saved", async () => {
      const exitCodeBackup = process.exitCode;
      const capture = captureStdout();
      let seenExitCode: typeof process.exitCode;
      try {
        await runInstall(["--no-register"], {
          choose: async () => "api",
          createReadline: pipeReadline,
          auth: async () => ({ updates: { apiKey: "hbr_x" }, clear: [] }),
          allowedDirs: async () => ({ updates: {}, clear: [], seedRejected: true }),
        });
        seenExitCode = process.exitCode;
      } finally {
        capture.restore();
        process.exitCode = exitCodeBackup;
      }
      const out = capture.text();
      expect(out).toContain("File access folders NOT saved");
      expect(out).not.toContain("\u2714 File access folders saved");
      // The summary row and the exit code must not contradict each other.
      expect(seenExitCode).toBe(1);
    });

    it("reports a failed server install with a non-zero exit code", async () => {
      const exitCodeBackup = process.exitCode;
      const capture = captureStdout();
      try {
        await runInstall([], {
          choose: async () => "api",
          createReadline: pipeReadline,
          auth: async () => ({ updates: {}, clear: [] }),
          allowedDirs: async () => ({ updates: {}, clear: [] }),
          register: async () => ({ outcome: "install-failed", configured: 0 }),
        });
        expect(process.exitCode).toBe(1);
        expect(capture.text()).toContain("Server install failed");
      } finally {
        capture.restore();
        process.exitCode = exitCodeBackup;
      }
    });
  });
});
