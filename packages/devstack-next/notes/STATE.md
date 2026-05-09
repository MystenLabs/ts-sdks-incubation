# devstack-next — current state

Living "where are we now" doc. Updated at session boundaries; PLAN.md
stays focused on architecture.

## HEAD

Branch: `integrate-devstack`. Most recent commits (oldest → newest):

```
ba4015b  L7 CLI snapshot — save | restore | list | delete
c5ac218  L7 CLI reset — stop runners + clear stack state
3c7cd1a  L7 CLI doctor — preflight checks
8bc5ce7  L6 accounts plugin — disk-backed Sui keystore + fund
20357f0  L6 walrus plugin — multi-node + aggregator
8fd9c20  L6 seal plugin — single-container key-server
57ee90c  L6 deepbook plugin — pre-deployed-id lookup
cd3f537  Package shape — add path + populate mvrPlaceholder
57847c4  rename codegen → manifest
9fc4b95  L6 bindings plugin — Move source → typed TS bindings
b71b1b3  L4 dockerImage runner — content-addressed builds
a8e4f4b  dockerContainer.image accepts Dep<string>
9448fa2  file-watching for `up`
039b312  expose attachFileWatcher as a public API
143aff9  L7 CLI stack — list + down (+ shared runner-state helper)
0d08759  viteDevServer helper + hostProcess provides
3934203  gitFetch helper + publishMove.path accepts Dep<string>
29a26ed  cliSigner helper — Sui CLI keystore signers
89772df  ResolvedDeps recurses through arrays + objects
dde94bc  sui plugin builds its own image via dockerImage
d65c2da  dockerImage buildContexts — BuildKit named contexts
ef03690  walrus plugin chains image build via dockerImage
587fc36  dockerOneShot runner — run-to-completion containers
b8c18cf  walrus.deploy + node-container deploy mount
0e4fff4  walrus.register — project deploy state into shapes
83ff236  publishViaSuiCli helper — host-CLI compile + tx.publish
18cfa87  sealLocalnet — gitFetch + publishMove + KeyServer register
174a0d1  deepbookLocalnet — gitFetch + publishMove + create-pool flow
f1d465b  stack new + stack use CLI subcommands
53ad8d3  accounts.fund AB-deposit (opt-in, gated on RPC reachability)
(this session)
         5a per-stack docker network primitive
         sui-localnet + walrus.deploy join via `sui-localnet` alias
         5b seal image build via dockerImage (binary fetch, no compile)
         5c seal.keygen via dockerOneShot (seal-cli genkey, disk-cached)
         dockerOneShot: idempotent re-runs, --entrypoint config
         5d sui.indexer-db (postgres sidecar) + sui.get('graphql')
         5e walrus committee on per-stack network (fixed IPs + aliases)
         dockerContainer.ip extended to function form for runtime IPs
```

Tests: 365 passing. Typecheck clean. Build clean.

## What's built

### Engine + factories (L1, L4)

```
src/engine/         L1 graph engine — pure logic, in-memory only
  build.ts            transitive Dep walk + request aggregation
  cycle.ts            reconciliation loop
  identity.ts         input hash + auto-hashed identity
  snapshot.ts         saveSnapshot orchestration
  topo.ts             topo sort, cycle detection
  class.ts            Engine — public API (start/stop/runOnce/cycle/subscribe/saveSnapshot/invalidate/restart/retry/pause/resume)
  types.ts            NodeImpl, Producer, Dep, DepRecipe, EngineState, EngineEvent, etc.

src/config.ts       L3 — defineDevstackConfig({ stack: [...] })

src/factories/      L4
  define.ts           define()
  define-schema.ts    defineSchema()
  dep.ts              dep() recipe builder

src/runners/        L4 — process/container/image runners
  host-process.ts     hostProcess({...})
  docker-container.ts dockerContainer({...}) — exposes provides.state + provides.hostPort.
                      `image` accepts a Dep<string> so dockerImage results chain in.
  docker-image.ts     dockerImage({...}) — content-addressed `docker build`.
                      Provides tag (`<prefix>/<name>:<hash>`), digest, full.
                      `buildContexts:` exposes BuildKit `--build-context` for
                      Dockerfiles that COPY --from=<name> (e.g. walrus's
                      cargo workspace fetched via `walrus-src=git#tag`).
  docker-one-shot.ts  dockerOneShot({...}) — run-to-completion containers
                      (deploy scripts, init jobs). Same image-Dep / env /
                      volumes surface; throws on non-zero exit with the
                      last 32 KB of combined output in the message.
                      `entrypoint:` overrides `--entrypoint`; `start`
                      bails early on stable `inputHash` so re-runs
                      don't fire unless inputs change (one-shot
                      semantics — fresh keygen runs would silently
                      invalidate captured outputs).
  docker-network.ts   `dockerNetwork` — singleton per-(app, stack) bridge
                      network with deterministic `/24` subnet
                      (`10.<octet>.0.0/24`, octet ∈ [1, 250] hashed
                      from `<appName>/<stack>`). Network name
                      `<appName>-<stack>`. Lifecycle: ensure on start,
                      remove on shutdown (engine reverses shutdown
                      order so attached containers tear down first).
                      `dockerContainer` and `dockerOneShot` join via
                      `network: dockerNetwork.get('name')` plus
                      `networkAlias` / `ip` (literal strings). Pulled
                      into the graph transitively whenever any
                      consumer Deps on it — no-docker stacks (live-net
                      sui stubs, `walrus({rpcUrls})`) skip it.

src/standard/       L4 — standard graph nodes
  ports.ts            singleton port allocator
  account-pool.ts     accountPool factory (generic, BYO-signer-type — kept
                      as a primitive; the disk-backed concrete plugin lives
                      under src/plugins/accounts.ts)

src/shapes/         WorldView typed shapes — Package, Endpoint, Account
```

### Helpers + plugins (L5, L6)

```
src/helpers/        L5 — sugar (publishMove, publishViaSuiCli,
                    runTransaction, gitFetch, cliSigner, envSigner,
                    viteDevServer).
                    publishMove.path accepts Dep<string> so users chain
                    gitFetch → publishMove for upstream Move vendoring.
                    publishViaSuiCli is the default publish callback
                    (host `sui move build` + tx.publish + sign +
                    execute); accepts an optional `capture:` callback
                    for plugins that surface Registry / AdminCap ids.

src/plugins/        L6
  accounts.ts         disk-backed Ed25519 keystore + fund step
                      (faucet + opt-in AB-deposit gated on RPC
                      reachability via `abMinBalanceMist`).
  bindings.ts         Move source → typed TS bindings via
                      `sui move summary` + `@mysten/codegen`. Atomic
                      dir swap so Vite never sees partial trees.
  deepbook.ts         pre-deployed package-id lookup (testnet/mainnet)
                      + `deepbookLocalnet({...})` sibling factory:
                      gitFetch + publishMove (capturing Registry +
                      AdminCap) + optional pool-creation flow.
  manifest.ts         typed-manifest TS emit (renamed from codegen.ts).
                      Sibling to bindings — runtime values vs. type bindings.
  seal.ts             single-container key-server schema. Chains
                      dockerImage (vendored Dockerfile under
                      seal/docker/, binary-fetch from the seal GitHub
                      release at SEAL_TAG — no rust compile) →
                      dockerContainer. The container's `MASTER_KEY`
                      env reads from `seal.keygen` (a dockerOneShot
                      running `seal-cli genkey` once, parsing master+
                      public key out of stdout, persisting to
                      `<stackDir>/.keys/seal-master-key.json` mode
                      0600, and exposing `masterKey` / `publicKey` /
                      `full` Deps). Schema-level `seal.get('publicKey')`
                      / `masterKey` surface the keys to consumers
                      (throws in url-override mode). `image:` override
                      skips the build for pre-built tags; `url:` skips
                      Docker entirely. `sealLocalnet({...})` sibling
                      factory drops the `publicKeyHex` opt — its
                      register step Deps on `seal.get('publicKey')`.
  sui.ts              localnet — chains dockerImage (vendored Dockerfile
                      under sui/docker/) → dockerContainer; image build
                      is content-addressed via SUI_VERSION build-arg.
                      Container joins `dockerNetwork` with alias
                      `sui-localnet` so siblings reach the localnet at
                      `sui-localnet:9000` / `:9123` without host-port
                      threading. Exported as
                      `SUI_LOCALNET_NETWORK_ALIAS`. A postgres sidecar
                      (`sui.indexer-db`, image postgres:16-alpine,
                      alias `sui-indexer-db`, no host port) backs sui's
                      embedded indexer + GraphQL — sui-localnet's args
                      now include `--with-indexer` (over the per-stack
                      network) and `--with-graphql=0.0.0.0:9125`.
                      Schema-level `sui.get('graphql')` provides the
                      host URL (`http://127.0.0.1:<port>/graphql`) on
                      localnet; throws on live nets where GraphQL
                      availability depends on the operator. `image:`
                      override skips the build for pre-built tags.
                      testnet/mainnet/devnet stubs unchanged.
  walrus.ts           multi-node committee + aggregator + deploy +
                      register. Two-stage image chain
                      `walrus.image.upstream` → `walrus.image` (the
                      latter chains BASE_IMAGE off the former's tag).
                      Storage-node containers join `dockerNetwork`
                      with fixed IPs `10.<octet>.0.<10+i>` (computed
                      from `dockerNetwork.octet` via the
                      `ip: ({ deps }) => ...` callback) and aliases
                      `walrus-node-<i>.localhost` matching the on-
                      chain registered public hosts.
                      `walrus.deploy.container` runs deploy-walrus.sh
                      via dockerOneShot, joining `dockerNetwork` so
                      `WALRUS_NETWORK` points at `sui-localnet:9000`
                      (alias) instead of `host.docker.internal`;
                      `WALRUS_LISTENING_IPS` enumerates the same
                      `10.<octet>.0.<10+i>` block storage nodes pin.
                      `walrus.deploy` parses the outputs file.
                      `walrus.register` projects deploy state into a
                      Package shape consumers (manifest / bindings)
                      pivot on. `image:` skips the build; `rpcUrls:`
                      skips docker entirely (deploy + register +
                      `dockerNetwork` included).
```

### Persistence + frontends (L7)

```
src/file-watcher.ts L7 — attachFileWatcher(engine, opts) — public API.
                    Subscribes to cycle:end and runs fs.watch on every
                    node's getWatchPaths(name); fires debounced cycles
                    on changes. Used by up.ts; also exported from the
                    main barrel for embedded use.
src/persistence/    L7 — atomic snapshot read/write under <appDir>/.devstack/...
src/cli/            L7 bin — devstack-next up | apply | status |
                              snapshot | reset | doctor | stack.
                              `stack list | new | use | down`. Active
                              pointer at <appDir>/.devstack/active so
                              unflagged commands respect the user's
                              last `stack use` (resolved via
                              `readActiveStack` in cli/env.ts).
src/tui/            L7 — Ink-based engine subscriber (TUI for `up`)
src/vitest/         L7 — setupForTest / readSnapshot / getNodeState
src/playwright/     L7 — createDevstackFixture (worker-scoped)
```

### Public API (`exports` in package.json)

- `.` — engine, `defineDevstackConfig`, factories
- `/helpers` — `publishMove`, `runTransaction`
- `/persistence` — snapshot path/read/write
- `/playwright` — `test`, `expect`, `createDevstackFixture`
- `/plugins` — `accounts`, `bindings`, `deepbook`, `manifest`, `seal`, `sui`, `walrus`
- `/shapes` — `Package`, `Endpoint`, `Account`
- `/vitest` — `setupForTest`, `readSnapshot`, `getNodeState`

Plus `bin: devstack-next`. The TUI and the CLI's programmatic exports
(runApply/runUp/runStatus/runSnapshot*/runReset/runDoctor) are
intentionally NOT in the public surface — implementation details of
the bin.

### Cross-cutting rule (formalized in this session)

**Plugins never call external runtimes (docker, processes, network
tools) directly from `start`.** Always delegate to a runner factory
(`dockerContainer`, `dockerImage`, `hostProcess`) so the resource is a
first-class graph node. That's what enables uniform snapshot /
shutdown / liveness handling across plugins. `sui.ts`, `walrus.ts`,
and `seal.ts` all follow this rule; their containers appear as
`*.container` siblings of the transformer producers in the graph.

The image build is now also a runner. Plugins that build their own
images (the upcoming sui-tools / walrus-service / seal-key-server
upgrades) chain `dockerImage` → `dockerContainer` so image-rebuild
fan-out is automatic: bumping a build arg flips the image's identity
→ container's input hash flips → container restarts on the new tag.

## What's deferred / not yet built

### Plugin features
- **walrus per-stack docker network**: 5a primitive landed (sui +
  walrus.deploy join the per-stack bridge with `sui-localnet` alias).
  Storage nodes still don't get fixed IPs — that's 5e. Real-running
  committee needs node containers on `10.<octet>.0.10..` via the new
  `network` / `networkAlias` / `ip` config on `dockerContainer`.
- **deepbookLocalnet end-to-end run**: composes the right primitives
  (gitFetch + publishMove + create_pool_admin tx) and tests the graph
  shape, but exercising it against a live sui-localnet (real publish,
  real pool creation, real Pool ids back) needs a docker-gated
  integration test. Deferred until a consumer wants pools wired.
- **walrus seedWal + walrus.proxy**: not ported. The walrus-deploy
  binary in the deploy container handles WAL exchange registration, so
  basic test setups don't need a separate seedWal step; nginx vhost
  proxy is committee-network-dependent and waits on the per-stack
  network design above.

### Frontend integration

There is **no JSON manifest writer** by design. The integration model
in the new world:

- **`manifest` plugin** emits `src/generated/manifest.ts` — typed
  values for the frontend to import at build time.
- **`bindings` plugin** emits `src/generated/sui/<pkg-name>/` — typed
  Move builders the frontend imports alongside the manifest.
- **snapshot.json** is the inter-process state of record. Tests +
  CLI + cross-process coordination read it directly (no separate
  manifest needed).

Old devstack wrote both a JSON manifest and a TS file; the JSON was
redundant once typed TS imports existed, and required a separate
sync mechanism. The new model is one source per consumer.

### Other deferred (not for next session)
- Full sui plugin features: indexer-db, GraphQL, docker-commit
  snapshots. Image build is done; the rest goes in a future
  `packages/devstack-sui/` package. (The `sui.image` step here
  intentionally omits indexer/graphql — leave them as TODO until a
  consumer drives the design.)
- Per-plugin package split (`packages/devstack-walrus/` etc.) — keep
  plugins in `devstack-next/src/plugins/` for now; split at cutover.
- Examples cutover.

## Conventions

- Tabs, single quotes, semicolons, trailing commas (Biome-ish).
- `import type` for type-only. `node:*` protocol for built-ins.
- Strict TypeScript — no `any` without a one-line comment justifying it.
- Comments only when WHY is non-obvious. Don't narrate code.
- Tests colocated as `*.test.ts(x)`. Vitest. No external network in tests.
  HTTP-dependent tests spin up a local `node:http` server (see
  `src/plugins/accounts.test.ts` faucet stub).
- Subpath exports pattern: each layer is a subpath. Add to
  `package.json` `exports` and `tsdown.config.ts` `entry`. Plugins all
  roll up under `/plugins`.
- Co-Authored-By trailer on commits:
  `Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

### TS inference

`ResolvedDeps<TDeps>` recursively unwraps `Dep<any, R>` through arrays
and nested objects (via `ResolveDep<T>`), mirroring the runtime walker
in `cycle.ts`. So `deps: { nodes: nodes.map(n => n.get('full')) }`
types as `{ nodes: WalrusNodeState[] }` at the call site — no cast
required. See `engine/types.ts`.

## Key files to read first when picking up

- `packages/devstack-next/PLAN.md` (especially L6 ~962–1127, L7 ~1128–1413)
- `packages/devstack-next/src/engine/class.ts` — Engine API
- `packages/devstack-next/src/runners/docker-container.ts` — runner pattern
- `packages/devstack-next/src/runners/docker-image.ts` — content-
  addressed image build runner; chains into dockerContainer via
  `image: Dep<string>` for image-aware containers
- `packages/devstack-next/src/plugins/sui.ts` — schema-style plugin
  composing `dockerContainer` (template for walrus / seal)
- `packages/devstack-next/src/plugins/accounts.ts` — disk-backed
  keystore plugin shape (define + define for Action)
- `packages/devstack-next/src/plugins/deepbook.ts` — simplest plugin
  shape (single static lookup)
- `packages/devstack-next/src/plugins/manifest.ts` +
  `packages/devstack-next/src/plugins/bindings.ts` — frontend
  integration pair: manifest emits values, bindings emits typed Move
  builders. Atomic dir swap pattern in bindings is load-bearing for
  Vite HMR.
- `packages/devstack-next/src/cli/apply.ts` — pattern for CLI
  commands (programmatic `run*` + argv-driven `main`)
