# Migrating from `@mysten-incubation/devstack` to `@mysten-incubation/devstack-next`

devstack-next is a parallel rebuild — same goals (fully-seeded local
Sui dev), redesigned plumbing. The biggest shift: the action graph
becomes a **producer graph**, and the registry becomes typed
**Provides Deps**.

This guide walks an existing `examples/<app>/devstack.config.ts`
through to its devstack-next equivalent.

---

## TL;DR API mapping

| Old (`@mysten-incubation/devstack`)                    | New (`@mysten-incubation/devstack-next`)                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `defineDevstackConfig({ app, accounts, use })`         | `defineDevstackConfig({ stack: [...] })`                                                                |
| `sui({ rpcPort, faucetPort, version })`                | `sui.create({ network: 'localnet', version? })`                                                         |
| `accounts()` + top-level `accounts: ['alice', 'bob']`  | `accounts({ specs: { alice: {}, bob: {} } })` → returns `{ pool, fund }`                                |
| `codegen()`                                            | `manifest({ packages: [...], endpoints: [...] })`                                                       |
| `walletApp({ port })`                                  | `walletApp.create({ accounts: [...], devServerOrigin? })`                                               |
| `frontend({ port })`                                   | `viteDevServer({ gates: [...] })` (helper, not a schema)                                                |
| `publishMove({ name, path, publisher? })`              | `publishMove({ name, path, signer, publish: publishViaSuiCli })`                                        |
| `seed({ name, needs, signer, run })`                   | `runTransaction({ name, signer, deps?, build })` (or raw `define()` for non-tx side effects)            |
| `runTransaction({ name, needs, signer, build })`       | `runTransaction({ name, signer, deps?, build })` (`needs` becomes `deps`)                               |
| `registerCoin({ from, package, … })`                   | `registerCoin({ name, package, module, type, decimals })` — feed `.get('coin')` to `manifest({ coins })` |
| `walrus({})`                                           | `walrus({ nodeCount? })` → returns `{ nodes, appNetwork, deploy, register, exchange }`                  |
| `seal({})`                                             | `sealLocalnet({ signer })` → returns full bundle (see seal section below)                               |
| `deepbook({ pools, marketMakers })`                    | `deepbookLocalnet({ signer, pools })` + `deepbookMarketMaker({...})` (separate producer per maker)      |
| `ctx.registry.packages.require('foo')`                 | Direct Dep on the publish producer: `deps: { foo: helloPublish.get('package') }`                       |
| `ctx.accounts.get('alice')`                            | `accountsBundle.pool.get('signer', { name: 'alice' })`                                                  |

---

## 1. Top-level config

**Old:**

```typescript
import { accounts, codegen, defineDevstackConfig, frontend, publishMove, sui, walletApp } from '@mysten-incubation/devstack';

export default defineDevstackConfig({
    app: '_template',
    accounts: ['alice', 'bob'],
    use: [
        sui({ rpcPort: 9100, faucetPort: 9101 }),
        accounts(),
        codegen(),
        walletApp({ port: 9102 }),
        frontend({ port: 5180 }),
        publishMove({ name: 'hello', path: HELLO_DIR, publisher: 'alice' }),
    ],
});
```

**New:**

```typescript
import { defineDevstackConfig } from '@mysten-incubation/devstack-next';
import { accounts, manifest, sui } from '@mysten-incubation/devstack-next/plugins';
import { publishMove, publishViaSuiCli, viteDevServer } from '@mysten-incubation/devstack-next/helpers';

const accountsBundle = accounts({
    specs: { alice: {}, bob: {} },
});

const helloPublish = publishMove({
    name: 'hello',
    path: HELLO_DIR,
    signer: accountsBundle.pool.get('signer', { name: 'alice' }),
    publish: publishViaSuiCli,
});

const m = manifest({
    packages: [helloPublish.get('package')],
});

const dev = viteDevServer({
    gates: [m.get('full')],
});

export default defineDevstackConfig({
    stack: [
        sui.create({ network: 'localnet' }),
        accountsBundle.pool,
        accountsBundle.fund,
        helloPublish,
        m,
        dev,
    ],
});
```

Key shape change: **the action graph is just an array of producers**.
There's no `app:` / `accounts:` / `use:` split — all producers
(plugins, helpers, raw `define()` calls) live in a single
`stack: [...]` array. Plugins that returned multiple actions in the
old API (e.g. `accounts()` produced a pool action + a fund action)
now return objects whose individual producers you spread into the
stack:

```typescript
const a = accounts({ specs: { alice: {} } });
defineDevstackConfig({
    stack: [
        a.pool,           // long-running keystore
        a.fund,           // one-shot faucet step
    ],
});
```

The engine deduplicates by producer `__id` and pulls in transitive
upstreams via `Dep` back-references, so the array only needs to list
leaf consumers if you prefer that style.

---

## 2. Registry → typed Provides Deps

The biggest mental shift. Old devstack used a string-keyed registry
the action's `run` callback poked at:

```typescript
// OLD
seed({
    name: 'mint-greeting',
    needs: ['hello'],
    signer: 'alice',
    run: async (ctx) => {
        const pkg = ctx.registry.packages.require('hello');
        const tx = new Transaction();
        tx.moveCall({
            target: `${pkg.packageId}::hello::mint`,
            arguments: [tx.pure.string('hi')],
        });
        // ...
    },
});
```

New devstack uses typed Deps the producer declares up-front. The
publish step's `package` Dep flows directly:

```typescript
// NEW
runTransaction({
    name: 'mint-greeting',
    signer: accountsBundle.pool.get('signer', { name: 'alice' }),
    deps: { hello: helloPublish.get('package') },
    build: async ({ signer, rpcUrl, deps }) => {
        const tx = new Transaction();
        tx.moveCall({
            target: `${deps.hello.packageId}::hello::mint`,
            arguments: [tx.pure.string('hi')],
        });
        const client = new SuiJsonRpcClient({ url: rpcUrl, network: 'localnet' });
        return await client.signAndExecuteTransaction({ signer, transaction: tx });
    },
});
```

Effects:

- **Type safety.** `deps.hello` is `Package`; the typo `deps.helo`
  fails at compile time.
- **Explicit edges.** Every chain dependency is a Dep — the engine
  builds the graph from these and surfaces missing edges as build
  errors, not as runtime "package 'foo' not registered" exceptions.
- **No string lookups.** `ctx.registry.packages.require` is gone;
  the package id arrives as a typed value.

---

## 3. Plugin-by-plugin

### `sui`

| Old                                       | New                                                |
| ----------------------------------------- | -------------------------------------------------- |
| `sui({ version, rpcPort, faucetPort })`   | `sui.create({ network: 'localnet', version? })`    |
| `ctx.registry.services.require('sui-rpc')` | `sui.get('rpc')` (Dep returning `{ url }`)        |
| `ctx.registry.services.require('sui-faucet')` | `sui.get('faucet')` (throws on mainnet)        |
| (none — old localnet had no GraphQL)      | `sui.get('graphql')` (Dep returning `{ url }`)     |

Port hints (`rpcPort`, `faucetPort`) are gone — the new stack uses a
shared `ports` allocator that binds whatever ephemeral port is free.
Consumers use the `ports.allocate` Dep and get the same allocated
port everywhere they reference the slot.

### `accounts`

| Old                                       | New                                                |
| ----------------------------------------- | -------------------------------------------------- |
| `accounts: ['alice', 'bob']` + `accounts()` plugin | `accounts({ specs: { alice: {}, bob: {} } })` |
| `ctx.accounts.get('alice')` → `Keypair`   | `accountsBundle.pool.get('signer', { name: 'alice' })` (Dep returning `Keypair`) |
| Faucet auto-runs on every cycle           | Explicit `accountsBundle.fund` producer in the stack |

### `codegen` → `manifest`

Renamed for clarity — the plugin emits a typed values manifest
(`src/generated/manifest.ts`), not codegen in the bindings sense.
Bindings (typed Move builders from `sui move summary`) live in the
sibling `bindings` plugin.

```typescript
// OLD
codegen()  // implicit, finds packages in registry

// NEW — explicit packages list
manifest({
    packages: [helloPublish.get('package'), tokenPublish.get('package')],
    endpoints: [sui.get('endpoint-as-shape')],
})
```

### `publishMove`

Now requires an explicit `signer` Dep + a `publish:` callback. The
`publishViaSuiCli` helper covers the common case (host `sui move
build` + tx.publish).

```typescript
publishMove({
    name: 'hello',
    path: HELLO_DIR,
    signer: accountsBundle.pool.get('signer', { name: 'alice' }),
    publish: publishViaSuiCli,
})
```

`publisher: 'alice'` (old, looked up by name in registry) becomes
the explicit signer Dep above.

### `runTransaction`

Same shape, plus optional `deps?: TExtra` for shared chain context:

```typescript
runTransaction({
    name: 'mint-initial',
    signer: pool.get('signer', { name: 'minter' }),
    deps: { token: tokenDeploy.get('full') },
    build: async ({ signer, rpcUrl, deps }) => {
        // deps.token.packageId — typed
    },
});
```

`needs: ['hello']` (old) becomes a typed `deps: { hello: ... }`.

### `seed`

There's no dedicated `seed` factory — use `runTransaction` for tx-
flavored seed actions, or raw `define()` for arbitrary side effects:

```typescript
define({
    name: 'mint-distribution',
    runsAs: 'publisher',
    deps: {
        signer: pool.get('signer', { name: 'publisher' }),
        rpc: sui.get('rpc'),
        token: tokenPublish.get('package'),
    },
    run: async ({ deps }) => {
        // arbitrary chain side effect
    },
});
```

### `seal`

The biggest restructure. Managed-mode key-server can't usefully run
without a published seal Move package + on-chain `KeyServer` object,
so the schema's `seal.create({})` no longer auto-creates the
container chain — it requires `sealLocalnet({ signer })` which owns
the full lifecycle:

```typescript
const sl = sealLocalnet({
    signer: pool.get('signer', { name: 'publisher' }),
});

defineDevstackConfig({
    stack: [
        sui.create({ network: 'localnet' }),
        a.pool, a.fund,
        sl.image, sl.keygenContainer, sl.keygen,
        sl.source, sl.publish, sl.register, sl.container,
        sl.instance,  // the seal schema instance — `seal.get(...)` resolves to this
    ],
});
```

`seal.create({ url })` for an externally-managed key server is
unchanged.

### `walletApp`

`walletApp.create({ accounts, devServerOrigin? })` — in-process HTTP
signer endpoint backing the dev-wallet `DevstackSignerAdapter`. Same
HTTP surface as the old plugin (`/api/v1/devstack/{accounts,sign-transaction,sign-personal-message}`,
bearer-token auth, persisted token under `<stackDir>/wallet-token`),
redesigned around typed Deps:

```typescript
const a = accounts({ specs: { alice: {}, bob: {} } });

const wallet = walletApp.create({
    accounts: [
        { name: 'alice', signer: a.pool.get('signer', { name: 'alice' }) },
        { name: 'bob', signer: a.pool.get('signer', { name: 'bob' }) },
    ],
    // Optional. Pass the dev server's origin Dep so the wallet-app's
    // CORS allowlist + input hash track it — a vite restart with a new
    // port triggers a clean wallet-app restart that preserves the
    // bearer token.
    devServerOrigin: dev.get('origin'),
});

const m = manifest({
    endpoints: [wallet.get('endpoint'), sui.get('endpoint-as-shape')],
});

defineDevstackConfig({
    stack: [
        sui.create({ network: 'localnet' }),
        a.pool, a.fund,
        wallet,
        m,
    ],
});
```

Differences from the old plugin:

- **No two-action split.** The register/serve split in the old plugin
  was there to populate the manifest at apply-time before the listener
  came up. devstack-next emits the manifest by reading the running
  producer's state, so a single producer covers both jobs — no
  apply-time placeholder.
- **No `setAccounts` / `setAllowedOrigins` hot-reload.** An account
  added or removed in `devstack.config.ts` flips the producer's input
  hash and triggers a clean restart; the bearer token persists across
  restarts so the frontend's stored pair URL keeps working.
- **`port:` hint dropped.** The shared `ports` allocator picks an
  ephemeral port via slot `'walletApp.http'` — warm restarts preserve
  the allocation.

`walletApp.get('url')` / `'token'` / `'pairUrl'` / `'endpoint'` /
`'full'` resolve via the schema's static accessor before the instance
exists, so `manifest({ endpoints: [walletApp.get('endpoint')] })`
type-checks at config build time.

### `walrus`

```typescript
const w = walrus({ nodeCount: 4 });
const seedSteps = walrusSeedWal({
    exchange: w.exchange!,
    accounts: [{ name: 'alice', signer: pool.get('signer', { name: 'alice' }) }],
});

defineDevstackConfig({
    stack: [
        sui.create({ network: 'localnet' }),
        a.pool, a.fund,
        w.appNetwork, w.deploy.deploy, w.register!, w.exchange!,
        ...w.nodes,
        ...seedSteps,
    ],
});
```

`walrusProxy({ nodes })` is opt-in — single-host-port nginx vhost
in front of the committee.

### `deepbook`

```typescript
const usdcPublish = publishMove({ name: 'mock_usdc', ..., publish: publishViaSuiCli });
const usdcCoin    = registerCoin({
    name: 'musdc',
    package: usdcPublish.get('package'),
    module: 'mock_usdc',
    type: 'MOCK_USDC',
    decimals: 6,
});

const db = deepbookLocalnet({
    signer: pool.get('signer', { name: 'publisher' }),
    pools: [
        {
            name: 'sui_usdc',
            base: '0x2::sui::SUI',
            // Pool specs accept either a literal Move type or a Dep
            // returning one (a registered coin's `.get('coin')` is
            // accepted — the engine resolves it at runtime from the
            // upstream publish's packageId).
            quote: usdcCoin.get('coin'),
            tickSize: 1_000n,
            lotSize: 100_000_000n,
            minSize: 1_000_000_000n,
        },
    ],
});

const aliceMaker = deepbookMarketMaker({
    name: 'alice',
    signer: pool.get('signer', { name: 'alice' }),
    deepbookPackage: db.publish.get('package'),
    pools: db.pools!.get('full'),
    quotedPools: ['sui_usdc'],
    midPrices: { sui_usdc: 3_500_000n },
    sizePerLevel: 1_000_000_000n,
    levels: 3,
});
```

The market-maker is a long-running producer — Playwright globalSetup
runs `engine.runOnce()` so the tick loop never starts there; only
`pnpm dev` / `devstack-next up` keep the supervisor alive. Mechanical
port of old devstack's `deepbook/market-maker.ts` (same Move calls,
same fee math, same cadence).

---

## 4. Snapshots + restore

Stateful containers (`sui.localnet.container`, `sui.indexer-db`,
walrus storage nodes) commit their writable layer to a tagged image
on `engine.saveSnapshot()`; the next session boots from the
committed tag instead of the configured image, recovering chain
state across `docker rm`. No user wiring needed — it's on by default
for those plugins.

`devstack-next snapshot save <label>` / `restore <label>` work the
same way as before; the labeled SnapshotRecord on disk now points at
the committed tag.

---

## 5. Plugin gaps

None blocking the example cutover — all five examples
(`_template`, `arena`, `private-content`, `token-studio`, `wallet`)
plus the `create-devstack-app` scaffold compile against devstack-next.

Polish / nice-to-have, tracked in `notes/PLAN-NEXT.md`:

- **Snapshot pruning / GC** — old per-stack `<id>-<label>.json`
  snapshot files accumulate over long dev sessions.
- **More signer flavors** — multisig + zkLogin signers when consumers
  ask. The signer types are pluggable (`Dep<any, Keypair>`) so adding
  a new flavor is non-invasive.

---

## 6. Why bother

- **End-to-end verified.** The integration suite
  (`pnpm test:integration`) brings up real sui-localnet, walrus
  committees, and seal key-servers against a real chain. None of
  this was integration-tested in the old devstack.
- **Snapshot/restore actually preserves chain state.**
  `dockerContainer.snapshot:` commits the writable layer; restore
  boots from the committed tag.
- **Type-safe wiring.** Typo in a Dep → compile error, not a
  runtime "registry key not found".
- **Per-stack docker network.** Sui-localnet, walrus committee,
  seal key-server reach each other via the network's DNS aliases
  (`sui-localnet:9000`) without host-port shuffling.
- **Pure-logic engine core.** The reconciler has zero I/O — it's
  pure data transforms over a Map of node states. Tests don't need
  Docker or even a tmp dir for unit-level coverage.

---

## 7. Where to look

- `notes/STATE.md` — what's built, what's deferred.
- `notes/PLAN-NEXT.md` — what's left, sequenced.
- `PLAN.md` — original architecture writeup (long).
- `src/integration/` — runnable end-to-end examples.
