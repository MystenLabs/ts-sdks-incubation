import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { styleText } from "node:util";
import { writeFileAtomic } from "./atomicWrite.js";
import { toRealPath } from "./pathSandbox.js";
import { runCommand } from "./spawnCommand.js";
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
  /** Printed after a successful `register`, for clients that need a manual reload. */
  nextStep?: string;
  /**
   * Re-check, some time after `register`, that the entry is still there.
   * Returns why not, or `undefined` when it is. For clients whose config another
   * application also writes: a save from settings it loaded before we wrote
   * drops our entry without any error on our side.
   */
  verify?: (command: string) => string | undefined;
}

/** Runs a subprocess, throwing on non-zero exit. Injectable for tests. */
export type CommandRunner = (bin: string, args: string[]) => void;

// runCommand, not execFileSync: an npm-installed `claude`/`codex`/`gemini` is a
// `.cmd` shim on Windows, which a bare execFileSync cannot spawn.
const defaultRun: CommandRunner = (bin, args) => {
  runCommand(bin, args, { stdio: "ignore" });
};

/**
 * Client registry for the installer's Register step.
 *
 * Each supported agent (Claude Code, Cursor, Codex, Gemini, Antigravity) is modelled as a
 * `Client`: it knows how to detect whether it's installed and how to register
 * the walrus-console-mcp stdio launcher with itself. Clients that ship an
 * `mcp add` CLI shell out to it; Cursor and Antigravity, which do not (or
 * whose CLI we deliberately avoid), get a `mcpServers` entry merged into their
 * JSON config file.
 *
 * Claude Desktop is deliberately absent (COMG-1133): it is set up by hand (see
 * the README's "Claude Desktop" section) until the `.mcpb` desktop extension
 * (COMG-851) is published.
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

/** How many times `register` re-merges after another writer changed the file. */
const MAX_MERGE_ATTEMPTS = 3;

/** Thrown by the pre-publish check when the file changed after it was read. */
class ConfigChangedError extends Error {}

/**
 * Build a `Client` that registers by merging our `mcpServers` entry into a JSON
 * config file (for clients without an `mcp add` CLI). Preserves existing
 * servers and other keys; creates the parent directory as needed.
 *
 * The file belongs to another application, which may be running, so three
 * things are handled beyond the merge itself:
 *
 *  - **A symlinked config** (a dotfiles manager) is written through to its
 *    target. Renaming over the link would replace it with a regular file and
 *    fork the user's config from its source. A link that does not resolve is
 *    refused rather than guessed at.
 *  - **Only a regular file is read.** A FIFO at the path would block the read
 *    forever; anything else would be replaced by our rename.
 *  - **Another writer saving between our read and our rename** would have its
 *    save silently undone. Just before publishing (`writeFileAtomic`'s
 *    `precondition`, which says what it cannot close) the file is read again;
 *    if it changed, the merge is redone from the new version, up to
 *    `MAX_MERGE_ATTEMPTS` times. A lock would not help: the other writer never
 *    takes ours. `verify` checks for the other direction, the app saving older
 *    settings over us.
 */
export function jsonFileClient(opts: {
  id: string;
  label: string;
  /** Resolve the client's config path. */
  configPath: () => string;
  detect: () => boolean;
  /**
   * Read a config file as UTF-8. Defaults to `fs.readFileSync`; injectable so a
   * test can drive the unreadable-file path deterministically instead of relying
   * on `chmod 000` (which a root/Windows test runner reads straight through).
   */
  readFile?: (p: string) => string;
  /**
   * Test seam, passed to `writeFileAtomic`: runs after the replacement is
   * written and before the pre-publish check, so a test can land a competing
   * write inside the real window.
   */
  onTempCreated?: (tmpPath: string) => void;
}): Client {
  const readFile = opts.readFile ?? ((p: string) => fs.readFileSync(p, "utf-8"));

  const unreadable = (p: string, err: unknown) =>
    new Error(
      `${opts.label}'s config at ${p} could not be read (${(err as Error).message}). ` +
        `Fix the file's permissions and re-run, or add the entry manually.`,
    );

  /**
   * The file to read and replace: `configPath` with any symlinks resolved, so a
   * linked config is written through rather than replaced. Must be a regular
   * file, or not exist yet.
   */
  const resolveTarget = (configPath: string): string => {
    let target: string;
    try {
      target = toRealPath(configPath);
    } catch (err) {
      throw new Error(
        `${opts.label}'s config at ${configPath} is a symlink that does not resolve ` +
          `(${(err as Error).message}). Refusing to replace the link — add the entry manually.`,
      );
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return target;
      throw unreadable(target, err);
    }
    if (!stat.isFile()) {
      throw new Error(
        `${opts.label}'s config at ${target} is not a regular file. Refusing to read or ` +
          `replace it — add the entry manually.`,
      );
    }
    return target;
  };

  /** The file's raw text, or `undefined` if it does not exist. */
  const readRaw = (p: string): string | undefined => {
    try {
      return readFile(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw unreadable(p, err);
    }
  };

  /**
   * Parse the client's existing config, or `{}` if there is genuinely nothing
   * there.
   *
   * ONLY a missing file counts as empty. A catch-all here is a data-loss bug:
   * registering writes the whole file back, so one unparseable byte — or a
   * permissions problem, or a file being written concurrently — would turn into a
   * silent wipe of every setting the client keeps, ours and theirs alike.
   * Refusing leaves the file untouched and says why.
   */
  const parseConfig = (p: string, raw: string | undefined): Record<string, unknown> => {
    if (raw === undefined) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${opts.label}'s config at ${p} could not be parsed as JSON (${(err as Error).message}). ` +
          `Refusing to overwrite it — repair the file and re-run, or add the entry manually.`,
      );
    }
    // Valid JSON is not necessarily a config object. Only a missing file can
    // be initialized; replacing an existing non-object would discard its bytes.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `${opts.label}'s config at ${p} has a top-level JSON value that is not an object. ` +
          `Refusing to overwrite it — repair the file and re-run, or add the entry manually.`,
      );
    }
    const config = parsed as Record<string, unknown>;
    // A non-object `mcpServers` would be spread key by key (a string becomes
    // {"0": …, "1": …}), corrupting a key the client owns. Refuse, as for bad JSON.
    const servers = config["mcpServers"];
    if (
      servers !== undefined &&
      (servers === null || typeof servers !== "object" || Array.isArray(servers))
    ) {
      throw new Error(
        `${opts.label}'s config at ${p} has an "mcpServers" value that is not an object. ` +
          `Refusing to overwrite it — repair the file and re-run, or add the entry manually.`,
      );
    }
    return config;
  };

  return {
    id: opts.id,
    label: opts.label,
    detect: opts.detect,
    register(command) {
      const configPath = opts.configPath();
      for (let attempt = 1; attempt <= MAX_MERGE_ATTEMPTS; attempt++) {
        const target = resolveTarget(configPath);
        const raw = readRaw(target);
        const merged = upsertMcpServer(parseConfig(target, raw), SERVER_NAME, command);
        try {
          // Atomic replacement: a direct write can truncate the target and then
          // fail (full disk, SIGTERM, competing writer), leaving the user with an
          // empty or half-written config for an application that is not ours.
          writeFileAtomic(target, `${JSON.stringify(merged, null, 2)}\n`, {
            mode: 0o600,
            mkdirMode: 0o700,
            // Their file, their mode.
            preserveExistingMode: true,
            ...(opts.onTempCreated ? { onTempCreated: opts.onTempCreated } : {}),
            precondition: () => {
              // A repointed link would leave us publishing to a file it no longer names.
              if (resolveTarget(configPath) !== target || readRaw(target) !== raw) {
                throw new ConfigChangedError();
              }
            },
          });
          return;
        } catch (err) {
          if (!(err instanceof ConfigChangedError)) throw err;
        }
      }
      throw new Error(
        `${opts.label}'s config at ${configPath} kept changing while it was being updated ` +
          `(${MAX_MERGE_ATTEMPTS} attempts). Nothing was written — close ${opts.label} and re-run.`,
      );
    },
    verify(command) {
      const configPath = opts.configPath();
      let entry: unknown;
      try {
        const target = resolveTarget(configPath);
        const servers = parseConfig(target, readRaw(target))["mcpServers"] as
          | Record<string, unknown>
          | undefined;
        entry = servers?.[SERVER_NAME];
      } catch (err) {
        return `${configPath} could not be read back (${(err as Error).message})`;
      }
      // An app's own rewrite may drop an empty `args` or add `disabled: false`;
      // that is our entry, kept. A different command or any argument is not.
      const { command: actual, args } = (entry ?? {}) as { command?: unknown; args?: unknown };
      const noArgs = args === undefined || (Array.isArray(args) && args.length === 0);
      return actual === command && noArgs
        ? undefined
        : `the "${SERVER_NAME}" entry in ${configPath} is no longer there, or no longer ` +
            `points at ${command} — ${opts.label} may have saved older settings over it`;
    },
    manualHint() {
      return `add "${SERVER_NAME}" to ${opts.configPath()}`;
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

  // `panelWidth`'s own default, not `?? 80`: a pty with no window size reports
  // `columns` as 0, and `0 ?? 80` is 0, which sizes the panel to nothing and
  // drops the frame, the title and the notice while every other panel in the
  // same run still frames at 72. Passing `undefined` through lets panelWidth
  // apply `|| 80` once, in one place.
  const width = panelWidth(opts.columns);
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

/** Path to Cursor's global MCP config (`~/.cursor/mcp.json`) on every platform. */
export function cursorConfigPath(
  _platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  return path.join(home, ".cursor", "mcp.json");
}

/**
 * Path to the MCP config shared by the Antigravity desktop app, IDE and `agy`
 * CLI (`~/.gemini/config/mcp_config.json`) on every platform; no env override.
 */
export function antigravityConfigPath(home: string = os.homedir()): string {
  return path.join(home, ".gemini", "config", "mcp_config.json");
}

/**
 * One entry for all three Antigravity surfaces, which read the same file.
 *
 * Found if any of the per-surface state dirs exists, or `agy` is on PATH. A bare
 * `~/.gemini` does not count: Gemini CLI owns that too.
 *
 * Register refuses until `~/.gemini/config/.migrated` exists: Antigravity's first
 * launch replaces the global config and would drop an entry written before it.
 * The check-then-write gap is accepted; the worst case is the entry being dropped
 * by that migration, which re-running the installer repairs.
 */
export function antigravityClient(opts: { home?: string; hasAgy?: () => boolean } = {}): Client {
  const home = opts.home ?? os.homedir();
  const hasAgy = opts.hasAgy ?? (() => commandExists("agy"));
  const base = jsonFileClient({
    id: "antigravity",
    label: "Antigravity",
    configPath: () => antigravityConfigPath(home),
    detect: () =>
      ["antigravity", "antigravity-cli", "antigravity-ide"].some((d) =>
        dirExists(path.join(home, ".gemini", d)),
      ) || hasAgy(),
  });
  const migrated = () =>
    fs.existsSync(path.join(path.dirname(antigravityConfigPath(home)), ".migrated"));
  return {
    ...base,
    register(command) {
      if (!migrated()) {
        throw new Error(
          "Antigravity hasn't finished its first start yet (~/.gemini/config/.migrated is missing), " +
            "so it would replace this entry. Open the Antigravity app or run `agy` once, then re-run the installer.",
        );
      }
      base.register(command);
    },
    // Printed straight after a refused register: before the migration a hand-written
    // entry is dropped too, so don't point at the file yet.
    manualHint: (command) =>
      migrated()
        ? base.manualHint(command)
        : "open the Antigravity app or run `agy` once, then re-run `walrus-console-mcp install`",
    nextStep:
      "In agy, open /mcp and reload; in the Antigravity app, press refresh under Installed MCP Servers. " +
      "Tools run in Ask mode until you allow them.",
  };
}

/**
 * The full client registry, in checklist order. CLI clients shell out to their
 * own `mcp add`; Cursor and Antigravity merge a JSON config file.
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
      id: "cursor",
      label: "Cursor",
      configPath: () => cursorConfigPath(),
      detect: () => dirExists(path.dirname(cursorConfigPath())),
    }),
    cli("codex"),
    cli("gemini"),
    antigravityClient(),
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
