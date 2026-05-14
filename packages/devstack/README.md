# @mysten-incubation/devstack

Producer-graph engine + plugins for fully-seeded local Sui development.
Boots `sui-localnet` (with embedded indexer + GraphQL), `seal`
key-servers, `walrus` storage committees, DeepBook v3 pools, and your
app's Move packages from a single `devstack.config.ts`, then keeps
everything reconciled across edits + snapshot save/restore.

## Install

```bash
pnpm add -D @mysten-incubation/devstack
```

Node 24+ is required (Node's native TypeScript-strip support is what
loads `devstack.config.ts` without a transformer).

## Minimum config

```ts
// devstack.config.ts
import { defineDevstackConfig } from '@mysten-incubation/devstack';
import { accounts, manifest, sui } from '@mysten-incubation/devstack/plugins';
import { publishMove, publishViaSuiCli } from '@mysten-incubation/devstack/helpers';

const a = accounts({ specs: { alice: {}, bob: {} } });

const helloPublish = publishMove({
  name: 'hello',
  path: './move/hello',
  // `exclusive` projects the signer the same as `signer` but tells the
  // engine to refuse to parallel-batch consumers that share this
  // signer name — gas-coin contention disappears by construction.
  signer: a.pool.get('exclusive', { name: 'alice' }),
  publish: publishViaSuiCli,
});

export default defineDevstackConfig({
  stack: [
    sui.create({ network: 'localnet' }),
    a.pool,
    a.fund,
    helloPublish,
    manifest({
      packages: [helloPublish.get('package')],
      endpoints: [sui.get('endpoint'), sui.get('faucetEndpoint')],
      accounts: [
        a.pool.get('account', { name: 'alice' }),
        a.pool.get('account', { name: 'bob' }),
      ],
    }),
  ],
});
```

Then:

```bash
$ devstack up          # long-running supervisor + TUI
# or
$ devstack apply       # one-shot reconcile, settles cascades, exits
```

## CLI

| Verb | What it does |
|---|---|
| `devstack up` | Long-running supervisor. Watches file paths registered via `runArgs.watch(...)`, auto-saves a snapshot at each `cycle:end`. |
| `devstack apply` | Single-shot reconcile. Drains cascades via `Engine.settle()`, writes a snapshot, exits. |
| `devstack status` | Read-only print of the on-disk snapshot. |
| `devstack snapshot save \| restore \| list \| delete` | Capture / restore labeled snapshots. |
| `devstack wipe --yes [--images]` | Stop snapshot-managed runners + remove per-stack state. `--images` runs `docker image prune -f`. Confirmation required. |
| `devstack stack list \| new \| use \| down \| drop` | Manage per-app stacks. `stack drop <name> --yes` = `wipe --stack <name> --yes`. |
| `devstack doctor` | Preflight checks (docker daemon, sui CLI, snapshot port conflicts). |

All mutating verbs go through `withStackLock` — two `devstack apply`
invocations against the same stack don't fight; the second sees a
clean `StackLockBusyError`.

## Test integration

### Vitest

```ts
// devstack-setup.ts (vitest globalSetup target)
import { setup, teardown } from '@mysten-incubation/devstack/vitest';
export default async function () {
  const handle = await setup();           // auto-detects appDir + stack
  return () => teardown(handle);
}

// some.test.ts
import { test as baseTest } from 'vitest';
import { readManifest } from '@mysten-incubation/devstack/vitest';

baseTest('publisher mints to alice', async () => {
  const m = await readManifest();         // typed Manifest<TExtras>
  const alice = m!.accounts.find((a) => a.name === 'alice')!;
  // ... drive the chain via m.endpoints.find(e => e.name === 'sui-rpc')
});
```

Wire `globalSetup: ['./devstack-setup.ts']` in `vitest.config.ts`.

### Playwright

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import { webServer } from '@mysten-incubation/devstack/playwright';
export default defineConfig({
  webServer: webServer({ endpoint: 'dev-server' }),
});

// e2e/some.spec.ts
import { test, expect } from '@mysten-incubation/devstack/playwright';
test('user can mint', async ({ page, manifest, rpcUrl, signerPool }) => {
  await page.goto(manifest.endpoints.find((e) => e.name === 'dev-server')!.url);
  await signerPool.withLease(async ({ signer }) => {
    // ... sign a tx; pool serializes shared signers across workers
  });
});
```

Default fixtures: `manifest`, `rpcUrl`, `stack`, `signerPool` —
worker-scoped, so each worker brings up its own `e2e-${workerIndex}`
stack. `webServer({ endpoint })` fails loudly if the named endpoint
isn't in the manifest (no `localhost:5173` fallback).

## Plugins

- **`sui`** — sui-localnet with embedded indexer + GraphQL. Live nets
  (`testnet`, `mainnet`, `devnet`) supported as no-Docker stubs.
- **`accounts`** — disk-backed Ed25519 keystore + faucet. Exposes
  `signer` (shared) and `exclusive` (serializes consumers sharing a
  signer name) projections.
- **`walrus`** — multi-node storage committee, deploy + register +
  exchange. `walrusSeedWal` per-account SUI→WAL swap.
- **`seal`** — full publish + register + key-server flow via
  `sealLocalnet`.
- **`deepbook`** — DeepBook v3 publish + pool create. `deepbookLocalnet`
  helper, `deepbookMarketMaker` for continuous grid liquidity.
- **`registerCoin`** — register a published coin into the manifest's
  `coins` slot. Dev-wallet's faucet panel discovers these.
- **`manifest`** — emit a typed `Manifest<TExtras>` TS file +
  JSON sidecar. The frontend contract.
- **`bindings`** — Move source → typed TS bindings via
  `@mysten/codegen`.
- **`walletApp`** — embedded dev-wallet server (signer endpoint,
  persisted-token bearer auth).

## Authoring plugins

Two factories:

- **`define`** — for plugins that take no required config. Returns a
  `Producer<TState, TProvides>`.
- **`defineSchema`** — for plugins that take config (sui, walrus,
  seal). Returns a `Schema` with `create(config)` and a static
  `get(key, args?)` accessor.

Recipes via **`dep`** / **`exclusiveDep`**. Public `Dep<TConsumerView>`
has one type parameter — plugin authors never need `<any>` or explicit
generics.

```ts
import { define, dep, exclusiveDep, type Provides } from '@mysten-incubation/devstack';

interface State { signers: Record<string, Signer> }

const provides = {
  signer: dep((s: State, d: { name: string }) => s.signers[d.name]),
  // Tells the engine: refuse to parallel-batch consumers whose
  // `pool.get('exclusive', { name: X })` resolves to the same X.
  exclusive: exclusiveDep({
    get: (s: State, d: { name: string }) => s.signers[d.name],
    lockKey: (_s, d) => `signer:${d.name}`,
  }),
} satisfies Provides<State>;

const pool = define<State, typeof provides>({
  name: 'pool',
  provides,
  start: async () => ({ signers: {} }),
});
```

Runners (`dockerContainer`, `dockerOneShot`, `dockerImage`,
`dockerNetwork`, `hostProcess`) are first-class graph nodes — use them
to wrap external resources without leaving the producer model.

## Subpaths

| Subpath | What |
|---|---|
| `@mysten-incubation/devstack` | `Engine`, `define`, `defineSchema`, `dep`, `exclusiveDep`, `defineDevstackConfig`, runners. |
| `/plugins` | sui, accounts, walrus, seal, deepbook, manifest, bindings, walletApp, registerCoin. |
| `/helpers` | `publishMove`, `publishViaSuiCli`, `runTransaction`, `gitFetch`, `viteDevServer`, signer helpers. |
| `/shapes` | `Manifest<TExtras>`, `Package`, `Endpoint`, `Account`, `Coin`. |
| `/vitest` | `setup`, `teardown`, `readManifest<TExtras>`, `readSnapshot`, `getNodeState`. |
| `/playwright` | Pre-extended `test` + `expect`, `webServer`, `setup`/`teardown`, `connectAs`/`selectAccount`/`waitForBalanceUpdate`. |
| `/leasing` | `SignerPool.fromManifest`, `Lease`, `withLease`. |
| `/persistence` | `withStackLock`, `StackLockBusyError`, paths + snapshot read/write. |
| `/dapp-kit` | `createDevstackDappKit`, `localnetDappKitConfig`, `localnetMvrOverrides`, `localnetWalrusOptions`. |

## Status

`0.1.0`. Initial public release. Public API is semver-bound across the
0.x series — breaking changes land at minor-version bumps.

## License

Apache-2.0.
