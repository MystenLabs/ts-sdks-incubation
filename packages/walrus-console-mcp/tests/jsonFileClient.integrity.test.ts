import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonFileClient, SERVER_NAME } from "../src/clients.js";

// jsonFileClient writes a config file another application owns (Cursor's
// mcp.json, Antigravity's mcp_config.json). These tests run against real files
// in a temp dir: the symlink cases use real symlinks, and the race cases land a
// real competing write inside the real read→rename window, through the
// `onTempCreated` seam that fires after our temp is fsync'd and before publish.

const LAUNCHER = "/opt/walrus-console-mcp/node_modules/.bin/walrus-console-mcp";
const posixOnly = it.skipIf(process.platform === "win32");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "walrus-jsonfile-integrity-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf-8"));
const writeJson = (p: string, v: unknown) => fs.writeFileSync(p, JSON.stringify(v));
const OTHER = { mcpServers: { other: { command: "other-bin", args: [] } } };

function clientAt(configPath: string, extra: Partial<Parameters<typeof jsonFileClient>[0]> = {}) {
  return jsonFileClient({
    id: "cursor",
    label: "Cursor",
    configPath: () => configPath,
    detect: () => true,
    ...extra,
  });
}

/** Temp files our writer leaves behind, if any. */
const strayTemps = (dir: string) =>
  fs.readdirSync(dir).filter((n) => n.startsWith(".walrus-console-mcp."));

describe("jsonFileClient — a symlinked config (dotfiles-style)", () => {
  posixOnly("writes through the link to its target and keeps the link", () => {
    const dotfiles = path.join(tmpDir, "dotfiles");
    fs.mkdirSync(dotfiles);
    const target = path.join(dotfiles, "mcp.json");
    writeJson(target, OTHER);
    fs.chmodSync(target, 0o640);
    const link = path.join(tmpDir, "cfg", "mcp.json");
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(target, link);

    clientAt(link).register(LAUNCHER);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(target);
    const cfg = readJson(target);
    expect(cfg.mcpServers[SERVER_NAME]).toEqual({ command: LAUNCHER, args: [] });
    expect(cfg.mcpServers.other).toEqual(OTHER.mcpServers.other);
    // The target's mode is its owner's choice; the write must not change it.
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    // The temp goes next to the target (same filesystem), and is gone.
    expect(strayTemps(dotfiles)).toEqual([]);
    expect(strayTemps(path.dirname(link))).toEqual([]);
  });

  posixOnly("follows a chain of links, including a relative one", () => {
    const target = path.join(tmpDir, "real.json");
    writeJson(target, OTHER);
    const mid = path.join(tmpDir, "mid.json");
    fs.symlinkSync("real.json", mid); // relative
    const link = path.join(tmpDir, "mcp.json");
    fs.symlinkSync(mid, link);

    clientAt(link).register(LAUNCHER);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(mid).isSymbolicLink()).toBe(true);
    expect(readJson(target).mcpServers[SERVER_NAME].command).toBe(LAUNCHER);
  });

  posixOnly("refuses a dangling link and creates nothing", () => {
    const missing = path.join(tmpDir, "dotfiles", "mcp.json");
    const link = path.join(tmpDir, "mcp.json");
    fs.symlinkSync(missing, link);

    expect(() => clientAt(link).register(LAUNCHER)).toThrow(/symlink.*does not resolve/i);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.dirname(missing))).toBe(false);
  });

  posixOnly("refuses a link loop", () => {
    const a = path.join(tmpDir, "a.json");
    const b = path.join(tmpDir, "b.json");
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);

    expect(() => clientAt(a).register(LAUNCHER)).toThrow(/symlink.*does not resolve/i);
  });

  posixOnly("refuses a link to a directory", () => {
    const dir = path.join(tmpDir, "somedir");
    fs.mkdirSync(dir);
    const link = path.join(tmpDir, "mcp.json");
    fs.symlinkSync(dir, link);

    expect(() => clientAt(link).register(LAUNCHER)).toThrow(/not a regular file/i);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("jsonFileClient — the link is repointed while we write", () => {
  posixOnly("re-merges into the new target instead of publishing to the old one", () => {
    const first = path.join(tmpDir, "first.json");
    const second = path.join(tmpDir, "second.json");
    writeJson(first, OTHER);
    writeJson(second, { mcpServers: { secondOnly: { command: "s", args: [] } } });
    const link = path.join(tmpDir, "mcp.json");
    fs.symlinkSync(first, link);
    let injected = 0;
    const client = clientAt(link, {
      onTempCreated: () => {
        if (injected++ > 0) return;
        fs.rmSync(link);
        fs.symlinkSync(second, link); // the dotfiles manager switches profiles
      },
    });

    client.register(LAUNCHER);

    expect(readJson(first)).toEqual(OTHER);
    const cfg = readJson(second);
    expect(cfg.mcpServers.secondOnly).toEqual({ command: "s", args: [] });
    expect(cfg.mcpServers[SERVER_NAME].command).toBe(LAUNCHER);
  });
});

describe("jsonFileClient — a config that is not a regular file", () => {
  // readFileSync on a FIFO blocks until a writer opens it, which hung the
  // installer forever. The default 5s test timeout is the hang detector here.
  posixOnly("refuses a FIFO promptly instead of blocking on the read", () => {
    const fifo = path.join(tmpDir, "mcp.json");
    execFileSync("mkfifo", [fifo]);

    expect(() => clientAt(fifo).register(LAUNCHER)).toThrow(/not a regular file/i);
    expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
  });

  it("refuses a directory at the config path", () => {
    const dir = path.join(tmpDir, "mcp.json");
    fs.mkdirSync(dir);

    expect(() => clientAt(dir).register(LAUNCHER)).toThrow(/not a regular file/i);
  });
});

describe("jsonFileClient — another writer saves inside our read→publish window", () => {
  it("re-merges from the other writer's version instead of overwriting it", () => {
    const cfgPath = path.join(tmpDir, "mcp.json");
    writeJson(cfgPath, OTHER);
    let injected = 0;
    const client = clientAt(cfgPath, {
      onTempCreated: () => {
        if (injected++ > 0) return;
        const cur = readJson(cfgPath);
        cur.mcpServers.appAdded = { command: "app", args: [] };
        cur.theme = "dark";
        writeJson(cfgPath, cur); // the app's save, after our read
      },
    });

    client.register(LAUNCHER);

    const cfg = readJson(cfgPath);
    expect(injected).toBe(2); // a second attempt ran, and only it published
    expect(cfg.mcpServers.appAdded).toEqual({ command: "app", args: [] });
    expect(cfg.theme).toBe("dark");
    expect(cfg.mcpServers.other).toEqual(OTHER.mcpServers.other);
    expect(cfg.mcpServers[SERVER_NAME]).toEqual({ command: LAUNCHER, args: [] });
    expect(strayTemps(tmpDir)).toEqual([]);
  });

  it("treats the file appearing after a missing read as a change", () => {
    const cfgPath = path.join(tmpDir, "mcp.json");
    let injected = 0;
    const client = clientAt(cfgPath, {
      onTempCreated: () => {
        if (injected++ === 0) writeJson(cfgPath, OTHER);
      },
    });

    client.register(LAUNCHER);

    const cfg = readJson(cfgPath);
    expect(cfg.mcpServers.other).toEqual(OTHER.mcpServers.other);
    expect(cfg.mcpServers[SERVER_NAME].command).toBe(LAUNCHER);
  });

  it("treats the file being deleted inside the window as a change", () => {
    const cfgPath = path.join(tmpDir, "mcp.json");
    writeJson(cfgPath, { ...OTHER, stale: true });
    let injected = 0;
    const client = clientAt(cfgPath, {
      onTempCreated: () => {
        if (injected++ === 0) fs.rmSync(cfgPath);
      },
    });

    client.register(LAUNCHER);

    // The second attempt merged into what was actually there: nothing.
    expect(readJson(cfgPath)).toEqual({
      mcpServers: { [SERVER_NAME]: { command: LAUNCHER, args: [] } },
    });
  });

  it("gives up after repeated changes, leaving the other writer's version and no temps", () => {
    const cfgPath = path.join(tmpDir, "mcp.json");
    writeJson(cfgPath, OTHER);
    let n = 0;
    const client = clientAt(cfgPath, {
      onTempCreated: () => {
        n++;
        writeJson(cfgPath, { ...OTHER, appRevision: n });
      },
    });

    expect(() => client.register(LAUNCHER)).toThrow(/kept changing/i);

    expect(n).toBe(3);
    const cfg = readJson(cfgPath);
    expect(cfg).toEqual({ ...OTHER, appRevision: 3 });
    expect(cfg.mcpServers[SERVER_NAME]).toBeUndefined();
    expect(strayTemps(tmpDir)).toEqual([]);
  });

  it("publishes on the first attempt when nothing else writes", () => {
    const cfgPath = path.join(tmpDir, "mcp.json");
    writeJson(cfgPath, OTHER);
    let attempts = 0;
    clientAt(cfgPath, { onTempCreated: () => attempts++ }).register(LAUNCHER);
    expect(attempts).toBe(1);
  });
});

describe("jsonFileClient.verify — is our entry still there after the other clients ran?", () => {
  it("is clean right after a register", () => {
    const cfgPath = path.join(tmpDir, "mcp.json");
    const client = clientAt(cfgPath);
    client.register(LAUNCHER);
    expect(client.verify?.(LAUNCHER)).toBeUndefined();
  });

  it("reports an entry an app's stale save wrote over", () => {
    const cfgPath = path.join(tmpDir, "mcp.json");
    writeJson(cfgPath, OTHER);
    const client = clientAt(cfgPath);
    client.register(LAUNCHER);
    writeJson(cfgPath, OTHER); // the app saves the settings it loaded before we wrote

    expect(client.verify?.(LAUNCHER)).toMatch(/no longer/i);
  });

  it("reports an entry now pointing at a different launcher", () => {
    const cfgPath = path.join(tmpDir, "mcp.json");
    const client = clientAt(cfgPath);
    client.register(LAUNCHER);
    writeJson(cfgPath, { mcpServers: { [SERVER_NAME]: { command: "/old/launcher", args: [] } } });

    expect(client.verify?.(LAUNCHER)).toMatch(/no longer/i);
  });

  it("accepts the app's own normalisation of our entry", () => {
    // agy rewrites the file with sorted keys, drops an empty `args` and adds
    // `disabled: false`. That is our entry, kept; not a lost write.
    const cfgPath = path.join(tmpDir, "mcp.json");
    const client = clientAt(cfgPath);
    client.register(LAUNCHER);
    writeJson(cfgPath, { mcpServers: { [SERVER_NAME]: { command: LAUNCHER, disabled: false } } });

    expect(client.verify?.(LAUNCHER)).toBeUndefined();
  });

  it("reports an entry whose launch arguments were changed", () => {
    const cfgPath = path.join(tmpDir, "mcp.json");
    const client = clientAt(cfgPath);
    client.register(LAUNCHER);
    writeJson(cfgPath, {
      mcpServers: { [SERVER_NAME]: { command: LAUNCHER, args: ["--something-else"] } },
    });

    expect(client.verify?.(LAUNCHER)).toMatch(/no longer/i);
  });

  it("reports an unreadable or unparseable file rather than throwing", () => {
    const cfgPath = path.join(tmpDir, "mcp.json");
    const client = clientAt(cfgPath);
    client.register(LAUNCHER);
    fs.writeFileSync(cfgPath, "{ half-written");
    expect(client.verify?.(LAUNCHER)).toMatch(/could not be read back/i);
    fs.rmSync(cfgPath);
    expect(client.verify?.(LAUNCHER)).toMatch(/could not be read back|no longer/i);
  });

  posixOnly("reads back through a symlinked config", () => {
    const target = path.join(tmpDir, "real.json");
    writeJson(target, OTHER);
    const link = path.join(tmpDir, "mcp.json");
    fs.symlinkSync(target, link);
    const client = clientAt(link);
    client.register(LAUNCHER);
    expect(client.verify?.(LAUNCHER)).toBeUndefined();
  });
});
