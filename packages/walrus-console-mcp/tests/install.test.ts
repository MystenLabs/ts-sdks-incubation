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
import { type Client, jsonFileClient } from "../src/clients.js";
import {
  getAdminConfigFilePath,
  getConfigDir,
  loadConfigFile,
  type mergeConfigFile,
  saveConfigFile,
} from "../src/configFile.js";
import type { PinSeeds } from "../src/credentials.js";
import { toRealPath } from "../src/pathSandbox.js";
import { panelWidth, stripAnsi, wrapVisible } from "../src/tui.js";

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

// Client detection + registration (Claude Code, Cursor, Codex, Gemini, Antigravity) lives in
// src/clients.ts and is covered by tests/clients.test.ts.

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

  // Companion to stepAuth's equivalent test above: this step only ever
  // writes `allowedDirs`, so a legacy inline admin pair migrating into
  // admin.json is always a side effect of `mergeConfigFile`'s own read, not
  // something `updates` names — the "saved →" line has to learn about it
  // from the migration notice firing, not from `updates`. Uses the REAL
  // `mergeConfigFile` (no `merge` override) so the migration actually runs.
  it("names admin.json in the saved line when this write migrates a legacy inline pair (interactive picker)", async () => {
    const envBackup = { ...process.env };
    process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
    try {
      const dir = getConfigDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ adminKey: "hbradm_legacy", adminServicePrivateKey: VALID_SIGNER }),
        "utf-8",
      );
      const target = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-picker-dir-"));
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      const capture = captureStdout();
      try {
        await stepAllowedDirs({
          cwd: tmpDir,
          home: tmpDir,
          select: async () => 4, // custom
          ask: async () => target,
        });
        expect(capture.text()).toContain("config.json + admin.json");
        // Review, "test gap": the earlier assertion above only pins
        // the saved-line WORDING, not that the migration notice actually
        // reached the panel's own line printer rather than console.error —
        // reverting that specific onNotice callback to console.error left
        // this test green. These two lines close that gap.
        expect(warn).not.toHaveBeenCalled();
        expect(capture.text()).toContain("Moving the Key-Admin credential");
        expect(fs.existsSync(getAdminConfigFilePath())).toBe(true);
      } finally {
        capture.restore();
        warn.mockRestore();
        fs.rmSync(target, { recursive: true, force: true });
      }
    } finally {
      process.env = envBackup;
    }
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

  it("prints a client's nextStep after verification succeeds, and only then", async () => {
    const capture = captureStdout();
    let outputDuringVerification = "";
    try {
      await stepRegister(spec, {
        select: async () => [
          fakeClient({
            label: "Hinted",
            nextStep: "Reload it in the app.",
            verify: () => {
              outputDuringVerification = capture.text();
              return undefined;
            },
          }),
          fakeClient({ label: "Plain" }),
        ],
        install: () => "/abs/launcher",
      });
      const out = capture.text();
      expect(outputDuringVerification).not.toContain("Hinted configured");
      expect(outputDuringVerification).not.toContain("Reload it in the app.");
      expect(out).toContain("Hinted configured");
      expect(out).toContain("Reload it in the app.");
      expect(out.match(/Reload it in the app\./g)).toHaveLength(1);
    } finally {
      capture.restore();
    }
  });

  // A JSON-file client's app can save settings it loaded before we wrote, dropping
  // our entry with no error on our side. The check runs after every client has
  // registered, so the app has had the CLI clients' run time to do it.
  it("re-checks every configured client after the last one, and does not count one whose entry is gone", async () => {
    const capture = captureStdout();
    const order: string[] = [];
    try {
      const result = await stepRegister(spec, {
        select: async () => [
          fakeClient({
            label: "Overwritten",
            register: () => order.push("register Overwritten"),
            verify: (cmd) => {
              order.push(`verify Overwritten ${cmd}`);
              return "the entry is no longer there";
            },
          }),
          fakeClient({
            label: "Kept",
            register: () => order.push("register Kept"),
            verify: () => {
              order.push("verify Kept");
              return undefined;
            },
          }),
          fakeClient({ label: "NoVerify", register: () => order.push("register NoVerify") }),
        ],
        install: () => "/abs/launcher",
      });
      expect(order).toEqual([
        "register Overwritten",
        "register Kept",
        "register NoVerify",
        "verify Overwritten /abs/launcher",
        "verify Kept",
      ]);
      expect(result.configured).toBe(2);
      const out = capture.text();
      expect(out).toMatch(/Overwritten.*the entry is no longer there/);
      expect(out).toContain("re-run the installer");
      expect(out).not.toMatch(/Kept.*no longer/);
    } finally {
      capture.restore();
    }
  });

  it.each(["unreadable", "missing"] as const)(
    "withholds success and reload instructions when a real JSON entry becomes %s",
    async (failure) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pr90-verify-"));
      const configPath = path.join(fixture, "mcp.json");
      fs.writeFileSync(configPath, '{"mcpServers":{"other":{"command":"other"}}}');
      let denyRead = false;
      const real = jsonFileClient({
        id: "fixture",
        label: "Fixture",
        detect: () => true,
        configPath: () => configPath,
        readFile: (p) => {
          if (denyRead) throw Object.assign(new Error("EACCES fixture"), { code: "EACCES" });
          return fs.readFileSync(p, "utf8");
        },
      });
      const capture = captureStdout();
      try {
        const result = await stepRegister(spec, {
          install: () => "/abs/launcher",
          select: async () => [
            { ...real, nextStep: "Reload fixture client." },
            fakeClient({
              label: "Fine",
              // Simulate another writer changing the earlier client's config
              // between registration and the final verification pass.
              register: () => {
                if (failure === "unreadable") denyRead = true;
                else fs.unlinkSync(configPath);
              },
            }),
          ],
        });
        const out = capture.text();
        expect(result.configured).toBe(1);
        expect(out).toContain("Fixture could not be verified");
        expect(out).not.toContain("Fixture entry lost");
        expect(out).not.toContain("Fixture configured");
        expect(out).not.toContain("Reload fixture client.");
        expect(out).toContain("Fine configured");
        if (failure === "unreadable") {
          expect(out).toContain("EACCES fixture");
          expect(
            JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers["walrus-console-mcp"],
          ).toEqual({ command: "/abs/launcher", args: [] });
        } else {
          expect(out).toContain("no longer there");
          expect(fs.existsSync(configPath)).toBe(false);
        }
      } finally {
        capture.restore();
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it("keeps going when a client's verify throws, reporting it as unverified", async () => {
    const capture = captureStdout();
    try {
      const result = await stepRegister(spec, {
        select: async () => [
          fakeClient({
            label: "Throws",
            nextStep: "Reload throwing client.",
            verify: () => {
              throw new Error("no home directory");
            },
          }),
          fakeClient({ label: "Fine", verify: () => undefined }),
        ],
        install: () => "/abs/launcher",
      });
      expect(result.configured).toBe(1);
      expect(capture.text()).toMatch(/Throws.*could not be verified.*no home directory/);
      expect(capture.text()).not.toContain("Throws entry lost");
      expect(capture.text()).not.toContain("Throws configured");
      expect(capture.text()).not.toContain("Reload throwing client.");
    } finally {
      capture.restore();
    }
  });

  it("does not verify a client whose register failed", async () => {
    let verified = false;
    const result = await stepRegister(spec, {
      select: async () => [
        fakeClient({
          register: () => {
            throw new Error("boom");
          },
          verify: () => {
            verified = true;
            return undefined;
          },
        }),
      ],
      install: () => "/abs/launcher",
    });
    expect(verified).toBe(false);
    expect(result.configured).toBe(0);
  });

  it("does not print nextStep when registration fails", async () => {
    const capture = captureStdout();
    try {
      await stepRegister(spec, {
        select: async () => [
          fakeClient({
            nextStep: "Reload it in the app.",
            register: () => {
              throw new Error("boom");
            },
          }),
        ],
        install: () => "/abs/launcher",
      });
      const out = capture.text();
      expect(out).toContain("not configured");
      expect(out).not.toContain("Reload it in the app.");
    } finally {
      capture.restore();
    }
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

  // COMG-1133: Claude Desktop is no longer a row, so a Desktop-only user who
  // re-runs `install` to upgrade ticks nothing — and the launcher their
  // hand-written entry points at is silently left on the old version.
  it("says the launcher was not installed or upgraded when no client is ticked", async () => {
    let installed = false;
    const capture = captureStdout();
    try {
      await stepRegister(spec, {
        select: async () => [],
        install: () => {
          installed = true;
          return "/abs/launcher";
        },
      });
    } finally {
      capture.restore();
    }
    expect(installed).toBe(false);
    expect(capture.text()).toContain("launcher was not installed or upgraded");
    expect(capture.text()).toContain("Claude Desktop");
  });

  it("says the launcher was not installed or upgraded when the checklist is cancelled", async () => {
    let installed = false;
    const capture = captureStdout();
    try {
      await stepRegister(spec, {
        select: async () => null,
        install: () => {
          installed = true;
          return "/abs/launcher";
        },
      });
    } finally {
      capture.restore();
    }
    expect(installed).toBe(false);
    expect(capture.text()).toContain("launcher was not installed or upgraded");
    expect(capture.text()).toContain("Claude Desktop");
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

  // Same case as the interactive-picker test above, for applySeededAllowedDirs
  // (the `--allowed-dirs` flag path) — its panel uses `rail`, a real bordered
  // box a bare console.error would break, so this also stands in for that
  // regression check. Uses the REAL mergeConfigFile (no `merge` override).
  it("names admin.json in the saved line when this write migrates a legacy inline pair (seeded)", async () => {
    const envBackup = { ...process.env };
    process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
    try {
      const dir = getConfigDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ adminKey: "hbradm_legacy", adminServicePrivateKey: VALID_SIGNER }),
        "utf-8",
      );
      const target = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-seed-migrate-dir-"));
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      const capture = captureStdout();
      try {
        await stepAllowedDirs({ cwd: tmpDir, home: tmpDir, seed: [target] });
        expect(capture.text()).toContain("config.json + admin.json");
        // Review, "test gap": pins that the migration notice reached
        // `rail.line`, not a bare `console.error` — a revert of that specific
        // onNotice callback left this test green before this assertion.
        expect(warn).not.toHaveBeenCalled();
        expect(capture.text()).toContain("Moving the Key-Admin credential");
        expect(fs.existsSync(getAdminConfigFilePath())).toBe(true);
      } finally {
        capture.restore();
        warn.mockRestore();
        fs.rmSync(target, { recursive: true, force: true });
      }
    } finally {
      process.env = envBackup;
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

  // The C15 review also flagged (as "cosmetic, related") that the
  // "saved →" summary line only named admin.json when `updates` itself
  // carried an admin field — missing the case where a legacy inline pair
  // migrates as a side effect of an otherwise unrelated write (exactly what
  // the C15 fix made possible: the notice now fires here too). This proves
  // the summary line follows suit.
  it("names admin.json in the saved summary when this write migrates a legacy inline pair as a side effect", async () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ adminKey: "hbradm_legacy", adminServicePrivateKey: VALID_SIGNER }),
      "utf-8",
    );

    const rl = readline.createInterface({ input: new PassThrough(), output: new PassThrough() });
    const capture = captureStdout();
    try {
      // Only a working-key write — no admin field in `updates` — yet the
      // legacy pair already on disk still needs to migrate into admin.json.
      await stepAuth(
        rl,
        "api",
        {},
        {
          collect: async () => ({ updates: { apiKey: "hbr_new" }, clear: [] }),
        },
      );
    } finally {
      capture.restore();
      rl.close();
    }
    expect(capture.text()).toContain("config.json + admin.json");
    expect(fs.existsSync(getAdminConfigFilePath())).toBe(true);
  });

  // security review, C18: `resolveInstallBaseUrl` and the pre-write
  // `loadConfigFileOrEmpty` read inside this step both used to warn about a
  // corrupt file via the default bare `console.error` — landing mid-render
  // and tearing the AUTHENTICATE panel's `│` border, the same failure mode
  // `onNotice` was added to `mergeConfigFile` to fix. Both are wired to the
  // panel's own line printer now, so a corrupt file here must never reach
  // `console.error` at all.
  it("routes a corrupt config.json's warnings through the panel instead of a bare console.error (C18)", async () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{ not valid json", "utf-8");

    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const rl = readline.createInterface({ input: new PassThrough(), output: new PassThrough() });
    const capture = captureStdout();
    try {
      await stepAuth(rl, "api", {}, { collect: async () => ({ updates: {}, clear: [] }) });
      expect(warn).not.toHaveBeenCalled();
      expect(capture.text()).toContain("could not be parsed as JSON");
    } finally {
      capture.restore();
      rl.close();
      warn.mockRestore();
    }
  });

  // security review, "test gap": the test above only isolates
  // `resolveInstallBaseUrl`'s onNotice — with the per-path dedup (C16b),
  // that read always happens first and already consumes the one warning for
  // config.json, so the SECOND read (the `loadConfigFileOrEmpty` fed to
  // `collect` below) never even attempts to warn, and its own onNotice
  // wiring could be reverted to a bare `console.error` without this test
  // going red. Setting CONSOLE_API_BASE_URL short-circuits
  // `resolveInstallBaseUrl` before it ever reads the file (see its own
  // `CONSOLE_API_BASE_URL || loadConfigFileOrEmpty(...)…`), so THIS read is
  // the first and only one — isolating the second call site for real.
  it("routes the pre-write loadConfigFileOrEmpty's own warning through the panel too, not just resolveInstallBaseUrl's (C18)", async () => {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{ not valid json", "utf-8");

    const envBackup = { ...process.env };
    process.env = { ...process.env, CONSOLE_API_BASE_URL: DEFAULT_CONSOLE_API_BASE_URL };
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const rl = readline.createInterface({ input: new PassThrough(), output: new PassThrough() });
    const capture = captureStdout();
    try {
      await stepAuth(rl, "api", {}, { collect: async () => ({ updates: {}, clear: [] }) });
      expect(warn).not.toHaveBeenCalled();
      expect(capture.text()).toContain("could not be parsed as JSON");
    } finally {
      capture.restore();
      rl.close();
      warn.mockRestore();
      process.env = envBackup;
    }
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

    // security review, C11: `resolveInstallBaseUrl` and the pre-write read
    // passed to `validateSilent` as `existing` both used to call
    // `loadConfigFile` bare — a pure read, evaluated as a plain function
    // argument before `validateSilent` ever runs, so a corrupt admin.json
    // threw there and masked whatever `validateSilent` would otherwise have
    // reported. The actual WRITE (`mergeConfigFile`'s own internal load)
    // stays correctly fail-stop on a genuinely corrupt admin.json — the
    // review itself calls that "deliberate and right" — so this only fixes the
    // reads that ran BEFORE any write decision exists. What's testable
    // post-fix: a wrong-key-type error unrelated to admin.json now surfaces
    // correctly instead of being pre-empted by the admin file's own corruption.
    it("surfaces a real validation error instead of an unrelated admin.json corruption (C11)", async () => {
      fs.mkdirSync(getConfigDir(), { recursive: true });
      fs.writeFileSync(getAdminConfigFilePath(), '{ "adminKey": "hbradm_TRUNC', "utf-8");

      const { code, out } = await runSilent([
        "--admin-key",
        "hbr_wrong_type",
        "--admin-signer",
        VALID_SIGNER,
      ]);

      expect(code).toBe(1);
      expect(out).toMatch(/everyday API key/i); // validateSilent's real error
      expect(out).not.toMatch(/could not be parsed as JSON/); // the masked one
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

    // COMG-1133 review: ticking nothing is now the normal Claude Desktop path, so
    // a green "0 agents configured" plus "Restart your agent" reads as success
    // while no launcher exists for any agent to start.
    for (const outcome of ["none-selected", "cancelled"] as const) {
      it(`does not report success in the DONE panel when registration is ${outcome}`, async () => {
        const exitCodeBackup = process.exitCode;
        const capture = captureStdout();
        try {
          await runInstall([], {
            choose: async () => "api",
            createReadline: pipeReadline,
            auth: async () => ({ updates: {}, clear: [] }),
            allowedDirs: async () => ({ updates: {}, clear: [] }),
            register: async () => ({ outcome, configured: 0 }),
          });
          const out = capture.text();
          expect(out).toContain("No agent registered");
          expect(out).not.toContain("0 agents configured");
          expect(out).not.toContain("Restart your agent");
          expect(process.exitCode ?? 0).toBe(0);
        } finally {
          capture.restore();
          process.exitCode = exitCodeBackup;
        }
      });
    }

    it("still tells the user to restart their agent when one was configured", async () => {
      const capture = captureStdout();
      try {
        await runInstall([], {
          choose: async () => "api",
          createReadline: pipeReadline,
          auth: async () => ({ updates: {}, clear: [] }),
          allowedDirs: async () => ({ updates: {}, clear: [] }),
          register: async () => ({ outcome: "installed", configured: 1 }),
        });
        const out = capture.text();
        expect(out).toContain("1 agent configured");
        expect(out).toContain("Restart your agent");
      } finally {
        capture.restore();
      }
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

/**
 * COMG-1036 items 3 and 5: esc on the File access step, and what the installer
 * says last.
 */
describe("stepAllowedDirs — esc (COMG-1036)", () => {
  it("skips, and says so, when there is no previous step to return to", async () => {
    const capture = captureStdout();
    let write: Awaited<ReturnType<typeof stepAllowedDirs>>;
    try {
      write = await stepAllowedDirs({ select: async () => null, cwd: tmpDir, home: tmpDir });
    } finally {
      capture.restore();
    }
    expect(write.backRequested).toBeUndefined();
    expect(capture.text()).toContain("File access skipped");
  });

  // `config` redraws the menu straight after, so a "skipped" line printed above
  // it would describe the opposite of what happened.
  it("reports back and prints nothing when the caller offers one", async () => {
    const capture = captureStdout();
    let write: Awaited<ReturnType<typeof stepAllowedDirs>>;
    try {
      write = await stepAllowedDirs({
        select: async () => null,
        cwd: tmpDir,
        home: tmpDir,
        back: true,
      });
    } finally {
      capture.restore();
    }
    expect(write.backRequested).toBe(true);
    expect(write.updates).toEqual({});
    expect(capture.text()).toBe("");
  });

  it("tells the user which one esc does", async () => {
    const hints: (string | undefined)[] = [];
    const capture = captureStdout();
    try {
      for (const back of [false, true]) {
        await stepAllowedDirs({
          select: async (_items, opts) => {
            hints.push(opts?.hint);
            return null;
          },
          cwd: tmpDir,
          home: tmpDir,
          back,
        });
      }
    } finally {
      capture.restore();
    }
    expect(hints[0]).toContain("esc skip");
    expect(hints[1]).toContain("esc back");
  });
});

describe("stepAllowedDirs — the custom-path prompt (COMG-1036)", () => {
  /** The index of the "Custom path" row in allowedDirChoices. */
  const customRow = (cwd: string, home: string) =>
    allowedDirChoices(cwd, home).findIndex((c) => c.id === "custom");

  /**
   * A prompt that gives up rather than answering forever.
   *
   * The loop under test re-asks until a folder validates, so a stub that always
   * answers turns a regression into a hung CI job instead of a failure. Verified
   * by deleting the `back` branch: this throws on the sixth call.
   */
  /**
   * A merge that writes nothing. Without it `stepAllowedDirs` falls back to the
   * real `mergeConfigFile`, whose target is resolved from the ambient
   * XDG_CONFIG_HOME at call time: on a run that reaches the write, that is the
   * developer's own ~/.config/walrus-console-mcp/config.json.
   */
  const noMerge = (() => {}) as unknown as typeof mergeConfigFile;

  const askAtMost = (answers: string[]) => {
    let calls = 0;
    return async (): Promise<string> => {
      if (++calls > answers.length + 1) {
        throw new Error("the custom-path prompt never let go");
      }
      return answers[calls - 1] ?? "back";
    };
  };

  it("re-asks until a folder validates, which is why it needs a way out", async () => {
    const capture = captureStdout();
    let write: Awaited<ReturnType<typeof stepAllowedDirs>>;
    try {
      write = await stepAllowedDirs({
        select: async () => customRow(tmpDir, tmpDir),
        ask: askAtMost(["", "back"]),
        cwd: tmpDir,
        merge: noMerge,
        home: tmpDir,
      });
    } finally {
      capture.restore();
    }
    // The empty answer was refused rather than accepted, and `back` ended it.
    expect(capture.text()).toContain("This value is required");
    expect(capture.text()).toContain("File access skipped");
    expect(write.updates).toEqual({});
  });

  it("returns to the menu instead, when the caller has one", async () => {
    const capture = captureStdout();
    let write: Awaited<ReturnType<typeof stepAllowedDirs>>;
    try {
      write = await stepAllowedDirs({
        select: async () => customRow(tmpDir, tmpDir),
        ask: askAtMost(["BACK "]),
        cwd: tmpDir,
        merge: noMerge,
        home: tmpDir,
        back: true,
      });
    } finally {
      capture.restore();
    }
    // Trimmed and case-folded, like every other answer this CLI reads.
    expect(write.backRequested).toBe(true);
    expect(capture.text()).not.toContain("File access skipped");
  });

  it("leaves without saving from the add-another prompt, which used to save", async () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-addanother-"));
    const merged: unknown[] = [];
    const capture = captureStdout();
    let write: Awaited<ReturnType<typeof stepAllowedDirs>>;
    try {
      write = await stepAllowedDirs({
        select: async () => customRow(tmpDir, tmpDir),
        // A folder that validates, then `back` at "Add another directory?".
        ask: askAtMost([real, "back"]),
        cwd: tmpDir,
        home: tmpDir,
        merge: ((u: unknown) => {
          merged.push(u);
        }) as unknown as typeof mergeConfigFile,
      });
    } finally {
      capture.restore();
      fs.rmSync(real, { recursive: true, force: true });
    }
    // Before this, `back` fell through `isAffirmative` as "no" and the step
    // saved the folder it had collected, one prompt after promising otherwise.
    expect(merged).toEqual([]);
    expect(write.updates).toEqual({});
  });

  it("leaves from the follow-up folder prompt too", async () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-followup-"));
    const merged: unknown[] = [];
    const capture = captureStdout();
    let write: Awaited<ReturnType<typeof stepAllowedDirs>>;
    try {
      write = await stepAllowedDirs({
        select: async () => customRow(tmpDir, tmpDir),
        ask: askAtMost([real, "y", "back"]),
        cwd: tmpDir,
        home: tmpDir,
        merge: ((u: unknown) => {
          merged.push(u);
        }) as unknown as typeof mergeConfigFile,
      });
    } finally {
      capture.restore();
      fs.rmSync(real, { recursive: true, force: true });
    }
    expect(merged).toEqual([]);
    expect(write.updates).toEqual({});
  });

  // The other side of the same edit: reading the answer once, to check it for
  // the sentinel, must not break the ordinary y/N loop.
  it("still saves when the operator answers the add-another prompt normally", async () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-normal-"));
    const merged: unknown[] = [];
    const capture = captureStdout();
    let write: Awaited<ReturnType<typeof stepAllowedDirs>>;
    try {
      write = await stepAllowedDirs({
        select: async () => customRow(tmpDir, tmpDir),
        ask: askAtMost([real, "n"]),
        cwd: tmpDir,
        home: tmpDir,
        merge: ((u: unknown) => {
          merged.push(u);
        }) as unknown as typeof mergeConfigFile,
      });
    } finally {
      capture.restore();
      fs.rmSync(real, { recursive: true, force: true });
    }
    expect(merged).toHaveLength(1);
    expect(write.updates.allowedDirs).toHaveLength(1);
  });

  it("says so before the prompt, since an unadvertised way out is none", async () => {
    const capture = captureStdout();
    try {
      await stepAllowedDirs({
        select: async () => customRow(tmpDir, tmpDir),
        ask: askAtMost(["back"]),
        cwd: tmpDir,
        merge: noMerge,
        home: tmpDir,
      });
    } finally {
      capture.restore();
    }
    expect(capture.text()).toContain('Type "back" at any prompt to leave this step');
  });
});

describe("runInstall — the last thing it says (COMG-1036)", () => {
  /** A readline over detached pipes: this must not touch a TTY. */
  const pipeReadline = () =>
    readline.createInterface({ input: new PassThrough(), output: new PassThrough() });

  // `claude mcp list` reports Connected the moment the server is registered, so
  // a session that was already running looks healthy while exposing none of the
  // 17 tools. The 18 September report is someone re-running the installer
  // instead, which changes nothing.
  /** Drive a minimal interactive install and return everything it printed. */
  const runToSummary = async (columns?: number): Promise<string> => {
    const envBackup = { ...process.env };
    const colsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
    if (columns !== undefined) {
      Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
    }
    const capture = captureStdout();
    try {
      await runInstall(["--no-register"], {
        choose: async () => "api",
        createReadline: pipeReadline,
        auth: async () => ({ updates: { apiKey: "hbr_x" }, clear: [] }),
        allowedDirs: async () => ({ updates: {}, clear: [] }),
      });
    } finally {
      capture.restore();
      process.env = envBackup;
      if (colsDescriptor) Object.defineProperty(process.stdout, "columns", colsDescriptor);
      else delete (process.stdout as { columns?: number }).columns;
    }
    return capture.text();
  };

  // The panel frames down to MIN_PANEL_WIDTH, and its rows used to be clamped,
  // so this sentence lost its second half at every width, including the widest
  // panel: it is 90 printable columns against a 67-column budget. The
  // same defect as the File access tip, in the same change that fixed that one.
  // Under vitest `process.stdout.columns` is undefined, so a test that does not
  // set it only ever sees the widest panel.
  it("keeps the whole sentence on a narrow terminal", async () => {
    for (const columns of [46, 60, 70]) {
      const out = stripAnsi(await runToSummary(columns));
      expect(out).not.toContain("\u2026");
      // Borders and line breaks removed, so the assertion is about the sentence
      // surviving rather than about where it happened to wrap.
      const flat = out.replace(/[\u2502\u256d\u256e\u2570\u256f\u2500]/g, " ").replace(/\s+/g, " ");
      expect(flat).toContain(
        "Restart your agent now. The tools will not appear in a session that was already running.",
      );
      expect(flat).toContain("Then run ping_console to confirm.");
    }
  });

  it("ends by telling the user to restart the agent, and names the check", async () => {
    const envBackup = { ...process.env };
    process.env = { ...process.env, XDG_CONFIG_HOME: tmpDir };
    const capture = captureStdout();
    try {
      await runInstall(["--no-register"], {
        choose: async () => "api",
        createReadline: pipeReadline,
        auth: async () => ({ updates: { apiKey: "hbr_x" }, clear: [] }),
        allowedDirs: async () => ({ updates: {}, clear: [] }),
      });
    } finally {
      capture.restore();
      process.env = envBackup;
    }
    const out = capture.text();
    expect(out).toContain("Restart your agent now");
    expect(out).toContain("will not appear in a session");
    expect(out).toContain("ping_console");
    // Last, not a footnote above the housekeeping line.
    expect(out.indexOf("Restart your agent now")).toBeGreaterThan(
      out.indexOf("Change a key later"),
    );
  });
});
