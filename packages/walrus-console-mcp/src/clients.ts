import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { styleText } from "node:util";
import { writeFileAtomic } from "./atomicWrite.js";
import {
  hintLine,
  panelBottom,
  panelRow,
  panelTop,
  panelWidth,
  runSelector,
  type SelectorOptions,
} from "./tui.js";

/** The MCP server name registered with every client. Stays unversioned. */
export const SERVER_NAME = "walrus-console-mcp";

/**
 * A registerable agent. `detect()` reports whether it's installed;
 * `register(command)` wires up the launcher (throwing on failure);
 * `manualHint(command)` is the copy-pasteable fallback shown if it fails or is
 * force-selected while undetected.
 *
 * `command` is the ABSOLUTE path of the installed server launcher, not a package
 * spec — see `upsertMcpServer`.
 */
export interface Client {
  id: string;
  label: string;
  detect: () => boolean;
  register: (command: string) => void;
  manualHint: (command: string) => string;
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
 * Return a copy of `config` with our stdio launcher upserted under
 * `mcpServers[name]`. Existing servers and unrelated top-level keys are
 * preserved; a stale entry for the same name is overwritten.
 *
 * `command` is the ABSOLUTE path of the installed launcher, with no arguments.
 * It used to be `npx -y <spec>`, which resolves the package name against
 * whatever directory the agent was started in — so a project shipping a package
 * of the same name got launched under this server's identity, with access to the
 * saved Console credentials. Resolving once at install time and recording the
 * result leaves nothing to shadow. See src/installDir.ts.
 */
export function upsertMcpServer(
  config: Record<string, unknown>,
  name: string,
  command: string,
): McpConfig {
  const existing = (config as { mcpServers?: Record<string, McpServerEntry> }).mcpServers ?? {};
  const mcpServers: Record<string, McpServerEntry> = {
    ...existing,
    [name]: { command, args: [] },
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
  /** `command` is the absolute launcher path — never a package spec. */
  addArgs: (name: string, command: string) => string[];
  removeArgs: (name: string) => string[];
}

export const CLI_CLIENT_SPECS: CliClientSpec[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    bin: "claude",
    addArgs: (name, command) => ["mcp", "add", "--scope", "user", name, "--", command],
    removeArgs: (name) => ["mcp", "remove", "--scope", "user", name],
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    addArgs: (name, command) => ["mcp", "add", name, "--", command],
    removeArgs: (name) => ["mcp", "remove", name],
  },
  {
    id: "gemini",
    label: "Gemini",
    bin: "gemini",
    // Gemini's `mcp add` takes the command + args directly, with NO `--` separator.
    addArgs: (name, command) => ["mcp", "add", "--scope", "user", name, command],
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
    register(command) {
      try {
        run(spec.bin, spec.removeArgs(SERVER_NAME));
      } catch {
        // not registered yet — nothing to remove
      }
      run(spec.bin, spec.addArgs(SERVER_NAME, command));
    },
    manualHint(command) {
      return `${spec.bin} ${spec.addArgs(SERVER_NAME, command).join(" ")}`;
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
  /**
   * Read the client's existing config, or `{}` if there is genuinely nothing
   * there.
   *
   * ONLY a missing file counts as empty. A catch-all here is a data-loss bug:
   * registering writes the whole file back, so one unparseable byte — or a
   * permissions problem, or a file being written concurrently — would turn into a
   * silent wipe of every setting the client keeps, ours and theirs alike.
   * Refusing leaves the file untouched and says why.
   */
  const readConfig = (p: string): Record<string, unknown> => {
    let raw: string;
    try {
      raw = fs.readFileSync(p, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(
        `${opts.label}'s config at ${p} could not be read (${(err as Error).message}). ` +
          `Fix the file's permissions and re-run, or add the entry manually.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${opts.label}'s config at ${p} could not be parsed as JSON (${(err as Error).message}). ` +
          `Refusing to overwrite it — repair the file and re-run, or add the entry manually.`,
      );
    }
    // `null` and arrays are valid JSON but not config objects; spreading either
    // would produce nonsense rather than preserving anything.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  };
  return {
    id: opts.id,
    label: opts.label,
    detect: opts.detect,
    register(command) {
      const configPath = opts.configPath();
      if (!configPath) {
        throw new Error(`${opts.label} is not supported on this platform`);
      }
      const merged = upsertMcpServer(readConfig(configPath), SERVER_NAME, command);
      // Atomic replacement: a direct write can truncate the target and then fail
      // (full disk, SIGTERM, competing writer), leaving the user with an empty or
      // half-written config for an application that is not ours.
      //
      // Deliberately NOT lock-protected. A lock only helps if every writer takes
      // it, and the other writer here is a third-party client that has never heard
      // of ours — so a lockfile would clutter someone else's config directory
      // while closing nothing. The atomic rename is the part that actually holds.
      writeFileAtomic(configPath, `${JSON.stringify(merged, null, 2)}\n`, {
        mode: 0o600,
        mkdirMode: 0o700,
        // Their file, their mode.
        preserveExistingMode: true,
      });
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

/** Widest found/not-found tag, so the tags right-align into one column. */
export const TAG_WIDTH = "not found".length;

/**
 * Render the checklist as plain lines (no ANSI): a cursor marker, the checkbox
 * state, the label (padded for alignment), and a found/not-found tag. Pure so
 * it can be unit-tested; the interactive loop handles cursor movement + color.
 */
export function renderChecklistLines(items: ChecklistItem[], cursor: number): string[] {
  const width = Math.max(0, ...items.map((it) => it.label.length));
  return items.map((it, i) => {
    // Checkbox glyphs, not the radio ◉/○ the credential chooser uses: this list
    // takes any number of clients, and the marker should say so.
    const marker = i === cursor ? "❯" : " ";
    const box = it.checked ? "◼" : "◻";
    const tag = it.detected ? "found" : "not found";
    return `${marker} ${box}  ${it.label.padEnd(width)}  ${tag.padStart(TAG_WIDTH)}`;
  });
}

/**
 * Render the explicit confirm row under the checklist so confirming is an
 * obvious step (not just "enter"). Pure so it can be unit-tested. The four
 * spaces after the marker line the text up with the labels above it.
 */
export function renderConfirmLine(count: number, selected: boolean): string {
  const marker = selected ? "❯" : " ";
  const noun = count === 1 ? "agent" : "agents";
  return `${marker}    [ Configure ${count} ${noun} ]`;
}

interface SelectClientsOptions extends SelectorOptions {
  /** Panel title. Omitted renders bare rows with no frame. */
  title?: string;
  /** Step counter shown on the top rail, e.g. "3/3". */
  step?: string;
  /** Key hints drawn under the panel. */
  hint?: string;
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
  const output = opts.output ?? process.stdout;
  const isTTY = opts.isTTY ?? (output as { isTTY?: boolean }).isTTY === true;

  const state = clients.map((client) => {
    const detected = client.detect();
    return { client, detected, checked: detected };
  });

  if (!isTTY) {
    return Promise.resolve(state.filter((s) => s.checked).map((s) => s.client));
  }

  const width = panelWidth(opts.columns ?? process.stdout.columns ?? 80);
  const confirmIndex = state.length; // the confirm row sits after the client rows
  const total = state.length + 1;
  let cursor = 0;

  const chosen = () => state.filter((s) => s.checked).map((s) => s.client);

  /** The checklist rows and confirm row, before any panel is wrapped around them. */
  const body = (): string[] => {
    const rows = renderChecklistLines(
      state.map((s) => ({ label: s.client.label, checked: s.checked, detected: s.detected })),
      cursor, // when cursor === confirmIndex this is out of range → no client marked
    ).map((row, i) => {
      // The found/not-found tag is always the last TAG_WIDTH columns, so it can
      // be dimmed without the renderer having to hand back its position.
      const head = row.slice(0, -TAG_WIDTH);
      const tag = row.slice(-TAG_WIDTH);
      return `${i === cursor ? styleText("cyan", head) : head}${styleText("dim", tag)}`;
    });
    const onConfirm = cursor === confirmIndex;
    const confirmLine = renderConfirmLine(state.filter((s) => s.checked).length, onConfirm);
    return [
      ...rows,
      "",
      // Highlight the confirm row so it reads as an obvious action: reverse
      // video when focused, accent color otherwise.
      onConfirm ? styleText("inverse", confirmLine) : styleText("cyan", confirmLine),
    ];
  };

  const render = (): string[] => {
    const lines = body();
    if (!opts.title || width === null) return lines;
    return [
      panelTop(styleText("bold", opts.title), width, styleText("cyan", opts.step ?? "")),
      panelRow("", width),
      ...lines.map((l) => panelRow(l ? `  ${l}` : "", width)),
      panelRow("", width),
      panelBottom(width),
      ...(opts.hint ? [hintLine(opts.hint)] : []),
    ];
  };

  return runSelector<Client[]>(
    {
      render,
      onKey: (key) => {
        switch (key.name) {
          case "escape":
            return { cancel: true };
          case "up":
          case "k":
            cursor = (cursor - 1 + total) % total;
            return { redraw: true };
          case "down":
          case "j":
            cursor = (cursor + 1) % total;
            return { redraw: true };
          case "space":
          case "return":
          case "enter": {
            // Enter/space act on the focused row: toggle a client, or confirm when
            // on the confirm row. (No "Enter confirms from anywhere" — that
            // surprised users who pressed Enter expecting to toggle a checkbox.)
            if (cursor === confirmIndex) return { done: chosen() };
            const cur = state[cursor];
            if (cur) cur.checked = !cur.checked;
            return { redraw: true };
          }
          case "a": {
            const allOn = state.every((s) => s.checked);
            for (const s of state) s.checked = !allOn;
            return { redraw: true };
          }
          default:
            return undefined;
        }
      },
    },
    opts,
  );
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
