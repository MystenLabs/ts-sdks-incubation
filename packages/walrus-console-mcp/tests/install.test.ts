import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getPackageVersion,
  isValidServiceKeyFormat,
  MASK_WIDTH,
  PACKAGE_NAME,
  maskedLine,
  maskedPanelLine,
  packageSpec,
  promptMasked,
  resolveInstallBaseUrl,
  visibleWidth,
} from "../bin/install.js";
import { DEFAULT_CONSOLE_API_BASE_URL } from "../src/baseUrl.js";
import { saveConfigFile } from "../src/configFile.js";
import { panelWidth } from "../src/tui.js";

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

  it("falls back to the testnet default when nothing is set", () => {
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
