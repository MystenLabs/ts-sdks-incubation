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
```

Tests: 314 passing. Typecheck clean. Build clean (143 files, ~549 kB).

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

src/standard/       L4 — standard graph nodes
  ports.ts            singleton port allocator
  account-pool.ts     accountPool factory (generic, BYO-signer-type — kept
                      as a primitive; the disk-backed concrete plugin lives
                      under src/plugins/accounts.ts)

src/shapes/         WorldView typed shapes — Package, Endpoint, Account
```

### Helpers + plugins (L5, L6)

```
src/helpers/        L5 — sugar (publishMove, runTransaction, gitFetch,
                    cliSigner, viteDevServer)
                    publishMove.path accepts Dep<string> so users chain
                    gitFetch → publishMove for upstream Move vendoring.

src/plugins/        L6
  accounts.ts         disk-backed Ed25519 keystore + fund Action
                      (depends on sui.get('faucet'))
  bindings.ts         Move source → typed TS bindings via
                      `sui move summary` + `@mysten/codegen`. Atomic
                      dir swap so Vite never sees partial trees.
  deepbook.ts         pre-deployed package-id lookup (testnet / mainnet)
  manifest.ts         typed-manifest TS emit (renamed from codegen.ts).
                      Sibling to bindings — runtime values vs. type bindings.
  seal.ts             single-container key-server (delegates to
                      dockerContainer; url-override escape hatch)
  sui.ts              localnet — chains dockerImage (vendored Dockerfile
                      under sui/docker/) → dockerContainer; image build
                      is content-addressed via SUI_VERSION build-arg.
                      `image:` override skips the build for pre-built
                      tags. testnet/mainnet/devnet stubs unchanged.
  walrus.ts           multi-node + aggregator (each node delegates to
                      dockerContainer; rpcUrls escape hatch)
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
                              snapshot | reset | doctor | stack
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
- **accounts.fund**: only faucets, doesn't push to the address-balance
  accumulator yet (the original devstack does both). AB deposit is
  cheaper to add when there's a real consumer asking for it.
- **walrus / seal real images**: the defaults
  (`mystenlabs/walrus-service:latest`, `mystenlabs/seal-key-server:latest`)
  are placeholders and not pinned to known-good tags. Sui ported its
  build via `dockerImage` (vendored Dockerfile under `sui/docker/`);
  walrus + seal still pending, slated for Chunks 2–3.
- **deepbook localnet publish**: `deepbook()` only knows about
  testnet/mainnet ids. Publishing the source against a localnet sui is
  deferred to a future devstack-deepbook plugin.

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
- envSigner helper (parallel to cliSigner — read keypair from env var).
- accounts.fund AB-deposit step — needs a running localnet to test.
- `stack new` / `stack use` (multi-stack convenience; --stack flag
  works today, no implicit "active stack" yet).

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
