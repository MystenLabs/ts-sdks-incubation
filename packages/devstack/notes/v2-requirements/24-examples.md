# examples

## Purpose

This document captures the **example-app-side contract** with devstack — what a project under the
top-level `examples/` directory of the repo does to consume `@mysten-incubation/devstack` and its
peers. Every example folder is a self-contained Vite + React + dapp-kit application (with a couple
of deliberate exceptions) that boots a hermetic local Sui stack, publishes one or more Move
packages, generates typed TS handles for the manifest, and exposes a dev wallet + dApp-Kit-driven
UI. The doc focuses on the _patterns_ those apps follow — `devstack.config.ts` shape,
`vite.config.ts` integration, codegen artifact consumption, wallet wiring, dev-server lifecycle vs
devstack lifecycle, `package.json` scripts, and Playwright/Vitest setup. The underlying
build-integration _surfaces_ (the `defineDevstack*Config` and helper modules under
`packages/devstack/src/{vite,vitest,playwright}/`) are the scope of doc 23 (build-integrations);
here we document how the example apps actually _consume_ them.

Terms used throughout:

- **stack** — a named, isolated instance of the local Sui devstack (default name `main`; tests use
  `DEVSTACK_STACK=test`). Each stack has its own `.devstack/stacks/<name>/manifest.json` +
  `runtime/accounts/` + state record.
- **manifest** — the on-disk JSON sidecar (`.devstack/stacks/<stack>/manifest.json`, mode 0o600) the
  supervisor writes after every successful apply cycle. Carries `services.*`, `packages.*`,
  `accounts.*`, `coins.*`, `app.{dev,wallet,extras}`.
- **Ref / LayeredTag** — a typed handle returned by a devstack factory (e.g. `Account('alice')`,
  `Package('hello', dir)`); composes via `yield* ref` inside `Effect.gen` blocks the user writes in
  `devstack.config.ts`.
- **codegen artifacts** — files emitted into `src/generated/` by the built-in codegen emitters
  (`BindingsEmitter`, `StackHandleEmitter`, `DappKitConfigEmitter`, `DeepbookConfigEmitter`).
- **devstack supervisor** — the `devstack` CLI process (typically invoked as `devstack up`) that
  holds the engine, runs the TUI, applies the configured services, writes manifests, and spawns the
  `Dev(...)` child process (vite).

## Current implementation

The "implementation" in this component is the collection of _example applications_, not source under
`packages/devstack/`. Each example directory is a self-contained npm workspace; the contract with
devstack is encoded in its hand-written files and its `package.json` scripts. The file-by-file table
below lists every example, then drills into the canonical files per app.

### Examples inventory (top-level `examples/`)

| Directory              | One-line characterization                                                                                                         | Stack composition (services declared, in order)                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_template/`           | Minimal-but-real starting point: 1 Move package, 1 publish, 1 mint button, 1 e2e. Used by the scaffolder.                         | `Account` x2, `Package(hello)`, `Action(mintGreeting)`, `Wallet`, `Codegen`, `Dev` (port 5179)                                                                                                                                          |
| `arena/`               | On-chain Connect Four. Matchmaking via shared `Lobby`, gameplay via shared `Game`; lobby id surfaced via `extras`.                | `Account` x3, `Package(connect_four)`, `Action(openLobby)` (with `cacheKey`), `Wallet`, `Codegen`, `Dev` (port 5176)                                                                                                                    |
| `deepbook-full/`       | Reference exercise of the full deepbook stack: pyth + indexer + server + margin + market-maker.                                   | `Account` x5, `VendorDeepbook`, `Postgres`, `Pyth(local)`, `PythPusher`, `Deepbook(local)`, `DeepbookMargin`, `DeepbookMargin.seed`, `DeepbookIndexer`, `DeepbookServer`, `DeepbookMarketMaker`, `Wallet`, `Codegen`, `Dev` (port 5179) |
| `effect-app/`          | Pure-DI Effect program — same `Effect.gen` body runs against localnet in dev, testnet in prod via env-driven `Account({ kind })`. | `Sui()`, `Account('alice', { kind: 'ephemeral-funded' \| 'env' })` — runs via `stack.layer + runMain`, no Vite, no codegen.                                                                                                             |
| `fork-greeting/`       | Minimal sui-fork harness. `testnet-fork` with seed addresses, single shared `Board` greeting flow.                                | `Sui({network:'testnet-fork', fork:{seed:{addresses}}})`, `Account` x3 (auto-promoted to impersonate), `PackageWithCapture(greeting)`, `Wallet`, `Codegen`, `Dev` (port 5181)                                                           |
| `plugin-author-redis/` | Minimal out-of-tree plugin example. Wraps Redis as a `dockerContainer(...)` via `/advanced` surface. No UI, no Move, no e2e.      | `Redis()` only (from local `./redis-plugin.ts`).                                                                                                                                                                                        |
| `private-content/`     | Seal-encrypted file vault on top of walrus + open-mode seal key server.                                                           | `Account` x3, `Walrus({local:{nodeCount:4}})`, `Seal`, `Package(vault)`, `Wallet`, `Codegen`, `Dev` (port 5170)                                                                                                                         |
| `token-studio/`        | Single managed coin (`STUDIO`) with TreasuryCap-gated minting.                                                                    | `Account` x3, `Package(managed_coin)`, `Wallet`, `Codegen`, `Dev` (port 5173)                                                                                                                                                           |
| `wallet/`              | Multi-coin wallet UI + DeepBook v3 swap; 2 mock coins + continuous in-process market maker.                                       | `Account` x4, `Package(mock_usdc)`, `Package(mock_weth)`, `Coin.fromPackage` x2, `Action(seedTokens)`, `Deepbook(local)`, `DeepbookMarketMaker`, `Wallet`, `Codegen`, `Dev` (port 5174)                                                 |

`examples/README.md` (the directory's own README) describes the same set modulo `_template` listed
first and lacks `fork-greeting` / `plugin-author-redis` — those landed after the README was written
and should be added to it (see Opportunities). The memory note about "4 example apps with green
playwright suites" predates the inventory in the table — there are now nine directories total under
`examples/`, of which seven have playwright suites (`_template`, `arena`, `deepbook-full`,
`fork-greeting`, `private-content`, `token-studio`, `wallet`). `effect-app` is a tsx CLI program (no
Vite, no Playwright); `plugin-author-redis` is a stack-only example (no Vite, no e2e tests).

### `_template/` — canonical structure (LOC)

`examples/_template/devstack.config.ts:1-63` is the smallest realistic devstack.config.ts in the
tree and effectively defines the contract every other app extends.

| File                                    | LOC | Summary                                                                                                                          |
| --------------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------- |
| `devstack.config.ts`                    | 63  | 2 accounts + 1 Move package + 1 post-publish Action + Wallet + Codegen + Dev. `export default devstack(...)`                     |
| `vite.config.ts`                        | 3   | `export default defineDevstackViteConfig({ port: 5179 })`                                                                        |
| `vitest.config.ts`                      | 12  | `export default defineDevstackVitestConfig()` + chain-mode usage comment                                                         |
| `playwright.config.ts`                  | 6   | `export default defineDevstackPlaywrightConfig()` + 300s timeout comment                                                         |
| `tsconfig.json`                         | 4   | Composite project: refs `tsconfig.app.json` + `tsconfig.node.json`                                                               |
| `tsconfig.app.json`                     | 14  | extends `@mysten-incubation/tsconfig/react.json`; `paths.@/*`; excludes generated test files                                     |
| `tsconfig.node.json`                    | 12  | extends `@mysten-incubation/tsconfig/node.json`; includes the 4 config files                                                     |
| `package.json`                          | 47  | scripts + workspace + catalog: deps; engines.node `>=24`                                                                         |
| `index.html`                            | 14  | One `<div id="root">`, one `<script type="module" src="/src/main.tsx">`                                                          |
| `src/main.tsx`                          | 24  | `createRoot(...).render(<StrictMode><QueryClientProvider><DAppKitProvider>...`                                                   |
| `src/dapp-kit.ts`                       | 21  | `createDAppKit({ ...devstackDappKitConfig })` + `globalThis.__devstackDAppKit__` export                                          |
| `src/App.tsx`                           | 148 | Card with ConnectButton + mint button; uses `useSignAndExecute` hook                                                             |
| `src/ui/Card.tsx`                       | 28  | Section-card layout primitive                                                                                                    |
| `src/index.css`                         | 26  | `@import 'tailwindcss'` + theme tokens                                                                                           |
| `src/vite-env.d.ts`                     | 1   | `/// <reference types="vite/client" />`                                                                                          |
| `e2e/mint.spec.ts`                      | 10  | `connectAs(page, 'alice')` then click mint, assert digest visible                                                                |
| `move/hello/...`                        | -   | Move package with one `mint` entry function (not enumerated here)                                                                |
| `src/generated/.gitignore`              | 5   | Excludes `dapp-kit-config.ts` + `extras.ts` (carry secrets)                                                                      |
| `src/generated/accounts.ts`             | 14  | `export const accounts = { alice: '0x...', bob: '0x...' } as const`                                                              |
| `src/generated/packages.ts`             | 17  | `export const packages = { hello: { id, mvr } } as const`                                                                        |
| `src/generated/services.ts`             | 29  | `export const services = { sui: { network, rpc, chainId, faucet, graphql, indexerDb } } as const`                                |
| `src/generated/dapp-kit-config.ts`      | 79  | `devstackDappKitConfig` + `devstackWalletInitializer` + `runtime`/`devstackNetwork` constants (carries bearer token, mode 0o600) |
| `src/generated/captured.ts`             | 11  | `export const captured = {} as const` (per-package object id capture)                                                            |
| `src/generated/coins.ts`                | 14  | `export const coins = {} as const` (auto-discovery output)                                                                       |
| `src/generated/extras.ts`               | 13  | `export const extras = {} as const` (user-supplied, secret-tier)                                                                 |
| `src/generated/bindings/<pkg>/<mod>.ts` | -   | Generated Move bindings (one file per module per package; counts vary)                                                           |
| `src/generated/bindings/utils/index.ts` | -   | Shared utility re-exports for the generated bindings                                                                             |

Totals for `_template/`: configs + entry ~600 LOC user-authored; generated ~200 LOC (per snapshot in
tree). Each example's own LOC differs based on UI complexity (the deepbook-full example below is the
largest).

### `deepbook-full/` — most complex example (LOC)

| File                          | LOC | Summary                                                                                                                                                                             |
| ----------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devstack.config.ts`          | 311 | 5 accounts, vendored deepbook v7.0.0, Postgres, Pyth local + pusher, Deepbook + margin + seed, indexer + server, market maker, Wallet, Codegen, Dev. `export default devstack(...)` |
| `vite.config.ts`              | 3   | `defineDevstackViteConfig({ port: 5179 })`                                                                                                                                          |
| `vitest.config.ts`            | 3   | `defineDevstackVitestConfig()`                                                                                                                                                      |
| `playwright.config.ts`        | 3   | `defineDevstackPlaywrightConfig()`                                                                                                                                                  |
| `package.json`                | 47  | adds `@mysten/deepbook-v3` over the `_template` deps                                                                                                                                |
| `index.html`                  | 14  | mounts `<script src="/src/main.tsx">`                                                                                                                                               |
| `src/main.tsx`                | 25  | identical pattern to `_template`                                                                                                                                                    |
| `src/dapp-kit.ts`             | 18  | identical pattern to `_template`                                                                                                                                                    |
| `src/App.tsx`                 | 86  | `<Health/>`, `<Ticker/>`, `<Mint/>`+`<Trading/>` when connected, `<Balances/>`                                                                                                      |
| `src/components/Health.tsx`   | 48  | Surfaces oracle + indexer + server REST URLs from `deepbookConfig` + manifest                                                                                                       |
| `src/components/Ticker.tsx`   | 96  | `useQuery` against `deepbook-server`'s `/ticker` endpoint                                                                                                                           |
| `src/components/Trading.tsx`  | 129 | Limit-order form against margin-enabled pool, via `@mysten/deepbook-v3` SDK                                                                                                         |
| `src/components/Mint.tsx`     | 109 | TreasuryCap-based mint (DEEP + USDC) via `0x2::coin::mint_and_transfer`                                                                                                             |
| `src/components/Balances.tsx` | 101 | Per-account, per-coin balance table from `useCoinBalance`                                                                                                                           |
| `src/lib/deployment.ts`       | 55  | Joins `services` + `accounts` + `deepbookConfig` into the typed `deployment`                                                                                                        |
| `src/lib/queries.ts`          | 98  | `useSignAndExecute` + `useCoinBalance` react-query hooks                                                                                                                            |
| `src/lib/transactions.ts`     | 61  | Memoized `DeepBookClient` factory + `buildLimitOrderTx` helper                                                                                                                      |
| `src/lib/format.ts`           | 41  | `formatCoin`, `parseCoinAmount`, `shortAddress`, `labelFor`                                                                                                                         |
| `src/ui/Card.tsx`             | 28  | Section card primitive                                                                                                                                                              |
| `src/ui/Field.tsx`            | 16  | Label + caller-rendered control                                                                                                                                                     |
| `e2e/margin-order.spec.ts`    | 26  | Place limit buy on `sui_usdc`; assert tx digest + ticker bid populated                                                                                                              |
| `e2e/mint.spec.ts`            | 19  | Click `Mint 100 DEEP`; assert `balance-alice-deep` cell changes                                                                                                                     |
| `e2e/oracle-mid.spec.ts`      | 53  | Health card surfaces oracle/server REST; ticker shows bid<ask                                                                                                                       |
| `e2e/ticker-fetch.spec.ts`    | 25  | Ticker rows for `sui_usdc` + `deep_sui` have numeric bid/ask                                                                                                                        |

### `wallet/` (LOC of devstack.config.ts only — UI is similar scale to deepbook-full)

| File                                              | LOC    | Summary                                                                                                                                                                                                   |
| ------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devstack.config.ts`                              | 209    | 4 accounts, 2 mock-coin packages, `seedTokens` action with per-account distribution, `Deepbook(local)` with mock-coin-ref pools, `DeepbookMarketMaker` (alice as maker), Wallet, Codegen, Dev (port 5174) |
| `vite.config.ts` / vitest / playwright            | 3 each | identical pattern                                                                                                                                                                                         |
| `src/App.tsx`                                     | 93     | `<SendForm/>` + `<SwapForm/>` + `<Balances/>`                                                                                                                                                             |
| `src/components/SwapForm.tsx`                     | 146    | Uses `deployment.pools` projection from codegen-derived deepbookConfig                                                                                                                                    |
| (other components/lib analogous to deepbook-full) |        |                                                                                                                                                                                                           |
| `e2e/send-sui.spec.ts`                            | 56     | Native SUI + mock-USDC send; balance cells change                                                                                                                                                         |
| `e2e/swap.spec.ts`                                | 62     | Swap SUI→mUSDC and back via UI; balance cells change                                                                                                                                                      |

### Other apps' devstack.config.ts LOC (UI omitted for brevity)

| Example                  | `devstack.config.ts` LOC | Notes                                                                                |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------ |
| `arena/`                 | 79                       | `extras` block returns Effect that yields `openLobby` and projects `{ openLobbyId }` |
| `fork-greeting/`         | 105                      | `Sui({ network:'testnet-fork', fork:{seed:{addresses}}})`                            |
| `private-content/`       | 75                       | `extras` block yields `SealKeyServerTag` and projects `{ sealKeyServer:{...}}`       |
| `token-studio/`          | 39                       | Single `Package(managed_coin)` with auto-discovered `STUDIO` coin                    |
| `plugin-author-redis/`   | 20                       | `import { Redis } from './redis-plugin.js'; export default devstack(Redis())`        |
| `effect-app/src/main.ts` | 59                       | `runMain(program.pipe(Effect.provide(stack.layer)))` — no `.run()`, no Vite          |

### Test LOC

Each Playwright spec is small (10–150 LOC); the longest is `arena/e2e/connect-four.spec.ts` (148 LOC
— full Connect Four game played via JSON-RPC SDK for scripted moves), then
`private-content/e2e/seal-flow.spec.ts` (73 LOC). No `vitest`-mode unit tests are checked into any
example today (every `pnpm test` script delegates to `vitest run` which finds the
`passWithNoTests: true` config and exits 0). The Vitest preset under
`packages/devstack/src/vitest/define-config.ts:31` explicitly bakes `passWithNoTests: true` for this
reason.

## Configuration

This section enumerates the _consumer-side_ knobs each example app sets to shape its devstack
behavior. The devstack-side surfaces those knobs map onto belong to other docs (engine,
build-integrations, codegen, services); here we document what the apps actually pass.

### `devstack.config.ts` — top-level shape

Every full-featured example follows the same recipe:

```
import { Account, Package, Action, Wallet, Codegen, Dev, devstack /* + service-specific factories */ } from '@mysten-incubation/devstack';

const alice = Account('alice');                                   // typed Ref
const hello = Package('hello', helloDir, { signer: alice });      // Move publish
const mint  = Action('mint', { signer: alice, needs:[hello], build: ... }); // post-publish tx
const wallet = Wallet({ accounts: [alice, bob], allowedOrigins: [...] });
const codegen = Codegen({ packages: [hello] });
const dev = Dev({ command: 'pnpm', args:[...,'--port','{port}'], port:5179, needs:[hello, wallet, codegen] });

export default devstack(alice, bob, hello, mint, wallet, codegen, dev, { /* options */ });
```

Cited file:line for the canonical shape: `examples/_template/devstack.config.ts:9-63`.

`devstack(...)` accepts varargs (the Refs) followed by an optional final options object (only
`arena`, `fork-greeting`, `private-content` use the options form today — see
`examples/arena/devstack.config.ts:62-78`, `examples/fork-greeting/devstack.config.ts:97-104`,
`examples/private-content/devstack.config.ts:59-74`). The options object is the only place the apps
set `extras` and `hotRestart`.

### Per-app knob inventory

The following knobs are set by at least one example:

- **`Account(name, opts?)`** — `examples/_template/devstack.config.ts:24-25` for default
  ephemeral-funded; `examples/effect-app/src/main.ts:27-28` for the env-driven branch
  (`{ kind: 'env', key: 'ALICE_PRIVATE_KEY' }`) vs `{ kind: 'ephemeral-funded' }`. Fork stacks
  (`fork-greeting`) rely on devstack's auto-promotion: a bare `Account('publisher')` against a
  `Sui({fork:...})` parent becomes `{kind:'impersonate', sender:<first-seed>}` per the comment at
  `examples/fork-greeting/devstack.config.ts:60-67`.
- **`Package(name, dir, opts)`** — `signer: <accountRef>`; sometimes `capture: { … }` via the
  `PackageWithCapture` advanced factory (see `examples/fork-greeting/devstack.config.ts:74-77` for
  the `{ boardId: '::board::Board' }` shape).
- **`Action(name, opts)`** — `signer`, `needs:[...refs]`, `build:(tx)=>Effect`, optional
  `gasBudget`, optional `cacheKey: Effect<string>` for idempotent post-publish actions (see arena's
  `examples/arena/devstack.config.ts:29-46`).
- **`Wallet(opts)`** — `accounts: [...refs]`, `allowedOrigins: string[]`. Origins consistently
  include `http://dev.<app>.localhost:5175` (the routed dev-server hostname) AND
  `http://localhost:<port>` (the direct Vite port) — see
  `examples/_template/devstack.config.ts:42-45`, `examples/wallet/devstack.config.ts:172-175`, etc.
- **`Codegen(opts)`** — `packages: [...packageRefs]`. The package list drives which Move modules get
  generated bindings; the four built-in emitters (`BindingsEmitter`, `StackHandleEmitter`,
  `DappKitConfigEmitter`, `DeepbookConfigEmitter`) run by default. The deepbook-full example uses
  `packages: []` because the deepbook source is vendored, not user-authored
  (`examples/deepbook-full/devstack.config.ts:277`).
- **`Dev(opts)`** — `command: 'pnpm', args: [...], port: <number>, needs: [...refs]`. The `{port}`
  token in `args` is interpolated by devstack at spawn time (see
  `examples/wallet/devstack.config.ts:180-184`). `needs` is the in-order dependency edge that forces
  Vite to wait for codegen + publishes to land before the supervisor spawns it. Several apps add
  `--strictPort` (wallet, arena, deepbook-full, fork-greeting, private-content); `_template` does
  not.
- **Top-level options on `devstack(...)`** — `extras` (Effect-typed projection into
  `manifest.app.extras`) and `hotRestart` (boolean — `false` under Playwright to avoid races against
  the codegen's first cycle re-triggering the watcher; see `examples/arena/devstack.config.ts:63-69`
  and `examples/fork-greeting/devstack.config.ts:99-103`).

### Environment variables consumed by examples

- **`DEVSTACK_STACK`** — Every test script sets this (`DEVSTACK_STACK=test vitest run` and
  `DEVSTACK_STACK=test playwright test` — `examples/_template/package.json:12-13`). Defaults to
  `'main'` when unset. Drives the on-disk path `.devstack/stacks/<stack>/manifest.json`.
- **`DEVSTACK_NETWORK`** — Read by `effect-app` to pick localnet vs testnet
  (`examples/effect-app/README.md:46-49`, `examples/effect-app/src/main.ts` (implicit via `Sui()`)).
- **`NODE_ENV`** — `effect-app` branches `Account` kind on `process.env.NODE_ENV === 'production'`
  (`examples/effect-app/src/main.ts:17-18`).
- **`FORK_SEED_ADDRESSES`** — fork-greeting reads a comma-separated list of upstream-funded
  addresses; falls back to a placeholder (`examples/fork-greeting/devstack.config.ts:42-49`).
- **`PLAYWRIGHT`** — Set by the playwright `webServer` block via `defineDevstackPlaywrightConfig`
  (`packages/devstack/src/playwright/web-server.ts:52`). Apps then branch on it inside their config
  — e.g. `hotRestart: process.env.PLAYWRIGHT === '1' ? false : undefined`
  (`examples/arena/devstack.config.ts:68`, `examples/fork-greeting/devstack.config.ts:103`).
- **`PORT`** — Read by `defineDevstackViteConfig` and overrides the `port` option from the call site
  (`packages/devstack/src/vite/index.ts:112`). The devstack supervisor's port allocator stamps
  `$PORT` for the spawned Vite process so multiple stacks don't collide.
- **`CI`** — `defineDevstackPlaywrightConfig` toggles `forbidOnly`, `retries: 2`, and `[github]`
  reporter when set (`packages/devstack/src/playwright/define-config.ts:53-55`).
  `webServer.reuseExistingServer` also flips on `!process.env.CI`
  (`packages/devstack/src/playwright/web-server.ts:46`).
- **`ALICE_PRIVATE_KEY`** — effect-app reads when `NODE_ENV=production`
  (`examples/effect-app/README.md:28-30`).

### `vite.config.ts` — what apps pass

Every Vite-having example collapses to a single line:

```ts
export default defineDevstackViteConfig({ port: <5170…5181> });
```

Cited: `examples/_template/vite.config.ts:1-3`, `examples/deepbook-full/vite.config.ts:1-3`
(identical modulo port). No example today passes `appDir`, `extraPlugins`, or `extend` to the
helper. The helper itself wires React + Tailwind plugins, `es2022` target, per-stack manifest
aliasing, `.devstack/` watcher exclusion, Traefik-aware HMR (`clientPort: 5175`), and `.localhost`
`allowedHosts` — `packages/devstack/src/vite/index.ts:83-131`.

### `playwright.config.ts` — what apps pass

Six examples use the bare call:

```ts
export default defineDevstackPlaywrightConfig();
```

(`_template`, `arena`, `wallet`, `token-studio`, `deepbook-full` — see
`examples/arena/playwright.config.ts:1-3` etc.) Two override `timeout`:

- `private-content` — `defineDevstackPlaywrightConfig({ timeout: 900_000 })` for walrus/seal
  cold-start (`examples/private-content/playwright.config.ts:5`).
- `fork-greeting` — same 900s for fork-mode cold start
  (`examples/fork-greeting/playwright.config.ts:7`).

### `vitest.config.ts` — what apps pass

Five examples use the bare call:

```ts
export default defineDevstackVitestConfig();
```

(`_template`, `arena`, `wallet`, `token-studio`, `deepbook-full`, `fork-greeting`, `private-content`
— all identical content `examples/wallet/vitest.config.ts:1-3` etc.). `effect-app` has its own
`vitest.config.ts` (not enumerated; doesn't use the preset).

### `tsconfig.*` — what apps pass

Composite project layout, identical across the Vite-having examples
(`examples/_template/tsconfig.json:1-4`, `examples/_template/tsconfig.app.json:1-14`,
`examples/_template/tsconfig.node.json:1-12`):

- `tsconfig.json` — refs `app.json` + `node.json`, no `files`.
- `tsconfig.app.json` — extends `@mysten-incubation/tsconfig/react.json`, `composite: true`,
  `types: ["vite/client"]`, `paths.@/*: ["./src/*"]`, excludes `e2e`, `.devstack`, and
  `**/*.test.{ts,tsx}`.
- `tsconfig.node.json` — extends `@mysten-incubation/tsconfig/node.json`, `noEmit: true`, includes
  `devstack.config.ts`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`.

### `package.json` — script contract

The script set is identical (modulo app name) across every Vite-having example. Verified at
`examples/_template/package.json:6-17`, `examples/wallet/package.json:6-17`,
`examples/deepbook-full/package.json:6-17`, `examples/fork-greeting/package.json:6-17`,
`examples/token-studio/package.json:6-17`, `examples/private-content/package.json:6-17`,
`examples/arena/package.json:6-17`:

```json
{
	"dev": "devstack up",
	"build": "if [ -f src/generated/dapp-kit-config.ts ]; then tsc -b && vite build; else echo 'skipping build: no src/generated/ — run devstack apply first'; fi",
	"preview": "vite preview",
	"typecheck": "if [ -f src/generated/dapp-kit-config.ts ]; then tsc -b --noEmit; else echo 'skipping typecheck: no src/generated/ — run devstack apply first'; fi",
	"test": "DEVSTACK_STACK=test vitest run",
	"test:watch": "vitest",
	"test:e2e": "DEVSTACK_STACK=test playwright test",
	"clean": "rm -rf dist .turbo node_modules/.tmp",
	"apply": "devstack apply",
	"stack": "devstack stack"
}
```

Important: **`pnpm dev` is `devstack up`** — not `vite dev`. The devstack supervisor owns the dev
cycle; Vite is a _child_ of it (spawned via `Dev(...)`).

Two non-Vite examples differ:

- `effect-app/package.json:6-11` — `dev` not present; `start: "tsx src/main.ts"` + `typecheck` +
  `test`.
- `plugin-author-redis/package.json:6-12` — `dev: "devstack up"`, plus `apply`, `typecheck`,
  `stack`; no build/preview/test scripts.

### `engines.node`

All examples pin `engines.node: ">=24"` (e.g. `examples/_template/package.json:44-45`,
`examples/wallet/package.json:44-45`).

## Capabilities CONSUMED

Each example app consumes a wide surface from devstack, dapp-kit, the dev-wallet, and the broader
Sui ecosystem. The breakdown below is faceted by category.

### From `@mysten-incubation/devstack` (the main barrel)

Imported by every Vite-having example's `devstack.config.ts` (cited from
`examples/_template/devstack.config.ts:11-19`):

- `Account` — factory for `LayeredTag<name, AccountHandle>` (account Ref).
- `Action` — post-publish single-tx builder; consumes
  `{ signer, needs, build, gasBudget?, cacheKey? }`.
- `Codegen` — codegen plugin factory; reads `packages: [...]`.
- `Coin` — coin Ref factory; `Coin.fromPackage(pkg, symbol)` for post-publish coin type resolution
  (`examples/wallet/devstack.config.ts:67-68`).
- `Dev` — dev-server primitive; consumes `command`, `args` (with `{port}` token), `port`, `needs`.
- `devstack` — varargs composer that returns the supervisor handle (with `.run()` / `.runMain()` /
  `.layer`).
- `Package` — Move publish primitive; auto-discovers coins and surfaces
  `pkg.coins[<sym>].treasuryCapId` etc.
- `Wallet` — declares an embedded dev-wallet HTTP server; consumes `accounts: [...]`,
  `allowedOrigins: string[]`.

Other factories consumed by specific examples:

- `Sui` — explicit (only when the app needs to override defaults — used in fork-greeting +
  effect-app: `examples/fork-greeting/devstack.config.ts:51-58`,
  `examples/effect-app/src/main.ts:31`). The supervisor auto-injects a default `Sui()` when omitted;
  deepbook-full relies on this (`examples/deepbook-full/devstack.config.ts:226,234`).
- `Postgres` — long-lived postgres container; consumes `databases: string[]`
  (`examples/deepbook-full/devstack.config.ts:63`).
- `Pyth`, `PythPusher` — Pyth on-chain feeds; consumes `{local:{signer,vendor,feeds:[...]}}` etc.
  (`examples/deepbook-full/devstack.config.ts:72-130`).
- `Deepbook` — Deepbook v3 deploy; consumes `{local:{signer,vendor|movePackagePath,pools:[...]}}`
  (`examples/deepbook-full/devstack.config.ts:135-158`,
  `examples/wallet/devstack.config.ts:118-141`).
- `DeepbookIndexer`, `DeepbookServer` — Rust containers; consume
  `{postgres,sui,deepbook,margin,databaseName}`
  (`examples/deepbook-full/devstack.config.ts:224-238`).
- `DeepbookMargin`, `DeepbookMargin.seed` — (`examples/deepbook-full/devstack.config.ts:191-220`).
- `DeepbookMarketMaker` — continuous maker fiber; consumes `{name,signer,strategy,pools,dependsOn}`
  (`examples/deepbook-full/devstack.config.ts:243-266`,
  `examples/wallet/devstack.config.ts:147-170`).
- `VendorDeepbook` — git-fetch helper for the deepbook Move source
  (`examples/deepbook-full/devstack.config.ts:54-57`).
- `DEFAULT_POOL_RISK_CONFIG`, `SUI_PRICE_FEED_ID`, `DEEP_PRICE_FEED_ID`, `USDC_PRICE_FEED_ID`,
  `SUI_MARGIN_DEFAULTS`, `USDC_MARGIN_DEFAULTS` — exported constants the deepbook-full config
  interpolates (`examples/deepbook-full/devstack.config.ts:17-28`).
- `Walrus` — Walrus committee + proxy; consumes `{local:{nodeCount,seedAccounts:[...]}}`
  (`examples/private-content/devstack.config.ts:36`).
- `Seal`, `SealKeyServerTag` — Seal key server + its Effect tag for the extras projection
  (`examples/private-content/devstack.config.ts:41`,
  `examples/private-content/devstack.config.ts:66-72`).

### From `@mysten-incubation/devstack/advanced`

- `pickCreatedByType` — used by arena to pull the seeded Lobby's id from the action's objectChanges
  (`examples/arena/devstack.config.ts:18,74`).
- `PackageWithCapture` — used by fork-greeting for typed object-id capture
  (`examples/fork-greeting/devstack.config.ts:24,74-77`).
- `defineEntrypoint`, `dockerContainer`, `makeService`, `DockerContainerHandle`, `LayeredTag` — used
  by plugin-author-redis (`examples/plugin-author-redis/redis-plugin.ts:25-30`).

### From `@mysten-incubation/devstack/vite`

- `defineDevstackViteConfig` — only export apps use, in every `vite.config.ts`. Cited:
  `examples/_template/vite.config.ts:1-3`, `examples/deepbook-full/vite.config.ts:1-3`.

### From `@mysten-incubation/devstack/playwright`

Imported by every e2e spec (cited from `examples/_template/e2e/mint.spec.ts:1`):

- `test`, `expect` — re-exports of `@playwright/test`.
- `connectAs(page, label)` — drives the dev-wallet ConnectButton flow.
- `selectAccount(locator, name)` — `<select>`-by-text shim.
- `loadStackManifest`, `loadStackKeypair` — typed sync loaders for off-UI specs (defined at
  `packages/devstack/src/playwright/artifacts.ts:62-118`); no current example imports these via the
  helper — the arena spec re-implements the same on-disk read inline at
  `examples/arena/e2e/connect-four.spec.ts:1-62`. See Opportunities below.
- `defineDevstackPlaywrightConfig` — every `playwright.config.ts`.

### From `@mysten-incubation/devstack/vitest`

- `defineDevstackVitestConfig` — every `vitest.config.ts`. No example uses
  `it.layer(stack.layer)(...)` today — the historical `withDevstack` wrapper has been deleted
  (`packages/devstack/src/vitest/index.ts:8-22`).

### From `@mysten-incubation/dev-wallet` (only in generated code)

- `devWalletInitializer`, `DevWalletInitializerConfig` — imported by the _generated_
  `src/generated/dapp-kit-config.ts:6` (template-rendered by `DappKitConfigEmitter` —
  `packages/devstack/src/codegen/emitters/dapp-kit-config.ts:92`).
- `createDevstackAdapterFromManifest` from `@mysten-incubation/dev-wallet/adapters` — same place
  (`packages/devstack/src/codegen/emitters/dapp-kit-config.ts:93`). Apps don't import these
  directly; they spread `devstackDappKitConfig` (which already wired them) into `createDAppKit`.

### From `@mysten/dapp-kit-react`

Imported by every Vite app's `main.tsx` + `App.tsx` + `dapp-kit.ts` (cited from
`examples/_template/main.tsx:3`, `examples/_template/src/dapp-kit.ts:5`,
`examples/_template/src/App.tsx:2-3`):

- `createDAppKit` — main factory.
- `DAppKitProvider` — context provider.
- `ConnectButton` — from `/ui` subpath. Drives the wallet panel.
- `useCurrentAccount`, `useCurrentClient`, `useDAppKit` — runtime hooks.

The wallet example additionally uses `@mysten/dapp-kit-react/ui`'s `ConnectButton` and the
`Register` declaration-merging interface to strongly-type the kit globally
(`examples/_template/src/dapp-kit.ts:17-21`).

### From `@mysten/sui`

- `Transaction` from `@mysten/sui/transactions` — in App.tsx of every mint-having app
  (`examples/_template/src/App.tsx:4`, `examples/deepbook-full/src/components/Mint.tsx:2`).
- `Ed25519Keypair` + `decodeSuiPrivateKey` from `@mysten/sui/cryptography` + `/keypairs/ed25519` —
  used by the off-UI arena e2e (`examples/arena/e2e/connect-four.spec.ts:6-8`); same shape is folded
  into the playwright `loadStackKeypair` helper
  (`packages/devstack/src/playwright/artifacts.ts:31-32`).
- `SuiJsonRpcClient` from `@mysten/sui/jsonRpc` — arena e2e
  (`examples/arena/e2e/connect-four.spec.ts:7`).
- `SuiGrpcClient` from `@mysten/sui/grpc` — _generated_ `dapp-kit-config.ts` (template renders
  `import { SuiGrpcClient } from '@mysten/sui/grpc'` at
  `packages/devstack/src/codegen/emitters/dapp-kit-config.ts:125`).
- `ClientWithCoreApi` from `@mysten/sui/client` — wallet example's transactions helper
  (`examples/wallet/src/lib/transactions.ts:2`).

### From `@mysten/deepbook-v3`

- `DeepBookClient` + `deepbook` extender — wallet + deepbook-full's trading transaction builders
  (`examples/deepbook-full/src/lib/transactions.ts:1`, `examples/wallet/devstack.config.ts:23`
  indirectly via the `@mysten/deepbook-v3` package.json dep at `examples/wallet/package.json:23`).

### From `@mysten/wallet-standard`

- No direct imports in app source — apps consume the wallet via dApp-Kit, which talks
  wallet-standard under the hood. The dependency is declared (`examples/_template/package.json:25`)
  because dApp-Kit's types reference it transitively.

### From `@tanstack/react-query`

- `QueryClient`, `QueryClientProvider`, `useMutation`, `useQuery`, `useQueryClient`,
  `UseMutationResult` — every app's `main.tsx` + `lib/queries.ts` (cited from
  `examples/_template/src/main.tsx:4`, `examples/deepbook-full/src/lib/queries.ts:3-8`).

### From `effect`

- `Effect` — used in `devstack.config.ts` when an `Action.build` or an `extras` projection needs
  Effect generators (`examples/_template/devstack.config.ts:10`,
  `examples/arena/devstack.config.ts:8`, `examples/private-content/devstack.config.ts:13`,
  `examples/effect-app/src/main.ts:13`). The deepbook-full config imports `Effect` to keep the
  lint-unused-var quiet (`examples/deepbook-full/devstack.config.ts:8,290`).

### From `@effect/platform-node`

- `runMain` from `@effect/platform-node/NodeRuntime` — effect-app only
  (`examples/effect-app/src/main.ts:14`, `examples/effect-app/package.json:13`).

### From React

- React 19 (catalog) + `react-dom` — every Vite app (`examples/_template/package.json:28-29`).

### From the dev toolchain (devDependencies)

- `@playwright/test`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `tailwindcss`, `vite`, `vitest`,
  `typescript` — common to all Vite apps (`examples/_template/package.json:32-43`).
- `@mysten-incubation/tsconfig` — shared TS config workspace package
  (`examples/_template/package.json:32`).

### Engine resources (consumed at runtime)

- **Per-stack manifest sidecar** at `.devstack/stacks/<stack>/manifest.json` (or
  `.devstack/manifest.json` for the legacy `main` shape) — read by Vite via the
  `defineDevstackViteConfig` resolve alias (`packages/devstack/src/vite/index.ts:69-77,99-101`) and
  by Playwright via the `webServer` block (`packages/devstack/src/playwright/web-server.ts:87-126`).
- **Per-stack runtime keys** at `.devstack/stacks/<stack>/runtime/accounts/<name>.key` — read by
  arena's e2e (`examples/arena/e2e/connect-four.spec.ts:24,59-61`) and by the helper
  `loadStackKeypair` (`packages/devstack/src/playwright/artifacts.ts:99-118`).
- **Per-stack wallet token** at `.devstack/stacks/<stack>/runtime/wallet/token` — written by the
  Wallet service; consumed indirectly via the `pairUrl` baked into the generated
  `dapp-kit-config.ts` (`examples/_template/src/generated/dapp-kit-config.ts:13-17`).
- **Port allocator** — the supervisor sets `$PORT` for the spawned Vite, which
  `defineDevstackViteConfig` honors over the call-site fallback
  (`packages/devstack/src/vite/index.ts:111-112`).
- **File watcher** — the supervisor watches `devstack.config.ts` + Move sources; apps configure Vite
  to _ignore_ `.devstack/**` to prevent feedback loops
  (`packages/devstack/src/vite/index.ts:107-109`).
- **Traefik router** — apps' allowedOrigins include both the routed hostname
  (`http://dev.<app>.localhost:5175`) and the direct port (`http://localhost:<port>`); HMR is wired
  with `clientPort: 5175` for the routed path (`packages/devstack/src/vite/index.ts:121-126`).
- **State store / cache** — apps don't read state-store entries directly; the supervisor surfaces
  them through the manifest (e.g. captured object ids landing on `pkg.captured.<key>` →
  `src/generated/captured.ts`).

### External resources

- **Docker** — apps don't shell to docker directly; the supervisor brings up sui-localnet, walrus,
  seal, postgres, deepbook etc. for them.
- **Sui CLI** — needed in PATH for Move compilation (called by `Package(...)`'s publish path). Apps
  list this as a README prerequisite (e.g. `examples/wallet/README.md:21`).
- **Node >= 24** — `engines.node` pin (every app's `package.json:44-45`).
- **Pyth benchmarks API** (`benchmarks.pyth.network`) — `PythPusher`'s default source
  (deepbook-full; `examples/deepbook-full/devstack.config.ts:120-121`).

### Codegen artifact imports (the `src/generated/` consumer surface)

This is the core _contract_ between the app source and devstack. Every Vite-having app's `src/`
imports from `./generated/`:

- `import { accounts } from './generated/accounts.js'` — named-account → address record.
  `as const`-typed. (`examples/_template/src/generated/accounts.ts:8-11` →
  `examples/deepbook-full/src/components/Mint.tsx:7` →
  `examples/deepbook-full/src/lib/deployment.ts:5`).
- `import { packages } from './generated/packages.js'` — per-package id, upgradeCapId, mvr
  placeholder, optional `captured` map. Apps reach for `.id` (template's `App.tsx:7`,
  `examples/deepbook-full/src/components/Mint.tsx:6`).
- `import { services } from './generated/services.js'` — resolved endpoint URLs for `sui`, `walrus`,
  `seal`, `deepbook`. Apps read `.sui?.rpc.url`
  (`examples/deepbook-full/src/lib/deployment.ts:7,44`).
- `import { coins } from './generated/coins.js'` — auto-discovered coin metadata (symbol, type,
  decimals, treasuryCapId, metadataId, packageId). Apps haven't surfaced direct consumption of
  `coins.ts` in the current tree (token-studio reads coins out of `deepbookConfig` in tests written
  for the wallet — the file exists with `{} as const` default content if no `Package` declared a
  coin).
- `import { captured } from './generated/captured.js'` — per-package captured object ids
  (`fork-greeting` reads `captured.greeting.boardId` indirectly via the UI's package consumption; no
  example imports this file's symbol directly in the src I read).
- `import { extras } from './generated/extras.js'` — user-supplied extras projection from
  `devstack(... , { extras: ... })`. Mode 0o600, gitignored.
- `import { devstackDappKitConfig } from './generated/dapp-kit-config.js'` — the single
  most-load-bearing import. Spread into `createDAppKit({ ... })`
  (`examples/_template/src/dapp-kit.ts:6-10`, `examples/deepbook-full/src/dapp-kit.ts:5-10`,
  `examples/wallet/src/dapp-kit.ts:5-10`).
- `import { deepbookConfig } from './generated/deepbook-config.js'` — emitted by
  `DeepbookConfigEmitter` for stacks that declared `Deepbook(...)`. Spread into
  `new DeepBookClient({ ...deepbookConfig })` or surfaced through an app-level `deployment`
  projection (`examples/deepbook-full/src/lib/deployment.ts:6`,
  `examples/wallet/src/lib/deployment.ts:15`, `examples/deepbook-full/src/components/Mint.tsx:5`,
  `examples/deepbook-full/src/components/Trading.tsx:5`,
  `examples/deepbook-full/src/components/Ticker.tsx:3`,
  `examples/deepbook-full/src/components/Health.tsx:2`,
  `examples/deepbook-full/src/lib/transactions.ts:5`).
- `import './generated/bindings/<pkg>/<mod>.js'` — typed Move bindings. No example in the tree
  currently imports these files in the `src/` body I read (the template scaffolds the directory but
  doesn't consume it from `App.tsx`); the import path is set up so apps can opt-in.

## Capabilities PRODUCED

What each example app _produces_ (for the broader system or for its own consumers):

### Routes / endpoints (registered into the manifest)

- `Dev(...)` — registers the `frontend.dev-server` endpoint (in `manifest.app.dev`). Conventional
  URL `http://dev.<app>.localhost:5175` (traefik) + direct `http://localhost:<port>` (port from
  `Dev({port:<n>})`). Cited per endpoint declaration in
  `packages/devstack/src/runtime/endpoint-names.ts:61-66`.
- `Wallet(...)` — registers the `wallet-app` endpoint. Conventional URL
  `http://wallet.<app>.localhost:5180`, direct `http://localhost:5180`
  (`packages/devstack/src/runtime/endpoint-names.ts:54-59`). Pair URL with bearer token
  (`http://wallet.<app>.localhost:5180/#token=<hex>`) is what the codegen embeds for the
  burner-wallet adapter.

### Files written to disk under `<app>/`

- `.devstack/manifest.json` — legacy flat manifest (mode 0o600). The template's snapshot is at
  `examples/_template/.devstack/manifest.json` (an older v0 schema with `endpoints[]`).
- `.devstack/stacks/<stack>/manifest.json` — v5 typed manifest (mode 0o600). Shape verified at
  `examples/_template/.devstack/stacks/main/manifest.json:1-52`.
- `.devstack/stacks/<stack>/runtime/accounts/<name>.key` — per-account bech32 secret key (mode
  0o600, `examples/_template/.devstack/stacks/main/runtime/accounts/`).
- `.devstack/stacks/<stack>/runtime/wallet/token` — wallet bearer token (mode 0o600,
  `examples/_template/.devstack/stacks/main/runtime/wallet/token`).
- `.devstack/stacks/<stack>/state.json` — supervisor state record (per-stack key store).
- `.devstack/stacks/<stack>/.keys/<name>.key` — legacy key location; newer code reads from
  `runtime/accounts/`.
- `.devstack/git/<plugin>.<repo>/<hash>/...` — VendorDeepbook's git clone cache (deepbook-full).
- `.devstack/vendor/<plugin>/<ref>/...` — VendorDeepbook's materialized Move tree (deepbook-full;
  `examples/deepbook-full/.devstack/vendor/deepbook/v7.0.0/{token,usdc,deepbook,pyth,deepbook_margin,margin_liquidation}/`).
- `.devstack/imports/<plugin>...` — wallet example references
  `.devstack/imports/mystenlabs_deepbookv3@v7.0.0/packages/deepbook` for the DeepBook source via
  `movePackagePath:` (a different vendoring scheme from VendorDeepbook).

### Files written to `src/generated/` (codegen artifacts)

All listed in `## Capabilities CONSUMED → Codegen artifact imports`. Two are gitignored as
secret-tier:

- `src/generated/dapp-kit-config.ts` — carries the dev-wallet bearer token (`pairUrl`).
- `src/generated/extras.ts` — user-supplied; treated as secret-tier by default. (See
  `examples/_template/src/generated/.gitignore:1-5`.)

### Move build artifacts (gitignored)

`move/**/build/`, `move/**/package_summaries/`, `*.mv` — written by `sui move build` /
`sui move summary` during codegen (`examples/_template/.gitignore:42-44`).

### TypeScript exports (what _user code_ exposes)

- `App` from `src/App.tsx` — the React root.
- `dAppKit` from `src/dapp-kit.ts` — the configured dApp-Kit instance (also stamped onto
  `globalThis.__devstackDAppKit__` for the Playwright helper to drive — cited at
  `examples/_template/src/dapp-kit.ts:14-15`).
- effect-app additionally exports `program`, `alice`, `sui` for unit-testability
  (`examples/effect-app/src/main.ts:26-31,37-43`).

### Container images / volumes

Apps don't _produce_ container images directly; the services they declare (sui-localnet, walrus,
seal, postgres, deepbook) pull pre-built images via the supervisor. Vendor caches
(`.devstack/vendor/`) and git clones (`.devstack/git/`) are the only persisted on-disk artifacts
created by an app's dependencies.

### Logs

Each app may write a `.stack.log` / `.e2e.log` / `.stack-<variant>.log` adjacent to its
`package.json` (observed: `examples/wallet/.stack.log`, `examples/arena/.stack.log`,
`examples/private-content/.stack-{alpha,test}.log`, `examples/token-studio/.e2e.log`). These are
written by the supervisor's log sink in TTY-detached mode; not gitignored at the example level but
covered by the workspace-level `*.log` glob.

## Lifecycle

### Startup (the `pnpm dev` cycle)

The user runs `pnpm dev` (which expands to `devstack up` — `examples/_template/package.json:7`). The
lifecycle within an example app is:

1. **CLI entry** — `devstack up` starts the supervisor in this app's cwd. It loads
   `devstack.config.ts` via tsx and reads the default export (the `devstack(...)` handle).
2. **State-dir lock** — `.devstack/stacks/<stack>/` is acquired via a per-stack file lock (engine
   concern; documented elsewhere).
3. **Engine bring-up** — Effect layers materialize in dependency order per the `needs:` edges
   declared in `Dev(...)` etc. Concretely for `_template`:
   - `Account('alice')` + `Account('bob')` resolve (ephemeral keypair created + funded via the
     localnet faucet).
   - `Package('hello', helloDir)` publishes via `sui move build` + `executeTransaction`.
   - `Action('mint-greeting')` runs after `hello` (its `needs: [hello]` edge —
     `examples/_template/devstack.config.ts:31`).
   - `Wallet({...})` starts the embedded HTTP server, mints a bearer token, and writes it to
     `.devstack/stacks/<stack>/runtime/wallet/token`.
   - `Codegen({packages:[hello]})` runs after `hello`+`wallet` (its emitters consume the manifest
     snapshot — `BindingsEmitter` reads the published package, `DappKitConfigEmitter` reads
     `app.wallet.{url,pairUrl}`, etc.).
4. **Manifest write** — supervisor writes `.devstack/stacks/<stack>/manifest.json` (mode 0o600) with
   the v5 shape (`stack`, `services`, `packages`, `accounts`, `coins`, `app.{dev,wallet,extras}`).
5. **Codegen sidecar** — files emitted into `src/generated/`. The build/typecheck scripts in
   `package.json:8-10` guard on `src/generated/dapp-kit-config.ts` existing so a never-applied stack
   doesn't error.
6. **`Dev(...)` spawn** — supervisor spawns `pnpm exec vite --port {port}` (with `{port}` filled in
   by the allocator). Vite reads `vite.config.ts`, which calls `defineDevstackViteConfig({port:N})`,
   which:
   - Pins `server.port` to `$PORT` (set by supervisor) or the fallback.
   - Aliases the legacy flat manifest path `../../.devstack/manifest.json` to the active stack's
     manifest under `.devstack/stacks/<stack>/manifest.json`
     (`packages/devstack/src/vite/index.ts:74-100`).
   - Pins `server.allowedHosts: ['.localhost']` and HMR `clientPort: 5175`.
7. **Vite ready** — Vite serves at both the direct port and (via Traefik) the routed hostname; React
   app loads, dApp-Kit constructor runs with the burner-wallet adapter, the dev-wallet panel mounts
   in `document.body` (if `mountUI: true`; defaults to false, but the codegen-emitted
   `devstackDappKitConfig` doesn't pass `mountUI: true` — the dev wallet pairs via the popup URL
   instead).
8. **TUI** — the supervisor's TUI renders `[sui] [wallet] [dev] [codegen]` rows showing per-service
   status. The user's browser is the primary surface; the TUI is a control plane.

### Ready criteria

- **Dev server ready** — Vite prints its listening line; the supervisor's `Dev` primitive considers
  it ready when the spawned process opens the port. Playwright `webServer.url` is the manifest's
  `app.dev.url` (`packages/devstack/src/playwright/web-server.ts:40-44`).
- **Stack ready** — manifest written + all services' ready probes green + codegen artifacts on disk.
  Apps gate UI rendering on `Object.keys(deepbookConfig.pools).length > 0`
  (`examples/deepbook-full/src/App.tsx:12,29`) or `Object.keys(deployment.accounts).length > 0`
  (`examples/wallet/src/lib/deployment.ts:90`).
- **Test ready** — Playwright's `webServer` block waits up to its configured `timeout` for
  `webServer.url` to respond 200. Defaults: 300_000 ms (preset default) or 120_000 ms (raw
  `webServer` helper default); apps override to 900_000 for walrus/seal/fork.

### Restart behavior

- **Hot-restart of `devstack.config.ts`** — the supervisor watches the config file and reloads when
  it changes. Some examples disable this under Playwright to dodge a known race
  (`examples/arena/devstack.config.ts:67-69`, `examples/fork-greeting/devstack.config.ts:99-103`):
  codegen's first cycle touches Move source files that trip the watcher, and Playwright's
  `webServer` then sees a brief vite-death window.
- **Idempotent re-publish** — `Action` factories take a `cacheKey: Effect<string>` for idempotency
  (arena's `openLobby` uses the publishing package's id as the key —
  `examples/arena/devstack.config.ts:37-41` — so restarts reuse the same Lobby object rather than
  minting a fresh one each time).
- **Vite hot-reload** — codegen artifacts under `src/generated/` are written via `writeIfChanged`
  (`packages/devstack/src/codegen/helpers.ts` per the comment trail); Vite HMR picks them up. The
  dapp-kit-config has a bearer token that changes on wallet restart, so HMR'ing it forces a wallet
  re-pair.
- **No-op re-runs** — `pnpm dev` against a warm cache reuses the per-stack state in
  `.devstack/stacks/<stack>/`; vendor caches under `.devstack/git/` + `.devstack/vendor/` persist
  across restarts.

### Teardown

- **Ctrl-C on `pnpm dev`** — supervisor catches SIGINT/SIGTERM, runs Effect finalizers, sends
  SIGTERM to the spawned Vite process group, stops containers gracefully. Dev tags'
  `stopGraceSeconds` (e.g. redis at 5s in `examples/plugin-author-redis/redis-plugin.ts:101`) bound
  the wait.
- **Playwright SIGTERM** — `defineDevstackPlaywrightConfig` sets the `webServer.gracefulShutdown` to
  `{signal:'SIGTERM', timeout:10_000}` (`packages/devstack/src/playwright/web-server.ts:62`).
  Without this, Playwright default-kills the shell with SIGKILL, reparenting Vite and the supervisor
  to init and orphaning ports — see the comment at
  `packages/devstack/src/playwright/web-server.ts:53-62`.
- **`devstack down` / `devstack wipe`** — engine concern; apps don't invoke these directly via
  scripts, but the `pnpm clean` script removes `dist .turbo node_modules/.tmp` (not `.devstack/` —
  user-facing "wipe" is the CLI command). Cited: `examples/_template/package.json:14`.

## Hard requirements / invariants

The following are the load-bearing contracts an example app must honor. Most are absent → fail-loud
at runtime; a few are absent → silent confusion.

### Wallet wiring

- **The user's hand-written `dapp-kit.ts` MUST spread `devstackDappKitConfig` into
  `createDAppKit`.** Without this, the wallet panel + burner-wallet adapter aren't wired and
  `connectAs` fails. Cited pattern: `examples/_template/src/dapp-kit.ts:8-10`.
- **The user's `dapp-kit.ts` MUST stamp the kit onto `globalThis.__devstackDAppKit__`.** This is the
  wire between the app's dApp-Kit instance and the Playwright `connectAs` helper — the helper calls
  `kit.switchAccount(...)` from `page.evaluate`. Without it, every e2e fails with "connectAs:
  globalThis.**devstackDAppKit** missing" (`packages/devstack/src/playwright/helpers.ts:46-52`).
  Cited app-side: `examples/_template/src/dapp-kit.ts:15`, `examples/wallet/src/dapp-kit.ts:14-15`,
  `examples/deepbook-full/src/dapp-kit.ts:12`.
- **The wallet's registered name MUST be `'Dev Wallet'` (the literal string).** The Playwright
  helper queries `dapp-kit-connect-modal getByText('Dev Wallet', { exact: true })`
  (`packages/devstack/src/playwright/helpers.ts:28-29`). Apps don't set this — the dev-wallet's
  `devWalletInitializer` defaults it. Enforced by
  `packages/devstack/src/playwright/helpers.test.ts:62-67`.
- **`Wallet({allowedOrigins:[...]})` MUST include the routed origin AND the direct origin.** Without
  the routed origin, browsers loading the app via Traefik hit a CORS reject. Without the direct
  origin, direct-port reloads break. Cited pattern (all wallet declarations):
  `examples/_template/devstack.config.ts:44`, `examples/arena/devstack.config.ts:50`,
  `examples/deepbook-full/devstack.config.ts:270`, `examples/private-content/devstack.config.ts:45`,
  `examples/wallet/devstack.config.ts:174`, `examples/fork-greeting/devstack.config.ts:81`,
  `examples/token-studio/devstack.config.ts:26`.

### Per-stack isolation

- **`vite.config.ts` MUST resolve the per-stack manifest** — `defineDevstackViteConfig`'s alias
  trick lets multiple stacks (e.g. `pnpm dev` + `DEVSTACK_STACK=test pnpm test:e2e`) coexist without
  cross-talk (`packages/devstack/src/vite/index.ts:64-77`). Apps that inline a custom Vite config
  and bypass the helper would lose this.
- **`DEVSTACK_STACK=test` MUST be set for `test` / `test:e2e`** — every test script sets it
  explicitly (`examples/_template/package.json:11-13`). Without it, tests contend on the `main`
  stack's port allocator and the supervisor's per-stack lock.

### Dev-server gating

- **`Dev(...)` MUST be in the `needs:` chain after `Codegen(...)` and every `Package(...)` it
  consumes.** Without this, Vite spawns before `src/generated/` exists and the app fails at import
  time (the `App.tsx` calls `packages.hello.id` immediately — `examples/_template/src/App.tsx:11`;
  no `isDeployed` guard). The guard the deepbook-full example uses
  (`Object.keys(deepbookConfig.pools).length > 0` — `examples/deepbook-full/src/App.tsx:12`) catches
  a _late_ state (apply'd but no pools yet), not an _absent_ `src/generated/`. The build/typecheck
  scripts gate on the file's existence (`examples/_template/package.json:8,10`).
- **`Dev(...)`'s `--strictPort` (when set) MUST match the supervisor allocator** —
  wallet/arena/deepbook-full/fork-greeting/private-content pass `--strictPort` in `args`, which
  means Vite refuses to drift to a different port if the configured one is taken. The supervisor's
  allocator guarantees the port (via `$PORT`), so the strict flag is a defensive check.

### Playwright contract

- **`testDir: './e2e'`** — every spec lives under `./e2e/` (preset default —
  `packages/devstack/src/playwright/define-config.ts:50`). Apps that hide specs elsewhere wouldn't
  be picked up.
- **`workers: 1, fullyParallel: false`** — preset default
  (`packages/devstack/src/playwright/define-config.ts:51-52`). The comment cites: "devstack apps
  share one supervisor per stack — parallel tests would contend." Apps that override would race on
  the wallet's state, the maker's order book, etc.
- **`reuseExistingServer: !process.env.CI`** —
  (`packages/devstack/src/playwright/web-server.ts:46`). In dev, a running `pnpm dev` is reused by
  `pnpm test:e2e`; in CI, every test cycle gets a fresh stack.
- **`gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 }`** —
  (`packages/devstack/src/playwright/web-server.ts:62`). Without this, Playwright SIGKILL leaves
  orphan Vite processes (commit `41366505` is cited in `web-server.test.ts:79`).

### Codegen

- **`src/generated/.gitignore` MUST exclude `dapp-kit-config.ts` and `extras.ts`** — the former
  carries a bearer token (`pairUrl`), the latter user-supplied secret-tier content. Cited:
  `examples/_template/src/generated/.gitignore:1-5`.
- **Generated files MUST end in `.js` when imported** (TypeScript ESM convention) — every app uses
  `.js` extensions in its `from './generated/<x>.js'` imports (`examples/_template/src/App.tsx:7`,
  `examples/_template/src/dapp-kit.ts:6`).

### Move sources

- **`move/<pkg>/Move.toml` package address MUST be the literal `0x0`** (the published address; the
  supervisor patches it during publish). Implied by `Package(...)`'s convention; apps don't
  re-document this in their READMEs.

## Failure modes

### `src/generated/` doesn't exist (cold first run)

- **Trigger**: User runs `pnpm build` or `pnpm typecheck` before `pnpm dev` / `pnpm apply` has ever
  populated codegen.
- **Current behavior**: Script's `if [ -f src/generated/dapp-kit-config.ts ]` guard prints the
  explanatory message and exits 0 (`examples/_template/package.json:8,10`). `pnpm dev`'s flow runs
  the supervisor which writes the directory.
- **Recovery**: `pnpm dev` once, then retry.

### Stale `src/generated/` (manifest schema changed)

- **Trigger**: `devstack` is upgraded and the manifest shape moved without re-running codegen.
- **Current behavior**: TS compile error against the new shape; the generated module imports break
  at runtime.
- **Recovery**: `pnpm dev` regenerates; or `pnpm apply` for a one-shot regen.

### `globalThis.__devstackDAppKit__` not set

- **Trigger**: User wrote a custom `dapp-kit.ts` that doesn't stamp the global.
- **Current behavior**: `connectAs` throws a descriptive error citing the exact line to add
  (`packages/devstack/src/playwright/helpers.ts:46-52`).
- **Recovery**: Add the stamping line per the helper's error message.

### Wallet's `allowedOrigins` missing the entry the browser is on

- **Trigger**: Wallet declaration omits the dev-server origin.
- **Current behavior**: Wallet HTTP server CORS-rejects the pair-request from the browser;
  ConnectButton flow stalls.
- **Recovery**: Add both `http://dev.<app>.localhost:5175` and `http://localhost:<dev-port>` to
  `allowedOrigins`.

### Vite spawns before codegen lands

- **Trigger**: User defines `Dev(...)` without `codegen` in `needs:`.
- **Current behavior**: Vite import fails because `src/generated/dapp-kit-config.ts` doesn't exist;
  browser sees build errors.
- **Recovery**: Add `codegen` to `Dev({ needs: [...] })`.

### Playwright `webServer` times out

- **Trigger**: Cold-start exceeds the timeout (walrus/seal images pulling, fork system-state
  warming).
- **Current behavior**: Playwright fails with "webServer didn't ready in time".
- **Recovery**: Pass `defineDevstackPlaywrightConfig({ timeout: 900_000 })` for the affected stacks
  (`examples/private-content/playwright.config.ts:5`,
  `examples/fork-greeting/playwright.config.ts:7`).

### Hot-restart racing playwright's first navigation

- **Trigger**: Codegen + `sui move build` touch files inside `move/` during the first cycle, watcher
  re-triggers, Vite briefly dies, Playwright's first `page.goto('/')` hits a 502.
- **Current behavior**: Intermittent test failures (502 surface).
- **Recovery**: `hotRestart: process.env.PLAYWRIGHT === '1' ? false : undefined` in
  `devstack({...})` options (arena, fork-greeting).

### Wallet bearer token regenerated on restart

- **Trigger**: `Wallet(...)` restarts (e.g. crash), new bearer token is minted, `pairUrl` in
  `dapp-kit-config.ts` changes.
- **Current behavior**: Existing browser tabs hold a stale token; next dApp-Kit request to the
  wallet fails. HMR'ing the generated module forces a re-pair.
- **Recovery**: Reload the browser; HMR usually catches it.

### Cold-start playwright config (no manifest yet)

- **Trigger**: `playwright.config.ts` loads before `devstack up` has written a manifest.
- **Current behavior**: `webServer({endpoint})` falls back to the conventional URL
  (`<stack>.<service>.<app>.localhost:<port>`) so Playwright's `webServer.url` is set; the spawned
  `pnpm dev` then materializes the real manifest and the URL converges
  (`packages/devstack/src/playwright/web-server.ts:96-126`).
- **Recovery**: None needed; designed-in convergence.

### Malformed manifest

- **Trigger**: A truncated write or stale schema leaves an invalid manifest on disk.
- **Current behavior**: `Schema.decodeUnknown(Manifest)` rejects; helpers throw `ManifestShapeError`
  with `RECOVERY: run devstack apply`
  (`packages/devstack/src/playwright/web-server.test.ts:128-150`).
- **Recovery**: `devstack apply` (or `pnpm apply`).

### Endpoint not in manifest

- **Trigger**: A spec references an endpoint name a plugin didn't publish (e.g. `wallet-app` on a
  stack without a `Wallet(...)`).
- **Current behavior**: `webServer` throws "no endpoint '<name>' in manifest at <path>"
  (`packages/devstack/src/playwright/web-server.ts:127-132`).
- **Recovery**: Add the primitive, or pick a different endpoint name.

### Fork-mode seed placeholder

- **Trigger**: User runs `fork-greeting` without overriding `FORK_SEED_ADDRESSES`.
- **Current behavior**: Publish fails with "insufficient gas" against the placeholder address
  (`examples/fork-greeting/devstack.config.ts:45-48`).
- **Recovery**: Set `FORK_SEED_ADDRESSES` to addresses you control on testnet.

### `pnpm test` finds no tests

- **Trigger**: App has only `e2e/` specs; vitest finds nothing in `src/`.
- **Current behavior**: `passWithNoTests: true` in the preset
  (`packages/devstack/src/vitest/define-config.ts:31`) makes vitest exit 0. Vitest also excludes
  `e2e/**` (`packages/devstack/src/vitest/define-config.ts:31`).
- **Recovery**: None needed.

## Persistence model

Per-app, the on-disk persistence picture:

### What survives restart

- `.devstack/stacks/<stack>/manifest.json` — full v5 manifest. Each restart re-decodes + reuses
  where contents are idempotent.
- `.devstack/stacks/<stack>/state.json` — engine state record (per-service caches the supervisor
  stamps; details belong to other docs).
- `.devstack/stacks/<stack>/runtime/accounts/<name>.key` — account keypairs. Reused across restarts
  so an ephemeral-funded account's address is stable.
- `.devstack/stacks/<stack>/runtime/wallet/token` — wallet bearer token. Reused so existing browser
  tabs survive a quick restart; rotated when the wallet service itself is reset.
- `.devstack/git/<plugin>.<repo>/<hash>/...` — Git clones (e.g. vendor deepbook v7.0.0 in
  `examples/deepbook-full/.devstack/git/vendorDeepbook.deepbook/<hash>/`).
- `.devstack/vendor/<plugin>/<ref>/...` — materialized Move trees
  (`examples/deepbook-full/.devstack/vendor/deepbook/v7.0.0/`).
- `.devstack/imports/<plugin>...` — wallet's deepbook source (different vendor scheme).
- `src/generated/*` — codegen artifacts; rewritten on every apply cycle but unchanged content uses
  `writeIfChanged`.

### What survives snapshot (subset of persisted)

OPEN QUESTION: example apps don't directly invoke snapshot/restore; the contract is on the engine.
Apps would need to know which of their on-disk artifacts are snapshot-included vs not — current code
doesn't expose this to the app's `devstack.config.ts`.

### What gets wiped on `devstack wipe`

OPEN QUESTION: not explicit in any example's docs. Inference from the gitignore set
(`examples/_template/.gitignore:30-44`): `.devstack/active`, `.devstack/stacks/`,
`.devstack/.generated/`, `.devstack/manifests/`, `.devstack/snapshots/`, `src/generated/`,
`move/**/build/`, `move/**/package_summaries/`, `*.mv`. Cached `.devstack/git/` and
`.devstack/vendor/` are deliberately NOT in the wipe scope (they're expensive to re-fetch).

### What is process-local only

- Vite HMR socket — bound to `clientPort: 5175` for routed access.
- Dev-wallet panel state in `document.body` — re-mounted on every page load via
  `devWalletInitializer` (when `mountUI: true`; the codegen's default is `mountUI: false` so the
  panel pairs via popup URL).
- React-Query cache — `QueryClient` is per-page instance.

## Modes & variants

Most examples are single-mode (dev). The notable mode dimensions are:

| Dimension            | Mode A (dev)                                                                    | Mode B (test)                                              | Mode C (build)                                      | Mode D (effect-app prod)                                       |
| -------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| Command              | `pnpm dev` → `devstack up`                                                      | `pnpm test:e2e` → `DEVSTACK_STACK=test playwright test`    | `pnpm build` → `tsc -b && vite build` (no devstack) | `DEVSTACK_NETWORK=testnet NODE_ENV=production pnpm start`      |
| Stack name           | `main`                                                                          | `test`                                                     | n/a (uses whatever `src/generated/` exists)         | testnet (live)                                                 |
| Supervisor           | Long-running supervisor with TUI                                                | `webServer:` block spawns `pnpm dev` (the same supervisor) | None — Vite consumes pre-existing generated files   | `runMain(program.pipe(Effect.provide(stack.layer)))`; one-shot |
| Manifest path read   | `.devstack/manifest.json` (legacy flat) + `.devstack/stacks/main/manifest.json` | `.devstack/stacks/test/manifest.json`                      | Same as last apply                                  | None — `stack.layer` provides services in-memory               |
| `$PORT` injection    | Supervisor allocator sets it                                                    | Same                                                       | n/a                                                 | n/a                                                            |
| `PLAYWRIGHT` env var | unset                                                                           | `'1'` (stamped by `webServer.env`)                         | n/a                                                 | n/a                                                            |
| Account source       | Per app's `Account(...)` config; localnet faucet                                | Same                                                       | n/a                                                 | `{ kind: 'env', key: 'ALICE_PRIVATE_KEY' }`                    |
| Ready criteria       | Vite listens + codegen complete + TUI shows green                               | `webServer.url` returns 200 within `timeout`               | `vite build` exits 0                                | `Effect.log` calls complete                                    |
| Persistence          | `.devstack/stacks/main/...`                                                     | `.devstack/stacks/test/...`                                | `dist/`                                             | None                                                           |
| Teardown             | Ctrl-C → graceful supervisor shutdown                                           | Playwright SIGTERM (10s budget) → supervisor → vite        | Process exits                                       | Program exits                                                  |
| Failure modes        | Manifest schema, codegen race, port collision                                   | webServer timeout, race against codegen first cycle        | "no src/generated/" → script no-ops                 | `ALICE_PRIVATE_KEY` missing → throw                            |
| Dependencies         | devstack, dev-wallet, dapp-kit, sui, deepbook                                   | + `@playwright/test`, conventional-URL fallback            | tsc + vite + the generated artifacts                | devstack engine only                                           |
| Hard requirements    | Per "Hard requirements" §                                                       | Same + `DEVSTACK_STACK=test` set                           | `src/generated/dapp-kit-config.ts` exists           | `DEVSTACK_NETWORK` set + `Account.kind` flips on `NODE_ENV`    |

The dapp-kit's `runtime` constant in `dapp-kit-config.ts` (`'normal'` vs `'forked'`) and the
`devstackNetwork` constant (unstripped `'testnet-fork'` vs `'testnet'`) give downstream UI code a
fork discriminator without re-importing devstack helpers
(`examples/_template/src/generated/dapp-kit-config.ts:46-52`). `fork-greeting` is the only example
today that exercises this; its config sets `Sui({network:'testnet-fork', fork:{seed:{addresses}}})`
which makes the generated `runtime` constant `'forked'`.

## Test coverage

This section enumerates the e2e specs in each example. There are no in-repo vitest unit tests inside
the example apps; each app's `vitest.config.ts` extends the `passWithNoTests:true` preset.

### `_template/e2e/mint.spec.ts` (1 test)

- `alice sends a greeting` — `connectAs(page,'alice')`; expects `package-id` not 0x0; clicks
  `mint-button`; expects `mint-tx` visible within 20s. Cited:
  `examples/_template/e2e/mint.spec.ts:3-10`.

### `arena/e2e/connect-four.spec.ts` (1 test)

- `alice + bob play to a horizontal win on row 0` — Loads the manifest from disk (re-implements the
  helper). alice connects, waits for `waiting` state; bob clears localStorage + connects, clicks
  `join-lobby`; spec queries `objectChanges` via `SuiJsonRpcClient` to resolve the spawned Game id;
  alice + bob play 7 scripted moves via JSON-RPC; expects game-over banner + cells 0..3 row 0 to
  have `data-cell=1`. Cited: `examples/arena/e2e/connect-four.spec.ts:64-147`.

### `deepbook-full/e2e/margin-order.spec.ts` (1 test)

- `alice places a limit buy on sui_usdc; tx submits + ticker reflects the new bid` —
  `connectAs(page,'alice')`, fills pool/side/ price/qty, submits; expects `Last tx:` visible within
  30s + ticker bid populated within 60s (`examples/deepbook-full/e2e/margin-order.spec.ts:1-25`).

### `deepbook-full/e2e/mint.spec.ts` (1 test)

- `clicking Mint 100 DEEP updates balance-alice-deep with correct delta` — connectAs alice; reads
  initial DEEP balance; clicks `mint-deep-100`; expects `Last tx:` + balance cell to change
  (`examples/deepbook-full/e2e/mint.spec.ts:1-18`).

### `deepbook-full/e2e/oracle-mid.spec.ts` (2 tests)

- `health card shows oracle state + indexer cursor + server REST` — Asserts pythState +
  deepbookPackage + serverRest cells render non-`—` text
  (`examples/deepbook-full/e2e/oracle-mid.spec.ts:9-24`).
- `ticker shows per-pool best bid/ask within 2% of configured mid` — Waits up to 60s for ticker
  rows; asserts `bid < ask` (`examples/deepbook-full/e2e/oracle-mid.spec.ts:26-52`).

### `deepbook-full/e2e/ticker-fetch.spec.ts` (1 test)

- `ticker page renders per-pool rows with numeric lastPrice + bestBid
  - bestAsk`— Waits for`ticker-row-sui_usdc`+`ticker-row-deep_sui` to be visible + bid/ask populated (`examples/deepbook-full/e2e/ticker-fetch.spec.ts:1-24`).

### `fork-greeting/e2e/greeting.spec.ts` (1 test)

- `alice posts a greeting that round-trips through the shared Board` — connectAs alice; asserts
  `board-id` not `(unset)`; fills + posts greeting; expects `post-tx` + `board-latest` to match the
  posted text + counter > 0 (`examples/fork-greeting/e2e/greeting.spec.ts:14-39`).

### `private-content/e2e/seal-flow.spec.ts` (1 test)

- `alice encrypts + uploads, grants bob a cap, bob decrypts` — Full SealClient round trip; uploads,
  captures file id from row, alice round-trip self-decrypts, grants to bob, bob clears
  localStorage + reconnects, decrypts; asserts plaintext matches
  (`examples/private-content/e2e/seal-flow.spec.ts:18-72`).

### `token-studio/e2e/create-coin.spec.ts` (2 tests, serial)

- `alice mints STUDIO to bob` — connectAs alice, expects `TreasuryCap holder` badge; selects bob,
  fills 17, clicks Mint, expects `Last tx:` (`examples/token-studio/e2e/create-coin.spec.ts:11-21`).
- `bob transfers STUDIO to carol` — connectAs bob, expects no TreasuryCap badge; selects carol,
  fills 5, clicks Transfer, expects `Last tx:`
  (`examples/token-studio/e2e/create-coin.spec.ts:23-33`).

### `wallet/e2e/send-sui.spec.ts` (2 tests, serial)

- `alice sends 0.5 SUI to bob; balances update` — Reads initial balances; sends; asserts both
  balances change (`examples/wallet/e2e/send-sui.spec.ts:10-32`).
- `alice sends 100 mUSDC to bob; balances update` — Same shape for the non-native coin
  (`examples/wallet/e2e/send-sui.spec.ts:34-55`).

### `wallet/e2e/swap.spec.ts` (2 tests, serial)

- `bob swaps 1 SUI for mUSDC against the maker bids; balances update` — Picks pool + direction;
  expects bobSui + bobUsdc cells to change (`examples/wallet/e2e/swap.spec.ts:17-38`).
- `bob swaps 100 mUSDC for SUI against the maker asks; balances update` — Mirror swap
  (`examples/wallet/e2e/swap.spec.ts:40-61`).

### Build-integration tests (under `packages/devstack/src/{vite,playwright,vitest}/`)

These are _not_ example-app tests, but they pin the contract the examples consume. Documented in doc
23; flagged here for traceability:

- `packages/devstack/src/vite/index.test.ts` — 7 `it` blocks pinning: canonical plugin set, `port`
  honor, `$PORT` precedence, per-stack alias, flat-main alias, `extraPlugins` order, top-level
  passthrough (`packages/devstack/src/vite/index.test.ts:4-81`).
- `packages/devstack/src/playwright/define-config.test.ts` — 4 `it` blocks pinning: canonical
  config, 300s default timeout, 900s override, `use.trace` extend
  (`packages/devstack/src/playwright/define-config.test.ts:30-60`).
- `packages/devstack/src/playwright/helpers.test.ts` — 6 `it` blocks pinning: export shape, arity,
  custom-element selectors, `'Dev Wallet'` literal, `__devstackDAppKit__` global wire
  (`packages/devstack/src/playwright/helpers.test.ts:33-76`).
- `packages/devstack/src/playwright/web-server.test.ts` — 10+ `it` blocks pinning: manifest
  resolution, cold-start fallback, `DEVSTACK_STACK` host prefix, malformed-manifest guard,
  conventional URL fallback, `PLAYWRIGHT=1` env, SIGTERM graceful shutdown, `baseURL` mirror
  (`packages/devstack/src/playwright/web-server.test.ts`).
- `packages/devstack/src/vitest/define-config.test.ts` — 2 `it` blocks pinning the
  includes/excludes/`passWithNoTests` (`packages/devstack/src/vitest/define-config.test.ts:4-17`).
- `packages/devstack/src/vitest/index.test.ts` — 1 `it` block pinning the `@effect/vitest` optional
  peer dep (`packages/devstack/src/vitest/index.test.ts:20-25`).

## Pain points today

### `dapp-kit.ts` is a near-clone in every app

Every Vite-having app's `src/dapp-kit.ts` is the same 18-22 LOC boilerplate:

```ts
import { createDAppKit } from '@mysten/dapp-kit-react';
import { devstackDappKitConfig } from './generated/dapp-kit-config.js';

export const dAppKit = createDAppKit({ ...devstackDappKitConfig });
(globalThis as { __devstackDAppKit__?: typeof dAppKit }).__devstackDAppKit__ = dAppKit;

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
```

Cited at `examples/_template/src/dapp-kit.ts:1-21`, `examples/wallet/src/dapp-kit.ts:1-21`,
`examples/deepbook-full/src/dapp-kit.ts:1-18`. The duplication exists because:

- The `Register` declaration-merging must occur in the app's own module graph (not in devstack's),
  so dApp-Kit's hooks see the correct `typeof dAppKit`.
- The `__devstackDAppKit__` global must be set after `createDAppKit` resolves — which is async
  (top-level await) in some configurations.

Apps that don't want devstack-specific dApp-Kit dependencies could sidestep the global stamping, but
every `connectAs`-driven test needs it.

### `main.tsx` is also a near-clone

Three apps have effectively identical `main.tsx` modulo whitespace:

```ts
createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DAppKitProvider dAppKit={dAppKit}>
        <App />
      </DAppKitProvider>
    </QueryClientProvider>
  </StrictMode>,
);
```

(`examples/_template/src/main.tsx:16-24`, `examples/deepbook-full/src/main.tsx:17-24`,
`examples/wallet/src/main.tsx:17-24`).

### `Card.tsx` is duplicated verbatim

`examples/_template/src/ui/Card.tsx` and `examples/deepbook-full/src/ui/Card.tsx` are
byte-identical. The wallet example presumably has its own copy too. The duplication is fine for
"this is template scaffolding" but invites drift.

### The `lib/queries.ts` `useSignAndExecute` hook is duplicated

The template's `App.tsx:46-72` defines `useSignAndExecute` inline; the deepbook-full example has the
same hook re-implemented at `examples/deepbook-full/src/lib/queries.ts:43-69`. The wallet example
has yet another copy at `examples/wallet/src/lib/queries.ts` (per the directory listing). This is a
candidate for a `@mysten-incubation/dapp-kit-helpers` sort of shared package, but isn't packaged
today.

### `examples/README.md` is stale

It lists 7 apps but `fork-greeting` and `plugin-author-redis` exist in the tree and aren't in the
table (`examples/README.md:9-16` vs `ls examples/`).

### Implicit "Move build inside `move/` trips watcher" gotcha

Three apps work around this (arena, fork-greeting + the deepbook-full config doesn't disable
hot-restart but doesn't have publishable Move either). The workaround is per-app:

```ts
hotRestart: process.env.PLAYWRIGHT === '1' ? false : undefined,
```

(`examples/arena/devstack.config.ts:67-69`, `examples/fork-greeting/devstack.config.ts:99-103`).
This is a known papercut; the comment in arena's config is the only documentation.

### `placeholder` helpers in deepbook-full

The deepbook-full config has two functions (`deepbookPackagePlaceholder`, `usdcCoinTypePlaceholder`
— `examples/deepbook-full/devstack.config.ts:173-186`) returning literal strings like
`'__DEEPBOOK_PACKAGE_ID__'` that the deepbook factory post-publish rewrites. Comments explicitly
call out this as a type-system workaround; the established pattern is
`Coin.fromPackage(deepbook, 'USDC')` (used by `examples/wallet/` correctly). The deepbook-full
example notes "for now we use literal type strings" — it's a known transitional shape.

### `as any` casts in deepbook-full

- `pyth: pyth as any` for `PythPusher` (`examples/deepbook-full/devstack.config.ts:128-130`).
- `sui: undefined as any` for `DeepbookIndexer` / `DeepbookServer`
  (`examples/deepbook-full/devstack.config.ts:226,234`).

Comments cite type-narrowing limitations in the discriminated-union return shape; flagged as known
shape, not pain.

### Generated `coins.ts` is `{}` in `_template`

`examples/_template/src/generated/coins.ts:11` exports `export const coins = {} as const` because
the `hello` Move package doesn't declare a coin. Apps that want to consume the coin record must
guard for empty.

### Inline manifest loading in arena's e2e

`examples/arena/e2e/connect-four.spec.ts:19-62` re-implements manifest discovery + keypair loading
instead of using the `loadStackManifest` + `loadStackKeypair` helpers
(`packages/devstack/src/playwright/artifacts.ts:62-118`). The helpers post-date the arena spec; the
spec should be migrated. Same pattern would apply to any other off-UI Playwright spec going forward.

### `extras.ts` lives next to non-secret-tier files

Both `src/generated/extras.ts` and `src/generated/dapp-kit-config.ts` are gitignored as secret-tier
(`*.gitignore`); the other six files in `src/generated/` are not. The mixture is confusing — a new
contributor might assume all of `src/generated/` is safe to commit, or all of it is secret. The
selective gitignore reflects the actual trust boundary but isn't documented at the directory level.

### `pnpm dev` blocks the terminal

There's no detached / daemon mode in the script set; `pnpm dev` holds the terminal for the
supervisor's lifetime. Concurrent workflows require `tmux` / `screen` / a separate shell.

## Open questions

- What's the snapshot inclusion list at the _example app_ level? The apps don't directly invoke
  snapshot, but documentation gaps mean it's unclear whether per-app `.devstack/git/` git-fetch
  caches and `.devstack/vendor/` materialized trees survive snapshot, or only the manifest + state
  record + keys.
- Is `mountUI: true` ever the right default for the dev-wallet panel embedded in the page? Today
  every app pairs via popup URL and the panel only renders inside the standalone wallet at
  `wallet.<app>.localhost:5180`. Apps could opt the embedded panel in via
  `devstackWalletInitializer({ mountUI: true })`, but none do. The `Register` declaration in
  `dapp-kit.ts` doesn't surface this knob.
- How does `pnpm preview` interact with a built `dist/` that references `src/generated/`? `preview`
  runs against the bundled output; the generated files are inlined at build time, so the bearer
  token is baked into the bundle. Is `pnpm preview` ever the right surface to expose this artifact?
  No example documents this.
- The `_template/.devstack/manifest.json` snapshot in the tree uses a pre-v5 schema (flat
  `endpoints[]`); the `_template/.devstack/stacks/main/manifest.json` uses the v5 schema. Is the
  legacy flat shape still actively emitted, or is it residual from before the per-stack split? The
  Vite alias resolves the flat path via a fallback (`packages/devstack/src/vite/index.ts:74-77`), so
  something's still consuming the legacy shape.
- For the `effect-app` pattern (no Vite, no codegen), what's the expected mode for production? The
  README documents the env-flip approach but doesn't describe a release/deploy path. Open whether
  this example is "real" production-ready or scaffolding-only.
- The `_template/src/generated/bindings/{hello,utils}/` directories exist but no example imports
  from them in the source I read. Is the bindings emitter de-facto unused by the in-repo examples,
  or does the wallet/deepbook-full example use it without me catching it? Worth a deeper scan.
- The `plugin-author-redis/` example imports from `@mysten-incubation/devstack/advanced` for its
  plugin definition; there's no separate plugin-author doc among the v2-requirements scope. Should
  this example be cited from the advanced doc, or re-located as its own example category?

## Opportunities noticed

- **`examples/README.md` is stale.** Add `fork-greeting` and `plugin-author-redis` rows. Cited:
  `examples/README.md:8-16`.
- **`src/dapp-kit.ts` near-clone across 7 apps.** Factor into a helper exported from
  `@mysten-incubation/devstack/dapp-kit` or similar:
  ```ts
  export const createDevstackDAppKit = (overrides = {}) => {
    const kit = createDAppKit({ ...devstackDappKitConfig, ...overrides });
    (globalThis as ...).__devstackDAppKit__ = kit;
    return kit;
  };
  ```
  Saves 7 × 20 LOC of identical boilerplate. The `Register` declaration is the one bit that has to
  stay app-local (TypeScript augmentation needs to happen in the consuming module graph).
- **`src/main.tsx` near-clone across 3+ apps.** Same shape — a `createDevstackApp(<App/>)` helper
  would compress 3 × 25 LOC. Whether to also embed the dev-wallet panel mount is the open design
  question.
- **`src/ui/Card.tsx` duplicated verbatim** between `_template` and `deepbook-full` (and likely
  more). Either factor into a `@mysten-incubation/example-ui` package or accept the "template fork"
  intent and stop pretending it's deduped.
- **`useSignAndExecute` hook implemented inline 3+ times** (`_template/src/App.tsx`,
  `deepbook-full/src/lib/queries.ts`, `wallet/src/lib/queries.ts`). Strong candidate for a
  `@mysten-incubation/dapp-kit-helpers` package.
- **Arena's e2e re-implements `loadStackManifest` + `loadStackKeypair`**
  (`examples/arena/e2e/connect-four.spec.ts:19-62`); migrate to the helpers at
  `packages/devstack/src/playwright/artifacts.ts`. This is a straightforward rewrite that would
  shrink the spec by ~30 LOC.
- **`hotRestart: PLAYWRIGHT === '1' ? false : undefined` is copy-pasted with identical comments** in
  arena and fork-greeting (`examples/arena/devstack.config.ts:67-69`,
  `examples/fork-greeting/devstack.config.ts:99-103`). Lift to a named option like
  `disableHotRestartUnderPlaywright()` so the fix is one symbol, not three lines per app.
- **The placeholder pattern in `deepbook-full`** (`__DEEPBOOK_PACKAGE_ID__`) is acknowledged
  technical debt; the migration target is the `Coin.fromPackage` pattern that `wallet` already uses.
  Worth scheduling.
- **`'Dev Wallet'` literal is asserted in the playwright helper test but isn't centrally
  constant-defined.** A typo in the codegen's wallet name would silently break every app's e2e. A
  named export (`DEV_WALLET_NAME = 'Dev Wallet'`) from `@mysten-incubation/devstack` would let the
  codegen + the helper share one source.
- **The `if [ -f src/generated/dapp-kit-config.ts ]; then ...` guard in build / typecheck scripts**
  is copy-pasted in every app's package.json with identical text. A `devstack guard build` /
  `devstack guard typecheck` wrapper command would dedupe.
- **`_template/.devstack/manifest.json` carries a pre-v5 schema** while
  `_template/.devstack/stacks/main/manifest.json` is the new shape. If the legacy flat shape is
  still supported, document it; if it's residual, delete it from the snapshot.
- **`examples/_template/src/generated/coins.ts:11` is `{} as const`** but apps consume
  `deepbookConfig.coins` via `Object.entries(...).filter(...)`
  (`examples/deepbook-full/src/lib/deployment.ts:23-29`). The divergence between "coins from
  `@mysten-incubation/devstack` manifest" and "coins from `deepbookConfig`" is confusing — both
  surfaces exist, neither references the other.
- **`pnpm preview` is in every script set but no example documents its security posture against a
  bearer-token-baked bundle.** Either document it or remove from the script set for examples that
  shouldn't be previewed.
- **Two vendor schemes for deepbook source coexist:** wallet uses `movePackagePath:` against
  `.devstack/imports/mystenlabs_deepbookv3@v7.0.0/.../deepbook/`
  (`examples/wallet/devstack.config.ts:29-32`); deepbook-full uses `VendorDeepbook({ref})` against
  `.devstack/vendor/deepbook/v7.0.0/` (`examples/deepbook-full/devstack.config.ts:54-57`). Pick one;
  if both are needed, document why.
- **`pnpm dev` blocking the terminal** is friction; consider a `devstack up --detach` flag and a
  `pnpm dev:bg` script in the template.
- **`Wallet({allowedOrigins})` deduplication** — every app types out both the routed and the direct
  origin verbatim. Devstack could default to both forms (routed + direct) given the `Dev(...)` port;
  the user would only override when they want to _narrow_.
- **`src/generated/extras.ts` carrying user-supplied data is mode 0o600 but lives in `src/`**
  alongside non-secret code. The selective gitignore + 0o600 is correct but UX-confusing. A
  dedicated `src/generated/private/extras.ts` subdirectory + a README note would surface the intent.
- **Doc 23 (build-integrations) and this doc share the playwright test files in their citation
  set.** That's fine — they pin a shared contract — but a cross-reference in both docs would help
  the next reader.
- **No example demonstrates `it.layer(stack.layer)(...)` for Effect-aware vitest tests** even though
  the vitest preset's comment at `packages/devstack/src/vitest/define-config.ts:23` explicitly
  invites the pattern. A 30-LOC `examples/effect-app/src/main.test.ts` using `it.effect` +
  `Effect.provide(stack.layer)` would be valuable documentation by example.
