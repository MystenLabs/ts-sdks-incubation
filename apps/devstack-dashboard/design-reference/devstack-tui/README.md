# Handoff: devstack TUI

## Overview

`devstack up` is a long-running CLI command that supervises a graph of background services (Sui localnet, Walrus aggregator/publisher, Seal key-server), build/publish steps (Move contracts, TypeScript codegen), and host processes (wallet server, frontend dev server) for a Web3 monorepo. While it runs, it renders a live, in-place terminal UI showing the state of every action, where each one's logs are going, and which URLs are now reachable.

This handoff covers the **TUI rendering layer** — what the user sees in the terminal while the supervisor is up. The reconciler / supervisor / action-runner is assumed to exist (or will be built separately); this design is purely concerned with how its events are presented.

## About the design files

The files in `prototype/` are an HTML/React prototype simulating the TUI in the browser. They are **a design reference, not production code** — the real implementation should be a Node CLI rendered with [Ink](https://github.com/vadimdemedes/ink) (React for terminals). Use the prototype as the source of truth for layout, colors, copy, typography, glyphs, and interaction behavior; do not port the JSX directly.

The prototype simulates a realistic action graph end-to-end (idle → queued → running → healthy / failed / skipped, with cascading failures and a shutdown lifecycle) so you can see how the UI behaves under every state without wiring up a real reconciler first.

The prototype runs entirely in the browser. Open `prototype/index.html` in any browser to see the design live; press keyboard shortcuts (Tab, r, s, f, q) to drive the simulation. The Tweaks toolbar exposes theme, density, border, and renderer-mode variants — these are exploration aids, not features that must ship.

## Fidelity

**High-fidelity.** Colors, typography scale, glyphs, and layout proportions are all final and should be reproduced as-shown. The information density, column widths, and spacing in the status table and log pane are intentional and tuned for an 80–140 column terminal.

The two areas where the developer should adapt rather than copy:

- The **HTML prototype uses CSS Grid for table-like alignment**. In Ink, use `<Box>` with fixed `width` (in characters) and `flexDirection="row"`. Translate `grid-template-columns: 2ch 32ch 12ch 10ch 1fr` to four sibling `<Box>` elements with widths `2`, `32`, `12`, `10`, and `flexGrow={1}`.
- **CSS colors map to chalk/Ink color names**, not hex. The exact mapping is in [Design tokens](#design-tokens) below.

## Target framework

- **Runtime**: Node 18+
- **Renderer**: [Ink](https://github.com/vadimdemedes/ink) v4+
- **Language**: TypeScript
- **Useful Ink components**: `<Static>` (for the supervisor banner that should scroll out), `<Box>`, `<Text>`, `useApp`, `useInput`, `useStdout`. Consider [`ink-spinner`](https://github.com/vadimdemedes/ink-spinner) and [`ink-link`](https://github.com/sindresorhus/ink-link) (or just rely on most modern terminals auto-linkifying URLs).
- **Plain mode fallback**: When `process.stdout.isTTY === false` or the env var `DEVSTACK_NO_TUI=1` is set, do **not** render Ink — emit one log line per state transition to stdout (see [Plain renderer](#plain-renderer-non-tty--ci)).

## Screens / views

There are two top-level views — one swap, in place. The chrome (Header + TabStrip + LogPane + Footer) stays mounted across both.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Header                                                                   │
├──────────────────────────────────────────────────────────────────────────┤
│ StatusTable        (or ShutdownPanel during shutdown)                    │
│   - per-scope group header                                               │
│   - one row per Action                                                   │
│   - inline endpoint URLs in healthy rows                                 │
├──────────────────────────────────────────────────────────────────────────┤
│ TabStrip:  [1] all   [2] supervisor                                      │
├──────────────────────────────────────────────────────────────────────────┤
│ LogPane (combined, color-coded by scope)                                 │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│ Footer (keybinding hints)                                                │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1. Header

One row, padded `8px 14px` (i.e. one blank line above and below; ~2 chars left padding in the terminal).

- **Left**: `devstack up` in bold, then `<appName> · <stack> · <network>` in dim color, separators are `·` (middle dot) in `--fg-mute` color.
- **Center-left** (appears only when sui-localnet is healthy): `rpc <url>` where the URL is in accent color.
- **Right**: rolling counts in this exact format:
  `<healthy>/<total> healthy · <running> running · <failed> failed · uptime <Xs|Xm0Ys>`
  - `<healthy>` count in `--ok` (green), `<running>` count in `--accent` (blue), `<failed>` count in `--err` (red).
  - "running" and "failed" segments are omitted entirely when their count is zero.
  - Uptime updates every second.

### 2. StatusTable

A small section title (`actions` in dim uppercase, with a subtle dashed bottom border), then groups of rows.

#### Group header

Renders once per scope. Format:
```
SUI ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  3/3 · 1 running
```
- Left label: scope name in **uppercase**, bold (600), letter-spaced ~`0.1em`, in the **scope color** (see palette).
- Middle: dashed rule that fills available width, also tinted to the scope color but at ~20% alpha (in Ink, just use a dimmer variant of the same color, or `gray`).
- Right: `<healthy>/<total>` then optional `· N running` (accent) and `· N failed` (red), each only when nonzero.

#### Row

Five columns, character-aligned:

| Col | Width | Contents |
|---|---|---|
| 1 | 2ch | Status glyph |
| 2 | 32ch | Type glyph + space + action name |
| 3 | 12ch | Status label (lowercase word: `running`, `healthy`, etc.) |
| 4 | 10ch | Duration: `+1.2s` while running, `4.2s` when settled, `queued` for queued, blank otherwise. Tabular numerals. |
| 5 | flex (1) | Detail — context-dependent |

Detail column rules (mutually exclusive, in priority order):

1. If failure → `— <err.message>` in red.
2. If status is `idle` → `waiting on <comma-sep dep names>` in dim.
3. If status is `queued` → `deps satisfied · scheduling` in dim.
4. If status is `skipped` → `— skipped (upstream failed)` in dim.
5. If status is `stale` → `— inputs changed` in amber.
6. If status is `healthy` AND the action exposes endpoints → render each endpoint as `<label> <url>`, separated by ` · `. The URL is the accent color and clickable (most modern terminals auto-linkify; in Ink you can use the OSC-8 escape via `ink-link`). The label is dim. Example: `JSON-RPC http://127.0.0.1:9000 · WebSocket ws://127.0.0.1:9000 · Faucet http://127.0.0.1:9123/gas`.
7. Otherwise → `<type-lowercase> · needs: <comma-sep deps or —>` in dim.

#### Status states (8 total)

| Status | Glyph | Color | Notes |
|---|---|---|---|
| `idle` | `·` | mute | Not yet schedulable |
| `queued` | `·` | mute | Deps healthy; waiting for runner slot |
| `running` | spinner | accent | Animated braille spinner |
| `healthy` | `✓` | ok (green) | Settled successfully |
| `failed` | `✗` | err (red) | Action threw — row is red |
| `skipped` | `–` | mute | Upstream failure |
| `stale` | `⟲` | warn (amber) | Inputs changed; needs re-run |
| `dirty` | `◌` | warn (amber) | Same as stale, used for filesystem changes |

Spinner: 80ms/frame braille animation: `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏` (use `ink-spinner` with the `dots` preset).

#### Action types

Each action has a `type` that controls its leading glyph (rendered dim, before the name):

| Type | Glyph | Examples |
|---|---|---|
| `Service` | `◆` | sui-localnet, walrus-aggregator, seal-key-server |
| `Build` | `⌬` | build:contracts |
| `Publish` | `↗` | publish:contracts |
| `Register` | `⊞` | register:walrus |
| `Seed` | `✱` | seed:accounts |
| `Emit` | `→` | codegen:typescript |
| `HostProcess` | `⚙` | wallet-server, frontend |
| `Verify` | `✓` | verify:health |

#### Scopes (plugins)

Every action belongs to one scope. Scopes are the grouping axis for the status table and the color axis for log lines. Order: `sui`, `walrus`, `seal`, `contracts`, `frontend`, `wallet`, `devstack`.

### 3. ShutdownPanel (replaces StatusTable during shutdown)

Triggered by `q` or `Ctrl+C`. Header reads `shutdown` in amber. Title row:

- While running: `⠋ shutting down — N hooks` (spinner + warn color) and right-aligned `<done>/<total> ok[, <failed> failed] · <elapsed>`.
- After settled: `✓ shutdown complete` (green) or `⚠ shutdown complete (with errors)` (amber), and final stats.

One row per healthy Service / HostProcess. Same 4-column layout (2ch glyph, 32ch label, 10ch duration, flex detail):

- `pending` → `·` glyph dim, "pending" duration, `— queued` detail dim.
- `running` → spinner, live duration, `stopping…` detail dim.
- `done` → `✓` green, final duration, `— exited cleanly` dim.
- `failed` → `✗` red, final duration, `— <error>` red. (Real impl: hook for sigkill timeout, port still bound, etc.)

Below the rows, a dashed-rule summary line restating the result and `press [r] to restart`.

### 4. TabStrip

Two tabs only: `all` and `supervisor`. Each tab:

- Padded `4px 12px`.
- Number prefix `1` / `2` in dim (matches keyboard shortcut).
- Active tab: accent (blue) background, terminal-bg-color text, bold.
- Inactive tab: dim text on strip background. Hover (mouse only — keyboard nav too) → fg color.
- Right edge of each tab: 1px vertical divider in `--border-soft`.
- Unread indicator: a small `●` in `--warn` color appears beside the label of any inactive tab that has new lines since last visit. Active tab clears its own counter on selection.

### 5. LogPane

A single combined stream of log lines from all actions plus the supervisor. Each line has 4 columns:

| Col | Width | Contents |
|---|---|---|
| 1 | 10ch | `[HH:MM:SS]` timestamp in mute |
| 2 | 9ch | **Scope tag** — uppercase scope name in a tight bordered pill, in the scope's color. E.g. `SUI`, `WALRUS`. 1px border at ~33% alpha of the same color. |
| 3 | 18ch | Source action name (truncate with ellipsis), in the scope color (slightly less saturated than the tag). The supervisor's source is the literal word "supervisor". |
| 4 | flex (1) | Message — `--fg` for info, `--warn` for warn, `--err` for error, `--ok` for success/ready lines, `--fg-dim` for dim lines. Preserve whitespace; truncate with ellipsis. |

When `selectedTab === 'supervisor'`, filter to source `supervisor` only. Otherwise show all lines.

Auto-scroll to bottom on new lines (the prototype does this with a ref + scrollHeight on every update).

Log line classification (mostly heuristic in the prototype, but real reconciler should attach a level):

- `info` → default
- `warn` → contains `warn` or appears after a stale event
- `err` → starts with `error:` or comes from a failed action
- `ok` → "ready in Xs" success messages, OSC 200 health probes, etc.
- `dim` → meta lines, e.g. counts, transient supervisor chatter

### 6. Footer

One padded row of keyboard hints, separated by gap. Each hint is `[key] description` where `[key]` is a keyboard pill (small bordered box, slightly larger than the surrounding text). Right-aligned cluster shows current modes: `verbose | logs: normal` and `paused | live`.

Default hints:
- `[Tab]` streams (cycle tabs)
- `[1-9]` jump (numbered tab)
- `[r]` retry (failed actions, or restart after shutdown)
- `[l]` logs (toggle verbose)
- `[s]` stale (mark a random healthy action stale — dev tool)
- `[f]` fail (inject failure into next running action — dev tool)
- `[q]` quit (begin shutdown)

`s` and `f` are dev/test affordances; ship them behind `--dev` or just don't surface them in the footer in the production build.

## Interactions & behavior

### Keyboard

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Cycle tabs forward/back |
| `1`–`9` | Jump to nth tab (only `1` and `2` matter currently) |
| `r` | Retry failed actions (idempotent — already-healthy actions are untouched). After shutdown completes, `r` resets and re-runs the whole graph. |
| `l` | Toggle verbose log filter |
| `s` | (dev) Pick a random healthy action, mark stale, emit "inputs changed — marked stale" warn line |
| `f` | (dev) Trigger a failure in the next running/queued action |
| `q` / `Ctrl+C` | Begin shutdown |
| `p` | Pause/resume the reconciler |

### Reconciler lifecycle (what the supervisor does)

The simulation in `prototype/simulation.jsx` is a faithful scale model of the real reconciler's state machine. Specifically:

1. **Resolve** the action graph from plugins. Each action declares `name`, `scope`, `type`, `needs` (deps by name), and an async runner.
2. **Mark roots queued** (no deps).
3. On each tick:
   - Any `idle` action whose deps are all `healthy` → `queued`.
   - Any `idle` action with a `failed`/`skipped` dep → `skipped`.
   - Any `queued` action with all deps healthy → `running` (spawn the runner).
4. **Run** parallelizes everything that's runnable. No global concurrency limit in the prototype, but real impl should support `--concurrency=N`.
5. **Settle** to `healthy` on success, `failed` on thrown error. Append a final status log line.
6. On healthy Services: register their **endpoints** (label + URL + kind: `rpc | ws | http | web`) for display in the status row and for the supervisor "rpc → ..." banner.

### Shutdown lifecycle

Triggered on `q` / `SIGINT` / `SIGTERM`:

1. Snapshot all healthy Services and HostProcesses → these become **shutdown hooks**.
2. Render them all as `pending` in the ShutdownPanel.
3. Stagger their `running` transitions by ~180ms each (fan out — looks alive, also reduces port-release thundering herd).
4. Each hook calls its action's `stop()`. Resolve → `done`. Reject or timeout (1s) → `failed` with detail (e.g. "process did not exit within 1s — sigkilled").
5. When all hooks settle, render the final summary line.
6. Process should `exit(0)` on clean shutdown, `exit(1)` if any hook failed (unless `--force-success`).

### Animations

- Spinners: 80ms/frame, dots preset.
- No fade/slide transitions — Ink is a TUI, not a web page. State changes are instantaneous.
- Header counts and uptime tick once per second.
- Status row durations tick at ~250ms while running.

## State management

The supervisor owns canonical state. The TUI is a pure projection; it should not own any business state. Recommended shape (TypeScript):

```ts
interface ActionStatus {
  status: 'idle' | 'queued' | 'running' | 'healthy' | 'failed' | 'skipped' | 'stale' | 'dirty';
  startedAt?: number;
  settledAt?: number;
  error?: Error;
}

interface Action {
  name: string;
  scope: 'sui' | 'walrus' | 'seal' | 'contracts' | 'frontend' | 'wallet' | 'devstack';
  type: 'Service' | 'Build' | 'Publish' | 'Register' | 'Seed' | 'Emit' | 'HostProcess' | 'Verify';
  needs: string[];
  endpoints?: Array<{ label: string; url: string; kind: 'rpc' | 'ws' | 'http' | 'web' }>;
  run(ctx: RunContext): Promise<void>;
  stop?(): Promise<void>;
}

interface LogLine {
  ts: number;             // ms epoch — format to HH:MM:SS at render time
  src: string;            // action name OR 'supervisor'
  msg: string;
  level: 'info' | 'warn' | 'err' | 'ok' | 'dim';
}

interface SupervisorState {
  appName: string;
  stack: string;
  network: string;
  rpcUrl?: string;          // populated when sui-localnet healthy
  startedAtMs: number;
  actions: Action[];
  statuses: Map<string, ActionStatus>;
  logs: LogLine[];          // bounded ring buffer, ~500 lines
  unread: Map<string, number>;   // per tab
  selectedTab: 'all' | 'supervisor';
  shutdown: ShutdownState | null;
  paused: boolean;
  verbose: boolean;
}
```

Use a small pub/sub or zustand-style store; subscribe Ink components via `useSyncExternalStore`. **Important**: bump a version counter inside `notify()` and use it as the snapshot — `useSyncExternalStore` bails out via `Object.is`, so returning the same state object reference will silently skip re-renders.

## Plain renderer (non-TTY / CI)

When the process is non-interactive (`!process.stdout.isTTY` or `DEVSTACK_NO_TUI=1`), bypass Ink and just `console.log()` line-oriented output:

```
─────────────────────────────────────────────────────────────────────
devstack up wallet-demo · sui+walrus+seal · localnet
13 actions
─────────────────────────────────────────────────────────────────────
⟳ sui-localnet                running     +0ms
✓ sui-localnet                healthy     4.2s
⟳ build:contracts             running     +0ms
✓ build:contracts             healthy     5.4s
…
```

One line per state transition (so each action appears 1× as `running` and 1× as terminal state). Plus per-action log lines, prefixed with `[HH:MM:SS] action-name  msg`. No in-place rewrites, no spinners, no ANSI control sequences beyond color (and respect `NO_COLOR`).

Use the same glyphs and color palette as the TUI, just without the in-place redraw. The prototype's `PlainPreview` component shows the intended output verbatim.

## Design tokens

### Colors

The prototype ships 5 themes; **ship "modern dark" only** and let users override via `~/.config/devstack/theme.json` if you want — the others are exploration.

Modern dark (default):

| Token | Hex | Ink/chalk equivalent | Used for |
|---|---|---|---|
| `--bg` | `#0e1116` | n/a (terminal default) | Page bg — don't paint, just leave terminal default |
| `--fg` | `#d6dde6` | `white` (default) | Body text |
| `--fg-dim` | `#7a8696` | `gray` | Secondary text, separators, dep names |
| `--fg-mute` | `#4a5260` | `blackBright` | Tertiary, glyphs for idle states |
| `--accent` | `#6cb6ff` | `blueBright` / `cyanBright` | Running spinner, links, RPC URL |
| `--ok` | `#57ab5a` | `green` | Healthy status, success log lines |
| `--warn` | `#daaa3f` | `yellow` | Stale, dirty, shutdown header, warning log lines |
| `--err` | `#e5534b` | `red` | Failed, error log lines |
| `--magenta` | `#b083f0` | `magenta` | Supervisor source, walrus scope |

Per-scope colors (used in log scope tags + status group headers):

| Scope | Hex | chalk |
|---|---|---|
| `sui` | `#6cb6ff` | `blueBright` |
| `walrus` | `#b083f0` | `magenta` |
| `seal` | `#daaa3f` | `yellow` |
| `contracts` | `#57ab5a` | `green` |
| `frontend` | `#e08aff` | `magentaBright` |
| `wallet` | `#5fb3a1` | `cyan` |
| `devstack` | `#daaa3f` | `yellow` |
| `supervisor` | `#b083f0` | `magenta` |

### Typography

The prototype uses **JetBrains Mono** at 14.5px / 22px line-height. In a terminal you have one font and one size; the design assumes the user's terminal font is monospace and ≥80 columns wide. Test in: macOS Terminal default (SF Mono), iTerm2 (any), Alacritty/Wezterm (any), Windows Terminal (Cascadia Code). Avoid relying on font features (no ligatures, no italics).

Three sizes show up only as relative emphasis:
- Body (default): action names, log messages, status labels
- Small (-1ch font-size in CSS, just regular weight in terminal): timestamps, durations, group counts
- Pill (-3ch in CSS, regular in terminal but in a bordered span): scope tags

In Ink, render scope tags as `<Text color={scopeColor}> {scope.toUpperCase().padEnd(8)} </Text>` — the surrounding spaces give it visual weight without an actual border.

### Spacing

- Outer padding: 1 char top/bottom, 2 chars left/right on each section.
- Section dividers: a single `─` rule line OR a blank line.
- Group header rule: `╌` (dashed) filling remaining width.

### Glyphs

All glyphs above are Unicode. They render correctly in any modern terminal with a Powerline-or-better font (Cascadia Code, JetBrains Mono, Fira Code, SF Mono, Menlo all work). For older terminals, provide an ASCII fallback (`*`, `o`, `x`, `>`, `v`, `^`) gated on `process.env.TERM` or a `--ascii` flag.

## Assets

No images, no icons, no fonts to ship. Everything is text + Unicode + ANSI color.

## Files

- `prototype/index.html` — entry point. Open in browser to see the design live.
- `prototype/simulation.jsx` — fake reconciler. The action defs at the top (`ACTION_DEFS`) are the canonical example graph; real plugins will resemble these.
- `prototype/tui.jsx` — all the rendering components: `Header`, `StatusTable`, `TabStrip`, `LogPane`, `Footer`, `ShutdownPanel`, `Spinner`, `StatusGlyph`. This is the file to mirror most closely when porting to Ink.
- `prototype/app.jsx` — keyboard wiring + Tweaks panel + plain-mode preview. The plain preview is the spec for non-TTY output.
- `prototype/tweaks-panel.jsx` — design-time chrome only. **Do not port.**

## Open questions for the developer

These are intentionally not specified in the design — make a call based on the codebase you're working in:

1. **Concurrency limit** — should `--concurrency=N` apply globally, or per-scope, or per-type? Prototype runs everything in parallel.
2. **Log retention** — prototype keeps 500 lines in memory. Real impl should also tee to a file (`.devstack/logs/<run-id>.ndjson`) for post-mortem.
3. **Shutdown hook timeout** — prototype hardcodes 1s. Probably needs to be per-action-configurable; default 5s for HostProcesses, 2s for Services.
4. **Resize handling** — Ink redraws on `process.stdout.on('resize')`; verify the layout still works at 80 columns.
5. **Mouse support** — prototype is click-aware on tabs. Ink doesn't support mouse natively. Drop it.
