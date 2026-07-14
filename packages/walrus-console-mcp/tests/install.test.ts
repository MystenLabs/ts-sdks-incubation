import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getPackageVersion,
  isValidServiceKeyFormat,
  maskedLine,
  packageSpec,
  promptMasked,
} from "../bin/install.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-install-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("isValidServiceKeyFormat", () => {
  it("accepts a valid suiprivkey1 key", () => {
    expect(isValidServiceKeyFormat("suiprivkey1qqqqqqqqqqqqqqqqqqqqqq")).toBe(true);
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
});

describe("packageSpec", () => {
  it("pins the given version", () => {
    expect(packageSpec("1.2.3")).toBe("walrus-console-mcp@1.2.3");
  });

  it("falls back to the unpinned name when the version is unknown", () => {
    expect(packageSpec(null)).toBe("walrus-console-mcp");
  });

  it("reads this package's real version by default", () => {
    expect(packageSpec()).toMatch(/^walrus-console-mcp@\d+\.\d+\.\d+/);
  });
});

describe("getPackageVersion", () => {
  it("returns this package's semver-shaped version", () => {
    expect(getPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// Client detection + registration (Claude Desktop, Cursor, Claude Code, Codex,
// Gemini) lives in src/clients.ts and is covered by tests/clients.test.ts.
