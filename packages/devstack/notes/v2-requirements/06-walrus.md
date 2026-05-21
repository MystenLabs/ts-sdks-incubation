# walrus

## Purpose

Walrus is a decentralised blob-storage protocol that runs on Sui. Devstack's `walrus` component is
the surface area that lets a developer stand up (or point at) a Walrus deployment from a
`defineDevstack(...)` config. It has two operating shapes that are picked automatically from the
resolved Sui network:

- **Local-cluster mode (localnet).** Build a wrapper docker image, run a one-shot `walrus-deploy`
  against the local sui chain that publishes the Walrus Move package, mints a WAL exchange, and
  emits per-node config files; start an N-storage-node committee on a pinned docker network; expose
  the cluster via the global Traefik router and an in-cluster WAL faucet strategy; seed declared
  accounts with WAL.
- **Known-deployment mode (testnet/mainnet, plus fork-known).** A pure-config surface that produces
  Effect `Context.Service` layers pointing at the live Walrus testnet/mainnet system + staking
  objects. No containers, no docker network, no admin capabilities.

The component fans out across four narrow `Context.Service` tags (`WalrusNetworkTag`,
`WalrusNodesTag`, `WalrusProxyTag`, `WalrusAdminTag`) so downstream code (the `@mysten/walrus` SDK,
blob fetchers, faucet WAL strategy) can type-depend on exactly the subset of Walrus capabilities it
needs. Known-deployment mode intentionally omits `WalrusAdminTag` so any code that requires admin
power on Walrus is type-checked away from running against testnet/mainnet (cite
`src/services/walrus.ts:131-156` for the admin-tag definition and
`src/services/walrus/known-deployment.ts:1-4` for the omission rule).

The fork-mode behaviour is asymmetric:

- `Walrus()` on a `*-fork` network auto-routes to the known-deployment branch of the wrapped
  upstream (see `src/services/walrus.ts:236-250`).
- `walrusLocalCluster()` composed directly on a `*-fork` network throws `ForkIncompatibleError` at
  factory time — the local cluster's storage nodes need JSON-RPC against the chain and sui-fork
  doesn't expose it (see `src/services/walrus/local-cluster.ts:88-114`).

## Current implementation

### `src/services/walrus.ts` (261 LOC)

Canonical `Walrus(opts?)` factory + the four narrow `Context.Service` tag declarations plus their
schemas.

- `WalrusNetwork` interface + `WalrusNetworkTag` class (`src/services/walrus.ts:54-81`) — on-chain
  identifiers: `systemObjectId`, `stakingPoolId`, `exchangeIds`, `network`, plus an SDK-ready
  `packageConfig` view that mirrors `@mysten/walrus`'s `WalrusPackageConfig` shape.
- `WalrusNodeInfo` + `WalrusNodes` interfaces + `WalrusNodesTag` class
  (`src/services/walrus.ts:87-107`) — per-node descriptor (`nodeId`, `publicKey`, `url`) and the
  committee view (`nodes: ReadonlyArray<...>`).
- `WalrusProxy` interface + `WalrusProxyTag` class (`src/services/walrus.ts:121-129`) — `proxyUrl` /
  `aggregatorUrl` / `publisherUrl`. The local primitive collapses all three onto a single Traefik
  vhost; the contract keeps them separate so remote factories can surface distinct endpoints.
- `WalrusAdmin` interface + `WalrusAdminTag` class (`src/services/walrus.ts:146-156`) —
  `waitForCommittee` (currently a typed no-op that returns `Effect.void`, since per-node ready
  probes happen in phase 4) and `seedWal({address, amount})` (swap SUI for WAL on a registered seed
  account).
- Schemas (`src/services/walrus.ts:166-206`) — `WalrusNetworkSchema`, `WalrusNodeInfoSchema`,
  `WalrusNodesSchema`, `WalrusProxySchema`. No schema for `WalrusAdmin` because it carries Effect
  values that aren't Schema-validatable (`src/services/walrus.ts:208-210`).
- `WalrusOptions` (`src/services/walrus.ts:216-221`) — single `local?: WalrusLocalClusterOptions`
  pass-through. Live nets ignore it.
- `Walrus(opts)` factory body (`src/services/walrus.ts:236-250`) — reads `resolveNetwork()`,
  branches into `walrusKnownDeployment` for non-localnet (consulting
  `resolveDeploymentNetwork(network)` to translate fork variants to their upstream live-net key) or
  `walrusLocalCluster(opts.local ?? {})` for localnet. The branch makes the local-cluster path
  inaccessible from `Walrus()` on a fork stack; explicit `walrusLocalCluster()` callers trip the
  `ForkIncompatibleError` thrown inside that factory.
- Re-exports `localnetWalrusOptions` / `LocalnetWalrusOptions` / `LocalnetWalrusInputs` from
  `./walrus/options.js` (`src/services/walrus.ts:256-261`).

### `src/services/walrus/index.ts` (30 LOC)

Barrel that re-exports `walrusLocalCluster`, `walrusKnownDeployment`, and `localnetWalrusOptions`.
Documents the four-vs-three tag asymmetry between the two factories in a header comment.

### `src/services/walrus/options.ts` (44 LOC)

`localnetWalrusOptions(args)` — pure helper that builds the `packageConfig`

- `storageNodeUrlScheme: 'http'` fields for `new WalrusClient(...)` against a devstack-booted
  Walrus. Decoupled from any specific manifest shape so app code can source the ids from generated
  `captured.ts` (`src/services/walrus/options.ts:36-44`).

### `src/services/walrus/local-cluster.ts` (350 LOC)

`walrusLocalCluster(options)` factory. Owns:

- `WalrusLocalClusterOptions<Name>` interface (`:51-76`) — `name`, `nodeCount`, `seedAccounts`,
  `version`, `suiVersion`, `containerApiPort`, `shards`, `epochDuration`, `readyTimeoutMs`,
  `seedPaymentMist`, `movePackagePath`.
- Synchronous factory-time guards (`src/services/walrus/local-cluster.ts:101-121`):
  `ForkIncompatibleError` on `*-fork` networks, `nodeCount >= 1`, `shards >= nodeCount`.
- Sibling `LayeredTag`s built at factory time so the topo scheduler sees them as level-0 leaves:
  `moveSource` (`gitFetch` of the walrus Move source, only when no `movePackagePath` was passed) and
  `upstreamImage` (the cargo-built `dockerImage`) (`src/services/walrus/local-cluster.ts:135-165`).
- `acquireAndProject` (`:180-294`) — the big body. Wires `EngineHandle`-aware lifecycle hooks
  (`markAcquiring`, `setEntryTitle`, `setPhase`, `markReady`, `markFailed`), calls
  `acquireLocalCluster(...)` from `internal.ts`, then projects the acquire result into four
  `Context.Service` shapes (network / nodes / proxy / admin) inside a single `Layer.effectContext`.
- The lifted-sibling return shape (`src/services/walrus/local-cluster.ts:328-349`): `__layer`,
  `__layers: [combinedLayer]` (deliberately slimmed to the primary so inner siblings don't
  double-build), `__extraMembers: innerSiblings`, `key: LOCAL_CLUSTER_KEY`, `__kind: 'service'`,
  `__pluginName: 'walrus'`, `__displayTitle: 'walrus.cluster'`, `__upstreamKeys` (resolves to
  `[SuiTag.key, ...seedAccountTags, upstreamImage, moveSource?]`).

### `src/services/walrus/known-deployment.ts` (133 LOC)

`walrusKnownDeployment(options)` factory.

- `WalrusKnownDeploymentOptions` interface (`:22-31`) — `network?: KnownNetwork`, plus per-field
  overrides (`systemObjectId` / `stakingPoolId` / `exchangeIds` / `nodes` / `aggregatorUrl` /
  `publisherUrl` / `proxyUrl`).
- `KNOWN_DEPLOYMENT_KEY = 'walrusKnownDeployment'` (`:33`) — fixed engine row key; this factory does
  not vary by `name`.
- Body (`:35-133`): synchronous lookup against `knownDeployments.walrus[network]`, synchronous
  throws when `systemObjectId` / `stakingPoolId` / `nodes` is missing, build `WalrusNetwork` /
  `WalrusNodes` / optionally `WalrusProxy` shapes (proxy is only published when all three URLs are
  present — `:101-112`), publish `WalrusStateRegistry` entry via
  `publishWalrusState({ name: KNOWN_DEPLOYMENT_KEY, systemObjectId })` inside `Layer.effectDiscard`
  (`:117-120`).
- Returns a `StackMember` with `__layer` / `__layers` / `key: KNOWN_DEPLOYMENT_KEY` /
  `__kind: 'service'` / `__pluginName: 'walrus'` / `__displayTitle: 'walrus.<network>'`. No
  `__upstreamKeys`, no `__extraMembers`.

### `src/services/walrus/internal.ts` (893 LOC)

The bulk of the local-cluster acquire logic.

- Defaults block (`:55-91`): `DEFAULT_WALRUS_REPO`, `DEFAULT_WALRUS_REF = 'devnet-v1.48.0'`,
  `DEFAULT_WALRUS_MOVE_SUBDIR = 'contracts/walrus'`, `DEFAULT_SUI_VERSION = 'devnet-v1.71.0'`,
  `DEFAULT_RUST_TOOLCHAIN = '1.93'`, `DEFAULT_NODE_API_PORT = 9185`, `ROUTER_WALRUS_PORT = 9185`,
  `DEFAULT_READY_TIMEOUT_MS = 60_000`, `DEFAULT_EPOCH_DURATION = '24h'`, `DEFAULT_SHARDS = 100`,
  `DEFAULT_SEED_WAL_PAYMENT_MIST = 500_000_000n`, `WALRUS_NODE_IP_BASE = 10`.
- `subnetForStack(app, stack)` (`:118-128`) — deterministic per-stack /24 derived from
  `sha256(<app>/<stack>/walrus)` in the range `10.[16..250].0/24`.
- Shape interfaces (`:145-202`): `DeployState`, `CachedDeployState`, `ExchangeState`, `NodeState`,
  `LocalClusterAcquired`, `LOCAL_CLUSTER_KEY = 'walrusLocalCluster'`.
- `acquireLocalCluster(args)` (`:211-644`) — the eight-step orchestrator. See "Lifecycle" below.
- `makeAdminShape(args)` (`:660-692`) — builds the `WalrusAdmin` value from the acquire state.
  `waitForCommittee = Effect.void`; `seedWal` resolves the request against the registered seed
  accounts and calls `swapSuiForWal`.
- `registerCommittee(args)` (`:711-747`) — currently a typed no-op span wrapped in `withCache` so
  the future per-node re-registration fill-in is a body edit, not a structural change. Returns
  `null`.
- `seedWalForAccounts(args)` (`:762-777`) — loops the declared seed accounts through
  `swapSuiForWalCached`.
- `swapSuiForWalCached(args)` (`:779-834`) — `withCache` wrapper around `swapSuiForWal` keyed by
  `(chainId, exchange.objectId, account.address)`; verify confirms
  `ChainProbe.getTransaction(digest)` still resolves.
- `swapSuiForWal(account, exchange, paymentMist)` (`:836-877`) — builds the `exchange_all_for_wal`
  Move call, signs+executes with the seed account, returns the resulting digest string.

### `src/services/walrus/image.ts` (61 LOC)

Wrapper-image build. `buildWrapperImage({name, context, baseImage, suiVersion})` (`:27-61`) computes
a content-addressed tag from
`{context, dockerfile: 'wrapper.Dockerfile', buildArgs: {BASE_IMAGE, SUI_VERSION}}` via
`contentHash`, then calls `Docker.build(...)` and wraps `DockerError` failures in
`WalrusError{phase: 'image'}`.

### `src/services/walrus/deploy.ts` (382 LOC)

The deploy one-shot + exchange-discovery phase.

- `makeOutputLineSink(label)` (`:53-65`) — per-line sink with a `DEVSTACK_LOG_LEVEL`-keyed min-level
  filter that defaults to `'warn'` (deploy emits ~50 INFO lines per boot that would otherwise spam
  the TUI).
- `deployContracts(args)` (`:71-268`) — creates the host output dir, derives in-network sui RPC +
  faucet URLs (preferring `rpc.container` over `rpc.host`), assembles the deploy env vars
  (`WALRUS_PUBLIC_HOSTS`, `WALRUS_LISTENING_IPS`, `WALRUS_REST_API_PORT`, `WALRUS_COMMITTEE_SIZE`,
  `WALRUS_SHARDS`, `WALRUS_EPOCH_DURATION`, `WALRUS_NETWORK`), calls `Docker.runOneShot(...)`
  against the wrapper image's `/opt/walrus/scripts/deploy-walrus.sh`, joins the per-stack sui docker
  network so `sui-localnet` DNS resolves inside the one-shot, then reads and parses the
  `<outputDir>/deploy` file.
- `parseDeployFile(outputDir, text)` (`:273-312`) — `key: value` newline-separated parser. Returns
  the `DeployState`. Required keys: `package_id`, `system_object`, `staking_object`. Optional:
  `upgrade_manager_object`, `treasury_object`, `exchange_object`.
- `resolveExchange(args)` (`:318-382`) — `client.core.getObject(exchangeObject)`, parse the type as
  `<pkg>::wal_exchange::Exchange`, return `{objectId, packageId}`. Gracefully degrades to
  `undefined` on `OBJECT_NOT_FOUND` (cache-resume safety: the cached exchange object can go missing
  after a regenesis).

### `src/services/walrus/nodes.ts` (275 LOC)

Storage-node committee boot.

- `makeNodeOutputSink(label)` (`:46-58`) — per-node line sink with the same `'warn'` default level
  (each storage node emits 5–20 INFO lines per second of normal narration).
- `startStorageNodes(args)` (`:60-275`) — parallel-`Effect.all` over `[0..nodeCount)`. Per node:
  assemble `containerIp` from `subnetPrefix + WALRUS_NODE_IP_BASE + i`, build the public hostname
  via `routerHostname(identity, 'walrus-node-' + i)`, call `runDockerContainer` with `--ip` pin +
  Traefik routing labels + `cors: true` + `stopGraceSeconds: 20`, then attach the storage node to
  the sui per-stack docker network via `Docker.networkConnect` so `WALRUS_FAUCET_URL` resolves via
  docker DNS. Finally run a router-fronted TCP ready probe against
  `${publicHostname}:${routerEntrypointPort}` (port 9185).
- `nodeStopScope` (`:109-110`) — parallel-strategy scope forked off the cluster scope so the four
  nodes' `docker stop --time 20` finalizers fire concurrently at teardown instead of serially (4 ×
  20 = 80 s collapsed to max ≈ 20 s).

### `src/services/walrus.test.ts` (175 LOC)

Unit-level coverage for `walrusKnownDeployment` + the stack-scoped router hostname pattern. See
"Test coverage" below.

### `src/services/walrus.fork-known.docker.test.ts` (26 LOC)

Phase 3 P3.T3 gate (gated behind `RUN_FORK_DOCKER_TESTS=1`). Pending docker wiring; the assertion is
currently `expect(SHOULD_RUN).toBe(true)`.

### `src/services/walrus.fork-localcluster-refused.test.ts` (78 LOC)

Phase 3 P3.T4 — `walrusLocalCluster()` must throw `ForkIncompatibleError` when `DEVSTACK_NETWORK` is
`*-fork`. Pure-unit (no Docker, no supervisor).

### Walrus-adjacent files outside the scope but referenced

- `src/engine/registries.ts:69-75, 265-268, 345-348, 394` — `WalrusStateRecord`,
  `WalrusStateRegistry` class, `WalrusStateRegistryLive` + `publishWalrusState` derived via
  `defineRegistry`, included in the bundled `RegistriesLive`.
- `src/engine/known-deployments.ts:125-151, 162, 392-421` — `WalrusDeployment` interface,
  `knownDeployments.walrus` entry, testnet + mainnet records.
- `src/engine/errors.ts:307-323` — `WalrusError` class (phase / component / message / stderr /
  stdout / exitCode / cause).
- `src/engine/phases.ts:68-77` — `WalrusPhases` closed set:
  `'image' | 'network' | 'deploy' | 'exchange' | 'nodes' | 'proxy' | 'seed'`.
- `src/engine/state-store-keys.ts:43-62` — `walrusDeployOutput({chainId})` and
  `walrusSeedWal({chainId, exchangeObjectId, accountAddress})`.
- `src/runtime/endpoint-names.ts:75-87, 135-136` — `walrus-aggregator` and `walrus-publisher`
  `defineEndpoint` declarations.
- `src/runtime/manifest-schema.ts:51-56` — `WalrusManifest` schema struct.
- `src/runtime/service.ts:115-128` — `walrusProjection` (state → manifest).
- `src/services/faucet/strategies/wal-exchange.ts` (82 LOC) — the WAL faucet strategy that
  `acquireLocalCluster` registers on the global `Faucet`.
- `images/walrus/upstream.Dockerfile` + `images/walrus/wrapper.Dockerfile` +
  `images/walrus/deploy.sh` + `images/walrus/run.sh` — the vendored docker recipes the local-cluster
  path drives.

### LOC totals

- In-scope src LOC: `261 + 30 + 44 + 350 + 133 + 893 + 61 + 382 + 275 = 2429` (excluding the four
  image-side files).
- In-scope test LOC: `175 + 26 + 78 = 279`.

## Configuration

The component is configured exclusively via the `Walrus(opts)` / `walrusLocalCluster(opts)` /
`walrusKnownDeployment(opts)` factory call sites, plus a handful of env vars that the supervisor and
image scripts consult directly.

### `Walrus(opts)` config keys

Defined by `WalrusOptions` (`src/services/walrus.ts:216-221`).

| Key     | Type                        | Default | What it controls                                                                          | Cite                         |
| ------- | --------------------------- | ------- | ----------------------------------------------------------------------------------------- | ---------------------------- |
| `local` | `WalrusLocalClusterOptions` | `{}`    | Pass-through into `walrusLocalCluster(...)` on localnet. Ignored on testnet/mainnet/fork. | `src/services/walrus.ts:220` |

`Walrus()` exposes no `override:` surface for known-deployment mode — the canonical registry already
carries every field for `testnet` / `mainnet`, and plugin authors needing to pin a private
deployment call `walrusKnownDeployment({...})` from `/advanced` directly (cite
`src/services/walrus.ts:27-32`).

### `walrusLocalCluster(opts)` config keys

Defined by `WalrusLocalClusterOptions<Name>` (`src/services/walrus/local-cluster.ts:51-76`).

| Key                | Type                                       | Default                                                    | What it controls                                                                                                                                                      | Cite                                           |
| ------------------ | ------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `name`             | `Name extends string`                      | `'walrus'`                                                 | Engine row key suffix, registry name, docker-network suffix, runtime output dir name. Pinned at factory-time.                                                         | `:81`                                          |
| `nodeCount`        | `number`                                   | `1`                                                        | Number of storage-node containers in the committee. Must be `>= 1`; throws synchronously otherwise.                                                                   | `:82, :116-118`                                |
| `seedAccounts`     | `ReadonlyArray<LayeredTag<…, Account, …>>` | `[]`                                                       | Accounts to swap SUI→WAL for after deploy. First element doubles as the deploy-paying admin and the WAL-faucet-strategy signer.                                       | `:129, :246-249, :485-489, :572-583, :593-600` |
| `version`          | `string`                                   | `DEFAULT_WALRUS_REF` (`'devnet-v1.48.0'`)                  | Pinned walrus release. Drives the `git clone --branch` in the upstream Dockerfile AND the matching `gitFetch` of Move sources.                                        | `:123, internal.ts:63`                         |
| `suiVersion`       | `string`                                   | `DEFAULT_SUI_VERSION` (`'devnet-v1.71.0'`)                 | Sui release whose binary the wrapper image bakes for the deploy script's admin wallet bootstrap.                                                                      | `:124, internal.ts:74`                         |
| `containerApiPort` | `number`                                   | `DEFAULT_NODE_API_PORT` (`9185`)                           | Port each storage node binds inside the container.                                                                                                                    | `:83, internal.ts:81`                          |
| `shards`           | `number`                                   | `DEFAULT_SHARDS` (`100`)                                   | Total shards distributed across the committee. Must be `>= nodeCount`; throws synchronously otherwise.                                                                | `:84, :119-121`                                |
| `epochDuration`    | `string`                                   | `DEFAULT_EPOCH_DURATION` (`'24h'`)                         | Walrus epoch length passed to `walrus-deploy --epoch-duration`.                                                                                                       | `:85, internal.ts:89`                          |
| `readyTimeoutMs`   | `number`                                   | `DEFAULT_READY_TIMEOUT_MS` (`60_000`)                      | Per-node TCP ready-probe timeout.                                                                                                                                     | `:86, internal.ts:88`                          |
| `seedPaymentMist`  | `bigint`                                   | `DEFAULT_SEED_WAL_PAYMENT_MIST` (`500_000_000n` = 0.5 SUI) | SUI MIST to spend per seed account on the SUI→WAL swap. Also the `defaultPaymentMist` baked into the registered WAL faucet strategy.                                  | `:87, internal.ts:91, :579, :597`              |
| `movePackagePath`  | `string` (path)                            | `undefined`                                                | If set, skips the `gitFetch` of the walrus Move source and uses the on-disk path. Surfaces via a span attribute only; the wrapper image bakes its own contracts copy. | `:75-76, :136-143, internal.ts:257-264`        |

### `walrusKnownDeployment(opts)` config keys

Defined by `WalrusKnownDeploymentOptions` (`src/services/walrus/known-deployment.ts:22-31`).

| Key              | Type                                                  | Default                                                                              | What it controls                                                                                                                                    | Cite               |
| ---------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `network`        | `KnownNetwork` (`'testnet' \| 'mainnet' \| 'devnet'`) | `undefined`                                                                          | Looks up the per-field defaults from `knownDeployments.walrus[network]`.                                                                            | `:23, :41`         |
| `systemObjectId` | `string`                                              | from `knownDeployments.walrus[network]`                                              | On-chain Walrus System object id. Required (throws synchronously if missing).                                                                       | `:24, :43, :52-57` |
| `stakingPoolId`  | `string`                                              | from `knownDeployments.walrus[network]`                                              | On-chain staking pool object id. Required (throws synchronously if missing).                                                                        | `:25, :44, :58-63` |
| `exchangeIds`    | `ReadonlyArray<string>`                               | from `knownDeployments.walrus[network]`                                              | WAL exchange contract ids. Surfaced in the SDK-ready `packageConfig` as a mutable `string[]`.                                                       | `:26, :45, :87-93` |
| `nodes`          | `ReadonlyArray<WalrusNodeInfo>`                       | from `knownDeployments.walrus[network]` (always undefined in the canonical registry) | Explicit storage-node committee. Required — testnet has 100+ nodes that aren't statically pinned, so the factory throws synchronously when missing. | `:27, :46, :70-77` |
| `aggregatorUrl`  | `string`                                              | from `knownDeployments.walrus[network]`                                              | Walrus aggregator URL.                                                                                                                              | `:28, :47`         |
| `publisherUrl`   | `string`                                              | from `knownDeployments.walrus[network]`                                              | Walrus publisher URL.                                                                                                                               | `:29, :48`         |
| `proxyUrl`       | `string`                                              | `aggregatorUrl ?? publisherUrl`                                                      | "Front door" URL for the SDK.                                                                                                                       | `:30, :49`         |

`WalrusProxyTag` is only published when ALL three URLs (`proxyUrl`, `aggregatorUrl`, `publisherUrl`)
are non-empty (`:101-103`).

### Env vars

| Env var                 | Read by                                                                                | Effect                                                                                                                                                                   | Cite                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `DEVSTACK_NETWORK`      | `resolveNetwork()` called inside `Walrus()` factory and `walrusLocalCluster()` factory | Drives the localnet vs known-deployment branch; trips `ForkIncompatibleError` in `walrusLocalCluster` on `*-fork`.                                                       | `src/services/walrus.ts:237, src/services/walrus/local-cluster.ts:101-114`                            |
| `DEVSTACK_LOG_LEVEL`    | `resolveMinLevel(...)` in `deploy.ts` + `nodes.ts`                                     | Lowers (`'info'`/`'trace'`/`'debug'`) or raises (`'warn'`/`'error'`) the supervisor log-sink filter for walrus-emitted lines. Container stderr stream is never silenced. | `src/services/walrus/deploy.ts:44-51, src/services/walrus/nodes.ts:35-41`                             |
| `DEVSTACK_KEEP_ONESHOT` | inherited from `Docker.runOneShot`, referenced in `deploy.ts:223-225`                  | When set, the deploy one-shot container is not auto-removed post-exit so failed deploys can be `docker logs`-ed.                                                         | `src/services/walrus/deploy.ts:223-225` (refers to behaviour; the env var is read by `engine/docker`) |
| `DEVSTACK_STACK`        | `resolveStackName` in supervisor                                                       | Indirect — drives `identity.stack`, which feeds `subnetForStack` (per-stack /24) and `routerHostname` (per-stack public hostnames).                                      | `src/engine/supervisor.ts:990-991`                                                                    |

### CLI flags

`Walrus` itself registers no CLI commands. The CLI `--network` flag in `src/cli/...` sets
`DEVSTACK_NETWORK` before the supervisor body runs, and that's what `resolveNetwork()` reads.

### Inputs supplied by the script env (`deploy-walrus.sh`)

The deploy script reads these env vars from the container environment that `deployContracts`
assembles (`src/services/walrus/deploy.ts:192-203`): `WALRUS_PUBLIC_HOSTS`, `WALRUS_LISTENING_IPS`,
`WALRUS_REST_API_PORT`, `WALRUS_COMMITTEE_SIZE`, `WALRUS_SHARDS`, `WALRUS_EPOCH_DURATION`,
`WALRUS_NETWORK`. The script also recognises `WALRUS_GC`, `WALRUS_CONTRACT_DIR`,
`WALRUS_DEPLOY_BIN`, `WORKING_DIR`, but devstack does not set these — they default inside the script
(`images/walrus/deploy.sh:42-51`).

The storage-node `run.sh` reads `HOSTNAME` (provided by Docker via the container hostname pin) and
`WALRUS_FAUCET_URL` (devstack sets this from
`Sui.faucet.container ?? Sui.rpc.container ?? Sui.faucet.host ?? Sui.rpc.host`

- `/v1/gas`, cite `src/services/walrus/internal.ts:497-507`).

## Capabilities CONSUMED

### Other services / components

- **`SuiTag` (sui service).** Yielded inside `acquireLocalCluster`
  (`src/services/walrus/internal.ts:236`) to get `sui.rpc` / `sui.faucet` / `sui.chainId` /
  `sui.client`. Hard required: the deploy one-shot dials the chain via `WALRUS_NETWORK`, the cache
  key folds `chainId`, storage nodes dial the faucet for SUI, and `resolveExchange` uses
  `sui.client.core.getObject`. Sui is also declared as an upstream edge via `__upstreamKeys`
  (`src/services/walrus/local-cluster.ts:332`).
- **`FaucetTag` (faucet service).** Optionally yielded via `Effect.serviceOption(FaucetTag)` after
  the exchange resolves (`src/services/walrus/internal.ts:572-583`). When present and the exchange +
  at least one seed account exist, walrus registers a `walExchangeStrategy` so any
  `Account({funding: {WAL}})` request can be satisfied.
- **`Account` shape via `LayeredTag<…, Account, …>` seed account tags.** Each declared seed account
  tag is resolved upfront (`src/services/walrus/internal.ts:246-249`); `seedAccounts[0]` doubles as
  the deploy-paying admin (`:485-489`) and the faucet-strategy signer (`:575-578`).

### Engine resources

- **`EngineHandle` (`src/engine/engine.ts`).** Optionally yielded via
  `Effect.serviceOption(EngineHandle)` (`src/services/walrus/local-cluster.ts:186`). When present,
  walrus calls `markAcquiring(LOCAL_CLUSTER_KEY, 'service')`,
  `setEntryTitle(LOCAL_CLUSTER_KEY, 'walrus.cluster')`, `setPhase(LOCAL_CLUSTER_KEY, phase)` for
  each of the eight phases, `markReady(LOCAL_CLUSTER_KEY, {title, primary, extras})`, and
  `markFailed(LOCAL_CLUSTER_KEY, cause)`. The internal `deploy.ts` and `nodes.ts` also use
  `EngineHandle.appendLog` indirectly via their per-line sinks.
- **`Identity` (`src/engine/identity.ts`).** Yielded inside `acquireLocalCluster`
  (`internal.ts:238`) and used to compute the per-stack /24 subnet
  (`subnetForStack(identity.app, identity.stack)`, `:239-242`), to compute container names
  (`Docker.composeContainerName`, `:436-441`), and to compute per-stack docker network names
  (`internal.ts:300-305`) and stack-scoped router hostnames (`routerHostname(args.identity, ...)`,
  `nodes.ts:117`).
- **`StateStore` (`src/engine/state-store.ts`).** Consumed via `withCache` for the deploy cache
  (`internal.ts:350-472`), the register-committee cache (`internal.ts:718-746`), and per-account
  seed-WAL caches (`internal.ts:807-833`). Cache keys use
  `StateStoreKeys.walrusDeployOutput({chainId})` and
  `StateStoreKeys.walrusSeedWal({chainId, exchangeObjectId, accountAddress})` (cite
  `src/engine/state-store-keys.ts:49-50, 57-62`).
- **`ChainProbe` (`src/engine/chain-probe.ts`).** Yielded inside `acquireLocalCluster`
  (`internal.ts:237`) and `swapSuiForWalCached` (`internal.ts:787`). Used for
  `chain.objectsMatchTypes([system, staking], matcher)` in the deploy-cache verify (`:398-404`) and
  `chain.getTransaction(digest)` in the seed-wal verify (`:816`).
- **`servicePath('walrus', name, 'deploy')` (`src/engine/service-paths.ts:80-92`).** Computes
  `.devstack/stacks/<stack>/runtime/walrus/<name>/deploy/` — the host output dir for the deploy
  one-shot AND the read-only mount the storage nodes consume (`internal.ts:334`).
- **`withCache` (`src/engine/cache.ts`).** Used three times: deploy output, register committee,
  per-account seed-wal swap. Each cache block carries a `chainId` namespace, a typed `verify` probe,
  and a `produce` body.
- **Registries:**
  - `publishPackage(...)` — pushes `walrus.<name>` into `PackageRegistry` with
    `{packageId, mvrPlaceholder: '@local/walrus', captured: {systemObject, stakingObject, exchangeObject?}}`
    (`internal.ts:606-615`).
  - `publishEndpoint(...)` — three endpoints per local cluster: `EndpointName.WALRUS_AGGREGATOR`,
    `EndpointName.WALRUS_PUBLISHER`, and `walrus-node-<i>` (one per storage node)
    (`internal.ts:617-633`).
  - `publishWalrusState({name, systemObjectId})` — `WalrusStateRegistry` entry. Local cluster
    publishes `{name, systemObjectId}` with `name` matching the factory's `name` option
    (`internal.ts:634`). Known-deployment publishes
    `{name: 'walrusKnownDeployment', systemObjectId}` (`known-deployment.ts:117-119`).

### Runtime resources

- **Container runtime (`Docker` from `src/engine/docker.ts`).**
  - `Docker.build(...)` — the wrapper image (`src/services/walrus/image.ts:44-49`).
  - `Docker.networkCreate(networkName, {subnet})` — per-stack walrus network with the pinned `/24`
    (`internal.ts:306-316`).
  - `Docker.runOneShot(...)` — the deploy one-shot (`deploy.ts:206-228`).
  - `Docker.composeContainerName(...)` + `Docker.removeContainerByName(...)` — best-effort scrubbing
    of previous nodes' RocksDB on cache-miss re-deploy (`internal.ts:435-443`).
  - `runDockerContainer(...)` (from `src/advanced/plugin-author/docker-container.ts`) — each storage
    node (`nodes.ts:139-191`).
  - `Docker.networkConnect(suiNetwork, containerId)` — dual-home each storage node onto the
    per-stack sui docker network (`nodes.ts:216-228`).
  - `Docker.awaitContainerReady({containerName, probe: {kind: 'tcp', host: publicHostname, port: routerEntrypointPort, …}})`
    — router-fronted readiness (`nodes.ts:238-257`).
  - `StopFinalizerScope` (`src/engine/docker/sweep.ts`) — provided with the forked parallel
    `nodeStopScope` so per-node `docker stop`s fire concurrently (`nodes.ts:103-110, 271-273`).
- **`@effect/platform` `FileSystem`.** Consumed via `FileSystem.FileSystem` in `deployContracts`
  (output dir mkdir + `readFileString` of the `deploy` file) (`deploy.ts:123-139, 256-266`) and via
  direct `node:fs/promises` `nodeFs.access` in the deploy-cache verify (`internal.ts:373-378`).
- **`@effect/unstable/process` `ChildProcessSpawner`.** Required by `Docker.build` / `Docker.run`
  (image + container subprocess execution).

### Surfaces

- **TUI rows.** `LOCAL_CLUSTER_KEY = 'walrusLocalCluster'` (`internal.ts:202`) is the engine row
  key. All four storage nodes' stop finalizers route their `markStopping` / `markStopped` events to
  this single row via `engineTagKey: LOCAL_CLUSTER_KEY` (`internal.ts:524, nodes.ts:88-89, 191`).
  The row shows `walrus.cluster` with `primary = proxyUrl` and `extras = ['N nodes']`
  (`local-cluster.ts:233-239`).
- **Per-phase log lines.** Each storage node / deploy one-shot is wrapped in a per-line sink keyed
  by `[walrus.deploy]` / `[walrus.node-N]` and `EngineHandle.appendLog`-ed
  (`deploy.ts:53-65, nodes.ts:46-58`).
- **OpenTelemetry spans.** Preserved phase span names: `walrus.image` (image.ts), `walrus.deploy`
  (deploy.ts), `walrus.exchange` (deploy.ts), `walrus.register` (internal.ts:717), `walrus.nodes`
  (nodes.ts), `walrus.seed-accounts` (internal.ts:768), `walrusLocalCluster(${name})`
  (local-cluster.ts:180). `WalrusSeedAccounts(${account.name})` per-swap span (internal.ts:877).

### External

- **Docker daemon** — local docker daemon for build + run.
- **GitHub raw / git** — `gitFetch` of `https://github.com/MystenLabs/walrus.git` at `walrusVersion`
  for the Move source. The upstream Dockerfile does its own `git clone --depth 1` of the same repo
  inside the build stage.
- **GitHub releases** — the wrapper Dockerfile curl-fetches the matching sui release tarball from
  `https://github.com/MystenLabs/sui/releases/download/${SUI_VERSION}/...`.
- **Walrus testnet/mainnet** — the canonical Walrus aggregator + publisher URLs from
  `knownDeployments.walrus` for the known-deployment path. Cite
  `src/engine/known-deployments.ts:402-419`.
- **Sui chain (RPC + faucet)** — through `SuiTag.rpc` / `SuiTag.faucet`.
- **System binaries inside the container** — `walrus`, `walrus-node`, `walrus-deploy`, `sui` (the
  cargo-built and tarball-fetched binaries).
- **Host ports** — devstack does NOT allocate a per-stack host port for walrus storage nodes any
  more. The Traefik router binds `9185` once on the host and routes by `Host:` header to each
  per-stack backend; this is the well-known walrus entrypoint port
  (`internal.ts:81-87, deploy.ts:99-107`).
- **Docker network IPs** — pinned `/24` carved out by `subnetForStack` with the third octet hashed
  off `<app, stack>` to avoid colliding with `docker0` defaults (`172.17.0.0/16`) or corp VPNs
  (`10.0.*`) (`internal.ts:118-128`).

### Effect / Layer / Context machinery

- Tags consumed via `yield*`: `SuiTag`, `ChainProbe`, `Identity`, `StateStore`, `EngineHandle` (via
  `serviceOption`), `FaucetTag` (via `serviceOption`), `FileSystem.FileSystem`.
- `Effect.scope` + `Scope.fork(scope, 'parallel')` — node stop scope (`nodes.ts:109-110`).
- `Layer.effectContext` — the local-cluster's single combined layer (`local-cluster.ts:296`).
- `Layer.succeed(...)` — known-deployment's per-tag layers (`known-deployment.ts:104-112`).
- `Layer.effectDiscard(publishWalrusState(...))` — known-deployment's registry publish layer
  (`known-deployment.ts:117-119`).
- `Layer.mergeAll(...)` — known-deployment combines the per-tag layers
  (`known-deployment.ts:122-124`).
- `Schema.TaggedErrorClass` for `WalrusError` (`engine/errors.ts:307`).
- `Schema.Struct` for the four shape schemas (`walrus.ts:166-206`).

### Imports from other workspace packages

- `@mysten/sui/transactions` (`Transaction`) — used in `swapSuiForWal` and `walExchangeStrategy` for
  the `wal_exchange::exchange_all_for_wal` move call (`internal.ts:31`).
- `@mysten/sui/grpc` (`SuiGrpcClient`) — type used in `resolveExchange` (`deploy.ts:22`).

### npm dependencies

- `effect` — `Context`, `Effect`, `Schema`, `Layer`, `FileSystem`, `Scope`.
- `@effect/platform-node/NodeFileSystem` — referenced only by the test file via
  `layer as NodeFileSystemLayer` (`walrus.test.ts:12`).
- `@effect/vitest` — test runner.
- `@mysten/sui` — `Transaction`, `SuiGrpcClient`.
- `@mysten/walrus` — peer dep (consumers bring their own SDK version). The
  `WalrusNetwork.packageConfig` shape is structurally compatible with `@mysten/walrus`'s
  `WalrusPackageConfig` (asserted at compile-time in `walrus.test.ts:29-38`).
- `node:crypto` (`createHash`) — `subnetForStack` (`internal.ts:28`).
- `node:fs/promises` — `nodeFs.access` in the deploy-cache verify (`internal.ts:29`).
- `effect/unstable/process` — `ChildProcessSpawner` consumed by `Docker.build` / `Docker.run`.

## Capabilities PRODUCED

### Endpoints

The local-cluster publishes the following to `EndpointRegistry` (`internal.ts:617-633`):

- `EndpointName.WALRUS_AGGREGATOR` (`'walrus-aggregator'`) — URL `proxyUrl` (router-fronted node-0
  URL), `kind: 'http'`. Conventional service alias `walrus-agg`, conventional port `9185`. Manifest
  path `services.walrus.aggregator` (`runtime/endpoint-names.ts:75-80`).
- `EndpointName.WALRUS_PUBLISHER` (`'walrus-publisher'`) — same URL as the aggregator on the local
  cluster (collapsed onto a single router vhost), `kind: 'http'`. Conventional alias `walrus-pub`,
  conventional port `9185`. Manifest path `services.walrus.publisher`
  (`runtime/endpoint-names.ts:82-87`).
- `walrus-node-<i>` (one per storage node, `i` in `[0..nodeCount)`) — `kind: 'walrus-node'`. URL
  shape `http://<routerHostname(identity, 'walrus-node-' + i)>:9185`. No `defineEndpoint`
  registration in `endpoint-names.ts` (free-form name string).

The known-deployment publishes `WalrusProxyTag` only when all three URLs are present; the endpoint
registry receives the `publishWalrusState({name: 'walrusKnownDeployment', systemObjectId})` call but
no `publishEndpoint(...)` calls — the URLs are surfaced via the `WalrusProxy` shape on the tag, not
via `EndpointRegistry`.

### State-store entries

Cache keys (`src/engine/state-store-keys.ts:49-62`):

- `walrus/deploy-output/<chainId>` — `CachedDeployState`:
  `{walrusPackageId, systemObject, stakingObject, upgradeManagerObject?, treasuryObject?, exchangeObject?}`
  (cite `internal.ts:158-165, 460-470`).
- `walrus/register-committee/v1/<chainId>` — currently `null` (typed no-op) (`internal.ts:718-746`).
- `walrus/seed-wal/<chainId>/<exchangeObjectId>/<accountAddress>` — `CachedSeedWalSwap`:
  `{digest, paymentMist: string, seededAt: ISO8601}` (`internal.ts:135-139, 824-832`).

Registry entries (`src/engine/registries.ts:69-75`):

- `WalrusStateRegistry`:
  - Local cluster: `{name: <opts.name>, systemObjectId: <deploy.systemObject>}` (cite
    `internal.ts:634`).
  - Known deployment: `{name: 'walrusKnownDeployment', systemObjectId: <opts.systemObjectId>}` (cite
    `known-deployment.ts:117-119`).
- `PackageRegistry` (local cluster only):
  `{name: 'walrus.<opts.name>', packageId: <walrusPackageId>, mvrPlaceholder: '@local/walrus', captured: {systemObject, stakingObject, exchangeObject?}}`
  (`internal.ts:606-615`).

### Events emitted

`EngineHandle.appendLog({ts, level, message})` per stdout/stderr line from the deploy one-shot
(`deploy.ts:53-65`) and each storage node (`nodes.ts:46-58`). Default filter level `'warn'`,
override via `DEVSTACK_LOG_LEVEL`.

Engine row state transitions on `LOCAL_CLUSTER_KEY`:
`markAcquiring → setEntryTitle → setPhase(× 7) → markReady` (or `markFailed`);
`markStopping → markStopped` per node at shutdown all collapsed onto the cluster row.

### Files written

- `<cwd>/.devstack/stacks/<stack>/runtime/walrus/<name>/deploy/`
  (`servicePath('walrus', name, 'deploy')` → `internal.ts:334`). Populated by the deploy one-shot:
  - `deploy` — the `key: value` summary parsed by `parseDeployFile` (`deploy.ts:188-201, 273-312`).
  - `dryrun-node-<i>.yaml` — per-node config the storage nodes mount (read-only) at
    `/opt/walrus/outputs` (`deploy.sh:203-251`).
  - `dryrun-node-<i>.keystore` — per-node sui keystore (`deploy.sh` → `generate-dry-run-configs`).
  - `dryrun-node-<i>-sui.yaml` — per-node sui client config (consumed by `run.sh:37`).
  - `sui_admin.yaml` + `sui_admin.keystore` — admin wallet derived in-script (`deploy.sh:99-150`).
- `runtime/<state-store stuff>` written by `StateStore` itself; walrus contributes via `withCache`
  writes only.

### CLI commands registered

None. Walrus contributes to status / manifest output via existing service-aware CLI logic
(`cli/commands/manifest.ts:74-80, cli/commands/status.ts:216-219`).

### Routes registered

Each storage node carries one Traefik route via `runDockerContainer({routing: […]})`
(`nodes.ts:152-163`):

```
{
  name: 'walrus-node-<i>',
  entrypoint: 'walrus',     // bound to host port 9185
  servicePort: <containerApiPort>,  // 9185 inside container
  cors: true,               // walrus storage REST API lacks CORS headers
}
```

The `walrus` entrypoint binds host port `9185` once globally; dispatch is by `Host:` header to
`routerHostname(identity, 'walrus-node-<i>')` (main stack: `walrus-node-<i>.<app>.localhost`;
non-main: `<stack>.walrus-node-<i>.<app>.localhost`).

### TypeScript exports consumed elsewhere

Public surface (`src/index.ts:44-48`):

- `Walrus`, `type WalrusOptions`.
- `localnetWalrusOptions`, `type LocalnetWalrusOptions`, `type LocalnetWalrusInputs`.

Plus the manifest schema (`src/index.ts:123`): `type WalrusManifest`.

Plus the tagged error (`src/index.ts:163`): `WalrusError`.

`/advanced` surface (`src/advanced/index.ts:179-195`):

- `WalrusNetworkTag`, `type WalrusNetwork`.
- `WalrusNodesTag`, `type WalrusNodes`.
- `WalrusProxyTag`, `type WalrusProxy`.
- `WalrusAdminTag`, `type WalrusAdmin`.

Plus the WAL faucet strategy (`src/advanced/index.ts:146`): `walExchangeStrategy`.

### Container images / volumes produced

- `walrus.image.upstream` — `dockerImage(...)` content-addressed tag for the upstream cargo build.
  Driven by `images/walrus/upstream.Dockerfile`.
- `devstack-<opts.name>.image:<contentHash>` — wrapper image driven by
  `images/walrus/wrapper.Dockerfile`. The wrapper layers a matching sui binary + the vendored
  `deploy.sh` + `run.sh` on top of the upstream image (`image.ts:42-43`).
- One docker network per stack: `walrus-<name>-net` (main stack on localnet) or
  `walrus-<app>-<stack>-<name>-net[-<network>]` (non-main or non-localnet) (`internal.ts:300-305`).
- N storage-node containers: `<docker compose name>walrus-<name>-node-<i>`, pinned at
  `<subnetPrefix>.<WALRUS_NODE_IP_BASE + i>` on the walrus network and dual-homed onto the per-stack
  sui network (`nodes.ts:114-115, 215-228`).
- One short-lived deploy one-shot container: `walrus-<name>-deploy` (`deploy.ts:207`).

## Lifecycle

### Startup — local cluster

Eight ordered phases inside `acquireLocalCluster` (`src/services/walrus/internal.ts:228-643`). Each
phase pushes a `setPhase(LOCAL_CLUSTER_KEY, phase)` call via the `pushPhase` callback
(`local-cluster.ts:201-203`) so the TUI row narrates progress.

0. **Yield dependencies (`internal.ts:236-249`).** `SuiTag`, `ChainProbe`, `Identity`,
   `seedAccountTags` (each resolved upfront so a missing account layer trips here rather than at the
   swap step).
1. **Image build (phase `'image'`, `internal.ts:271-282`).** Two-stage:
   - The upstream image — yielded via `yield* args.upstreamImage`, which references the lifted
     `dockerImage` member built in parallel with `Sui`'s boot by the topo scheduler.
   - The wrapper image — built inline via `buildWrapperImage(...)` because its `BASE_IMAGE`
     build-arg is the upstream's content-addressed tag, which only resolves at runtime
     (`local-cluster.ts:150-165, image.ts:27-61`). Span: `walrus.image`. 1b. **Network create (phase
     `'network'`, `internal.ts:300-320`).** Per-stack docker network with the pinned `/24` subnet
     via `Docker.networkCreate(networkName, {subnet})`. Trips `WalrusError{phase: 'network'}` on
     `DockerError`.
2. **Deploy contracts (phase `'deploying contracts'` — note the human phase string differs from the
   WalrusPhase enum `'deploy'`, `internal.ts:444`).** Wrapped in `withCache` keyed by
   `walrus/deploy-output/<chainId>`. The verify probe (`:371-414`) checks three conditions:
   1. The on-disk `<outputDir>/deploy` file exists.
   2. `chain.objectsMatchTypes([{objectId: systemObject}, {objectId: stakingObject}], () => true)`
      succeeds — both ids must resolve on chain.
   3. (Implicit: `chainId` is part of the cache key — regenesis invalidates cleanly.) On cache miss,
      `produce` (`:415-471`):
   4. Best-effort `docker rm -f` each predicted storage-node container name to drop stale RocksDB
      (`:434-443`).
   5. `deployContracts(...)` — runs the deploy one-shot via `Docker.runOneShot` (deploy.sh inside
      container). Span: `walrus.deploy`.
3. **Register committee (phase `'registering nodes'`, `internal.ts:483-489`).** Currently a typed
   no-op `withCache` body wrapped in span `walrus.register`. Future per-node re-registration would
   land here.
4. **Storage nodes (phase `'starting nodes'`, `internal.ts:495-525`).** Parallel
   `Effect.all({concurrency: 'unbounded'})` over N per-node Effects (`nodes.ts:111-275`). Per node:
   1. Allocate `containerIp = subnetPrefix.<WALRUS_NODE_IP_BASE + i>`.
   2. `runDockerContainer(containerName, {image, args: ['…run-walrus.sh'], mounts: [{source: deployDir, target: '/opt/walrus/outputs'}], env: {HOSTNAME, WALRUS_FAUCET_URL}, network: args.network, ip, hostname, networkAlias, routing: [{name, entrypoint: 'walrus', servicePort, cors: true}], onOutputLine, stopGraceSeconds: 20, engineTagKey: LOCAL_CLUSTER_KEY})`.
   3. `Docker.networkConnect(suiNetwork, runResult.containerId)` — attach to per-stack sui network
      for `sui-localnet` DNS resolution.
   4. `Docker.awaitContainerReady({probe: {kind: 'tcp', host:    publicHostname, port: 9185, timeoutMs: readyTimeoutMs}})`.
      Span: `walrus.nodes`.
5. **Exchange resolution (phase `'exchange'` via span, `internal.ts:537-540`).** Reads the exchange
   object's `.type` on chain via `sui.client.core.getObject` to extract the `wal_exchange` package
   id. Degrades to `undefined` on `OBJECT_NOT_FOUND`. Span: `walrus.exchange`.
6. **Proxy URL pick (no explicit phase, `internal.ts:553-561`).** Picks `nodes[0]!.rpcUrl` as the
   representative aggregator/publisher endpoint. Fails with `WalrusError{phase: 'proxy'}` if
   `nodes.length === 0` (in practice unreachable — `nodeCount >= 1` is enforced synchronously). 7a.
   **WAL faucet strategy register (no explicit phase, `internal.ts:572-583`).** If
   `exchange !== undefined && seedAccounts.length > 0`, optionally yield `FaucetTag` (via
   `serviceOption`) and call
   `faucet.register(walExchangeStrategy({exchange, signer: seedAccounts[0],     defaultPaymentMist: seedPaymentMist}))`.
   7b. **Seed accounts (phase `'seed'` via span, `internal.ts:593-600`).** If
   `exchange !== undefined && seedAccounts.length > 0`, run `seedWalForAccounts(...)` which loops
   each account through `swapSuiForWalCached`. Each cached on
   `(chainId, exchangeObjectId,     accountAddress)` so warm restart short-circuits idempotently.
   Span: `walrus.seed-accounts` + per-account `WalrusSeedAccounts(${account.name})`.
7. **Registries (no explicit phase, `internal.ts:606-634`).** `publishPackage`, `publishEndpoint` ×
   `(2 + nodeCount)`, `publishWalrusState`.

After acquire returns, `local-cluster.ts:233-239` calls
`engine.markReady(LOCAL_CLUSTER_KEY, {title: 'walrus.cluster', primary: proxyUrl, extras: ['N nodes']})`.

### Startup — known deployment

Purely synchronous factory body (`known-deployment.ts:35-133`). No ordered phases — the factory
either throws synchronously (missing field) or returns a `StackMember` whose layer is the eager
`Layer.mergeAll(...)` of `Layer.succeed(...)` constants. The `publishWalrusState` runs once at layer
build time via `Layer.effectDiscard`.

### Ready criteria

- **Local cluster.** Ready iff:
  - `withCache` deploy hit OR `deployContracts` returned a valid summary, AND
  - all N storage nodes passed `Docker.awaitContainerReady` against the router-fronted TCP probe at
    `${publicHostname}:9185`.
- **Known deployment.** Ready iff:
  - All three required fields (`systemObjectId`, `stakingPoolId`, `nodes`) were resolved at factory
    time.

Downstream-observable readiness signals:

- Engine row `LOCAL_CLUSTER_KEY` (`'walrusLocalCluster'`) transitions to `markReady` with
  `primary = proxyUrl`.
- `EndpointRegistry` has `walrus-aggregator` + `walrus-publisher` records (local cluster).
- `PackageRegistry` has a `walrus.<name>` record (local cluster).
- `WalrusStateRegistry` has an entry whose `systemObjectId` matches the current chain's deploy
  (local cluster) or the known live deployment.

### Restart behavior

- **Watch-fire selective restart.** If walrus is in the affected closure, the supervisor logs a
  heavy-infra warning `"Walrus — ~60s reboot expected"` (cite `src/engine/supervisor.ts:598`). The
  lifted-sibling architecture means the `walrus.image.upstream` and `walrus.move-source` members can
  each be in the affected closure independently — a watch fire on the move source alone re-builds
  the wrapper image without re-cargo-building the upstream.
- **Full restart (`r` keypress / SIGUSR2).** Cascades through every primitive in the stack. Walrus's
  `Layer.effectContext` body runs again; cached deploy state is reused (verify probe pass-through).
- **Warm restart (next `up`).** Cache verify probes for deploy, register-committee, and seed-wal all
  gate on `chainId`, on-chain object existence, and (for deploy) on-disk outputs. The combination
  means a warm restart against the same chain id reuses everything.
- **Idempotency edge cases.**
  - **Storage-node container adoption.** `Docker.run`'s adopt-if-image-matches keeps existing
    storage-node containers when the wrapper image tag didn't change. On cache miss (chainId changed
    or verify probe failed), `acquireLocalCluster` proactively `docker rm -f`s the predicted
    container names so the post-deploy `Docker.run` lands on the fresh-create branch (avoiding
    RocksDB integrity-check failures from a new chain over old node state) (`internal.ts:419-443`).
  - **Seed-WAL swap.** Cached by `(chainId, exchangeObjectId, accountAddress)`; verify confirms
    `chain.getTransaction(digest)` still resolves. Tradeoff: a manually-drained balance is not
    re-swapped (`internal.ts:794-806`).
  - **Exchange object missing.** If the cached `exchangeObject` no longer resolves on chain
    (regenesis without state-store wipe), the exchange resolution step degrades to `undefined` and
    downstream WAL faucet + seed-account funding silently skip; the user-facing error becomes a
    clean "no WAL strategy registered" at first funding (`deploy.ts:336-364`).

### Teardown

The cluster scope's finalizer chain (in LIFO order from the acquire):

1. `nodeStopScope` — `parallel` strategy. The N storage-node `docker stop --time 20` finalizers fire
   concurrently (`nodes.ts:109-110`). Net teardown ≈ 20s instead of 4 × 20 = 80s.
2. Each node's `markStopping(LOCAL_CLUSTER_KEY)` → `markStopped(LOCAL_CLUSTER_KEY)` engine row
   updates collapse onto the single `walrus.cluster` row (the last node wins for the final state)
   (`nodes.ts:175-191`).
3. The deploy one-shot's container is `--rm` by default (no finalizer to fire); the dir at
   `runtime/walrus/<name>/deploy/` persists across teardown.
4. The walrus docker network is cleaned by the per-scope `Docker.networkCreate` finalizer.

The supervisor's outer scope is forked with `'parallel'` strategy so the walrus, sui, seal, deepbook
scopes close concurrently (`supervisor.ts:1565-1593`). With 4 nodes at 20s grace each (collapsed by
the parallel stop scope to ~20s) and sui at 30s, walrus is usually NOT the long pole at shutdown.

What survives teardown:

- The `<cwd>/.devstack/stacks/<stack>/runtime/walrus/<name>/deploy/` output dir.
- The `StateStore` cache entries (`walrus/deploy-output`, `walrus/register-committee`,
  `walrus/seed-wal`).
- The wrapper docker image tag (`devstack-<name>.image:<hash>`).
- The upstream image tag.
- The walrus docker network (`Docker.networkCreate` is reuse-if-matching via the engine; only
  deleted on explicit wipe).
- The actual `docker volume`s if any (none today — storage uses container writable layer).

## Hard requirements / invariants

These are the load-bearing constraints — each is cited to file:line or to a test that asserts it.

### Topology / IP / network

1. **N storage nodes share a per-stack `/24` docker network with pinned IPs starting at
   `subnetPrefix.10`.** `WALRUS_LISTENING_IPS` passed to `walrus-deploy` MUST match what the
   storage-node containers actually `--ip` pin to — the on-chain committee record's bind addresses
   are derived from `--listening-ips`, and a mismatch breaks committee communication. Cite
   `internal.ts:113, 171-174` and `nodes.ts:114`.
2. **Per-stack docker network name must include the stack dimension when `stack != 'main'`.**
   Without the stack dimension, two parallel stacks of the same app collide on the docker network
   and `network create` adopts the sibling's network (with its sibling's subnet), failing downstream
   with
   `invalid config for network walrus-…-net: no configured subnet contains IP address 10.X.0.10`.
   Cite `internal.ts:296-305`.
3. **Per-stack /24 is hashed off `<app, stack, "walrus">`, in the range `10.[16..250].0/24`.**
   Avoids collision with `docker0` defaults (172.17.0.0/16), corp VPN ranges (`10.0.*`), and
   broadcast (`10.255.*`). Cite `internal.ts:118-128`.
4. **Storage nodes must dual-home onto the per-stack sui docker network for faucet DNS to resolve.**
   Each node's primary network is the walrus network (where the pinned `--ip` lives); the post-run
   `Docker.networkConnect(suiNetwork, …)` is what gives `WALRUS_FAUCET_URL`
   (`http://sui-localnet:9123/v1/gas`) a working hostname. The `run.sh` script `getent hosts`-loops
   the faucet hostname for up to 30s to absorb the attach race (`run.sh:82-98`). Cite
   `nodes.ts:215-228`.

### Deploy / fingerprint / cache

5. **Deploy cache key folds `chainId`.** A regenesis invalidates the deploy cache cleanly. Cite
   `internal.ts:351-352, 718-720`.
6. **Deploy cache verify must check BOTH the on-disk `deploy` file AND on-chain object existence
   (system + staking).** Each can go missing independently — the on-disk side from a partial
   snapshot restore or manual `rm -rf runtime/`, the on-chain side from a regenesis without
   state-store wipe. Either failure invalidates the cache and forces a re-deploy. Cite
   `internal.ts:371-414`.
7. **`runtime/walrus/<name>/deploy/` MUST ride the snapshot tar.** The directory holds storage-node
   private keys + per-node configs that `walrus-deploy` wrote; without them, a state-store entry
   that says "walrus is already deployed" cannot be honoured on resume. The `acquireLocalCluster`'s
   verify probe detects the absence and invalidates, but the snapshot system pre-emptively
   guarantees both pieces travel together by tarring the entire `runtime/` dir. Cite
   `engine/snapshot.ts:14-23` and the test `engine/snapshot.test.ts:285-335` ("walrus deploy outputs
   (multiple instances) ride the runtime tar verbatim").
8. **`WALRUS_PUBLIC_HOSTS` must match the public hostnames per node.** These are what each node
   registers as its on-chain `network_address`. `routerHostname(identity, 'walrus-node-' + i)` is
   the canonical builder; for main stack it produces `walrus-node-<i>.<app>.localhost`, for non-main
   `<stack>.walrus-node-<i>.<app>.localhost`. Two parallel stacks of the same app advertise disjoint
   hostnames and never trample each other's on-chain committee record. Cite `deploy.ts:155-164` and
   the assertions in `walrus.test.ts:52-87`.
9. **`WALRUS_REST_API_PORT` is the SAME for every stack now (9185).** The on-chain `public_port`
   value matches the global router entrypoint port; the router dispatches by `Host:` header to the
   per-stack backend. Cite `internal.ts:81-87, deploy.ts:196-199`.
10. **Deploy summary file must contain `package_id`, `system_object`, and `staking_object`.**
    Missing any of the three fails the parse with `WalrusError{phase: 'deploy'}`. Cite
    `deploy.ts:284-301`.
11. **`shards >= nodeCount`.** Asserted synchronously at factory time (`local-cluster.ts:119-121`)
    AND inside `deploy.sh:77-80`.

### Fork mode

12. **`walrusLocalCluster()` MUST refuse `*-fork` networks at factory time.** sui-fork doesn't
    expose JSON-RPC; the local cluster needs it via upstream walrus's `DualClient`. Letting the
    supervisor partway through the image build before the storage nodes fail to dial would be
    confusing. The `ForkIncompatibleError` carries an actionable `hint` pointing at `Walrus()` or
    `walrusKnownDeployment({network: '<stripped>'})`. Cite `local-cluster.ts:88-114` and the test
    `walrus.fork-localcluster-refused.test.ts` (4 tests).
13. **`Walrus()` on `*-fork` MUST auto-route to known-deployment with the wrapped upstream's
    `KnownNetwork`.** `resolveDeploymentNetwork(network)` handles the translation. Cite
    `walrus.ts:244` and `known-deployments.ts:58-65`.

### Tag layering

14. **`walrusKnownDeployment` MUST NOT publish `WalrusAdminTag`.** Any code that yields
    `WalrusAdminTag` against a known-deployment composition fails at runtime — but the type system
    stops most call sites from compiling against testnet/mainnet. Cite the asymmetric
    `Layer.succeed` set (`known-deployment.ts:104-115`, with no admin layer) and the test
    `walrus.test.ts:121-141` ("does NOT provide WalrusAdminTag").
15. **`walrusKnownDeployment` MUST publish `WalrusProxyTag` only when all three URLs are present.**
    Without any URLs the consumer can't talk to walrus; surfacing empty-string URLs would 404 at the
    first blob op. Cite `known-deployment.ts:101-112`.
16. **`walrusKnownDeployment` MUST throw synchronously when `nodes` is missing for a registered
    network.** Testnet has 100+ nodes that the `@mysten/walrus` SDK fetches dynamically; pinning
    them statically would be misleading and silently break callers. The factory throws so
    misconfiguration surfaces at the call site, not at deferred Layer.build time. Cite
    `known-deployment.ts:70-77` and the test `walrus.test.ts:166-174`.

### Lifted-sibling / topology

17. **`walrusLocalCluster` MUST declare `__upstreamKeys` and `__extraMembers` so the topo scheduler
    can build `walrus.image.upstream` and `walrus.move-source` in parallel with sui's boot.**
    Pre-Phase-D, folding the inner tags into the composite's `__layers` slice meant they only
    started building once the composite's level was reached — sui + walrus serialised in practice.
    The lift adds level-0 leaves to the dep graph. Cite `local-cluster.ts:302-349`.
18. **`__layers` MUST contain only the primary combined layer, NOT the lifted siblings.** Without
    this slimming, the composite would double-build its inner tags (once at its own level, once at
    level 0 via the lift); Effect's MemoMap would dedupe at runtime but the topo scheduler would
    still account for them twice. Cite `local-cluster.ts:336-343`.
19. **Two `Walrus()` instances sharing a single lifted sibling must dedupe by key.** The
    duplicate-key guard in `composeStackLayer` collapses two composites that lifted the same
    `gitFetch` upstream first-wins (silently — the warning fires only for user-authored top-level
    collisions). Cite `supervisor.ts:1056-1102`.

### Engine lifecycle

20. **All 4 storage-node stop finalizers MUST route their TUI events to `LOCAL_CLUSTER_KEY`.**
    Without an explicit pass-through, the fallback creates 4 phantom `walrus-walrus-node-N` rows in
    the TUI's "Other" section AND leaves the real `walrus.cluster` row stuck on `ready` through
    teardown. The last node's `markStopped` wins so the row's final state matches the actual
    container set. Cite `nodes.ts:175-191` and the matching comment on the `engineTagKey` param.
21. **`StopFinalizerScope` MUST be a forked parallel scope so node `docker stop`s fire
    concurrently.** Serial firing would mean `4 × 20s = 80s` teardown; parallel collapses to
    `max(grace) ≈ 20s`. Cite `nodes.ts:99-110, 271-273`.
22. **`stopGraceSeconds: 20`.** Storage nodes maintain RocksDB-backed state at
    `/var/walrus/storage`; need >10s to flush and checkpoint on `docker stop`. Without enough grace
    they get SIGKILL'd and the next start runs RocksDB log-replay before serving. Cite
    `nodes.ts:170-174`.

### Image / version pinning

23. **`DEFAULT_WALRUS_REF` and `DEFAULT_WALRUS_MOVE_SUBDIR` MUST be bumped together.** The cargo
    build and the Move package must agree on the on-chain types they emit. The Move source directory
    moved from `move/walrus` to `contracts/walrus` around v1.20+ — the default reflects that. Cite
    `internal.ts:55-68`.
24. **`DEFAULT_SUI_VERSION` (the wrapper-baked sui binary) MUST be aligned with the localnet image's
    sui release.** Otherwise the admin-wallet bytecode is mutually incompatible. Cite
    `internal.ts:69-74`.
25. **The wrapper image MUST use `ubuntu:24.04`, not `debian:bookworm-slim`.** The wrapper layer
    bakes a sui binary linked against glibc 2.38; bookworm ships glibc 2.36 and fails. The walrus
    binaries built on `rust-1.93-bookworm` run fine on ubuntu:24.04 because glibc is
    forward-compatible. Cite `images/walrus/upstream.Dockerfile:63-77`.

### Container scripting

26. **`run.sh` MUST relocate per-node sui keystore + yamls out of `/opt/walrus/outputs`.** On macOS
    Docker, osxfs / gRPC-fuse returns ENOTSUP for keystore lock/write ops the sui SDK performs
    during tx signing. Relocating to `/root/*` (writable layer) sidesteps it. Cite
    `images/walrus/run.sh:8-15, 35-44`.
27. **`run.sh` MUST `getent hosts <faucet host>`-loop before the first faucet call.** The supervisor
    attaches the storage node to the sui network AFTER `docker run` returns; that attach races with
    the script's first `sui client faucet` call. Without the wait, the very first call NXDOMAINs and
    exits 1. Cite `images/walrus/run.sh:82-98`.
28. **`deploy.sh` MUST `tls.disable_tls: true`.** Workaround for axum-server 0.8.0 panic on
    arm64-darwin self-signed TLS handshake. Plain HTTP between nodes is fine inside the docker
    network — Traefik on `devstack-router` terminates host-facing access. Cite
    `images/walrus/deploy.sh:212-240`.
29. **`deploy.sh` MUST rebind `rest_api_address` and `metrics_address` to `0.0.0.0:`.** Storage
    nodes must listen on every interface (walrus-net, devstack-router, sui per-stack net), not only
    the walrus-net pinned IP. The on-chain `public_host` / `public_port` stays the routable
    hostname; only the bind changes. Cite `images/walrus/deploy.sh:222-231`.

## Failure modes

| Trigger                                                      | Current behavior                                                                                                                                                                                                                                                          | Recovery path                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Wrapper image build fails                                    | `WalrusError{phase: 'image', message: 'walrus.image: failed to build wrapper …', cause: DockerError}` (`image.ts:50-58`).                                                                                                                                                 | Inspect docker build output via supervisor log; fix Dockerfile / pin / base image.                                                    |
| Docker network create fails                                  | `WalrusError{phase: 'network', message: 'walrus.network: failed to create '<name>': …'}` (`internal.ts:306-316`). Common cause: parallel-stack collision when the stack dimension is missing from the name.                                                               | Verify stack name; check sibling docker networks via `docker network ls`.                                                             |
| Deploy script exits non-zero                                 | `WalrusError{phase: 'deploy', message: 'walrus.deploy: deploy script exited <N>', stderr, stdout, exitCode}` (`deploy.ts:240-250`).                                                                                                                                       | Read captured stderr/stdout; set `DEVSTACK_KEEP_ONESHOT=1` to inspect the container post-mortem.                                      |
| Deploy summary file missing required field                   | `WalrusError{phase: 'deploy', message: 'walrus.deploy: deploy file missing one of {package_id, system_object, staking_object}'}` (`deploy.ts:285-301`).                                                                                                                   | Inspect raw `<runtime>/walrus/<name>/deploy/deploy` file; check `walrus-deploy` upstream changes.                                     |
| Cached `systemObject` / `stakingObject` missing on chain     | Warning logged, cache invalidated, re-deploy on next cycle (`internal.ts:405-412`).                                                                                                                                                                                       | Automatic.                                                                                                                            |
| Cached `exchangeObject` missing on chain                     | Warning logged via `Effect.logWarning`, exchange resolution degrades to `undefined`; WAL faucet strategy + seed-account funding are silently skipped (`deploy.ts:336-364`). Downstream `Account({funding: {WAL: …}})` then fails with "no strategy registered for 'WAL'". | Wipe state store entry or re-deploy; or accept the degraded state for non-WAL-funding workloads.                                      |
| Storage node fails to start (`DockerError`)                  | `WalrusError{phase: 'nodes', message: 'walrus.nodes: failed to start storage node <i>: …', cause}` (`nodes.ts:192-200`).                                                                                                                                                  | Read captured docker logs via supervisor; check pinned IP collision; check network exists.                                            |
| Storage node fails ready probe within `readyTimeoutMs`       | `WalrusError{phase: 'nodes', message: 'walrus.nodes: storage node <i> never became ready: …', stderr: cause.detail}` (`nodes.ts:201-209, 247-256`).                                                                                                                       | Tail `[walrus.node-<i>]` lines; inspect node container with `docker exec`.                                                            |
| Sui network attach for a storage node fails                  | `WalrusError{phase: 'nodes', message: 'walrus.nodes: failed to attach storage node <i> to sui network …'}` (`nodes.ts:216-228`).                                                                                                                                          | Verify sui network exists; check sui primitive booted correctly.                                                                      |
| Exchange `getObject` returns an unexpected type              | `WalrusError{phase: 'exchange', message: 'walrus.exchange: unexpected exchange object type "<type>" — expected "<pkg>::wal_exchange::Exchange"'}` (`deploy.ts:367-377`).                                                                                                  | Check upstream walrus's `--with-wal-exchange` behaviour; bump `DEFAULT_WALRUS_REF`.                                                   |
| `nodes.length === 0` at proxy pick                           | `WalrusError{phase: 'proxy', message: 'walrus: at least one storage node is required'}` (`internal.ts:553-560`). Unreachable in practice — synchronous factory-time guard catches `nodeCount < 1` first.                                                                  | Set `nodeCount >= 1`.                                                                                                                 |
| `seedWal({address})` against an unregistered address         | `WalrusError{phase: 'seed', message: 'walrusAdmin.seedWal: address \'<addr>\' is not registered as a seed account …'}` (`internal.ts:678-689`).                                                                                                                           | Add the address to `seedAccounts` at factory time.                                                                                    |
| `seedWal` called when exchange is undefined                  | `WalrusError{phase: 'seed', message: 'walrusAdmin.seedWal: no exchange object available (deploy ran without --with-wal-exchange)'}` (`internal.ts:669-678`).                                                                                                              | Re-deploy with the exchange enabled (which is default — devstack passes `--with-wal-exchange` unconditionally in `deploy.sh:200`).    |
| Seed-WAL swap fails                                          | `WalrusError{phase: 'seed', message: 'walrus.seedAccounts: swap failed for \'<name>\': …', cause}` (`internal.ts:862-870`).                                                                                                                                               | Inspect tx; check signer SUI balance; tweak `seedPaymentMist`.                                                                        |
| `walrusLocalCluster()` composed on `*-fork`                  | Synchronous `ForkIncompatibleError{variant: 'walrusLocalCluster', network, hint}` (`local-cluster.ts:101-114`).                                                                                                                                                           | Replace `walrusLocalCluster()` with `Walrus()` (auto-routes to known-deployment) or `walrusKnownDeployment({network: '<stripped>'})`. |
| `walrusKnownDeployment({})` (no network, no required fields) | Synchronous `Error('walrusKnownDeployment: `systemObjectId` is required …')` (`known-deployment.ts:52-57`).                                                                                                                                                               | Pass `network` or all three required fields explicitly.                                                                               |
| `walrusKnownDeployment({network: 'testnet'})` (no `nodes`)   | Synchronous `Error('walrusKnownDeployment: Walrus testnet committee has 100+ nodes …')` (`known-deployment.ts:70-77`).                                                                                                                                                    | Pass explicit `nodes` array or use `walrusLocalCluster()` for local testing.                                                          |
| `nodeCount < 1` or `shards < nodeCount`                      | Synchronous `Error('walrusLocalCluster: …')` (`local-cluster.ts:116-121`).                                                                                                                                                                                                | Fix the options.                                                                                                                      |
| Move source `gitFetch` fails                                 | Surfaces as the `LayeredTag<moveSource>` failure cause; not wrapped as `WalrusError`.                                                                                                                                                                                     | Network connectivity / git ref.                                                                                                       |

## Persistence model

### Survives restart (state-store + on-disk)

State-store entries under `.devstack/stacks/<stack>/state.json`:

- `walrus/deploy-output/<chainId>` — full `CachedDeployState`. Lets a warm restart reuse the deploy
  without re-running the one-shot.
- `walrus/register-committee/v1/<chainId>` — currently `null` (placeholder).
- `walrus/seed-wal/<chainId>/<exchangeObjectId>/<accountAddress>` — per swap receipt
  (`{digest, paymentMist, seededAt}`). Lets a warm restart skip re-swapping accounts that already
  swapped.

On-disk under `.devstack/stacks/<stack>/runtime/walrus/<name>/deploy/`:

- `deploy` — the parsed summary.
- `dryrun-node-<i>.yaml` — per-node config.
- `dryrun-node-<i>.keystore` — per-node sui keystore (storage-node signing material). Mode `0o600`.
- `dryrun-node-<i>-sui.yaml` — per-node sui client config.
- `sui_admin.yaml` + `sui_admin.keystore` — admin wallet.

Docker artifacts:

- The upstream image tag and the wrapper image tag (content-addressed — reused as long as inputs
  don't change).
- The per-stack walrus docker network (`Docker.networkCreate` reuse-if-matching).
- The N storage-node containers (adopted by `Docker.run`'s reuse path when name + image match).

### Survives snapshot

The `runtime/walrus/<name>/deploy/` directory is part of `runtime.tar`
(`snapshot.ts:14-23, 465-479`).

The state-store entries (`walrus/deploy-output/...`, `walrus/seed-wal/...`) ride in the `state.json`
capture (`snapshot.ts:452-463`).

Container state: storage-node RocksDB lives in the container writable layer at
`/var/walrus/storage`. If the storage-node containers are included in `opts.containers`,
`docker commit` + `docker save` would capture this; otherwise, on restore the storage nodes
re-replay checkpoint history from chain — generally fine for the chunks of state walrus keeps.

The wrapper docker image (`devstack-<name>.image:<hash>`) is reproducible from the deterministic
inputs (content-hashed), so snapshots don't need to bundle it as long as the chain-side artifacts
(`runtime/...`) align.

### Wiped on `devstack wipe`

OPEN QUESTION: the exact wipe path for `runtime/walrus/` and the state-store walrus entries isn't
documented here — the wipe behaviour is owned by the snapshot/lifecycle component. From the
snapshot.ts header comment, `runtime/` is the canonical service-owned state dir, so a wipe that
wipes `.devstack/stacks/<stack>/` clears it.

### Process-local only

- The four `Context.Service` tag values (`WalrusNetwork`, `WalrusNodes`, `WalrusProxy`,
  `WalrusAdmin`) are reconstructed every cycle from the acquire state. They don't persist.
- The TUI engine row state (`markAcquiring` / `markReady` / `markStopping` / `markStopped`).
- The OpenTelemetry spans + `EngineHandle.appendLog` lines.

## Modes & variants

The walrus component has four distinct operating modes. The dimensions below are the lifecycle /
capability dimensions a downstream architect needs to know about. Each cell is addressed explicitly;
`same` is only used where the behaviour is genuinely identical.

| Dimension              | `local` (localnet)                                                                                                                                                                                                     | `live` (testnet/mainnet)                                                                                                                                               | `fork-known` (`*-fork`)                                                                                                                                                      | `fork-localcluster-refused`                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Selected by            | `Walrus()` when `DEVSTACK_NETWORK === 'localnet'`; or explicit `walrusLocalCluster(opts)`                                                                                                                              | `Walrus()` when `DEVSTACK_NETWORK === 'testnet' \| 'mainnet'`; or explicit `walrusKnownDeployment({network})`                                                          | `Walrus()` when `DEVSTACK_NETWORK ∈ {'mainnet-fork', 'testnet-fork', 'devnet-fork'}` — auto-routes via `resolveDeploymentNetwork(network)` to live's known-deployment record | Explicit `walrusLocalCluster()` composition on `DEVSTACK_NETWORK === '*-fork'`    |
| Factory entry          | `walrusLocalCluster` (`local-cluster.ts:78-350`)                                                                                                                                                                       | `walrusKnownDeployment` (`known-deployment.ts:35-133`)                                                                                                                 | `walrusKnownDeployment` (same factory; `walrus.ts:244-247` translates `*-fork` → upstream `KnownNetwork`)                                                                    | Synchronous `throw new ForkIncompatibleError(...)` — no factory body executes     |
| Engine row key         | `LOCAL_CLUSTER_KEY = 'walrusLocalCluster'` (`internal.ts:202`)                                                                                                                                                         | `KNOWN_DEPLOYMENT_KEY = 'walrusKnownDeployment'` (`known-deployment.ts:33`)                                                                                            | `KNOWN_DEPLOYMENT_KEY = 'walrusKnownDeployment'`                                                                                                                             | n/a — throws synchronously                                                        |
| Containers             | 1 short-lived deploy one-shot (`walrus-<name>-deploy`) + N persistent storage nodes (`walrus-<name>-node-<i>` for `i ∈ [0..nodeCount)`)                                                                                | None                                                                                                                                                                   | None                                                                                                                                                                         | None — never reaches container phase                                              |
| Docker network         | One per-stack `/24`: `walrus-<name>-net` (main) or `walrus-<app>-<stack>-<name>-net[-<network>]`                                                                                                                       | None                                                                                                                                                                   | None                                                                                                                                                                         | n/a                                                                               |
| Provided tags          | `WalrusNetworkTag` + `WalrusNodesTag` + `WalrusProxyTag` + `WalrusAdminTag` (4 of 4)                                                                                                                                   | `WalrusNetworkTag` + `WalrusNodesTag` + `WalrusProxyTag` (when all three URLs present); no `WalrusAdminTag`                                                            | Same as `live` — 3 of 4 tags (no admin)                                                                                                                                      | n/a                                                                               |
| Required deps consumed | `SuiTag`, `Identity`, `EngineHandle` (optional), `StateStore`, `ChainProbe`, `FileSystem`, `ChildProcessSpawner`, `FaucetTag` (optional), seed account tags                                                            | None at acquire time; `WalrusStateRegistry` writer needed at layer-publish                                                                                             | Same as `live` (the wrapped sui fork is the underlying `SuiTag` provider, but the walrus side reads no sui at acquire)                                                       | n/a                                                                               |
| Lifted siblings        | `walrus.image.upstream` (`dockerImage`) + optional `<name>.move-source` (`gitFetch`)                                                                                                                                   | None                                                                                                                                                                   | None                                                                                                                                                                         | n/a                                                                               |
| Startup sequence       | 8 phases: image → network → deploy → register-committee → start-nodes → exchange → proxy-pick → registries-publish (cite `internal.ts:228-643`)                                                                        | Single synchronous factory body: lookup → schema check → build `Layer.succeed(...)` tags → emit `publishWalrusState` discard layer (cite `known-deployment.ts:35-133`) | Same as `live`                                                                                                                                                               | Throws at `walrusLocalCluster()` invocation, before any composition               |
| Ready criteria         | `withCache` deploy hit (or `deployContracts` success) AND all N nodes pass router-fronted TCP probe at `:9185`                                                                                                         | Synchronous factory return — known immediately. `Layer.succeed(...)` resolves trivially.                                                                               | Same as `live`                                                                                                                                                               | n/a                                                                               |
| Persistence            | `walrus/deploy-output/<chainId>` + `walrus/seed-wal/...` state-store entries; `runtime/walrus/<name>/deploy/` on-disk; wrapper image tag; docker network; N container writable layers (RocksDB)                        | None (config-only)                                                                                                                                                     | None                                                                                                                                                                         | n/a                                                                               |
| Teardown               | Parallel `docker stop --time 20` for all N nodes via forked parallel `nodeStopScope`; all node finalizers route engine events to `LOCAL_CLUSTER_KEY` row                                                               | No-op                                                                                                                                                                  | No-op                                                                                                                                                                        | n/a                                                                               |
| Hard requirements      | Items 1–11, 17–22, 26–29 from the "Hard requirements" section above (topology, deploy fingerprint, lifted siblings, engine lifecycle, container scripts)                                                               | Items 14–16, 23–25 (tag layering, image pinning for the SDK side)                                                                                                      | Items 13–16 (auto-route + tag layering)                                                                                                                                      | Item 12 (fork-incompat refusal)                                                   |
| Failure modes          | Image build / network create / deploy script / deploy parse / storage node start / readiness / sui attach / exchange parse / seed-wal swap — all wrapped in `WalrusError` with a `WalrusPhases`-literal phase tag      | Synchronous `Error` throws for missing required fields (no `WalrusError` since no async lifecycle)                                                                     | Same as `live`                                                                                                                                                               | Synchronous `ForkIncompatibleError{variant: 'walrusLocalCluster', network, hint}` |
| Deploy semantics       | Runs the full `walrus-deploy deploy-system-contract` Move publish on the local sui chain via the deploy one-shot. Mints WAL exchange. Generates per-node dryrun configs.                                               | No deploy — the on-chain `system_object` is the real testnet/mainnet system.                                                                                           | Same as `live` — reads the wrapped upstream's known deployment, never deploys.                                                                                               | n/a                                                                               |
| Fingerprint behavior   | Cache key `walrus/deploy-output/<chainId>` folds the live chain id; verify probe checks on-chain + on-disk together; either failure forces re-deploy. The cached blob is the _fingerprint_ (in the snapshot.ts sense). | Not applicable — no deploy, no fingerprint. The known-deployment values are static and verified out-of-band via `INTEGRITY` comments in `engine/known-deployments.ts`. | Same as `live`                                                                                                                                                               | n/a                                                                               |
| Endpoints published    | `walrus-aggregator`, `walrus-publisher`, `walrus-node-<i>` (× N)                                                                                                                                                       | None                                                                                                                                                                   | None                                                                                                                                                                         | n/a                                                                               |
| Registry writes        | `PackageRegistry` (`walrus.<name>`), `WalrusStateRegistry` (`{name: <opts.name>, systemObjectId}`), `EndpointRegistry` (3 + N entries)                                                                                 | `WalrusStateRegistry` (`{name: 'walrusKnownDeployment', systemObjectId}`) only                                                                                         | Same as `live`                                                                                                                                                               | n/a                                                                               |
| TUI behaviour          | One `walrus.cluster` row with phase narration (`building image` → `deploying contracts` → `registering nodes` → `starting nodes`); `primary = proxyUrl`, `extras = ['N nodes']`                                        | Engine row exists but is quick to `ready` — no phase narration (synchronous body). `displayTitle: walrus.<network>`                                                    | Same as `live` (`displayTitle: walrus.<KnownNetwork>`)                                                                                                                       | n/a                                                                               |

## Test coverage

### `src/services/walrus.test.ts`

- `describe('walrus storage-node router hostnames')` — verifies the stack-scoped hostname pattern
  that walrus's deploy phase plugs into `WALRUS_PUBLIC_HOSTS` and that nodes register on chain.
  - `it('main stack — main-stack hostnames omit the stack prefix')` — asserts
    `routerHostname({app:'private-content', stack:'main'}, 'walrus-node-0')` ⇒
    `'walrus-node-0.private-content.localhost'`.
  - `it('non-main stack — stack prefix isolates parallel committees')` — asserts
    `routerHostname({app:'arena', stack:'test'}, 'walrus-node-0')` ⇒
    `'test.walrus-node-0.arena.localhost'`. Two parallel stacks of the same app must produce
    disjoint hostnames.
  - `it('routerId composes the per-node label namespace')` — asserts
    `routerId({app:'private-content', stack:'main'}, 'walrus-node-0')` ⇒
    `'private-content-main-walrus-node-0'`. Pins the Traefik label namespace so two parallel stacks
    don't overwrite each other's router config.
- `describe('walrusKnownDeployment')`:
  - `it.effect('provides WalrusNetworkTag + WalrusNodesTag from a network lookup with explicit nodes')`
    — calls `walrusKnownDeployment({network:'testnet', nodes:[]})`, builds the member's layer,
    yields `WalrusNetworkTag` + `WalrusNodesTag` and checks the shape against
    `knownDeployments.walrus.testnet`. Also pins the SDK-ready `packageConfig` shape.
  - `it.effect('does NOT provide WalrusAdminTag')` — same factory call; yielding `WalrusAdminTag`
    produces a runtime resolution failure (`Exit.isFailure(exit)` true). Asserts the type-level
    admin omission is matched at runtime.
  - `it.effect('explicit systemObjectId overrides the network lookup')` — call with
    `{network:'testnet', systemObjectId:'0xCAFE', nodes:[]}`; asserts
    `network.systemObjectId === '0xCAFE'`.
  - `it('throws at factory time when neither network nor required fields are provided')` —
    `walrusKnownDeployment({})` throws synchronously with `/systemObjectId/` in the message.
  - `it('throws at factory time when nodes is not supplied for a registered network')` —
    `walrusKnownDeployment({network:'testnet'})` throws synchronously with `/committee/` in the
    message.
- Compile-time guard (`_walrusPackageConfigCheck`) — asserts
  `WalrusNetwork['packageConfig'] extends _ExpectedWalrusPackageConfig`
  (`{systemObjectId: string, stakingPoolId: string, exchangeIds?: string[]}`) at compile-time so the
  SDK contract doesn't silently drift.

### `src/services/walrus.fork-known.docker.test.ts`

- `describe.skipIf(!SHOULD_RUN)('services/walrus fork docker gate (P3.T3)')`:
  - `it('Walrus() on testnet-fork composes to walrusKnownDeployment(testnet); system-object read succeeds')`
    — gated behind `RUN_FORK_DOCKER_TESTS=1`. Currently a pending stub
    (`expect(SHOULD_RUN).toBe(true)`). Designed to read the real testnet Walrus system object via
    the fork's gRPC port to confirm the fork's seed-objects path pre-fetched it.

### `src/services/walrus.fork-localcluster-refused.test.ts`

- `describe('Phase 3 P3.T4 — walrusLocalCluster refused under fork mode')`:
  - `it('throws ForkIncompatibleError on mainnet-fork')` —
    `process.env.DEVSTACK_NETWORK = 'mainnet-fork'`; calls `walrusLocalCluster()`; expects
    `ForkIncompatibleError` with `variant === 'walrusLocalCluster'`, `network === 'mainnet-fork'`,
    `message` matching `/sui-fork does not expose/`, `hint` matching
    `/Walrus\(\) or walrusKnownDeployment/` and `'mainnet'`.
  - `it('throws ForkIncompatibleError on testnet-fork with the testnet recipe')` — same as above for
    `testnet-fork`; asserts hint mentions `'testnet'`.
  - `it('throws ForkIncompatibleError on devnet-fork')` — same as above for `devnet-fork`.
  - `it('does NOT throw on localnet (the variant the local cluster targets)')` — sets
    `DEVSTACK_NETWORK = 'localnet'`; asserts that any thrown error is NOT a `ForkIncompatibleError`
    (other errors like missing signer are out of scope here).

### Cross-component tests that touch walrus

These are NOT in the walrus doc scope (they belong to other components' docs) but are listed here
for the encoded-spec cross-reference:

- `src/runtime/service.test.ts:97-127` — `gatherManifest` test seeds the `WalrusStateRegistry` +
  endpoint registry and asserts that `ds.services.walrus` equals
  `{aggregator: {url: '…:9185'}, publisher: {url: '…:9186'}}`. Indirectly pins the
  `walrusProjection` schema.
- `src/engine/snapshot.test.ts:231-283` — asserts that `runtime/walrus/main/deploy/deploy` rides the
  runtime tar.
- `src/engine/snapshot.test.ts:285-335` — asserts that multiple walrus instances' (`'main'`,
  `'alt'`) deploy outputs ride the tar with mode bits preserved.
- `src/engine/dep-graph.test.ts:120-202` — uses walrus as a node in a fake dep graph to exercise the
  closure / topo-level computation.
- `src/engine/scheduler.test.ts:135-171` — uses a walrus-shaped tag in a diamond-dep scheduler test.
- `src/services/faucet/strategies/wal-exchange.test.ts` — unit-level coverage of the WAL faucet
  strategy (3 tests: default-payment dispatch, non-zero-amount honour, sign-failure-wrapping).
- `src/codegen/emitters/*.test.ts` — six tests load `WalrusStateRegistryLive` to satisfy the
  manifest pipeline (no walrus-specific assertions).

## Pain points today

1. **`acquireLocalCluster` is monolithic.** 432 lines of imperative orchestration with eight phases.
   The split-out per-phase files (`image.ts`, `deploy.ts`, `nodes.ts`) sliced the bodies but
   `internal.ts` still owns the orchestration AND the seed-wal + admin-shape + register-committee
   logic. Cite `internal.ts:211-644`.
2. **Vendored shell scripts (`deploy.sh`, `run.sh`) are load-bearing but live in `images/walrus/`.**
   Bash is opaque to type-checking; environment-variable contracts between TypeScript and bash are
   only enforced by comments. Five known "sed patches against the upstream version" were the
   explicit reason for the in-tree fork (`run.sh:3-6`).
3. **`registerCommittee` is a typed no-op that's been pre-wired for future work that may never
   land.** The `withCache` block with `produce: return null` and `verify: Effect.succeed(cached)`
   adds 30 LOC of plumbing for a phase that does nothing today. Cite `internal.ts:711-747`.
4. **The lifted-sibling architecture leaks into the return shape.** The composite must hand-roll
   `__layer` / `__layers` / `__extraMembers` / `__upstreamKeys` because `Layer.effectContext`
   doesn't compose with `tag()`/`provide()`'s lifted-sibling helpers. The comment at
   `local-cluster.ts:302-349` is 47 lines documenting the workaround.
5. **`run.sh`'s post-attach race with the supervisor's `Docker.networkConnect` requires a 30-second
   `getent hosts` loop.** The supervisor's container start ordering and post-run network attach
   aren't atomic, so the script absorbs the race. Cite `run.sh:82-98`.
6. **`waitForCommittee` is a typed no-op (`Effect.void`).** The `WalrusAdmin` contract surfaces it
   but the per-node readiness probes already happened in phase 4, so there's nothing to wait for.
   Future work could tighten to a quorum-status check. Cite `internal.ts:660-666`.
7. **The exchange-object resolution probes by `getObject` rather than by typed accessor.** Despite
   the rest of the deploy/seed flow migrating to `ChainProbe`, `resolveExchange` still uses
   `client.core.getObject({objectId})` and parses `.type` manually (`deploy.ts:332-377`). The
   comment at `internal.ts:879-893` says the typed accessor would help here too.
8. **`localnetWalrusOptions` is decoupled from the manifest but couples to a free-form cast.** The
   doc comment shows users coercing
   `captured as Record<string, {systemObject?: string; stakingObject?: string}>` and then
   dereferencing `'walrus.walrus'`. Cite `options.ts:10-22`. This is the "Codegen surface for
   Walrus" pain point.
9. **The `WalrusNodes` shape from `walrusLocalCluster` carries synthetic `nodeId` + empty
   `publicKey`.** The upstream `deploy-system-contract` only writes committee size + chain ids; the
   per-node BLS keys aren't surfaced anywhere we can read them. Cite `local-cluster.ts:260-274`.
10. **The WAL coin type can't be reconstructed from `walrusPackageId`.** A wholly separate `wal`
    package is published by `walrus-deploy`, but only the `walrus` system id is captured in the
    deploy output. The seed-wal cache had to switch from "probe balance" to "probe digest" to dodge
    the missing coin type. Cite the long comment at `internal.ts:794-806`.
11. **`Walrus()` produces no `WalrusAdminTag` on testnet/mainnet but the contract surfaces it on the
    type system without a "presence" flag.** Consumers reach for
    `Effect.serviceOption(WalrusAdminTag)` if they want to gracefully degrade, but the asymmetry is
    documented only in a comment, not in the type. Cite `walrus.ts:131-156, walrus/index.ts:1-15`.
12. **The factory ignores `opts.local` on non-localnet but doesn't warn.** A user who configures
    `Walrus({local: {nodeCount: 4}})` and then flips to testnet gets a silent no-op of all the local
    options.
13. **`deploy.ts` has a 36-line `makeOutputLineSink` plus a duplicate in `nodes.ts`.** Both wrap
    `EngineHandle.appendLog` with the same `DEVSTACK_LOG_LEVEL`-based filter; the only difference is
    the label. Cite `deploy.ts:53-65, nodes.ts:46-58`.
14. **The pinned `/24` collision-avoidance range `[16, 250]` is a hash output, not a leased
    resource.** Two stacks whose `(app, stack)` hash collide on the same octet will collide on the
    docker network too. The probability per cluster size is small but non-zero. Cite
    `internal.ts:118-128`.

## Open questions

1. **What invalidates the wrapper-image content hash on Move-source changes?** `buildWrapperImage`
   hashes `{context, dockerfile, buildArgs: {BASE_IMAGE, SUI_VERSION}}` — neither the local move
   source path nor the upstream Move sources are part of the inputs. Re-using the cached wrapper
   image after a Move source change would mean the container ships stale contracts. The deploy
   script does its own `WALRUS_CONTRACT_DIR` reset (`deploy.sh:84`) and the wrapper image bakes
   `/opt/walrus/contracts` from the upstream image which DOES vary on `WALRUS_VERSION`, so the path
   probably works — but this isn't asserted by a test.
2. **What does `devstack wipe` actually do to `runtime/walrus/<name>/` and the walrus state-store
   entries?** Owned by the snapshot / wipe doc, but the behaviour is referenced in the snapshot.ts
   header comment without an exact mapping.
3. **Are the `WALRUS_GC`, `WALRUS_CONTRACT_DIR`, `WALRUS_DEPLOY_BIN`, `WORKING_DIR` env vars in
   `deploy.sh` reachable from the TypeScript side?** `deployContracts` doesn't pass any of them.
   They have script-side defaults but no factory option exposes them. Cite `deploy.sh:42-51`.
4. **What happens on a re-deploy that mints NEW storage-node keys against a chain that already has
   registered nodes?** The comment at `internal.ts:362-371` says "Re-deploying on top of a chain
   that already has registered nodes mints NEW keys and breaks the committee". Today's verify probe
   catches the missing on-chain object case, but the "deploy outputs lost on host, chain still
   healthy" case is documented as the messy edge.
5. **The pinned `seedPaymentMist` default (`500_000_000n` = 0.5 SUI) produces an unspecified amount
   of WAL.** The WAL exchange rate isn't captured anywhere in the contract. A consumer expecting
   "fund my account with N WAL" has to pre-compute the SUI MIST amount.
6. **The fork-known.docker.test is pending.** The test body is `expect(SHOULD_RUN).toBe(true)`,
   gated behind `RUN_FORK_DOCKER_TESTS=1`. Was this intentionally left stubbed, or is there a wiring
   TODO?
7. **Multiple `Walrus({name})` instances and the snapshot test (`snapshot.test.ts:285-335`).** Two
   `Walrus()` instances in the same stack work per the snapshot test, but the doc / comments don't
   make the use case explicit. What's the intended user story for two parallel local clusters in one
   stack?
8. **`movePackagePath` is consumed only via a span annotation (`internal.ts:264`), never read in the
   deploy.** The doc comment says "the fetched value isn't consumed by the deploy one-shot today
   (the wrapper image embeds its own copy)". Is the option vestigial?

## Opportunities noticed

1. **Collapse `makeOutputLineSink` (`deploy.ts:53-65`) and the `makeNodeOutputSink`
   (`nodes.ts:46-58`) — they're byte-identical modulo the label.** Lift to a shared
   `engine/log-sink.ts` or to `engine/docker.ts` alongside the `OutputLineLevel` type so all
   docker-shelling primitives benefit.
2. **Move `WalrusError` phase tags (`WalrusPhases`) into a shape that the orchestrator can consume
   directly.** Today the orchestrator passes free-form phase strings to `pushPhase`
   (`'building image'`, `'deploying contracts'`, `'registering nodes'`, `'starting nodes'`) while
   the WalrusError carries a different closed set
   (`'image' | 'network' | 'deploy' | 'exchange' | 'nodes' | 'proxy' | 'seed'`). Two parallel
   vocabularies for the same lifecycle phases.
3. **Drop `registerCommittee` until per-node re-registration actually lands.** It's 37 lines of
   structural plumbing for a body that returns `null` and a verify that returns
   `Effect.succeed(cached)`. The future-proofing comment at `internal.ts:704-708` admits this; the
   "shape preserved as a `withCache` so the future fill-in is a body edit" is exactly the kind of
   cargo-culted abstraction the v3 rewrite is trying to shed.
4. **Surface the per-node BLS public keys.** Read the `staking_pool` object on chain after deploy to
   fill in `WalrusNodeInfo.publicKey` instead of returning empty strings. The comment at
   `local-cluster.ts:260-265` says "future work could read the `staking_pool` object" — substrate
   redesign should absorb this.
5. **Eagerly capture the wal package id in the deploy summary.** `walrus-deploy` publishes 4
   packages; only the `walrus` system id is in the deploy output. Capturing the `wal` package id
   directly would sidestep the entire seed-wal cache "probe by digest, not balance" workaround
   (`internal.ts:794-806`). Substrate redesign could negotiate this with upstream.
6. **The `runtime/walrus/<name>/deploy/` directory format is tightly coupled to the walrus-deploy
   binary's output.** A typed serde layer between the binary and the rest of devstack would make the
   deploy summary parser typed instead of regex-based and would surface format drift at the schema
   check, not at a missing-field WalrusError.
7. **The "snapshot tar must include the deploy outputs" invariant is asserted by tests but not by
   types.** A typed snapshot manifest that declared `runtime/walrus/*/deploy/` as a
   "required-for-resume" path set could prevent silent drift.
8. **The `walrusKnownDeployment` factory's "throw if no nodes" check is sensible but inconsistent
   with the runtime-fetch design of `@mysten/walrus`.** Architecture-design phase should decide: do
   we model the testnet/mainnet committee as a dynamic Effect resource (`Effect.cachedFunction` over
   the staking pool) or keep the throw?
9. **The `Walrus()` factory's option-pass-through (`opts.local`) is silently dropped on
   non-localnet.** Lifting the warning to a typed compile-time check ("only pass `local` when on
   localnet") via a discriminated union would catch the misconfiguration at the call site.
10. **The two `Walrus()` instances sharing-a-`gitFetch` warning suppression**
    (`supervisor.ts:1090-1095`) is a comment-only invariant. Substrate redesign should make this a
    typed property of the lifted-sibling protocol so a missing-from-tree composite that lifted the
    same sibling can't accidentally trip a false-positive warning.
11. **The walrus `LOCAL_CLUSTER_KEY = 'walrusLocalCluster'` is a magic string referenced in three
    places.** `internal.ts:202`, `local-cluster.ts:47, 190-194, 200, 234`, `nodes.ts:88-89, 191`,
    `internal.ts:524`. A `WalrusEngineKey` constant or a tag-based key would tie this together.
12. **`buildWrapperImage`'s content hash is hand-rolled (`contentHash(inputs, {length: 12})`)**
    while `dockerImage(...)`'s upstream side gets the same treatment via the factory. The wrapper's
    hand-roll is a bypass because `BASE_IMAGE` is runtime-resolved; a follow-up that lets
    `dockerImage(...)` accept a runtime-resolved build arg would unify the two image-building paths.
13. **`Walrus()` exposes no override surface but `walrusKnownDeployment` on `/advanced` does.** The
    `/advanced` path is the user's escape hatch — the structural duplication between `Walrus()`'s
    fork-routing logic and the `walrusKnownDeployment` factory's field-merge logic could be unified.
14. **The router-fronted port number `9185` appears in three places**
    (`internal.ts:81-87, deploy.ts:99-107, nodes.ts:241-244`). One central `WALRUS_ROUTER_PORT`
    would reduce the number of places to update on a port change.
15. **The split between `services/walrus.ts` and `services/walrus/` is a transitional shape.** The
    outer file holds the four tag classes + factory, the inner directory holds the implementations.
    The architecture should pick one of: keep the split for tag-class visibility, or fold the tag
    classes into the implementation files.
