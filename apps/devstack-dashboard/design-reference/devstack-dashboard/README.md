# Handoff: devstack Web Dashboard

## Overview
A local-first control plane and Sui chain explorer for the `devstack` Effect-TS orchestrator. The dashboard mirrors everything the existing Ink TUI shows (status, logs, events, endpoints), adds account/faucet management and per-plugin domain panels (DeepBook, Walrus, Seal, Coins, Postgres), embeds a suiscan-style explorer, and exposes interactive controls (restart, snapshot, apply, wipe…). It is the web surface described in the architecture hand-off doc.

## About the Design Files
The files in this bundle are **design references built in HTML/React (via in-browser Babel)** — interactive prototypes showing intended look and behavior, **not production code to ship directly**. The task is to **recreate these designs inside the real `apps/devstack-dashboard` app** (the doc specifies React 19 + Tailwind v4 + Vite + shadcn/ui + dapp-kit), wiring the panels to the live `devstackClient` (SSE projection stream + REST commands) and the local node's GraphQL/RPC instead of the bundled mock. Use the target repo's established patterns (TanStack Query/Router/Virtual, shadcn primitives, the `display-derivation` import) rather than porting this JSX verbatim.

All data here is simulated: `mock.js` builds a fake `SubscribableState`-shaped projection and a 2.2s ticker (`DSBus`) standing in for the SSE stream. Swapping the data layer is the integration seam.

See **`CHANGELOG.md`** for what moved between hand-off revisions — use it to re-sync only the deltas.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, layout, interactions, and motion. Recreate pixel-closely using the codebase's component library; treat the CSS custom properties in `styles.css` as the source of truth for design tokens (map them onto Tailwind theme vars / shadcn CSS vars).

---

## Information Architecture

Left nav rail → routed main content → global overlays (⌘K command palette, toasts, confirm dialogs, right-hand service detail drawer). Persistent top status header. Footer status capsule in the rail.

Nav groups & routes:
- **(top)** Overview · Services · Console
- **Chain** — Accounts · Faucet · Explorer
- **Plugins** (first-class items) — DeepBook · Walrus · Seal · Coins · Postgres
- **Manage** — Controls · Config

Route ids: `overview`, `services`, `activity` (Console), `accounts`, `faucet`, `explorer`, `plugin:<key>`, `controls`, `config`. Plugin routes are `plugin:deepbook` etc.

---

## Screens / Views

### App shell
- **Layout**: CSS grid `[nav] 1fr`. Nav width `232px` (collapsed `60px`). Header height `56px`. Content padding `24px 26px`, independently scrollable.
- **Nav rail**: gradient surface (`bg-panel`→`bg-base`). Brand block (32px gradient diamond logo + "devstack" 15/620 + mono "orchestrator · v0.9.4"). Section eyebrows (10.5px/600/.14em uppercase, `--tx-lo`). Nav items 37px tall, radius 9px, gap 1px; active = `--accent-soft` bg + accent icon + 3px accent left bar with glow; hover = `--bg-hover`. Services item shows a pulsing red dot when any resource failed. Footer capsule: a `panel` showing phase dot + label, mode badge, mono `cycle #N` + `ready` count.
- **Status header**: green dot + `identity.name` + uppercase mode badge (cyan); divider; phase badge (`cycle #N · running`, dot pulses when not running); mono summary line (`7/11 ready · 9 tps · cp 18,442`). Right: Search button with `⌘K` kbd, divider, restart icon-btn, console icon-btn, live connection indicator (pulsing green "live").

### 1. Overview (`overview`)
- **KPI row**: auto-fit grid, min 168px. Tiles: Services `ready/total` (green), Checkpoint (live sweep), Throughput tps (cyan, live), Accounts funded (magenta), Packages published (blue), Uptime (`cycle #N`). Each tile = `panel` with eyebrow + icon, 26px/600 tabular value, sub label.
- **Failed-services banner** (conditional): red-tinted panel, alert icon, count + first error summary, "Inspect" button → opens that service drawer.
- **Two-column grid (1.55 / 1)**: left = "Stack status" panel grouping rows by section (Core/Infrastructure/Services/Plugins) — each row: status dot, title, narration, status label; click → service drawer. Right column = "Endpoints" panel (EndpointLink + copyable URL) and "Recent activity" (live event feed, last 7).

### 2. Services (`services`)
- Section-grouped tables. Columns: Status (StatusBadge), Service, Phase (narration; red if failed), Role badge, Owner (system text or copy chip), Endpoints (EndpointLink chips), Uptime, chevron. Row click → **Service detail drawer**.
- **Service drawer** (right sheet, 440px): header (status dot + title + mono `key · role`), StatusBadge + narration, error panel (code/summary/hint) if failed, endpoints list, recent events, **live log tail** (mono, terminal styling, auto-updating), footer actions (Restart, Apply, "open in console").

### 3. Console (`activity`)
Merged Logs + Events + Traces, segmented tabs.
- **Logs**: search input (mono), Plugin filter dropdown (multi), Level filter dropdown (multi, color-dotted), Following/Paused toggle with "N new" counter, export button. Virtualized-feel log list (capped 600) with timestamp, level pill, tag, message (red/yellow by level), inline fields. Auto-scroll when following; pauses on manual scroll-up.
- **Events**: Scope filter, Curated/Raw toggle. Each row: relative time, colored scope bar, dot, mono tag, message (or raw `{plugin, scope}`), plugin badge; click → Services filtered.
- **Traces**: info banner (SpanStore tracer), table of spans — status dot, mono op, plugin badge, duration meter + ms, relative time.

### 4. Accounts (`accounts`)
- Table: Account (magenta), Address (copy chip), Scheme (mono), Source badge (impersonate = yellow), Balance (CoinAmount), Funding (dot + `✓ funded`/`✓ cached`/`pending`/`skipped`), Wallet (cyan dot). Row click → right detail card (avatar, full address, SUI/DEEP balances, impersonation warning, Fund/Explorer/Export actions). "Connect dev-wallet" primary button.

### 5. Faucet (`faucet`)
- Two columns. Left request panel: Target select, Coin pills (faucet-enabled coins only), Amount input + quick chips (10/100/1000), primary Request button with idle→requesting→success states. Right: "Recent requests" table (coin, amount, target, when, ok dot).

### 6. Explorer (`explorer`)
- Header with global search input (digest/object/address/package — Enter to resolve). Connection banner. KPI row: Epoch, Checkpoint (cyan live), Total tx, TPS (green live), Ref gas. Two columns: "Latest transactions" table and "Packages" list (ours = blue dot + "published here" badge). **All rows drill in.**
- **Drill-down** (internal view state + Breadcrumbs):
  - **Transaction detail** — status/kind badges + digest; sender (→object)/timestamp/checkpoint; `TxEffectsView` (gas breakdown, balance changes, object changes — each object → object detail); events rendered with `JsonTree`; programmable-transaction command list.
  - **Object detail** — id/version; type, owner (AddressOwner → object, or Shared/Immutable badge), previous-tx (→tx); fields via `JsonTree`; dynamic fields table (→object).
  - **Package detail** — name + "published by this stack" badge; version/publisher/upgrade-cap/source; module list (left) → functions table (visibility, params) per module.
  - Detail views show **loading skeletons** (`DetailSkeleton`) during a simulated ~480ms GraphQL fetch (`useChainLoad`).

### 7. Plugin pages (`plugin:<key>`)
Each: header bar (icon tile, title + StatusBadge, tag + phase, Restart + "Logs & events"), then domain body.
- **DeepBook**: KPIs (pools, 24h volume, DEEP funded, MM status). Pools table (pair, price, 24h ±%, tick/lot/min, depth, trades, pool id) + "Seed liquidity". Pyth feeds table (sym, price, age ms, fresh/stale) + refresh. Market-maker card (running toggle, spread range slider in bps). Addresses card (package/registry/admin cap copy chips).
- **Walrus**: KPIs (cluster ready, epoch, blobs, shards). Endpoints card (aggregator/publisher/proxy, WAL exchange). Cluster nodes table (node, shards, stake, StatusBadge). Recent blobs table (blob id, size, epochs, uploader, certified, deletable, when) + Upload.
- **Seal**: warning banner if key-server not healthy + Probe. Key-server card (health, mode, threshold, key servers, object id). Policies table (name, type badge, threshold, package).
- **Coins**: registry table (coin + icon, type copy chip, decimals, supply, treasury cap, Mint button when cap present). Mint inline form (recipient select, amount, Mint/Cancel).
- **Postgres**: DSN bar (copy + "Open psql"). KPIs (health, index lag, db size, connections). Tables table (name, rows, size, fill meter).

### 8. Controls (`controls`)
- Command grid (auto-fill 232px cards): Restart, Apply, Codegen, Prune, Advance clock (disabled unless `mode==='fork'`), Wipe (destructive), Shutdown (destructive). Each: colored icon tile, label, description, "destructive" badge.
- "Selective restart" — chip buttons per resource (status dot + title).
- "Snapshots" panel: Capture button (opens **naming dialog**), live capture progress (phase + % meter), table (label + id, created, participants, containers, host-tree dot, size, Restore + delete). 

### 9. Config (`config`)
- "Identity" panel (key/value rows) + "Endpoint registry" table (key, plugin badge, protocol, URL copy chip). Read-only, live.

---

## Interactions & Behavior
- **Navigation**: `goto(route, param)` sets route; content remounts with a `fadeUp` transform entrance (`.34s` cubic-bezier(.2,.7,.3,1)). Plugin routes prefixed `plugin:`.
- **Command palette** (`⌘K` / `/`): fuzzy filter over nav targets, services, accounts, endpoints, and commands; ↑/↓ + Enter; Esc closes. Items show kind badge.
- **Keyboard**: `r` restart (→confirm), `s` controls, `l` console, `/` & `⌘K` palette, `?` shortcut toast.
- **Confirmations**: centralized `command(id, msg, opts)` opens a confirm dialog for `restart`, `restart/:key`, `shutdown`, `wipe`, `prune`, and snapshot restore/delete; benign commands (apply, codegen) dispatch directly. Destructive variants render a red alert ConfirmDialog. **Restart** flips `cycle.phase` to `restarting` then back to `running` with `cycle.id++` after 1.8s (mock; real impl waits for the projection stream).
- **Snapshot capture**: prompts for a name (prefilled `snapshot-N`), then runs a 5-phase progress animation; appends to the list.
- **Toasts**: top-right, auto-dismiss 3.2s, colored dot + message; fired on command acks.
- **Live updates**: `DSBus` ticker emits `log`/`event`/`row`/`tick`; panels subscribe and re-render (Seal toggles acquiring↔ready, Walrus active↔ready, TPS/checkpoint drift). In production these are SSE `state`/`engine-event` frames.
- **Connection state**: the header connection indicator shows `live` (green) / `reconnecting` (yellow). Clicking it simulates a stream drop — the main content **dims + greys + locks** and a "connection lost, reconnecting…" banner appears; auto-reconnects after ~3.6s and toasts a re-sync. In production this is driven by the `devstackClient` `connectionState` (distinguish bridge-down vs `cycle.phase==='shutting-down'`); on reconnect a full state snapshot is re-sent.
- **Loading**: detail views render `Skeleton`/`SkeletonRows` during fetch; replace with react-query `isLoading`.
- **Motion**: status dots pulse for active/acquiring; KPI live-sweep shimmer; sheet slides in from right; dialogs `popIn`.

## State Management
- `route` + `param` (current view), `svcKey` (open service drawer), `palette` (bool), `toasts[]`, `confirmState` ({title, body, danger, confirmLabel, onConfirm}). Tweaks state via `useTweaks` (persisted).
- Per-panel local state (filters, follow/pause, selected account, mint form, capture progress, MM toggle/spread).
- **Production**: one store fed by `subscribeState()` (single source of truth), an `EventFeed` + per-tag log buffers from `subscribeEvents()`, react-query for chain reads keyed by `identity.network`, and a registry-enrichment overlay. Commands only via `devstackClient.publish`.

## Design Tokens
Defined as Tailwind v4 theme tokens in `styles.css` — authored as Tailwind source (`@import "tailwindcss"` + `@theme inline` + `@layer base/components` + `@utility`). The raw CSS custom properties live in `@layer base :root` (dark) / `[data-theme="light"]`, and `@theme inline` aliases them onto Tailwind namespaces so utilities like `bg-panel text-mid border-line text-green rounded-lg shadow-e1 font-mono` resolve to the same vars (light-mode + density + accent Tweaks cascade through). The prototype compiles this in-browser via `@tailwindcss/browser@4`; in the real app it's a normal Vite + `@tailwindcss/vite` build. Key values (dark):
- **Surfaces**: `--bg-base #07080b`, `--bg-canvas #0a0c11`, `--bg-panel #0f1219`, `--bg-elev #161a24`, `--bg-elev-2 #1d2230`. Hover `rgba(255,255,255,.04)`, active `.07`.
- **Lines**: `--line rgba(255,255,255,.07)`, `--line-strong .13`, `--line-faint .04`.
- **Text**: `--tx-hi #e8ebf2`, `--tx-mid #9aa4b6`, `--tx-lo #616b7d`, `--tx-dim #424b5b`.
- **Accent** (tweakable): `--accent #34d8c4` (+ `-soft` 14%, `-line` 38%, `-glow` 30% via color-mix; `--accent-ink #04201c`).
- **Semantic ColorTokens** (mirror TUI display-derivation): green `#45d483` ready · yellow `#f6c454` active/warn · red `#fb6f84` failed · cyan `#46baf5` service · magenta `#df7aef` account/action · blue `#8893f6` package/snapshot · white `#c6cfde` neutral.
- **Status → token map** (`STATUS_MAP` in components.jsx): ready→green, active→yellow(pulse), failed→red, acquiring→cyan(pulse), idle→white, blocked→red, empty→dim.
- **Radii**: 4 / 6 / 9 / 13 / 18 px (`--r-xs…xl`).
- **Shadows**: `--sh-1/2/3/pop` (see file).
- **Density**: `--d` multiplier (compact .84 / balanced 1 / comfy 1.18) scales row height, cell padding, gaps, panel padding.
- **Type**: `--font-ui "Geist"`, `--font-mono "Geist Mono"`. Scale: display 30/600/-.025em, h2 19, h3 14.5–16, body 14, eyebrow 10.5/600/.14em, mono ids 12–13. Mono used for ALL machine values (ids, addresses, ports, digests, log lines, numbers via `tabular-nums`).

## Assets
- **Fonts**: Geist + Geist Mono (Google Fonts).
- **Icons**: inline 24-viewbox stroke SVG set in `components.jsx` (`ICONS` map, `<Icon name>`); ~40 glyphs. Replace with the codebase's icon library (lucide pairs cleanly).
- No raster images; logo is a CSS gradient tile with a `◆` glyph. Coin glyphs are unicode.

## Files
- `devstack dashboard.html` — entry; loads React/Babel + the scripts below.
- `styles.css` — **Tailwind v4 source** (`@import "tailwindcss"` + `@theme` tokens + `@layer base/components` + `@utility` helpers). All component classes and utility helpers are authored here.
- `mock.js` — fake projection + `DSBus` live ticker (the data seam to replace).
- `components.jsx` — Icon set + shared components, all exported on `window`:
  - *Domain*: StatusBadge, Dot, CopyChip, AddressChip, EndpointLink, CoinAmount, Kpi, SectionHead, LevelPill, EmptyState, ConfirmDialog, FundingStatus, ErrorPanel, JsonTree, TxEffectsView.
  - *Primitives*: Panel/PanelHeader, **DataTable** (config-driven sortable table), Segmented, Field/Select/TextInput/NumberInput/Slider/Switch, DefList/DefRow, Meter, Collapsible, Tooltip, Breadcrumbs, Skeleton/SkeletonRows.
- `components-viz.jsx` — **charts via Recharts** (matches shadcn/ui's chart engine): Sparkline, AreaChart, BarChart, DepthChart + shared `CHART_TOOLTIP`. Themed with `--viz-*` tokens.
- `components-extra.jsx` — Banner (callout), MultiSelect (faceted filter), Pagination/LoadMore, CodeBlock (Move highlight), CoinIcon, Identicon.
- `panels-core.jsx` — Overview, Services + ServiceDrawer, Controls.
- `panels-feed.jsx` — Console (Logs/Events/Traces); FilterMenu delegates to MultiSelect.
- `panels-stub.jsx` — Accounts, Faucet, Explorer (+ tx/object/package drill-down), Config.
- `panels-plugins.jsx` — per-plugin pages (DeepBook/Walrus/Seal/Coins/Postgres) + views.
- `app.jsx` — shell: nav, header, routing, command palette, toasts, global confirm, connection state, Tweaks wiring.
- `library.jsx` + `Component Library.html` — design-system gallery (tokens, type, components, charts, banners).
- `ds/` — Design System tab cards (`@dsCard`-tagged): colors, typography, spacing, components, charts.
- `tweaks-panel.jsx` — Tweaks panel scaffold (prototype-only; not part of the product).

> **Charts**: the prototype uses **Recharts** (UMD; needs `react-is` + `prop-types` globals). In the app, use shadcn's `chart` component (Recharts wrapper) — `--viz-*` tokens map onto its theming, so the chart designs port without re-derivation.

> Note on the JSX: each `<script type="text/babel">` runs in isolated scope and shares via `window`. Component identifiers used as JSX tags MUST be uppercase-first — this is a prototype constraint, irrelevant once recreated as real modules.
