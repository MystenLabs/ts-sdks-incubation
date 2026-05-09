# devstack-next — current state

Living "where are we now" doc. Updated at session boundaries; PLAN.md
stays focused on architecture.

## HEAD

Branch: `integrate-devstack`. Most recent commits (oldest → newest):

```
e0d3b83  L4 factories + ports allocator
50692cf  L4 accountPool + hostProcess + dockerContainer runners
c573c57  initial scaffold — L1 graph engine + design plan
071e6d3  L3 config + L5 helpers + L6 codegen/sui + L7 persistence + shapes
9277338  route sui-localnet through dockerContainer runner
1970fe8  L7 CLI scaffold — up + apply + status
5c8656d  L7 TUI — Ink-based engine subscriber
76fe11d  L7 vitest harness
ac27a7a  L7 playwright fixture
```

Tests: 202 passing. Typecheck clean. Build clean (103 files, ~295 kB).

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
  account-pool.ts     createAccountPool factory (in-memory pool — not a real keystore yet)

src/shapes/         WorldView typed shapes — Package, Endpoint, Account
```

### Helpers + plugins (L5, L6)

```
src/helpers/        L5 — sugar (publishMove, runTransaction)

src/plugins/        L6
  sui.ts              localnet (delegates to dockerContainer) + testnet/mainnet/devnet stubs
  codegen.ts          typed-manifest emit (no Move bindings yet)
```

### Persistence + frontends (L7)

```
src/persistence/    L7 — atomic snapshot read/write under <appDir>/.devstack/...
src/cli/            L7 bin — devstack-next up | apply | status
src/tui/            L7 — Ink-based engine subscriber (TUI for `up`)
src/vitest/         L7 — setupForTest / readSnapshot / getNodeState
src/playwright/     L7 — createDevstackFixture (worker-scoped)
```

### Public API (`exports` in package.json)

- `.` — engine, `defineDevstackConfig`, factories
- `/helpers` — `publishMove`, `runTransaction`
- `/persistence` — snapshot path/read/write
- `/playwright` — `test`, `expect`, `createDevstackFixture`
- `/plugins` — `sui`, `codegen`
- `/shapes` — `Package`, `Endpoint`, `Account`
- `/vitest` — `setupForTest`, `readSnapshot`, `getNodeState`

Plus `bin: devstack-next`. The TUI and the CLI's programmatic exports
(runApply/runUp/runStatus) are intentionally NOT in the public surface
— implementation details of the bin.

### Cross-cutting rule (from this session)

**Plugins never call external runtimes (docker, processes, network
tools) directly from `start`.** Always delegate to a runner factory
(`dockerContainer`, `hostProcess`) so the resource is a first-class
graph node. That's what enables uniform snapshot / shutdown / liveness
handling across plugins. The `9277338` commit refactored sui-localnet
to follow this rule; it's the template for walrus / seal.

## What's deferred / not yet built

### CLI commands
- `snapshot save|restore|list|delete` — labeled snapshots under
  `<appDir>/.devstack/stacks/<stack>/snapshots/`. Save uses the
  existing `labeledSnapshotPath` helper. Restore re-hydrates the
  snapshot at the canonical location. List walks
  `labeledSnapshotsDir`. Delete removes one.
- `reset` — stops engine, removes per-stack `.devstack/` contents.
- `doctor` — preflight checks: docker daemon, sui CLI, port
  conflicts. No engine construction.

### Plugins (the rest)
- **accounts** — real keystore signers materialized to disk under
  `<appDir>/.devstack/stacks/<stack>/.keys/<name>.key`. Today's
  `account-pool` standard node is in-memory only. Lift it to a plugin
  with proper signer serialization + a `fund` Action that depends on
  `sui.get('faucet')`.
- **walrus** — dynamic node fan-out (`walrus.node-${i}`) + aggregator
  node. Each node uses `dockerContainer` per the cross-cutting rule.
  PLAN.md L6 has the design sketch (lines ~1037–1103).
- **seal** — similar shape to walrus; `dockerContainer`-backed.
- **deepbook** — bundle via plain function: loads pre-deployed package
  IDs into a Producer that surfaces `Package` shapes. No container.

### Other deferred (not for next session)
- Move bindings codegen (`sui move summary` + `@mysten/codegen`) —
  needs a real Move package to test against.
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
- Subpath exports pattern: each layer is a subpath. Add to
  `package.json` `exports` and `tsdown.config.ts` `entry`.
- Co-Authored-By trailer on commits:
  `Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

## Key files to read first when picking up

- `packages/devstack-next/PLAN.md` (especially L6 ~962–1127, L7 ~1128–1413)
- `packages/devstack-next/src/engine/class.ts` — Engine API
- `packages/devstack-next/src/runners/docker-container.ts` — runner pattern
- `packages/devstack-next/src/plugins/sui.ts` — example of a plugin
  composed via `dockerContainer` (the template for walrus/seal)
- `packages/devstack-next/src/standard/account-pool.ts` — current
  in-memory pool (lift to a real plugin)
- `packages/devstack-next/src/cli/apply.ts` — pattern for new CLI
  commands (programmatic `run*` + argv-driven `main`)
- `packages/devstack/src/cli/snapshot.ts` — original snapshot CLI for
  reference (do NOT copy wholesale; tied to the old runtime)
