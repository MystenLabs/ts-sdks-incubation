# Devstack Web Dashboard — Architecture & Design Hand-off

> Companion doc: [`design-brief.md`](./design-brief.md) — the self-contained UI/feature hand-off for the design agent (in this same folder).

## Context

`devstack` (`packages/devstack`) is an Effect-TS v4 local Sui dev-stack orchestrator. Today the only live view is an **Ink TUI** (`src/surfaces/tui/`). We want a **web dashboard** that (a) shows everything the TUI shows (status, logs, live-updating info, spans, endpoints), (b) adds faucet/account management and per-plugin panels (deepbook, walrus, seal, …), (c) embeds a **full suiscan/suivision-style Sui explorer** wired to the stack's own published packages/objects/accounts, and (d) exposes interactive controls (restart, snapshot, apply, …).

The exploration confirmed devstack was **built in anticipation of this**: the projection is fully serializable, the display-derivation layer is deliberately framework-free ("what lets a future web dashboard reuse the same status→glyph/label/color derivation" — `display-derivation.ts:1-7`), control commands are a typed union, and the repo already ships a Vite+React app precedent (`apps/dev-wallet`) with all the needed deps in the catalog. So this is **mostly additive**: one new plugin, one small substrate seam, one new frontend app, and a browser-safe re-export.

This document is the architecture plan **plus** a comprehensive UI/feature inventory intended to be handed to a design-specialist agent. Per the design discussion: the **full vision is captured here**; concrete build-phasing is a recommendation to finalize afterward.

### Key decisions (from review)
- **Packaging:** the dashboard is a **plugin** (`plugins/dashboard/`), like `wallet`/`seal`/`faucet` — inherits PortBroker, router hostname, CORS, endpoint emission, lifecycle, config.
- **Our API:** a **code-first GraphQL API built with Pothos** (`@pothos/core`), served from the dashboard plugin; the frontend consumes it with **`gql.tada`** (typed operations, no codegen step). One typed schema covers control/observability **and** the explorer (queries + mutations + subscriptions).
- **Chain access — prefer gRPC:** explorer chain reads go through `@mysten/sui`'s **`SuiGrpcClient`**, resolved **server-side** inside our GraphQL resolvers. gRPC hits the full node directly, so it **works against forked networks** (a fork's diverged state has no GraphQL indexer); it also sidesteps browser-gRPC limits and lets registry enrichment compose in the same resolver. Sui's GraphQL **indexer is optional** — used only to augment deep history/analytics in non-fork local mode.
- **Explorer ambition (v1):** **full suiscan-like** — tx/object/address/package/coin/checkpoint detail + global search, registry-enriched. Current-state + recent reads come from gRPC (fork-safe); long historical lists/analytics light up when an indexer is present.
- **HTTP host:** **`effect/unstable/http`** (Effect v4 in-core) hosts the GraphQL handler + `HttpStaticServer` (SPA); GraphQL **subscriptions** stream over **SSE** (`graphql-sse`). No `@effect/rpc`.
- **Frontend:** new `apps/devstack-dashboard` (React 19 + Tailwind v4 + Vite), mirroring `apps/dev-wallet`; shadcn/ui + `gql.tada` + dapp-kit-react (wallet/signing only) + TanStack Query/Virtual.

---

## 1. Architecture overview

**One typed GraphQL API, two data sources behind it.** The dashboard plugin serves a single **Pothos** GraphQL schema that the browser consumes with **`gql.tada`**. Resolvers pull from two sources and compose them:

- **Control / observability (devstack-native):** the live `SubscribableState`, event stream, logs, spans, registries, config, and command dispatch — read in-process via `ControlPlaneService` (§2.2). Authoritative for *everything about the stack*.
- **Chain (Sui explorer):** resolved **server-side via gRPC** (`@mysten/sui` `SuiGrpcClient`) against the local/forked node. Because gRPC talks to the full node directly, it **reflects forked state** (where no GraphQL indexer exists). The same resolvers overlay registry enrichment ("which entities are ours"). A Sui GraphQL indexer, when present (non-fork local), augments deep history/analytics.

The browser uses **dapp-kit** only for wallet connection + transaction signing — **not** for reading the chain (so the explorer stays fork-correct and uniformly typed through our schema). The router's permissive CORS (`["*"]` — `src/orchestrators/router/cors.ts`) still applies to the `/graphql` endpoint.

```
                         ┌─────────────────────────────────────────────────┐
   browser (SPA)         │  devstack process (supervisor)                  │
   apps/devstack-dashboard                                                  │
   ┌────────────────┐    │  ┌───────────────────┐  ControlPlane service:   │
   │ gql.tada client│◄───┼──┤ dashboard plugin  │◄─ projection ref +       │
   │  query /       │    │  │  Pothos GraphQL   │   event hub + commands   │
   │  mutation /    │───►┼──┤  (yoga on HTTP)   │   + Logger / registries  │
   │  subscription  │SSE │  │  + serves SPA     │                          │
   └───────┬────────┘    │  └─────────┬─────────┘                          │
           │             │            │ resolvers                           │
   ┌───────▼────────┐    │  ┌─────────▼─────────┐  gRPC (fork-safe)         │
   │ dapp-kit       │    │  │ @mysten/sui       │─► sui plugin / node       │
   │ wallet + sign  │────┼─►│ SuiGrpcClient     │   (GraphQL indexer        │
   └────────────────┘    │  └───────────────────┘    optional, non-fork)   │
                         └─────────────────────────────────────────────────┘
```

The dashboard reproduces the TUI's three seams as GraphQL operations:
1. `state: SubscriptionRef<SubscribableState>` → `subscription { state }` (+ an initial `query { state }`).
2. `events: Stream<EngineEvent>` → `subscription { engineEvents }` (and `subscription { logs }`).
3. `publish(command: EngineCommand)` → GraphQL **mutations** (one per command) returning the correlated ack/error.

---

## 2. Backend — the `dashboard` plugin

### 2.1 Plugin shape & precedent
Model it on the `wallet` plugin, which already runs an in-process HTTP server with port + route + CORS + endpoint emission:
- HTTP server primitive options: the repo's `listenScopedHttpServer` (`src/substrate/runtime/scoped-http-server.ts`, used by `wallet`/`faucet`) **or** the chosen `effect/unstable/http` stack. We use the latter.
- Port: `PortBrokerService.allocate(...)` (`src/substrate/runtime/port-broker/service.ts`), as `wallet` does via `ctx.allocatePort`.
- Clean hostname + CORS: `RouterService.contributeRoute(decl)` (`src/orchestrators/router/service.ts:204`) with `upstream: { type: 'host-loopback', port }`, `cors: true`. Template: `src/plugins/wallet/routable.ts` (`makeWalletRoutable`) + an `EntrypointDecl`.
- Endpoint emission: registering the route surfaces a `dashboard` `Endpoint` in the projection, so `devstack up` lists the dashboard URL in the TUI like any other service.

**New module layout** (`packages/devstack/src/plugins/dashboard/`):
- `index.ts` — `dashboard()` factory + plugin registration (resource id `'dashboard'`, singleton).
- `service.ts` — acquire body: allocate port, mount HTTP server (process-scoped, see 2.3), subscribe to ControlPlane, register route, emit endpoint.
- `server.ts` — HTTP host (`effect/unstable/http` / `NodeHttpServer`) mounting the GraphQL handler (graphql-yoga) at `/graphql` + `HttpStaticServer` for the SPA.
- `schema.ts` — the **Pothos** GraphQL schema: control/observability **queries**, command **mutations**, live **subscriptions**; resolvers run Effects against a plugin-scoped runtime.
- `subscriptions.ts` — bridge `SubscriptionRef.changes(state)` + the event/log streams into async iterables for the `state`/`engineEvents`/`logs` subscriptions (served over SSE via `graphql-sse`).
- `routable.ts` — `makeDashboardRoutable(...)` + `DASHBOARD_ENTRYPOINTS` (copy of wallet's).
- `explorer.ts` — gRPC-backed explorer resolvers (`@mysten/sui` `SuiGrpcClient`) + registry enrichment; optional Sui-GraphQL augmentation for deep history/analytics.

### 2.2 The one new substrate seam: `ControlPlaneService`
Plugins don't currently get the projection ref, event hub, or command dispatch — those live in the supervisor's internal `SupervisorState` (`ref`, `hub`, `queuedCommands` — `src/substrate/runtime/supervisor/state.ts`). Add a small **read/control service** the supervisor provides into the plugin-acquire context:

```ts
interface ControlPlaneService {
  readonly state: SubscriptionRef<SubscribableState>      // process-scoped; survives cycles
  readonly events: Stream<EngineEvent>                    // multicast subscription
  readonly publish: (c: EngineCommand) => void            // fire-and-forget (= makeQueueCommandPublisher)
  readonly runCommand: (c: EngineCommand) => Effect<void> // request/response (= handle.runCommand)
}
```

- It wraps handles the supervisor already owns (the projection `SubscriptionRef`, the event hub, `handle.commands`/`handle.runCommand` — see `src/cli/wirings/up.ts:476,516,519,533-540` and `start-supervisor.ts` `SupervisorHandle`).
- **Multicast events:** the current fanout offers `handle.events` into a single per-surface queue (`up.ts:536-540`). To let the dashboard plugin subscribe independently of the TUI, back the event distribution with a `PubSub` (or have `ControlPlaneService.events` register a fresh consumer). This is the "promote the event fanout to a hub" opportunity surfaced during exploration — small and principled.
- **Isolation:** it's just a context service; only the dashboard plugin requires it, so no other plugin is affected.

Everything else the dashboard needs is **already plugin-accessible**: `Logger` (ring buffers — `readAll`), `PackageRegistryService`/`CoinRegistryService`, `RouterService`, `PortBrokerService`, the `sui` plugin's `SuiClient`.

### 2.3 Lifecycle — survive restarts
The projection ref is **process-scoped and survives engine cycles** ("Stop-and-restart keeps the same ref; only `cycle.id` increments" — `src/substrate/runtime/projection/state-ref.ts`). To avoid the dashboard blinking on every `stack.restart`, **pin the HTTP listener to the process/runtime-root scope** (precedent: the router boots its shared Traefik container process-scoped) while the plugin registration is per-cycle. On restart the plugin re-subscribes to the same ref/hub; the browser sees `cycle.phase` go `restarting → running` with no disconnect. The frontend's reconnect logic is the safety net regardless.

`effect/unstable/http` / `listenScopedHttpServer` install graceful-close finalizers, so shutdown drains cleanly; PortBroker and `contributeRoute` release their resources via scope finalizers.

### 2.4 Enablement
Ship `dashboard()` as a **built-in plugin auto-included in the default member set** (so `devstack up` prints a dashboard URL with zero config), with a top-level config option / `--no-dashboard` flag to disable and `--dashboard-port` to pin. This keeps the "plugin like other services" model while preserving the native, zero-setup feel.

### 2.5 API surface — one Pothos GraphQL schema

The dashboard exposes a single GraphQL endpoint (`/graphql`) built with **Pothos** (code-first) and hosted by **graphql-yoga** on the plugin's HTTP server; the SPA consumes it with **`gql.tada`** (typed documents, no codegen). Resolvers execute Effects against a plugin-scoped runtime that has `ControlPlaneService`, the registries, the `Logger`, and a `SuiGrpcClient`.

**Subscriptions (server→client push, over SSE via `graphql-sse`):**
- `state` — initial snapshot (`SubscriptionRef.get`) then every `SubscriptionRef.changes(state)` value. The projection is fully serializable (`__ProjectionFieldsClosed` guard).
- `engineEvents` — the `EngineEvent` stream.
- `logs` — `log.appended` lines (optionally filtered by plugin/level/tag).

Each subscriber gets its own fiber + bounded queue (drop-oldest) so a slow tab can't stall the engine. A matching `query { state }` covers first paint / non-streaming clients.

**Mutations (commands → in-process dispatch via `ControlPlaneService.publish`/`runCommand`, no file round-trip).** One mutation per `EngineCommand` (tags verified in `src/substrate/events.ts`): `restart` (`stack.restart`), `restartPlugin(pluginKey)` (`selective-restart.requested`), `apply(pluginKey?)`, `codegen`, `captureSnapshot(name?)`, `restoreSnapshot(id)`, `deleteSnapshot(id)`, `prune`, `wipe`, `advanceClock(toMillis)` (fork only), `shutdown` (graceful `shutdown.requested` only — never `hardKillRequested`). These ride the same supervisor command path as the TUI keypresses (`makeSnapshotCommandHandler` in `up.ts`).

**Queries (read-models):**
- `state`, `accounts`, `packages`, `endpoints`, `errors`, `cycle`, `identity` — from the projection.
- `coins` → `CoinRegistryService.list()`; full `packages` → `PackageRegistryService.entries()` (incl. captured object ids); `routes` → `RouterService.applied`; `config` → resolved `DevstackOptions`; `logs`/`logTags` → `Logger.readAll`/`readTag` (already exist — `src/substrate/runtime/observability/logger.ts`); `snapshots` → snapshot catalog; `spans` → `SpanStore` (§2.6).
- `registry` — the enrichment maps (packageId/address/coinType → friendly name/kind/owning plugin) used to annotate explorer results.

**Explorer queries (chain — gRPC-backed, fork-safe):** `object(id)`, `transaction(digest)`, `address(addr)` (owned objects / coins / balances), `package(id)` (modules/functions/structs), `coin(type)`, `checkpoint`/`epoch`, and `search(term)` (route by shape). Resolved server-side through `SuiGrpcClient` against the local/forked node, with registry enrichment overlaid **in-resolver** (so the browser receives already-annotated entities). Deep historical lists/analytics resolvers additionally consult the Sui GraphQL indexer **when available** (non-fork local) and degrade otherwise.

### 2.6 Logs & spans
- **Logs:** no new Logger API needed — `readAll`/`readTag` exist; live lines also stream via the `logs` subscription (`log.appended`).
- **Spans/traces:** there is **no tracer/OTel/span store today** (95 files call `withSpan`/`spanWithLabels` but `up.ts`/`run.ts` provide no tracer, so spans are dropped). Add a lightweight additive **`SpanStore`** (`src/substrate/runtime/observability/span-store.ts`): a bounded ring buffer + a custom `Tracer` (`Tracer.make({...})`) whose spans index by the `SpanAttr` vocabulary (`devstack.plugin`/`endpoint.key`/`op`/`cycle.id` — `src/substrate/runtime/observability/spans.ts`). Register it as a layer beside `Logger.layer([])` at `up.ts:558`. No existing span call-site changes. Surfaces the **Traces** feature (a `spans` query/subscription). Phase-2 candidate.

### 2.7 Serving the SPA
- **Prod:** `HttpStaticServer` over the built `dist/`, with `HttpServerResponse.file(index.html)` fallback for client-side routes. `tsdown` is `unbundle:true`, so the surface resolves the asset dir from disk (`new URL(...)`); a devstack build step copies the dashboard `dist/` into devstack's published `dist/` and extends `package.json` `files`.
- **Dev:** run Vite dev server (HMR) on its own port; the SPA calls `/graphql` cross-origin (CORS already permissive) or the plugin proxies non-`/graphql` routes to Vite. Gate via env/flag.

---

## 3. Frontend — `apps/devstack-dashboard`

New Vite + React 19 + Tailwind v4 app, sibling of `apps/dev-wallet` (same toolchain; **most deps already in the catalog**: `@mysten/dapp-kit-react ^2.0.1`, `@mysten/dapp-kit-core ^1.3.0`, `@tanstack/react-query ^5.100.0`, `tailwindcss ^4.2.4`, `@tailwindcss/vite`, `@vitejs/plugin-react`, `react/react-dom 19`, `vite`). New catalog additions needed: a router (TanStack Router), `@tanstack/react-virtual`, a charts lib (recharts), and the GraphQL client stack — **`gql.tada`** + `graphql` + a transport (`graphql-sse` for subscriptions; queries/mutations via a fetch executor wrapped in react-query, or urql for both).

### 3.1 Tech & structure
- **Routing:** TanStack Router (type-safe search params — ideal for deep-linkable explorer routes and `/logs?plugin=…&level=…`).
- **Components:** **shadcn/ui (Radix + Tailwind)** — accessible primitives (dialog/command/tabs/table/toast/resizable) without hand-rolled a11y; copy-in, themeable via CSS vars. dapp-kit's `ConnectButton`/`ConnectModal` are also Radix-based → consistent.
- **Data / our API:** **`gql.tada`** for fully-typed GraphQL operations against our Pothos schema (no codegen). Execute via a fetch-based GraphQL client wrapped in **`@tanstack/react-query`** for queries/mutations (keys namespaced by `identity.network` so wipe/restart invalidates cleanly), and **`graphql-sse`** for the `state`/`engineEvents`/`logs` subscriptions. `@tanstack/react-virtual` for logs/long tables; recharts for analytics.
- **Chain via our API, not the browser:** explorer data is fetched through our **gRPC-backed GraphQL resolvers** (fork-safe, registry-enriched) — the browser does **not** query the chain directly. `@mysten/dapp-kit-react` is used **only for wallet connection + transaction signing**, with its network pointed at the local stack and reusing the existing **dev-wallet** adapter (`packages/dev-wallet` `react/` exports + `devstack-adapter`).

> **Sui SDK note:** "our API" = our **Pothos GraphQL** (distinct from Sui's GraphQL RPC). For chain reads we prefer **gRPC** (`@mysten/sui` `SuiGrpcClient`) **server-side**, because it hits the full node directly and so works on **forked** networks (the Sui **JSON-RPC** transport sunsets 2026-07-31 — avoid it). Sui's own GraphQL indexer is consulted only to augment deep history/analytics in non-fork local mode.

### 3.2 Reuse strategy (the core leverage)
- **Import the projection/event/command TYPES and the pure derivation directly from devstack** — `SubscribableState`, `Row`, `Endpoint`, `AccountProjection`, `PackageProjection`, `StructuredError`, `RowSection`, `LifecycleStatus` (`src/substrate/projection.ts`, `lifecycle.ts`); `EngineEvent`, `EngineCommand`, `SnapshotCaptureProgressPhase` (`src/substrate/events.ts`); and the entire `display-derivation.ts` + `event-log.ts` (`eventLogLineFromEvent`, `appendEventLogLines`, `EventLogLine`).
- **Browser-safe export:** the public barrel pulls in Effect/Node, so add a **`./display`** (and types) subpath export to devstack `package.json` `exports` (the map already uses subpaths; `display-derivation.ts`/`event-log.ts` are proven framework-free). Alternative: a Vite source alias. Small devstack change, high leverage — keeps TUI and web vocabulary from drifting.
- **`ColorToken → Tailwind`** single resolver module (`tokens.ts`): `'yellow'|'green'|'red'|'magenta'|'cyan'|'blueBright'|'white'` → semantic CSS-var/class pairs (green=ready, yellow=active/warn, red=failed, cyan=service, magenta=account/action, blueBright=package/snapshot, white=neutral). Dark-first, light variant.
- **`devstackClient.ts`** — the network analogue of the TUI's three props: `subscribeState()`, `subscribeEvents()`, `publish(cmd) → ack/error`, `connectionState`.

### 3.3 State management
- **Live projection** (single source of truth for control/observability) — one store fed by `subscribeState()`; all native panels render purely from it via the derivation helpers (no local mirrors). Event stream feeds a bounded `EventFeed` + per-tag log buffers (reuse `MAX_EVENT_LOG_LINES`/`appendEventLogLines`).
- **Chain queries** — typed `gql.tada` operations against our GraphQL API (gRPC-backed, fork-safe), cached/invalidated via react-query.
- **Registry enrichment** — composed **server-side** in the explorer resolvers (our package → friendly name + "published by this stack"; owner that's a known account → account ref), so the browser receives already-annotated entities and just renders the badges/links. Raw chain fields stay authoritative.
- **Commands** — issued only via `devstackClient.publish`; the UI waits for the projection/event stream to reflect the effect (TUI discipline) and toasts the correlated ack/error.

### 3.4 Design-system layer (component inventory — designer owns visuals)
**Tokens:** semantic color (incl. ColorToken-derived), spacing, typography (mono for ids/addresses/logs), radii, elevation; dark-first + light; density toggle.
**Primitives (shadcn/Radix):** Button, Tabs, Table (sortable/sticky), Dialog/AlertDialog, Popover, Tooltip, DropdownMenu, Command (palette), Toast, Badge, Skeleton, ScrollArea, Resizable, Sheet/Drawer, Input/Select, Switch, Collapsible, Breadcrumbs.
**Domain components** (each maps to a real shape): `StatusBadge` (LifecycleStatus via statusGlyph/Color/Label), `RoleChip`, `SectionChip`, `EndpointLink` (Endpoint; uses `endpointLine`/`visibleEndpointsForRow`), `AddressChip` (truncate+copy+link, impersonate flag), `CoinAmount` (decimals/symbol from coin registry; MIST/SUI), `PackageCard` (PackageProjection + "ours" badge), `AccountCard`/`FundingStatus` (AccountProjection.funding), `LogStream` (virtualized), `EventFeed` (curated via eventLogLineFromEvent + raw mode), `JsonTree`, `TxEffectsView` (balance/object changes/events/gas), `ErrorPanel` (StructuredError + `errorSummaryFor`), `SnapshotProgress` (reuse dashboard.tsx `snapshotPhaseLabel`/`SnapshotStatus`), `CopyButton`, `HealthDot`, `ConnectionIndicator`, `CommandPalette`, `ConfirmDestructive`.
**System states:** disconnected/reconnecting (freeze last projection dimmed, auto-reconnect; full snapshot re-sent on reconnect; distinguish bridge-down vs `cycle.phase==='shutting-down'`); loading skeletons; empty (`health==='empty'`); error tray from `state.errors` + inline `Row.lastError`.

---

## 4. Full UI / Feature inventory (design hand-off)

App shell: persistent left nav (collapsible), always-visible **status header** (identity, `cycle.id`+`phase` chip, `dashboardSummaryLine`, connection indicator, global search/command-palette), routed main content, dockable **activity/log drawer** (persists across routes), toast layer. Each area below: *purpose · data (mapped to real shapes) · interactions · states*. `(MVP)`/`(Later)` are phasing **hints**, not commitments.

**1. Overview / Home** `(MVP)` — Purpose: at-a-glance health + fast jumps. Data: `identity`, `cycle`, full `deriveDashboardSummary(state)` as headline tiles, status grid from `groupRows(rows,endpoints)` (each row `deriveDisplayCells`), endpoint quick-links (`state.endpoints`), recent activity (last N `EventFeed`), quick controls. Interactions: cell→`/services/:key`, endpoint open/copy, quick command buttons. States: booting/running/restarting/shutting-down/empty/blocked.

**2. Services / Plugins** `(MVP)` — Purpose: resource tables + per-plugin ops. Data: `state.rows` via `groupRows`; per row StatusBadge, phase narration (`narrationFor`), RoleChip, owner (`ownerForRow`), endpoints (`visibleEndpointsForRow`), error (`errorSummaryFor`), `selectiveRestartHighlight`, logTail truncation. Detail drawer (`/services/:key`): lifecycle/phase history (events filtered by `pluginKey`), endpoints, logTail + live log, errors, **controls** (selective-restart, restart), build progress (`state.stackBuild`). States: per-status visuals, acquiring spinner, failed ErrorPanel, restart highlight.

**3. Logs** `(MVP)` — Purpose: unified live console. Data: `log.appended` events + `Row.logTail` + per-tag `LogLine{tag,pluginKey,level,message,fields,at}`. Interactions: filter by plugin/level/tag, full-text search, pause/follow, expand `fields` (JsonTree), client-side download, clear. States: following/paused ("N new"), filtered-empty, virtualized.

**4. Activity / Events & Traces** `(MVP events / Later traces)` — Data (events): curated `EventFeed` (`eventLogLineFromEvent`, scope-colored by `RowSection`) + raw toggle (all `EngineEvent` tags); filter by plugin/scope/level/tag. Data (traces): span timeline filterable by `devstack.plugin/endpoint/op` — **needs the `SpanStore` seam (§2.6)**. Interactions: filters, jump-to-source (event→`/services/:key`, snapshot→`/controls`).

**5. Accounts & Wallet** `(MVP; export Later)` — Data: `state.accounts` (`AccountProjection`: name/address/scheme/source/walletVisible/funding{status,balanceMist,requestedMist,entries[]}) via `accountCells`+`FundingStatus`; live balances/owned-objects/tx-history from chain plane keyed by address. Per-account: registry facts + live chain reads; impersonation labeling (`source==='impersonate'`); inline faucet control. Wallet connect: dev-wallet adapter (pairing token in URL fragment, constant-time bearer). Export keypair: ephemeral only, guarded, loud warning. States: funding pending/funded/already-satisfied/skipped/failed ("✓ cached" vs "✓ funded"); address `<pending>`; wallet connected/not.

**6. Faucet** `(MVP)` — Data: target = AccountProjection or pasted address; coins from coin registry + per-coin faucet (SUI always; WAL when Walrus exchange exists; DEEP when Deepbook funding present); faucet URL from endpoints; typed errors (`FaucetExhausted`/`Unreachable`/`BodyError`). Interactions: pick target+coin+amount→request; history; retry/backoff. States: idle/requesting/success(new balance)/exhausted/unreachable/body-error; per-coin gating.

**7. Sui Explorer (full suiscan-like)** `(MVP core + Later breadth)` — Purpose: a Sui explorer over the **local/forked node**, registry-enriched. Data access: our **gRPC-backed GraphQL API** (resolved server-side; **fork-safe**); Sui's GraphQL indexer augments deep history/analytics when present. Sub-areas:
- **Home / network stats:** epoch + progress, TPS, total tx, reference gas price, total staked, checkpoint height; latest-transactions feed; latest-checkpoints feed; analytics charts (tx/day, active accounts, packages) — *current-state via gRPC works on forks; deep history/analytics need an indexer (non-fork local)*.
- **Transaction detail:** status, sender, timestamp, certifying checkpoint, gas (computation/storage/rebate/budget/price), events (typed), balance changes, object changes, PTB/inputs, raw effects — via `TxEffectsView`.
- **Object detail:** id, full Move type, owner, version + previous-tx, fields (recursive JsonTree), dynamic fields/children (paginated), related txs, version history.
- **Address/account:** SUI + coin balances, owned objects split Coins/NFTs (+media), tx history (paginated), staked SUI.
- **Package:** modules → functions (signatures/visibility/entry) + structs/datatypes, normalized ABI, bytecode/disassembly, dependencies, version history — **our packages highlighted/friendly-named** (`state.packages`), "published by this stack" badge linking to owning plugin/account.
- **Coin/token:** metadata (symbol/decimals/icon), total supply, holders, treasury/cap — registry-enriched.
- **Checkpoints / epoch / validators:** browse + detail.
- **Global search:** resolve digest/object-id/address/package/coin/checkpoint by shape; SuiNS.
- **Registry enrichment:** `useRegistryEnrichment()` overlay. States: per-panel skeletons, not-found, **indexer-unavailable degraded mode**, mode-aware banners (local/fork/live).

**8. Plugin-specific panels** `(Later, per plugin; gated on presence)` — under `/plugins/:domain`:
- **deepbook:** pools table (pairs, tick/lot/min), `registryId`/`adminCap`, order book / seed-liquidity, Pyth feed status, DEEP funding, market-maker toggle/status.
- **walrus:** cluster node health (+ aggregator/publisher/proxy URLs from endpoints), blob upload/aggregator test, WAL exchange/faucet.
- **seal:** key-server status, mode, object id, policies.
- **postgres:** copyable DSN, health.
- **package:** publish status, captured object ids, `upgradeCapId`, publisher, `sourcePath`.
- **coin:** registry table (`CoinValue`) + **mint control when `treasuryCapId` present**.
Control actions route via `publish` or direct dapp-kit tx.

**9. Controls / Operations** `(MVP)` — Commands (all `EngineCommand`, §2.5): restart, selective-restart, snapshot capture(name)/list/restore/delete, apply, codegen, prune, wipe, advance-clock (fork only — gate on `sui.fork`), shutdown. Snapshot panel: list from `SnapshotCatalogEntry[]` (id, label, createdAt, participants, containers, hostTreeIncluded); **live progress** via `SnapshotProgress` (reuse `snapshotPhaseLabel` + `snapshot.*` events). Destructive ops (wipe/prune/restore/delete) → `ConfirmDestructive`. States: in-progress (disabled+spinner from progress events), success, failed (error reply), skipped (capture running), advance-clock disabled outside fork.

**10. Config inspector** `(MVP-light)` — Data: identity, resolved members/modes/ports/funding plans, full endpoints registry (`endpointKey`, `pluginKey`, `wireProtocol`, `registeredAt`), copy helpers. States: read-only, live-updates on endpoint register/release.

**11. Cross-cutting** `(MVP)` — Command palette / global search (Radix Command: jump to any plugin/account/package/endpoint + explorer entity by id + command actions); copyable ids everywhere; connection/health indicator (bridge `connectionState` + `cycle.phase` + `health`); toasts (command ack/error + `error.reported`); keyboard shortcuts mirroring the TUI (`r` restart, `s` snapshot, `q` shutdown-with-confirm, `/` search, `?` help — see `src/surfaces/tui/input.tsx`); responsive + light/dark.

---

## 5. Minimal-change accounting

**New files/modules (devstack):**
- `src/plugins/dashboard/{index,service,server,schema,subscriptions,routable,explorer}.ts` — the plugin (Pothos schema + gRPC explorer resolvers).
- `src/substrate/runtime/control-plane/service.ts` — `ControlPlaneService` (wraps projection ref + event multicast + command dispatch).
- `src/substrate/runtime/observability/span-store.ts` — `SpanStore` + collector tracer (Traces; phase-2).

**New app:** `apps/devstack-dashboard/` (Vite+React+Tailwind SPA, mirrors `apps/dev-wallet`).

**Small touch-points in existing files:**
- Supervisor wiring (`src/cli/wirings/up.ts` / `start-supervisor.ts`): construct + provide `ControlPlaneService` into the plugin-acquire context; promote the event fanout (`up.ts:536-540`) to a multicast hub/PubSub.
- Register `dashboard()` in the default member set + add disable flag (`--no-dashboard`) and `--dashboard-port` (`src/surfaces/cli/command-tree.ts` + flags).
- `up.ts:558`: add the `SpanStore` tracer layer next to `Logger.layer([])` (phase-2).
- `src/substrate/runtime/observability/index.ts`: export `SpanStore`.
- `packages/devstack/package.json`: add `./display` (+ types) subpath export; add the GraphQL server deps (`@pothos/core` + plugins, `graphql`, `graphql-yoga`); add dashboard build to scripts + `files` (embed SPA dist).
- `pnpm-workspace.yaml` catalog: server-side `@pothos/core` (+ plugins), `graphql`, `graphql-yoga` (devstack deps); client-side `gql.tada`, `graphql`, `graphql-sse`, TanStack Router, `@tanstack/react-virtual`, recharts (dashboard app deps).

**Explicitly avoid:** `@effect/rpc` (the Pothos GraphQL API + SSE subscriptions cover client/server typing); querying the chain from the browser (breaks fork-correctness — go through gRPC-backed resolvers); `@effect/opentelemetry`/real exporter (the in-memory `SpanStore` suffices); changing the projection field set (trips `__ProjectionFieldsClosed`); bundling SPA into the `tsdown` bundle (`unbundle:true` — serve from disk).

---

## 6. Suggested phasing (finalize after reviewing the full design)
1. **Foundation:** `ControlPlaneService` + dashboard plugin (HTTP server, route, SSE stream, command POSTs) + `apps/devstack-dashboard` shell + `devstackClient` + `./display` export + ColorToken→Tailwind.
2. **Devstack-native panels:** Overview, Services + detail drawer, Logs, Activity (events), Controls + snapshot progress, Config.
3. **Accounts & Faucet:** account list + live balances, dev-wallet connect, faucet controls.
4. **Explorer (full):** core lookups + global search + registry enrichment first, then history/checkpoints/analytics (depends on local GraphQL indexer; ensure it's on in local mode, degrade in live/fork).
5. **Plugin panels + Traces:** deepbook/walrus/seal/coin-mint/etc.; `SpanStore` + traces timeline; charts.

---

## 7. Verification

- **Backend, in-isolation:** start a stack (`pnpm --filter @mysten-incubation/devstack ...` / local Docker per repo conventions); hit `/graphql` — `query { state { cycle { phase } } }` returns, the `state` subscription (SSE) pushes updates, `mutation { restart }` flips `cycle.phase`, and a `logs` query returns tag buffers. Confirm the `dashboard` endpoint appears in the TUI's endpoint list (route emission works).
- **Restart survival:** with an open `state` subscription, trigger `restart`; the SSE connection stays up and `cycle.id` increments (validates process-scoped listener + ref).
- **Frontend dev:** `pnpm --filter devstack-dashboard dev`; load the SPA against a running stack; verify Overview/Services/Logs render from the live subscription and a control button round-trips an ack toast.
- **Explorer (fork-safe):** run a **forked** stack; issue explorer GraphQL queries (`object`/`transaction`/`address`/`package`) and confirm they resolve via gRPC against the fork's diverged state, with our published packages showing the "published by this stack" badge (server-side enrichment). Confirm deep-history/analytics degrade gracefully when no indexer is present.
- **Reuse integrity:** assert the SPA imports `display-derivation` via the `./display` export and that the existing TUI tests still pass (no display-vocab drift). Run the repo typecheck/tests once after wiring (orchestrator sweep, not per-agent).
- **Packaging:** `pnpm --filter @mysten-incubation/devstack build` includes the SPA `dist/`; a packed-consumer smoke (`smoke:pack-consumer`) still resolves.

---

## 8. Open risks / notes
- **GraphQL ⇆ Effect host:** confirm the executor host (graphql-yoga vs a thin graphql-js handler on `effect/unstable/http`) and how resolvers run Effects (a plugin-scoped runtime via `Effect.runPromise`); pick the `gql.tada` client transport (fetch + react-query for queries/mutations, `graphql-sse` for subscriptions, vs urql for both). Pothos plugins to consider: errors, dataloader, simple-objects.
- **Indexer is optional, not required:** gRPC covers current-state + recent reads on every mode (incl. forks); only deep historical lists/analytics need a local Sui GraphQL indexer. Surface a clear degraded state when it's absent rather than failing.
- **gRPC on forks:** validate `SuiGrpcClient` reads reflect forked/diverged state (objects/txs created post-fork) against the fork node, and that node retention covers what the explorer reads.
- **Event multicast:** promoting the single-queue fanout to a PubSub is the one slightly-more-than-trivial substrate change; it's already an identified cleanup and benefits future surfaces too.
- **Auth:** loopback-bind, no auth by default (dev tool; the dashboard itself has no signing capability — signing is delegated to the dev-wallet). Revisit if exposed beyond localhost.
- **Wallet-protocol hoist:** the dashboard becomes a 3rd consumer of the dev-wallet contract — reinforces the in-code TODO to hoist the wallet protocol into a shared package.
