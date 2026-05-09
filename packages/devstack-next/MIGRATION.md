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
| `walletApp({ port })`                                  | **Gap** — see [Plugin gaps](#plugin-gaps) below                                                         |
| `frontend({ port })`                                   | `viteDevServer({ gates: [...] })` (helper, not a schema)                                                |
| `publishMove({ name, path, publisher? })`              | `publishMove({ name, path, signer, publish: publishViaSuiCli })`                                        |
| `seed({ name, needs, signer, run })`                   | `runTransaction({ name, signer, deps?, build })` (or raw `define()` for non-tx side effects)            |
| `runTransaction({ name, needs, signer, build })`       | `runTransaction({ name, signer, deps?, build })` (`needs` becomes `deps`)                               |
| `registerCoin({ from, package, … })`                   | **Gap** — see [Plugin gaps](#plugin-gaps) below                                                         |
| `walrus({})`                                           | `walrus({ nodeCount? })` → returns `{ nodes, appNetwork, deploy, register, exchange }`                  |
| `seal({})`                                             | `sealLocalnet({ signer })` → returns full bundle (see seal section below)                               |
| `deepbook({ pools, marketMakers })`                    | `deepbookLocalnet({ signer })` for publish + create-pool. Market makers: **gap**.                       |
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
const db = deepbookLocalnet({
    signer: pool.get('signer', { name: 'publisher' }),
    pools: [{ name: 'sui_usdc', base: 'sui', quote: '@reg/musdc', ... }],
});
```

`marketMakers` from old devstack is **not yet ported** — see
[Plugin gaps](#plugin-gaps) below.

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

These are explicitly NOT yet ported — follow-up work tracked in
`notes/PLAN-NEXT.md`:

- **`walletApp({ port })`** — the dev-wallet HTTP server with
  custom-element panels (devstack-wallet-panels). The replacement
  ("server-backed signer adapter + custom-element panel API") is a
  separate workstream.
- **`registerCoin({ from, package, name, … })`** — coin-token
  registry helper. Workaround: emit the coin metadata directly via
  the `manifest` plugin's `coins:` field (when added).
- **`deepbook.marketMakers`** — long-running grid market-maker host
  process. Easy to port to `hostProcess`-wrapping, but not in this
  release.
- **In-place example cutover** — the `examples/*` apps still use the
  old API + their frontends consume the old manifest format. Porting
  each app is mechanical for the chain-side bring-up but blocked on
  the gaps above for full UI integration.

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
