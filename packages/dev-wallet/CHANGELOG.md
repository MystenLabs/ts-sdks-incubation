# @mysten-incubation/dev-wallet

## 0.5.1

### Patch Changes

- 8119fac: Expose dev-wallet allowed origins to the injected adapter, reject forbidden page origins
  with a browser-visible diagnostic, and allow same-stack routed app endpoints without allowing raw
  loopback origins.

## 0.5.0

### Minor Changes

- efa3ab6: Multi-network deployment config.

  - **devstack**: renamed the persisted `id-config`/`ids` layer to `deployment`
    (`NetworkDeployment`/`DevstackDeployment`, `loadDeployment`, `dump-deployment`). Added
    multi-network support — per-network service buckets via `forNetwork(network)`, typed committed
    `deployments/<net>.ts` files (`dump-deployment --network <net>`), and a deployment envelope
    merged at the Vite layer (committed networks for a prod build, the live local stack overlaid on
    `vite dev`). Removed the legacy `resolve*()` config-runtime shims and the
    `@devstack-dev/generated-extras` subsystem.
  - **dev-wallet**: the injected dev wallet now operates across the full network set — it advertises
    every configured network as the wallet-standard chain `sui:<name>` (including fork/custom
    names), routes a per-network faucet, and stays registered across a dApp Kit `switchNetwork`.
    `createDevstackAdapterFromManifest` accepts an optional `networks` set so manifest-built
    adapters advertise the same chains.
  - **create-devstack-app**: templates reshaped around the deployment API and multi-network
    deployments (typed `deployments/<net>.ts` authoring surface, dApp Kit wired to the generated
    network set).

## 0.4.1

### Patch Changes

- d3d3805: Fix scaffolded-app build/dev breakages and dashboard reporting; reshape codegen + tests.

  - **create-devstack-app**: declare `lit` + `@mysten/signers` (fix `vite build` "failed to resolve
    lit" and the dev-wallet injection crash); run `pnpm codegen` after install when `sui` is on PATH
    (`--no-codegen` to skip); move tests to `tests/unit` · `tests/e2e` · `tests/browser` with a
    standalone `tsconfig.test.json`.
  - **devstack**: the Vite plugin now dedupes only Lit packages hoisted at the app root (phantom
    packages no longer break the production build); `devstack codegen` requires a host `sui` CLI
    (the Docker fallback is removed) and fails fast when it's missing; the vitest/Playwright presets
    adopt the `tests/unit`/`tests/e2e`/`tests/browser` layout; the dashboard surfaces Pyth price
    feeds (`DeepbookInfo.pythFeeds`) and renames `marketMakerRunning` → `hasSeedLiquidity`; fix a
    bug where `devstack up`'s extras emit clobbered the committed `src/generated/.gitignore` with an
    ignore-all policy.
  - **dev-wallet**: the WebCrypto adapter is loaded lazily and gated on the optional
    `@mysten/signers` peer, so an app without it still gets a working dev wallet instead of a hard
    inject crash.

## 0.4.0

### Minor Changes

- 9e1e1be: Dev wallet: explicit test-only connect, no pre-connect or storage seeding.

  The injected dev wallet no longer seeds dApp Kit's localStorage to fake an auto-connect to a
  specific account on page load. A fresh page now loads disconnected, and dApp Kit's own
  `autoConnect` does only what it's meant to — re-connect a genuine prior session.

  A new devstack `/dapp-kit` entrypoint exports `registerDAppKitForTesting(dAppKit)`, which the app
  wires DEV-only after `createDAppKit(...)`. It publishes the `connectAs` slot that drives a REAL
  connection through dApp Kit's public API (`connectWallet` / `switchAccount`, resolving accounts by
  label) instead of narrowing/widening the wallet's exposed accounts to exploit reconciliation. The
  dev wallet auto-approves `standard:connect` only when signing is auto-approved (the headless-e2e
  `DEVSTACK_AUTO_APPROVE` signal); in normal dev a human approves the connect. This fixes wallet
  connection under `@mysten/dapp-kit-core` ≥1.6, whose rewritten auto-connect state machine broke
  the old storage-seeding approach.

- 11c258a: Auto-inject the devstack dev wallet via the Vite plugin.

  `@mysten-incubation/dev-wallet` adds a `/inject` entry (`registerDevstackDevWallet`) that
  constructs the dev wallet from a devstack stack's config and registers it on the page via the
  wallet-standard window protocol (plus the Playwright `connectAs` slot). The devstack Vite plugin
  uses it to inject + register the dev wallet in DEV only, so dapp-kit apps discover it through
  wallet-standard with no app-side wiring — apps no longer need a `dapp-kit.dev.ts` or any
  `@devstack-dev` import, and production builds carry no dev-wallet code. The dev wallet exposes all
  of its accounts to the dApp while `connectAs` still drives the active account.

- 9e1e1be: The injected devstack dev wallet now bundles a `WebCryptoSignerAdapter` alongside the
  stack's server-resolved accounts, so users can create their own accounts from the wallet UI.
  Created accounts persist across reloads in IndexedDB via non-extractable WebCrypto keys (not
  in-memory), and the stack's `alice`/`bob`/`carol` accounts remain available.
- 9e1e1be: Disambiguate the conflated `chain` concept into three precise ones: `network` (the
  network name — `localnet`/`testnet`/…), `chainId` (the genesis-digest chain identifier, unique per
  spun-up network), and the wallet-standard `sui:<network>` chain name (derived only at the
  dev-wallet wallet-standard boundary — `sui:` never appears in devstack internals).

  **Breaking.** The substrate `Identity`/manifest field `chain` is now `network` and holds the bare
  network name (previously a `sui:`-prefixed string). The network parser accepts only canonical
  names — the `local` shorthand and the `sui:`-prefixed alias table are removed (use `localnet`);
  `network ⇄ chain id` is now just a `sui:` prefix, not a lookup table. The sui plugin's resolved
  value, on-disk cache-dir keys, and `chain-probe:`/`faucet:request:` capability keys now key on the
  genesis-digest `chainId`. The generated `config.ts` active-network key is `localnet` (was
  `local`), and `config.networks.<net>` / `byNetwork.<net>` are keyed by network name. The
  dev-wallet `registerDevstackDevWallet` config and `DevWalletConfig` take `network` instead of
  `chain`. The dashboard GraphQL surfaces `chainId` (sui) and `network` (deepbook) instead of
  `chain`. Known walrus/deepbook deployments and the deepbook DEEP-funding gate now key on the
  network name — fixing a latent bug where the gate compared a genesis digest against the
  `'sui:testnet'` literal and was dead for every non-literal value.

  On-disk state keyed by the old `sui:local` chain brand is invalidated; run `devstack wipe` on
  existing local stacks after upgrading.

## 0.3.0

### Minor Changes

- b6af6d2: Devstack: thorough-review remediation pass plus follow-up cleanup round.

  Highlights:
  - `runStack({ layers })` replaced by `runStack({ extendContext })`. Custom context extension now
    goes through a typed seam.
  - `executeSuiTx` returns a discriminated union (`$kind: 'ExecutedSuccess' | 'ExecutedFailure'`).
    On-chain failure is a value, not an error. Plugins that previously caught the failure-tag in the
    error channel must dispatch on `$kind` instead.
  - New substrate helper `signAndDispatch` compacts the
    `withTransactionSigner → build → sign → execute → $kind dispatch` pattern across five publisher
    plugins.
  - Supervisor module (1.8k LOC) split into 11 per-concern modules under
    `substrate/runtime/supervisor/`. No behavior change.
  - New `built-in-plugin-layers.ts` lives in `orchestrators/`, not `runtime/` — `run.ts` lifted into
    `orchestrators/` similarly. Layer composition now lives at L3 only.
  - New L0 helper `routed-url.ts` for `renderUrl`/`routedHostname`; L3 router/hostname.ts retained
    as an intra-L3 adapter.
  - Docker image builds now stamp ownership labels (`expectedImageOwnershipLabels`); prune can reach
    previously-unlabelled images. New `BuildOptions.labels` on the container-runtime contract.
  - Sweep evicts own endpoints and surfaces remaining `ForeignNetworkHolder` rather than failing
    silently.
  - Per-app shared-stack pinning: `_per-app_` stacks (e.g. shared chain-build cache) are pinned
    while any app sibling is live.
  - `atomicWriteFile` cleanup is now whole-pipeline (open/write/fsync/rename) via `Effect.onError`,
    not rename-only.
  - `cross-process-lock` typed errors: `StackLockTimeoutError | StackLockIoError` in the E channel;
    no more `Effect.orDie`.
  - Plugin-domain span/log keys namespaced via per-plugin `spans.ts` files.
  - `ChainOperation` typed seam removed (zero plugin adoption signal); `ClientWithCoreApi` is the
    sanctioned SDK cast at plugin boundaries.
  - ARCHITECTURE.md / STYLE_GUIDE.md rewritten to describe current state (537→308, 894→477 lines).
  - New style-enforcement tests: `l4-boundary`, `no-unknown-as` (globs every plugin barrel),
    `plugin-boundary`, `span-attr-namespace`, `substrate/name-blindness`.

  Dead-code purge and substrate race fixes:
  - Orphan modules removed (no consumers): `orchestrators/codegen/extras.ts` (inlined into
    `runtime-composition.ts`); `plugins/deepbook/routable.ts` + the `DEEPBOOK_ENTRYPOINTS`
    aggregation; `plugins/sui/live-faucet-strategy.ts` (`suiLiveStrategy`, `LIVE_FAUCET_URLS`,
    `SuiLiveNetwork`, `SuiLiveStrategyOptions`); `plugins/sui/seed-objects.ts`
    (`SeedObjectsAccumulator`, `makeSeedObjectsAccumulator`, `SEED_OBJECTS_CAPABILITY_KEY`). The sui
    plugin's emitted-capability count drops from 5 to 4.
  - `plugins/walrus/faucet-strategy.ts`: `makeWalFaucetContribution` removed;
    `makeWalFaucetStrategy` unaffected.
  - `orchestrators/router/index.ts`: unused `STATIC_PROVIDER_FILENAME` export removed.
  - `plugins/sui/fork-orchestration.ts`: `ForkGuardedSdk<Sdk>` derived type alias removed;
    `wrapWithForkGuard` now returns `Sdk` directly (behavior identical).
  - Capability-sink registration race fixed: install + finalizer wrapped in `Effect.uninterruptible`
    so an interrupt between `Ref.modify` and `addFinalizer` cannot leak the sink past scope close.
  - Cross-process command channel short-read fix: `readSync` may short-return on NFS / cross-FS;
    offset advances by `bytesRead` rather than the requested length, with a clean bail on
    `bytesRead <= 0`.
  - Cross-process roster PID-recycle hazard fixed: `heartbeat` / `release` / `setIntent` now match
    holders via `(pid, hostname, startTime)` triple via a new `isOwnEntry` helper (was matching
    `(pid, hostname)` only).
  - Background snapshot interrupt now awaits via `Fiber.interrupt(fiber)` (was fire-and-forget
    `fiber.interruptUnsafe()`) so a follow-up capture can't start while the previous fiber is still
    inside `pauseAndCommit` / `saveImages`.
  - CLI restructure: `cli/main.ts` (1338 LOC) split into per-verb wirings under
    `cli/wirings/{up,apply,snapshot,wipe,prune}.ts` plus shared `build-verb-layers.ts` /
    `identity.ts` / `config-loader.ts` helpers. `main.ts` is now argv → identity → deps → dispatch
    only (~290 LOC).
  - Cross-process command-channel `ack` / `error` records gain an optional `payload: unknown` field
    plumbed through `awaitCompletion`. `snapshot.capture` now carries the captured metadata (or
    failure summary / skipped reason) on the reply directly — the CLI no longer tail-fibers
    `events.ndjson` for the completion event.
  - Repo-wide Prettier reformat.

  User-visible behavior changes (minor-bump rationale):
  - **Pyth types removed from the root barrel.** `PythFeed`, `PythHandle`, `PythOptions`,
    `PythPackageMember`, and `PythPriceFeedId` no longer re-export from
    `@mysten-incubation/devstack`. They remain reachable via the `DeepbookLocalOptions.pyth` field
    chain. The value helpers (`pythPriceFeedId`, `DEEP_PRICE_FEED_ID`, `SUI_PRICE_FEED_ID`,
    `USDC_PRICE_FEED_ID`) are kept because `examples/deepbook-trader/devstack.config.ts` is the
    market-maker case the architecture permits.
  - **Postgres password format changed.** `derivePassword(app, stack, stackRoot)` now incorporates
    the stack's on-disk runtime root and an sha256 short hash. Existing dev databases created
    against the previous `pg-${app+stack}` format will fail to authenticate on first `pg_isready`
    probe. Delete the existing container (`docker rm -f`) and let devstack recreate it.
    Multi-checkout shells of the same `(app, stack)` now derive distinct passwords by design.
  - **CLI argv-parse failures now exit with code 64 (`USAGE`), not 1 (`GENERIC`).** Tests / CI
    scripts that pattern-match exit codes for "user error vs internal error" should treat 64 the
    same way they treat the `--help` exit code. `--json` mode now also emits a structured envelope
    for these failures instead of plain stderr.
  - **`DevstackOptions.stateDir` is now honored.** The field was declared on the type but silently
    ignored by `runStack` (only `runtimeRoot` was read). Programs that set
    `defineDevstack({ stateDir })` previously had no effect; they now do.
  - **CLI now honors `config.options.stateDir` / `defineDevstack({ stateDir })`.** The `devstack`
    CLI loads the config best-effort before resolving identity and feeds its `stateDir` into the
    runtime-root ladder. Precedence: `--state-dir` flag > `config.options.stateDir` >
    `$DEVSTACK_STATE_DIR` > `<cwd>/.devstack`. The `--state-dir` flag still wins, and no-config
    verbs (`prune`, `wipe`) keep resolving without a config.
  - **`setNetworkEnv` now save/restores `process.env.DEVSTACK_NETWORK`.** In-process CLI invocations
    (tests, embedded use) no longer leak `--network` env state into subsequent calls. Single-process
    CLI semantics are unchanged.
  - **`stringifyCause` renamed to `formatUnknownError`.** Plugins importing the substrate helper
    directly need to update their import (canonical path:
    `substrate/runtime/format-unknown-error.ts`). The function's behavior is unchanged.
  - **Wallet endpoint constant unified.** `WALLET_ENDPOINT_ALIAS` removed; `WALLET_ENDPOINT_KEY` is
    the single canonical name. All exports surface through the same module paths.
  - **`EndpointEntry.wireProtocol`, `Endpoint.wireProtocol`, `ResolvedEndpoint.wireProtocol`**
    narrowed from `'http' | 'h2c' | string` to `'http' | 'h2c' | 'tcp'`. Persisted manifests and
    projections now reject other values at decode time. Plugins emitting custom wire protocols (none
    ship today) would need to extend the literal union.

  dev-wallet:
  - `DEVSTACK_WALLET_HTTP_PATH.EXECUTE` removed (devstack-side `/execute` endpoint deleted; the
    dapp-kit / dev-wallet path bypasses it and the protocol shape didn't match the Sui Wallet
    Standard).

## 0.2.0

### Minor Changes

- 3806dc8: Add the devstack signer adapter and a custom panel API.

  **Adapter.**
  - New `DevstackSignerAdapter` (and `DevstackProxySigner`) under
    `@mysten-incubation/dev-wallet/adapters`. Mirrors `RemoteCliAdapter`'s out-of-process model —
    keys never enter the frontend bundle; signing goes over HTTP to a devstack-side wallet-app
    server.
  - `parseDevstackToken(pairedUrl)` and `createDevstackAdapterFromManifest(manifest)` helpers wire
    the adapter up from the devstack manifest's wallet-server service entry.

  **Panel API.**
  - New `WalletPanelDescriptor` type (`{ id, label, icon?, tagName }`) plus
    `DevWalletConfig.panels?` and `DevWalletInitializerConfig.panels?` options. The wallet appends
    each registered tab after the built-in Assets / Objects / Settings; the registered custom
    element gets `.wallet`, `.activeAddress`, and `.client` properties wired in automatically.

### Patch Changes

- 9be42e5: Redesign the dev wallet UI with a clearer standalone layout, polished wallet panel
  chrome, useful side content, refreshed settings and signing flows, and updated docs screenshots.

## 0.0.1

### Patch Changes

- Test publish via CI
