# seal

## Purpose

The seal component is the devstack-side encryption / on-chain key-server service. It is the
integration glue around Mysten Labs' Seal (`MystenLabs/seal`) — a BLS12-381-based identity-based
encryption key server fronted by an on-chain `KeyServer` object on Sui.

On localnet, devstack builds and runs the Seal `key-server` binary in a docker container, generates
a fresh BLS12-381 master keypair via `seal-cli genkey`, publishes the Seal Move package, registers a
`KeyServer` object on chain pointing at the per-stack routed URL, and surfaces both a read-side
handle (`SealKeyServerTag` — SDK-ready `serverConfigs` for `@mysten/seal`'s `SealClient`) and a
local admin handle (`SealKeyManagerTag` — master-key env-file path + an Effect that rotates the
keypair).

On `testnet` / `mainnet` (and the corresponding `*-fork` variants), the same `Seal()` factory routes
to a read-only handle that points at Mysten's pre-deployed public key server (per
`engine/known-deployments.ts`); the local cluster path is structurally incompatible with sui-fork
(the key-server's chain client is JSON-RPC-bound, and sui-fork only exposes gRPC) and fails fast
with a `ForkIncompatibleError` at factory time.

The component is a "composite primitive" — its public factory returns a single `StackMember`, but
internally it composes a private internal Context.Service tag (`SealLocalKeygenInternal`), several
inner `onChainArtifact` tags (`keypair`, `keyServer`), an external `publishMove` reference, and
lifted `__extraMembers` siblings (`sealImage`, optional `sourceFetch`) so the topo scheduler can
parallelize them against other stack members. The interface is split across the network-side
`SealKeyServerTag` (always produced) and the local-only `SealKeyManagerTag` (produced only by the
`sealLocalKeygen` variant), which lets consumer code that depends on rotation be type-checked away
from running on testnet/mainnet.

## Current implementation

### `services/seal.ts` — 206 LOC

The canonical public surface for seal.

- **`SealKeyServerEntry`** (lines 52-56): Structural mirror of `@mysten/seal`'s `KeyServerConfig` —
  `{ objectId, weight, aggregatorUrl? }`. `@mysten/seal` is a peer dep; duplicating the shape keeps
  the runtime import off the bundle. Compile-time structural-assignability check lives in
  `seal.test.ts:26-33`.
- **`SealKeyServer`** interface (lines 59-85): The network-side view every Seal-key-server factory
  must surface — `serverConfigs: ReadonlyArray<SealKeyServerEntry>` (SDK-ready),
  `keyServerUrl: string` (debug/health convenience), `objectId: string` (convenience reference to
  the first server).
- **`SealKeyServerTag`** Context.Service tag (lines 87-89): `@devstack/SealKeyServerTag`.
- **`SealKeyManager`** interface (lines 107-114): Local-only admin capabilities —
  `masterKeyEnvFile: string` (the 0o600 env-file path under `runtime/seal/`) and
  `rotate: Effect.Effect<void, SealError>`.
- **`SealKeyManagerTag`** Context.Service tag (lines 112-114): `@devstack/SealKeyManagerTag`.
- **Schemas** (lines 121-135): `SealKeyServerEntrySchema`, `SealKeyServerSchema` —
  runtime-validation mirrors for the read interface. `SealKeyManager` carries an Effect value
  (`rotate`) so it intentionally has no Schema mirror.
- **`SealOptions`** (lines 145-156): `signer?` (required on localnet), `local?` (pass-through extras
  for the local-keygen path), `name?` (override tag name; default `'seal'`).
- **`Seal(opts)`** factory (lines 178-206): Reads `resolveNetwork()`; routes to `sealKnownKeyServer`
  on testnet/mainnet/`*-fork` (via `resolveDeploymentNetwork`), routes to `sealLocalKeygen` on
  localnet. Throws synchronously if `opts.signer` is undefined on localnet. Returns a `StackMember`.

The file's header comment establishes the capability split: `SealKeyServerTag` (network-side view)
vs. `SealKeyManagerTag` (local-only admin) — designed so future remote-only factories produce a
strict subset of the surface.

### `services/seal/internal.ts` — 1361 LOC

The heavy lifting. Two factories (`sealLocalKeygen`, `sealKnownKeyServer`) plus helpers.

- **Header (1-52)**: Documents the two-factory layout, the internal-tag-with-projection-layers
  topology, the manifest field (`manifest.packages.seal`), and the snapshot participation contract
  (see "Persistence model" below).
- **Imports + constants (53-162)**: `DEFAULT_KEY_SERVER_PORT = 2024` (line 102),
  `DEFAULT_READY_TIMEOUT_MS = 60_000` (line 103), `DEFAULT_SEAL_VERSION = 'seal-v0.6.6'` (line 110),
  `SEAL_KEYGEN_ENTRYPOINT = 'seal-cli'` + `SEAL_KEYGEN_ARGS = ['genkey']` (lines 115-116),
  `KEY_TYPE_BONEH_FRANKLIN_BLS12381 = 0` (line 137),
  `DEFAULT_SEAL_REPO = 'https://github.com/MystenLabs/seal'` (line 148),
  `DEFAULT_SEAL_MOVE_SUBDIR = 'move/seal'` (line 149). `LEVEL_RANK` + `resolveMinLevel` (lines
  126-133) drive the `DEVSTACK_LOG_LEVEL` filter applied to the container's docker-logs stream.
- **`PersistedBlsKeypair`** interface (lines 159-162): `{ masterKey: string; publicKey: string }` —
  two hex blobs persisted in the state-store.
- **`SealLocalKeygenShape`** (lines 172-178): The aggregate shape that lands in
  `manifest.packages.seal`.
- **`SealLocalKeygenOptions<Name>`** (lines 184-209): `name?`, `signer` (required
  `LayeredTag<any, Account, any, any>`), `image?` (override pre-built tag), `version?` (default
  `'seal-v0.6.6'`), `movePackagePath?` (vendored path; bypasses gitFetch), `readyTimeoutMs?`
  (default 60s), `keyServerName?` (default `'devstack-local'`), `dependsOn?` (explicit ordering
  edges).
- **`SealLocalKeygenInternalShape`** interface (lines 214-218):
  `{ keyServer, keyManager, packageId }` — the resolved value produced by the heavy acquire effect.
- **`sealLocalKeygen()`** factory (lines 233-1217): The full local-only path. Builds inner sibling
  tags (`sealImage`, `sourceFetch?`, `publish`, `keypair`, `keyServer`), the private
  `SealLocalKeygenInternal` tag class (`@devstack/SealLocalKeygenInternal/${name}`), the heavy
  `acquire` Effect, projection layers for `SealKeyServerTag` and `SealKeyManagerTag`, and a `rotate`
  Effect closure. Returns
  `Object.assign(SealLocalKeygenInternal, {__layers, __extraMembers, __kind, __pluginName, __displayTitle})`
  as a `StackMember`.
- **`SealKnownKeyServerOptions`** (lines 1223-1231): `name?`, `network?` (looked up in
  `knownDeployments.seal`), `objectId?`, `keyServerUrl?` (latter two override the lookup).
- **`sealKnownKeyServer()`** factory (lines 1238-1280): Read-only handle for a public Seal
  deployment. Throws synchronously if neither `network` nor the field tuple are sufficient (line
  1247-1252). The build body publishes the endpoint into the `EndpointRegistry` and the state record
  into `SealStateRegistry`, then returns the `SealKeyServer` shape.
- **`renderSealKeyServerConfig`** helper (lines 1296-1316): Renders the CONFIG_PATH yaml the
  key-server reads. Forces `network: !Devnet` (the discriminator the binary uses for "custom chain
  via node_url") because env-only mode silently routes at the public testnet fullnode regardless of
  `NODE_URL`.
- **`parseSealKeygenOutput`** helper (lines 1323-1337): Parses `Master key:` / `Public key:` lines
  from `seal-cli genkey` stdout. Hex prefix may or may not include `0x`.
- **`redactMasterKey`** helper (lines 1345-1347) + `MASTER_KEY_LINE_RE` (line 1343):
  Case-insensitive line-level replacement of any `master[_-]?key` mention with
  `[REDACTED master key]`. Used wherever stdout/stderr from `seal-cli` might surface in a SealError.
- **`decodeHex`** helper (lines 1351-1361): Hex → bytes, tolerates leading `0x`, throws on odd
  length.

### `services/seal/parallel-stack.test.ts` — 195 LOC (unit)

Per-invariant proofs that the seal primitive's host-side state is exhaustively stack-keyed. See
"Test coverage" for the per-describe breakdown.

### `services/seal/parallel-stack.docker.test.ts` — 64 LOC (docker, gated)

Docker-gated placeholder for the full two-stacks-side-by-side e2e. Gated behind
`RUN_SEAL_DOCKER_TESTS=1`; currently asserts only the orchestration gate is reachable.

### `services/seal.test.ts` — 112 LOC (unit)

`sealKnownKeyServer` smoke tests + the compile-time `@mysten/seal` structural-assignability guard.

### `services/seal.fork-known.docker.test.ts` — 27 LOC (docker, gated)

Docker-gated placeholder for `Seal()` on `testnet-fork` composing to `sealKnownKeyServer(testnet)`.
Gated behind `RUN_FORK_DOCKER_TESTS=1`.

### `services/seal.fork-localkeygen-refused.test.ts` — 96 LOC (unit)

Asserts that `sealLocalKeygen()` throws `ForkIncompatibleError` at factory time on every `*-fork`
network, and that the error carries an actionable hint pointing at the known-deployment alternative.

### Adjacent Seal references

- `engine/registries.ts:61-67`: `SealStateRecord` interface + `SealStateRegistry` tag class +
  `SealStateRegistryLive` layer + `publishSealState` free function.
- `engine/known-deployments.ts:153-157, 163, 422-440`: `SealDeployment` interface
  (`{ keyServerObjectId, keyServerUrl }`), `KnownDeployments.seal` slot, and the canonical `testnet`
  entry (`mysten-testnet-1` Open-mode independent server). `mainnet` slot intentionally empty
  (Mysten doesn't ship a public default key server on mainnet — production is via Enoki). `devnet`
  slot intentionally empty.
- `engine/errors.ts:325-341`: `SealError` (`Schema.TaggedErrorClass`) with `phase` (closed set in
  `SealPhases`), `keyServer` (optional, for multi-instance configurations), `message`, `stderr`,
  `stdout`, `exitCode`, `cause`.
- `engine/errors.ts:112-121`: `ForkIncompatibleError` (shared with walrus) — what `sealLocalKeygen`
  throws on `*-fork` networks.
- `engine/phases.ts:79-91`: `SealPhases` closed set —
  `'port-alloc' | 'image' | 'keygen' | 'publish' | 'register' | 'config-render' | 'container' | 'ready' | 'rotate' | 'seal'`.
- `engine/state-store-keys.ts:64-78`: `StateStoreKeys.sealBlsKeypair({chainId})` →
  `seal/bls-keypair/${chainId}` and `StateStoreKeys.sealKeyServerId({chainId})` →
  `seal/key-server-id/${chainId}` builders. (Note: the in-code `buildCacheKey` calls in
  `seal/internal.ts:622-631` use the namespace + inputs-hash form rather than these literal
  builders. The two paths derive the SAME slot — see Pain Points and Open Questions.)
- `runtime/endpoint-names.ts:68-73, 134`: `seal_key_server` endpoint definition —
  `name: 'seal-key-server'`, conventional service `'seal'` on port `2024`, manifest field
  `services.seal.keyServer`, published by `Seal()`. Surfaced via `EndpointName.SEAL_KEY_SERVER`.
- `runtime/manifest-schema.ts:45-49, 142`: `SealManifest` shape —
  `{ keyServer: EndpointEntry, objectId?: string }` — included as optional in
  `ServicesManifest.seal`.
- `runtime/service.ts:103-113`: `sealProjection` — reads from `SealStateRegistry` +
  `EndpointRegistry`, produces the `SealManifest` entry surfaced at `manifest.services.seal`.
- `engine/snapshot.ts:1-11, 452-455`: Snapshot header lists `runtime/seal/master-key.env` as one of
  the canonical service-owned paths the runtime tar must capture; `state.json` participation lists
  the BLS keypair cache.
- `engine/supervisor.ts:124, 596-601, 1115-1166, 1557-1559`: References for the lifted `sealImage`
  sibling, the `HEAVY_INFRA_COSTS` table (~30s reboot expected for seal), the topo-level placement
  (level after sui+signer+publish+keypair+keyServer), and the parallel-finalizer /
  `stopGraceSeconds: 15` teardown reasoning.
- `engine/docker/router.ts:194`: `defineEntrypoint({ name: 'seal', port: 2024 })` — declares the
  well-known seal entrypoint on Traefik. Single shared host port across stacks (Traefik dispatches
  by `Host:` header).
- `images/seal/Dockerfile` (63 lines, vendored): The build context the `dockerImage({build})`
  factory tag references. Downloads `seal-cli` + `key-server` from the GitHub release for
  `SEAL_VERSION`. No Rust compile.
- `images/seal/entrypoint.sh` (51 lines, vendored): The shell wrapper that traps docker SIGTERM and
  forwards SIGINT to the `key-server` child. Works around an upstream bug: the seal `key-server`
  binary's `#[tokio::main] async fn main` installs no signal handler, so running it as PID 1 makes
  `docker stop` always timeout to SIGKILL → exit 137 → next-up trip "UNCLEAN PRIOR SHUTDOWN".

### Totals

|                                                                                                                                                                            | LOC  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Src (`seal.ts` + `seal/internal.ts`)                                                                                                                                       | 1567 |
| Tests (`seal.test.ts` + `seal/parallel-stack.test.ts` + `seal/parallel-stack.docker.test.ts` + `seal.fork-known.docker.test.ts` + `seal.fork-localkeygen-refused.test.ts`) | 494  |
| Vendored docker assets (`images/seal/Dockerfile` + `entrypoint.sh`)                                                                                                        | 114  |
| **Combined**                                                                                                                                                               | 2175 |

## Configuration

### `Seal(opts)` factory options

- **`signer?: LayeredTag<any, Account, any, any>`** (`seal.ts:150-153`): The Account whose key signs
  the `KeyServer::create_and_transfer_v2_independent_server` Move tx and pays the gas. **Required on
  localnet**; ignored on testnet/mainnet (the remote deployment is already published). Synchronous
  throw at factory call site if undefined on localnet (`seal.ts:193-199`).
- **`local?: Omit<SealLocalKeygenOptions<string>, 'name' | 'signer'>`** (`seal.ts:153`):
  Pass-through extras for the local-keygen branch. Ignored when the resolved network is
  testnet/mainnet.
- **`name?: string`** (`seal.ts:155`): Override tag name. Default `'seal'`. Folds into
  Context.Service key (`@devstack/SealLocalKeygenInternal/${name}`), state-store cache key inputs
  hash, container name (`seal-${name}-key-server`), and display title.

### `sealLocalKeygen()` factory options (under the `local:` key)

- **`name?: Name`** (`seal/internal.ts:185`): As above. Default `'seal'`.
- **`image?: string`** (`seal/internal.ts:187-192`): Skip the vendored Dockerfile build and use a
  pre-built tag instead. When unset, builds from `packages/devstack/images/seal/` with
  `SEAL_VERSION=<version>` as a build arg.
- **`version?: string`** (`seal/internal.ts:193-197`): Pinned seal release tag. Default
  `'seal-v0.6.6'`. Used both as `SEAL_VERSION` for the Dockerfile (which release asset to download)
  AND as the git ref for the `move/seal` source fetch — the binary ABI and Move package must match,
  so the two MUST move in lockstep.
- **`movePackagePath?: string`** (`seal/internal.ts:198-201`): Filesystem path to a vendored
  `move/seal` Move package. When unset, devstack `gitFetch`es `MystenLabs/seal` at `version` and
  uses the `move/seal` subdir. Setting this skips the fetch.
- **`readyTimeoutMs?: number`** (`seal/internal.ts:202-204`): Ready-probe timeout for `/health`.
  Default `60_000` (60s).
- **`keyServerName?: string`** (`seal/internal.ts:205`): On-chain `KeyServer.name` field. Default
  `'devstack-local'`.
- **`dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>`** (`seal/internal.ts:207-208`):
  Explicit ordering edges. Same shape as walrus / deepbook. Yielded first inside `acquire`
  (`seal/internal.ts:581-583`) to pin consumers before the heavy work.

### `sealKnownKeyServer()` factory options

- **`name?: string`** (`seal/internal.ts:1224`): Override tag name. Default `'seal'`.
- **`network?: KnownNetwork`** (`seal/internal.ts:1227-1228`): One of `'testnet'` / `'mainnet'` /
  `'devnet'` — looked up in `knownDeployments.seal[network]`.
- **`objectId?: string`** (`seal/internal.ts:1229`): Explicit override; wins over the network
  lookup.
- **`keyServerUrl?: string`** (`seal/internal.ts:1230`): Explicit override; wins over the network
  lookup.

At least one of `network` OR the `(objectId, keyServerUrl)` pair must resolve to a usable tuple,
otherwise the factory throws synchronously (`seal/internal.ts:1246-1252`).

### Env vars consumed

- **`DEVSTACK_NETWORK`** (`engine/network.ts:80-81`, read inside `resolveNetwork()` called by
  `seal.ts:179` + `seal/internal.ts:251`): Resolves to one of
  `'localnet' | 'testnet' | 'mainnet' | 'mainnet-fork' | 'testnet-fork' | 'devnet-fork'`. Default
  `'localnet'`. The single source of truth that decides which branch `Seal()` takes.
- **`DEVSTACK_LOG_LEVEL`** (`seal/internal.ts:128`): Per-container log filter for the supervisor's
  TUI log sink. Accepted values (case-insensitive): `'trace'` / `'debug'` / `'info'` → `'info'`,
  `'warn'` / `'warning'` → `'warn'`, `'error'` / `'fatal'` → `'error'`. Default `'warn'` for seal
  (`seal/internal.ts:602`). Default suppresses upstream's routine INFO narration from the TUI
  without silencing the container's `docker logs` stream.
- **`DEVSTACK_STACK`** (read in `engine/supervisor.ts:990-991` via `resolveStackName`): Default
  `'main'`. Folds into per-stack identity → hostname, container name, state-store cache path,
  `runtime/seal/` path.
- **`DEVSTACK_STATE_DIR`** (`engine/snapshot.ts:61`, also referenced by
  `engine/service-paths.ts:67-70`): Default `.devstack`. Where `runtime/seal/master-key.env` lives.
- **`RUN_SEAL_DOCKER_TESTS`** (`seal/parallel-stack.docker.test.ts:29`): Gates the docker-gated
  parallel-stack test.
- **`RUN_FORK_DOCKER_TESTS`** (`seal.fork-known.docker.test.ts:16`): Gates the docker-gated fork
  test.

### Container-side env

The key-server container is launched with:

- `CONFIG_PATH=/etc/seal/key-server-config.yaml` (`seal/internal.ts:810-811`): the bind-mounted
  config yaml the binary reads.
- `RUST_LOG=info` (`seal/internal.ts:812`): the seal binary's tracing filter.
- `--env-file <masterKeyEnvFile>` (`seal/internal.ts:814`): the 0o600-perm env-file containing
  `MASTER_KEY=<hex>`. Chosen over `-e MASTER_KEY=…` because the latter surfaces the value in host
  process env and `docker inspect` output (`seal/internal.ts:740-745`).

## Capabilities CONSUMED

### Other services / cross-references

- **`SuiTag`** (`seal/internal.ts:89, 411, 585, 1126`): The sui rpc handle. Yielded at acquire time
  (line 585) for `chainId` (folded into cache keys) and `rpc.container` / `rpc.containerNetworks`
  (joined for in-container DNS resolution of `sui-localnet`). Yielded inside the `keypair` verify
  probe (line 411) so the B8 cascade can read the state-store. Listed as an upstream key (line 1126)
  for topo-level scheduling.
- **`Account`** ref (via `options.signer`, `seal/internal.ts:186, 314, 523, 585, 1128`): Signs the
  `KeyServer::create_and_transfer_v2_independent_server` Move tx. Yielded at acquire time (585) and
  inside `keyServer.upstream` (523). Also threaded into `publishMove`'s `signer` field (314) for the
  inner Move package publish.
- **`publishMove`** primitive (`seal/internal.ts:90, 303-315, 523, 673-676`): Wrapper around the
  universal Move-publish substrate. Always present; takes either the user-supplied `movePackagePath`
  or the runtime-resolved path from the inner `gitFetch` (via `Effect.gen` runtime form, line
  309-313).
- **`gitFetch`** primitive (`seal/internal.ts:77, 296-302`): Vendored sibling for the `move/seal`
  source when the user did not provide `movePackagePath`. Lifted to top-level via `__extraMembers`
  (line 1198-1199).
- **`dockerImage`** (`seal/internal.ts:76, 270-281`): Image-build / pull substrate. Lifted to
  top-level via `__extraMembers` (line 1198-1199) so the build runs in parallel with sui's boot.
- **`onChainArtifact`** substrate (`seal/internal.ts:78, 383-479, 512-567`): Used to build the inner
  `keypair` and `keyServer` tags. Each receives a `verify` probe (the B8 cascade for the keypair;
  `chain.getObject(cached)` round-trip for the key-server object) and a `produce` body that re-runs
  on cache-miss / verify-fail.
- **`runDockerContainer`** (`seal/internal.ts:76, 808-872`): The long-running key-server container's
  owner. Owns: container start, `docker stop` finalizer on scope close, traefik file-provider
  materialization, and the `/health` ready probe raced against `docker wait`.
- **`Docker.runOneShot`** (`seal/internal.ts:59, 445-477, 916-945`): One-shot container runner used
  by the keygen step (both initial and rotate paths).
- **`Docker.restartContainer`** (`seal/internal.ts:1025-1035`): Used by rotate to bounce the daemon
  after writing fresh config + env-file.
- **`Docker.awaitContainerReady`** (`seal/internal.ts:1042-1060`): Used by rotate to re-probe
  `/health` after the bounce.

### Engine resources

- **`Identity`** (`seal/internal.ts:66, 487, 587, 1075`): Read for the per-stack identity that
  drives `routerHostname(identity, 'seal')`. Pre-provided to `rotate` (line 1075) so the
  consumer-facing `rotate: Effect.Effect<void, SealError>` stays `R = never`.
- **`StateStore`** (`seal/internal.ts:70, 412, 586, 1067-1068`): Read for the keypair / key-server
  cache entries during the B8 cascade verify; written by `rotate` to update the cache after a
  successful rotation.
- **`PackageRegistry`** (`seal/internal.ts:79, 878`): Yielded for ordering — `publishMove` already
  published into it; the bare `yield* PackageRegistry` (with discarded value) is a topological
  ordering hint per the registries.ts contract.
- **`EndpointRegistry`** (via `publishEndpoint`, `seal/internal.ts:79, 879-883, 1255-1259`): Where
  the seal-key-server URL is published for the manifest grouper.
- **`SealStateRegistry`** (via `publishSealState`, `seal/internal.ts:79, 884, 1260`): Where the
  on-chain `KeyServer` object id is published — last-write-wins per name.
- **`EngineHandle`** (`seal/internal.ts:60, 326-334, 601-612`): The TUI log sink. Falls back to
  no-op when not present (standalone tests).
- **`Path.Path`** (`seal/internal.ts:56, 434, 696`): For path joining (`master-key.env`,
  `key-server-config.yaml`).
- **`FileSystem.FileSystem`**
  (`seal/internal.ts:56, 434, 695, 709, 728, 754, 764, 994, 1004, 1014`): For writing the master-key
  env-file, the config yaml, and chmod 0o600 / 0o700.
- **`servicePath('seal')`** (`seal/internal.ts:69, 432, 708`): Resolves to
  `<state-dir>/runtime/seal/`. Used to host `master-key.env` + `key-server-config.yaml`.
- **`Effect.scope`** (implicit via Layer construction): The key-server's `docker stop` finalizer
  registers on the primitive's scope.
- **`buildCacheKey`** (`seal/internal.ts:71, 411-415, 622-631`): Derives
  `seal/bls-keypair/${chainId}/${inputsHash}` and `seal/key-server-id/${chainId}/${inputsHash}`. The
  `sealInputsHash` (line 346-348) folds in `{name}` once at factory time so two
  `sealLocalKeygen({name:…})` calls land in distinct slots.
- **`contentHash`** (`seal/internal.ts:72, 346-348`): Hash function used to derive `sealInputsHash`.
- **`jsonBigintReplacer`** (`seal/internal.ts:73, 347`): JSON.stringify replacer for the hash input.
- **`stringifyCause`** (`seal/internal.ts:74, 1097`): Used in the outer `catch` to surface arbitrary
  causes as `SealError.message`.
- **`pickCreatedByType`** (`seal/internal.ts:75, 552-555, 971-974`): Extract the created `KeyServer`
  object id from `result.objectChanges` after the register tx.

### Runtime resources

- **`ChildProcessSpawner`** (`seal/internal.ts:57, 595, 1070`): The Effect-platform spawner;
  captured at acquire time to pre-provide `rotate`.
- **`docker` CLI** (transitively via `Docker.runOneShot`, `runDockerContainer`,
  `Docker.restartContainer`, `Docker.awaitContainerReady`): One-shot keygen, long-running
  key-server, restart on rotate, ready probe.
- **Host filesystem** (via `FileSystem.FileSystem`): `<state-dir>/runtime/seal/master-key.env`
  (0o600) and `<state-dir>/runtime/seal/key-server-config.yaml`; parent dir chmod 0o700 (best-effort
  with a `nodeFs.chmod` fallback, lines 709-716, 764-771, 1014-1021).
- **Inner Docker network** (via `network: suiNet`, `seal/internal.ts:804-816`): The first entry of
  `Sui.rpc.containerNetworks` (with `suiNetworkName(identity)` as a defensive fallback) so the
  key-server container can resolve `sui-localnet` via docker DNS.

### Surfaces (TUI updates, log sink, event bus)

- **TUI phase updates** via `setPhase(...)`
  (`seal/internal.ts:87, 649, 660, 672, 684, 789, 915, 949, 988, 1024`): Phase transitions surface
  as the right-column phase indicator in the TUI. Phases: `'building image'`,
  `'generating master key'`, `'publishing contracts'`, `'registering on-chain key-server'`,
  `'starting key server'`, plus rotation phases (`'rotate: …'`).
- **Engine log sink** via `EngineHandle.appendLog` (`seal/internal.ts:332-333, 608-611`): Per-line
  forwarding of the container's stdout/stderr to the supervisor's TUI log tail. Min-level filtered
  by `DEVSTACK_LOG_LEVEL` (default `'warn'`).
- **Effect.annotateCurrentSpan** (`seal/internal.ts:643`): Annotates the seal hostname onto the
  current trace span.
- **Effect.withSpan** (`seal/internal.ts:652, 675, 1076`): `SealImage`, `SealPublish`,
  `SealRotate(${name})` named spans.

### External

- **`https://github.com/MystenLabs/seal`** (gitFetch source, `seal/internal.ts:148-149`): The Seal
  upstream repo. `subdirectory: 'move/seal'`, `ref: SEAL_VERSION`.
- **`https://github.com/MystenLabs/seal/releases/download/${SEAL_VERSION}/seal-${PLATFORM}`** and
  `/key-server-${PLATFORM}` (`images/seal/Dockerfile:35-37`): The Seal release binaries fetched at
  image-build time.
- **`http://${sealHostname}:2024/health`** (`seal/internal.ts:838-841, 1046-1048`): The ready
  probe + post-rotate re-probe.
- **`http://sui-localnet:9000`** (`seal/internal.ts:722`, transitively from `Sui.rpc.container`):
  The container-side sui RPC URL the key-server dials.
- **`http://${sealHostname}:${sealEntrypointInfo.port}`** (`seal/internal.ts:498`): The routed
  key-server URL surfaced both to the on-chain `KeyServer.url` field and to consumers via
  `SealKeyServerTag.keyServerUrl`.

### Effect/Layer/Context machinery

- `effect` (Context, Effect, FileSystem, Layer, Option, Path, Schema)
- `effect/unstable/process` (`ChildProcessSpawner`)
- `Layer.effect` (`seal/internal.ts:1143, 1151`): Used to build the two projection layers from the
  internal tag.
- `Context.Service` (factory-closure-bound `SealLocalKeygenInternal` class at line 573-576).
- `Effect.fn(name)` (line 578, 1254): Named-effect wrappers.
- `Effect.gen` (multiple): The build bodies.
- `Effect.serviceOption(EngineHandle)` (line 326, 601): For the optional engine sink.
- `Effect.catchTag('DockerError'|'ReadyProbeError')` (multiple): Maps low-level errors into typed
  `SealError`s.
- `Effect.catch` (multiple): Defensive catch-all for chmod failures.
- `Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)` +
  `Effect.provideService(Identity, identity)` (lines 1070, 1075): Pre-provide so the consumer-facing
  `rotate` has `R = never`.
- `Effect.withSpan` (multiple): Trace spans for observability.

### npm dependencies

- **`@mysten/sui/transactions`** (`Transaction` class, `seal/internal.ts:58`): Builds the on-chain
  `KeyServer::create_and_transfer_v2_independent_server` move calls.
- **`effect`** (Context, Effect, FileSystem, Layer, Option, Path, Schema): Core runtime.
- **`@effect/platform-node/NodeFileSystem`** (only in `seal.test.ts:11`).
- **`@effect/vitest`** (test harness).
- **`vitest`** (test harness).
- **`@mysten/seal`** — **peer dep** (NOT runtime-imported). The shape of `SealKeyServerEntry` is
  hand-mirrored; the test in `seal.test.ts:26-33` is the structural-drift guard.

### Imports from other workspace packages

None directly. Seal is a leaf primitive within `@mysten-incubation/devstack`.

## Capabilities PRODUCED

### Endpoints

- **`SEAL_KEY_SERVER`** (`runtime/endpoint-names.ts:68-73`, published at
  `seal/internal.ts:879-883, 1255-1259`):
  - `name: 'seal-key-server'`
  - URL: `http://seal.<app>.localhost:2024` (main stack) or
    `http://<stack>.seal.<app>.localhost:2024` (non-main stack)
  - Conventional service `'seal'`, port `2024`
  - Manifest path: `services.seal.keyServer`
  - Surfaced into the manifest at `services.seal.keyServer` as an `EndpointEntry`.

### State-store entries

- **`seal/bls-keypair/<chainId>/<inputsHash>`** (`engine/state-store-keys.ts:64-71`, written
  transparently by `onChainArtifact`'s `withCache` substrate via `seal/internal.ts:383-479`):
  - Value shape: `{ masterKey: string; publicKey: string }` (a `PersistedBlsKeypair`).
  - Two hex blobs round-tripped through `StateStore`'s JSON layer.
  - `chainId` fold-in ensures regenesis of the underlying chain invalidates the cache.
  - `inputsHash` folds in `{name}` (line 346-348) so two `sealLocalKeygen({name: 'a'})` and
    `sealLocalKeygen({name: 'b'})` in the same stack get distinct slots.
- **`seal/key-server-id/<chainId>/<inputsHash>`** (`engine/state-store-keys.ts:73-78`, written by
  `onChainArtifact` for the `keyServer` tag at `seal/internal.ts:512-567`):
  - Value: `string` — the on-chain `KeyServer` object id.

### Events / engine lifecycle

- **TUI lifecycle entries** keyed on the internal tag's key
  (`@devstack/SealLocalKeygenInternal/${name}`, line 1188):
  `pending → acquiring → ready → stopping → stopped`. The two projection layers (`SealKeyServerTag`,
  `SealKeyManagerTag`) are NOT separate lifecycle entries — they're trivial value extractions.
- **HEAVY_INFRA_COSTS warnings** (`engine/supervisor.ts:599-600`): Both `SealKeyServerTag` and
  `SealKeyManagerTag` carry the same `Seal — ~30s reboot expected` annotation. Surfaced in the
  watch-fire log line when a selective restart's downstream-closure includes seal.

### Files written

- **`<state-dir>/runtime/seal/master-key.env`** (`seal/internal.ts:753-754, 1004-1005`):
  - Content: `MASTER_KEY=<hex>\n`
  - Permissions: 0o600 (file) within 0o700 parent dir (best-effort chmod).
  - Survives snapshot (under `runtime/`).
  - NOT unlinked on scope close (load-bearing for snapshot → restore round-trip).
- **`<state-dir>/runtime/seal/key-server-config.yaml`** (`seal/internal.ts:717-737, 994-1003`):
  - Rendered by `renderSealKeyServerConfig` (lines 1296-1316).
  - Content: yaml with `network: !Devnet`, `seal_package`, `node_url`, `server_mode: !Open`,
    `key_server_object_id`, `ts_sdk_version_requirement`.
  - Persisted (not in a scoped temp dir) so the bind-mount survives between `pnpm dev` invocations —
    losing the host path between cycles makes `docker start` of the prior container fail with
    `not a directory: Are you trying to mount a directory onto a file (or vice-versa)?` (per the
    rationale at lines 700-705).

### CLI commands registered

None directly by seal. `devstack status` (`cli/commands/status.ts:214-215`) and `devstack manifest`
(`cli/commands/manifest.ts:72-73`) print the seal-key-server URL when present.

### Routes registered

- **Traefik router `seal`** (`engine/docker/router.ts:194`):
  `defineEntrypoint({ name: 'seal', port: 2024 })`. Stamped per-container by `runDockerContainer`'s
  `routing: [{ name: 'seal', entrypoint: 'seal', servicePort: 2024 }]` (`seal/internal.ts:822-828`)
  with router id `${app}-${stack}-seal` (per `routerId(identity, 'seal')`).

### TypeScript exports consumed elsewhere

- **`Seal`** (factory, `services/index.ts:34, index.ts:42`): The public canonical factory.
- **`SealOptions`** (type, `services/index.ts:35, index.ts:43`): Factory option shape.
- **`SealKeyServerTag`** (Context.Service tag, `services/index.ts:38, index.ts:178`): The narrow
  read-side interface tag — consumers `yield* SealKeyServerTag` in their effects.
- **`SealKeyServer`** (type, `services/index.ts:37, index.ts:178`): The resolved shape.
- **`SealKeyServerEntry`** (type, `services/index.ts:36`): SDK-ready `serverConfigs[]` entry.
- **`SealKeyManagerTag`** + **`SealKeyManager`** (`services/index.ts:39-40`,
  `advanced/index.ts:196-197`): Local admin tag — surfaced on `/advanced` only.
- **`SealError`** (`engine/errors.ts:325-341`, re-exported `index.ts:160`).
- **`SealManifest`** type (`runtime/manifest-schema.ts:49`, re-exported `index.ts:118`).
- **`sealLocalKeygen`** + **`sealKnownKeyServer`** are NOT exported from any public barrel
  (`/index`, `/services/index`, `/advanced/index`, `/advanced/plugin-author/index`). They're
  imported by the canonical `Seal()` factory and by the tests, but plugin-author surface is `Seal()`
  only. (See "Pain Points" — the header comment at `seal.ts:158-163` claims plugin authors can
  `import { sealKnownKeyServer } from '/advanced'`, but no such re-export exists.)

### Container images / volumes produced

- **Docker image** built from `packages/devstack/images/seal/Dockerfile`:
  - Base: `ubuntu:24.04` (bin-fetch stage) → `debian:bookworm-slim` (runtime stage).
  - Contains: `/usr/local/bin/seal-cli`, `/usr/local/bin/key-server`,
    `/usr/local/bin/devstack-seal-entrypoint.sh`.
  - Exposes ports 2024 and 9184.
  - Multi-arch via `TARGETARCH` (arm64 → `linux-aarch64`, amd64 → `linux-x86_64`).
- **Docker container** named `<app>-<stack>[-<network>]-seal-<name>-key-server` (composed by
  `composeContainerName` in `engine/docker/core.ts`). Per-instance per stack.
- **No docker volumes** — the master key, config, and any other state live on the host fs under
  `runtime/seal/` and are bind-mounted in.

## Lifecycle

### Startup — `sealLocalKeygen` (localnet)

The single `acquire` Effect (`seal/internal.ts:578-1102`) runs the following ordered phases. Inner
tags resolved via `yield*` may have been precomputed by the topo scheduler (they appear as upstream
siblings); Effect's MemoMap dedupes the cross-yield.

1. **0. Explicit ordering edges** (lines 581-583): Yield every tag in `options.dependsOn` so
   consumers that need to settle before seal are awaited.
2. **Captures** (lines 585-602): Yield `SuiTag`, `options.signer`, `StateStore`, `Identity`,
   `ChildProcessSpawner` (captured for the closure-bound `rotate`), `EngineHandle` (optional).
   Compute `LEVEL_RANK` for the sink filter.
3. **Cache-key derivation** (lines 622-631): Build `blsKeypairKey` and `keyServerIdKey` via
   `buildCacheKey({namespace, chainId: sui.chainId, inputsHash: sealInputsHash})`. The inputs hash
   is the factory-time content hash of `{name}`.
4. **Router exposure** (lines 641-643): Compute `sealHostname = routerHostname(identity, 'seal')`
   and `keyServerUrl` (via `resolveKeyServerUrl` — which checks `routerEntrypoint('seal')` was
   registered). Annotate the span with the hostname.
5. **Image ensure** (lines 649-653): `setPhase('building image')`; yield the inner `sealImage` tag —
   either pulls a pre-built tag or builds from `packages/devstack/images/seal/Dockerfile`. Wrapped
   in `Effect.withSpan('SealImage')`.
6. **Keygen** (lines 660-664): `setPhase('generating master key')`; yield the inner `keypair` tag.
   On cache hit (verify passes the 3-check B8 cascade), returns the cached `PersistedBlsKeypair`. On
   miss / verify-fail, runs `Docker.runOneShot` with `entrypoint: 'seal-cli', args: ['genkey']`,
   parses `Master key:` / `Public key:` from stdout, returns `{masterKey, publicKey}`. Only
   `masterKey` is consumed downstream — `publicKey` flows through the `keyServer` tag's own
   upstream.
7. **Publish** (lines 672-676): `setPhase('publishing contracts')`; yield the inner `publish` tag (a
   `publishMove({name: '<name>.publish', signer, path: <vendoredPath OR Effect.gen{return gitFetch.path}>})`).
   On warm restart, the Move publish is cached by `publishMove`'s `(name, sourceHash, chainId)`
   discipline so this short-circuits.
8. **Register** (lines 684-685): `setPhase('registering on-chain key-server')`; yield the inner
   `keyServer` tag. On cache hit (verify probes `chain.getObject(cached)` and finds the on-chain
   object alive), returns the cached object id. On miss / verify-fail, runs
   `KeyServer::create_and_transfer_v2_independent_server` via the signer's `signAndExecute`,
   extracts the created id via
   `pickCreatedByType(result.objectChanges, {suffix: '::key_server::KeyServer'})`.
9. **Config render + master-key staging** (lines 695-781):
   - Resolve `sealStateDir = servicePath('seal')`, best-effort chmod 0o700.
   - Write `key-server-config.yaml` to `<sealStateDir>/key-server-config.yaml` with
     `nodeUrl = sui.rpc.container ?? sui.rpc.host`.
   - Write `master-key.env` to `<sealStateDir>/master-key.env` with `MASTER_KEY=<hex>\n`, chmod
     0o600.
   - Both files persist between cycles — NOT unlinked on scope close.
10. **Long-running container** (lines 789-872): `setPhase('starting key server')`; compose the
    container name as `seal-${name}-key-server` (further composed downstream into
    `<app>-<stack>-…`), pick the sui container network from `Sui.rpc.containerNetworks[0]`
    (defensive fallback to `suiNetworkName(identity)`), call `runDockerContainer` with: image tag,
    `env: {CONFIG_PATH, RUST_LOG=info}`, `envFiles: [masterKeyEnvFile]`,
    `mounts: [{source: configPath, target: '/etc/seal/key-server-config.yaml'}]`, `network: suiNet`,
    `routing: [{name: 'seal', entrypoint: 'seal', servicePort: 2024}]`,
    `ready: {kind: 'http', url: '${keyServerUrl}/health', timeoutMs: readyTimeoutMs}`,
    `onOutputLine: makeSealOutputSink(...)`, `stopGraceSeconds: 15`. `DockerError` and
    `ReadyProbeError` are caught and remapped to `SealError`.
11. **Registries** (lines 874-884):
    - `yield* PackageRegistry` (ordering hint).
    - `publishEndpoint({name: EndpointName.SEAL_KEY_SERVER, url: keyServerUrl, kind: 'seal-key-server'})`.
    - `publishSealState({name, objectId: keyServerObjectId})`.
12. **Return** (lines 1079-1090):
    `{keyServer: {serverConfigs: [{objectId, weight: 1}], keyServerUrl, objectId}, keyManager: {masterKeyEnvFile, rotate}, packageId}`.

Inner tags (`sealImage`, optional `sourceFetch`, `publish`, `keypair`, `keyServer`) all appear in
the `__upstreamKeys` list (`seal/internal.ts:1125-1134`), so the topo scheduler builds them at the
levels they require BEFORE seal's primary acquire fires. The lifted siblings (`sealImage`,
`sourceFetch`) are also exposed via `__extraMembers` (line 1212) so they become first-class
top-level dep-graph nodes (parallel with sui's boot, etc.).

### Startup — `sealKnownKeyServer` (testnet / mainnet / fork)

Far simpler. The `build` Effect (`seal/internal.ts:1254-1271`):

1. `publishEndpoint({name: SEAL_KEY_SERVER, url: keyServerUrl, kind: 'seal-key-server'})`.
2. `publishSealState({name, objectId})`.
3. Return `{serverConfigs: [{objectId, weight: 1}], keyServerUrl, objectId}`.

No docker, no image build, no chain interactions, no state-store writes.

### Ready criteria

- **`sealLocalKeygen`**: The HTTP ready probe at `GET ${keyServerUrl}/health` returning 200
  (`seal/internal.ts:837-841`). `/health` returns `{name, version, status: 'up'}` once the binary
  has bound and parsed `CONFIG_PATH`. Raced against `docker wait` (default `awaitExit: true`) so a
  crash during boot surfaces the log tail instead of a blind timeout. Default timeout 60s.
- **`sealKnownKeyServer`**: Synchronous resolution — no ready probe. The remote deployment's
  liveness is the caller's problem.

### Restart behavior

- **Warm restart (`pnpm dev` after a clean shutdown, same chainId)**:
  - `sealImage`: docker-image cache hit, no rebuild.
  - `sourceFetch`: gitFetch's content-addressed cache hit, no re-clone.
  - `publish`: `publishMove`'s `(name, sourceHash, chainId)` cache hit, no re-publish.
  - `keypair`: B8 cascade verify passes (cached keypair structure OK + sibling key-server cache
    present + chain object still alive + master-key.env file present) → returns cached keypair, no
    re-keygen.
  - `keyServer`: verify probe (`chain.getObject(cached)`) passes → returns cached object id, no
    re-register.
  - `runDockerContainer`: reuse-if-image-matches probe in `Docker.run` adopts the existing container
    if image + name match.
- **Chain regenesis (chainId changes)**:
  - Cache keys flip because `chainId` is folded in → keypair re-derives + key-server re-registers.
- **Verify-fail cascade**:
  - If the on-chain `KeyServer` object disappears (e.g. selective regenesis), `keyServer`'s verify
    returns undefined → re-register.
  - The keypair's verify probe (B8 cascade) ALSO inspects the sibling key-server cache; if the cache
    claims a key-server but `chain.getObject` returns undefined, the keypair invalidates its own
    cache so the next acquire writes a freshly-aligned (keypair, on-chain object) pair. (Per RS5:
    cross-primitive invalidation flows through verify dependencies, not eviction side-effects.)
- **`runtime/seal/master-key.env` missing** (e.g. partial snapshot restore):
  - The keypair's verify probe step 3 catches the missing file and returns undefined → re-derive.
- **Image change (`SEAL_VERSION` bump)**:
  - New content-addressed image tag → `runDockerContainer`'s reuse probe sees image mismatch →
    forced recreate.

### Teardown

- **Per-primitive scope close** (triggered by stack down / SIGINT / hot restart):
  - `runDockerContainer`'s `docker stop` finalizer fires with `stopGraceSeconds: 15`
    (`seal/internal.ts:851`).
  - Container's entrypoint shell forwards SIGTERM as SIGINT to the child `key-server`; child exits
    cleanly (exit 130 = 128+2) per `images/seal/entrypoint.sh:30-50`.
  - All `docker stop` finalizers fire in PARALLEL across primitives via the supervisor's
    parallel-finalizer scope (`engine/supervisor.ts:1567-1577`), so seal's 15s grace overlaps with
    walrus's 20s and sui's 30s — net teardown ≈ max(grace), not sum.
- **`master-key.env` and `key-server-config.yaml`**: explicitly NOT unlinked on scope close
  (`seal/internal.ts:772-781`). Persisted so snapshot save → stack down → snapshot restore
  round-trip retains the master key (the chain-registered public key would otherwise mismatch on
  resume).
- **State-store entries (keypair + key-server-id)**: survive teardown. They're invalidated only by
  chain regenesis (the chainId fold).
- **Docker image**: not removed.
- **Network attachment**: detached when container is removed.

### `sealKnownKeyServer` teardown

No-op aside from the standard Layer scope-close. No docker resource, no on-disk file, no finalizer.

## Hard requirements / invariants

1. **The `KeyServer.url` registered on chain MUST equal the routed hostname the container runs
   behind** (`seal/internal.ts:817-819, 537`). The `@mysten/seal` SDK reads the on-chain `KeyServer`
   object to discover the endpoint; mismatch → SDK can't reach the server. The factory enforces this
   by minting the URL once via `resolveKeyServerUrl` and using the same value in both the on-chain
   Move call (line 537) and the container's `routing[].name = 'seal'` entry (line 824). Asserted at
   `seal/internal.ts:817-819` in code comments; tested transitively by the parallel-stack test
   (`parallel-stack.test.ts:45-68`).
2. **The master-key env-file MUST be 0o600 within a 0o700 parent dir**
   (`seal/internal.ts:709-716, 764-771`). Best-effort with a `nodeFs.chmod` fallback for filesystems
   where `FileSystem.chmod` fails (e.g. certain mount types). Asserted only by code review — no
   test.
3. **The master-key MUST NOT pass via `-e MASTER_KEY=…`** (`seal/internal.ts:740-745`). The `-e`
   form surfaces the value in host process env (PID-visible) and `docker inspect` output. Always use
   `--env-file <masterKeyEnvFile>`. Asserted by code structure (the `envFiles:` field is the only
   path; `env:` does not contain `MASTER_KEY`).
4. **The `master-key.env` file MUST NOT be unlinked on scope close** (`seal/internal.ts:772-781`).
   Required so snapshot → restore round-trip retains the key. Asserted only by absence of an unlink
   call.
5. **State-store cache keys MUST fold in chainId** (`engine/state-store-keys.ts:64-78`,
   `seal/internal.ts:622-631`): Without this, a chain regenesis would reuse a stale keypair against
   fresh chain state. Asserted in `parallel-stack.test.ts:121-138`.
6. **State-store cache keys MUST fold in the factory `name`** (via
   `sealInputsHash = contentHash({name})`, `seal/internal.ts:346-348`): Without this, two
   `sealLocalKeygen({name: 'a'})` and `sealLocalKeygen({name: 'b'})` in the same stack would
   collide. Asserted in `parallel-stack.test.ts:139-157` (same chainId + same hash produces same key
   — the converse).
7. **The seal port 2024 MUST NOT be host-published** (`seal/internal.ts:99-103, 822-828`): Two
   stacks of the same app must coexist on the well-known port 2024 — Traefik dispatches by `Host:`
   header. A `ports: {…}` field on the `runDockerContainer` payload for the key-server would make
   the second stack's `docker run` fail to bind. Asserted by source-text grep in
   `parallel-stack.test.ts:160-194` — the test reads the source file and asserts no `ports:` key
   appears in the `runDockerContainer` block.
8. **The router id MUST fold in stack identity** (`engine/router-hostname.ts:34-37`): Two stacks
   must mint distinct `traefik.http.routers.<id>.*` ids; collision means the second container
   silently steals the first's routing rule. Asserted in `parallel-stack.test.ts:58-68`.
9. **The routed hostname MUST fold in stack identity** (`engine/router-hostname.ts:22-25`): Main
   stack: `seal.<app>.localhost`; non-main: `<stack>.seal.<app>.localhost`. Asserted in
   `parallel-stack.test.ts:45-56`.
10. **The container name MUST fold in stack + network identity** (`engine/docker/core.ts`'s
    `composeContainerName`): `<app>-<stack>[-<network>]-seal-<name>-key-server`. Asserted in
    `parallel-stack.test.ts:71-117`.
11. **The Move package version (`SEAL_VERSION`) MUST match the binary version**
    (`seal/internal.ts:107-110, 144-149`): The Dockerfile's `SEAL_VERSION` build arg AND the
    gitFetch's `ref:` are both tied to the same `version` option. Out-of-sync versions cause silent
    runtime contract mismatches.
12. **`sealLocalKeygen` MUST refuse `*-fork` networks at factory time**
    (`seal/internal.ts:251-263`): The key-server binary's chain client is JSON-RPC-bound
    (`crates/key-server/src/sui_rpc_client.rs`); sui-fork's gRPC `simulate_transaction` returns
    "unsupported". Refusal is
    `throw new ForkIncompatibleError({variant: 'sealLocalKeygen', network, message, hint})`.
    Asserted in `seal.fork-localkeygen-refused.test.ts:50-95`.
13. **`Seal()` on `*-fork` MUST route to `sealKnownKeyServer` with the wrapped upstream's
    deployment** (`seal.ts:178-190`, via `resolveDeploymentNetwork`): The fork variant's upstream is
    the canonical key-server source. Asserted in `seal.fork-known.docker.test.ts:19` (placeholder;
    not yet running).
14. **`Seal()` on localnet MUST require `signer`** (`seal.ts:193-199`): Otherwise the Move package
    can't be published. Synchronous throw at factory call site.
15. **`SealKeyManagerTag` MUST NOT be produced by `sealKnownKeyServer`**
    (`seal/internal.ts:1238-1280`, `seal.test.ts:68-89`): We don't own the master key for a remote
    deployment, so there's no manager surface. Asserted by `seal.test.ts:68-89` — yielding
    `SealKeyManagerTag` against a `sealKnownKeyServer` layer surfaces as a runtime resolution
    failure.
16. **The keygen container's stdout MUST be redacted in any propagated error**
    (`seal/internal.ts:467-475, 938-942, 1333`): A failed keygen that echoed the master key before
    exiting non-zero would otherwise embed the secret in a `SealError` visible to logs / traces /
    user terminals. `redactMasterKey` is applied at every error-surfacing site.
17. **The keypair's verify probe MUST NOT call `state.remove(otherKey)`**
    (`seal/internal.ts:417-425, RS5 in design doc`): Cross-primitive invalidation flows through
    verify dependencies, not eviction side-effects. The keypair reads the sibling cache; the sibling
    (`keyServer`) is responsible for its own eviction on next acquire when its verify fails.
18. **`SealKeyServerEntry` MUST remain structurally assignable to `@mysten/seal`'s
    `KeyServerConfig`** (`seal.test.ts:26-33`): Peer-dep boundary; structural drift would silently
    break `new SealClient({serverConfigs})`. Asserted at compile time via a
    `_SealKeyServerEntryCheck = … extends … ? true : never` pattern.
19. **The `network: !Devnet` discriminator in `key-server-config.yaml` is load-bearing**
    (`seal/internal.ts:1292-1316`): Env-only mode silently forces `network: Testnet` + a
    public-fullnode URL, ignoring the supplied `NODE_URL`. Going through `CONFIG_PATH` with the
    `!Devnet` discriminator is what binds the daemon to `sui-localnet`.
20. **The `key-server-config.yaml` MUST be persisted under `runtime/seal/`, NOT a scoped temp dir**
    (`seal/internal.ts:700-707`): If the host path is cleaned between `pnpm dev` invocations,
    `docker start` of the prior container fails with
    `not a directory: Are you trying to mount a directory onto a file (or vice-versa)?`.
21. **The `key-server` binary MUST run as a non-PID-1 child of the entrypoint shell**
    (`images/seal/entrypoint.sh:30-50`): The binary's `#[tokio::main] async fn main` installs no
    signal handler. As PID 1, `docker stop`'s SIGTERM is ignored → grace timeout → SIGKILL → exit
    137 → next-up trip "UNCLEAN PRIOR SHUTDOWN". The shell wrapper forwards SIGINT to the child;
    non-PID-1 processes terminate cleanly on default-action signals (exit 130).
22. **`sealImage` and `sourceFetch` MUST be lifted via `__extraMembers`**
    (`seal/internal.ts:1198-1213`): Lifting makes them first-class dep-graph nodes so the topo
    scheduler can parallelize the image build with sui's boot. Asserted only structurally; the
    `parallel-stack.test.ts:160-194` source-text grep also confirms the structure.
23. **The Effect's `R` channel on `SealKeyManager.rotate` MUST be `never`**
    (`seal/internal.ts:592-595, 1069-1076`): The consumer holding the manager shape doesn't expect
    to provide `ChildProcessSpawner` / `Identity`. The acquire body captures both at acquire time
    and pre-provides them via `Effect.provideService` so the surfaced `rotate` is
    `Effect<void, SealError>`. Asserted by the type of `SealKeyManager.rotate`.

## Failure modes

| Trigger                                                                        | Current behavior                                                                                                                                                                          | Recovery path                                                                                                                         |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **`opts.signer` missing on localnet**                                          | Synchronous `throw new Error('Seal() on localnet requires a signer: ref ...')` at factory call site (`seal.ts:193-199`).                                                                  | User passes a signer Account ref.                                                                                                     |
| **`sealLocalKeygen` composed on `*-fork`**                                     | Synchronous `throw new ForkIncompatibleError({variant, network, message, hint})` at factory call site (`seal/internal.ts:252-263`).                                                       | Switch to `Seal()` (auto-routes to known-key-server in fork mode) or `sealKnownKeyServer({network})`.                                 |
| **`sealKnownKeyServer` with neither `network` nor `(objectId, keyServerUrl)`** | Synchronous `throw new Error('sealKnownKeyServer: missing required fields. Pass network or set objectId/keyServerUrl ...')` (`seal/internal.ts:1247-1252`).                               | Pass a known `network` or both override fields.                                                                                       |
| **Router `seal` entrypoint not registered**                                    | `SealError({phase: 'port-alloc', message: 'router entrypoint seal not registered'})` (`seal/internal.ts:489-497`).                                                                        | Indicates a misconfigured router substrate; should never happen in production (module-load-time registration).                        |
| **`seal-cli genkey` container fails (DockerError)**                            | Caught at `seal/internal.ts:452-461`, remapped to `SealError({phase: 'keygen', message: '... keygen container failed ...', cause})`.                                                      | Investigate docker / image / network — surfaced in pretty-error output.                                                               |
| **`seal-cli genkey` exits non-zero**                                           | `SealError({phase: 'keygen', exitCode, stdout: redactMasterKey(...), stderr: redactMasterKey(...)})` (`seal/internal.ts:462-476`). Master key redacted from echoes.                       | Investigate stderr / stdout; usually a binary ABI mismatch.                                                                           |
| **`parseSealKeygenOutput` can't find `Master key:` / `Public key:`**           | `throw new Error('seal.keygen: could not parse seal-cli genkey output ...')` with redacted tail (`seal/internal.ts:1330-1335`).                                                           | Indicates an upstream output format change; bump `seal-cli`'s parser.                                                                 |
| **Move publish failure**                                                       | Propagated as `PublishError` from `publishMove`; rethrown by the outer catch as `SealError({phase: 'seal', cause})` (`seal/internal.ts:1092-1102`).                                       | Investigate Move source / signer balance / chain state.                                                                               |
| **`KeyServer::create_and_transfer_v2_independent_server` Move call fails**     | Caught at `seal/internal.ts:542-550`, remapped to `SealError({phase: 'register', message, cause})`.                                                                                       | Investigate signer balance / package id / chain state.                                                                                |
| **`KeyServer` object missing from `result.objectChanges`**                     | `SealError({phase: 'register', message: 'KeyServer object missing from objectChanges (digest=...)'})` (`seal/internal.ts:555-563`).                                                       | Indicates a Move ABI shift; check the upstream Move package.                                                                          |
| **Config-render write failure**                                                | `SealError({phase: 'config-render', message: 'could not write key-server config to ...'})` (`seal/internal.ts:729-737`).                                                                  | Check `runtime/seal/` perms / disk full.                                                                                              |
| **`master-key.env` write failure**                                             | `SealError({phase: 'config-render', message: 'could not write master-key env-file to ...'})` (`seal/internal.ts:755-763`).                                                                | Same.                                                                                                                                 |
| **`chmod 0o600` fails on `master-key.env`**                                    | `nodeFs.chmod` fallback runs; result `Effect.ignore`'d (`seal/internal.ts:764-771`).                                                                                                      | Master key remains readable to anyone who can read the file — concerning but tolerated. **OPEN QUESTION**: Should this log a warning? |
| **`docker run` fails for the key-server container**                            | Caught at `seal/internal.ts:853-861`, remapped to `SealError({phase: 'container', cause})`.                                                                                               | Investigate image / network / port collision.                                                                                         |
| **`/health` ready probe times out (60s default)**                              | `ReadyProbeError` caught at `seal/internal.ts:862-871`, remapped to `SealError({phase: 'ready', stderr: cause.detail, cause})`. Container's log tail surfaces in `stderr`.                | Investigate container logs — usually a config parse failure, missing env, or wrong `node_url`.                                        |
| **`key-server` container crashes during boot**                                 | `docker wait` race against the ready probe surfaces the crash earlier than the timeout — log tail included.                                                                               | Investigate logs.                                                                                                                     |
| **B8 cascade — sibling key-server cache present but chain object missing**     | Keypair's verify returns `undefined` → re-derive keypair (`seal/internal.ts:417-425`); the `keyServer` tag's own verify will also independently evict its entry on the next acquire step. | Self-healing.                                                                                                                         |
| **`master-key.env` missing on resume**                                         | Keypair's verify step 3 catches it (`seal/internal.ts:431-439`) → re-derive keypair → outer acquire writes a fresh aligned (keypair, on-chain object) pair.                               | Self-healing.                                                                                                                         |
| **`rotate` Effect failure (keygen / register / restart / ready)**              | Each step wraps its low-level error into `SealError({phase: 'rotate', ...})`. State-store NOT updated if any step fails; the daemon continues serving the pre-rotation keys.              | Caller retries; investigate per-phase error.                                                                                          |

## Persistence model

### What survives restart (state-store entries + on-disk paths)

- **State-store** (under `<state-dir>/state.json`):
  - `seal/bls-keypair/<chainId>/<inputsHash>` → `{masterKey, publicKey}` hex blobs.
  - `seal/key-server-id/<chainId>/<inputsHash>` → on-chain `KeyServer` object id string.
- **On-disk under `<state-dir>/runtime/seal/`**:
  - `master-key.env` (0o600).
  - `key-server-config.yaml` (rendered).

### What survives snapshot

- **State.json**: Yes — `snapshot save` copies it directly. Restored on `snapshot apply`.
- **`runtime/seal/master-key.env`**: Yes — captured under `runtime.tar` (per
  `engine/snapshot.ts:1-11, 465-479`). Restored as-is.
- **`runtime/seal/key-server-config.yaml`**: Yes — same `runtime.tar` capture.
- **Container image**: Yes — `docker commit devstack-snap:<id>-<name>` + `docker save` per container
  in `opts.containers` (`engine/snapshot.ts:25-30`). Restored via `docker load` on apply. The seal
  key-server's writable layer is mostly empty (master key is in-memory), so the image is small.

### What gets wiped on `devstack wipe`

The entire `<state-dir>` is wiped (per the SHUTDOWN_LOG_MESSAGE at `engine/supervisor.ts:104-105`:
"Run `pnpm exec devstack wipe --yes` to clear all local state"):

- All state-store entries (including seal's keypair + key-server-id).
- All `runtime/` paths, including `master-key.env` and `key-server-config.yaml`.
- Docker containers + networks (via the orphan sweep).
- Docker images: NOT wiped by `wipe` — they survive (image cache is content-addressed, separate from
  stack state).

### What is process-local only

- The TUI log buffer (the engine's in-memory `appendLog` ring).
- Effect MemoMap entries (per-process).
- The `rotate` closure's captured `signer`, `spawner`, `identity` values (process-local; rebuilt on
  each acquire).
- The key-server's in-memory session caches + rate-limit counters (per `seal/internal.ts:48-50`).
- Any in-flight `/v1/fetch_key` requests (drop on teardown).

## Modes & variants

Four operative modes for `Seal()`. The factory's branch decision is driven entirely by
`resolveNetwork()`:

| Lifecycle dimension                       | `local-keygen` (localnet)                                                                                                                                                                                                                                                                                                                                                                                     | `live` (testnet / mainnet)                                                                                                                  | `fork-known` (`*-fork`)                                                                                                                                                                | `fork-localkeygen-refused`                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**                               | `Seal({signer})` on `DEVSTACK_NETWORK=localnet` (or unset)                                                                                                                                                                                                                                                                                                                                                    | `Seal({})` on `DEVSTACK_NETWORK=testnet` or `=mainnet`                                                                                      | `Seal({})` on `DEVSTACK_NETWORK=*-fork`                                                                                                                                                | Explicit `sealLocalKeygen({signer})` on any `*-fork` network                                                                                  |
| **Public factory routes to**              | `sealLocalKeygen()` (`seal.ts:200-205`)                                                                                                                                                                                                                                                                                                                                                                       | `sealKnownKeyServer({network: resolveDeploymentNetwork(network)})` (`seal.ts:181-190`)                                                      | Same — `sealKnownKeyServer({network: 'testnet'\|'mainnet'\|'devnet'})` via `resolveDeploymentNetwork(*-fork)`                                                                          | N/A — `sealLocalKeygen` throws synchronously                                                                                                  |
| **Container(s)**                          | One: `<app>-<stack>-seal-<name>-key-server` (long-running). Plus one short-lived `seal.<name>.keygen` and one short-lived `seal.<name>.publish` (via publishMove) per cold start. Plus rotation-time `seal.<name>.keygen.rotate.<ts>`.                                                                                                                                                                        | None                                                                                                                                        | None                                                                                                                                                                                   | N/A                                                                                                                                           |
| **Image**                                 | Built from `packages/devstack/images/seal/Dockerfile` (or pulled via `options.image`) with `SEAL_VERSION` arg.                                                                                                                                                                                                                                                                                                | None                                                                                                                                        | None                                                                                                                                                                                   | N/A                                                                                                                                           |
| **Startup sequence**                      | 11-step (deps → captures → cache keys → router → image → keygen → publish → register → config-render + master-key → container → registries). See "Lifecycle / Startup — `sealLocalKeygen`" above.                                                                                                                                                                                                             | 2-step: `publishEndpoint` then `publishSealState`. No chain, no docker.                                                                     | Same as `live`. The fork's gRPC port can serve `getObject(keyServerObjectId)` reads of the upstream's known key server.                                                                | Throw at factory call site BEFORE any acquire fires.                                                                                          |
| **Ready criteria**                        | HTTP probe `GET ${keyServerUrl}/health` → 200, raced against `docker wait`. Default 60s timeout.                                                                                                                                                                                                                                                                                                              | Synchronous Layer resolution.                                                                                                               | Synchronous Layer resolution.                                                                                                                                                          | N/A                                                                                                                                           |
| **Persistence**                           | State-store: `seal/bls-keypair/<chainId>/<inputsHash>`, `seal/key-server-id/<chainId>/<inputsHash>`. On-disk: `runtime/seal/master-key.env` (0o600), `runtime/seal/key-server-config.yaml`.                                                                                                                                                                                                                   | None                                                                                                                                        | None                                                                                                                                                                                   | N/A                                                                                                                                           |
| **Teardown**                              | `docker stop` finalizer with `stopGraceSeconds: 15`. Files NOT unlinked.                                                                                                                                                                                                                                                                                                                                      | No-op                                                                                                                                       | No-op                                                                                                                                                                                  | N/A                                                                                                                                           |
| **Dependencies (yielded inside acquire)** | `SuiTag`, `options.signer`, `StateStore`, `Identity`, `ChildProcessSpawner`, `EngineHandle?`, `Path.Path`, `FileSystem.FileSystem`. Inner upstream tags: `sealImage`, `sourceFetch?`, `publish` (publishMove), `keypair` (onChainArtifact), `keyServer` (onChainArtifact). Plus `options.dependsOn`.                                                                                                          | None — pure value-publishing. Only the `EndpointRegistry` + `SealStateRegistry` writes need to settle.                                      | Same as `live`. The fork's gRPC port is referenced only at observation time (e.g. for the planned `KnownPackage('seal', {seedObjects})` flow per `seal.fork-known.docker.test.ts:23`). | N/A                                                                                                                                           |
| **Hard requirements**                     | All 23 invariants listed above. Most load-bearing: `KeyServer.url == routed hostname`, master-key file perms, no host-port-publish of 2024, fork refusal in pure form.                                                                                                                                                                                                                                        | Only #15 (`SealKeyManagerTag` MUST NOT be produced — exists as runtime check). #18 (peer-dep structural-assignability) applies universally. | Same as `live`. Plus #13 (`Seal()` routes correctly via `resolveDeploymentNetwork`).                                                                                                   | #12 (factory throws synchronously with actionable hint).                                                                                      |
| **Failure modes**                         | Full surface: keygen exit non-zero, publish failure, register failure, config-render write failure, docker run failure, ready probe timeout, B8 cascade re-derive, rotate phase failures.                                                                                                                                                                                                                     | Only the synchronous "missing required fields" throw (when neither `network` nor `objectId+keyServerUrl` resolves).                         | Same as `live`. (Currently no known runtime failure mode beyond the registry write.)                                                                                                   | The factory throws `ForkIncompatibleError`.                                                                                                   |
| **Key handling**                          | Owns the BLS12-381 master key. Generated by `seal-cli genkey` on first run; cached in state-store + `runtime/seal/master-key.env` (0o600). Rotation supported via `SealKeyManagerTag.rotate`.                                                                                                                                                                                                                 | Read-only. Does not own a master key. Public key is retrieved dynamically by `@mysten/seal` from `<keyServerUrl>/v1/service`.               | Same as `live` — points at the wrapped upstream's deployment.                                                                                                                          | N/A                                                                                                                                           |
| **Inner-tag structure**                   | `sealImage` (`dockerImage`), `sourceFetch?` (`gitFetch`, when no `movePackagePath`), `publish` (`publishMove`), `keypair` (`onChainArtifact`), `keyServer` (`onChainArtifact`), and the private `SealLocalKeygenInternal` Context.Service class (closure-bound, key `@devstack/SealLocalKeygenInternal/${name}`). Two projection layers (`SealKeyServerTag`, `SealKeyManagerTag`) read from the internal tag. | None — single `Effect.fn` build body bound directly to `SealKeyServerTag` via `provide()`.                                                  | Same as `live`.                                                                                                                                                                        | N/A                                                                                                                                           |
| **Lifted siblings (`__extraMembers`)**    | `[sealImage]` (always) plus `[sourceFetch]` if `movePackagePath` is unset (`seal/internal.ts:1198-1199`).                                                                                                                                                                                                                                                                                                     | None                                                                                                                                        | None                                                                                                                                                                                   | N/A                                                                                                                                           |
| **Surfaced tags**                         | Both `SealKeyServerTag` AND `SealKeyManagerTag`.                                                                                                                                                                                                                                                                                                                                                              | `SealKeyServerTag` ONLY (no manager — we don't own the key).                                                                                | Same as `live`.                                                                                                                                                                        | N/A                                                                                                                                           |
| **Manifest contribution**                 | `services.seal.keyServer` (the routed local URL) + `services.seal.objectId` (the on-chain registered KeyServer id).                                                                                                                                                                                                                                                                                           | `services.seal.keyServer` (the remote URL) + `services.seal.objectId` (the known testnet KeyServer id).                                     | Same as `live`.                                                                                                                                                                        | N/A                                                                                                                                           |
| **TUI lifecycle entry key**               | `@devstack/SealLocalKeygenInternal/${name}` (single entry, the projection layers don't get their own).                                                                                                                                                                                                                                                                                                        | `<name>` (default `'seal'`) — bound to `SealKeyServerTag` directly.                                                                         | Same as `live`.                                                                                                                                                                        | N/A                                                                                                                                           |
| **Test coverage**                         | `seal/parallel-stack.test.ts` (host-state stack-keying invariants), `seal/parallel-stack.docker.test.ts` (gated e2e). E2E coverage via `examples/private-content`.                                                                                                                                                                                                                                            | `seal.test.ts:47-103` (provides tag from network lookup; does NOT provide manager tag; explicit override wins).                             | `seal.fork-known.docker.test.ts` (gated placeholder).                                                                                                                                  | `seal.fork-localkeygen-refused.test.ts` (mainnet-fork, testnet-fork, devnet-fork all throw; localnet does NOT throw `ForkIncompatibleError`). |
| **Rotation supported**                    | Yes — `SealKeyManagerTag.rotate` regenerates the BLS keypair, registers a NEW on-chain `KeyServerV2 Independent` (the upstream contract has no in-place pk mutation), re-renders yaml + env-file, restarts the container, re-probes `/health`, updates state-store caches. NOT a hot-swap (`SealKeyServerTag`'s cached shape holds pre-rotation values until a hot-restart).                                  | No (no manager tag).                                                                                                                        | No (no manager tag).                                                                                                                                                                   | N/A                                                                                                                                           |

## Test coverage

### `services/seal.test.ts` (112 LOC)

Compile-time + runtime smoke that `sealKnownKeyServer` provides `SealKeyServerTag` and NOT
`SealKeyManagerTag`.

- **`sealKnownKeyServer › provides SealKeyServerTag from a network lookup`** (lines 48-66): Composes
  `sealKnownKeyServer({network: 'testnet'})`, yields `SealKeyServerTag`, asserts `keyServerUrl` and
  `objectId` match `knownDeployments.seal.testnet`, asserts `serverConfigs` is a one-element array
  `[{objectId, weight: 1}]`.
- **`sealKnownKeyServer › does NOT provide SealKeyManagerTag`** (lines 68-89): Composes the same
  factory, yields `SealKeyManagerTag` against a layer that doesn't provide it, asserts
  `Exit.isFailure(exit)` is true. Cast through `unknown` because the layer's `R` channel correctly
  doesn't expose `SealKeyManagerTag`.
- **`sealKnownKeyServer › explicit keyServerUrl overrides the network lookup`** (lines 91-103):
  Asserts the override field wins over the registry lookup.
- **`sealKnownKeyServer › throws at factory time when neither network nor required fields are provided`**
  (lines 105-111): Asserts synchronous throw with `/missing required fields/`.
- **Type-level `_SealKeyServerEntryCheck`** (lines 26-33): Compile-time guard against
  `SealKeyServerEntry` drifting from `@mysten/seal`'s `KeyServerConfig`. Runtime no-op.

### `services/seal.fork-known.docker.test.ts` (27 LOC)

Gated behind `RUN_FORK_DOCKER_TESTS=1`.

- **`services/seal fork docker gate (P3.T5) › Seal() on testnet-fork composes to sealKnownKeyServer(testnet); KeyServer-object read succeeds`**
  (lines 19-26): Placeholder. Asserts only `SHOULD_RUN === true`. Pending docker wiring — full
  assertion will read `knownDeployments.seal.testnet.keyServerObjectId` via the fork's gRPC port.

### `services/seal.fork-localkeygen-refused.test.ts` (96 LOC)

Pure unit — no docker, no supervisor. Manipulates `process.env.DEVSTACK_NETWORK` with
beforeEach/afterEach restore.

- **`Phase 3 P3.T6 — sealLocalKeygen refused under fork mode › throws ForkIncompatibleError on mainnet-fork`**
  (lines 50-66): Sets `DEVSTACK_NETWORK=mainnet-fork`, asserts
  `sealLocalKeygen({signer: stubSigner})` throws `ForkIncompatibleError`. Inspects the thrown error:
  `e.variant === 'sealLocalKeygen'`, `e.network === 'mainnet-fork'`, `e.message` matches
  `/JSON-RPC/`, `e.hint` matches `/Seal() or sealKnownKeyServer/` and includes `'mainnet'` (the
  stripped variant).
- **`...throws ForkIncompatibleError on testnet-fork with the testnet recipe`** (lines 68-79): Same
  shape; asserts `e.hint` includes `'testnet'`.
- **`...throws ForkIncompatibleError on devnet-fork`** (lines 81-84): Asserts
  `ForkIncompatibleError` thrown.
- **`...does NOT throw ForkIncompatibleError on localnet`** (lines 86-95): Sets
  `DEVSTACK_NETWORK=localnet`, calls `sealLocalKeygen({signer: stubSigner})`. May throw something
  else (image-resolution outside docker context) but MUST NOT be `ForkIncompatibleError`.

### `services/seal/parallel-stack.test.ts` (195 LOC)

Unit-side proofs that the seal primitive's host-side state is stack-keyed.

- **`services/seal parallel-stack invariants › routed hostname (Traefik Host: header dispatch) › two stacks of the same app resolve to distinct seal hostnames`**
  (lines 45-56): `routerHostname({app:'arena', stack:'main', network:'localnet'}, 'seal')` →
  `'seal.arena.localhost'`; `routerHostname({stack:'preview', ...}, 'seal')` →
  `'preview.seal.arena.localhost'`. Asserts they differ.
- **`...routed hostname › Traefik router id is stack-scoped so per-stack labels do not collide`**
  (lines 58-68): `routerId(stackA, 'seal')` → `'arena-main-seal'`; `routerId(stackB, 'seal')` →
  `'arena-preview-seal'`. Asserts they differ.
- **`...docker container name composition › two stacks of the same app mint distinct seal container names`**
  (lines 72-95): `composeContainerName('arena', 'main', 'localnet', 'seal-seal-key-server')` →
  `'arena-seal-seal-key-server'`; same for `stack=preview` → `'arena-preview-seal-seal-key-server'`.
  Asserts they differ.
- **`...docker container name composition › per-fork variants on different upstreams (mainnet vs testnet) also mint distinct names`**
  (lines 97-117): Same `(app, stack)` against `mainnet-fork` vs `testnet-fork` mint different names
  (network suffix appended).
- **`...state-store cache keys › two stacks with different chainIds get distinct seal/bls-keypair cache keys`**
  (lines 121-138): Two
  `buildCacheKey({namespace: 'seal/bls-keypair', chainId: 'chainA'\|'chainB', inputsHash: 'abc'})`
  differ.
- **`...state-store cache keys › same chainId + same name produces the SAME cache key (intentional reuse on resume)`**
  (lines 139-157): Two identical inputs produce identical keys — warm-resume invariant.
- **`...seal entrypoint port › seal is intentionally served on a well-known port shared across stacks`**
  (lines 161-194): Reads `seal/internal.ts` as text, asserts `DEFAULT_KEY_SERVER_PORT = 2024`
  literal, asserts the long-lived container's `runDockerContainer` block does NOT contain `ports:`.
  Source-text regression-guard against a future refactor folding 2024 into a host-port publish.

### `services/seal/parallel-stack.docker.test.ts` (64 LOC)

Gated behind `RUN_SEAL_DOCKER_TESTS=1`.

- **`services/seal parallel-stack docker gate (P5.T3 sibling) › two seal stacks (main + preview) under the same app boot concurrently without collision`**
  (lines 32-63): Placeholder. Asserts only `SHOULD_RUN === true`. Pending docker wiring — full
  orchestration will compose two `sealLocalKeygen({name: 'seal'})` factories under two
  `defineDevstack` calls, apply both stacks concurrently, assert distinct `KeyServer.url`s, two
  running containers with distinct `devstack.stack` labels, both `/health` green, distinct BLS
  keypairs.

## Pain points today

1. **Header comment claim about `sealKnownKeyServer` on `/advanced` is stale** (`seal.ts:158-163`):
   "Plugin authors who need to pin a private Seal key-server registry can call
   `sealKnownKeyServer({...})` directly from `/advanced`" — but `sealKnownKeyServer` is NOT exported
   from `/advanced/index.ts` or `/advanced/plugin-author/index.ts`. Only `Seal` (the canonical
   factory) is. Either the export should be added or the comment should be revised.
2. **Two state-store-key derivation paths** (`engine/state-store-keys.ts:64-78` vs
   `seal/internal.ts:622-631`): `state-store-keys.ts` defines `sealBlsKeypair({chainId})` →
   `seal/bls-keypair/${chainId}`. But `seal/internal.ts` uses
   `buildCacheKey({namespace: 'seal/bls-keypair', chainId, inputsHash})` →
   `seal/bls-keypair/${chainId}/${inputsHash}`. The two SHAPES differ — `inputsHash` is in the
   in-code form but absent from the `state-store-keys` builder. Either the helper is unused (dead)
   or one of the two is wrong. **OPEN QUESTION**: which is correct, and what reads the
   `state-store-keys.ts` builder?
3. **In-memory staleness on `rotate`** (`seal/internal.ts:893-910`): Callers that already captured
   `SealKeyServerTag`'s shape (objectId / serverConfigs) by yielding the tag BEFORE rotate hold
   pre-rotation values. The Layer caches the shape; re-yielding in the same scope returns the same
   cached value. Picking up the new identity requires a hot-restart (TUI `r` / SIGUSR2 /
   watched-file edit). Treat rotate as an admin action, not a hot-swap. Documented in the code; no
   API to enforce.
4. **Old `KeyServer` objects orphan on rotate** (`seal/internal.ts:906-910`): Upstream
   `key_server.move` has no delete entry for Independent servers, so each rotation leaves the old
   object on-chain. Acceptable for localnet (ephemeral chain); orphans on testnet/mainnet — not
   supported for `Known*` factories.
5. **`SealKeyManager.rotate` requires manual cleanup before reuse**: Pre-provides
   `ChildProcessSpawner` + `Identity` at acquire time. If the captured `signer` value changes
   between cycles (e.g. the Account ref rotated to a new key), `rotate` operates against the
   original signer. **OPEN QUESTION**: does this matter in practice, or is the signer immutable
   per-stack?
6. **The image's `EXPOSE 9184`** (`images/seal/Dockerfile:44`) — what's port 9184? `routerHostname`
   and `routing[]` only mention 2024. **OPEN QUESTION**: Is 9184 a metrics port the binary listens
   on? It's never connected by devstack.
7. **The closure-bound `SealLocalKeygenInternal` class** (`seal/internal.ts:573-576`) is private and
   never re-imported elsewhere, but type-erased via `Object.assign(...) as unknown as StackMember`.
   The double-cast pattern (`as unknown as StackMember`, line 1216) is necessary because the class
   is a `Context.Service` and TypeScript can't statically prove it satisfies the `StackMember`
   structural shape after `Object.assign`. A bit awkward.
8. **The `makeSinkE` helper and the inline `makeSealOutputSink` body duplicate the same log-sink
   logic** (`seal/internal.ts:323-335` vs `603-612`). The duplication is because `makeSinkE` returns
   `Effect.Effect<OutputLineCallback>` (used by the inner `keypair`/`keyServer` produce bodies)
   while the inline form returns `OutputLineCallback` directly (used by the long-running container).
   Both could probably consolidate.
9. **`gitFetch` is a non-typed peer of `dockerImage`** in `__extraMembers` (line 1198-1199): The
   list is built conditionally with explicit array branches. A small util that filtered
   `[sealImage, sourceFetch].filter(x => x !== undefined)` would be tidier — though TypeScript
   inference on conditional readonly arrays is awkward.
10. **The factory throws `Error`, not `SealError`, for "signer missing" and "missing required
    fields"** (`seal.ts:193-199`, `seal/internal.ts:1247-1252`). Inconsistent with the
    `ForkIncompatibleError` pattern used for fork-mode refusal. **OPEN QUESTION**: Should these be
    `SealError({phase: 'config'})` or a new dedicated tagged error?
11. **The keypair's verify probe is the load-bearing B8 cascade** but its 3-step shape is
    undocumented elsewhere — the inline comment at `seal/internal.ts:356-379` is the only spec. The
    `notes/integration-contract-redesign.md` reference is to a design doc that may not survive into
    the v2 plans.
12. **`renderSealKeyServerConfig` defaults `tsSdkVersionRequirement` to `'>=0.4.5'`**
    (`seal/internal.ts:1302`). No configuration knob for this; downstream consumers using older
    `@mysten/seal` would be silently rejected. Whether this matters in practice depends on
    upstream's enforcement.
13. **`DEVSTACK_LOG_LEVEL` semantics are seal-internal but the same pattern exists in walrus**
    (`seal/internal.ts:120-133`, mirrors `services/walrus/{nodes,deploy}.ts` per the comment): The
    level-rank table and the env-var reading logic are duplicated. A shared helper would be cleaner.
14. **No "remote" key-server image variant or override path** for testnets that aren't `testnet` /
    `mainnet`: `sealKnownKeyServer` requires either a `network` lookup or an explicit
    `(objectId, keyServerUrl)` pair. A custom local-keygen-against-testnet (e.g. running an
    independent server with your own keypair on testnet) requires bypassing both factories and
    hand-rolling the surface.
15. **`SealStateRecord.objectId` is non-optional** (`engine/registries.ts:65`), but seal manifest
    field is `objectId?: string | undefined` (`runtime/manifest-schema.ts:47`). If
    `publishSealState` is called with an objectId, the manifest will have it; the optional in the
    schema is for the (impossible in current code) case where state isn't published. Minor schema
    drift.

## Open questions

1. **`engine/state-store-keys.ts:64-78`'s `sealBlsKeypair` / `sealKeyServerId` builders** — are they
   unused dead code, or is something reading them? `seal/internal.ts` uses
   `buildCacheKey({namespace, chainId, inputsHash})` exclusively, which produces a DIFFERENT slot
   (extra `inputsHash` segment). `grep` shows no consumer of the helpers' return values. (See Pain
   Points #2.)
2. **What is port 9184 (`EXPOSE 9184` in `images/seal/Dockerfile:44`)?** A metrics endpoint? Never
   connected in code, never routed, never asserted.
3. **The `DEFAULT_SEAL_VERSION = 'seal-v0.6.6'`** — what's the upgrade cadence policy? Is there a
   process for bumping it when a new release lands?
4. **`tsSdkVersionRequirement: '>=0.4.5'`** — what's the rationale for `>=0.4.5`?
   Upstream-recommended? Tested floor? Customizing it is impossible today.
5. **Rotate semantics when `signer` mutates** — if the captured `signer` is updated externally
   between acquire and rotate (e.g. the Account ref's underlying keypair rotated), does rotate still
   work as expected? See Pain Points #5.
6. **Multi-server (t-of-n committee) for `sealKnownKeyServer`** — `seal/internal.ts:1262-1266`
   mentions a "future `serverConfigs?` override" for t-of-n committees. Is this a planned feature,
   or just a placeholder?
7. **Multi-instance seal** — can two `sealLocalKeygen({name: 'seal-a'})` and
   `sealLocalKeygen({name: 'seal-b'})` coexist in the same stack today? The state-store key folds in
   `name` (per `sealInputsHash`), and the container name folds in `name`
   (`seal-${name}-key-server`), so structurally yes. But two containers would both try to register
   against the `seal` Traefik entrypoint on the same port 2024 with the same
   `routing[].name: 'seal'` — likely conflicts. Untested.
8. **`SealError.keyServer` field** (`engine/errors.ts:329-332`) — designed for multi-instance
   configurations but never set anywhere in `seal/internal.ts`. Dead at the moment.
9. **Snapshot-restore semantics when the chain image is captured separately** — the docs say
   `master-key.env` rides along under `runtime/`, but if the sui container's image is restored to a
   _different_ chainId, the state-store cache keys flip and the cached keypair becomes unreachable
   while the (stale) `master-key.env` file remains on disk. The keypair's verify probe will catch
   this (cache miss → re-derive), but the orphan file persists. Tolerable, but documenting would
   help.
10. **The header comment in `seal.ts:158-163`** mentions `Wave 3 / §10.3` of an external spec — what
    document is that? The v2 plans should canonicalize the canonical-vs-private factory boundary.
11. **Is the assertion in `parallel-stack.test.ts:171` (slice to `).effect`) brittle?** The test
    reads source as a string and slices the runDockerContainer block by literal `).effect` substring
    — would survive most refactors but breaks if the `).effect` boundary moves or the formatting
    changes. Acceptable for a structural source-text guard but documented as fragile.
12. **Does `sealKnownKeyServer` ever need to be a `StackMember` with a richer ready signal?** Today
    it has no readiness check beyond "the factory resolved its inputs." If the remote endpoint is
    down, callers get a network error at runtime — not surfaced through devstack's lifecycle.
13. **`gitFetch` + `dockerImage` lifting** — the comments at `seal/internal.ts:1159-1180` say
    "publish stays inner: it carries a runtime dependency on `sourceFetch.path`... cache
    discipline + state-store writes are tightly coupled with the composite's own acquire body." Is
    this still true after the substrate redesign? The reason for keeping `publish` inner might be
    obsolete.

## Opportunities noticed

1. **Consolidate `sealBlsKeypair` / `sealKeyServerId` builders** in `engine/state-store-keys.ts`: If
   they're dead (Open Question #1), delete them. If they're load-bearing somewhere, refactor
   `seal/internal.ts` to use them so the cache-key shape has a single source of truth. Asserted by
   `parallel-stack.test.ts:121-157`, but only through `buildCacheKey` — the helpers' canonicalness
   is unenforced.
2. **Add `sealKnownKeyServer` to `/advanced` exports** OR remove the stale comment at
   `seal.ts:158-163`. The docs and code disagree.
3. **Centralize `DEVSTACK_LOG_LEVEL` parsing**: The level-rank table + env-var resolution in
   `seal/internal.ts:120-133` is duplicated across walrus and seal. Lift to `engine/log-level.ts`
   (or similar).
4. **Lift the `makeSinkE` / inline-sink duplication** in `seal/internal.ts:323-335` vs `603-612`.
   One helper that returns either the Effect or the callback would be cleaner.
5. **Replace `throw new Error(...)` with `SealError({phase: 'config'})`** in `seal.ts:193-199` and
   `seal/internal.ts:1247-1252`. Consistent error vocabulary; integrates with pretty-error and
   trace-span surfaces.
6. **`SealError.keyServer` field is dead** — either start setting it (when multi-instance seal
   becomes real) or remove it.
7. **Schema drift between `SealStateRecord` (required `objectId`) and `SealManifest` (optional
   `objectId`)**: Both should agree. Likely the manifest should be required if the registry write is
   unconditional.
8. **The `key-server-config.yaml`'s `tsSdkVersionRequirement: '>=0.4.5'`** could be configurable via
   a new option on `SealLocalKeygenOptions` (e.g. `tsSdkVersionRequirement?: string`).
9. **`renderSealKeyServerConfig` could move to a templates dir or shared helper**: It's a 20-line
   yaml-builder living deep inside the primitive. Easier to maintain in a templates dir.
10. **The closure-bound `SealLocalKeygenInternal` class is a load-bearing trick**
    (`seal/internal.ts:573-576`) but uses `Object.assign` + `as unknown as StackMember` casts. Worth
    investigating if a more typed pattern (e.g. a `makeComposite(...)` helper that does the
    `__layers` + `__extraMembers` + `__kind` setup once) could replace the casts.
11. **The image's `EXPOSE 9184`** should be documented or removed. Dead-on-arrival otherwise.
12. **The two seal docker tests (`seal.fork-known.docker.test.ts`,
    `seal/parallel-stack.docker.test.ts`) are placeholders that only assert `SHOULD_RUN === true`**.
    They should either be wired or skipped via `describe.skip` (currently `describe.skipIf` already
    covers the gated case). They're noise in the file tree.
13. **`Seal()` rejects an explicit `signer` on testnet/mainnet only via ignore**
    (`seal.ts:151-153, 187`): "ignored on testnet/mainnet" is currently silent. A warning when an
    unused option is passed would help catch misconfigurations (e.g. user runs `--network mainnet`
    thinking their signer matters).
14. **The B8 cascade is documented inline** (`seal/internal.ts:356-379`) but the design rationale
    lives in `notes/integration-contract-redesign.md`. The v2 plans should canonicalize the cascade
    pattern (verify → sibling-cache-probe → on-chain-probe → file-existence-probe) as a reusable
    substrate for any composite primitive, not just seal.
15. **The signal-handler workaround in `images/seal/entrypoint.sh`** is identical in shape to
    `images/sui/entrypoint.sh` (per the header comment). Lift to a shared template for
    upstream-binary-with-no-signal-handler containers.
16. **The `redactMasterKey` helper and `MASTER_KEY_LINE_RE` could be generalized** to a
    `redactSecrets(stdout, patterns)` substrate. Other primitives (walrus, postgres) likely have
    analogous redaction needs — currently each rolls its own.
17. **The `display: (_kp: PersistedBlsKeypair) => ({title, primary: ''})` pattern**
    (`seal/internal.ts:389`) abuses the `display` callback purely for type inference. A more direct
    way to pin `T` on `onChainArtifact` would remove this hack.
18. **`SealOptions.name`** is undocumented (default `'seal'`) — surfacing it in the doc-comment more
    explicitly would help users who want to compose multiple seal instances (see Open Question #7).
19. **`KnownPackage('seal', {seedObjects})` flow** mentioned in
    `seal.fork-known.docker.test.ts:22-25` as Phase 3 P3.7 — a planned feature that would seed the
    upstream `KeyServer` object id into the fork. Worth confirming in v2 plans that this is still on
    the roadmap.

---

Summary findings (for the orchestrator):

- **Totals**: src 1567 LOC, tests 494 LOC, docker assets 114 LOC. Two factories (`sealLocalKeygen`,
  `sealKnownKeyServer`) behind one canonical `Seal()`.
- **Biggest finding**: The seal primitive is a "composite primitive" with deep inner-tag plumbing —
  a closure-bound `SealLocalKeygenInternal` Context.Service that two narrow projection layers
  (`SealKeyServerTag`, `SealKeyManagerTag`) read from, plus 4-5 inner sibling tags (`sealImage`,
  `sourceFetch?`, `publish`, `keypair`, `keyServer`), of which `sealImage` and `sourceFetch` are
  lifted to top-level via `__extraMembers`. The B8 cascade in the keypair's verify probe (3-step:
  structure → sibling-cache+chain-probe → file-existence) is the single most load-bearing piece of
  logic.
- **Top open question**: `engine/state-store-keys.ts:64-78`'s `sealBlsKeypair` / `sealKeyServerId`
  builders produce DIFFERENT cache keys than the inline `buildCacheKey(...)` calls in
  `seal/internal.ts:622-631`. Are the helpers dead code or is there a hidden consumer? This is the
  biggest unresolved correctness question.
- **Top opportunity**: Consolidate the seal/walrus log-level parsing and the secret-redaction
  substrate into shared helpers — both patterns are duplicated and grow with each new primitive.
- **Doc location**:
  `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/notes/v2-requirements/07-seal.md`.
