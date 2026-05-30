# Devstack Web Dashboard — Design Brief

> **For the design agent.** This brief describes *everything that goes into* the devstack web dashboard so you can own the visual and interaction design. It is deliberately **not** prescriptive about pixels, exact colors, or layout — those are yours. It **is** specific about product context, information architecture, every screen and what it must surface, interactions, states, the component inventory, and a few fixed vocabularies (status set, color-token semantics) that already exist in the tool and should map cleanly into your design system.
>
> Engineering/data details live in the companion `plan.md` — you don't need them to design, but it explains what data is available and why some things are phased.

---

## 1. Product context — what you're designing

**Devstack** is a tool that spins up a complete **local Sui blockchain development environment** on a developer's machine: a local Sui node, a faucet, test accounts, published Move packages, and optional services (DeepBook DEX, Walrus storage, Seal key-management, Postgres, a dev-wallet, etc.). Today the only live view is a **terminal UI** (TUI) that shows service status, logs, and endpoints. We're building a **web dashboard** that does everything the terminal does and much more.

**Who uses it:** Sui / blockchain application developers and protocol engineers, running a stack locally while building. They are technical, live in the terminal and the browser, value **information density, speed, and real-time feedback**, and frequently copy ids/addresses/URLs.

**The shape of the experience:** a long-running local process the developer keeps open in a browser tab while coding. It must feel like a **fast, dense, real-time operator console** — think the polish of Vercel/Railway/Grafana dashboards crossed with a block explorer (suiscan/suivision) — not a marketing site.

**Three jobs the dashboard does:**
1. **Operate the stack** — see health/status of every service, read live logs, watch activity, and run controls (restart, snapshot, etc.).
2. **Work with accounts & funds** — list test accounts, see balances, request faucet funds, connect a wallet.
3. **Explore the chain** — a full block explorer over the *local* node (transactions, objects, addresses, packages, coins, checkpoints), with the stack's *own* published packages/accounts highlighted as first-class.

---

## 2. Design goals & principles

- **Truth at a glance.** A developer should know in <2 seconds whether the stack is healthy, starting, or broken, and which service is the problem.
- **Real-time, calm.** Data updates live (status, logs, events stream continuously). Updates must feel alive but **never cause jarring layout shifts or flicker**. New log/activity lines append smoothly; status changes animate subtly.
- **Dense but scannable.** Maximize useful information per screen (tables, grids, compact rows) while keeping a clear hierarchy. Offer a density/compact mode.
- **Status-driven visual language.** Health/status is the dominant signal — encode it consistently everywhere with both **color and shape** (see §9; the tool already uses glyphs like ● ◐ ○ ✖ ✓, which makes it color-blind-safe — preserve shape encoding).
- **Copy everything.** Every id, address, digest, URL, and connection string has a one-click copy affordance.
- **Explorer familiarity.** The Sui explorer section should feel immediately familiar to anyone who has used suiscan/suivision — but visually distinguish entities that **belong to this stack**.
- **Keyboard-friendly.** A command palette + shortcuts (mirroring the terminal's `r` restart, `s` snapshot, `q` quit, plus `/` search, `?` help).
- **Dark-first.** Developer tool; design dark as the primary theme with a light variant. Honor reduced-motion and system color-scheme.

---

## 3. Visual & system direction (guidance, not prescription)

- **Theme:** dark-first, with a light variant. High contrast for status; restrained chrome so data dominates.
- **Typography:** a clean sans for UI chrome; a **monospace** for all machine values — addresses, object/package ids, tx digests, log lines, code/JSON, amounts in raw units. This is important and pervasive.
- **Density:** comfortable default with a **compact toggle**; tables and the log/event streams benefit from compact rows.
- **Color:** build a small **semantic palette** anchored to the fixed status tokens in §9. Beyond status, keep accent usage disciplined (the explorer and charts will introduce data colors — keep them harmonious with the status palette).
- **Motion:** subtle and purposeful — spinners for in-progress lifecycle, gentle highlight pulses for state changes (e.g., a service being selectively restarted), smooth append for streams. Respect `prefers-reduced-motion`.
- **Iconography:** a consistent set for service roles, plugin domains (sui, deepbook, walrus, seal, postgres, wallet, coin, package, account, faucet), endpoints/links, copy, and explorer entity types (tx, object, address, package, coin, checkpoint).
- **Accessibility:** color-blind-safe status (shape + color), keyboard navigability, focus states, sufficient contrast in both themes.

---

## 4. Information architecture & app shell

**Persistent shell:**
- **Left navigation rail** — top-level sections (below); collapsible to icons on narrow widths.
- **Status header (always visible)** — stack identity (app / stack / network), a **cycle/phase chip** (booting · running · restarting · shutting-down), a one-line health summary (e.g., "3/5 ready · 1 starting · 1 failed · 7 endpoints · 2 accounts"), a **connection indicator** (dashboard ↔ stack link health), and the global **search / command-palette** trigger.
- **Main content** — the routed section.
- **Activity / log drawer** — a dockable, toggleable drawer (bottom or right) that persists across sections, so the live event/log narration is never lost while navigating.
- **Toast layer** — results of control actions and surfaced errors.

**Top-level sections:**
1. **Overview** (home)
2. **Services** (the stack's plugins/services)
3. **Logs**
4. **Activity** (events &, later, traces)
5. **Accounts & Wallet**
6. **Faucet**
7. **Explorer** (the Sui block explorer)
8. **Plugins** (domain-specific panels: deepbook, walrus, seal, postgres, package, coin)
9. **Controls** (operations: restart, snapshot, apply, prune, wipe, advance-clock)
10. **Config** (resolved configuration & endpoints)

---

## 5. Screen-by-screen inventory

For each: **purpose · what it shows · interactions · states.** (Phasing hints in the plan; design all of it.)

### 5.1 Overview / Home
- **Purpose:** at-a-glance stack health + fast jumps.
- **Shows:** stack identity & current cycle/phase; **health summary tiles** (total services, how many ready / starting / waiting / failed; counts of endpoints, accounts, packages, errors; an overall health state: ready / active / blocked / empty); a **service status grid** grouped by category (Services, Packages, Accounts, Actions, App, Other) — each cell a service with its status glyph+color, name, role, and a one-line headline (its primary endpoint or current error); **endpoint quick-links**; a **recent activity** strip; and **quick controls** (restart, snapshot).
- **Interactions:** click a service → its detail; click an endpoint → open/copy; quick-control buttons.
- **States:** booting (many "starting"), running (healthy), restarting, shutting-down, **empty** (nothing configured → onboarding), **blocked** (something failed → draw the eye to it).

### 5.2 Services / Plugins
- **Purpose:** the operator's table of every running service + per-service operations.
- **Shows:** a table/grid of services and one-shot tasks: status (glyph+color+label), a **phase narration** ("starting: pulling image", "ready", "failed"), role (service vs task), owning plugin, its **endpoints**, an **error summary** if failed, and a hint when logs were truncated. A service mid–selective-restart is visually highlighted.
- **Service detail (drawer/page):** lifecycle/phase history timeline, this service's endpoints, a live **log tail** filtered to it, structured errors, and **controls** — restart this service (selective) and restart the whole stack. Build/compile progress where relevant.
- **Interactions:** row → detail; restart / selective-restart (confirm when running); filter by category/status; copy endpoints.
- **States:** per-status visuals; starting shows narration + spinner; failed shows an error panel; restart highlight pulse.

### 5.3 Logs
- **Purpose:** a unified, live, multi-source log console.
- **Shows:** a continuous stream of log lines across all services — timestamp, source/scope (color-coded per service), level (trace→fatal), message, and expandable **structured fields**.
- **Interactions:** filter by service, level, and tag; full-text search; **pause/follow** (auto-scroll with a "N new lines" pill when paused); expand a line's structured fields; download the current view; clear.
- **States:** following (auto-scroll) vs paused; filtered-empty; high-volume (must be **virtualized** — tens of thousands of lines stay smooth); level-colored.

### 5.4 Activity / Events (and Traces, later)
- **Purpose:** the engine's narrative — what the stack is doing — and (later) performance traces.
- **Shows (events):** a curated, human-readable feed of significant events (lifecycle changes, endpoints coming up, errors, restarts, snapshots, builds), scope-colored by service; plus a "raw" toggle that exposes every event type. Filterable by service/scope/level.
- **Shows (traces, later):** a spans timeline — operations with durations, filterable by service / endpoint / operation, for spotting slow startup steps.
- **Interactions:** filters; jump-to-source (an event about a service → that service; a snapshot event → Controls); follow/pause.
- **States:** live / filtered / empty; correlate a control action to its resulting events.

### 5.5 Accounts & Wallet
- **Purpose:** test identities, their funds, and connecting a wallet.
- **Shows:** account list — name, **address** (truncated, copyable), key scheme, whether real vs **impersonated** (fork mode), and **funding status** (pending / funded / already-satisfied / skipped / failed) with requested vs actual balances, broken down per coin. **Live balances and owned objects** come from the chain. Per-account detail: registry facts + live balances + owned coins/objects + recent transactions; an inline **"request funds"** control; impersonation clearly labeled; **export keypair** (ephemeral accounts only — guarded, with a clear warning).
- **Wallet:** a "Connect dev-wallet" flow (the stack ships a browser dev-wallet); show paired accounts.
- **Interactions:** copy address; open in explorer; request funds; connect/disconnect wallet; toggle live-balance refresh.
- **States:** funding states (distinguish "✓ cached/already-funded" from "✓ freshly funded"); address still resolving; impersonate badge; wallet connected / not.

### 5.6 Faucet
- **Purpose:** dispense local test coins quickly.
- **Shows:** target (pick an account or paste an address), coin selector (SUI always; **WAL** when Walrus is present; **DEEP** when DeepBook funding is available — gate per availability), amount, and a request history.
- **Interactions:** request funds; see success reflected in balances; retry with feedback on rate-limit / unreachable / malformed-response errors.
- **States:** idle / requesting / success / rate-limited (exhausted) / unreachable / error; per-coin availability gating.

### 5.7 Sui Explorer (full, suiscan/suivision-style)
- **Purpose:** a complete block explorer over the **local node**, with the stack's own entities highlighted. Should feel familiar to suiscan/suivision users.
- **Network home:** epoch + progress, throughput (TPS), total transactions, reference gas price, total staked, checkpoint height; **latest transactions** feed; **latest checkpoints** feed; **analytics charts** (transactions/day, active accounts, packages over time).
- **Transaction detail:** status (success/failure), sender, timestamp, the checkpoint that certified it, **gas breakdown** (computation / storage / rebate / budget / price), **events** (typed, parsed), **balance changes** (per-coin per-owner), **object changes** (created/mutated/deleted/wrapped/transferred), the PTB/inputs breakdown, and raw effects.
- **Object detail:** id, full Move type, **owner** (address / object / shared / immutable), version + previous transaction, **fields** rendered recursively, **dynamic fields / child objects** (paginated), related transactions, version history.
- **Address / account view:** SUI + all coin **balances**, **owned objects** split into Coins and NFTs (with media), **transaction history** (paginated), staked SUI.
- **Package view:** **modules** → functions (signatures, visibility) and structs/datatypes, normalized ABI, **bytecode/disassembly**, dependencies, version history. **Packages published by this stack are highlighted and friendly-named**, with a "published by this stack" badge linking to the owning service/account.
- **Coin / token view:** metadata (symbol, decimals, icon), total supply, holders, treasury/cap — enriched with the stack's known coins.
- **Checkpoints / epoch / validators:** browse + detail.
- **Global search:** one box resolving address / object id / tx digest / package / coin / checkpoint by shape (and name service).
- **Enrichment (the differentiator):** anywhere a chain entity is one of *ours*, badge it and link it back into the dashboard (an owner address that's a known account renders as an account chip; our package gets the "stack" badge and links to its plugin). Raw chain data stays authoritative; our overlay only annotates.
- **States:** per-panel loading skeletons; not-found; a **graceful degraded mode** for deep history/analytics only (current-state lookups always work — **including on forked networks**; only long historical lists/analytics need an indexer); banners reflecting the chain mode (local / fork / live). Design fork as a fully-functional explorer state, not a disabled one.

### 5.8 Plugin-specific panels
Domain consoles, shown only when that plugin is present:
- **DeepBook:** pools table (trading pairs, tick/lot/min sizes), registry & admin objects, order-book / seed-liquidity view, oracle (Pyth) feed status, DEEP funding, market-maker toggle/status.
- **Walrus:** storage-cluster node health (+ aggregator/publisher/proxy endpoints), a blob upload / aggregator test, WAL exchange/faucet.
- **Seal:** key-server status, mode, policies.
- **Postgres:** connection string (copyable), health.
- **Package:** publish status, captured object ids, upgrade capability, publisher, source path.
- **Coin:** the coin registry table + a **mint control** when the stack holds the treasury capability.
- **States:** ready / seeding / failed per panel; control actions show progress.

### 5.9 Controls / Operations
- **Purpose:** the stack's command surface (mirrors the terminal's controls + more).
- **Shows / does:** restart stack; selective-restart a service; **snapshots** — capture (with a name), list existing snapshots (id, label, created-at, contents), restore, delete; apply config; regenerate codegen; prune; **wipe** (destructive); **advance clock / checkpoint** (fork mode only).
- **Snapshot capture** shows **live progress** (phases, paused containers, counts) and a final captured/failed/skipped result.
- **Interactions:** buttons issue commands and toast the result; destructive operations (wipe, prune, restore, delete) require an explicit **confirm** step; advance-clock is disabled outside fork mode.
- **States:** in-progress (disabled + progress), success, failed (with detail), skipped (e.g., a capture already running).

### 5.10 Config inspector
- **Purpose:** show the resolved configuration and all endpoints.
- **Shows:** stack identity; resolved members, modes, ports, funding plans; the full **endpoints registry** (name, owning service, protocol, when registered); copy helpers throughout.
- **States:** read-only; live-updates as endpoints register/release.

---

## 6. Component inventory (what to design)

**Primitives (a unified design system):** buttons/icon-buttons, tabs, sortable/sticky tables, dialogs & destructive-confirm dialogs, popovers, tooltips, dropdown menus, a **command palette**, toasts, badges, skeletons, scroll areas, resizable panes (for the log drawer), inputs/selects, switches, collapsibles, breadcrumbs.

**Domain components (each maps to real data):**
- **StatusBadge** — service lifecycle status as glyph + color + label (and variants for the stack phase and overall health).
- **RoleChip** — service vs one-shot task.
- **CategoryChip** — Services / Packages / Accounts / Actions / App / Other.
- **EndpointLink** — a named endpoint: label, URL (prefer a friendly display URL), a protocol tag when not plain HTTP, copy + open affordances.
- **AddressChip** — truncated `0x…`, copy, links into the explorer; flags impersonated vs real.
- **CoinAmount** — formats raw amounts with the coin's decimals/symbol; shows human + raw (tooltip); SUI/MIST aware.
- **PackageCard** — name, id, local-vs-known, upgrade cap, source path; "published by this stack" badge.
- **AccountCard / FundingStatus** — account identity + funding state (per-coin requested vs actual, with the cached/funded/skipped distinction).
- **LogStream** — virtualized, level-colored, expandable structured fields, follow/pause.
- **EventFeed** — curated narration + raw mode, scope-colored.
- **JsonTree** — collapsible viewer for object fields, transaction effects, error chains, structured log fields.
- **TxEffectsView** — a transaction's balance changes / object changes / events / gas.
- **ErrorPanel** — a structured error (summary, severity, cause chain, owning service).
- **SnapshotProgress** — capture phases, paused indicator, counts, outcome.
- **CopyButton, HealthDot, ConnectionIndicator, CommandPalette, ConfirmDestructive.**

**Explorer components:** entity headers (tx / object / address / package / coin / checkpoint), a results/listing table (virtualized, paginated), a universal search result router, and the "stack-owned" badge/annotation treatment.

---

## 7. Cross-cutting interaction patterns

- **Command palette / global search** — one entry point to jump to any service, account, package, endpoint, or explorer entity (by id), and to invoke commands (restart, snapshot…).
- **Copy-everything** — ubiquitous copy affordances on machine values.
- **Keyboard shortcuts** — mirror the terminal (`r` restart, `s` snapshot, `q` quit-with-confirm) plus `/` focus search and `?` shortcut help. Document the full map in the UI.
- **Live data presentation** — append smoothly; don't reflow tables on every tick; use highlight-then-settle for changes; keep scroll position stable when paused.
- **Confirm-destructive** — wipe/prune/restore/delete and quit require an explicit confirm.

---

## 8. States & feedback (design all of these)

- **Connected / live** — the normal state; subtle "live" affordance.
- **Connecting / reconnecting / disconnected** — distinguish "the dashboard lost its link to the stack" from "the stack is shutting down." On disconnect, freeze and dim the last-known view, show a non-blocking banner, and auto-reconnect; the full state refreshes on reconnect.
- **Loading** — skeletons (the stack state arrives as a whole; chain panels load independently).
- **Empty** — nothing configured, no logs, no results, no snapshots — each needs a designed empty state, with onboarding guidance on Overview.
- **Error** — a global error tray fed by the stack's error history, plus inline errors on the failing service; chain-query errors are local to their panel.
- **In-progress operations** — disabled controls + progress for restart/snapshot/etc.

---

## 9. Fixed vocabulary & constraints (please map these into your system)

These exist in the tool already and should map cleanly into your design tokens/components so the web and terminal stay consistent:

- **Service lifecycle statuses (7):** `pending` (waiting), `acquiring` (starting), `ready`, `failed`, `stopping`, `stopped`, `done`. Each already has a **glyph** (e.g., ○ waiting, ◐ starting/spinning, ● ready, ✖ failed, ✓ done) and a color — please keep **shape encoding** alongside color (color-blind safety) and design the spinning/active treatment for `acquiring`/`stopping`.
- **Stack phases:** `booting` · `running` · `restarting` · `shutting-down`.
- **Overall health:** `ready` · `active` · `blocked` · `empty`.
- **Service categories:** Services · Packages · Accounts · Actions · App · Other.
- **Color tokens (7) and their intended meaning** — the tool's renderer emits these semantic tokens; define each in both themes: **green** = ready/healthy, **yellow** = in-progress/warning, **red** = failed/error, **cyan** = service accent / info, **magenta** = account/action accent, **blueBright** = package/snapshot accent, **white** = neutral/idle/pending.
- **Mode awareness:** the chain runs in **local**, **fork**, or **live** mode — surface this, and clearly label **fork/impersonated** accounts (signing is simulated).
- **Per-coin faucet gating:** SUI always; WAL/DEEP only when those plugins are present.
- **Explorer "ours" distinction:** entities published/owned by the running stack must be visually distinct from arbitrary chain entities.
- **Real-time without churn:** the projection updates frequently — designs must tolerate continuous updates without layout thrash.

---

## 10. References & inspiration

- **Block explorers (for the Explorer section):** suiscan.xyz, suivision.xyz — match the information set and familiarity, improve the density/clarity, and add the stack-owned highlighting.
- **Operator dashboards (for status/logs/observability):** Vercel, Railway, Grafana, Fly.io — for live status, log/event density, and calm real-time updates.
- **Existing internal language:** the terminal UI's status glyphs and color semantics (above) are the starting vocabulary; the dashboard is the richer, visual evolution of that same language.

---

## 11. What we'd love from you (deliverables)

1. A **design system / token set** (color incl. the 7 status tokens, typography incl. mono usage, spacing, density modes, elevation, motion) for dark-first + light.
2. **Key screen designs:** Overview, Services + service detail, Logs, Activity, Accounts & Wallet, Faucet, the Explorer (network home + transaction + object + address + package detail), Controls, and Config.
3. **Component specs** for the domain + explorer components in §6, including their **states** (§8).
4. **Interaction patterns:** command palette, live-update behavior, confirm-destructive, keyboard shortcuts, the activity drawer.
5. **Responsive behavior** (rail collapse, drawer docking) and **theme** variants.

> Companion docs: `plan.md` (architecture & data — for engineering). You can design entirely from this brief; reach into the plan only if you want to know exactly what data backs a panel.
