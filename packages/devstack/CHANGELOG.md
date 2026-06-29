# @mysten-incubation/devstack

## 0.6.0

### Minor Changes

- 86726c1: Start the release-provided Walrus publisher and aggregator services by default in local
  mode. Local Walrus bindings now point `publisherUrl` and `aggregatorUrl` at app-facing `/v1/blobs`
  service containers instead of aliasing both URLs to the first storage node.

## 0.5.0

### Minor Changes

- 4fc3586: Align known/live-network config with the built-in `@mysten/*` SDK constants, and unify
  the per-service factory ergonomics.

  - **Known-network ids now come from the SDK (no drift).** DeepBook's known deployments derive from
    `@mysten/deepbook-v3` (`testnet/mainnetPackageIds`, `…PythConfigs`) and Walrus's from
    `@mysten/walrus` (`TESTNET/MAINNET_WALRUS_PACKAGE_CONFIG`) instead of hand-copied literals. This
    fixes a stale mainnet DeepBook `packageId` and means future SDK bumps flow through
    automatically. Walrus known mode now defaults `systemObjectId`/`stakingPoolId`/`exchangeIds`
    from the SDK, so a caller only supplies `nodes`.
  - **Unified factory shape.** Known/live networks use per-network methods across all plugins:
    `deepbookFor(net).testnet()`/`.mainnet()`,
    `walrusFor(net).testnet({ nodes })`/`.mainnet({ nodes })`,
    `sealFor(net).testnet()`/`.mainnet()`. The redundant `network`-in-`.known({ network })` path is
    removed; `.known(...)`/`.custom(...)` are now raw-id overrides only.
  - **Seal committee support.** Live/fork-known modes now model both independent and decentralized
    (committee) key servers with the current Mysten object IDs. `sealFor(net).testnet()` resolves to
    both Mysten testnet independent servers (zero-config, no API key);
    `.testnet({ server: 'committee' })` and `.mainnet({ server: 'committee', apiKeyName })` select
    the committee (mainnet requires the non-secret `apiKeyName` — a factory-time error if missing).
    The stale `seal-keyserver.testnet.mystenlabs.com` URL is removed (object IDs are the source of
    truth). `SealKeyServerEntry` is now a true structural mirror of the SDK's `KeyServerConfig`
    (adds `apiKeyName`/`apiKey`), guarded by a real compile-time drift check, and `verifyKeyServers`
    is surfaced (defaults on for live; local-keygen keeps it off for self-signed servers).
    **devstack never carries the secret committee `apiKey` value** — the committed `seal.ts` and the
    world-readable `deployment.json` would both expose it. devstack emits only the non-secret
    `apiKeyName` plus the committee `serverConfigs`; a verbatim `serverConfigs` override that embeds
    an `apiKey` is rejected, and codegen strips any `apiKey` from the emitted config as
    defense-in-depth. The app injects the secret `apiKey` into `serverConfigs` at runtime (keyed by
    `apiKeyName`) when it constructs `SealClient`.

## 0.4.0

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

## 0.3.0

### Minor Changes

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

## 0.2.0

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

- 9e1e1be: New `codegen.includePhantomTypeParameters` stack option, passed through to
  `@mysten/codegen`: phantom type parameters become required arguments on generated struct
  factories, so the generated BCS classes compose into fully-qualified type tags
  (`Pool(DBTC, DUSDC).name`). Default remains off.
- 11c258a: Reshape generated codegen output, make `deepbook()` a one-liner local DeX, and fix
  dashboard snapshot/restore.

  **Codegen reshape (breaking for consumers of generated output).** `generated/` is now a
  runtime-only surface: a single combined `config.ts`
  (`{ network, networks, packages.byNetwork, objects }`) plus per-plugin siblings (`seal.ts`,
  `walrus.ts`, `deepbook.ts`, `coins.ts`) and Move `bindings/`. Dev-only and secret artifacts (the
  account name→address map and the dev-wallet pairing config) move out of the committed app surface
  into `.devstack/stacks/<stack>/generated-extras/`, reachable via a new `@devstack-dev` path alias.
  The old `accounts.ts` / `packages.ts` / `services.ts` / `sui/network.ts` / `dapp-kit/config.ts` /
  `extras.ts` outputs are removed; the `dappKitConfig` export is now `devWallet`. `localPackage` /
  `knownPackage` gain a `networks` option for per-network (testnet/mainnet) package and object ids,
  projected into `config.packages.*.byNetwork` and `config.objects` — so the same generated shape
  can target a real network with pre-deployed contracts by switching `config.network`.

  **Deepbook one-liner.** `deepbook()` (or `deepbook({ mode: 'local' })`) with no arguments now
  provisions a working local DeepBook DeX: it bundles the DeepBook v3 + sandbox-Pyth Move sources as
  plugin assets, synthesizes the publish plus an ephemeral funded publisher, and seeds a default
  DEEP/SUI pool — consumable directly through `@mysten/deepbook-v3` against localnet. `package` /
  `pyth` / `pools` / `publisher` are now optional overrides; `known` / `override` modes are
  unchanged.

  **Dashboard snapshot/restore.** A restore triggered from the web dashboard now re-acquires
  services automatically (no manual restart required) and surfaces `snapshotting` / `restoring`
  status instead of staying on "running". The post-restore re-acquire excludes the dashboard and
  host-service transport, so the restore mutation returns its result cleanly instead of tearing down
  the connection it is answering on (previously surfaced as a 502).

- 467ec8e: Remove unused plugin-authoring API surface that had no consumers.

  The decl authoring helpers `routable`, `strategyContributor`, `snapshotable`, and `codegenable`
  are removed from the package root. Built-in plugins build these contribution decls as inline
  `{ kind: '...' }` object literals, so the helpers carried no callers; `projection` remains (it has
  live call sites). The `PluginContext` passed to plugin contribution functions also drops its
  unused `persist`, `requires`, and `fail` verbs — plugins persist via `CacheService` and read
  strategies via the strategy registry directly — leaving a closed five-verb authoring surface
  (`codegen`, `endpoint`, `snapshotExtra`, `publish`, `provides`).

  No in-repo consumer used any of these. External plugin authors building decls through the removed
  helpers should switch to the inline `kind` literals.

- 467ec8e: Add `devstack up --warm` — a fingerprinted boot cache.

  The first `--warm` boot is a normal cold boot that captures a baseline snapshot; subsequent
  `--warm` boots restore that baseline (fast path) instead of cold-booting, as long as the inputs
  are unchanged. The baseline is keyed on a fingerprint of the config source, the plugin/member
  graph, watched Move source contents, the devstack version, and image-override env vars; any change
  re-captures. Use `--no-warm` to force a cold boot, or set `warm: true` in devstack options. A
  change to per-plugin options is detected via the config-source hash; config logic split across
  imported modules or driven by environment is a known v1 limitation (use `--no-warm` / `wipe` after
  such changes).

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

### Patch Changes

- 9e1e1be: Build-integration manifest discovery (vitest, playwright, vite) now infers the default
  stack name from the nearest package.json `name`, matching the CLI's `resolveStackName` ladder
  (explicit > `DEVSTACK_STACK` > package name > `main`). Previously the discovery ladder
  hard-defaulted to `main`, so in a bare app — where `devstack up` names the stack after the package
  — `pnpm test` (and any standalone consumer of the discovery ladder) failed with "no devstack
  manifest found for stack 'main'" even though the stack was live. The vitest setup hook's stack
  advisory now names the inferred stack too.
- 467ec8e: Stage A of the devstack simplification: delete the dead `state-store` (and its snapshot
  `state.json` phantom) and hoist the Sui-domain helpers (`sui-execute`, `sui-move-build`,
  `sui-ledger`) out of the name-blind substrate into `plugins/sui/{exec,move,ledger}`. Internal
  refactor only — no public API change (release-surface is unchanged); the substrate no longer
  imports `@mysten/sui` or names any plugin.
- 467ec8e: Fix the sui-owned GraphQL-indexer Postgres sidecar failing auth
  (`FATAL: password authentication failed for user "devstack"`) on a reused/restored data dir, which
  crash-looped the validator's embedded indexer and broke every e2e that boots a bare `sui()`
  (snapshot-restore matrix + the deepbook/token-studio/warm-cache/action-cache/indexer-reverify
  boots).

  The sidecar password derived from `(app, stack, stackRoot)`, but its PGDATA rides the owner's
  snapshot and its committed layer is aliased onto the content-addressed `devstack-build:*` build
  tag, which a later boot reuses. The password baked into PGDATA at first init is never re-applied
  on reuse/restore, so a `stackRoot`-folded credential (which churns whenever the runtime root
  changes — every e2e boot mints a fresh tmpdir root) stopped matching the persisted data dir.
  Sidecar passwords now derive from `(app, stack, role)` only — invariant across runs of the same
  stack, matching how the snapshot/image persist — so reuse/restore is always credential-safe.
  User-declared `postgres()` is unchanged (it keeps the per-checkout `stackRoot` isolation; it has
  no sidecar's shared-image collapse).

- 467ec8e: Local-mode Sui now bases on the upstream `mysten/sui-tools` image (pinned to the build
  carrying the embedded-fullnode resume fix, sui #26884), so both the validator and the embedded
  fullnode resume from their persisted dbs across `docker stop`/`start` — there is no per-boot
  genesis re-sync.

  GraphQL and its indexer run against a sui-owned Postgres sidecar that is ON BY DEFAULT for a bare
  `sui()`: the sidecar auto-creates its `sui_indexer` DB, so the full GraphQL surface boots with no
  cross-plugin wiring. `indexer: false` opts out (RPC + faucet only, no sidecar);
  `indexerDb: { url, network, database? }` points GraphQL at a Postgres you already run instead.

- 9e1e1be: Fix the injected dev wallet failing with `Illegal constructor` and an unusable connection
  state on disconnect/reconnect in scaffolded apps. The Vite plugin now pre-bundles the dev-wallet
  entries it injects (`optimizeDeps.include` for `@mysten-incubation/dev-wallet/inject` +
  `/adapters`) and dedupes Lit (`resolve.dedupe`), so Vite never re-optimizes them mid-session into
  a second Lit instance — which had registered the wallet's web components in a separate
  custom-element realm the page couldn't construct.
- b54e13a: Fix a stray NUL byte in the codegen orchestrator's `pathKey` separator
  (`orchestrators/codegen/service.ts`). The NUL made `file(1)` classify the source as binary `data`
  and caused `grep` to silently skip it, and it also broke the duplicate-output-path error message:
  that path is extracted with `pathKey.slice(pathKey.indexOf(' ') + 1)`, which expects a space
  separator the NUL wasn't. The separator is now a space, fixing both the tooling/grep issue and the
  error-message extraction.

## 0.1.1

### Patch Changes

- 7cfef58: Docs: the README's create command uses the `@latest` tag
  (`pnpm create @mysten-incubation/devstack-app@latest my-app`) so new apps scaffold from the newest
  tooling. No runtime change.

## 0.1.0

### Minor Changes

- dcf5905: Dashboard: explorer routing, plugin real-data, controls UX, and real faucet funding.
  - **Explorer** — addresses, objects, and packages share one address space, so search now resolves
    an id first (package → object → address probe) and routes to the concrete kind instead of a
    generic entity route; objects can act as addresses (owned-objects/balances + package detection),
    and links from the transactions table route to concrete kinds. URL encoding no longer
    over-encodes path-safe characters.
  - **Walrus / Seal panels** — Walrus shows real epoch, shard assignments, and recent blobs via Sui
    GraphQL (`register_blob`/`certify_blob` transaction filter, no indexer); Seal drops the policy
    pane and probes the correct `/health` endpoint.
  - **Controls** — all restarts are behind a confirmation, restart is removed from the header,
    advance-clock is hidden unless on a fork, shutdown is no longer styled destructive, and the
    checkpoint figure is relabeled "Oldest checkpoint".
  - **Account/address history** — Sent/Received transaction history via the typed `SuiGraphQLClient`
    from `@mysten/sui` (replacing hand-rolled fetch).
  - **Snapshot/restore progress** — honest in-flight indicator (the engine emits no progress
    projection field) rather than fake instant success.
  - **Faucet funding** — a `fund` control-plane mutation funds SUI/WAL/DEEP by reusing devstack's
    registered in-process funding strategies (the same ones the boot-time account-funding pass
    invokes), with a real processed/failed result; SUI is fixed-amount, WAL/DEEP take an editable
    amount and fund a resolved account.

- 8322e9a: Fork mode: impersonation-based faucet + setup/usability fixes.
  - **Fork faucet** — `sui({ mode: 'fork', faucet: { whale, perRequestCapMist?, enabled? } })` funds
    test accounts by impersonating a large-reserve "whale" address on the forked upstream and
    transferring SUI from it. Wired through the existing faucet-strategy pathway, so
    ephemeral-account auto-funding and cross-cutting SUI funding work in fork mode exactly like
    localnet. The whale is auto-seeded into fork state and validated at boot to hold a SUI coin
    covering a default fund plus gas (an actionable error fires if none qualifies). Coin selection
    paginates the whale's coins and uses the first that covers the request + gas budget, so a
    sufficient coin sitting behind dust on a later page is still found.
  - **Error surfacing** — `formatUnknownError` now unwraps an error's `.message` (tagged plain
    objects included, not just `Error`s) and chains its `.cause` (whether that cause is an `Error`
    or a tagged object), and the publish / action / wallet / sui-execute transaction paths route
    through it. Fixes `account.signAndExecute failed … [object Object]`, which had swallowed the
    real cause (e.g. "no SUI gas coins found for 0x…").
  - **Image build UX** — the first-run `sui-fork` source build now narrates progress on the
    supervisor row instead of appearing hung; `image: { pull }` or `DEVSTACK_SUI_FORK_IMAGE` skip
    the build with a prebuilt image, falling back to a source build on miss.
  - **Fork-mode real accounts** — faucet-funded _real_ (ephemeral) accounts can now publish, run
    actions, mint coins, AND move value in fork mode, not just impersonate accounts. Pieces: (1)
    funding-settlement balance reads use `listCoins` in fork mode, since `getBalance`/`listBalances`
    panic under the fork guard; (2) the publish, action, and coin-mint transaction paths build
    offline with explicit gas in fork mode (real signers too, not only impersonate), because the
    `sui-fork` binary has no `simulate_transaction`; (3) the fork gas budget is lowered to 0.1 SUI
    so a faucet-funded account's coin isn't fully reserved by gas — leaving headroom to
    split/transfer value. End-to-end verified: a fork stack of ephemeral accounts auto-funds,
    publishes a Move package, and runs a value-transfer action with no pre-funded addresses.
    (Deepbook pool deploy + its DEEP-funding faucet remain local/known-only in fork — out of scope
    here.)
  - **Readiness** — the fork ready-probe timeout message now points at the container logs and the
    `readyTimeout` option.

  Follow-up: publish a prebuilt `sui-fork` image in CI (e.g. `ghcr.io/mysten/sui-fork:<rev>`) so the
  default path pulls in seconds instead of compiling from source.

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

- b8f4959: Devstack: follow-up careful-review remediation pass — correctness fixes, an inert-layer
  removal, a dead-surface purge, and dedup. Builds on `devstack-review-fixes`.

  User-visible API / behavior changes (pre-1.0 minor bump):
  - **`Redactor` and `layerRedactor` removed from the public barrel.** The engine-wide
    secret-redaction service was never populated (`register` had zero callers), so it was inert.
    Redaction is now strictly inline-at-construction in the plugins that handle secrets (seal master
    keys, wallet pairing tokens), and the account variants (inline / env / keystore) no longer
    attach the raw secret via the error `cause`. The pure helpers (`redactText`, `RedactionRule`)
    remain.
  - **`SeedManifestMismatchError` and `ForkMeta` removed from the public barrel.** The fork
    seed-manifest drift-detection apparatus was dead (the error was never raised; `fork-meta.json`
    was write-only). `fork-meta.json` is no longer written.
  - **`ContainerExited` docker error removed.** It was declared and projected but never constructed
    — `catchTag('ContainerExited')` could never fire.
  - **`ArtifactSpec.verifySchema` removed.** The field was populated by plugins but never consumed
    by the substrate publisher (`verify` is plugin-owned). Plugins providing it should drop the
    property; the `Verified` type is still pinned by the `verify` signature.
  - **`FaucetBodyError.reason` no longer includes `'malformed-body'`** (never constructed;
    JSON-parse failures use `'invalid-json'`). **`ActionPhase` no longer includes `'parse'`** (never
    raised).
  - **`snapshot prune` now sweeps committed snapshot images by a reserved `role=snapshot-image`
    ownership label** (stamped at `docker commit`). Previously it filtered by `{app, stack}`, which
    matched live plugin _build_ images (untagging them, forcing silent rebuilds) and never matched
    the unlabelled snapshot byproducts it was meant to reap.
  - **Sui snapshots now carry a `mode` discriminator in their restore identity.** A
    container-`local` snapshot and a `local-rpc` snapshot at the same chain id are no longer
    mutually restorable (the cross-mode restore was a silent no-op). **Migration:** sui snapshots
    captured before this change carry the old `{kind, chain}` identity and will be refused on
    restore against the new `{kind, mode, chain}` identity (fail-closed `IdentityMismatchError`,
    never silent corruption) — re-capture after upgrading, or delete the stale snapshot.
  - **`dockerExec` gains an optional `timeoutMillis`**, and docker subprocess spawns now escalate
    SIGTERM→SIGKILL (`forceKillAfter`) so a CLI that ignores SIGTERM cannot wedge scope-close.

  Correctness fixes (no API change):
  - Supervisor selective-restart no longer wedges the command loop on an uncatchable
    lifecycle-transition defect (lifecycle reset routes status authoritatively to `pending`; the
    acquire-side self-transition is defect-tolerant).
  - Cross-process `stack.lock` / snapshot-reservation reclaim re-stats (mtime + inode) immediately
    before `unlinkSync`, so a competitor's freshly-rewritten live lock can't be deleted
    (mutual-exclusion break).
  - `ensureNetwork` adopts an owned network on a concurrent-create collision instead of failing
    boot.
  - `stage-and-swap` restores the backup on an EXDEV cross-filesystem copy failure, and the EXDEV
    detection now reads the real (nested) errno off the `PlatformError`.
  - host-service spawns the child and registers its terminator atomically
    (`Effect.uninterruptible`), so an interrupt mid-boot can't orphan a detached process; same
    hardening on `scoped-http-server`.
  - deepbook pool matching is position-aware on `Pool<Base, Quote>` generics (reversed/overlapping
    pairs no longer collapse to one id).
  - coin self-funding (publisher funded with its own coin) no longer deadlocks on the per-address
    lease.
  - router `boot()` runs bootstrap once per supervisor lifetime even under concurrent plugin
    acquire.
  - lifecycle-prune re-probes each victim's liveness immediately before removal (TOCTOU vs a
    concurrent `up`).
  - command-channel tail handles UTF-8 multibyte sequences split across a short read.
  - snapshot `recover-pending` distinguishes "already recovered" from a transient daemon error.
  - playwright codegen-watch schema pins the engine-record discriminators (loud decode-failure on
    drift instead of a silent 5-minute deadlock).

  Internal dedup (no behavior change): shared `makePhaseFailer` across snapshot orchestrators;
  `readLabels` lifted to `docker/labels.ts`; `inspectVolume` routed through
  `dockerInspectAndDecode`; single `WALRUS_ROUTER_PORT`; shared deepbook `stableContentHash`;
  single-source `DEFAULT_STACK_NAME`.

- 8e7801e: Add the devstack web dashboard plugin (`dashboard()`): bundled-in-CLI control-plane + Sui
  explorer with live data.

## Unreleased

First documented pre-release after the multi-phase surface stabilization. Major lines of work:

### Surface stabilization (Phases 0-8)

The package was rewritten over eight planned phases that landed before this entry. The result is a
single root barrel (`@mysten-incubation/devstack`) carrying every built-in plugin factory, plugin
authoring helper, capability decl type, and substrate helper namespace. The only public subpaths are
the L5 build-integration entrypoints — `/vitest`, `/vitest/setup`, `/playwright`,
`/playwright/global-setup`, `/vite`, `/runtime`, and `/dapp-kit` — exposed for tree-shaking and L5
isolation. The `/vite` entrypoint is a `devstackVitePlugin()` that points a customizable
`@generated` import alias at the active stack's codegen output (per-stack codegen so `pnpm dev` and
`pnpm test:e2e` coexist). The `/dapp-kit` entrypoint is a DEV-only test bridge
(`registerDAppKitForTesting`) the app wires after `createDAppKit(...)` so the Playwright `connectAs`
helper can drive a real connection through dApp Kit's public API — no localStorage seeding, no
pre-connect on load. See `ARCHITECTURE.md` for layer boundaries and `STYLE_GUIDE.md` for code-level
patterns.

### Critical correctness fixes

- Snapshot recovery scanner: a fresh `supervise` startup now reads the on-disk
  `snapshot.restore-pending.json` marker, re-tags any managed image that the restore step staged but
  did not promote, and clears the marker. Closes the SIGKILL-during-promote silent-failure window.
- Capability sinks atomicity: `registerSink` now wraps the `Ref.modify` + finalizer pair in
  `Effect.uninterruptible` so a fiber interrupt between the two does not leak a registration without
  a paired teardown.
- Supervisor background-snapshot interrupt: aligned with the stack-restart interrupt path — both now
  await `Fiber.interrupt` rather than returning immediately.
- Cross-process roster: heartbeat / release / setIntent paths now key on `(pid, startTime)` rather
  than `pid` alone, removing the PID-recycle false-match window.
- File-channel short-read: command-channel readers advance `state.offset` from the actual bytes
  returned, not from a stale `stat.size`. Closes the truncated-tail window.
- Windows path bug: the postgres data-dir bootstrap and walrus cargo-image loader now use
  `fileURLToPath(...)` instead of `decodeURIComponent(url.pathname)` so the leading `/` on
  Windows-style `file:///C:/...` URLs is stripped correctly.
- Deepbook: `buildKnownPlugin` now stamps a `pluginKey` matching the local/override branches so the
  dep-graph row-identity is stable across config edits; `findExistingPoolId` treats the normalized
  `0x0` address as the "no pool" sentinel instead of returning a bogus id.
- Walrus partial-URL handling: `known-deploy` nullifies only the missing URL field rather than all
  three when one is absent.
- Action plugin: produce-phase failures preserve their phase tag through `ArtifactPublishError`
  wrapping; build-phase raw `Error` throws are converted to typed `Effect.fail`.
- Account funding: the SUI funding branch is now strongly typed end-to-end rather than resting on a
  `<AccountFundingStrategy>` cast.

### Public API surface stabilization

Root-barrel exports added so plugin authors and embedders can author without reaching into package
subpaths:

- Contracts: `Renderer`, `RendererError`, `EntrypointDecl`, `pluginErrorContributions`,
  `PluginErrorContribution`.
- Network inference helpers: `parseDevstackNetwork`, `parseDevstackNetworkName`,
  `DevstackNetworkParseError`, `resolveAppName`, `resolveStackName`, `resolveNetwork`,
  `DEFAULT_STACK_NAME`, `DEFAULT_DEVSTACK_NETWORK`, `DEVSTACK_NETWORK_NAMES`,
  `ParsedDevstackNetwork`, `ResolvedDevstackNetwork`, `DevstackNetworkName`.

A `resolveNetwork({ explicit, env, default })` helper centralizes the `options > env > default`
precedence so `api/run-stack.ts` and `cli/main.ts` no longer carry parallel inline ladders.

### Capability contract ergonomics

- `projection({ kind, key, payload })` shorthand alongside the verbose `projection({ event })` form,
  so common-case callers don't restate `tag` + `at`.

### Layer-boundary fixes

- `build-integrations/{vitest,playwright}` now re-export `ManifestEnvelope`,
  `ManifestEnvelopeSchema`, `parseJsonTextSync` through `build-integrations/runtime/` rather than
  reaching across into `substrate/`.
- `playwright/wallet-context.ts` re-exports `WalletHttpPath` through the runtime bridge instead of
  importing from L0–L3.
- `build-integrations/runtime/conventional-routes.ts` derives the plugin-name route table from the
  manifest at runtime rather than from a hardcoded list.

### Documentation

- `ARCHITECTURE.md` now explicitly names `orchestrators/built-in-plugin-layers.ts` and
  `orchestrators/runtime-composition.ts` as the documented "built-in defaults composition" seam,
  with the plugin-author equivalent being `RunStackOptions.extendContext` +
  `CapabilitySinksService`.
- Substrate name-blindness allowlist documents the `account/`, `package/`, `wallet/` projection-key
  prefix exception.

### Tests

- Per-capability-decl contract tests added under `test/contracts/` — one per decl kind pinning the
  discriminated-union literal + required-field shape + a happy-path decode.
- Bug-regression tests added for each critical correctness fix above (recovery scanner, capture
  identity merge, prune misrouting, exit-code table, network validation, …).
- `CapabilitySinks` unregistered-kind test pins that emitting a custom kind with no registered sink
  surfaces a typed error.

### Removed stub surfaces

- `plugins/sui/seed-objects.ts` accumulator (never wired).
- `plugins/sui/live-faucet-strategy.ts` (never wired).
- `plugins/deepbook/` server / indexer routable factories and the `DEEPBOOK_SERVER_*` /
  `DEEPBOOK_INDEXER_METRICS_*` reserved entrypoint ports (never wired).

These will be re-introduced when actually consumed.

## 0.0.1

### Patch Changes

- 133fb14: Add the signer package required by the dev-wallet adapters barrel to scaffolded apps,
  align the generated Vitest version with devstack's published peer range, and update the devstack
  install docs.
- 133fb14: Switch to trusted publishing.
