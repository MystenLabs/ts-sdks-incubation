# 23 Build Integrations (distilled)

## Purpose

The thin layer of devstack that lets external build tools — Vite, Vitest, Playwright, browser-side
runtime bundles — and apps consume the devstack supervisor's artifacts (manifest, account keys,
endpoint URLs) without reaching into engine internals. Each integration collapses the user's
build-tool config to a single one-call helper and exposes the in-spec helpers the app's tests /
runtime code need to talk to the live stack.

Today this lives across five sub-directories (`src/vite`, `src/vitest`, `src/playwright`,
`src/browser`, `src/runtime`) totaling ~3.5k LOC; the runtime substrate alone is ~2.3k of that.

## Integrations covered

- **Vite** — dev-server + bundler config preset; bakes in framework plugins, port wiring,
  traefik-friendly HMR, per-stack manifest alias.
- **Vitest** — minimal config preset (canonical include/exclude + `passWithNoTests`); declares
  `@effect/vitest` as an optional peer for the in-test layer pattern; no devstack lifecycle.
- **Playwright** — config preset + low-level `webServer` / `baseURL` resolvers + in-spec UI helpers
  (`connectAs`, `selectAccount`) + artifact loaders (`loadStackManifest`, `loadStackKeypair`).
- **Browser** — a tiny side-subpath that re-exports the small slice of devstack values safe to
  evaluate in a browser bundle (no `node:*` imports at module init).
- **Runtime (manifest substrate)** — schema, emit, discover, read, project, and conventional-route
  fallback for the on-disk manifest that every consumer (build integrations, codegen, CLI, tests)
  keys off.

## Consumer-of-devstack principle

Build integrations are downstream of the engine. The seam is the **artifact set** devstack emits:

What flows in (from devstack):

- The on-disk manifest at `.devstack/stacks/<stack>/manifest.json` (endpoint URLs, package ids,
  accounts, coins, app extras, identity).
- Per-account key files under `runtime/accounts/<name>.key`.
- Conventional-route metadata (host pattern + entrypoint port) for cold-start fallback before the
  manifest exists.
- A small set of environment variables the supervisor sets when it spawns the build tool (`PORT`,
  `DEVSTACK_STACK`, etc.).
- A global slot (`globalThis.__devstackDAppKit__`) populated by the app's own runtime code at module
  init.

What integrations own:

- Tool-specific config defaults (Vite plugins, Vitest include globs, Playwright `testDir` /
  parallelism, graceful-shutdown wiring).
- Manifest discovery (walk-up from the test/cwd to find the stack-scoped file).
- Cold-start URL fallback when the manifest isn't on disk yet.
- The browser/Node bundle partition (which exports are safe to evaluate in a browser bundle).
- In-spec UI flows (clicking the dev-wallet connect button, switching accounts via the global slot).

Integrations do not subscribe to engine events, do not register plugins, do not call into the
supervisor at runtime. They are passive readers of files + env + a global slot.

## Runtime manifest substrate

The largest and most ambiguous piece. It IS:

- The single source of truth for the on-disk manifest shape (a `Schema`-defined record covering
  `stack`, `services`, `packages`, `accounts`, `coins`, `app`, including nested per-service shapes).
- The **producer**: an Effect that, given Identity and ~14 service registries, gathers a snapshot,
  encodes through the schema, and atomically writes the file at supervisor acquire-time; forks a
  slow-tick repeater to catch late registrations; runs a final flush on scope close.
- The **consumer surfaces**: a sync reader (used by Playwright's config-load) and an Effect reader
  (used by CLI / codegen). Both walk-up from a cwd to find a stack-scoped manifest, schema-decode,
  surface structured `ManifestDiscoveryError` / `ManifestShapeError`, and project to a flat
  per-endpoint accessor.
- A **conventional-route table** derived from endpoint declarations: given an endpoint name and a
  stack/app, returns the `<stack>.<service>.<app>.localhost:<port>` cold-start URL when no manifest
  exists yet.
- The **endpoint-name declaration registry** that maps each well-known endpoint (sui-rpc,
  sui-faucet, walrus-aggregator, etc.) to its manifest-field path, its conventional host pattern,
  and its symbolic constant exported to consumers.

Why it's ~2.3k LOC: it carries the full manifest schema, an Effect-based producer with scope-aware
finalization, two reader surfaces (sync + Effect), a discovery resolver with multi-source precedence
(env > override > walk-up), a conventional-routes derivation, and the endpoint metadata registry.
Plus its tests, which are the contract.

### The scope ambiguity (load-bearing for the redesign)

The current code places `runtime/` under build-integrations, but it straddles three of the goals
doc's layers:

- The **write path** (emit + gather) is supervisor-lifecycle code: it needs `Scope`, it reads engine
  state registries, it runs as part of bringing the stack up. That's L3 (orchestrator) or even
  engine-adjacent.
- The **read path** (discover + readStackContext + conventional URL) is pure consumer code: it lives
  in surface-level helpers (Playwright config-load, CLI commands, codegen emitters). That's L4 / L5.
- The **shape itself** (manifest schema + endpoint name declarations) is shared substrate that both
  sides need to agree on — neither obviously a producer nor a consumer.

The goals doc flags this as symptom #10 ("runtime substrate is cross-cutting and underdesigned —
`src/runtime/` touches L3, L4, L5 without a clear home"). The brief makes the same point at top: the
runtime substrate sits ambiguously between L3 orchestrator and L5 consumer.

Consequence for the redesign: at least three plausible splittings exist — (a) keep everything under
"manifest" as a single shared module shared between engine and surfaces; (b) split write-path into
the supervisor / snapshot orchestrator and keep read-path here; (c) put the schema + endpoint
declarations into a third shared module and have producer + consumers each depend on it. The
architecture must pick one explicitly rather than letting `runtime/` grow as a junk drawer again.

## Per-integration requirements

### Vite

What it needs:

- The supervisor's port assignment via `$PORT` env (must override the preset's fallback so
  concurrent stacks don't collide).
- The active stack name via `DEVSTACK_STACK` (selects which manifest file the per-stack alias points
  at).
- A predictable on-disk location for the stack's manifest file (so the alias can resolve a
  hard-coded path emitted by codegen).
- Traefik routing assumptions: a known wildcard host suffix and HMR port pinned to the router's
  public port.

What it produces:

- A single `UserConfig` object containing bundled framework plugins, the per-stack manifest alias,
  ES2022 targets, the `*.localhost`-friendly host allowlist, HMR over the router, and a watch ignore
  for `.devstack/` to avoid reload loops on each manifest tick.

How it hooks in:

- The app's `vite.config.ts` is one call to the preset; the app may pass extra plugins to append and
  an `extend` block whose top-level keys win.

### Vitest

What it needs:

- Just the user-supplied test overrides. No env reads, no I/O, no devstack lifecycle.
- `@effect/vitest` declared as an optional peer so the in-test `it.layer(stack.layer)` pattern works
  without the preset itself pulling it in.

What it produces:

- A `ViteUserConfig` with canonical include/exclude (excludes `e2e/**`) and `passWithNoTests: true`.

How it hooks in:

- The app's `vitest.config.ts` is one call to the preset. Devstack does NOT boot inside vitest via
  this preset — the test file is expected to drive its own lifecycle via `@effect/vitest`'s
  `it.layer`. (A historical `withDevstack(handle)` shim was removed; the header comment also
  references an `out-of-band setup-devstack.ts` file under `playwright/` that doesn't exist
  anywhere.)

### Playwright

What it needs:

- The same manifest as Vite (to compute `webServer.url` and `use.baseURL`), but with a **cold-start
  fallback** to a conventional URL when the manifest isn't on disk yet — Playwright config-load runs
  BEFORE the supervisor spawns to write the manifest.
- Per-account key files alongside the manifest (for in-spec `loadStackKeypair`).
- A global slot populated by the app's `dapp-kit.ts` (for in-spec `connectAs` to drive the
  dev-wallet flow).
- Knowledge that the dev wallet is selectable by a literal label, and that account switching goes
  through the global slot rather than a click.

What it produces:

- A canonical `PlaywrightTestConfig` (workers 1, fullyParallel false, `testDir: './e2e'`, CI-aware
  reporter/retries/forbidOnly, graceful-shutdown wiring with a SIGTERM + 10s timeout).
- `webServer` + `baseURL` low-level resolvers.
- In-spec helpers (`connectAs`, `selectAccount`) and artifact loaders (`loadStackManifest`,
  `loadStackKeypair`).
- Re-exports of `test` and `expect` from the underlying runner.

How it hooks in:

- The app's `playwright.config.ts` is one call to the preset; in-spec helpers are imported from the
  same subpath.
- The spawned `pnpm dev` (default `command`) brings up the supervisor, which writes the real
  manifest. Playwright polls `webServer.url` until reachable.

### Browser

What it needs:

- A partition of the devstack exports such that nothing imported by the browser subpath transitively
  imports a `node:*` module at module init.

What it produces:

- A small re-export surface (today: walrus-options helpers + their types).

How it hooks in:

- App browser code imports from the devstack browser subpath instead of the main barrel.
- The hygiene check today is manual (inspect the built bundle for `import "node:*"` lines); should
  become automated.

### Runtime

(See "Runtime manifest substrate" above for what it IS; this section is what it requires of devstack
and what it provides.)

What it needs from the engine / supervisor side:

- A canonical Identity (stack, app, network).
- A set of service registries it can read at gather time. Today these are ~14 typed registries — the
  new architecture should reduce that to a contract the engine collects from per-service
  `Snapshotable`
  - `Endpoint` capabilities, so the substrate doesn't import service names.
- An "extras resolved once" capability so that user-supplied `() => ({...})` extras produce the SAME
  blob on every read across manifest write, codegen emit, and dapp-kit config.
- Atomic-write + JSON-bigint helpers, structured manifest errors, and the endpoint-declaration
  registry on the read side.

What it provides:

- The manifest file (atomic, mode 0o600) and the read/discover/project surfaces every consumer keys
  off.
- Cold-start URL fallback for endpoints that have a conventional pattern.

## Lifecycle states

- **Vite / Vitest preset call**: synchronous, idempotent, no I/O at call time (Vite reads env).
  Returns a config object. No teardown.
- **Browser subpath**: import-time only. Pure re-exports.
- **Playwright config-load** (host process):
  - Synchronous resolve of `webServer.url` / `baseURL`: try manifest via discover-walk-up; on
    `ManifestDiscoveryError`, fall back to a conventional URL; on `ManifestShapeError`, rethrow with
    the structured recovery recipe.
- **Playwright `webServer` runtime**:
  - Playwright spawns `command` (`pnpm dev` by default), stamps `PLAYWRIGHT=1` into child env, waits
    for `webServer.url` to respond up to `timeout`, runs tests, sends SIGTERM at teardown with a 10s
    grace before SIGKILL.
- **Manifest emit** (supervisor scope):
  - **acquire**: read Identity + resolve extras-once, eager snapshot-and-write, atomic rename, chmod
    0o600, fork a slow-tick repeater (default ~500ms).
  - **during lifetime**: repeater picks up late-registered state (e.g. wallet endpoint that lands
    after acquire); each tick re-runs gather + encode + atomic-write-if-changed.
  - **finalize**: on scope close, run one final snapshot-and-write to capture teardown-time
    mutations.
- **Manifest read** (any consumer): no lifecycle; each call is independent.

## Inputs / dependencies

- **Engine state**: Identity, service registries, the `defineEndpoint` declaration registry, the
  "extras resolved once" capability.
- **Engine helpers**: atomic-write, JSON-bigint serializer, structured manifest errors.
- **External tools (peer-optional)**: Vite + framework plugins, Vitest, `@effect/vitest`,
  Playwright, `@mysten/sui` cryptography for keypair loading.
- **External contracts**: the dApp Kit web-component / wallet-label contract (selectors + literal
  `"Dev Wallet"` label), the `globalThis.__devstackDAppKit__` slot the app populates.
- **Environment**: `PORT`, `DEVSTACK_STACK`, `DEVSTACK_STATE_DIR`, `DEVSTACK_MANIFEST_PATH`, `CI`,
  `PLAYWRIGHT`.
- **Filesystem**: the stack-scoped manifest path under `<stateDir>/stacks/<stack>/`; per-account key
  files under `runtime/accounts/`.

## Outputs / capabilities provided

- A single-call config helper per tool (`defineDevstackXxxConfig`).
- Low-level `webServer` / `baseURL` resolvers reusable outside the preset.
- In-spec UI helpers (`connectAs`, `selectAccount`) and artifact loaders (`loadStackManifest`,
  `loadStackKeypair`).
- A browser-safe re-export subpath.
- The on-disk manifest file (the only persistent artifact this slice writes).
- Structured errors (`ManifestDiscoveryError`, `ManifestShapeError`) with embedded recovery recipes.
- Conventional URL fallback for endpoints declared with a conventional pattern.

No events, no state-store entries, no CLI commands, no Effect Layer.

## Invariants and constraints

Stable artifact paths and shapes

- Manifest lives at `<stateDir>/stacks/<stack>/manifest.json`. The `main` stack also has a
  backwards-compatible flat path that the Vite alias special-cases. Stack-scoped path is the only
  one discover walks; a stale flat manifest must NOT be returned.
- Manifest file mode is 0o600 (extras may be sensitive).
- Manifest writes are atomic (tmp + rename) so every consumer's sync `readFileSync` can't race a
  truncate-and-rewrite.
- Schema-encode happens BEFORE serialize so shape mismatches fail at write time with the offending
  field path, not later as invalid JSON downstream.

Snapshot-survivable / idempotent re-emit

- Each tick re-emits via write-if-changed; identical content is a no-op. The manifest is fully
  regenerable from the registries on the next supervisor run (it's not the source of truth, the
  registries are).
- Late-registered state lands in the next tick or in the final-flush finalizer; consumers see
  at-least-eventually-consistent state.

No-restart on harmless changes

- Vite's watcher MUST ignore `.devstack/**` (else the 500ms manifest tick triggers a full reload
  loop).
- The repeater is throttled (~500ms default) and uses write-if-changed; consumers polling the file
  don't get spurious inode changes.

Build-tool wiring (each is load-bearing)

- `$PORT` must win over the Vite preset's port option (supervisor port allocator is authoritative).
- Vite host allowlist must include `.localhost` and HMR clientPort must equal the router's public
  port.
- Vite + esbuild targets must be ES2022 (top-level await + dapp-kit peers).
- Playwright workers=1, fullyParallel=false (single supervisor per stack; parallel tests would
  contend on shared faucet/wallet/RPC).
- Playwright `gracefulShutdown` SIGTERM + 10s — load-bearing for process-tree cleanup; without it
  the default SIGKILL-on-shell orphans vite + supervisor descendants holding ports.
- `webServer.url` must be settable at config-load time even when no manifest exists (cold-start
  fallback).
- Malformed manifest must produce a structured `ManifestShapeError` with a recovery recipe; no NPE
  downstream.

Boundary partition

- Browser subpath must not pull in `node:*` modules at module init. Today verified manually by
  inspecting the built bundle.

Slot + selector contracts

- The dev-wallet is matched by literal label.
- The dApp Kit web-component names are matched by literal selectors.
- The `globalThis.__devstackDAppKit__` slot is populated by the app, read by `connectAs`. Renames
  upstream silently break all consumers' e2e.

Endpoint naming

- The endpoint-name string constants are the contract between emitters, manifest schema fields,
  codegen, and Playwright helpers. Renames must be intentional.

## Edge cases and known failure modes

- **Cold-start with no manifest**: Playwright falls back to a conventional URL. The fallback can lie
  silently if the supervisor's eventual manifest disagrees with the conventional URL (different
  stack, different port). Convergence is an unenforced convention.
- **Endpoint with no conventional fallback** and no manifest: throws a clear error listing supported
  endpoints. The supported list is today hard-coded in the error message rather than derived from
  the declaration registry.
- **Endpoint name typo in user spec**: throws a clear "no endpoint X in manifest" with a hint to
  check the plugin that should emit it.
- **Malformed / corrupt manifest**: structured `ManifestShapeError` with `phase: 'shape' | 'parse'`
  and embedded `rm … && devstack apply` recovery recipe.
- **Manifest write failure during runtime** (disk full, EACCES): caught + logged at warning level,
  returns false, next tick retries. Reader sees stale data with no warning channel. Repeated
  failures don't degrade or alert.
- **`reuseExistingServer: !CI`**: on a dev machine a stale supervisor can make tests pass against
  yesterday's state. CI always spawns fresh.
- **`@effect/vitest` not installed** but imported by the user's config: load-time
  `Cannot find package` error with no devstack-side warning beyond the optional-peer flag.
- **Vite optional peer missing**: importing the Vite subpath without Vite installed gives a
  load-time error.
- **`globalThis.__devstackDAppKit__` not populated**: `connectAs` throws with instructions. No
  type-system help on the app side.
- **`loadStackKeypair` for an unfunded account**: ENOENT with a guiding "run devstack up" recovery.
- **Test process killed without graceful shutdown**: orphans vite. The gracefulShutdown wiring
  protects Playwright-driven runs; other launchers must do their own propagation.
- **Concurrent vite outside the supervisor**: both pick the option fallback port; EADDRINUSE. Each
  example app picks a distinct fallback to mitigate.

## Learnings from current implementation

- **A single-helper "config preset" is the right shape** for these integrations — it collapses every
  example app's config to one line and centralizes the load-bearing wiring (port precedence, HMR,
  allowedHosts, ES2022, graceful shutdown). The cost of the abstraction is small and the savings are
  large.
- **The manifest is the right cross-process seam.** A file at a known path with a schema-decoded
  shape lets sync readers (Playwright config-load) and Effect readers (CLI / codegen) share the same
  contract without sharing process / memory.
- **Atomic write + write-if-changed + slow-tick repeater + final flush** is the right shape for the
  producer. The repeater catches late registrations; the final flush captures teardown-time
  mutations; the if-changed avoids inode churn.
- **"Resolve once" for extras** is load-bearing. A bug class where `() => ({ts: Date.now()})`
  returned divergent values across manifest and codegen artifacts was fixed by memoizing at
  infra-layer build time. The new architecture must preserve a single "extras resolved" capability
  shared by every artifact producer.
- **Cold-start fallback** is necessary because Playwright config-load predates the supervisor. The
  conventional-route table is the right shape for it; but its convergence with the eventual manifest
  must be enforceable (today it's a comment, not a test).
- **Structured errors with embedded recovery recipes** turn shape / parse / missing errors into
  actionable signals instead of downstream NPEs.
- **Stack-scoped paths only** — a stale flat manifest must NOT be returned. The current code learned
  this and the regression test pins it.
- **A browser subpath is necessary** because the main barrel pulls in node-only modules whose
  module-init reaches `node:fs` / `node:path`. Even when bundlers externalize them, every property
  access throws at module init.
- **Endpoint metadata in three places (declaration, structured projection, flat lookup) is a
  divergence trap.** The redesign should drive all three from a single declaration.
- **The vitest preset doesn't pull its weight** today — it's a 17-line defaults shim. Either remove
  it or make it actually drive a lifecycle (the deleted `withDevstack` shim's role).
- **Graceful-shutdown wiring at the Playwright layer fixed a real bug** (default SIGKILL-on-shell
  orphaned vite + supervisor). The new architecture must keep this seam explicit and tested as a
  process-tree integration, not just a config-shape unit test.

## Cross-component references

- **Engine core / engine-resources** — provide Identity, atomic write, JSON-bigint helpers,
  structured manifest errors, the `defineEndpoint` registry, and the "extras resolved once"
  capability.
- **Codegen** — consumes `gatherManifest` + `EndpointName` to emit `extras.ts`,
  `dapp-kit-config.ts`, `stack-handle.ts`. The extras-resolved-once invariant is shared with
  codegen.
- **CLI** — consumes the Effect-flavored `readStackContext` for `status`, `manifest`, and similar
  commands.
- **Snapshot orchestrator** — manifest is regenerable from registries per the goals doc; not part of
  the snapshot directly, but the account key files this slice reads ARE part of snapshot.
- **Router** — owns the traefik routing the Vite preset assumes (host allowlist, HMR clientPort,
  `*.localhost` resolution).
- **Wallet / dev-wallet** — owns the `Dev Wallet` label and the account-switch flow that `connectAs`
  drives.
- **Every service plugin** — produces the registry entries `gatherManifest` reads; the new
  architecture should collect these through a `Snapshotable` / `Endpoint` capability rather than
  importing per-service registries by name.

## Open questions / decisions deferred

- **Where does `runtime/` live in the new layer model?** (Goals symptom #10.) Plausible options:
  keep one shared manifest module; split write-path into the supervisor or snapshot orchestrator and
  keep read-path with consumers; pull schema + endpoint declarations out as a third shared module.
- **Does the engine know endpoint names at all?** The `defineEndpoint` declaration registry is
  engine-level today but every well-known endpoint name is service-specific. The "engine knows zero
  service names" rule suggests endpoint metadata should live with plugins; the substrate should walk
  a plugin-emitted registry instead.
- **What's the vitest lifecycle?** Should the preset (re)gain a devstack-bring-up role (matching the
  deleted `withDevstack`), or is the test file's `@effect/vitest`'s `it.layer(stack.layer)` the only
  path? The header comment also references an out-of-band `setup-devstack.ts` that doesn't exist.
- **How is cold-start URL convergence enforced?** Currently a comment. The redesign should either
  test it (`for each endpoint, conventional URL == manifest URL`) or collapse to a single derivation
  that can't drift.
- **Should the manifest carry a version field** so cross-version reads produce a typed "manifest
  version mismatch" instead of a generic shape error?
- **Should the Vite preset honor `DEVSTACK_STATE_DIR`** (today only discover honors it; Vite
  hard-codes `./.devstack/`)?
- **Should the Vite preset support non-React frameworks** rather than hard-coding `react()` +
  `tailwindcss()`?
- **Where does `sdk-coin` live** — under coin/ or in the manifest substrate (it's a pure projection
  that bridges devstack's coin shape to the SDK shape)?
- **`SUI_CHECKPOINT_VOLUME`** endpoint declared but unused — keep until sui-fork lands, or drop and
  reintroduce later?
- **Should `globalThis.__devstackDAppKit__`** be replaced by a typed helper export (e.g.
  `registerDevstackDAppKit(kit)`) so the slot name and contract live in one module?
- **Should the spec `connectAs` selector contract live with dev-wallet** instead of with the build
  integrations (it's a UI contract, not a build-tool concern)?
- **Should `webServer.command` default detect the lockfile** (pnpm / npm / yarn) rather than
  hard-code `pnpm dev`?

## Opportunities noticed

- **Consolidate endpoint metadata to one declaration.** Today the endpoint name, manifest-field
  path, conventional host pattern, and flat-lookup mapping are split across three sites; the
  substrate should drive all three from `defineEndpoint`.
- **Lift "manifest substrate" into a shared module the new engine / surfaces both depend on**,
  rather than a `runtime/` directory inside the build-integrations slice. Resolves the L3/L5
  ambiguity.
- **Replace the manual browser bundle hygiene check** with an automated test that inspects the built
  browser bundle for `node:*` imports.
- **Replace the tree-shaking-defense IIFE** in conventional-routes with an explicit value-import
  path that bundlers cannot strip.
- **Drop the vitest preset** (inline its defaults at each call site) OR extend it to actually drive
  a devstack lifecycle. Either is better than the current shim that earns little.
- **Surface manifest write failures** as a real warning channel rather than `log + return false`;
  repeated failures should degrade loudly or tear the supervisor down.
- **Add a `manifestVersion` field** and an explicit "wrong version" error path with a migration
  recipe.
- **Generate the supported-endpoints list in cold-start error messages** from the declaration
  registry; today it's a hard-coded literal that drifts.
- **Factor a shared test helper** for env-var save/restore + tmpdir setup/teardown used in at least
  five test files in this slice.
- **Allow the Vite preset to opt out of `react()` + `tailwindcss()`** via a framework flag or
  full-replacement plugin list.
- **Unify `webServer.timeout` defaults** between the low-level helper and the preset (today: 120s vs
  300s for the same knob).
- **Stop re-exporting `test` / `expect` from the Playwright subpath** (or do it loudly with
  documented convention) — today it creates a needless import-duality in user code.
- **Move the cross-cutting `extras-consistency` test** to an integration tests directory; it
  logically belongs with codegen + emit-manifest agreement, not under `runtime/` alone.
- **Reduce the 14 typed registry dependencies** in `gatherManifest` to a single `Snapshotable`-style
  contract collected by the engine on behalf of plugins, removing per-service imports from the
  substrate.
- **Reconsider the `globalThis.__devstackDAppKit__` slot contract** in favor of a typed bridge
  module.
