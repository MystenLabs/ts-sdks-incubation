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
```

Tests: 262 passing. Typecheck clean. Build clean (121 files, ~411 kB).

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

src/runners/        L4 — process/container runners
  host-process.ts     hostProcess({...})
  docker-container.ts dockerContainer({...}) — exposes provides.state + provides.hostPort

src/standard/       L4 — standard graph nodes
  ports.ts            singleton port allocator
  account-pool.ts     accountPool factory (generic, BYO-signer-type — kept
                      as a primitive; the disk-backed concrete plugin lives
                      under src/plugins/accounts.ts)

src/shapes/         WorldView typed shapes — Package, Endpoint, Account
```

### Helpers + plugins (L5, L6)

```
src/helpers/        L5 — sugar (publishMove, runTransaction)

src/plugins/        L6
  accounts.ts         disk-backed Ed25519 keystore + fund Action
                      (depends on sui.get('faucet'))
  codegen.ts          typed-manifest emit (no Move bindings yet)
  deepbook.ts         pre-deployed package-id lookup (testnet / mainnet)
  seal.ts             single-container key-server (delegates to
                      dockerContainer; url-override escape hatch)
  sui.ts              localnet (delegates to dockerContainer) + testnet/mainnet/devnet stubs
  walrus.ts           multi-node + aggregator (each node delegates to
                      dockerContainer; rpcUrls escape hatch)
```

### Persistence + frontends (L7)

```
src/persistence/    L7 — atomic snapshot read/write under <appDir>/.devstack/...
src/cli/            L7 bin — devstack-next up | apply | status |
                              snapshot | reset | doctor
src/tui/            L7 — Ink-based engine subscriber (TUI for `up`)
src/vitest/         L7 — setupForTest / readSnapshot / getNodeState
src/playwright/     L7 — createDevstackFixture (worker-scoped)
```

### Public API (`exports` in package.json)

- `.` — engine, `defineDevstackConfig`, factories
- `/helpers` — `publishMove`, `runTransaction`
- `/persistence` — snapshot path/read/write
- `/playwright` — `test`, `expect`, `createDevstackFixture`
- `/plugins` — `accounts`, `codegen`, `deepbook`, `seal`, `sui`, `walrus`
- `/shapes` — `Package`, `Endpoint`, `Account`
- `/vitest` — `setupForTest`, `readSnapshot`, `getNodeState`

Plus `bin: devstack-next`. The TUI and the CLI's programmatic exports
(runApply/runUp/runStatus/runSnapshot*/runReset/runDoctor) are
intentionally NOT in the public surface — implementation details of
the bin.

### Cross-cutting rule (formalized in this session)

**Plugins never call external runtimes (docker, processes, network
tools) directly from `start`.** Always delegate to a runner factory
(`dockerContainer`, `hostProcess`) so the resource is a first-class
graph node. That's what enables uniform snapshot / shutdown / liveness
handling across plugins. `sui.ts`, `walrus.ts`, and `seal.ts` all
follow this rule; their containers appear as `*.container` siblings
of the transformer producers in the graph.

## What's deferred / not yet built

### Plugin features
- **accounts.fund**: only faucets, doesn't push to the address-balance
  accumulator yet (the original devstack does both). AB deposit is
  cheaper to add when there's a real consumer asking for it.
- **walrus / seal real images**: the defaults
  (`mystenlabs/walrus-service:latest`, `mystenlabs/seal-key-server:latest`)
  are placeholders and not pinned to known-good tags. Per-plugin image
  build (the `*.build` actions in the original devstack) lives in a
  future devstack-walrus / devstack-seal package.
- **deepbook localnet publish**: `deepbook()` only knows about
  testnet/mainnet ids. Publishing the source against a localnet sui is
  deferred to a future devstack-deepbook plugin.

### Move bindings codegen
- `sui move summary` + `@mysten/codegen` integration. Needs a real Move
  package to test against; STATE-frozen until an example app is
  ported.

### Other deferred (not for next session)
- Full sui plugin features: image build, indexer-db, GraphQL,
  docker-commit snapshots. Per the plan these go in a future
  `packages/devstack-sui/` package.
- Per-plugin package split (`packages/devstack-walrus/` etc.) — keep
  plugins in `devstack-next/src/plugins/` for now; split at cutover.
- Examples cutover.
- File-watching for `up`. The engine has the `invalidate(name)` +
  `cycle()` API; `up` just doesn't drive it from FS events yet.

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

### TS-inference quirks worth knowing

- `define()`'s third generic is `TDeps`. When `deps:` includes an
  array of `Dep`s (e.g. walrus's aggregator over `nodes.map(n =>
  n.get('full'))`), `ResolvedDeps<TDeps>` doesn't auto-unwrap the
  array — the engine resolves it recursively at runtime, but the TS
  surface needs a cast. Pattern: declare a local `type Deps = {...}`
  and do `(deps as Deps).whatever`. See `src/plugins/walrus.ts`.

## Key files to read first when picking up

- `packages/devstack-next/PLAN.md` (especially L6 ~962–1127, L7 ~1128–1413)
- `packages/devstack-next/src/engine/class.ts` — Engine API
- `packages/devstack-next/src/runners/docker-container.ts` — runner pattern
- `packages/devstack-next/src/plugins/sui.ts` — schema-style plugin
  composing `dockerContainer` (template for walrus / seal)
- `packages/devstack-next/src/plugins/accounts.ts` — disk-backed
  keystore plugin shape (define + define for Action)
- `packages/devstack-next/src/plugins/deepbook.ts` — simplest plugin
  shape (single static lookup)
- `packages/devstack-next/src/cli/apply.ts` — pattern for CLI
  commands (programmatic `run*` + argv-driven `main`)
