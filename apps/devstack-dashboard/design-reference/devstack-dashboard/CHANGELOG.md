# Changelog — devstack Dashboard designs

All notable changes to the design files. The consumer (real `apps/devstack-dashboard`) can use this to track what moved between hand-off revisions and re-sync only the deltas.

Format: [Keep a Changelog](https://keepachangelog.com/). Dates are design-revision dates, not release dates.

---

## [0.6.0] — 2026-05-29
### Added
- **Real charting via Recharts** (`components-viz.jsx`) — chosen to match the build target: shadcn/ui charts are Recharts under the hood, so these port 1:1 to `<ChartContainer>` instead of being re-derived. Components: **`Sparkline`**, **`AreaChart`**, **`BarChart`**, **`DepthChart`** (order-book). Themed with new `--viz-*` tokens; shared `CHART_TOOLTIP` mirrors shadcn's tooltip.
- **Data-viz palette tokens** in `styles.css` `@theme` — `--viz-1…6` + `--viz-grid` (dark + light), exposed as `text/bg/stroke/fill-viz-N` utilities.
- **New components** (`components-extra.jsx`): **`Banner`** (info/warn/success/danger/neutral callout), **`MultiSelect`** (faceted filter — now backs the Console filters), **`Pagination`** + **`LoadMore`** (relay-connection lists), **`CodeBlock`** (Move/ABI syntax highlight), **`CoinIcon`** (token glyphs), **`Identicon`** (deterministic address avatar).
- **Wired into panels**: KPI sparklines (Overview, Explorer); Explorer tx/day `BarChart` + active-accounts `AreaChart`; DeepBook price `AreaChart` + `DepthChart` + per-pool trend sparklines; `Banner` for the reconnecting state + Explorer indexer notice; `CoinIcon` in the coin registry; `Identicon` in Accounts.
- **Design System registration** — `ds/` card pages tagged with `<!-- @dsCard -->` so they surface in the project's Design System tab: `colors.html` (Colors), `typography.html` (Type), `spacing.html` (Spacing), `components.html` + `charts.html` (Components).

### Dependencies (for the rebuild)
- **Recharts** is now a real dependency (`recharts@2.x`, loaded via UMD in the prototype: needs `react-is` + `prop-types` globals first). In the app, use shadcn's `chart` component (wraps Recharts) — the `--viz-*` tokens map straight onto its CSS-var theming.
- Recharts 2.x emits a harmless `defaultProps` deprecation warning on React 18; the prototype filters it from the console. Goes away with shadcn's wrapper / Recharts 3.


### Added
- **Reusable layout/primitive components** extracted from repeated dashboard patterns (all in `components.jsx`, showcased in the library):
  - **`DataTable`** — config-driven table (`columns`/`rows`/`rowKey`/`onRowClick`, sortable headers, per-column `render`/`align`/`width`/`sortVal`, empty slot). Consolidates the ~12 hand-rolled `<table class="tbl">` patterns into one primitive — **showcased in the library; the prototype panels still use raw `.tbl` markup, so adopt `DataTable` during the rebuild** (the raw tables render identically, so this is a code-consolidation step, not a visual one).
  - **`Panel`** + **`PanelHeader`** — formalized surface (optional `pad`, `header` slot) and header-with-actions (alias of `SectionHead`).
  - **`Segmented`** — segmented tab control (`value`/`onChange`/`options`).
  - **Form controls**: **`Field`** (labeled wrapper + hint), **`Select`**, **`TextInput`**, **`NumberInput`**, **`Slider`**, **`Switch`**.
  - **`DefList`** / **`DefRow`** — key/value rows. **`Meter`** — proportion bar. **`Collapsible`** — disclosure panel.
- Library: new **Surfaces & Layout**, **Tables**, and **Form controls** sections (13 total).

### Fixed
- **Scrolling** in the dashboard and library — `overflow-y:auto` containers now get `min-height:0` and bounded flex/grid heights, so long pages scroll within `main` instead of being clipped by `body { overflow:hidden }`.

### Notes for upgraders
- These primitives are presentational and dep-free. When recreating in the real app, map them onto your shadcn equivalents (`DataTable`→TanStack Table + shadcn `<Table>`, `Select`→shadcn Select, `Switch`→shadcn Switch, etc.) — the prototype versions document the intended shape/behavior.

## [0.4.0] — 2026-05-29
### Added
- **`JsonTree`** — recursive, collapsible JSON viewer (auto-collapses past depth 2; address-aware coloring). For object fields, tx effects, log `fields`, raw config. `components.jsx`.
- **`TxEffectsView`** — transaction effects: gas breakdown (computation/storage/rebate/budget/price/total), balance changes, object changes (created/mutated/deleted/wrapped). `components.jsx`.
- **`Tooltip`**, **`Breadcrumbs`**, **`Skeleton`** + **`SkeletonRows`**, standalone **`ErrorPanel`**, **`FundingStatus`** primitives. `components.jsx`.
- **Explorer drill-down** — transaction / object / package detail views with breadcrumb navigation. (see `panels-stub.jsx`)
- **Disconnected / reconnecting** system state — dims the last projection and shows an auto-reconnect banner. (see `app.jsx`)
- **Loading skeletons** on detail views.
- `.skel` shimmer utility + `skelSweep` keyframe. `styles.css`.
- This `CHANGELOG.md`.

### Notes for upgraders
- New components are pure presentational + token-driven; no new deps. Map `JsonTree`/`TxEffectsView` onto your shadcn equivalents or keep as-is.

## [0.3.0] — 2026-05-29
### Changed
- **Styling migrated to Tailwind v4 (CSS-first).** `styles.css` is now Tailwind source: `@import "tailwindcss"` + `@theme inline` (tokens → utilities) + `@layer base/components` + `@utility` helpers. Compiled in-browser via `@tailwindcss/browser@4` in the prototype; drops into Vite + `@tailwindcss/vite` in the real app.
- Token CSS variables retained as source of truth → light/dark, density, and accent **Tweaks still cascade**; all dynamic inline styles unchanged.
- Output is pixel-identical to 0.2.0.

## [0.2.0] — 2026-05-28
### Added
- **Plugins promoted to first-class nav items** (DeepBook, Walrus, Seal, Coins, Postgres), each with a dedicated domain page (`panels-plugins.jsx`).
- **Snapshot capture naming dialog.**
- **Centralized confirmation dialogs** for restart, selective-restart, shutdown, wipe, prune, snapshot restore/delete.

### Changed
- **Logs + Activity merged into one "Console" page** (Logs · Events · Traces tabs); removed the redundant bottom drawer.
- **Sidebar overhaul** — fixed unstyled grey nav buttons (missing base `background`), added brand block + live status capsule.

## [0.1.0] — 2026-05-28
### Added
- Initial dashboard: app shell (nav rail, status header, ⌘K command palette, toasts, service detail drawer), Overview, Services, Logs, Activity, Accounts, Faucet, Explorer (lists), Controls, Config.
- Mission-control dark-first visual system; semantic ColorToken palette mirroring the TUI display-derivation vocabulary.
- Simulated projection + live event/log stream (`mock.js` / `DSBus`).
- **Component Library** showcase page.
- **Tweaks** panel (theme, accent, density, nav layout, mono-heavy).
