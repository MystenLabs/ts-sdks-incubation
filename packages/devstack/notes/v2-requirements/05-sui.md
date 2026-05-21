# sui

## Purpose

The `sui` component is devstack's facade over the Sui blockchain that user code consumes via
`yield* SuiTag`. It folds four entrypoint **modes** behind a single `Sui(opts?)` factory — three
first-class modes (**local**, **live**, **fork**) plus a degenerate "wrap an externally-managed RPC"
sub-mode for local — and a Move-build sub-system that drives `sui move build` against either the
host CLI or a per-stack long-lived in-container worker. It surfaces:

- A `SuiGrpcClient` (`@mysten/sui/grpc`) and its derived endpoints (`rpc` / `faucet` / `graphql`)
  shaped as devstack `Endpoint` records that carry both host and docker-DNS URLs.
- The `chainId` (checkpoint-0 digest) that downstream cache primitives fold into their state-store
  keys so on-chain artifacts re-derive when the chain underneath them is wiped.
- A `waitForTransactionsReady()` method that upgrades the supervisor's socket-level "ready" gate
  into a "funds-transferable" gate by POSTing a real funding tx against the localnet faucet.
- A fork-mode admin surface (`Sui.fork`) wrapping
  `ForkingServiceClient.{getStatus, advanceClock, advanceCheckpoint}`, an empty-signature
  impersonation helper, and an auto-tick clock fiber.
- A typed `ChainProbe` accessor over `client.core.{getObject, getTransaction}` that schema-validates
  the SDK's response shape so verify probes don't silently drift on renamed fields.
- A `Move` package build container and CLI driver capable of building Move source into BCS bytecode
  either on the host or inside the per-stack sui image, with a cross-process advisory lock guarding
  `~/.move/git/` and a stale-git-lock sweeper.

The component is the **most entangled** primitive in the codebase: it provisions docker networks,
postgres sidecars, sui-localnet validators, sui-fork containers, traefik router entries, host
file-locks, on-disk meta gates, image build pipelines, AND drives the Move build pipeline that other
primitives (Package, Coin, Account, Codegen) depend on. Total in-scope code: ~5,600 LOC under
`src/`, ~4,300 LOC under tests.

## Current implementation

File-by-file list, with LOC counts and one-line summaries. Grouped by sub-component.

### Sui service entrypoint

- `src/services/sui.ts` — **1995 LOC**. The `Sui(opts?)` factory + per-network builders
  (`buildLocalnet`, `buildTestnet`, `buildMainnet`, `buildCustom`, `buildFork`), the `SuiTag`
  `Context.Service`, the `Sui` / `ForkControl` / `ForkStatus` interfaces, the `forkGuard` Proxy
  (rejecting unsupported `client.core.*` methods at the JS-property level), the `buildForkControl`
  adapter, the `faucetReadyProbe` + `waitForTransactionsReady` retry pipeline, the localnet image /
  postgres-sidecar wiring, and the `__layers` composition that surfaces `SuiBuildImage` +
  `SuiBuildContainerLive` + `ChainProbeLive` alongside the service.
- `src/services/sui/impersonate.ts` — **196 LOC**. `executeImpersonated(client, sender, tx, opts?)`
  — builds a `Transaction` with the declared sender, stamps a default 0.1 SUI gas budget when none
  is set, BCS-serialises, and submits with empty signatures (the sui-fork executor branches into
  `simulacrum::execute_transaction_impersonating` on an empty `signatures: []` array —
  `crates/sui-fork/src/rpc/executor.rs:70`). Returns `ImpersonatedTxResponse` with digest + success
  bit.
- `src/services/known-package.ts` — **121 LOC** (boundary file — also referenced by other docs). The
  `KnownPackage(name, opts)` factory for declaring well-known on-chain packages (testnet deepbook,
  mainnet seal, etc.) without publishing. Holds the module-scope `accumulatedSeedObjects`
  `Set<string>` that `buildFork` reads at acquire time to union `KnownPackage`-declared
  `seedObjects` into the fork's `--object` seed flags. Exposes `collectKnownPackageSeedObjects()`
  (snapshot) + `clearKnownPackageSeedObjects()` (reset between composes). `services/sui.ts:1673`
  consumes this for the fork branch.

### Engine — CLI + build container

- `src/engine/sui-cli.ts` — **735 LOC**. The Effect-flavored thin wrapper around the `sui` CLI for
  Move publishing + building. Defines `SuiBuildImage`
  (`Context.Reference<{tag: string} | undefined>`, default `undefined`); the `SuiCliError`
  `TaggedErrorClass`; `buildMove(opts)` (three execution paths: long-lived container exec, fresh
  `docker run --rm`, host CLI); `containerBuildCmd` / `hostBuildCmd` argv builders; `runWithCapture`
  over `captureCommand`; `shellQuote` (POSIX single-quote escape); `extractTrailingJson` (last
  `{`-terminated chunk parser); `stripPinnedSections` (TOML `[pinned.<env>.<pkg>]` / legacy `[env]`
  / `[env.<name>]` section stripper); `scrubCachedMoveLocks` + `scrubMoveLock` (walk `~/.move/git/`
  removing pinned-env sections); `stripPinnedSectionsFromMoveLock` (package-scoped scrub climbing up
  to find `.devstack/imports/`); the stale-`.git/index.lock` hint appender (`STALE_GIT_LOCK_MARKER`,
  `STALE_GIT_LOCK_RECIPE`); `MAX_ERROR_DETAIL = 600` truncation; `cliEnv` (merges
  `inheritedHostEnv` + `SUI_FULLNODE_URL` / `SUI_FAUCET_URL`).
- `src/engine/sui-build-container.ts` — **718 LOC**. The `SuiBuildContainer` `Context.Service` +
  `SuiBuildContainerLive` `Layer.effect`. One long-lived
  `docker run -d --entrypoint sleep ... infinity` container per `(app, stack)` (container name
  `devstack-<app>-build`, intentionally network- and stack-agnostic — `containerNameFor(identity)`
  at line 122). Delegates adopt-vs-create state-machine to the shared
  `engine/docker/ensure-container.ts::ensureContainer` primitive (rejects the helper's default
  `recreate-on-resume-failed` policy so daemon outages surface loudly). Owns the cross-process
  move-build lock (`withMoveBuildLock`, `acquireMoveBuildLock`, `releaseMoveBuildLock`) keyed by
  `sha1(path.resolve(moveHome)).slice(0,16)` at `~/.devstack/locks/sui-move-build-<repoHash>.lock`
  with `MOVE_BUILD_LOCK_TIMEOUT_MS = 5 minutes`, base/max backoff 100ms/2s. Owns
  `sweepStaleGitLocks` (60s mtime safety window, exported for `cli/commands/doctor.ts` + `wipe.ts`).
  Defines `toContainerPath(appDir, hostPath)` translating host paths to `/host/<rel>` inside the
  container; returns `undefined` when `hostPath` escapes `appDir`. Surfaces `runBuild` +
  `runSummary` shells that `docker exec` into the container against the translated path, scrubbing
  Move.lock files inline via `gawk -i inplace -f /tmp/scrub-move-lock.awk` (HIGH-R5 hardening:
  `-type f` rejects symlinks; explicit `gawk` because Ubuntu's default `awk` is mawk which lacks
  `-i inplace`).
- `src/engine/sui-helpers.ts` — **317 LOC**. Allocation-free Move-type / object-change picker
  utilities. `pickCreatedByType(changes, filter)` with three filter shapes (`suffix` / `includes` /
  `prefix`) + `all: true` enumeration form returning `ReadonlyArray<CreatedObjectEntry>` with
  `(objectId, objectType, owner?)`. Address-form-agnostic `moveTypeStartsWith` / `moveTypeIncludes`
  / `moveTypeEndsWith` / `moveTypeEquals` via `normalizeStructTag` (handles `0x2` vs `0x0…0002`
  gRPC-long-form vs JSON-RPC short-form). `parseCoinTypeFromGeneric(objectType, wrapper)` extracts
  the inner coin type from `0x2::coin::TreasuryCap<...>` / `CoinMetadata<...>`; rejects nested
  generics.

### Engine — fork

- `src/engine/sui-fork/control.ts` — **299 LOC**. `resolveAutoTickIntervalMs(option?)` (default
  `DEFAULT_AUTO_TICK_INTERVAL_MS = 1000`);
  `resolveResumeAutoTickIntervalMs({option, savedAutoTickMs})` (fresh-option wins, saved value as
  fallback, corrupt saved values ignored); `runAutoTickClock({client, intervalMs})` forks a
  `Effect.forkScoped` fiber repeating `advanceClockOnce` on `Schedule.spaced(intervalMs)` (failure →
  log WARN + keep ticking — R9); `subscribeCheckpoints(client)` adapting the SDK's
  `subscriptionService.subscribeCheckpoints({})` server-streaming RPC to `Stream.fromAsyncIterable`;
  `pollCheckpoints(client, pollIntervalMs=2000)` with `Stream.mapAccum` cursor dedupe;
  `subscribeCheckpointsWithFallback(client, pollIntervalMs?=2000)` — subscription first, polling on
  stream error.
- `src/engine/sui-fork/file-lock.ts` — **64 LOC**. `acquireForkDataLock(lockPath)` — scope-bound
  `Effect.acquireRelease` over `tryClaimLockSync` from `engine/file-lock.ts` (the shared file-lock
  primitive). Maps lock-busy + lock-failure cases to `SuiError({phase: 'fork-lock'})` with a message
  naming the holder's `pid` / `host` / `instanceId` / `startedAt`. Refuses to start when another
  live supervisor holds the lock.
- `src/engine/sui-fork/meta.ts` — **301 LOC**. The on-disk `meta.json` config-hash gate at
  `.devstack/stacks/<stack>/sui-fork/meta.json`. Defines the `ForkMeta` Schema
  (`{version, createdAt, upstream, checkpoint?, seedAddresses, seedObjects, configHash, runtime?: {autoTickMs?}}`).
  `computeConfigHash(input)` produces a stable digest over
  `(upstream, checkpoint, sorted+lowercased seedAddresses, sorted+lowercased seedObjects)` via
  `contentHash` length 16. `resolveForkMetaPath(stack, appDir?)` /
  `resolveForkDataDir(stack, appDir?)`. `readForkMeta(metaPath)` (treats missing or corrupt as
  `undefined`). `writeForkMeta` via `writeFileAtomicIfChanged`.
  `ensureForkMetaConsistent({metaPath, current, runtime?})` — three outcomes: first boot (write
  fresh), resume with matching configHash (no-op or runtime refresh), mismatch (raise
  `SeedManifestMismatchError` with previous/current snapshots).
- `src/engine/sui-fork/cache-inventory.ts` — **98 LOC**. Read-side inventory of the shared
  `.devstack/sui-fork-cache/` cache directory. `collectCacheEntries(cacheRoot, referencedChainIds)`
  enumerates per-`chainId` subdirs returning `{chainId, path, bytes, referenced}`.
  `collectReferencedChainIds(stateRoot)` walks every per-stack `meta.json` collecting referenced
  chain ids (falls back to `upstream` literal for pre-P4.T4 metas that didn't persist `chainId`).
  Consumers: `cli/commands/fork.ts:cacheListCommand` / `cachePruneCommand`,
  `cli/commands/prune.ts:maybePruneForkCache`.
- `src/engine/sui-fork.testkit.ts` — **305 LOC**. Test harness for fork-mode integration tests.
  Exports `forkHarness(options)` (Effect-scoped — boots a `sui-fork` container against the real
  testnet upstream at `TEST_TESTNET_CHECKPOINT = 50_000_000`, returns
  `{client, stack, upstream, checkpoint, hostUrl, containerId, stop}`) and
  `testHarness.fork = forkHarness`. Builds the fork image idempotently via content-addressed
  `devstack-sui.fork.image-test:<12-hex>` tag derived from
  `TEST_SUI_FORK_REV = '259b947bf5b07cded7481c0c1f5e88470939c930'`. Provides a synthetic
  `Identity({app: 'fork-test', stack: <random>, network: 'testnet-fork'})`. Uses
  `Docker.networkCreate` + `Docker.run` with `ports: {0: FORK_GRPC_PORT}` for auto-allocated host
  port. Polls `forkingService.getStatus({})` until success or 180s deadline. `forkCacheRoot()` reads
  `DEVSTACK_SUI_FORK_CACHE_DIR` env or defaults to `<cwd>/.devstack/sui-fork-cache/testnet`.

### Engine — probes + resolution

- `src/engine/chain-probe.ts` — **316 LOC**. `ChainProbe` `Context.Service` with
  `{getObject, getObjectStrict, objectsMatchTypes, getTransaction}`. Schema-validates
  `client.core.getObject(...)` responses against
  `GetObjectResponseSchema = {object: {objectId, type, version, owner}}` with a typed
  `ObjectOwnerSchema` union (`AddressOwner` / `Shared` / `Immutable` / `ConsensusAddressOwner` /
  `Parent` / `Unknown`). Normalises to flat `ObjectOwnerInfo = {address?, shared?, immutable?}`.
  Lenient default accessors return `undefined` for both "not found" and transient RPC failures
  (matching `withCache`'s convention). Strict `*Strict` variants distinguish via `ProbeError`
  `TaggedErrorClass`. `ChainProbeLive` Layer backed by `SuiTag.client.core` — folded into every
  `Sui()` member's `__layers` ring at `services/sui.ts:1993`.
- `src/engine/on-chain-artifact.ts` — **298 LOC**. `onChainArtifact(spec)` — the substrate for the
  unified publish-cache-verify-register shape on-chain primitives use (consumed by Package, Coin,
  etc., but defined here because it knows `SuiTag` + `ChainProbe`). Spec carries a typed
  `upstream: Record<Alias, LayeredTag<...>>` — values flow as a typed `deps` arg to `inputs` /
  `verify` / `produce` / `register` callbacks. Auto-flattens `upstream` record into `__upstreamKeys`
  (the dep graph IS the upstream record). Composes `withCache` + `register` step + `tag()` wiring.
  Cache key shape: `${namespace}/${chainId}/${contentHash(canonical(inputs))}` with `chainId`
  resolved from `SuiTag.chainId`.
- `src/engine/network.ts` — **133 LOC**. `SuiNetwork` literal
  (`'localnet' | 'testnet' | 'mainnet' | 'mainnet-fork' | 'testnet-fork' | 'devnet-fork'`);
  `resolveNetwork()` (reads `DEVSTACK_NETWORK` env, defaults to `'localnet'`, throws on
  unrecognised); `isKnownNetwork(value)`; `isLocalLikeNetwork(network)` (true for `'localnet'` + any
  `*-fork`); `isLiveNetwork(network)` (negation); `stripForkSuffix(network)`
  (`'mainnet-fork' → 'mainnet'` etc.).

### Engine — shared registries / errors / known-deployments (Sui parts)

- `src/engine/registries.ts:56-59,255-258,335-338` — `SuiStateRecord` (`{name, chainId}`),
  `SuiStateRegistry` `Context.Service`, `SuiStateRegistryLive` Layer + `publishSuiState` free
  function.
- `src/engine/known-deployments.ts:1-65,160-441` — `KnownNetwork` type
  (`'testnet' | 'mainnet' | 'devnet'`), `resolveDeploymentNetwork(network: SuiNetwork)` (maps fork
  variants to upstream live-net key, returns `undefined` for localnet), the static
  `knownDeployments` registry with per-service partial maps.
- `src/engine/errors.ts:34-188` — `ForkUnsupportedError`, `SeedManifestMismatchError`,
  `ForkIncompatibleError`, `SuiError`, `PublishError`, `HostProcessError`. Each is a
  `Schema.TaggedErrorClass` with a `phase` field (open or closed depending on the class) and
  optional `cause` / `stderr` / `stdout` / `exitCode` captures.

### LOC totals

- **Source (in-scope)**: ~5,602 LOC across primary files + ~98 LOC `cache-inventory.ts` + ~196 LOC
  `impersonate.ts` = **~5,896 LOC**. (Excludes the shared portions of `registries.ts` /
  `known-deployments.ts` / `errors.ts` whose Sui-specific slices are a few hundred lines each.)
- **Tests (in-scope)**: 319 + 751 + 257 + 325 + 344 + 158 + 175 + 143 + 151 + 20 + 125 + 338 + 391 +
  331 + 154 = **~4,276 LOC**.

## Configuration

### `Sui(opts?)` factory options

Read at factory-call time (NOT acquire time) in `services/sui.ts:1967`.

- `network?: 'localnet' | 'testnet' | 'mainnet' | 'mainnet-fork' | 'testnet-fork' | 'devnet-fork' | { rpc: string, faucet?: string }`
  — defaults to `resolveNetwork()` (`services/sui.ts:1968`). The object form routes to
  `buildCustom`. Fork variants route to `buildFork`. The three live-net literals route to their
  respective builders. `'localnet'` and unmatched values route to `buildLocalnet`.
- `localnet?: SuiLocalnetOptions` — read at `services/sui.ts:1983`. Sub-fields:
  - `image?: DockerContainerImage` — `{pull: '...'}` or `{build: {context, dockerfile, buildArgs}}`
    (`services/sui.ts:586,756-767`). When set, `version` is ignored.
  - `version?: string` — default `DEFAULT_SUI_VERSION = 'devnet-v1.71.0'`
    (`services/sui.ts:91,740`). Passed as `SUI_VERSION` build arg.
  - `rpcUrl?: string`, `faucetUrl?: string`, `graphqlUrl?: string` — pre-existing externally-managed
    RPC. When `rpcUrl` is set the container body is skipped (`services/sui.ts:792`). `runtime`
    becomes `'external'`.
  - `ports?: Record<number, number>` — rare opt-out for direct host port mapping in addition to the
    router (`services/sui.ts:599,880`).
  - `readyTimeoutMs?: number` — default 60_000 ms (`services/sui.ts:1069`).
- `testnet?: SuiTestnetOptions` — read at `services/sui.ts:1977`.
  `{rpcUrl?: string, faucetUrl?: string, graphqlUrl?: string}` with defaults
  `https://fullnode.testnet.sui.io:443`, `https://faucet.testnet.sui.io`,
  `https://sui-testnet.mystenlabs.com/graphql` (`services/sui.ts:1276-1278`).
- `mainnet?: SuiMainnetOptions` — read at `services/sui.ts:1979`.
  `{rpcUrl?: string, graphqlUrl?: string}` with defaults `https://fullnode.mainnet.sui.io:443`,
  `https://sui-mainnet.mystenlabs.com/graphql` (`services/sui.ts:1333-1334`). No faucet.
- `fork?: SuiForkOptions` — read at `services/sui.ts:1981`. Sub-fields:
  - `image?: DockerContainerImage` — `services/sui.ts:642,1620-1632`.
  - `version?: string` — default `DEFAULT_SUI_FORK_REV = '259b947bf5b07cded7481c0c1f5e88470939c930'`
    (`services/sui.ts:116,1613`). Passed as `SUI_REV` build arg.
  - `checkpoint?: number` — upstream checkpoint to fork at; omitted means latest
    (`services/sui.ts:649,1738`).
  - `seed?: { addresses?: ReadonlyArray<string>, objects?: ReadonlyArray<string> }` —
    `services/sui.ts:655-658,1663-1677`. `objects` is unioned with
    `collectKnownPackageSeedObjects()`.
  - `defaultGasBudget?: bigint` — default `100_000_000n` (0.1 SUI). Used by `executeImpersonated`
    via `services/sui/impersonate.ts:45,95`.
  - `readyTimeoutMs?: number` — default 180_000 ms (`services/sui.ts:669,1819`).
  - `autoTick?: AutoTickOption` — `boolean | { intervalMs: number }`. `false`/undefined → no
    auto-tick; `true` → 1000ms; object form → custom cadence (`engine/sui-fork/control.ts:51-71`).

### Environment variables

- `DEVSTACK_NETWORK` — read by `resolveNetwork()` (`engine/network.ts:81`). Accepts
  `'localnet' | 'testnet' | 'mainnet' | 'mainnet-fork' | 'testnet-fork' | 'devnet-fork'`.
  Unrecognised values throw.
- `RUN_FORK_DOCKER_TESTS` — gates the `*.docker.test.ts` files
  (`engine/sui-fork.container.docker.test.ts:32`, `engine/fork.e2e.docker.test.ts:7`,
  `engine/sui-fork/parallel.docker.test.ts:31`).
- `DEVSTACK_SUI_FORK_CACHE_DIR` — override shared fork upstream cache root
  (`engine/sui-fork.testkit.ts:114`). Default `<cwd>/.devstack/sui-fork-cache/testnet`.

### Internal constants

- `DEFAULT_SUI_VERSION = 'devnet-v1.71.0'` (`services/sui.ts:91`).
- `DEFAULT_SUI_FORK_REV = '259b947bf5b07cded7481c0c1f5e88470939c930'` (`services/sui.ts:116`).
  Lockstep with `engine/sui-fork.testkit.ts:67`.
- `LOCAL_RPC_PORT = 9000`, `LOCAL_FAUCET_PORT = 9123`, `LOCAL_GRAPHQL_PORT = 9125`
  (`services/sui.ts:96-98`).
- `FORK_GRPC_PORT = 9000` (`services/sui.ts:105`).
- `SUI_FORK_NETWORK_ALIAS = 'sui-fork'`, `SUI_INDEXER_DB_NETWORK_ALIAS = 'sui-indexer-db'`,
  `SUI_LOCALNET_NETWORK_ALIAS = 'sui-localnet'` (`services/sui.ts:117,132-133`).
- `SUI_INDEXER_DB_BASE_VERSION = '16-alpine'`, `SUI_INDEXER_DB_USER = 'sui'`,
  `SUI_INDEXER_DB_PASSWORD = 'sui'`, `SUI_INDEXER_DB_NAME = 'sui_indexer'`
  (`services/sui.ts:131,134-136`).
- `FAUCET_PROBE_RECIPIENT = '0xf0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0be'`
  (`services/sui.ts:385`).
- `WAIT_FOR_TX_READY_RETRY_SPACING = '2 seconds'`, `WAIT_FOR_TX_READY_TIMEOUT_MS = 90_000`
  (`services/sui.ts:431-432`).
- `FETCH_CHAIN_ID_TIMEOUT_MS = 30_000` (`services/sui.ts:488`).
- `PROBE_FETCH_TIMEOUT_MS = 3000` (`services/sui.ts:1073`).
- `MOVE_BUILD_LOCK_TIMEOUT_MS = 5 * 60 * 1000`, `MOVE_BUILD_LOCK_BASE_BACKOFF_MS = 100`,
  `MOVE_BUILD_LOCK_MAX_BACKOFF_MS = 2_000` (`engine/sui-build-container.ts:283-285`).
- `STALE_GIT_LOCK_AGE_MS = 60_000` (`engine/sui-build-container.ts:451`).
- `GIT_LOCK_NAMES = ['index.lock', 'HEAD.lock', 'config.lock', 'shallow.lock', 'packed-refs.lock']`,
  `GIT_INFO_LOCK_NAMES = ['sparse-checkout.lock']` (`engine/sui-build-container.ts:435-445`).
- `MAX_ERROR_DETAIL = 600` (`engine/sui-cli.ts:486`).
- `STALE_GIT_LOCK_MARKER = '.git/index.lock'`, `STALE_GIT_LOCK_RECIPE`
  (`engine/sui-cli.ts:502-507`).
- `DEFAULT_AUTO_TICK_INTERVAL_MS = 1000` (`engine/sui-fork/control.ts:45`).
- `DEFAULT_FORK_GAS_BUDGET = 100_000_000n` (`services/sui/impersonate.ts:45`).
- `TEST_TESTNET_CHECKPOINT = 50_000_000`,
  `TEST_SUI_FORK_REV = '259b947bf5b07cded7481c0c1f5e88470939c930'`
  (`engine/sui-fork.testkit.ts:57,67`).
- `FORK_UNSUPPORTED_CORE_SURFACES` Map: `'getBalance'`, `'listBalances'`, `'getCoinInfo'`
  (`services/sui.ts:1449-1462`).

## Capabilities CONSUMED

### Effect / Layer / Context machinery

- `Context.Service` — `SuiTag` (`services/sui.ts:336`), `SuiBuildContainer`
  (`engine/sui-build-container.ts:99`), `ChainProbe` (`engine/chain-probe.ts:141`),
  `SuiStateRegistry` (`engine/registries.ts:255`).
- `Context.Reference` — `SuiBuildImage` (`engine/sui-cli.ts:48-51`), `Identity` (consumed throughout
  — `services/sui.ts:644,857,1635`, `engine/sui-build-container.ts:644`).
- `Layer.effect` — `SuiBuildContainerLive` (`engine/sui-build-container.ts:640`), `ChainProbeLive`
  (`engine/chain-probe.ts:233`), `SuiBuildImage` provider layer (`services/sui.ts:1245,1940`).
- `Effect.gen`, `Effect.scope`, `Effect.forkScoped`, `Effect.acquireRelease`,
  `Effect.acquireUseRelease`, `Effect.tryPromise`, `Effect.try`, `Effect.retry`, `Effect.repeat`,
  `Effect.timeoutOrElse`, `Effect.mapError`, `Effect.catchTag`, `Effect.serviceOption`,
  `Effect.annotateCurrentSpan`, `Effect.withSpan`, `Effect.fn` — used extensively.
- `Stream.callback`, `Stream.fromAsyncIterable`, `Stream.map`, `Stream.mapAccum`,
  `Stream.fromEffectSchedule`, `Stream.catch`, `Stream.tap`, `Stream.unwrap` —
  `engine/sui-fork/control.ts:179-286`.
- `Schedule.spaced`, `Schedule.exponential`, `Schedule.either` —
  `services/sui.ts:436,518-520,1119,1826`; `engine/sui-fork/control.ts:146,237`.
- `Schema` — `effect`'s `Schema.Struct`, `Schema.Union`, `Schema.Literal`, `Schema.Literals`,
  `Schema.String`, `Schema.Number`, `Schema.Array`, `Schema.optional`, `Schema.TaggedErrorClass`,
  `Schema.decodeUnknownEffect`, `Schema.decodeUnknownSync`, `Schema.encodeUnknownSync` —
  `engine/chain-probe.ts`, `engine/errors.ts`, `engine/sui-fork/meta.ts`.
- `Scope.Scope` — fiber-scoped `runAutoTickClock` (`engine/sui-fork/control.ts:136`),
  `acquireForkDataLock` (`engine/sui-fork/file-lock.ts:28`), `SuiBuildContainerLive`'s cleanup scope
  (`engine/sui-build-container.ts:665,677`).
- `Ref` — `EffectRef.make(new Set<ProbeKey>())` for tracking which probes have succeeded at least
  once (`services/sui.ts:1078`).
- `Fiber` — `Fiber.Fiber<unknown, never>` return type of `runAutoTickClock`
  (`engine/sui-fork/control.ts:136`).
- `FileSystem` — used by `engine/sui-cli.ts:118`, `engine/sui-fork/meta.ts:163-185` (`fs.exists`,
  `fs.readFileString`, `fs.writeFileString`, `fs.readDirectory`, `fs.stat`).
- `ChildProcessSpawner` — needed by every `runWithCapture` call (`engine/sui-cli.ts:118`,
  `engine/sui-build-container.ts:156`).

### Engine resources

- **Identity** (`engine/identity.ts`) — read for `{app, stack, network}`
  (`services/sui.ts:644,857,1635`, `engine/sui-build-container.ts:644`). Drives every per-stack name
  (docker network, container name, hostname).
- **Docker primitives** — `Docker.run` (`services/sui.ts:967,1766`,
  `engine/sui-fork.testkit.ts:218`), `Docker.networkCreate` (`services/sui.ts:887,1717`,
  `testkit.ts:204`), `Docker.exec` (`services/sui.ts:524`), `Docker.dockerLogsTail`
  (`services/sui.ts:1125`), `Docker.build` + `Docker.imageExists` (`testkit.ts:96,97`).
- **`engine/docker/ensure-container.ts::ensureContainer`** — adopts/creates the SuiBuildContainer's
  sleeper container (`engine/sui-build-container.ts:157`).
- **`engine/docker/router.ts::routerEntrypoint`** + **`engine/router-hostname.ts::routerHostname`**
  — read for the per-service routed hostname (`services/sui.ts:858-863,1636-1646`). Entrypoints
  consumed: `'sui-rpc'`, `'sui-faucet'`, `'sui-graphql'`, `'sui-grpc'`.
- **`engine/registries.ts::publishEndpoint`** — published 4× for localnet (`SUI_RPC`, `SUI_FAUCET`,
  `SUI_GRAPHQL`, `SUI_INDEXER_DB`), 1-3× for testnet/mainnet/custom
  (`services/sui.ts:797-811,1144-1159,1280-1290,1336-1341,1390-1404,1853`).
- **`engine/registries.ts::publishSuiState`** — published 1× per builder
  (`services/sui.ts:813,1162,1292,1343,1406,1861`).
- **`engine/resolve-app-dir.ts::resolveAppDir()`** — read by `SuiBuildContainerLive`
  (`engine/sui-build-container.ts:667`) for the `/host` bind-mount root, by `buildFork`
  (`services/sui.ts:1651`) for the `.devstack/stacks/<stack>/sui-fork/` lock + data + meta paths, by
  `engine/sui-fork/meta.ts:148,153` defaults.
- **`engine/file-lock.ts`** — `ownLockBody`, `parseLockBody`, `releaseLockSync`,
  `serializeLockBody`, `tryClaimLockSync`, `LockBody` (`engine/sui-build-container.ts:61`,
  `engine/sui-fork/file-lock.ts:21`).
- **`engine/process-liveness.ts::isHolderLive`** — used by the move-build lock's stale-PID reclaim
  (`engine/sui-build-container.ts:60,343`).
- **`engine/safe-env.ts::inheritedHostEnv`** — folded into host-sui env
  (`engine/sui-cli.ts:30,420`).
- **`engine/capture-command.ts::captureCommand`** — routed through by every `runWithCapture`
  invocation (`engine/sui-cli.ts:29,471`).
- **`engine/atomic-write.ts::writeFileAtomicIfChanged`** — used by `writeForkMeta`
  (`engine/sui-fork/meta.ts:183`).
- **`engine/content-hash.ts::contentHash`** — used by `computeConfigHash`
  (`engine/sui-fork/meta.ts:141`) and by the testkit's image tag (`engine/sui-fork.testkit.ts:76`).
- **`engine/stringify-cause.ts::stringifyCause`** — error message formatting in
  `engine/sui-fork/control.ts`, `services/sui/impersonate.ts`, `engine/chain-probe.ts`.
- **`engine/pretty-error.ts::prettyError`** — used by `SuiCliError`'s ENOENT detection
  (`engine/sui-cli.ts:32,85`).
- **`engine/cache.ts::withCache`** — composed by `onChainArtifact`
  (`engine/on-chain-artifact.ts:28,245`).
- **`engine/phases.ts`** — `SuiPhases` + `SuiCliPhases` (closed-set phase strings stamped into
  errors; `engine/errors.ts:18`, `engine/sui-cli.ts:31,62`).
- **`engine/shared.ts::SuiObjectChange`** — type imported by `engine/sui-helpers.ts:6` for the
  object-changes picker.
- **`engine/fs-utils.ts::safeDirSize`** — used by `cache-inventory.ts:16`.
- **`advanced/plugin-author/index.ts::dockerImage`**, **`runDockerContainer`**,
  **`DockerContainerImage`** — `services/sui.ts:55-56,757-767,777-784,913,967,1622-1632,1766`.
- **`advanced/tag.ts::provide`**, **`tag`**, **`setPhase`**, **`LayeredTag`** —
  `services/sui.ts:57,847,912,957,1068,1198,1310,1359,1424,1654,1679,1709,1756,1820,1907`;
  `engine/on-chain-artifact.ts:31`.
- **`advanced/make-service.ts::makeService`** — `services/sui.ts:58,1994`.
- **`runtime/endpoint-names.ts::EndpointName`** — `SUI_RPC`, `SUI_FAUCET`, `SUI_GRAPHQL`,
  `SUI_INDEXER_DB`, `SUI_CHECKPOINT_VOLUME` — `services/sui.ts:62`.

### Runtime resources

- **Host fs** — `~/.move/git/` for sui-cli's content-addressed Move dep cache (read + write);
  `~/.devstack/locks/` for the move-build lock (`engine/sui-build-container.ts:294`);
  `<appDir>/.devstack/stacks/<stack>/sui-fork/{data,data.lock,meta.json}` for fork state.
- **Host docker daemon** — every container, network, image build flows through it; the
  SuiBuildContainerLive `dockerRm` finalizer is best-effort
  (`engine/sui-build-container.ts:130-137`).
- **Host process** — `os.homedir()` (`engine/sui-cli.ts:25`,
  `engine/sui-build-container.ts:53,294`); `process.pid` + `os.hostname()` (via
  `engine/file-lock.ts`).
- **`SUI_FULLNODE_URL`, `SUI_FAUCET_URL`** env passed to host-sui spawns
  (`engine/sui-cli.ts:420-422`).
- **`/tmp/scrub-move-lock.awk`** inside container (`engine/sui-cli.ts:289-291`,
  `engine/sui-build-container.ts:553-555`).

### Surfaces

- **TUI** — every `provide(SuiTag, build, {kind, plugin, displayTitle, display, upstreamKeys})`
  (`services/sui.ts:1198,1310,1359,1424,1907`) feeds the supervisor's TUI state. `setPhase(...)`
  emits per-step narration: `'resolving image'`, `'starting indexer-db'`, `'starting localnet'`,
  `'awaiting rpc + faucet + graphql'`, `'acquiring data-dir lock'`, `'checking fork meta'`,
  `'starting sui-fork'`, `'awaiting sui-fork rpc + GetStatus'`, `'starting auto-tick clock (Nms)'`.
- **OTLP spans** — `Effect.withSpan('SuiCli.buildMove')`, `SuiCli.scrubCachedMoveLocks`,
  `SuiProbeRpc` / `SuiProbeFaucet` / `SuiProbeGraphql`, `SuiWaitForTransactionsReady`,
  `SuiIndexerReady`, `SuiForkStatus`, `SuiForkAdvanceClock`, `SuiForkAdvanceCheckpoint`,
  `SuiForkAutoTickTick`, `SuiForkImpersonate`.
- **`Effect.logWarning` / `Effect.logError` / `Effect.logInfo` / `Effect.logDebug`** — used for
  auto-tick failures (`engine/sui-fork/control.ts:140`), Move.lock scrub warnings
  (`engine/sui-cli.ts:610,622`), full build stderr/stdout on failed builds
  (`engine/sui-cli.ts:198-202`), polling fallback debug (`engine/sui-fork/control.ts:281`),
  auto-tick activation info (`services/sui.ts:1879`).

### External

- **HTTP** — POST `<faucetUrl>/v2/gas` with `FixedAmountRequest` body for `faucetReadyProbe`
  (`services/sui.ts:408-415`); GET `<faucetUrl>/` for the socket-level liveness check
  (`services/sui.ts:1092-1098`); POST `<graphqlUrl>` with `{ chainIdentifier }` query
  (`services/sui.ts:1102-1115`).
- **gRPC (over fetch via `@mysten/sui/grpc`)** — `client.core.getChainIdentifier()`
  (`services/sui.ts:492`); `client.core.getObject` / `getTransaction` / `listCoins` /
  `executeTransaction` (`engine/chain-probe.ts`, `services/sui/impersonate.ts:131`);
  `client.forkingService.getStatus` / `advanceClock` / `advanceCheckpoint`
  (`services/sui.ts:1513,1533,1554`); `client.subscriptionService.subscribeCheckpoints`
  (`engine/sui-fork/control.ts:184`).
- **`sui` CLI binary** — invoked via `ChildProcess.make('sui', [...])` on the host
  (`engine/sui-cli.ts:391`) OR via `docker run --rm ... sui ...` (`engine/sui-cli.ts:374`) OR via
  `docker exec <container> sh -c ... sui ...` (`engine/sui-build-container.ts:591,604-616`).
- **`docker` CLI binary** — every `Docker.*` call and direct `ChildProcess.make('docker', [...])`
  (`engine/sui-build-container.ts:130-137,211,373,591,604`).
- **Public Sui fullnodes / faucet / GraphQL** — `https://fullnode.{testnet,mainnet}.sui.io:443`,
  `https://faucet.testnet.sui.io`, `https://sui-{testnet,mainnet}.mystenlabs.com/graphql`
  (`services/sui.ts:1276-1278,1333-1334`).
- **Upstream Sui RPC** for fork mode — accessed by the `sui-fork` binary inside the container; not
  directly dialled from host code, except by tests via `https://sui-testnet.mystenlabs.com/graphql`
  for cache warming (`engine/sui-fork.testkit.ts:14`).

### Imports from other workspace packages

- `@mysten/sui/grpc` — `SuiGrpcClient` (`services/sui.ts:40`, `engine/chain-probe.ts:25`,
  `services/sui/impersonate.ts:38`, `engine/sui-fork/control.ts:34`,
  `engine/sui-fork.testkit.ts:23`).
- `@mysten/sui/transactions` — `Transaction` (`services/sui.ts:329`,
  `services/sui/impersonate.ts:37`).
- `@mysten/sui/utils` — `normalizeStructTag` (`engine/sui-helpers.ts:5`).

### npm dependencies

- `effect` (top-level), `effect/unstable/process::ChildProcessSpawner` + `ChildProcess`
  (`engine/sui-cli.ts:28`, `engine/sui-build-container.ts:56`).
- Node built-ins: `node:crypto` (`createHash`, `randomBytes` — `engine/sui-build-container.ts:51`,
  `engine/sui-fork.testkit.ts:24`), `node:fs` (`engine/sui-build-container.ts:52`,
  `engine/sui-fork.testkit.ts:26`, `engine/sui-fork/cache-inventory.ts:14`), `node:os`
  (`engine/sui-cli.ts:25`, `engine/sui-build-container.ts:53`), `node:path` (`engine/sui-cli.ts:26`,
  `engine/sui-build-container.ts:54`, `engine/sui-fork/meta.ts:59`, `services/sui.ts:78`).

## Capabilities PRODUCED

### Endpoints

Published into `EndpointRegistry` via `publishEndpoint` (consumed by router, snapshot, codegen,
manifest, frontend bindings):

- **localnet container path**:
  - `EndpointName.SUI_RPC = http://sui.<app>.localhost:<sui-rpc port>` (host) +
    `http://sui-localnet:9000` (container) on network `<networkName>` —
    `services/sui.ts:1144-1147,1170-1174`.
  - `EndpointName.SUI_FAUCET = http://faucet.<app>.localhost:<sui-faucet port>` +
    `http://sui-localnet:9123` — `services/sui.ts:1145-1149`.
  - `EndpointName.SUI_GRAPHQL = http://graphql.<app>.localhost:<sui-graphql port>/graphql` +
    `http://sui-localnet:9125/graphql` — `services/sui.ts:1150-1154`.
  - `EndpointName.SUI_INDEXER_DB = postgres://sui:sui@sui-indexer-db:5432/sui_indexer` (kind:
    'internal') — `services/sui.ts:1155-1159`.
- **localnet externally-managed RPC path**: `SUI_RPC` (always), `SUI_FAUCET` (if `faucetUrl` set),
  `SUI_GRAPHQL` (if `graphqlUrl` set) — host-only Endpoints (`services/sui.ts:797-811,820-824`).
- **testnet**: `SUI_RPC`, `SUI_FAUCET`, `SUI_GRAPHQL` — host-only Endpoints, no container view —
  `services/sui.ts:1280-1290`.
- **mainnet**: `SUI_RPC`, `SUI_GRAPHQL` (NO faucet) — `services/sui.ts:1336-1341`.
- **custom**: `SUI_RPC` + optional `SUI_FAUCET` / `SUI_GRAPHQL` — `services/sui.ts:1390-1404`.
- **fork**: `SUI_RPC = http://sui.<app>.localhost:<sui-grpc port>` (host, h2c-translated via
  traefik) + `http://sui-fork:9000` (container) on network `<forkNetworkName>` —
  `services/sui.ts:1853,1890-1894`.

### State-store entries

Published into `SuiStateRegistry` via `publishSuiState` (`engine/registries.ts:335`):

- Key:
  `{name: 'sui.localnet' | 'sui.testnet' | 'sui.mainnet' | 'sui.<custom-name>' | 'sui.mainnet-fork' | 'sui.testnet-fork' | 'sui.devnet-fork'}`.
  Value: `{chainId: string}` (`engine/registries.ts:56-59`). Multiple writes to same key are
  last-write-wins.

### Fork-mode on-disk artifacts

- `<appDir>/.devstack/stacks/<stack>/sui-fork/data/` — fork data dir (writable RocksDB-like state).
  Bind-mounted into the fork container; `docker commit` captures it for snapshot save.
- `<appDir>/.devstack/stacks/<stack>/sui-fork/data.lock` — file-lock sentinel guarding single-writer
  access (`engine/sui-fork/file-lock.ts`).
- `<appDir>/.devstack/stacks/<stack>/sui-fork/meta.json` — config-hash gate
  (`engine/sui-fork/meta.ts`).
- `<appDir>/.devstack/stacks/<stack>/sui-fork/seed-manifest.json` — written by sui-fork itself;
  devstack does NOT re-read this file (`engine/sui-fork/meta.ts:78-81`).
- `<appDir>/.devstack/sui-fork-cache/<chainId>/` — shared upstream cache root, NOT refcounted.
  Manual GC via `devstack fork cache prune --unreferenced` or `devstack wipe --also-upstream-cache`
  (`engine/sui-fork/meta.ts:13-26`).

### Move build artifacts

- `~/.devstack/locks/sui-move-build-<sha1(moveHome)[:16]>.lock` — host-wide advisory lock; held only
  across the `sui move build` spawn.
- `<package>/build/` — `sui move build` output (BCS bytecode + dependencies). Returned shape:
  `BuildMoveResult = {modules: ReadonlyArray<string>, dependencies: ReadonlyArray<string>}`
  (`engine/sui-cli.ts:103-106`).
- The long-lived per-app `devstack-<app>-build` sleeper container
  (`engine/sui-build-container.ts:122,200`) — `docker rm -f`'d at scope teardown.

### Container images / volumes produced

- `devstack-sui.image:<content-hash>` (localnet path, vendored `images/sui/`) —
  `services/sui.ts:758-764`.
- `devstack-sui.indexer-db.image:<content-hash>` (`images/postgres/` with PGDATA relocated to
  `/pgdata`) — `services/sui.ts:777-784`.
- `devstack-sui.fork.image:<content-hash>` (vendored `images/sui-fork/`, builder cargo-builds from
  `SUI_REV` build arg) — `services/sui.ts:1620-1632`.
- `devstack-sui.fork.image-test:<12-hex>` (test-harness variant) —
  `engine/sui-fork.testkit.ts:75-84`.

### Container names + docker networks

- Container names (composed by `runDockerContainer`'s name composition):
  `<app>-<stack>-sui.localnet`, `<app>-<stack>-sui.indexer-db`, `<app>-<stack>-sui.fork`,
  `devstack-<app>-build` (build container — flat, no stack/network suffix;
  `engine/sui-build-container.ts:122`).
- Docker network names — `suiNetworkName(identity)` returns `<app>-sui-network` (main stack) or
  `<app>-<stack>-sui-network` (non-main), suffixed with `-<network>` for non-localnet
  (`services/sui.ts:369-379`). `suiForkNetworkName(identity)` returns
  `<app>[-<stack>]-sui-fork-network-<network>` (`services/sui.ts:1596-1606`).
- Network aliases: `sui-localnet` (`SUI_LOCALNET_NETWORK_ALIAS`), `sui-indexer-db`
  (`SUI_INDEXER_DB_NETWORK_ALIAS`), `sui-fork` (`SUI_FORK_NETWORK_ALIAS`).

### Routes registered

- localnet: `'sui'` / `'faucet'` / `'graphql'` routes through traefik on entrypoints `sui-rpc` /
  `sui-faucet` / `sui-graphql` (`services/sui.ts:1018-1034`).
- fork: `'sui'` route on entrypoint `sui-grpc` with `protocol: 'h2c'` (`services/sui.ts:1771-1778`).

### TypeScript exports consumed elsewhere

- From `services/sui.ts`: `Sui`, `SuiTag`, `Sui` (interface), `SuiOptions`, `SuiLocalnetOptions`,
  `SuiTestnetOptions`, `SuiMainnetOptions`, `SuiCustomOptions`, `SuiForkOptions`, `ForkStatus`,
  `ForkAdvanceClockResult`, `ForkAdvanceCheckpointResult`, `ForkControl`, `SuiSchema`,
  `EndpointSchema`, `SuiNetwork` (re-export), `suiNetworkName`, `faucetReadyProbe`.
- From `engine/network.ts`: `SuiNetwork`, `ResolvedNetwork`, `resolveNetwork`, `isKnownNetwork`,
  `isLocalLikeNetwork`, `isLiveNetwork`, `stripForkSuffix`.
- From `engine/sui-cli.ts`: `SuiCliError`, `SuiCliCapture`, `Spawner`, `SuiBuildImage`,
  `BuildMoveOptions`, `BuildMoveResult`, `buildMove`, `runWithCapture`, `shellQuote`,
  `stripPinnedSections`, `scrubCachedMoveLocks`.
- From `engine/sui-build-container.ts`: `SuiBuildContainer`, `SuiBuildContainerShape`,
  `SuiBuildContainerLive`, `containerNameFor`, `toContainerPath`, `withMoveBuildLock`,
  `sweepStaleGitLocks`.
- From `engine/sui-helpers.ts`: `pickCreatedByType`, `PickCreatedByTypeFilter`,
  `PickCreatedByTypeResult`, `CreatedObjectEntry`, `moveTypeStartsWith`, `moveTypeEquals`,
  `parseCoinTypeFromGeneric`.
- From `engine/chain-probe.ts`: `ChainProbe`, `ChainProbeLive`, `ObjectInfo`, `ObjectOwnerInfo`,
  `TransactionInfo`, `ProbeError`.
- From `engine/on-chain-artifact.ts`: `onChainArtifact`, `OnChainArtifactSpec`, `Resolved`,
  `UpstreamE`.
- From `engine/sui-fork/control.ts`: `AutoTickOption`, `DEFAULT_AUTO_TICK_INTERVAL_MS`,
  `ForkCheckpointEvent`, `resolveAutoTickIntervalMs`, `resolveResumeAutoTickIntervalMs`,
  `runAutoTickClock`, `subscribeCheckpoints`, `pollCheckpoints`, `subscribeCheckpointsWithFallback`.
- From `engine/sui-fork/file-lock.ts`: `acquireForkDataLock`.
- From `engine/sui-fork/meta.ts`: `ForkMeta`, `ForkConfigInput`, `ForkRuntimeInput`,
  `computeConfigHash`, `resolveForkMetaPath`, `resolveForkDataDir`, `readForkMeta`, `writeForkMeta`,
  `ensureForkMetaConsistent`.
- From `engine/sui-fork/cache-inventory.ts`: `CacheEntry`, `collectCacheEntries`,
  `collectReferencedChainIds`.
- From `engine/sui-fork.testkit.ts`: `forkHarness`, `testHarness`, `ForkHarness`,
  `ForkHarnessOptions`, `TEST_TESTNET_CHECKPOINT`, `forkCacheRoot`.
- From `services/known-package.ts`: `KnownPackage`, `KnownPackageOptions`,
  `collectKnownPackageSeedObjects`, `clearKnownPackageSeedObjects`.
- From `services/sui/impersonate.ts`: `executeImpersonated`, `DEFAULT_FORK_GAS_BUDGET`,
  `ImpersonateOptions`, `ImpersonatedTxResponse`.

## Lifecycle

### Startup ordering across modes

The `Sui()` factory returns a `LayeredTag` whose `__layers` ring is composed by
`services/sui.ts:1230-1271,1928-1952`. The supervisor's topological scheduler builds these layers in
dependency order:

1. **Image layers** (build / pull): localnet image + indexer-db image (always built lazily by
   current `buildLocalnet`); fork image; sibling test-harness image. Caller-supplied `{pull}` images
   skip the build step entirely.
2. **`SuiBuildImage` `Context.Reference` provider Layer** (only for localnet container path + fork
   path — NOT external-rpc localnet, NOT testnet/mainnet/custom). This binds the layer with the
   resolved image tag the build container should dispatch into.
3. **Network + sidecar acquisition** — `Docker.networkCreate(suiNetworkName(...))` (localnet/fork),
   then the postgres `sui.indexer-db` sidecar (localnet only) + `pg_isready` probe, then the
   sui-localnet / sui-fork container itself.
4. **Ready probes**:
   - localnet: parallel
     `Effect.all([rpcProbe, faucetProbe, graphqlProbe], {concurrency: 'unbounded'})` retried
     `Schedule.spaced('1 seconds')` until 60_000ms (default) deadline. Per-probe
     `AbortSignal.timeout(3000)` cap. Tracks `seen: Set<ProbeKey>` so the deadline message names
     which probes never succeeded (`services/sui.ts:1077-1142`).
   - fork: `ForkingService.GetStatus({})` round-trip retried `Schedule.spaced('2 seconds')` until
     180_000ms (default) deadline (`services/sui.ts:1820-1850`).
   - testnet/mainnet/custom: NO ready probe — `fetchChainId` is the only sentinel.
5. **Chain id resolution** via `fetchChainId(client)` (30_000ms timeout —
   `services/sui.ts:489-513`).
6. **Endpoint + state publish** — `publishEndpoint(SUI_RPC|...)` +
   `publishSuiState({name, chainId})`.
7. **`waitForTransactionsReady` cached** — `buildWaitForTransactionsReady(faucetUrl?)`
   (`services/sui.ts:466-477`). `Effect.cached` so subsequent calls don't re-probe; for no-faucet
   networks it's `() => Effect.void`.
8. **Fork-only: auto-tick fiber** — when `autoTickMs !== undefined`, `runAutoTickClock`
   `Effect.forkScoped`s the tick fiber (`services/sui.ts:1876-1880`).
9. **`SuiBuildContainerLive`** (when wired): adopts-or-creates `devstack-<app>-build` sleeper
   container with `-v <appDir>:/host -v ~/.move:/root/.move --entrypoint sleep ... infinity`.
   `Scope.addFinalizer(cleanupScope, dockerRm(spawner, containerName))` registered
   (`engine/sui-build-container.ts:677`).
10. **`ChainProbeLive`** folded into the layer ring at `services/sui.ts:1993` so every
    `onChainArtifact` finds `ChainProbe` at acquire time without re-wiring.

### Ready criteria

- **localnet container**: all three of `rpcProbe` (client.core.getChainIdentifier()), `faucetProbe`
  (GET / returning < 500), `graphqlProbe` (POST { chainIdentifier }) succeed concurrently in one
  iteration. `seen: Set<ProbeKey>` tracked for diagnostic on timeout. NOTE: ready ≠
  funds-transferable — primitives submitting tx after this must call `waitForTransactionsReady()`.
- **localnet external-rpc**: `fetchChainId(client)` succeeds — no ready probe.
- **testnet/mainnet/custom**: `fetchChainId(client)` succeeds.
- **fork**: `forkingService.getStatus({})` succeeds; `initialStatus.forkedAtCheckpoint` is then
  bound into the `ForkControl` adapter.
- **build container**: `ensureContainer` returns successfully (covers fresh-run / adopt-running /
  adopt-stopped / recreate-different-image paths).

### Restart behavior

- **Reuse-if-image-matches** is the default for localnet + fork (resume via `runDockerContainer`'s
  `decideRunAction`). Image bump → recreate; same image → adopt the writable layer + `docker start`.
  localnet's `expectedExitCodes: [137]` opts out of UNCLEAN_PRIOR_SHUTDOWN auto-recreate (the sui
  PID-1-blocks-SIGINT trace at `services/sui.ts:978-1006` means 137 is normal exit).
- **Build container**: `ensureContainer` handles the full state machine. Resume on same image is
  `docker start`; different image is `docker rm -f` + recreate. Rejects `recreate-on-resume-failed`
  (defensive — wants daemon outages to fail loudly, not silently recreate).
- **Selective restart**: each primitive's scope is independent (`Effect.MemoMap` forks one scope per
  `Layer.effect`). A targeted watch-invalidation tearing the SuiBuildContainer scope but NOT the
  localnet scope (or vice versa) is supported. `r` (full rebuild) cascades through every scope in
  dep order.
- **Auto-tick fiber**: `Effect.forkScoped` so it dies cleanly on the outer scope close (`r`, watch
  invalidation, Ctrl-C, SIGTERM).
- **Move-build lock**: `Effect.acquireUseRelease` so the lock is released on success, failure, and
  interruption (including SIGINT teardown).

### Teardown ordering

1. Auto-tick fiber dies via scope close (no manual interrupt).
2. SuiBuildContainer's `cleanupScope` finalizer fires `docker rm -f devstack-<app>-build`
   (best-effort; failure does not fail teardown).
3. Move-build lock's `releaseLockSync` finalizer fires if still held.
4. Fork data-dir lock's `releaseLockSync` finalizer fires.
5. The sui-localnet / sui-fork / sui-indexer-db containers are `docker stop`'d (NOT `rm`'d) by
   `runDockerContainer`'s normal teardown — `stopGraceSeconds: 30` for localnet (forces SIGKILL →
   exit 137), `stopGraceSeconds: 20` for postgres (clean WAL close). The writable layer survives for
   the next `up` to resume.
6. Docker networks are torn down by `Docker.networkCreate`'s scope finalizer (idempotent — orphans
   are reaped by `engine/docker/orphans.ts`).

## Hard requirements / invariants

Load-bearing constraints. Each cited to file:line or test.

### Build / publish

- **Cross-process move-build lock MUST serialize at the `buildMove` funnel, not at the container
  level.** `withMoveBuildLock` is applied inside `buildMove` (`engine/sui-cli.ts:187`) so it covers
  all three paths (host CLI, fresh `docker run --rm`, `docker exec` into SuiBuildContainer).
  Wrapping at the container layer would miss two paths. (`engine/sui-cli.ts:170-187`; test:
  `engine/sui-cli.test.ts:240,245` "two concurrent buildMove calls serialize their build spawns".)
- **Move.lock `[pinned.<env>.*]` sections MUST be stripped before sui move build** — both the
  package's own `Move.lock` AND every `~/.move/git/<repo>/.git/`-cached lockfile. Without this,
  deepbook's `token` dep pins testnet's published id into the build, which then fails on localnet
  ("Active environment 'localnet' does not correspond to any of environments defined for the
  package"). The strip is now inline inside the container shell via `gawk -i inplace`.
  (`engine/sui-cli.ts:274-372,712-735`; tests: `engine/sui-cli.test.ts:18-167` "stripPinnedSections"
  suite.)
- **`-e testnet --no-tree-shaking` flags are mandatory** post sui-cli ≥ 1.71 — `-e` because the CLI
  requires the env to match a `[pinned.<env>.*]` block, `--no-tree-shaking` because the tree-shaking
  pass tries to RPC the configured env's fullnode for dep digests and the build container has no
  network for that. (`engine/sui-cli.ts:330-357,394-407,584-589`.)
- **HIGH-R5: scrub MUST use `-type f -exec gawk -i inplace`** — `-type f` rejects symlinks (a
  malicious `Move.lock -> /etc/passwd` would otherwise be scrubbed when the bind-mounted-root
  container runs the awk). Explicit `gawk` (not `awk`) because Ubuntu's default is mawk which lacks
  `-i inplace`. (`engine/sui-cli.ts:292-306,562-579`.)
- **`shellQuote` MUST be applied to `pkgName` interpolated into the in-container `sh -c` script** —
  bind-mounts grant container write access to host source dir + `~/.move`, so unquoted interpolation
  is a foot-gun. (`engine/sui-cli.ts:324-329,383`; tests: `engine/sui-cli.test.ts:170-237`
  "shellQuote" suite.)
- **`captured.exitCode !== 0` MUST fail BEFORE the JSON parse** — empty stdout from a failed build
  would otherwise crash the parser without ever surfacing the real error. Both stderr and stdout are
  routed through `Effect.logError` before failing. (`engine/sui-cli.ts:194-215`.)
- **`SuiBuildContainerLive` requires `SuiBuildImage` to be provided** — defensive fail-loud if a
  caller composes it manually without the image (`engine/sui-build-container.ts:646-658`).
  `suiLocalnet` skips both layers when `rpcUrl` is set (`services/sui.ts:1244`).
- **Stale-git-lock sweep happens AFTER acquiring the move-build lock, BEFORE the body runs** —
  guarantees no peer is mid-`git sparse-checkout add` when the sweep runs
  (`engine/sui-build-container.ts:421-430`; tests: `engine/sui-build-container.test.ts:112-216`
  "sweepStaleGitLocks" suite).
- **60s mtime safety window for stale-lock removal** — well above any normal git op against a
  sparse-checkout dep cache (`engine/sui-build-container.ts:451`; test:
  `engine/sui-build-container.test.ts:142` "leaves fresh lock files alone").

### Localnet

- **`expectedExitCodes: [137]` opt-out of UNCLEAN_PRIOR_SHUTDOWN auto-recreate is mandatory** — the
  sui-faucet binary's `axum::serve(...)` blocks PID 1's SIGINT handler registration, so the
  validator ALWAYS exits 137 on cycle teardown. Without this opt-out, `decideRunAction` recreates on
  every `pnpm dev`, nuking `/root/.sui` (chain state) and defeating warm resume.
  (`services/sui.ts:978-1017`.)
- **Per-stack docker network is mandatory** so the indexer-db sidecar + sui-localnet have stable
  in-network DNS aliases (`sui-indexer-db`, `sui-localnet`) and parallel stacks of the same app
  don't collide. Network name folds `Identity.stack` (`services/sui.ts:369-379`).
- **PGDATA relocated to `/pgdata` (off the inherited VOLUME) for the indexer-db image** — upstream
  postgres's VOLUME declaration would otherwise exclude state from `docker commit` (snapshot save).
  (`services/sui.ts:128-131,776-784`.)
- **Chain state under `/root/.sui` lives in the writable layer, NOT a named volume** — same reason:
  `docker commit` captures it for snapshot save. (`services/sui.ts:947-956`.)
- **`waitForTransactionsReady` MUST be called before any funds-transferable tx after
  `yield* SuiTag`** — the socket-level ready gate passes BEFORE the validator can actually fund.
  (`services/sui.ts:188-195,406-477`.)
- **Per-fetch `AbortSignal.timeout(3000)`** required so a hung fetch doesn't block the whole
  `Effect.all` for the full 60s outer budget (`services/sui.ts:1073-1075`).

### Fork

- **R5: `acquireForkDataLock` MUST be acquired before handing the data dir to `sui-fork`** — two
  `sui-fork start` processes against the same data dir silently trample each other's RocksDB state.
  (`services/sui.ts:1655`, `engine/sui-fork/file-lock.ts:28-64`; tests:
  `engine/sui-fork.lock.test.ts:31-143`.)
- **R6: `ensureForkMetaConsistent` MUST run before the fork container starts** — sui-fork's own
  write-once `seed_manifest.json` fails inside the binary with a non-actionable Rust panic message
  on a config drift. Devstack mirrors that contract at a higher layer with an actionable
  `SeedManifestMismatchError`. (`services/sui.ts:1693-1704`, `engine/sui-fork/meta.ts:187-275`;
  tests: `engine/sui-fork/meta.test.ts:171` "P4.T5 raises SeedManifestMismatchError when configHash
  changes".)
- **`configHash` MUST be stable across orderings of `seedAddresses` / `seedObjects`** — both are
  sorted + lowercased before digesting (`engine/sui-fork/meta.ts:128-142`; tests:
  `meta.test.ts:26-67`).
- **`runtime.autoTickMs` MUST be excluded from `configHash`** — auto-tick cadence is a
  supervisor-side knob, not a seed-manifest contract field. Flipping it 1000ms → 2000ms must NOT
  trip the gate. (`engine/sui-fork/meta.ts:46-57,107`; test: `meta.test.ts:107,231`.)
- **R1: `forkGuard` Proxy MUST throw SYNCHRONOUSLY for unsupported `client.core.*` surfaces** —
  `getBalance`, `listBalances`, `getCoinInfo` panic the fork binary
  (`crates/sui-fork/src/store.rs:1198,1206,1214`). The guard intercepts BEFORE the wire call so the
  fork stays up. (`services/sui.ts:1449-1494`; test: `services/sui.fork.test.ts:18`.)
- **R3: Default gas budget MUST be stamped when none is set** — sui-fork's `simulate_transaction`
  returns `"unsupported"`, breaking the SDK's auto-gas-budget path.
  `DEFAULT_FORK_GAS_BUDGET = 100_000_000n` (`services/sui/impersonate.ts:45,95-110`).
- **R9: auto-tick failure policy is log+continue, NOT propagate** — a single advance-clock RPC
  failure should not tear the stack down (`engine/sui-fork/control.ts:121-147`; test:
  `engine/sui-fork/control.test.ts:202` "logs + keeps ticking on advance-clock failure").
- **R10: 180s ready-timeout default** — cold-start serially fetches upstream system state via
  GraphQL (`services/sui.ts:1819-1840`).
- **Fork data dir lives under `.devstack/stacks/<stack>/sui-fork/`, NOT
  `.devstack/networks/<net>.json`** — per-stack mutable chain state
  (`engine/network.ts:30-33,109-111`; tests: `services/sui.fork.test.ts:140-153`).
- **Shared `.devstack/sui-fork-cache/<chainId>/` is NOT refcounted; GC is manual** — settled as
  manual-only 2026-05-19. `chainId` is the partition key; `upstream` literal is the legacy fallback
  (`engine/sui-fork/meta.ts:13-26`, `engine/sui-fork/cache-inventory.ts:69-98`).
- **`stripForkSuffix` translates `*-fork → upstream` for codegen + KnownDeployment lookups** —
  dapp-kit sees the real `'mainnet'` (`engine/network.ts:126-133`; tests:
  `services/sui.fork.test.ts:98`).
- **`isLocalLikeNetwork` returns true for `'localnet'` + every `*-fork`** — used by state-store
  routing, snapshot resolveStackPaths, service-paths to decide between per-stack and per-network
  state (`engine/network.ts:109-111`; tests: `services/sui.fork.test.ts:78`).
- **`resolveDeploymentNetwork` returns `undefined` for localnet** — no canonical deployment. Tested
  in `engine/known-package.fork.test.ts:40`.
- **`KnownPackage` seedObjects accumulator MUST be cleared between composes** —
  `clearKnownPackageSeedObjects()` called at top of `devstack(...)` compose
  (`services/known-package.ts:69-74`; tests: `engine/known-package.fork.test.ts:115`).
- **Per-stack docker network name MUST include the network suffix for non-localnet** —
  `<app>-<stack>-sui-network-<network>` prevents collision between two stacks of the same app on
  different chains (`services/sui.ts:369-379,1596-1606`).
- **Two parallel `forkHarness` instances against different upstreams MUST produce different
  chainIds** — the load-bearing assertion that parallel forks don't accidentally share chain state
  (`engine/sui-fork/parallel.docker.test.ts:131-146`).

### Probes

- **`ChainProbe` default accessors return `undefined` for both "not found" and transient RPC
  failure** — over-derive on the next cycle rather than fail boot. Matches `withCache`'s convention
  (`engine/chain-probe.ts:135-140,276`). Strict variants distinguish via `ProbeError`.
- **`ChainProbeLive` is folded into every `Sui()` member's `__layers` ring** — every
  `onChainArtifact` finds it at acquire time without rewiring (`services/sui.ts:1992-1993`,
  `engine/on-chain-artifact.ts:272-275`).

## Failure modes

### Build / publish

- **`sui` binary not on PATH** — `ENOENT` on spawn. `suiCliError` formats a setup-actionable message
  pointing at `https://github.com/MystenLabs/sui/releases` (`engine/sui-cli.ts:74-91`). Recovery:
  install sui or compose the localnet container (which provides `SuiBuildImage`).
- **Build container `docker start` fails with "No such container"** (Bug C) — TOCTOU race: prior
  finalizer rm'd between inspect and start. `ensureContainer` falls back to `docker run -d`
  (`engine/sui-build-container.ts:174-187`; test: `engine/sui-build-container.test.ts:513`).
- **Build container `docker start` fails for non-TOCTOU reason** — daemon outage, perms, etc. The
  SuiBuildContainer rejects the helper's recreate promotion and surfaces as
  `SuiCliError({phase: 'docker start (build container)'})` (`engine/sui-build-container.ts:174-187`;
  test: `engine/sui-build-container.test.ts:552`).
- **Build container `docker run -d` fails with name collision** (Bug H) — peer beat us; helper
  adopts via `docker start` (`engine/sui-build-container.ts:157`; test:
  `engine/sui-build-container.test.ts:589`).
- **Move build lock timeout** (5 minutes) — `SuiError({phase: 'sui move build'})` naming pid +
  host + suggesting `rm <lockPath>` for manual cleanup (`engine/sui-build-container.ts:353-363`).
- **Stale `.git/index.lock` blocks build** — `sweepStaleGitLocks` removes 0-byte files older than
  60s during acquire. If the lock survives (fresh lock from concurrent process), the build fails
  with sui's verbatim stderr; `appendStaleGitLockHint` appends a recovery recipe pointing at
  `pnpm devstack doctor --clean-locks` or manual `rm ~/.move/git/<repo>/.git/index.lock`
  (`engine/sui-cli.ts:489-514`).
- **`hostPath` outside bind-mounted appDir** — `SuiBuildContainer.runBuild` returns typed
  `SuiError({phase: 'SuiBuildContainer.runBuild'})` instructing caller to fall back to
  `docker run --rm`. `buildMove` checks `canExec(hostPath)` first and auto-falls-back when false
  (`engine/sui-build-container.ts:684-693`; test: `engine/sui-build-container.test.ts:729`).
- **Build exits non-zero** — full stderr + stdout routed through `Effect.logError`, then
  `SuiCliError({phase: 'sui move build', exitCode, stderr, stdout})` (`engine/sui-cli.ts:194-215`).
- **JSON parse fails on non-zero exit fallthrough** — `extractTrailingJson` returns last
  `{`-terminated chunk; `parseJson` maps decoding failure into `SuiCliError`.

### Localnet

- **Image build fails** — `DockerError` from `dockerImage`, mapped at the calling layer.
- **Postgres sidecar fails ready probe** — `SuiError({phase: 'postgres-up'})`
  (`services/sui.ts:923-944`). pg_isready exec failure → `phase: 'indexer-ready'`
  (`services/sui.ts:531-550`).
- **Localnet container ready probe times out** (default 60s) — `SuiError({phase: 'ready-probe'})`
  message naming which of rpc/faucet/graphql never succeeded individually + last
  `Docker.dockerLogsTail` (`services/sui.ts:1120-1141`).
- **`fetchChainId` times out** (30s) — `SuiError({phase: 'fetch-chainId'})`
  (`services/sui.ts:489-513`).
- **Faucet returns body-level `{Failure: ...}` despite HTTP 200** — `waitForTransactionsReady`
  retries every 2s for 90s, then `SuiError({phase: 'wait-for-transactions-ready'})` with explicit
  recovery recipe (`devstack wipe --yes && devstack up`) and root cause hint ("validator mid-genesis
  on cold start" / "unclean prior shutdown") (`services/sui.ts:434-464`; tests:
  `services/sui.test.ts:274,300,314`).

### Fork

- **Data-dir lock contention** — `SuiError({phase: 'fork-lock'})` naming holder pid + host +
  instanceId (`engine/sui-fork/file-lock.ts:30-48`; test: `engine/sui-fork.lock.test.ts:55`).
- **Stale lock (dead PID)** — `acquireForkDataLock` reclaims; second acquire succeeds
  (`engine/sui-fork.lock.test.ts:89`).
- **`meta.json` configHash mismatch** — `SeedManifestMismatchError({metaPath, previous, current})`
  with actionable recipe (`devstack wipe --keep-upstream-cache && devstack apply`)
  (`engine/sui-fork/meta.ts:237-261`; test: `engine/sui-fork/meta.test.ts:171`).
- **Corrupt meta.json** — treated as first boot; `readForkMeta` returns `undefined`,
  `ensureForkMetaConsistent` writes a fresh one (`engine/sui-fork/meta.ts:172-177`; test:
  `engine/sui-fork/meta.test.ts:298`).
- **Fork ready-probe timeout** (default 180s) — `SuiError({phase: 'ready-probe'})` with hint about
  cold-start GraphQL warming (`services/sui.ts:1827-1850`).
- **`forkGuard`-rejected surface** — `ForkUnsupportedError({surface, message, hint})` thrown
  synchronously (`services/sui.ts:1464-1494`; test: `services/sui.fork.test.ts:18`).
- **`executeImpersonated` tx failure** — `SuiError({phase: 'fork-impersonate'})` carrying the
  response's error message (`services/sui/impersonate.ts:178-188`).
- **`advanceClock` failure during auto-tick** — log WARN; next tick continues
  (`engine/sui-fork/control.ts:121-147`; test: `engine/sui-fork/control.test.ts:202`).
- **Subscription stream errors** — `subscribeCheckpointsWithFallback` falls back to 2s polling
  indefinitely (`engine/sui-fork/control.ts:272-286`; tests:
  `engine/sui-fork/control.test.ts:256,301`).
- **Variant composed against incompatible mode** — `ForkIncompatibleError({variant, network, hint})`
  raised at factory time by `walrusLocalCluster()` / `sealLocalKeygen()` on a `*-fork` network
  (`engine/errors.ts:91-121`). (NOTE: this error class lives in the sui-scope file because the gate
  fires at sui-fork composition time, but the consumers are Walrus / Seal.)

### Chain probe

- **`getObject` RPC error matching `/not\s*found|NOT_FOUND/i`** — lenient `getObject` returns
  `undefined` (`engine/chain-probe.ts:246-253`).
- **`getObject` RPC error otherwise** — lenient returns `undefined`; strict raises
  `ProbeError({surface: 'getObject'})` (`engine/chain-probe.ts:253-260`; test:
  `engine/chain-probe.test.ts:135`).
- **Schema validation failure** —
  `ProbeError({surface: 'getObject', message: 'schema validation failed: ...'})`
  (`engine/chain-probe.ts:263-272`).
- **Partial SDK mock without `core.getTransaction`** — `getTransaction` returns `undefined`
  defensively (`engine/chain-probe.ts:300-304`; test: `engine/chain-probe.test.ts:305`).

## Persistence model

### Survives restart (between cycles within one supervisor lifecycle)

- localnet: `/root/.sui` (writable container layer — chain state) + `/pgdata` (writable container
  layer — indexer schema + rows). Container is `docker stop`'d (not rm'd) at teardown.
- fork: `<appDir>/.devstack/stacks/<stack>/sui-fork/data/` (writable host bind-mount — RocksDB) +
  `meta.json` + shared upstream cache `<appDir>/.devstack/sui-fork-cache/<chainId>/`. Container is
  `docker stop`'d.
- Build container: just the sleeper process + bind-mounted views (no own state). Container is
  `docker rm -f`'d at scope teardown.
- `~/.move/git/<repo>/` — content-addressed SHA-keyed git deps cache. Survives ALL restarts AND ALL
  wipes (it's a host-wide cache, not stack-scoped).

### Survives snapshot (subset of persisted, captured by `docker commit`)

- localnet: chain state + indexer state (both ride the writable layer).
- fork: per-stack data dir + meta.json (bind-mounts captured separately by snapshot save).

### Wiped on `devstack wipe`

- `<appDir>/.devstack/stacks/<stack>/sui-fork/{data,data.lock,meta.json}` — per-stack fork state.
- localnet's per-stack docker network (orphan sweeper).
- The sui-localnet / sui-indexer-db / sui-fork containers (full rm).
- The `devstack-<app>-build` sleeper container (full rm).
- The build-container's docker rm finalizer fires regardless of wipe vs normal teardown.
- `~/.move/git/<repo>/.git/{index,HEAD,config,shallow,packed-refs,sparse-checkout}.lock` if matched
  by sweepStaleGitLocks (`engine/sui-build-container.ts:480-521`).
- The shared `.devstack/sui-fork-cache/` survives a plain `wipe`;
  `devstack wipe --also-upstream-cache` nukes it; `devstack fork cache prune --unreferenced`
  selectively drops unreferenced chainIds.

### Process-local only

- The `KnownPackage` `accumulatedSeedObjects: Set<string>` module-scope state
  (`services/known-package.ts:59`).
- The `EffectRef<Set<ProbeKey>>` ready-probe tracker (`services/sui.ts:1078`).
- The `waitForTransactionsReady` `Effect.cached` memoization (`services/sui.ts:475`).
- The `Sui.fork.autoTickMs` knob — ephemeral on the in-memory `ForkControl`, but the resolved
  cadence IS persisted to `meta.json` via `runtime.autoTickMs`.

## Modes & variants

The Sui factory has three first-class modes and a degenerate "external RPC" sub-mode of local.
Below: one column per mode, one row per lifecycle dimension. Citations in cells reference
`services/sui.ts` unless prefixed otherwise.

| Dimension                          | **local (container)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **local (external RPC)**                                                                                                                                                                                                                                | **live (testnet / mainnet / custom)**                                                                                                                                                                                                             | **fork (mainnet-fork / testnet-fork / devnet-fork)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Container**                      | Vendored `images/sui/`. `dockerImage({build: {context, dockerfile, buildArgs: {SUI_VERSION}}})` (`L755-764`), default `SUI_VERSION = 'devnet-v1.71.0'` (`L91`). Plus indexer-db sidecar (vendored `images/postgres/` with PGDATA relocated to `/pgdata`, `L777-784`).                                                                                                                                                                                                                                                                                                                                                                              | None — caller pre-booted their own `sui` and supplies `rpcUrl`. `L792-835`.                                                                                                                                                                             | None — wraps `https://fullnode.{testnet,mainnet}.sui.io:443` or custom RPC.                                                                                                                                                                       | Vendored `images/sui-fork/`. `dockerImage({build: {context, dockerfile, buildArgs: {SUI_REV}}})` (`L1620-1632`), default `SUI_REV = '259b947bf5b07cded7481c0c1f5e88470939c930'` (`L116`). The Dockerfile cargo-builds a `sui-fork` binary from the pinned `MystenLabs/sui` commit, ALSO ships the matching `sui` binary, so move builds can `docker exec` into the same image. NO postgres sidecar (no indexer in fork mode).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Startup sequence**               | 1. resolve image (build if needed); 2. mint per-stack docker network `<app>-sui-network`; 3. start indexer-db sidecar with `stopGraceSeconds: 20`; 4. `awaitIndexerDbReady` via `docker exec pg_isready` (exp backoff, 30s budget); 5. start sui-localnet container with `args: ['start', '--with-faucet=0.0.0.0:9123', '--with-indexer=<dbUrl>', '--with-graphql=0.0.0.0:9125']`, `stopGraceSeconds: 30`, `expectedExitCodes: [137]`, routing entries for sui/faucet/graphql; 6. concurrent ready probes for rpc + faucet + graphql; 7. publish endpoints; 8. fetch chainId; 9. publish sui state; 10. build `waitForTransactionsReady` (cached). | 1. wrap supplied URLs; 2. publish endpoints conditionally; 3. fetch chainId from supplied rpcUrl; 4. publish sui state; 5. build `waitForTransactionsReady` (only if faucetUrl). NO container, NO docker network, NO build container, NO SuiBuildImage. | 1. instantiate `SuiGrpcClient` with default-or-overridden URLs; 2. publish endpoints; 3. fetch chainId (30s timeout); 4. publish sui state; 5. build `waitForTransactionsReady` (testnet: yes; mainnet: no — `L1344`; custom: only if faucetUrl). | 1. resolve router entrypoint `sui-grpc`; 2. acquire data-dir lock (`acquireForkDataLock` — `L1655`); 3. derive seedObjects by unioning user-supplied with `collectKnownPackageSeedObjects()` (`L1673`); 4. read existing meta (`L1686`) + resolve `autoTickMs` via `resolveResumeAutoTickIntervalMs` (P5.5.4); 5. `ensureForkMetaConsistent` (`L1693`) — may raise `SeedManifestMismatchError`; 6. resolve image (build if needed); 7. mint per-stack docker network `<app>[-<stack>]-sui-fork-network-<network>`; 8. set env `SUI_FORK_NETWORK`, `SUI_FORK_RPC_ADDR=0.0.0.0:9000`, optionally `SUI_FORK_CHECKPOINT`, `SUI_FORK_SEED_ADDRS`, `SUI_FORK_SEED_OBJS`; 9. `runDockerContainer` with `routing: [{name: 'sui', entrypoint: 'sui-grpc', servicePort: 9000, protocol: 'h2c'}]`; 10. ready probe via `forkingService.getStatus({})` retried every 2s up to 180s; 11. publish endpoints (RPC only — no faucet/graphql); 12. fetch chainId; 13. publish sui state; 14. wrap client with `forkGuard` Proxy; 15. (conditional) start auto-tick fiber. |
| **Ready criteria**                 | All three of rpcProbe (`client.core.getChainIdentifier()`), faucetProbe (GET / returning < 500), graphqlProbe (POST `{ chainIdentifier }`) succeed concurrently in one iteration. Default 60s, per-fetch 3s timeout. Diagnostic: per-probe `Set<ProbeKey>` tracker names laggards on timeout. `L1077-1142`.                                                                                                                                                                                                                                                                                                                                        | `fetchChainId` succeeds (30s timeout).                                                                                                                                                                                                                  | `fetchChainId` succeeds.                                                                                                                                                                                                                          | `forkingService.getStatus({})` round-trip succeeds. Default 180s, per-attempt 2s spacing. `L1820-1850`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Persistence**                    | `/root/.sui` (chain state) + `/pgdata` (indexer schema/rows) in writable container layer. Survives `docker stop`/start. Captured by `docker commit` for snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | None — externally managed; devstack neither captures nor wipes.                                                                                                                                                                                         | None — public chain.                                                                                                                                                                                                                              | `<appDir>/.devstack/stacks/<stack>/sui-fork/data/` (bind-mounted) + `<appDir>/.devstack/stacks/<stack>/sui-fork/meta.json` + `<appDir>/.devstack/stacks/<stack>/sui-fork/seed-manifest.json` (written by sui-fork itself). Shared `<appDir>/.devstack/sui-fork-cache/<chainId>/`. The fork container ALSO has its own writable layer for the binary's runtime state, but the load-bearing chain state lives in the bind-mount.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Teardown**                       | `docker stop` (with 30s grace, terminates via SIGKILL → exit 137). Network torn down by `networkCreate`'s scope finalizer. NOT `docker rm`'d — writable layer kept for next `up`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | None — caller owns the externally-managed lifecycle.                                                                                                                                                                                                    | None — public chain.                                                                                                                                                                                                                              | `docker stop` (sui-fork registers SIGINT properly; clean shutdown). Auto-tick fiber dies via scope close. Data-dir lock released via `releaseLockSync` finalizer. Network finalized.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Dependencies on other services** | `Identity`, `ChildProcessSpawner`, `FileSystem` (transitive), `EndpointRegistry`, `SuiStateRegistry`, `routerEntrypoint('sui-rpc'/'sui-faucet'/'sui-graphql')`. Indexer-db sidecar is in-stack.                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `Identity`, `ChildProcessSpawner`, `EndpointRegistry`, `SuiStateRegistry`.                                                                                                                                                                              | Same as external-RPC localnet.                                                                                                                                                                                                                    | `Identity`, `ChildProcessSpawner`, `FileSystem`, `EndpointRegistry`, `SuiStateRegistry`, `routerEntrypoint('sui-grpc')`. ALSO consults the process-scope `accumulatedSeedObjects` from `KnownPackage` decls (`L1673`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Hard requirements**              | `expectedExitCodes: [137]` (PID-1-blocks-SIGINT trace); PGDATA relocation; per-stack network; build-image layer wired only when not external-RPC; ready ≠ funds-transferable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Caller's URLs must be valid + reachable in 30s.                                                                                                                                                                                                         | URLs must be reachable; for mainnet `faucet` is intentionally absent.                                                                                                                                                                             | Data-dir lock acquired (R5); meta consistency gate run (R6); `forkGuard` Proxy applied to client (R1); default gas budget for impersonated txs (R3); cache GC is manual (settled 2026-05-19); fork's chain id is the upstream's REAL chainId (`L1855-1860`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Failure modes**                  | `network-create`, `postgres-up`, `indexer-ready`, `sui-up`, `ready-probe` (with last `dockerLogsTail`), `fetch-chainId` (30s timeout), `wait-for-transactions-ready` (90s budget, body-Failure detection).                                                                                                                                                                                                                                                                                                                                                                                                                                         | `fetch-chainId` only.                                                                                                                                                                                                                                   | `fetch-chainId` only (no ready-probe).                                                                                                                                                                                                            | `fork-lock` (lock busy), `fork-meta` / `SeedManifestMismatchError`, `network-create`, `sui-up`, `ready-probe` (with cold-start hint), `fetch-chainId`. Per-RPC: `fork-status`, `fork-advance-clock`, `fork-advance-checkpoint`, `fork-impersonate`, `fork-unsupported`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **RPC source**                     | In-stack sui-localnet binary serving JSON-RPC + gRPC + GraphQL on the same container. URLs go through the shared Traefik router.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Caller-supplied URL string.                                                                                                                                                                                                                             | Public Mysten fullnode (or custom).                                                                                                                                                                                                               | In-stack sui-fork binary serving `sui.rpc.v2.*` (data plane) AND `sui.forking.v1alpha.ForkingService` (admin) AND `sui.subscriptions.v1alpha.SubscriptionService` ALL on the same gRPC listener on port 9000 (`L100-104`). h2c through Traefik. NO JSON-RPC, NO GraphQL, NO faucet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Genesis**                        | sui-localnet binary generates fresh genesis on first boot. ChainId is the resulting checkpoint-0 digest (a localnet-specific value, not stable across rebuilds).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | N/A (caller owns).                                                                                                                                                                                                                                      | N/A (upstream chain).                                                                                                                                                                                                                             | sui-fork inherits genesis from the wrapped upstream (mainnet / testnet / devnet) at the specified checkpoint anchor. ChainId is the upstream's REAL chainId — dapp-kit MVR + wallet-standard validation think they're talking to the real chain (which they essentially are, at a frozen checkpoint). `L1855-1860`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Fork-specific data flow**        | N/A.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | N/A.                                                                                                                                                                                                                                                    | N/A.                                                                                                                                                                                                                                              | The seed-manifest is written ONCE by sui-fork on first boot (`crates/sui-fork/src/seed.rs:128,144,153`). Subsequent boots resume from it. Devstack mirrors this contract at the supervisor layer via `meta.json` so config drifts surface as actionable `SeedManifestMismatchError` BEFORE the binary panics. Snapshot save captures both data dir AND meta.json. On restore, both are restored together. The `KnownPackage(opts).seedObjects` from every composed-before-`Sui()` declaration is auto-merged into the fork's `--object` seed flags (`L1673-1677`). `knownDeployments[deepbook                                                                                                                                                                                                                                                                                                                                                                                                                                                            | walrus | seal][resolveDeploymentNetwork(network)]`returns the wrapped upstream's real on-chain addresses —`Deepbook()`/`Walrus()`/`Seal()`on fork mode auto-pick this path;`\*LocalCluster`variants raise`ForkIncompatibleError`. |

## Test coverage

For each in-scope test file, exhaustive describe / it enumeration.

### `engine/sui-cli.test.ts` (319 LOC)

- `describe('stripPinnedSections')`:
  - `it('strips v4-flat [pinned.<env>.<pkg>] sections')` — `[pinned.testnet.X]`,
    `[pinned.mainnet.Y]`-style sections removed wholesale.
  - `it('strips legacy [env] and [env.<name>] sections')` — pre-v4 lockfile shape coverage.
  - `it('strips both pinned and env sections from a mixed file, preserves the rest verbatim')` —
    interleaved sections, no leakage.
  - `it('is idempotent: stripping a scrubbed file returns the same string')` — re-running the scrub
    is a no-op.
  - `it('matches headers tolerantly of leading whitespace (tabs and spaces)')` — whitespace before
    `[` is tolerated.
  - `it('leaves a file without any pinned/env sections unchanged')` — happy-path identity.
- `describe('shellQuote')`:
  - `it('wraps a plain string in single quotes')`.
  - `it('wraps a string containing spaces in single quotes (POSIX argv split-prevention)')`.
  - `it('escapes a single embedded apostrophe via the close/escape/reopen trick')`.
  - `it('escapes multiple apostrophes in a single string')`.
  - `it('passes shell metacharacters through verbatim inside the quote')`.
  - `it('blocks command injection via embedded apostrophe + shell construct')` — security-shaped
    invariant test.
  - `it('handles an empty string as a present-but-empty argv slot')`.
- `describe('buildMove — concurrent funnel serialization')`:
  - `it.live('two concurrent buildMove calls serialize their build spawns')` — `it.live` (not
    `it.effect`) — asserts the host-wide cross-process move-build lock serializes two parallel
    `buildMove` invocations against the same `~/.move`.

### `engine/sui-build-container.test.ts` (751 LOC)

- `describe('containerNameFor')`:
  - `it('produces \`devstack-<app>-build\` per the user-facing contract')`.
  - `it('does not include the network or stack dimension')` — intentional sharing across
    stack/network within an app.
- `describe('toContainerPath')`:
  - `it('translates an in-appDir path to \`/host/<rel>\`')`.
  - `it('handles deep nesting under the app dir')`.
  - `it('returns undefined when hostPath escapes the app dir (parent reference)')` — `..` rejection.
  - `it('returns undefined when hostPath is an unrelated absolute path')`.
  - `it('returns \`/host\` when hostPath equals appDir itself')`.
- `describe('sweepStaleGitLocks')`:
  - `it('removes stale \`.git/index.lock\` and \`info/sparse-checkout.lock\` whose mtime exceeds the
    safety window')`.
  - `it('leaves fresh lock files alone (real in-flight git op)')` — 60s safety window.
  - `it('removes stale sui-cli per-repo lock sentinels (\`.<repo>.lock\` at the \`git/\` root)')`.
  - `it('leaves non-\`.lock\` dotfiles at the \`git/\` root untouched')`.
  - `it('returns empty when \`<moveHome>/git/\` does not exist')` — missing-root tolerance.
- `describe('SuiBuildContainerLive — adopt-or-create')`:
  - `it.effect('creates a fresh detached container when none exists with that name')` — happy-path
    fresh.
  - `it.effect('adopts an existing running container with the SAME image (no run / no start)')` —
    resume hit.
  - `it.effect('starts a stopped container with the SAME image via \`docker start\` (no run)')`.
  - `it.effect('rms + recreates when an existing container is running a DIFFERENT image')` — image
    drift.
  - `it.effect('registers a \`docker rm -f\` finalizer that fires on scope close')`.
- `describe('SuiBuildContainerLive — race recovery')`:
  - `it.effect('Bug C: falls back to fresh \`docker run -d\` when \`docker start\` reports container
    missing')` — TOCTOU.
  - `it.effect('Bug C: an unrelated \`docker start\` failure surfaces as a typed error (no silent
    fallback)')` — fail-loud on daemon outage.
  - `it.effect('Bug H: falls back to \`docker start\` when \`docker run -d\` reports a name
    collision')`.
  - (Fourth race-recovery test — see file:637.)
- `describe('SuiBuildContainer.runBuild')`:
  - `it.effect('issues \`docker exec <name> sh -c <inner>\` with the translated container path')`.
  - `it.effect('two sequential runBuild calls both succeed (lock released between)')`.
  - `it.effect('runBuild fails (typed) for a hostPath outside the bind-mounted app dir')`.

### `engine/sui-helpers.test.ts` (257 LOC)

- `describe('pickCreatedByType — suffix filter')`: 3 cases (match, miss, mutated-changes ignored).
- `describe('pickCreatedByType — includes filter')`: 2 cases.
- `describe('pickCreatedByType — prefix filter (first match)')`: 1 case.
- `describe('pickCreatedByType — prefix filter (all: true)')`: 3 cases including owner-propagation +
  empty-on-no-match.
- 4 gRPC-normalisation cases (prefix / suffix / includes against long-form addresses).
- `describe('parseCoinTypeFromGeneric')`: 7 cases — TreasuryCap, CoinMetadata, leading-zero
  addresses, gRPC long-form, wrong-wrapper rejection, nested-generic rejection, malformed-inner
  rejection.

### `engine/sui-fork/control.test.ts` (325 LOC)

- `describe('engine/sui-fork/control')`:
  - `describe('resolveAutoTickIntervalMs (P5.5.1)')`: undefined/false → undefined; true → 1000;
    custom intervalMs honored; rejects 0/negative/non-finite.
  - `describe('resolveResumeAutoTickIntervalMs (P5.5.4)')`: saved value used when option absent;
    fresh option (`true`, explicit intervalMs, explicit `false`) wins; corrupt saved values ignored.
  - `describe('runAutoTickClock (P5.5.2)')`:
    `it.live('fires advanceClock on the configured cadence and dies on scope teardown')`;
    `it.live('logs + keeps ticking on advance-clock failure (failure policy)')`.
  - `describe('subscribeCheckpoints (P5.10.T1)')`:
    `it.effect('emits one event per upstream SubscribeCheckpointsResponse')`.
  - `describe('subscribeCheckpointsWithFallback (P5.10.T2)')`:
    `it.live('falls back to polling when the subscription stream errors')`.
  - `describe('pollCheckpoints')`:
    `it.live('dedupes repeated cursors (only emits when sequence advances)')`.

### `engine/sui-fork/meta.test.ts` (344 LOC)

- `describe('computeConfigHash (P4.15)')`: stable across address ordering; stable across object
  ordering; case-insensitive on addresses+objects; flips when checkpoint changes; flips when
  upstream changes; ignores runtime-shaped extras (autoTickMs not part of contract — P5.5.4).
- `describe('ensureForkMetaConsistent (P4.16)')`:
  - `it.effect('writes meta.json on first boot')`.
  - `it.effect('no-ops on identical second boot')`.
  - `it.effect('P4.T5 raises SeedManifestMismatchError when configHash changes')`.
  - `it.effect('P5.5.4: persists runtime.autoTickMs across first-boot write')`.
  - `it.effect('P5.5.4: configHash unchanged when only autoTickMs changes (no mismatch)')`.
  - `it.effect('P5.5.4: clearing runtime drops the key on the persisted shape')`.
  - `it.effect('treats corrupt meta.json as first boot')`.
- `describe('readForkMeta')`:
  - `it.effect('returns undefined when file missing')`.
- `it.effect('FileSystem is the live node service')` — wiring check.

### `engine/sui-fork/parallel.test.ts` (158 LOC)

- `describe('engine/sui-fork parallel-stacks invariants (P5.6.1)')`:
  - `describe('per-stack path partitioning (P5.6.2)')`: distinct data dirs; distinct meta.json
    paths; implied data.lock paths stack-keyed.
  - `describe('per-upstream config hash partitioning (P5.6.3)')`: same-stack + different-upstream →
    different configHash; different upstream + different checkpoint still distinct; same-upstream +
    same-checkpoint converges (cache-key parity).
  - `describe('cross-product (different stack + different upstream)')`: 4 distinct dimensions
    partition independently.

### `engine/sui-fork/parallel.docker.test.ts` (175 LOC)

Gated by `RUN_FORK_DOCKER_TESTS=1`. Boots two `forkHarness` instances concurrently.

- `it.effect('P5.6.2: two stacks against the same upstream (testnet) boot concurrently and surface distinct host URLs')`
  — 600s timeout.
- `it.effect('P5.6.3: two stacks against different upstreams (mainnet + testnet) coexist')` —
  asserts distinct chainIds via `getChainIdentifier`.
- `it.effect('P5.T3: parallel harnesses tear down cleanly without leaking containers')` — 900s
  timeout.

### `engine/sui-fork.lock.test.ts` (143 LOC)

- `describe('sui-fork: P1.T7 data-dir file lock')`:
  - `it('happy path: acquire succeeds in an empty directory')` — verifies file exists during scope,
    is unlinked after.
  - `it('contention: second acquire fails with SuiError({phase: fork-lock})')` — walks v4
    `Cause.reasons` for Fail reason.
  - `it('stale reclaim: acquire succeeds when on-disk holder PID is dead')` — same-host dead-PID
    body reclaim.

### `engine/sui-fork.container.docker.test.ts` (151 LOC)

Gated by `RUN_FORK_DOCKER_TESTS=1` + `dockerOk()` runtime check. Uses `forkHarness`.

- `it.effect('P1.T1: image builds, container starts, gRPC port responds')` — asserts
  `forkedAtCheckpoint === TEST_TESTNET_CHECKPOINT` and `containerId` is a hex hash. 300s timeout.
- `it.effect('P1.T2: ready-probe passes once container is ready')` — harness resolution IS the
  assertion.
- `it.effect('P1.T3: sui.fork.advanceClock(60_000) advances the clock by 60s')` — diff `timestampMs`
  before/after.
- `it.effect('P1.T4: sui.fork.advanceCheckpoint increments checkpointSequenceNumber')`.
- `it.effect('P1.T6: ForkUnsupportedError carries surface + hint for unsupported gas surfaces')` —
  typed-error wiring check (doesn't exercise wire).

### `engine/fork.e2e.docker.test.ts` (20 LOC)

- `describe.skipIf(!SHOULD_RUN)('engine fork end-to-end docker gate (P4.T11)')`:
  - `it('apply → up → snapshot save → wipe → snapshot restore → down on mainnet-fork')` — 5min
    timeout. **Currently a placeholder** — body `expect(SHOULD_RUN).toBe(true)`; comment "Pending
    docker wiring".

### `engine/known-package.fork.test.ts` (125 LOC)

- `describe('Phase 3 P3.T1 — KnownPackage + fork-aware deployment lookup')`:
  - `describe('resolveDeploymentNetwork')`: maps fork variants to upstream KnownNetwork keys; passes
    live nets through; returns undefined for localnet; drives lookups (mainnet-fork → real walrus
    deployment; testnet-fork → testnet deepbook).
  - `describe('KnownPackage seedObjects accumulator (P3.7)')`: records seedObjects for fork's
    `--object` flags; deduplicates across multiple declarations; no-op when omitted;
    `clearKnownPackageSeedObjects()` resets.

### `engine/chain-probe.test.ts` (338 LOC)

- `describe('ChainProbe.getObject (live layer — Schema-validated parsing)')`:
  - `it.effect('parses an AddressOwner response and normalizes the owner')`.
  - `it.effect('normalizes Shared owner kind')`.
  - `it.effect('normalizes Immutable owner kind')`.
  - `it.effect('lenient getObject returns undefined when the RPC says NOT_FOUND')`.
  - `it.effect('lenient getObject returns undefined on transient RPC failure')`.
  - `it.effect('strict getObjectStrict raises ProbeError on a transient RPC failure')`.
  - (One more case at L152 — schema validation related.)
- `describe('ChainProbe.objectsMatchTypes (helper composition)')`:
  - 4 `it.effect` cases — every id matches → true; missing id → false; type mismatch → false; custom
    match predicate honoured.
- `describe('ChainProbe.getTransaction (live layer)')`:
  - `it.effect('returns the digest when the SDK resolves a transaction')`.
  - `it.effect('returns undefined on RPC failure')`.
  - `it.effect('returns undefined when the SDK client omits getTransaction (partial mock)')`.
- `describe('ProbeError')`: `it('is a Schema-tagged error with surface/message fields')`.

### `engine/on-chain-artifact.test.ts` (391 LOC)

- `describe('onChainArtifact (substrate composition)')`:
  - `it.effect('cache miss → produce + register + return')`.
  - `it.effect('cache hit + verify-success → no produce, register still runs')`.
  - `it.effect('cache hit + verify-undefined → evict + produce + register')`.
  - `it.effect('register undefined → no register call')`.
  - `it.effect('upstream record values flow as \`deps\` to every callback')`.
  - `it.effect('verify receives the ChainProbe service in deps args')`.
- `describe('onChainArtifact (tag shape + upstream auto-flatten)')`:
  - `it('auto-flattens upstream record values into __upstreamKeys')`.
  - `it('conditional undefined upstream entries are dropped from __upstreamKeys')`.
  - `it('stamps plugin / kind / displayTitle through to the LayeredTag')`.
  - `it("defaults kind to 'action' when not specified")`.

### `services/sui.test.ts` (331 LOC)

Stubs `getChainIdentifier` via
`vi.spyOn(grpcCoreProto, 'getChainIdentifier').mockResolvedValue(...)`. NO docker — localnet
container path is integration-tested via examples.

- `describe('Sui(opts?) factory shapes')`:
  - `it.effect("Sui({ network: 'testnet' }) defaults to the well-known testnet endpoints")`.
  - `it.effect("Sui({ network: 'testnet', testnet: { rpcUrl } }) override wins over the default")`.
  - `it.effect("Sui({ network: 'mainnet' }) defaults to mainnet rpc with NO faucet")`.
  - `it.effect('Sui({ network: { rpc } }) carries an explicit RPC through to Sui')`.
  - `it.effect("Sui({ network: 'mainnet' }).waitForTransactionsReady() resolves immediately")`.
  - `it.effect('Sui({ localnet: { rpcUrl, graphqlUrl } }) surfaces graphqlUrl on SuiTag')`.
  - `it.effect('Sui({ localnet: { rpcUrl } }) without graphqlUrl leaves it undefined')`.
  - `it.effect('Sui({ network: { rpc } }) without a faucet skips the ready probe')`.
- `describe('faucetReadyProbe')`:
  - `it.effect('rejects a 200 OK body with status: { Failure }')`.
  - `it.effect('resolves cleanly on a `status: "Success"` body')`.
  - `it.effect('rejects a non-OK HTTP status (e.g. 503 during boot)')`.
- `describe('EndpointName.SUI_CHECKPOINT_VOLUME (P2.T6)')`:
  - `it('uses the conventional name format')`.

### `services/sui.fork.test.ts` (154 LOC)

- `describe('sui-fork: P1.T5 todo-guard (forkGuard Proxy)')`:
  - `it('throws ForkUnsupportedError synchronously for getBalance / listBalances / getCoinInfo')` —
    re-implements the guard locally and verifies the contract; checks `.surface` + `.hint`.
- `describe('sui-fork: P1.T8 network type widening')`:
  - `it('isLocalLikeNetwork identifies localnet + every *-fork variant')`.
  - `it('isLiveNetwork is the negation of isLocalLikeNetwork for known networks')`.
  - `it('stripForkSuffix translates fork variants to their upstream and leaves others alone')`.
  - `it('isKnownNetwork validates fork variants')`.
  - `it('resolveNetwork accepts fork variants from the env (Phase 3 plugin dispatch)')`.
- `describe('sui-fork: P1.T8 state-store routes fork variants per-stack')`:
  - `it('state-store path for a *-fork stack lands under .devstack/stacks/<stack>/')` —
    predicate-level (state-store internal not directly reached).

## Pain points today

- **`services/sui.ts` is ~2000 LOC** with 4 sibling per-network builders + a fork builder, all
  sharing constants, helpers, and the chain-id-fetch pipeline. The builders share boilerplate (each
  does `publishEndpoint(...)` + `fetchChainId` + `publishSuiState`) but their bodies diverge enough
  that a naive extraction would be lossy. Splitting into
  `services/sui/{localnet,live,fork,custom}.ts` is a natural cut.
- **Move build container is `(app, stack)`-keyed via a flat `devstack-<app>-build` name**
  (`engine/sui-build-container.ts:122`), intentionally network-AND-stack-agnostic. Two stacks of the
  same app share one container — concurrent Move builds across stacks SERIALIZE through
  `docker exec` queueing. The trade-off was settled as accepted, but the comment-block calls it out
  as a known limitation (`engine/sui-build-container.ts:108-115`).
- **`fork.e2e.docker.test.ts:13` is a placeholder body** with `expect(SHOULD_RUN).toBe(true)` and
  comment "Pending docker wiring". The P4.T11 full lifecycle integration (apply → up → snapshot save
  → wipe → snapshot restore → down) is NOT actually tested.
- **`TEST_TESTNET_CHECKPOINT = 50_000_000` is admitted as a placeholder** in the testkit
  (`engine/sui-fork.testkit.ts:49-56`) — "verify a recent testnet checkpoint before merging."
- **`DEFAULT_SUI_FORK_REV` is duplicated** in `services/sui.ts:116` and
  `engine/sui-fork.testkit.ts:67`, with a comment noting "bump in lockstep" (`services/sui.ts:108`).
  Drift would silently spend the docker daemon's cache on two images.
- **`knownDeployments` is hardcoded** with an INTEGRITY comment warning that a malicious update
  would silently redirect every consumer (`engine/known-deployments.ts:9-31`). No signed manifest,
  no checksum verification, no automated provenance.
- **`Move.lock` scrub uses awk inside the container** with a printf-driven script staged to
  `/tmp/scrub-move-lock.awk`. Two parallel `runBuild` calls in the same container could race on the
  staging file (though the move-build lock would funnel them). Same code is duplicated in
  `containerBuildCmd` (`engine/sui-cli.ts:289-322`) and `runBuildInside`
  (`engine/sui-build-container.ts:553-579`).
- **`KnownPackage`'s module-scope `accumulatedSeedObjects: Set<string>`**
  (`services/known-package.ts:59`) is a process-global with explicit clear-between-composes
  contract. Two `devstack(...)` calls in the same process (tests) MUST call
  `clearKnownPackageSeedObjects()` at compose start — the responsibility lives in the composer, not
  the factory. Easy to miss.
- **`stripPinnedSectionsFromMoveLock` walks up to 6 parent directories** looking for
  `.devstack/imports/` (`engine/sui-cli.ts:658-669`). Brittle — caps recursion depth to a hardcoded
  constant.
- **`scrubCachedMoveLocks(_packagePath)`** ignores its `packagePath` argument entirely
  (`engine/sui-cli.ts:551-552` — "retained for API symmetry"). Dead parameter.
- **`HostProcessError` is in `errors.ts` but no Sui-scope file imports it** — listed as in-scope for
  this doc because the user mentioned it, but it's actually used by plugin-author primitives
  (`hostScript`), not by Sui directly. Move to the plugin-author doc.
- **`forkGuard` Proxy** intercepts `client.core` at the JS property-access level — there's no
  type-system guarantee that a future SDK API addition won't introduce a fourth unsupported surface
  that isn't in the `FORK_UNSUPPORTED_CORE_SURFACES` Map. Discovery happens at runtime when the user
  composes a fork and hits the new surface.
- **`forkGuard` does NOT cover `executeTransaction`'s auto-gas-budget path** — that's covered
  separately via the `DEFAULT_FORK_GAS_BUDGET` stamp inside `executeImpersonated`
  (`services/sui/impersonate.ts:95`). A direct caller using
  `tx.sign(...).then(signed => client.core.executeTransaction(signed))` on a fork without setting a
  gas budget would still trip `simulate_transaction`'s `"unsupported"`.
  (`services/sui.fork.test.ts:18` covers only the Proxy-rejected surfaces, not the gas-budget path.)
- **`runBuildInside` (`engine/sui-build-container.ts:543`) and `containerBuildCmd`
  (`engine/sui-cli.ts:274`) both emit a slightly different awk script** — the `containerBuildCmd`
  path uses `-maxdepth 4` whereas `runBuildInside` uses the same. Both have the same
  security-hardening lessons (gawk, `-type f`); they should be one helper.
- **The build path inside containers uses `-e testnet --no-tree-shaking`** unconditionally — even
  for fork mode where the upstream is `mainnet-fork` or `devnet-fork`. This is intentional ("the
  build's output bytecode uses symbolic addresses that are resolved at publish time" —
  `engine/sui-cli.ts:331-343`) but easy to misread as a bug.
- **`buildWaitForTransactionsReady` uses `Effect.cached`** to memoize the probe
  (`services/sui.ts:475`). The cache is invalidated by scope close, but there's no manual
  invalidation surface — a user that wants to re-probe after a fork restart can't.

## Open questions

- **Test-side `DEFAULT_SUI_FORK_REV` vs production**: are they ALWAYS the same SHA? The lockstep
  contract is documented but not enforced by code or CI gate. **OPEN QUESTION**: where is the
  cross-file pin verified?
- **`TEST_TESTNET_CHECKPOINT` refresh cadence**: documented as "quarterly" but no calendar, no CI
  alert. **OPEN QUESTION**: how is the staleness tracked?
- **`HostProcessError` in scope**: the user's task explicitly listed it. It's not used by any Sui
  code path in this scope. **OPEN QUESTION**: was that an oversight, or is it expected to be
  referenced indirectly (e.g. when `hostScript` is invoked by tests against host sui)?
- **`fork.e2e.docker.test.ts` placeholder**: when is P4.T11 expected to land? The body just asserts
  `RUN_FORK_DOCKER_TESTS === '1'`. **OPEN QUESTION**: is this intentionally deferred, or is the test
  orchestration code in a separate file?
- **`ChainProbe.getTransaction` defensive partial-mock fallback** (`engine/chain-probe.ts:296-312`):
  the comment says "test mocks may satisfy `Sui` with a minimal `client.core`" — but the partial
  mock is exercised in `chain-probe.test.ts:305`. **OPEN QUESTION**: are there production callsites
  whose mock-`Sui` factories deliberately omit `core.getTransaction`? If so, should the default be
  more permissive?
- **`SuiBuildContainer.canExec` returns `false` for paths outside the bind-mounted app dir**:
  callers fall back to `docker run --rm`, which still uses the cross-process move-build lock. **OPEN
  QUESTION**: is the SuiBuildContainer used at all for moves outside `appDir`, or is this fallback
  the dominant path for vendored Move sources under `.devstack/imports/`?
- **`SuiBuildContainerLive` is only wired when `SuiBuildImage` exists**: localnet external-rpc skips
  it (`services/sui.ts:1244`). Testnet/mainnet/custom NEVER wire it. **OPEN QUESTION**: does that
  mean `publishMove` against testnet/mainnet/custom RPCs MUST use the host `sui` CLI? Confirmed
  `cliEnv` is built in `engine/sui-cli.ts:415-423` — yes, host path. But this means a developer with
  a testnet config sees a different build path than a developer with a localnet config; the
  resulting bytecode SHOULD be identical (the build is offline given `--no-tree-shaking`) but the
  version drift between host-sui and the pinned localnet sui is the well-documented foot-gun
  (`engine/sui-cli.ts:36-46`).
- **Auto-tick fiber forking**: `runAutoTickClock` returns `Fiber.Fiber<unknown, never>`
  (`engine/sui-fork/control.ts:136`) but the call site at `services/sui.ts:1878` doesn't bind the
  return value. **OPEN QUESTION**: was the explicit-fiber return designed for a re-config path that
  hasn't landed?
- **Snapshot semantics for fork mode**: the comment at `services/sui.ts:18-37` says fork data dir +
  meta.json are snapshotted via separate bind-mount handling. **OPEN QUESTION**: where is that
  bind-mount handling? It's not in `services/sui.ts` — must be in the snapshot orchestrator (covered
  by another doc, but the seam is here).
- **`forkUpstream(network)` throws for non-fork variants** (`services/sui.ts:1497-1502`). This is
  defensive — `buildFork` only calls it on fork literals. **OPEN QUESTION**: is the throw a real
  failure mode or dead-code?
- **`runtime/endpoint-names.ts::SUI_CHECKPOINT_VOLUME`**: tested at `services/sui.test.ts:323` but
  not used by `services/sui.ts` anywhere visible in the scope read. **OPEN QUESTION**: what consumes
  it?

## Opportunities noticed

- **Extract `cliEnv` + `fetchChainId` + `publishEndpoint`/`publishSuiState` boilerplate** into a
  single `buildSuiCommon({rpcUrl, faucetUrl?, graphqlUrl?, network})` helper shared by
  `buildLocalnet`-external + `buildTestnet` + `buildMainnet` + `buildCustom`. The four bodies are
  80% the same; only the URL defaults and the `runtime` discriminator differ.
- **`containerBuildCmd` + `runBuildInside` duplicate the awk-staging + scrub script**. Extract
  `composeBuildInnerScript(packagePath, env)` returning the `[stageAwk, scrub, exec].join('; ')`
  string. Both call sites would shrink ~30 LOC and the security-hardening invariants live in one
  place.
- **`SuiBuildContainerLive`'s rejection of the helper's `recreate-on-resume-failed` policy**
  (`engine/sui-build-container.ts:174-187`) duplicates work the helper already does — the recreate
  path inside `ensureContainer` is configurable. Audit whether the helper should grow a
  `strictFailOnResume: boolean` option so SuiBuildContainer's bespoke rejection block goes away.
- **`scrubCachedMoveLocks(_packagePath)`'s unused first arg** (`engine/sui-cli.ts:551`) is
  documented as kept "for API symmetry" but symmetry isn't required — only one caller exists. Drop
  the arg.
- **`stripPinnedSectionsFromMoveLock`'s 6-deep walk** (`engine/sui-cli.ts:658-669`) is brittle. Pin
  the depth via a single named constant or — better — walk until `.git` is found (standard "find
  project root" pattern).
- **`KnownPackage` module-scope accumulator** (`services/known-package.ts:59`) is global mutable
  state. A `KnownPackageRegistry` `Context.Service` would let the factory write into a stack-scoped
  registry that `buildFork` reads via `Effect.serviceOption` at acquire time. Same shape as the
  existing per-service registries.
- **`accumulatedSeedObjects.clear()` is called at the top of `devstack(...)` compose**
  (`services/known-package.ts:69-74`) — but the user's compose entrypoint is the supervisor, not
  user code. If a test composes twice without calling `clearKnownPackageSeedObjects`, the second
  compose sees leaked seed objects. The clear should be inside the supervisor's `defineDevstack`,
  not relied on as a user-side hygiene step.
- **`ChainProbe` schema** validates `version: Schema.String` (`engine/chain-probe.ts:58`) — Sui's
  SDK returns version as a string today but is semantically a `bigint`. If the SDK ever exposes a
  typed version, the schema needs an update; consider `Schema.NumberFromString` or a brand-typed
  `VersionString`.
- **`forkGuard`'s closed `FORK_UNSUPPORTED_CORE_SURFACES` map** is a maintenance burden — sui-fork
  adds/removes `todo!()`s and devstack has no automated drift detection. A weekly CI job that
  introspects the running fork container's actual error surface (call every `core.*` method against
  a known-bad payload, classify by stderr) would catch drift.
- **`buildWaitForTransactionsReady` uses `Effect.cached`** which memoizes the WHOLE pipeline
  including the 90s timeout — if the first call fails, subsequent calls return the same cached
  failure without retrying. The `Effect.cachedWithTTL` or per-fork-restart invalidation would be
  more robust.
- **Per-stack docker network names** mix two composition rules
  (`services/sui.ts:369-379,1596-1606`): localnet has `<app>[-<stack>]-sui-network[-<network>]`
  (suffix only for non-localnet) while fork has `<app>[-<stack>]-sui-fork-network-<network>` (suffix
  always). Standardise to one rule.
- **`buildLocalnet` always builds the indexer-db image** (`services/sui.ts:776-784`) but the comment
  at line 775 notes "built lazily — only when the sui primitive actually starts an indexer (i.e.
  always, today; the option to skip the indexer entirely is a future-proofing path)". Either land
  the skip-indexer option or drop the lazy phrasing.
- **`SuiBuildImage` is a `Context.Reference` with `defaultValue: () => undefined`**
  (`engine/sui-cli.ts:48-51`) — but its consumer `buildMove` is wired into every Sui-using
  primitive. The `defaultValue` pattern is correct for "this is optional" but the comment chain
  (lines 36-47) explains the rationale at length because the implicit default is surprising. A typed
  wrapper `Maybe<SuiBuildImage>` would be more self-documenting.
- **`SuiCliPhases`** (closed set in `engine/phases.ts:148-160`) carries 11 phase strings, all
  docker-CLI-shaped. Half are "docker $verb (build container)" — these could compose
  `'docker $verb' + ' (' + subject + ')'` programmatically.
- **The fork's gRPC port `9000` and the localnet's RPC port `9000`** collide. Each runs on a
  different per-stack docker network so the in-network alias differs — but a developer reading the
  constants block would benefit from a comment explaining why two `9000`s coexist
  (`services/sui.ts:96-105`).
- **`forkGuard` returns a Proxy of the client**, but `Sui.client` is typed as `SuiGrpcClient`. The
  cast at `services/sui.ts:1493` (`as SuiGrpcClient`) silently allows the Proxy to satisfy the type
  — any SDK addition that uses `instanceof SuiGrpcClient` would fail. Switch to a typed wrapper that
  explicitly delegates the supported surfaces.
- **`SuiBuildContainerShape.runSummary`** (`engine/sui-build-container.ts:88-96`) exists for the
  bindings codegen emitter but the codegen consumers aren't in this scope. Surface this in the
  codegen doc so the contract between Sui (provider) and Codegen (consumer) is documented from both
  sides.
- **`ChainProbe`'s `objectsMatchTypes` accepts a custom `match` predicate**
  (`engine/chain-probe.ts:172-178`) defaulting to strict equality, but the most common usage in
  verify probes is the `moveTypeEquals` from `engine/sui-helpers.ts:270`. Either ship
  `objectsMatchTypes` defaulting to `moveTypeEquals` or add a sibling
  `objectsMatchTypesAddressAgnostic` so callers don't keep re-passing the same predicate.
- **The seed-manifest contract is mirrored TWICE** — sui-fork's own `seed_manifest.json`
  (write-once, contract owned by `crates/sui-fork/src/seed.rs`) AND devstack's `meta.json`
  (write-once, contract owned by `engine/sui-fork/meta.ts`). Devstack's gate fires before sui-fork's
  so the user gets an actionable error, but conceptually it's two locks on the same invariant.
  Document the layered-defense rationale in one place.
- **`ForkIncompatibleError` lives in `engine/errors.ts:112-121`** but is raised by Walrus / Seal
  factory bodies, not by Sui code. The class belongs in those service docs; only its definition
  lives here because all `Schema.TaggedErrorClass`es are centralised.
- **`SuiBuildContainer.runSummary` was added "pre-fix it shelled out to the HOST sui binary"**
  (`engine/sui-build-container.ts:90-96`) — the same fix should be applied to any other tool that
  the codegen path shells out to. Sweep for `'sui'`-named host invocations.
