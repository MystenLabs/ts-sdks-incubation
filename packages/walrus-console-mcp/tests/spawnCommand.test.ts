import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandInvocation, quoteCmdArgument, resolveWindowsCommand } from "../src/spawnCommand.js";

/**
 * On Windows `npm` (and every npm-installed agent CLI) is a `.cmd` batch file,
 * which `execFileSync(name)` cannot spawn (`spawnSync npm ENOENT`). These pin
 * how a command name becomes something Windows can actually run, without
 * changing what macOS and Linux do.
 */

/** A fake filesystem: only the listed paths exist (case-insensitively, like NTFS). */
const filesAt =
  (...paths: string[]) =>
  (p: string) =>
    paths.some((f) => f.toLowerCase() === p.toLowerCase());

/** The resolved path carries PATHEXT's casing (`.CMD`); Windows paths compare case-insensitively. */
const lower = (p: string | null | undefined) => p?.toLowerCase();

describe("commandInvocation off Windows", () => {
  it("spawns the bare name, exactly as before", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(commandInvocation("npm", ["install", "--prefix", "/a b"], { platform })).toEqual({
        file: "npm",
        args: ["install", "--prefix", "/a b"],
      });
    }
  });
});

describe("resolveWindowsCommand", () => {
  const env = {
    PATH: "C:\\Program Files\\nodejs;C:\\Users\\u\\AppData\\Roaming\\npm",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  };

  it("finds npm.cmd and skips the extensionless POSIX script beside it", () => {
    const isFile = filesAt("C:\\Program Files\\nodejs\\npm", "C:\\Program Files\\nodejs\\npm.cmd");

    expect(lower(resolveWindowsCommand("npm", { env, isFile }))).toBe(
      "c:\\program files\\nodejs\\npm.cmd",
    );
  });

  it("takes an absolute path with its own extension as-is", () => {
    const launcher =
      "C:\\Users\\A B\\AppData\\Local\\walrus-console-mcp\\node_modules\\.bin\\walrus-console-mcp.cmd";

    expect(resolveWindowsCommand(launcher, { env, isFile: filesAt(launcher) })).toBe(launcher);
    expect(resolveWindowsCommand(launcher, { env, isFile: () => false })).toBeNull();
  });

  it("follows PATH order and PATHEXT order", () => {
    const isFile = filesAt(
      "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd",
      "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.exe",
    );

    expect(lower(resolveWindowsCommand("claude", { env, isFile }))).toBe(
      "c:\\users\\u\\appdata\\roaming\\npm\\claude.exe",
    );
  });

  it("ignores relative PATH entries, so the working directory cannot shadow the command", () => {
    const isFile = filesAt(".\\npm.cmd", "C:\\Program Files\\nodejs\\npm.cmd");

    expect(
      lower(resolveWindowsCommand("npm", { env: { ...env, PATH: `.;${env.PATH}` }, isFile })),
    ).toBe("c:\\program files\\nodejs\\npm.cmd");
  });

  it("reads Path/PathExt case-insensitively, as Windows does", () => {
    const isFile = filesAt("C:\\tools\\gemini.cmd");

    expect(
      lower(
        resolveWindowsCommand("gemini", { env: { Path: '"C:\\tools"', PathExt: ".CMD" }, isFile }),
      ),
    ).toBe("c:\\tools\\gemini.cmd");
  });

  it("returns null when nothing on PATH matches", () => {
    expect(resolveWindowsCommand("codex", { env, isFile: () => false })).toBeNull();
  });
});

describe("commandInvocation on Windows", () => {
  const env = {
    PATH: "C:\\Program Files\\nodejs",
    PATHEXT: ".EXE;.CMD",
    ComSpec: "C:\\WINDOWS\\system32\\cmd.exe",
  };

  it("runs a batch file through cmd.exe with a verbatim, fully quoted command line", () => {
    const inv = commandInvocation("npm", ["install", "--prefix", "C:\\Users\\John & Co\\x"], {
      platform: "win32",
      env,
      isFile: filesAt("C:\\Program Files\\nodejs\\npm.cmd"),
    });

    expect(inv.file).toBe("C:\\WINDOWS\\system32\\cmd.exe");
    expect(inv.windowsVerbatimArguments).toBe(true);
    // /v:off: delayed expansion is forced off, so `!` is escaped for the mode it is parsed in.
    expect(inv.args.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
    const line = inv.args[4] ?? "";
    expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
    // No bare metacharacter survives: every `&` and space in an argument is escaped.
    expect(line).not.toMatch(/[^^]&/);
    expect(line.toLowerCase()).toContain("c:\\program^ files\\nodejs\\npm.cmd");
  });

  it("spawns a real executable directly, by absolute path", () => {
    const inv = commandInvocation("claude", ["mcp", "add"], {
      platform: "win32",
      env: { PATH: "C:\\bin", PATHEXT: ".exe;.cmd" },
      isFile: filesAt("C:\\bin\\claude.exe"),
    });

    expect(inv).toEqual({ file: "C:\\bin\\claude.exe", args: ["mcp", "add"] });
  });

  it("refuses an unresolvable name with ENOENT instead of letting Windows search the cwd", () => {
    let thrown: NodeJS.ErrnoException | undefined;
    try {
      commandInvocation("codex", ["mcp"], { platform: "win32", env, isFile: () => false });
    } catch (error) {
      thrown = error as NodeJS.ErrnoException;
    }

    expect(thrown?.code).toBe("ENOENT");
    expect(thrown?.message).toMatch(/"codex" was not found/);
  });

  it("names cmd.exe by absolute path when COMSPEC is missing or not fully qualified", () => {
    const isFile = filesAt("C:\\Program Files\\nodejs\\npm.cmd");
    for (const extra of [{}, { ComSpec: "cmd.exe" }, { ComSpec: "\\Windows\\cmd.exe" }]) {
      const inv = commandInvocation("npm", ["-v"], {
        platform: "win32",
        env: { PATH: env.PATH, PATHEXT: env.PATHEXT, SystemRoot: "D:\\Win", ...extra },
        isFile,
      });
      expect(inv.file).toBe("D:\\Win\\System32\\cmd.exe");
    }
  });

  it("falls back to C:\\Windows when SystemRoot is missing too", () => {
    const inv = commandInvocation("npm", ["-v"], {
      platform: "win32",
      env: { PATH: env.PATH, PATHEXT: env.PATHEXT },
      isFile: filesAt("C:\\Program Files\\nodejs\\npm.cmd"),
    });

    expect(inv.file).toBe("C:\\Windows\\System32\\cmd.exe");
  });
});

describe("resolveWindowsCommand edge cases", () => {
  it("skips a drive-relative PATH entry, which depends on the current drive", () => {
    const isFile = filesAt("\\tools\\npm.CMD", "C:\\Windows\\npm.CMD");

    expect(
      lower(resolveWindowsCommand("npm", { env: { PATH: "\\tools;C:\\Windows" }, isFile })),
    ).toBe("c:\\windows\\npm.cmd");
  });

  it("drops PATHEXT entries without a leading dot", () => {
    const isFile = filesAt("C:\\w\\npmEXE", "C:\\w\\npm.CMD");

    expect(
      lower(
        resolveWindowsCommand("npm", { env: { PATH: "C:\\w", PATHEXT: ".COM;EXE;.CMD" }, isFile }),
      ),
    ).toBe("c:\\w\\npm.cmd");
  });

  it("accepts a name that already carries a runnable extension, whatever PATHEXT says", () => {
    const launcher = "C:\\a\\node_modules\\.bin\\walrus-console-mcp.cmd";

    expect(
      resolveWindowsCommand(launcher, { env: { PATHEXT: ".EXE" }, isFile: filesAt(launcher) }),
    ).toBe(launcher);
    expect(
      resolveWindowsCommand("foo.exe", {
        env: { PATH: "C:\\bin", PATHEXT: "EXE" },
        isFile: filesAt("C:\\bin\\foo.exe"),
      }),
    ).toBe("C:\\bin\\foo.exe");
  });

  it("keeps a ';' inside a quoted PATH entry", () => {
    const isFile = filesAt("C:\\a;b\\bin\\npm.CMD");

    expect(
      lower(resolveWindowsCommand("npm", { env: { PATH: '"C:\\a;b\\bin";C:\\Windows' }, isFile })),
    ).toBe("c:\\a;b\\bin\\npm.cmd");
  });

  it("prefers the exact PATH spelling when an env object carries two", () => {
    const isFile = filesAt("C:\\evil\\npm.CMD", "C:\\good\\npm.CMD");

    expect(
      lower(resolveWindowsCommand("npm", { env: { Path: "C:\\evil", PATH: "C:\\good" }, isFile })),
    ).toBe("c:\\good\\npm.cmd");
  });
});

describe("quoteCmdArgument", () => {
  it("quotes and caret-escapes twice", () => {
    expect(quoteCmdArgument("a b")).toBe('^^^"a^^^ b^^^"');
    expect(quoteCmdArgument("a&b")).toBe('^^^"a^^^&b^^^"');
  });

  it("doubles backslashes only where they precede a quote", () => {
    expect(quoteCmdArgument("C:\\dir\\")).toBe('^^^"C:\\dir\\\\^^^"');
    expect(quoteCmdArgument('a\\"b')).toBe('^^^"a\\\\\\^^^"b^^^"');
  });

  it("refuses a line break or NUL instead of truncating the command", () => {
    expect(() => quoteCmdArgument("a\nb")).toThrow(/line break/);
    expect(() => quoteCmdArgument("a\0b")).toThrow(/NUL/);
  });
});

// The real thing: cmd.exe and a batch shim, on a Windows runner (CI's windows
// job). The shim has npm's own shape — `node "%~dp0\x.js" %*` — so what the
// recorder sees is exactly what npm-cli.js or an agent CLI would.
describe.runIf(process.platform === "win32")("round trip through cmd.exe (Windows)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus spawn & test "));
    fs.writeFileSync(
      path.join(dir, "record.cjs"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
    );
    fs.writeFileSync(path.join(dir, "fakeagent.cmd"), '@node "%~dp0\\record.cjs" %*\r\n');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("delivers every argument byte-for-byte", () => {
    const args = [
      "plain",
      "with space",
      "a&b|c>d<e",
      "C:\\Users\\John & Co (x)\\AppData\\Local\\walrus-console-mcp\\node_modules\\.bin\\walrus-console-mcp.cmd",
      "%PATH%",
      "^caret^",
      'quote"inside',
      "trailing\\",
      'back\\"slash',
      "!bang!",
      "semi;comma,eq=",
      "",
      "@mysten-incubation/walrus-console-mcp@0.1.0-beta.0",
    ];
    const env = { ...process.env, PATH: `${dir};${process.env["PATH"] ?? ""}` };

    const inv = commandInvocation("fakeagent", args, { env });
    // Spread: @types/node omits windowsVerbatimArguments from execFileSync's
    // options, though Node forwards it to spawnSync.
    const out = execFileSync(inv.file, inv.args, {
      env,
      encoding: "utf8",
      ...(inv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });

    expect(JSON.parse(out)).toEqual(args);
  });
});
