# 24 Examples (distilled)

## Purpose (in the redesign)

Examples are **not part of the system** — they are the system's customer. The top-level `examples/`
directory holds nine self-contained apps whose job is to exercise devstack end-to-end and to be the
on-ramp a new user copies. They have no engine code in them; everything they write is either (a) the
user's real concern (Move sources, React UI, e2e specs, `devstack.config.ts`) or (b) boilerplate
that devstack failed to absorb.

The pain points captured below are therefore evidence of API gaps. Every near-clone file in an
example is a signal that the redesigned package + build-integrations should provide that thing as a
first-class affordance. The goal of this distillation is to figure out: what does an example _have_
to do to wire devstack in, and what should be one symbol away?

## Examples inventory

Nine directories under `examples/`. Seven are full Vite + React + dapp-kit apps with Playwright
suites; one is a CLI Effect program; one is a stack-only plugin demo.

- `_template/` — minimal canonical app (2 accounts, 1 Move package, 1 mint action, 1 e2e). Used by
  the scaffolder. Stack: Sui (implicit) + Account + Package + Action + Wallet + Codegen + Dev (port
  5179).
- `arena/` — on-chain Connect Four. Shared Lobby + Game objects; lobby id surfaced via `extras`
  projection. Adds `Action` with `cacheKey` for idempotent restart.
- `deepbook-full/` — full deepbook stack: Postgres + Pyth (local) + PythPusher + Deepbook +
  DeepbookMargin (+ seed) + Indexer + Server + MarketMaker. Largest config (~310 LOC). Vendors
  deepbook v7.0.0 via `VendorDeepbook`.
- `effect-app/` — pure-DI Effect program, **no Vite, no codegen**. Same `Effect.gen` body runs
  against localnet in dev and testnet in prod; mode flipped by
  `Account({kind: 'env' | 'ephemeral-funded'})` keyed on `NODE_ENV`. Uses
  `runMain(program.pipe(Effect.provide(stack.layer)))`.
- `fork-greeting/` — minimal sui-fork harness.
  `Sui({network:'testnet-fork', fork:{seed:{addresses}}})`; accounts auto-promote to `impersonate`.
- `plugin-author-redis/` — stack-only out-of-tree plugin. Wraps Redis as a `dockerContainer(...)`
  via the `/advanced` surface. No UI, no e2e.
- `private-content/` — Seal-encrypted vault on Walrus + open-mode key server. Uses `extras` to
  project the SealKeyServerTag for the UI.
- `token-studio/` — single managed coin (`STUDIO`) with TreasuryCap-gated mint + transfer.
- `wallet/` — multi-coin wallet UI + DeepBook v3 swap; 2 mock coins + in-process market maker.

`examples/README.md` is stale: missing `fork-greeting` and `plugin-author-redis`.

## Common needs across examples

Every Vite-having example expresses the same shape:

- **One `devstack.config.ts`** — declares Refs (Account, Package, Action, Wallet, Codegen, Dev,
  optional services) and `export default devstack(...)`.
- **`pnpm dev` → `devstack up`** — `dev` script never invokes Vite directly; the supervisor owns the
  dev cycle and spawns Vite as a `Dev(...)` child.
- **Codegen-driven `src/generated/`** — apps
  `import { accounts, packages, services, coins, captured, extras, devstackDappKitConfig, deepbookConfig } from './generated/<x>.js'`.
  The generated `dapp-kit-config.ts` is the single most load-bearing artifact (carries the wallet
  bearer token / pair URL and pre-wires the burner-wallet adapter).
- **dapp-kit wiring** — `src/dapp-kit.ts` creates the kit, stamps it on
  `globalThis.__devstackDAppKit__`, and declaration-merges into dApp-Kit's `Register` interface.
  `src/main.tsx` mounts `<StrictMode><QueryClientProvider><DAppKitProvider>...`.
- **Vite preset** — `vite.config.ts` is one line: `defineDevstackViteConfig({port: <N>})`. The
  preset wires React + Tailwind plugins, manifest aliasing, watcher exclusion, Traefik-aware HMR
  (`clientPort: 5175`), and `.localhost` allowedHosts.
- **Playwright preset** — `playwright.config.ts` is `defineDevstackPlaywrightConfig()` (some
  override `timeout` for cold-start services). Preset spawns `pnpm dev` as the `webServer`, ties
  `webServer.url` to the manifest's `app.dev.url`, sets `gracefulShutdown: SIGTERM/10s`,
  `workers: 1`, `fullyParallel: false`, `reuseExistingServer: !CI`.
- **Vitest preset** — `defineDevstackVitestConfig()` with `passWithNoTests: true` (no in-tree unit
  tests today).
- **Browser dev-wallet** — every e2e uses `connectAs(page, 'alice')` from the playwright helpers;
  depends on the kit being stamped on the global.
- **Shared script set** — `dev`, `build`, `preview`, `typecheck`, `test`, `test:watch`, `test:e2e`,
  `clean`, `apply`, `stack`. `test*` scripts set `DEVSTACK_STACK=test` for stack isolation.

## Repeated boilerplate (devstack-side smells)

This is the dedup heat-map. Each entry below is duplicated across the seven Vite apps with
near-byte-identical content — **these are not example concerns; they're API gaps in devstack /
build-integrations**.

- **`src/dapp-kit.ts` (~20 LOC × 7 apps ≈ 140 LOC) — THE biggest smell.** Every app's `dapp-kit.ts`
  does the same three things: `createDAppKit({ ...devstackDappKitConfig })`, stamp
  `globalThis.__devstackDAppKit__`, and declare-merge `Register`. The first two should be a single
  `createDevstackDAppKit()` factory shipped from devstack. Only the `Register` augmentation must
  stay in user code (TS augmentation rule).
- **`src/main.tsx` (~25 LOC × ≥3 apps) — second biggest smell.** The `createRoot` →
  `<StrictMode><QueryClientProvider><DAppKitProvider>` shell is byte-identical across `_template`,
  `deepbook-full`, `wallet`. Candidate for a `createDevstackApp(<App/>)` helper or a thin shell
  module.
- **`useSignAndExecute` (~25 LOC × ≥3 apps) — third biggest smell.** The same React-Query mutation
  hook is implemented inline in `_template/src/App.tsx`, `deepbook-full/src/lib/queries.ts`, and
  `wallet/src/lib/queries.ts`. Belongs in a `@mysten-incubation/dapp-kit-helpers` (or devstack-side)
  shared module.
- **`src/ui/Card.tsx`** — byte-identical between `_template` and `deepbook-full` (likely more).
  Either factor or accept the "template fork" intent and stop pretending it's deduped.
- **`Wallet({allowedOrigins:[...]})` two-line litany** — every app types both
  `http://dev.<app>.localhost:5175` AND `http://localhost:<port>` by hand. Devstack already knows
  the `Dev` port and the routed hostname; it should default to both, with `allowedOrigins` reserved
  for _narrowing_.
- **`hotRestart: process.env.PLAYWRIGHT === '1' ? false : undefined`** — identical line + identical
  comment in `arena` and `fork-greeting`. Should be a named option
  (`disableHotRestartUnderPlaywright()`).
- **The build/typecheck shell guard** —
  `if [ -f src/generated/dapp-kit-config.ts ]; then ... else echo 'skipping ...'` is copy-pasted
  verbatim across every example's `package.json`. Belongs inside `devstack guard build` /
  `devstack guard typecheck` (or codegen should fail loud + provide a `--if-applied` flag).
- **`'Dev Wallet'` literal string** — the playwright `connectAs` helper matches the wallet by
  literal name; the codegen emits the same literal on the other side. No shared constant; a typo
  silently breaks every e2e.
- **Inline manifest + keypair loading in `arena/e2e/connect-four.spec.ts`** — re-implements
  `loadStackManifest` and `loadStackKeypair` (helpers already exist in the playwright module; spec
  predates them).

Aggregate: roughly **~600 LOC of boilerplate** that's user-authored today but should live behind one
or two helper functions exported from devstack or a build-integration sub-package.

## CI contract

What CI must do against every example (this is the e2e validation that the redesigned package must
still support):

- `pnpm dev` (or `devstack up --detach`?) must come up cleanly from a cold state on a fresh checkout
  — no manual prerequisites past Docker, Node 24, and Sui CLI.
- `pnpm build` must be a no-op (with explanatory message + exit 0) when `src/generated/` is absent,
  and must produce a valid `dist/` after codegen has run at least once.
- `pnpm typecheck` must be a no-op pre-codegen and pass post-codegen.
- `pnpm test:e2e` must:
  - set `DEVSTACK_STACK=test` so it doesn't contend with a parallel `pnpm dev` on the `main` stack;
  - launch its own supervisor via Playwright's `webServer` block (or reuse a running one in dev via
    `reuseExistingServer: !CI`);
  - SIGTERM-graceful-shutdown within 10s on completion;
  - tolerate cold-start: walrus + seal + fork stacks need 900s `timeout` overrides, default is 300s.
- The build-integration preset tests (under `packages/devstack/src/{vite,vitest,playwright}/`) gate
  the contract the examples consume; they must pass independently and together.
- CI flips `forbidOnly: true`, `retries: 2`, `[github]` reporter via
  `defineDevstackPlaywrightConfig` reading `process.env.CI`.

## Integration with build tools

The seams are narrow and presets do the heavy lifting:

- **Vite** ← `defineDevstackViteConfig({port})`. Reads the per-stack manifest, aliases the legacy
  flat-manifest path, sets HMR `clientPort: 5175`, allows `.localhost`, excludes `.devstack/**` from
  watch, honors `$PORT` over the call-site `port`. Apps pass only `port`; the preset surfaces
  `appDir`, `extraPlugins`, `extend` as escape hatches that no example uses today.
- **Playwright** ← `defineDevstackPlaywrightConfig({timeout?})`. Tests live under `./e2e/`. Preset
  wires the `webServer` block (manifest-resolved URL with conventional-URL fallback for cold-start),
  CI flips, graceful-shutdown, and stamps `PLAYWRIGHT=1` for the spawned config.
- **Vitest** ← `defineDevstackVitestConfig()`. Excludes `e2e/**`, `passWithNoTests: true`. No
  example currently uses `it.layer(stack.layer)`.
- **Supervisor → Vite** spawn contract: `Dev({command, args:[...,'--port','{port}'], port, needs})`.
  `{port}` token interpolated at spawn time; `needs` orders Vite after Codegen + every Package it
  consumes.
- **Browser ← burner-wallet adapter**: the generated `dapp-kit-config.ts` carries the `pairUrl`
  (bearer token in the fragment) and the `devstackWalletInitializer`. Apps spread it into
  `createDAppKit`.

Apps never `import` from devstack engine code in browser-shipped modules; the only devstack-shaped
thing in `src/` is the dApp-Kit factory call consuming the generated config, plus the playwright
helpers (which are Node-only and not bundled).

## Per-example specifics

- **`_template`** — sets the canonical shape; smallest realistic config.
- **`arena`** — uses `Action({cacheKey})` for idempotent post-publish lobby creation; uses `extras`
  to project the resulting Lobby id; uses `pickCreatedByType` from `/advanced`; e2e re-implements
  manifest + keypair loading instead of using helpers.
- **`deepbook-full`** — largest config; `Codegen({packages:[]})` because the deepbook source is
  vendored, not user-authored; uses `VendorDeepbook` (git-clone scheme under `.devstack/vendor/`);
  has known `as any` casts and "`__PLACEHOLDER__`" string-typed helpers flagged as type-system
  workarounds (target migration: the `Coin.fromPackage` pattern that `wallet` uses).
- **`effect-app`** — no Vite, no codegen, no Playwright. Runs as `tsx src/main.ts`. Demonstrates the
  "same Effect program runs against localnet in dev and testnet in prod" mode via
  `Account({kind: 'env'})`. Open: no documented release path.
- **`fork-greeting`** — only fork-mode example. Reads `FORK_SEED_ADDRESSES` env (with a placeholder
  fallback that publishes fail-loud). Accounts auto-promote to `impersonate`. Uses
  `PackageWithCapture` from `/advanced` to type-capture object ids. Requires 900s playwright timeout
  for fork cold-start.
- **`plugin-author-redis`** — only out-of-tree plugin demo. Uses `dockerContainer`,
  `defineEntrypoint`, `makeService`, `LayeredTag` from `/advanced`. Stack-only — no UI, no e2e.
  Suggests `@mysten-incubation/devstack/advanced` exists as a stable surface for plugin authors.
- **`private-content`** — only Walrus + Seal example. Requires 900s playwright timeout. Uses
  `extras` to project `SealKeyServerTag` into the UI surface.
- **`token-studio`** — smallest non-template config (39 LOC). Single-package, single-coin
  (`STUDIO`).
- **`wallet`** — uses a _different_ deepbook vendor scheme (`.devstack/imports/...` via
  `movePackagePath:`) from `deepbook-full`'s `VendorDeepbook` (`.devstack/vendor/...`). Two
  coexisting schemes — pick one.

## Lifecycle / invocation patterns

- **`pnpm dev`** → `devstack up` → load `devstack.config.ts` → acquire per-stack file lock →
  materialize Effect layers per `needs:` edges → accounts/packages/actions/wallet/codegen run in
  order → write `.devstack/stacks/<stack>/manifest.json` → spawn `Dev` child (vite) with `$PORT` set
  → Vite ready → TUI renders.
- **`pnpm test`** → `DEVSTACK_STACK=test vitest run` → no-op (preset excludes e2e +
  `passWithNoTests`).
- **`pnpm test:e2e`** → `DEVSTACK_STACK=test playwright test` → preset's `webServer` block spawns
  its own `pnpm dev` (separate supervisor on the `test` stack), waits for manifest's `app.dev.url`,
  runs specs in serial (`workers: 1`), SIGTERM-graceful-shutdown.
- **`pnpm build`** → existence-guarded `tsc -b && vite build` → produces `dist/` from existing
  `src/generated/`. No supervisor.
- **`pnpm preview`** → `vite preview` against `dist/` — open question re: bearer-token-in-bundle
  security.
- **`pnpm apply`** → `devstack apply` — one-shot codegen + apply without the long-running
  supervisor.
- **`pnpm clean`** → removes `dist .turbo node_modules/.tmp` (not `.devstack/`; that's
  `devstack wipe`).

## Invariants and constraints

- **Apps do not import devstack engine code into browser bundles.** The only devstack-shaped symbols
  that hit the browser come from the generated `dapp-kit-config.ts` (which only imports from
  `@mysten-incubation/dev-wallet` and `@mysten/sui/grpc`).
- **Codegen artifacts are gitignored — `dapp-kit-config.ts` and `extras.ts` are _also_ mode 0o600**
  (carry bearer token and user-supplied secret-tier data respectively). The mixed gitignore inside
  `src/generated/` is the right behavior but UX-confusing.
- **`globalThis.__devstackDAppKit__` MUST be stamped** in every app for the Playwright `connectAs`
  helper to work.
- **Wallet name MUST be the literal `'Dev Wallet'`** — codegen sets it, playwright helper queries
  it; no shared constant today.
- **`Wallet({allowedOrigins})` MUST include both the routed and direct origins.**
- **`vite.config.ts` MUST resolve the per-stack manifest** (the preset's alias trick) for
  multi-stack coexistence.
- **`DEVSTACK_STACK=test` MUST be set for any test target** so it doesn't contend with the `main`
  stack.
- **`Dev(...)` MUST be downstream of `Codegen(...)` and every Package it consumes** via `needs:`.
  Else Vite spawns before `src/generated/` exists.
- **Move package address in `Move.toml` MUST be `0x0`** — supervisor patches at publish time.
- **`testDir: './e2e'`** — preset hard-codes; specs elsewhere are not found.
- **`workers: 1, fullyParallel: false`** — one supervisor per stack; tests share state.

## Edge cases and known failure modes

- **Cold-first-run `src/generated/` absent** — build/typecheck scripts' shell guard prints message +
  exits 0; `pnpm dev` is the recovery.
- **Stale `src/generated/` after schema bump** — tsc fails; `pnpm dev` or `pnpm apply` regenerates.
- **`globalThis.__devstackDAppKit__` missing** — `connectAs` throws with a descriptive recovery
  message.
- **`allowedOrigins` missing the routed/direct origin** — wallet HTTP server CORS-rejects;
  ConnectButton stalls.
- **Vite spawns before codegen lands** (missing `needs:` edge) — browser sees import errors.
- **Playwright `webServer` timeout** on walrus/seal/fork cold-start — override to 900s.
- **Hot-restart races Playwright's first navigation** — codegen's first cycle touches Move sources →
  watcher re-triggers → brief vite death → 502. Workaround:
  `hotRestart: PLAYWRIGHT === '1' ? false : undefined`.
- **Wallet bearer token rotates on restart** — existing tabs hold a stale token; HMR-ing the
  generated module forces re-pair.
- **Cold-start before manifest exists** — Playwright `webServer` falls back to conventional URLs
  (`<stack>.<service>.<app>.localhost:<port>`) and converges once `pnpm dev` writes the real
  manifest.
- **Malformed manifest** — schema decode rejects with `ManifestShapeError`
  - recovery hint (`devstack apply`).
- **Endpoint not in manifest** — `webServer` throws with the missing name.
- **Fork-mode seed placeholder unset** — publish fails "insufficient gas"; recovery is setting
  `FORK_SEED_ADDRESSES`.
- **`pnpm preview` against a bundled `dist/`** — bearer token is inlined at build time. Undocumented
  security posture.

## Learnings from current implementation

- **The presets are doing the right thing.** Every app's `vite.config.ts`, `playwright.config.ts`,
  `vitest.config.ts` is a one-liner. The seam is good — extend it rather than replace it.
- **Codegen is the primary surface between devstack and the app.** Eight generated files, of which
  `dapp-kit-config.ts` is uniquely load-bearing. Apps interact with devstack 95% through codegen,
  not through runtime imports.
- **`needs:` edges encode the lifecycle.** Examples that get this right never see codegen-race
  errors. The redesign should make `needs:` inference automatic from Ref usage where possible, and
  validate at config-load time.
- **`extras` is the user-supplied projection escape hatch.** Used by arena, fork-greeting,
  private-content to expose typed values the built-in emitters don't know about (lobby id, seal key
  server, etc.).
- **`cacheKey` on `Action` is the idempotency primitive.** Without it, every restart mints a fresh
  side-effect.
- **The supervisor's port allocator + `$PORT` injection** is the load-bearing concurrency primitive
  for multi-stack coexistence (`pnpm dev` on `main` while `pnpm test:e2e` runs on `test`).
- **Conventional-URL fallback** in the playwright preset lets the `webServer` block work _before_ a
  manifest exists, then converges. Good pattern; preserve.
- **`Coin.fromPackage` is the right pattern** for post-publish coin type resolution; deepbook-full's
  literal `__PLACEHOLDER__` strings are acknowledged debt with `wallet` showing the migration
  target.

## Cross-component references

- **Doc 19 (codegen)** — emitters: BindingsEmitter, StackHandleEmitter, DappKitConfigEmitter,
  DeepbookConfigEmitter. Output paths + permissions are example-facing contract.
- **Doc 15 (wallet)** — `Wallet({accounts, allowedOrigins})`; bearer-token rotation; `pairUrl`
  shape; the `'Dev Wallet'` name literal.
- **Doc 23 (build-integrations)** — `defineDevstackViteConfig`, `defineDevstackPlaywrightConfig`,
  `defineDevstackVitestConfig`; `connectAs`, `loadStackManifest`, `loadStackKeypair`. Shared test
  files pin a contract both docs cite.
- **Doc 12 (account)** — `Account({kind: 'ephemeral-funded' | 'env' | 'impersonate'})`;
  auto-promotion under `Sui({fork:...})`.
- **Doc 14 (package)** — `Package` and `PackageWithCapture` (from `/advanced`); auto-coin-discovery;
  the `0x0` Move address convention.
- **Doc 16 (action)** — `Action({signer, needs, build, cacheKey?})`.
- **Doc 13 (coin)** — `Coin.fromPackage(pkg, symbol)` post-publish resolution.
- **Doc 05 (sui)** — `Sui()` default + `Sui({network:'testnet-fork', fork:{seed:{addresses}}})` fork
  mode.
- **Doc 06 (walrus)**, **Doc 07 (seal)** — used by `private-content`.
- **Doc 08 (deepbook)**, **Doc 09 (pyth)**, **Doc 10 (postgres)** — used by `deepbook-full` and
  `wallet`.
- **Doc 20 (cli)** — `devstack up`, `apply`, `stack`, `wipe`, `down`; TTY-detached vs TUI behavior.
- **Doc 17 (snapshot)** — open question of what survives at the example level (`.devstack/git/`,
  `.devstack/vendor/`, etc.).
- **Doc 18 (router)** — Traefik routing; `dev.<app>.localhost:5175` + HMR `clientPort: 5175`.
- **Doc 22 (programmable api)** — the `effect-app` pattern; `stack.layer`
  - `runMain`; production-mode wiring.

## Open questions / decisions deferred

- **Should `createDevstackDAppKit()` be a devstack export?** It would collapse 7 × 20 LOC of
  identical boilerplate; the `Register` declaration would stay app-local.
- **Should `createDevstackApp(<App/>)` be a devstack export?** Same question for the `main.tsx`
  shell. Whether to also embed the dev-wallet panel mount is the design call (`mountUI: true` is
  never used today).
- **Should a `@mysten-incubation/dapp-kit-helpers` package exist** for `useSignAndExecute` and
  friends? Or live inside devstack?
- **Snapshot inclusion list at the example level** — apps don't invoke snapshot but need to know
  whether vendor caches survive.
- **`pnpm preview` security posture** — bearer token inlined into the bundle. Is preview ever the
  right surface for an example?
- **`mountUI: true` for the embedded dev-wallet panel** — every app pairs via popup URL today. Is
  the embedded panel ever the right default?
- **Two deepbook vendor schemes** (`movePackagePath` against `.devstack/imports/` vs
  `VendorDeepbook` against `.devstack/vendor/`) — pick one or document why both exist.
- **Legacy flat `.devstack/manifest.json`** still has a Vite-alias fallback. Residual or active?
- **`bindings/` emitter usage** — `_template/src/generated/bindings/` exists but no example source
  imports it. De-facto unused?
- **`effect-app` production path** — README documents the env-flip but no deploy story.
- **`plugin-author-redis` taxonomy** — is it an "example" or should it move under a plugin-author
  surface?
- **`devstack up --detach` flag** — `pnpm dev` blocking the terminal is friction; no documented
  daemon mode.
- **A `devstack guard build|typecheck` wrapper command** to replace the copy-pasted shell guard in
  every `package.json`.

## Opportunities noticed

- **Biggest lever: collapse the dapp-kit + main.tsx + useSignAndExecute boilerplate** (~600 LOC
  across 7 apps) into one or two devstack-shipped helpers. This is the single largest UX win in the
  example surface.
- **Default `Wallet.allowedOrigins`** to both the routed and direct forms derived from the `Dev`
  port. User explicitly _narrows_, never has to spell both out.
- **Make `disableHotRestartUnderPlaywright()` (or auto-detect under `PLAYWRIGHT=1`) the default** —
  the workaround is in two configs with identical comments; the underlying race is the system's bug,
  not the example's.
- **Centralize the `'Dev Wallet'` name literal** as a single exported constant shared by codegen +
  playwright helper, so a typo can't silently break every e2e.
- **Replace the shell `if [ -f ... ]` guard in every `package.json`** with a `devstack guard <cmd>`
  wrapper (or have codegen scripts no-op loudly).
- **Migrate `arena/e2e/connect-four.spec.ts`** to `loadStackManifest` + `loadStackKeypair`; the
  helpers post-date the spec. ~30 LOC saved.
- **Update `examples/README.md`** to include `fork-greeting` and `plugin-author-redis`.
- **Document the selective gitignore in `src/generated/`** — or reorganize so secret-tier files live
  under `src/generated/private/`.
- **Settle the two deepbook vendor schemes** — wallet's `.devstack/imports/` vs deepbook-full's
  `.devstack/vendor/`. Pick one and migrate the other, or document the split.
- **Schedule the `__PLACEHOLDER__` → `Coin.fromPackage` migration** in `deepbook-full`; `wallet`
  already shows the target.
- **Add an `effect-app` vitest test using `it.layer(stack.layer)`** — the vitest preset's comment
  explicitly invites this pattern but no example demonstrates it. 30 LOC of
  documentation-by-example.
- **`devstack up --detach` / `pnpm dev:bg` script in the template** to free the terminal.
- **Decide whether `src/generated/bindings/` is actually consumed** — if not, prune it from the
  template scaffold; if yes, add an example use site so the affordance is discoverable.
