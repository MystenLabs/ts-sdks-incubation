# `@mysten-incubation/devstack`

> ⚠️ **Prototype.** Devstack is not published to npm and there is no near-term plan to publish. The
> public API is in flux — we break shapes whenever they're wrong rather than ship a shim. Use it
> inside this monorepo via `workspace:*`; pin nothing in external code.

A localnet harness for Sui apps. Each app declares the services it needs (sui, walrus, seal,
imports, codegen, ...) as a list of plugins; `devstack` reconciles toward that state, publishes Move
packages, runs codegen, and writes a typed manifest the frontend consumes via Vite. The harness is
opinionated about its goals: warm cycles short-circuit through `getStatus` so subsequent
`devstack up` invocations skip whatever's already converged. Cold cycles depend heavily on what's on
the plugin list — a sui-only stack is ~10–20 s on Apple Silicon. seal pulls release binaries (~30 s,
no compile). walrus is hybrid: `walrus` and `walrus-node` come from the release tarball, but
`walrus-deploy` (the testbed bootstrap binary) isn't published — we cargo-build only that. First
build is ~9–10 min; subsequent version bumps drop to ~1–2 min because BuildKit cache mounts reuse
the cargo registry + target dir. All images cached forever after the first build. Numbers in this
README are eyeballed during local development; if you're benchmarking, run it yourself and please
file the timing as a note in `notes/friction.md`.

For the full docs, see the [docs site](https://github.com/mysten-incubation/devstack#readme). For
the journal of paper-cuts driving evolution, see [`notes/friction.md`](notes/friction.md).

---

## Quickstart

Requires **Node.js 24+** (native TypeScript stripping — no tsx, no pre-build of the config) and
**Docker**.

While the package isn't on npm, install via a workspace path or git URL:

```sh
# Inside this monorepo:
pnpm --filter <your-app> add -D @mysten-incubation/devstack@workspace:*
```

```ts
// devstack.config.ts
import { codegen, defineDevstackConfig, frontend, sui } from '@mysten-incubation/devstack';

export default defineDevstackConfig({
	app: 'my-app',
	accounts: { publisher: {}, alice: {}, bob: {} },
	plugins: [sui(), codegen(), frontend({ port: 5173 })],
});
```

```jsonc
// package.json
{
	"scripts": {
		"dev": "devstack up",
		"localnet:up": "devstack up --once",
		"apply": "devstack apply",
		"codegen": "devstack codegen",
		"deploy": "devstack deploy",
		"stack": "devstack stack",
	},
}
```

```sh
pnpm dev                             # one combined process: stack + dev server
```

The supervisor brings up sui-localnet, fund accounts, publish Move packages, regenerate codegen
bindings, AND start the Vite dev server — all in one log stream. Re-runs are noticeably faster (warm
cycles short-circuit through `getStatus`) because each action's `getStatus` skip predicate
short-circuits work that hasn't drifted.

---

## Architecture in one screen

The runtime is a **declarative reconciler over an action graph**. A plugin contributes named actions
of one of seven kinds:

| Kind       | Purpose                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| `Build`    | Idempotent image / artifact build.                                           |
| `Service`  | Long-running container or host process. Localnet only.                       |
| `Publish`  | Move package publish — captures `packageId` + named object IDs.              |
| `Register` | On-chain registration that produces registry entries.                        |
| `Seed`     | Post-deploy state seeding (mint balances, open lobbies, place orders).       |
| `Emit`     | Side-effecting outputs derived from the registry (codegen, manifest writes). |
| `Verify`   | Read-only invariant check; fails the cycle on `ok: false`.                   |

Actions declare `needs: string[]` for ordering, `provides: { capabilities?, registry? }` for
capability declarations + a registry-rehydrate hook the reconciler invokes on warm-path skips, plus
`getStatus?(ctx)` — a probe that returns `{ ok: true }` when the action's effect is already in
place. `provides.registry(ctx)` runs on every successful path — both the cold cycle and warm-path
skips — so plugin authors can factor registry-population logic in one place instead of duplicating
it across `run` and `getStatus`. The reconciler:

1. Hydrates the registry from the prior manifest at
   `<appDir>/.devstack/stacks/<stack>/manifest.json` (localnet) or
   `<appDir>/.devstack/manifests/<network>.json` (live nets).
2. Topo-sorts actions (Kahn, stable tie-break, capability synthesis from `provides` ↔
   `needs: ['cap:before']`).
3. For each action: calls `getStatus`; if `ok: true`, marks `skipped`. If `ok: false` (or unset,
   with a stale input hash), runs the action.
4. After the topo walk, re-fires any `Emit` whose `dependsOnKind` is dirty — `consumeDirty` makes
   this re-fire-once-per-cycle, not infinite.
5. Writes the manifest.

### Registry — the inter-plugin API

```ts
ctx.registry.packages.find('connect_four');
ctx.registry.accounts.require('alice');
ctx.registry.services.list();
```

`packages`, `accounts`, `services` are the three core kinds — every `RegistryQuery<T>` exposes
`list()`, `find(name)`, `require(name)`, `register(item)`, and `unregister(name)`. Plugin-namespaced
kinds register through `defineRegistryKind<T>('<ns>.<kind>')` and serialize under their dotted key
in the manifest:

```ts
const arenaSharedObjects = defineRegistryKind<ArenaSharedObject>('arena.sharedObjects');
arenaSharedObjects(ctx.registry).register({ name: 'openLobby', objectId, objectType });
arenaSharedObjects(ctx.registry).list();
```

### Accounts

Top-level `accounts: { ... }` declares signers available as `ctx.accounts.get(name)` in plugins and
`accounts.<name>` in the REPL. Empty `{}` gets a per-stack generated keypair on disk. Live-net
deploys take a per-network signer config object (`{ testnet: ..., mainnet: ... }`); the prototype
ships only the localnet auto-keypair path on the public surface — live signer factories live in
source for in-monorepo use.

### Discriminated context

```ts
type ActionRunContext = LocalnetActionRunContext | LiveNetActionRunContext;
```

Plugin code that touches `ctx.stack` either narrows on `if (ctx.network === 'localnet') { ... }` or
calls `requireLocalnetCtx(ctx)` to assert at runtime.

---

## CLI surface

| Command                                          | What it does                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `devstack up [config]`                           | Long-running supervisor: reconcile + watch Move sources. `--once` for one-shot.                                 |
| `devstack apply [config] [--target] [--actions]` | Single-cycle reconcile. `--actions a,b,c` scopes to a subset.                                                   |
| `devstack deploy <config> --network`             | Live-network deploy slice.                                                                                      |
| `devstack codegen [config] [--target]`           | Re-emit codegen against the prior manifest (read-only).                                                         |
| `devstack down [config]`                         | Stop the active stack's containers (volumes preserved).                                                         |
| `devstack reset [config] --yes`                  | Wipe the active stack — containers, volumes, host state. `--images` also drops cached devstack images (global). |
| `devstack stack list/new/use/down/drop`          | Manage named per-app stacks. `drop --dry-run` previews deletion; `drop --images` cascades to image cache.       |
| `devstack snapshot save/restore/list/rm/hash`    | Capture / restore named snapshots of a stack (containers + volumes + host state).                               |
| `devstack console [config] [--target]`           | REPL with `manifest`, `client`, `accounts.<name>`, `packages.<name>` pre-bound.                                 |

`--target` accepts `<network>`, `<stack>`, or `<network>:<stack>`. The supervisor (`up`) is
localnet-only; live-network targets error with a hint pointing at `apply` or `deploy`.

### Image cache

The first-run builds — seal (~30 s, pure binary fetch) and walrus-service (~9–10 min on the cold
first build because `walrus-deploy` depends on most of the walrus workspace; ~1–2 min on subsequent
version bumps thanks to BuildKit cache mounts) — produce Docker images tagged
`dev-examples/<name>:<rev>` and labeled `devstack.cache=<kind>`. Sui-localnet, walrus's wrapper
layer, and the upstream-source images for `imports({ packages })` carry the same label scheme.

Successful builds **GC superseded tags automatically**: bumping `WRAPPER_REV` in `sui` / `walrus` or
pinning a new `SEAL_REV` triggers the new build to drop the prior tag once it lands, so old
`r6`-style revisions don't accumulate. In-use tags are kept (no `--force`).

To force a full first-build re-test from scratch:

```sh
# Preview what would be removed (lists tags + reports BuildKit reclaim estimate)
devstack reset --images --dry-run

# Drop active stack + every cached devstack-built image
# (also runs `docker image prune` for dangling layers and `docker builder
# prune` for BuildKit cache — without those, a rebuild short-circuits
# through cached layers and doesn't actually re-exercise the build path)
devstack reset --yes --images

# Ad-hoc with the docker CLI directly:
docker image rm $(docker image ls -q --filter "label=devstack.cache")
docker image prune -f --filter "label=devstack.cache"
docker builder prune -f
```

> **Why three commands?** `docker image rm` only removes the _tag_; the underlying layer manifest
> stays as a dangling image, and the BuildKit layer cache (where the cargo-build outputs live) is in
> a separate store that `image rm` never touches. To genuinely force a fresh Rust compile, all three
> need to run.

### Networking

Every Docker `--publish` defaults to `127.0.0.1:` — the sui-localnet RPC, faucet, GraphQL,
seal key-server, and walrus storage nodes are reachable only from the developer's own machine.
Other devices on the same LAN can't hit them. The wallet-server has its own `host:` knob with the
same default. Pass `expose: 'lan'` on `RunContainerOptions` (the underlying primitive
`runContainer` accepts) to bind a container's ports to `0.0.0.0` instead — useful for shared dev
rigs (a teammate hitting your faucet, a phone connecting to your wallet-server). The default is
deliberate: a localnet faucet on a laptop in a coffee shop should not mint dev SUI for arbitrary
strangers.

---

## Subpath layout

| Subpath                                                | Audience                 | What's there                                                                                                                            |
| ------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@mysten-incubation/devstack`                          | App authors              | `defineDevstackConfig`, `defineRegistryKind`, `coinTokens`, `publishMove`, `seed`, `runTransaction`, `mintCoinDistribution`, built-in plugins (`sui`, `walrus`, `seal`, `accounts`, `codegen`, `imports`, `frontend`, `walletServer`, `deepbook`) |
| `@mysten-incubation/devstack/app-setup`                | App authors (UI bootstrap) | `createWalletApp({ manifest })` — one-line dapp-kit setup wired with the devstack burner-wallet adapter and panels                    |
| `@mysten-incubation/devstack/helpers`                  | App-setup callbacks      | `seedSharedObject`, `createLocalSuiClient`                                                                                              |
| `@mysten-incubation/devstack/react`                    | App authors (UI)         | `DevstackProvider`, `useDevstackDeployed`, `useSignAndExecute`, `localnetDappKitConfig`, `localnetMvrOverrides`, `localnetWalrusOptions` |
| `@mysten-incubation/devstack/react/ui`                 | App authors (UI)         | `Card`, `Field` — primitive components shared across examples                                                                           |
| `@mysten-incubation/devstack/vite`                     | Vite users               | `devstackVitePlugins`, `devstackManifestPlugin` — `virtual:devstack-manifest` virtual module + dev-keys                                 |
| `@mysten-incubation/devstack/playwright`               | E2E tests                | `defineDevstackPlaywrightConfig({ manageStack })`, `connectAs`, `selectAccount`, `waitForBalanceUpdate`, `test`, `expect`              |
| `@mysten-incubation/devstack/vitest`, `vitest/runtime` | Unit + chain-aware tests | `defineDevstackVitestConfig`, `AccountPool`, `getSessionAccountPool`                                                                    |
| `@mysten-incubation/devstack/manifest`                 | Type-only consumers      | `Manifest` (re-export of the types from the main barrel, for `.d.ts`-only consumption paths)                                            |

---

## Built-in plugins

### `sui({ version?, rpcPort?, faucetPort? })`

Sui localnet container. Two actions: `sui.build`, `sui.localnet`. Account funding lives in the
separate `accounts()` plugin (`accounts.fund`) — the sui plugin no longer takes an `accounts:`
option.

### `walrus({ version?, suiVersion?, nodeHostPortBase?, epochDuration?, committeeSize?, shards?, gc? })`

Walrus testbed on a pinned per-stack subnet. Provides the `app-network` capability. Defaults to a
4-node committee with 100 shards. `version` pins a release tag (`'devnet-v1.48.0'` by default) —
runtime binaries (`walrus`, `walrus-node`) come from the matching GitHub release tarball;
`walrus-deploy` (the testbed bootstrap binary, not in any public release) compiles from source.
First build ~9–10 min on M-series, version bumps ~1–2 min via BuildKit cache mounts. Pass
`gc: true` to enable in-node blob garbage-collection (matches the walrus team's `--gc` knob in
their procman config).

### `seal({ version?, port?, keyServerName?, master?, publisher? })`

Seal key-server in Open mode. Four actions: build, publish (Move package), register (BLS keypair +
on-chain `KeyServer`), key-server (Service). On first run the `register` action shells out to
`seal-cli genkey` inside the build image to mint a BLS12-381 master keypair, then writes both halves
to `<stackDir>/.keys/seal-master-key.json`. Subsequent runs load the cached pair so `KeyServer.id`
and the on-chain registration stay stable across `up`/`down` cycles. Pass `master:` directly to
bypass key generation entirely (deterministic test fixtures).

### `codegen({ output?, mvrName? })`

One Emit action that runs `@mysten/codegen`'s `generateFromPackageSummary` per `packages` registry
entry whose `path?` is set. Defaults to `./src/generated/sui/<package>/`.

Each generated builder embeds an MVR-shape placeholder (`@local/<kebab-name>`) as its default
`package` option. The matching `mvr.overrides.packages` entry — wired automatically by
`localnetDappKitConfig(manifest)` — resolves the placeholder to the live `packageId` at transaction
build time. App code calls `tx.add(connectFour.joinLobby({ arguments: [...] }))` directly; the SDK
substitutes the live id during build.

`mvrName?: (pkgName) => string` overrides the default placeholder shape. If you change it, pass the
same mapper to `localnetDappKitConfig({ mvrName })` so the codegen output and the override key
agree.

### `imports({ packages })`

Recursive Move-package imports from git. Per package: a Build action (content-addressed source
image) + a Publish action with `provides: ['imports.<name>']`. Curated `addresses[network]`
overrides the publish on live nets. Cross-imports referencing one another via `dependsOn:` walk
the Move.toml dep graph automatically.

---

## Authoring app-level `setup:` actions

Apps declare per-app actions inline in `defineDevstackConfig({ setup: [...] })`. The list is
synthesized into a per-app plugin at config-load time — no separate plugin definition needed for
single-app code. The action graph IS the app lifecycle: ordering via `needs:`, idempotence via
input-hash match (or an explicit `getStatus`), serialization on shared signers via `runsAs:`.

The arena example, in full:

```ts
import {
	accounts, codegen, defineDevstackConfig, defineRegistryKind, frontend,
	publishMove, seed, sui, walletServer,
} from '@mysten-incubation/devstack';
import { createLocalSuiClient, seedSharedObject } from '@mysten-incubation/devstack/helpers';

interface ArenaSharedObject { name: string; objectId: string; objectType: string }
const arenaSharedObjects = defineRegistryKind<ArenaSharedObject>('arena.sharedObjects');

export default defineDevstackConfig({
	app: 'arena',
	accounts: ['publisher', 'alice', 'bob'],
	plugins: [sui(), accounts(), codegen(), walletServer({ port: 9421 }), frontend({ port: 5176 })],
	setup: [
		publishMove({
			name: 'connect_four',
			needs: ['accounts.fund'],
			path: './move/connect_four',
		}),
		seed({
			name: 'openLobby',
			needs: ['connect_four'],
			inputs: { lobby: 'openLobby' },
			run: async (ctx) => {
				const pkg = ctx.registry.packages.require('connect_four');
				const lobbyCreator = ctx.accounts.get('alice');
				const client = createLocalSuiClient(ctx.registry.services.require('sui-rpc').url);
				const result = await seedSharedObject({
					client, publisher: lobbyCreator,
					target: `${pkg.packageId}::game::create_lobby`,
					objectTypeFilter: '::game::Lobby',
				});
				arenaSharedObjects(ctx.registry).register({
					name: 'openLobby',
					objectId: result.objectId,
					objectType: result.objectType,
				});
			},
		}),
	],
});
```

Bare `needs:` resolve to the same app's setup actions; dotted needs cross into plugins
(`'accounts.fund'`, `'sui.localnet'`); suffixed needs (`'app-network:before'`) hit the capability
table.

### Setup action factories

`@mysten-incubation/devstack` re-exports the action factories app code reaches for:

- `publishMove({ name, path, needs?, capture?, onPublished?, ... })` — Publish action with build +
  publish + register + cache baked in. `capture: { adminCap: '::admin::AdminCap' }` extracts
  created objects by type-suffix into `registry.packages.<name>.captured`.
- `seed({ name, run, getStatus?, inputs?, runsAs?, liveNetworks?, ... })` — Seed action. Skipped on
  testnet/mainnet by default; opt in via `liveNetworks: ['testnet']`.
- `runTransaction({ name, build, runsAs?, ... })` — generic transaction runner; default `getStatus`
  is a marker file at `<stackDir>/setup/<name>.done` keyed by stable-hash of the inputs.
- `mintCoinDistribution({ name, ... })` — coin-distribution helper used by token-bearing apps.

The lower-level factories (`definePlugin`, `service`, `containerService`, `hostProcess`,
`buildImage`, `register`, `emit`, `publish`) are not on the public barrel — they're for
in-monorepo plugin authoring and live under `packages/devstack/src/{actions,plugins}/`. Walk the
built-in plugins (`src/plugins/{sui,walrus,seal,...}/`) as the canonical examples.

### Helpers (`@mysten-incubation/devstack/helpers`)

- `seedSharedObject({ client, publisher, target, objectTypeFilter })` — common Seed pattern. Calls
  the target Move function, picks the created shared object by `objectTypeFilter`, returns
  `{ objectId, objectType }`. The default `getStatus` baked into `seed()`'s wrapper checks the
  cached shared-object id is still live on-chain.
- `createLocalSuiClient(url, network?)` — minimal `SuiJsonRpcClient` constructor for setup-time
  reads / writes.

---

## React adapter

Two subpaths: `@mysten-incubation/devstack/app-setup` for the one-line dapp-kit bootstrap, and
`@mysten-incubation/devstack/react` for the provider + hooks consumed inside components. The
surface is intentionally minimal and manifest-driven — generic SDK ergonomics (signing
transactions, binding codegen modules) live in `@mysten/dapp-kit-react` / `@mysten/codegen`.

```tsx
// dapp-kit.ts — what every example uses, byte-for-byte
import { createWalletApp } from '@mysten-incubation/devstack/app-setup';
import { manifest } from 'virtual:devstack-manifest';

export const { dAppKit } = createWalletApp({ manifest });

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
```

`createWalletApp({ manifest })` wires up `localnetDappKitConfig`, the devstack burner-wallet
adapter (`@mysten-incubation/dev-wallet/adapters`), and the devstack panels
(`@mysten-incubation/devstack-wallet-panels`) into a single `createDAppKit({...})` call. Apps
declaring their own dapp-kit shape can compose `localnetDappKitConfig(manifest)` directly from the
`/react` subpath instead — the function returns the `defaultNetwork` / `networks` / `createClient`
triple plus pre-loaded MVR overrides keyed `@local/<kebab-name>`.

```ts
// devstack.config.ts — opt-in walletServer is what lets the burner-wallet
// adapter sign without leaking keys into the frontend bundle
import { walletServer } from '@mysten-incubation/devstack';
plugins: [sui(), /* ... */, walletServer({ port: 9421 }), frontend({ port: 5176 })];
```

`walletServer()` spins up an in-process HTTP endpoint exposing every account devstack resolved.
Keys never enter the frontend bundle — the dev-wallet adapter signs by HTTPing the supervisor.

```tsx
// main.tsx
import { DevstackProvider } from '@mysten-incubation/devstack/react';
import { manifest } from 'virtual:devstack-manifest';

<DevstackProvider manifest={manifest}>
	<App />
</DevstackProvider>;
```

```tsx
// component.tsx
import { Transaction } from '@mysten/sui/transactions';
import { useSignAndExecute } from '@mysten-incubation/devstack/react';
import * as connectFour from './generated/sui/connect_four/game';

const { mutateAsync, isPending } = useSignAndExecute({ invalidateKeys: [['arena']] });

const tx = new Transaction();
tx.add(connectFour.joinLobby({ arguments: [lobbyId] }));
await mutateAsync(tx);
```

`useSignAndExecute` is a sign + waitForTransaction + invalidate helper. Apps wrap it in their own
`lib/queries.ts` to bind app-specific `invalidateKeys` defaults, but the wrapper is a one-line
re-export, not a fork. Production app code looks identical; the file that differs between local
and prod is `dapp-kit.ts` — drop `createWalletApp` and supply your own RPC + MVR + adapter set.

---

## Manifest format

Per-stack on localnet at `<appDir>/.devstack/stacks/<stack>/manifest.json`; per-network on live nets
at `<appDir>/.devstack/manifests/<network>.json`.

```jsonc
{
	"app": "arena",
	"network": "localnet",
	"emittedAt": "2026-04-30T...",
	"registry": {
		"packages": [{ "name": "connect_four", "packageId": "0x...", "captured": {...} }],
		"accounts": [{ "name": "publisher", "address": "0x...", "funded": true }],
		"services": [{ "name": "sui-rpc", "url": "http://127.0.0.1:9000", ... }],
		"arena": { "sharedObjects": [{ "name": "openLobby", "objectId": "0x..." }] },
		"coin": { "tokens": [...] }
	},
	"actionStates": { "<plugin>.<action>": { "lastInputHash": "...", "lastRunAt": ..., "identity": "..." } }
}
```

`packages` / `accounts` / `services` are core kinds. Plugin-namespaced kinds register through
`defineRegistryKind('<ns>.<kind>')` and serialize as nested objects (`registry.<ns>.<kind>[]`).

---

## Layout

```
src/
  cli/         — up | apply | deploy | codegen | console | stack | snapshot
                 (down/reset are aliases on top of stack)
  core/        — Action / Plugin / Registry / Network types + requireLocalnetCtx
  registry/    — typed Proxy-backed Registry + defineRegistryKind
  actions/     — build / service / container-service / host-process /
                 publish / publish-move / register / seed / emit / verify /
                 transaction / mint-coin-distribution
  runtime/     — reconciler, supervisor, status renderer, file watcher,
                 manifest writer/reader, one-shot (with actionScope),
                 topo (with lenient mode), accounts resolver, hash,
                 active-stack, supervisor-lock, port-allocator, snapshot
  plugin.ts    — definePlugin + defineDevstackConfig + expandPluginActions
  helpers/     — move-package (host or container build), imported-package,
                 sui-client, signers, keystore, seed-shared-object, ...
  plugins/     — accounts | sui | walrus | seal | codegen | deepbook |
                 imports | wallet-server | frontend
  app-setup/   — createWalletApp (one-line dapp-kit bootstrap)
  react/       — DevstackProvider | useDevstackDeployed |
                 useSignAndExecute | localnetDappKitConfig |
                 localnetMvrOverrides | localnetWalrusOptions
  vite/        — devstackManifestPlugin / devstackVitePlugins
                 (virtual:devstack-manifest + dev-keys)
  playwright/  — defineDevstackPlaywrightConfig (with manageStack) + helpers
  vitest/      — defineDevstackVitestConfig + AccountPool runtime
```
