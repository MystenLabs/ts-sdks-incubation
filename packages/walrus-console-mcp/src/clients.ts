import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

/** The MCP server name registered with every client. Stays unversioned. */
export const SERVER_NAME = "walrus-console-mcp";

/**
 * A registerable agent. `detect()` reports whether it's installed;
 * `register(spec)` wires up the pinned launcher (throwing on failure);
 * `manualHint(spec)` is the copy-pasteable fallback shown if it fails or is
 * force-selected while undetected.
 */
export interface Client {
  id: string;
  label: string;
  detect: () => boolean;
  register: (spec: string) => void;
  manualHint: (spec: string) => string;
}

/** Runs a subprocess, throwing on non-zero exit. Injectable for tests. */
export type CommandRunner = (bin: string, args: string[]) => void;

const defaultRun: CommandRunner = (bin, args) => {
  execFileSync(bin, args, { stdio: "ignore" });
};

/**
 * Client registry for the installer's Register step.
 *
 * Each supported agent (Claude Desktop, Cursor, Claude Code, Codex, Gemini) is
 * modelled as a `Client`: it knows how to detect whether it's installed and how
 * to register the walrus-console-mcp stdio launcher with itself. Clients that
 * ship an `mcp add` CLI shell out to it; the rest merge a `mcpServers` entry
 * into a JSON config file.
 *
 * Credentials are never written here — they live in the shared config file from
 * Step 1. Registration only wires up how to *launch* the server.
 */

/** A single stdio MCP server entry, as it appears in a client's JSON config. */
export interface McpServerEntry {
  command: string;
  args: string[];
}

/** A client config file that carries an `mcpServers` map (plus other keys). */
export interface McpConfig extends Record<string, unknown> {
  mcpServers: Record<string, McpServerEntry>;
}

/**
 * Return a copy of `config` with our pinned stdio launcher upserted under
 * `mcpServers[name]`. Existing servers and unrelated top-level keys are
 * preserved; a stale entry for the same name is overwritten.
 */
export function upsertMcpServer(
  config: Record<string, unknown>,
  name: string,
  spec: string,
): McpConfig {
  const existing = (config as { mcpServers?: Record<string, McpServerEntry> }).mcpServers ?? {};
  const mcpServers: Record<string, McpServerEntry> = {
    ...existing,
    [name]: { command: "npx", args: ["-y", spec] },
  };
  return { ...config, mcpServers };
}

/**
 * Static definition of a CLI-based client (one that ships its own `mcp add`).
 * `addArgs`/`removeArgs` build the argv passed to `bin`, excluding `bin` itself.
 * The three supported CLIs differ (Claude Code and Codex use a `--` separator
 * before the launch command; Gemini does not; only Claude Code and Gemini take
 * a `--scope` flag), so each carries its own builders.
 */
export interface CliClientSpec {
  id: string;
  label: string;
  /** Executable name looked up on PATH. */
  bin: string;
  addArgs: (name: string, spec: string) => string[];
  removeArgs: (name: string) => string[];
}

const NPX = ["npx", "-y"];

export const CLI_CLIENT_SPECS: CliClientSpec[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    bin: "claude",
    addArgs: (name, spec) => ["mcp", "add", "--scope", "user", name, "--", ...NPX, spec],
    removeArgs: (name) => ["mcp", "remove", "--scope", "user", name],
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    addArgs: (name, spec) => ["mcp", "add", name, "--", ...NPX, spec],
    removeArgs: (name) => ["mcp", "remove", name],
  },
  {
    id: "gemini",
    label: "Gemini",
    bin: "gemini",
    // Gemini's `mcp add` takes the command + args directly, with NO `--` separator.
    addArgs: (name, spec) => ["mcp", "add", "--scope", "user", name, ...NPX, spec],
    removeArgs: (name) => ["mcp", "remove", "--scope", "user", name],
  },
];

/**
 * Build a `Client` that registers via a client's own `mcp add` CLI. For
 * idempotency it runs a best-effort remove (swallowing failure — the server may
 * simply not be registered yet) before the add, so re-running never duplicates
 * or errors on "already exists".
 */
export function cliClient(
  spec: CliClientSpec,
  opts: { run?: CommandRunner; detect?: () => boolean } = {},
): Client {
  const run = opts.run ?? defaultRun;
  return {
    id: spec.id,
    label: spec.label,
    detect: opts.detect ?? (() => commandExists(spec.bin)),
    register(pkgSpec) {
      try {
        run(spec.bin, spec.removeArgs(SERVER_NAME));
      } catch {
        // not registered yet — nothing to remove
      }
      run(spec.bin, spec.addArgs(SERVER_NAME, pkgSpec));
    },
    manualHint(pkgSpec) {
      return `${spec.bin} ${spec.addArgs(SERVER_NAME, pkgSpec).join(" ")}`;
    },
  };
}

/**
 * Build a `Client` that registers by merging our `mcpServers` entry into a JSON
 * config file (for clients without an `mcp add` CLI). Preserves existing
 * servers and other keys; creates the parent directory as needed.
 */
export function jsonFileClient(opts: {
  id: string;
  label: string;
  /** Resolve the client's config path, or null if this platform is unsupported. */
  configPath: () => string | null;
  detect: () => boolean;
}): Client {
  const readConfig = (p: string): Record<string, unknown> => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  return {
    id: opts.id,
    label: opts.label,
    detect: opts.detect,
    register(pkgSpec) {
      const configPath = opts.configPath();
      if (!configPath) {
        throw new Error(`${opts.label} is not supported on this platform`);
      }
      const merged = upsertMcpServer(readConfig(configPath), SERVER_NAME, pkgSpec);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
    },
    manualHint() {
      const configPath = opts.configPath();
      return `add "${SERVER_NAME}" to ${configPath ?? "the client's mcp config"}`;
    },
  };
}

/** One row in the interactive register checklist. */
export interface ChecklistItem {
  label: string;
  checked: boolean;
  detected: boolean;
}

/**
 * Render the checklist as plain lines (no ANSI): a cursor marker, the checkbox
 * state, the label (padded for alignment), and a found/not-found tag. Pure so
 * it can be unit-tested; the interactive loop handles cursor movement + color.
 */
export function renderChecklistLines(items: ChecklistItem[], cursor: number): string[] {
  const width = Math.max(0, ...items.map((it) => it.label.length));
  return items.map((it, i) => {
    const marker = i === cursor ? "›" : " ";
    const box = it.checked ? "x" : " ";
    const tag = it.detected ? "found" : "not found";
    return `${marker} [${box}] ${it.label.padEnd(width)}  ${tag}`;
  });
}

/** A readable input that may be a raw-capable TTY (process.stdin or a mock). */
type KeyInput = NodeJS.EventEmitter & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
  resume?: () => void;
  pause?: () => void;
};

interface SelectClientsOptions {
  input?: KeyInput;
  output?: NodeJS.WritableStream;
  /** Force interactive mode; defaults to output.isTTY. */
  isTTY?: boolean;
}

/**
 * Interactive tickbox: detect each client, present a checklist (detected ones
 * pre-ticked), and return the clients the user selected. Undetected clients are
 * shown but still tickable to force-register.
 *
 * Non-TTY (CI, pipes, tests without `isTTY`): skips the UI and returns exactly
 * the detected clients — matching the default tick state. Returns `null` if the
 * user cancels (Ctrl-C / Esc).
 */
export function selectClients(
  clients: Client[],
  opts: SelectClientsOptions = {},
): Promise<Client[] | null> {
  const input: KeyInput = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const isTTY = opts.isTTY ?? (output as { isTTY?: boolean }).isTTY === true;

  const state = clients.map((client) => {
    const detected = client.detect();
    return { client, detected, checked: detected };
  });

  if (!isTTY) {
    return Promise.resolve(state.filter((s) => s.checked).map((s) => s.client));
  }

  return new Promise((resolve) => {
    let cursor = 0;
    let rendered = 0;

    const render = () => {
      if (rendered > 0) output.write(`\x1b[${rendered}A`);
      const lines = renderChecklistLines(
        state.map((s) => ({ label: s.client.label, checked: s.checked, detected: s.detected })),
        cursor,
      );
      for (const l of lines) output.write(`\x1b[2K${l}\n`);
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
      switch (key.name) {
        case "escape":
          cleanup();
          resolve(null);
          return;
        case "up":
        case "k":
          cursor = (cursor - 1 + state.length) % state.length;
          break;
        case "down":
        case "j":
          cursor = (cursor + 1) % state.length;
          break;
        case "space": {
          const cur = state[cursor];
          if (cur) cur.checked = !cur.checked;
          break;
        }
        case "a": {
          const allOn = state.every((s) => s.checked);
          for (const s of state) s.checked = !allOn;
          break;
        }
        case "return":
        case "enter":
          cleanup();
          resolve(state.filter((s) => s.checked).map((s) => s.client));
          return;
        default:
          return;
      }
      render();
    };

    input.on("keypress", onKey);
    render();
  });
}

/** True if `p` exists and is a directory. Used to detect file-based clients. */
export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Platform-specific path to Claude Desktop's config, or null if unsupported. */
export function claudeDesktopConfigPath(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string | null {
  if (platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (platform === "win32") {
    const { APPDATA } = process.env;
    const appData = APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  if (platform === "linux") {
    return path.join(home, ".config", "Claude", "claude_desktop_config.json");
  }
  return null;
}

/** Path to Cursor's global MCP config (`~/.cursor/mcp.json`) on every platform. */
export function cursorConfigPath(
  _platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  return path.join(home, ".cursor", "mcp.json");
}

/**
 * The full client registry, in checklist order. CLI clients shell out to their
 * own `mcp add`; Claude Desktop and Cursor merge a JSON config file.
 */
export function getClients(opts: { run?: CommandRunner } = {}): Client[] {
  const cli = (id: string): Client => {
    const spec = CLI_CLIENT_SPECS.find((s) => s.id === id);
    if (!spec) throw new Error(`unknown CLI client: ${id}`);
    return cliClient(spec, opts.run ? { run: opts.run } : {});
  };
  return [
    cli("claude-code"),
    jsonFileClient({
      id: "claude-desktop",
      label: "Claude Desktop",
      configPath: () => claudeDesktopConfigPath(),
      detect: () => {
        const p = claudeDesktopConfigPath();
        return p != null && dirExists(path.dirname(p));
      },
    }),
    jsonFileClient({
      id: "cursor",
      label: "Cursor",
      configPath: () => cursorConfigPath(),
      detect: () => dirExists(path.dirname(cursorConfigPath())),
    }),
    cli("codex"),
    cli("gemini"),
  ];
}

interface CommandExistsOptions {
  /** PATH string to scan; defaults to process.env.PATH. */
  path?: string;
  /** Platform override; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Windows PATHEXT override; defaults to process.env.PATHEXT. */
  pathext?: string;
}

/**
 * Return true if `bin` resolves to an executable file on PATH. Pure lookup —
 * no subprocess is spawned. On Windows, tries each PATHEXT extension so a bare
 * name like `gemini` matches `gemini.CMD`. Options are injectable for testing.
 */
export function commandExists(bin: string, opts: CommandExistsOptions = {}): boolean {
  const { PATH, PATHEXT } = process.env;
  const platform = opts.platform ?? process.platform;
  const pathValue = opts.path ?? PATH ?? "";
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  if (dirs.length === 0) return false;

  const exts =
    platform === "win32"
      ? ["", ...(opts.pathext ?? PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)]
      : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, bin + ext)).isFile()) return true;
      } catch {
        // not in this dir; keep looking
      }
    }
  }
  return false;
}
