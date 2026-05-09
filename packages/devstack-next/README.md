# @mysten-incubation/devstack-next

Producer-graph engine + plugins for fully-seeded local Sui
development. Boots sui-localnet (with embedded indexer + GraphQL),
seal key-servers, walrus storage committees, deepbook pools, and
your app's Move packages from a single `devstack-next.config.ts`,
then keeps everything reconciled across edits and snapshot saves.

This is the parallel rebuild of `@mysten-incubation/devstack` —
same goals, redesigned plumbing. See
[MIGRATION.md](./MIGRATION.md) for the API mapping.

## Quick start

```typescript
import { defineDevstackConfig } from '@mysten-incubation/devstack-next';
import { accounts, manifest, sui } from '@mysten-incubation/devstack-next/plugins';
import { publishMove, publishViaSuiCli } from '@mysten-incubation/devstack-next/helpers';

const a = accounts({ specs: { alice: {}, bob: {} } });

const helloPublish = publishMove({
    name: 'hello',
    path: './move/hello',
    signer: a.pool.get('signer', { name: 'alice' }),
    publish: publishViaSuiCli,
});

export default defineDevstackConfig({
    stack: [
        sui.create({ network: 'localnet' }),
        a.pool,
        a.fund,
        helloPublish,
        manifest({ packages: [helloPublish.get('package')] }),
    ],
});
```

```bash
$ devstack-next up
```

## What's in the box

- **Engine.** Pure-data reconciler over a producer graph. Inputs
  flow as typed Deps; cycles are detected at graph build; the engine
  has zero I/O.
- **Runners.** `dockerContainer`, `dockerOneShot`, `dockerImage`,
  `dockerNetwork`, `hostProcess` — first-class graph nodes for the
  external resources plugins compose.
- **Plugins (`./plugins/`).** `sui` (with indexer + GraphQL),
  `seal` (full publish + register + key-server flow via
  `sealLocalnet`), `walrus` (multi-node committee + deploy +
  exchange + seedWal + nginx proxy), `deepbook`, `accounts`,
  `manifest`, `bindings`.
- **Snapshots.** `dockerContainer.snapshot:` commits the writable
  layer via `docker commit` on save; restore boots from the
  committed tag, recovering chain state across `docker rm`.
- **Per-stack docker network.** Each (app, stack) pair gets a
  deterministic `/24`; in-network DNS aliases (`sui-localnet`,
  `walrus-node-<i>.localhost`) replace `host.docker.internal`
  hops.
- **Frontends.** CLI (`devstack-next` bin), TUI for `up`,
  vitest harness (`./vitest`), Playwright fixture
  (`./playwright`).

## Verified end-to-end

```bash
# Fast unit / structural tests (~20s).
pnpm test

# Real docker bring-up — sui + seal + walrus + snapshot
# round-trip. ~90s once images are cached; multi-minute cargo
# compile of walrus on first run.
RUN_SLOW_INTEGRATION=1 pnpm test:integration
```

## Status

`1.0.0-rc.0`. Public API stable for the 1.0 series.

## Layout

- `src/engine/` — pure-logic engine (build, cycle, snapshot, types).
- `src/runners/` — `dockerContainer` / `dockerOneShot` /
  `dockerImage` / `dockerNetwork` / `hostProcess`.
- `src/factories/` — `define`, `defineSchema`, `dep`.
- `src/standard/` — `ports` allocator, `accountPool`.
- `src/plugins/` — sui, seal, walrus, deepbook, accounts,
  manifest, bindings.
- `src/helpers/` — `publishMove`, `runTransaction`, `gitFetch`,
  `viteDevServer`, signer helpers.
- `src/cli/` — `devstack-next` binary (`up`, `apply`, `snapshot`,
  `reset`, `stack`, `doctor`, `status`).
- `src/tui/` — Ink renderer for `up`.
- `src/vitest/` — test harness (`setupForTest`, `readSnapshot`,
  `getNodeState`).
- `src/playwright/` — `createDevstackFixture` (worker-scoped).
- `src/integration/` — docker-gated end-to-end suite.
- `notes/STATE.md` — what's built, what's deferred.
- `notes/PLAN-NEXT.md` — what's left, sequenced.
- `PLAN.md` — original architecture writeup.

## License

Apache-2.0.
