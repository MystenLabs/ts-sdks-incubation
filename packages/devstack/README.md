# `@mysten-incubation/devstack`

> ⚠️ **Prototype.** Devstack is not published to npm and there is no near-term plan to
> publish. The public API is in flux — we break shapes whenever they're wrong rather than
> ship a shim. Use it inside this monorepo via `workspace:*`; pin nothing in external code.

A localnet harness for Sui apps. Each app declares the services it needs (sui, walrus, seal,
imports, codegen, ...) as a list of plugins; `devstack` reconciles toward that state, publishes Move
packages, runs codegen, and writes a typed manifest the frontend consumes via Vite. The harness is
opinionated and fast — a fresh `arena` (sui-only) `pnpm exec devstack up` finishes in ~17 s; a fresh
`private-content` (sui+walrus+seal) finishes in ~76 s on Apple Silicon. Warm cycles short-circuit
through `getStatus` and run in 1–3 s.

For the full docs, see the [docs site](https://github.com/mysten-incubation/devstack#readme). For
the journal of paper-cuts driving evolution, see
[`../../notes/friction.md`](../../notes/friction.md).

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
bindings, AND start the Vite dev server — all in one log stream. Re-run is fast (~1–3 s) because
each action's `getStatus` skip predicate short-circuits work that hasn't drifted.

---

## Architecture in one screen

The runtime is a **declarative reconciler over an action graph**. A plugin contributes named actions
of one of six kinds:

| Kind       | Purpose                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| `Build`    | Idempotent image / artifact build.                                           |
| `Service`  | Long-running container or host process. Localnet only.                       |
| `Publish`  | Move package publish — captures `packageId` + named object IDs.              |
| `Register` | On-chain registration that produces registry entries.                        |
| `Seed`     | Post-deploy state seeding (mint balances, open lobbies, place orders).       |
| `Emit`     | Side-effecting outputs derived from the registry (codegen, manifest writes). |
| `Verify`   | Read-only invariant check; fails the cycle on `ok: false`.                   |

`provides` accepts either a bare `string[]` (capability names for
ordering only) OR an object form `{ capabilities?, registry? }`.
`provides.registry(ctx)` is invoked by the reconciler on every
successful path — both the cold cycle and warm-path skips — so plugin
authors can factor registry-population logic in one place instead of
duplicating it across `run` and `getStatus`.

Actions declare `needs: string[]` for ordering, `provides: string[]` for capability declarations,
plus `getStatus?(ctx)` — a probe that returns `{ ok: true }` when the action's effect is already in
place. The reconciler:

1. Hydrates the registry from the prior manifest at
   `<appDir>/.devstack/stacks/<stack>/manifest.json` (localnet) or
   `<appDir>/.devstack/manifests/<network>.json` (live nets).
2. Topo-sorts actions (Kahn, stable tie-break, capability synthesis from `provides` ↔
   `needs: ['cap:before' | 'cap:after']`).
3. For each action: calls `getStatus`; if `ok: true`, marks `skipped`. If `ok: false` (or unset,
   with a stale input hash), runs the action.
4. After the topo walk, re-fires any `Emit` whose `dependsOnKind` is dirty — `consumeDirty` makes
   this re-fire-once-per-cycle, not infinite.
5. Writes the manifest.

### Registry — the inter-plugin API

```ts
ctx.registry.tokens.list();
ctx.registry.packages.find('connect_four');
ctx.registry.accounts.require('alice');
ctx.registry.services.list();
```

Plus plugin-namespaced kinds via `ctx.registry.ns<T>('walrus').nodes` — the namespace becomes a key
in the serialized manifest under `registry.<ns>.<kind>[]`.

### Accounts

Top-level `accounts: { ... }` declares signers available as `ctx.accounts.get(name)` in plugins and
`accounts.<name>` in the REPL. Empty `{}` gets a per-stack generated keypair on disk; per-network
factories handle live deploys:

```ts
import { cliSigner, envSigner } from '@mysten-incubation/devstack';

defineDevstackConfig({
	accounts: {
		alice: {},
		publisher: {
			testnet: cliSigner({ alias: 'deployer' }),
			mainnet: envSigner({ name: 'PROD_KEY' }),
		},
	},
	/* ... */
});
```

### Discriminated context

```ts
type ActionRunContext = LocalnetActionRunContext | LiveNetActionRunContext;
```

Plugin code that touches `ctx.stack` either narrows on `if (ctx.network === 'localnet') { ... }` or
calls `requireLocalnetCtx(ctx)` to assert at runtime.

---

## CLI surface

| Command                                          | What it does                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `devstack up [config]`                           | Long-running supervisor: reconcile + watch Move sources. `--once` for one-shot. |
| `devstack apply [config] [--target] [--actions]` | Single-cycle reconcile. `--actions a,b,c` scopes to a subset.                   |
| `devstack deploy <config> --network`             | Live-network deploy slice.                                                      |
| `devstack codegen [config] [--target]`           | Re-emit codegen against the prior manifest (read-only).                         |
| `devstack down [config]`                         | Stop the active stack's containers (volumes preserved).                         |
| `devstack reset [config] --yes`                  | Wipe the active stack — containers, volumes, host state.                        |
| `devstack stack list/new/use/down/drop`          | Manage named per-app stacks. `drop --dry-run` previews deletion.                |
| `devstack console [config] [--target]`           | REPL with `manifest`, `client`, `accounts.<name>`, `packages.<name>` pre-bound. |

`--target` accepts `<network>`, `<stack>`, or `<network>:<stack>`. The supervisor (`up`) is
localnet-only; live-network targets error with a hint pointing at `apply` or `deploy`.

---

## Subpath layout

| Subpath                                                | Audience                 | What's there                                                                                                                                       |
| ------------------------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mysten-incubation/devstack`                          | Plugin + app authors     | `definePlugin`, `defineDevstackConfig`, action factories, built-in plugins, signer factories, types                                                |
| `@mysten-incubation/devstack/runtime`                  | Embedders                | `Reconciler`, `Supervisor`, `RegistryImpl`, `FileWatcher`, `StatusRenderer`, manifest I/O, `runOneShot`, active-stack helpers                      |
| `@mysten-incubation/devstack/cli`                      | CLI consumers            | `runUp`, `runDeploy`, `runApply`, `runCodegen`, `runConsole`, `runStack`, target/filter helpers                                                    |
| `@mysten-incubation/devstack/helpers`                  | Plugin authors           | `publishMovePackage`, `importMovePackage`, `seedSharedObject`, `objectTypeMatchesFilter`, `ensureUpstreamSourceImage`, `createLocalSuiClient`      |
| `@mysten-incubation/devstack/react`                    | App authors (UI)         | `DevstackProvider`, `useDevstackManifest`, `useDevstackDeployed`, `localnetDappKitConfig`, `localnetMvrOverrides`, `localnetWalrusOptions`, `defaultMvrName` |
| `@mysten-incubation/devstack/vite`                     | Vite users               | `devstackVitePlugins` (manifest + dev-keys virtual modules)                                                                                        |
| `@mysten-incubation/devstack/playwright`               | E2E tests                | `defineDevstackPlaywrightConfig({ manageStack })` + helpers                                                                                        |
| `@mysten-incubation/devstack/vitest`, `vitest/runtime` | Unit + chain-aware tests | `defineDevstackVitestConfig`, `AccountPool`                                                                                                        |

---

## Built-in plugins

### `sui({ version?, rpcPort?, faucetPort? })`

Sui localnet container. Three actions: `sui.build`, `sui.localnet`, `sui.accounts`. Account names
come from top-level `accounts: { ... }` — the plugin no longer takes an `accounts:` option.

### `walrus({ rev? })`

4-node Walrus testbed on a pinned subnet. Provides the `app-network` capability. First-run image
build is heavy.

### `seal({ rev?, apiPort? })`

Seal key-server in Open mode. Four actions: build, publish (Move package), register (BLS keypair +
on-chain `KeyServer`), key-server (Service). The master key is cached at
`<stackDir>/.keys/seal-master-key.json`.

### `codegen({ output?, mvrName? })`

One Emit action that runs `@mysten/codegen`'s `generateFromPackageSummary` per `packages`
registry entry whose `path?` is set. Defaults to `./src/generated/sui/<package>/`.

Each generated builder embeds an MVR-shape placeholder (`@local/<kebab-name>`) as its
default `package` option. The matching `mvr.overrides.packages` entry — wired automatically
by `localnetDappKitConfig(manifest)` — resolves the placeholder to the live `packageId` at
transaction build time. App code calls `tx.add(connectFour.joinLobby({ arguments: [...] }))`
directly; the SDK substitutes the live id during build.

`mvrName?: (pkgName) => string` overrides the default placeholder shape. If you change it,
pass the same mapper to `localnetDappKitConfig({ mvrName })` so the codegen output and the
override key agree.

### `imports({ packages })`

Recursive Move-package imports from git. Per package: a Build action (content-addressed source
image) + a Publish action with `provides: ['imports.<name>']`. Curated `addresses[network]`
overrides the publish on live nets. Use `await withRecursiveDeps([{...}])` to walk Move.toml dep
graphs.

---

## Plugin authoring

```ts
import { definePlugin, definePublishAction, seed } from '@mysten-incubation/devstack';

export const arenaPlugin = () =>
	definePlugin({
		name: 'arena',
		actions: () => [
			definePublishAction({
				name: 'connect_four',
				needs: ['sui.accounts'],
				sourcePath: './move/connect_four',
				capture: { adminCap: '::admin::AdminCap' },
				onPublished: (ctx, result) => {
					/* fired only on a fresh publish, not on cache hit */
				},
			}),
			seed({
				name: 'openLobby',
				needs: ['connect_four'],
				run: async (ctx) => {
					/* mint + share Lobby */
				},
				getStatus: async (ctx) => {
					/* check shared Lobby still on-chain */
				},
			}),
		],
	});
```

Bare action names auto-prefix with the plugin namespace (`arena.connect_four`). Bare `needs:`
resolve locally; dotted needs (`'sui.accounts'`) cross plugins; suffixed needs
(`'app-network:before'`) hit the capability table.

`definePublishAction` bakes in a default `getStatus` (chainId match + on-chain liveness) and `run`
(build → publish → register → optional `onPublished` hook). Use the lower-level `publish({...})`
factory for custom shapes (the imports plugin's escape hatch).

### Action helpers

| Helper                                              | Returns                                                  |
| --------------------------------------------------- | -------------------------------------------------------- |
| `buildImage({ name, run, getStatus?, watches? })`   | `Build` action.                                          |
| `service({ name, run, getStatus?, ... })`           | `Service` action. Localnet only.                         |
| `containerService({ name, run, ... })`              | Typed factory: managed docker container.                 |
| `hostProcess({ name, run, ... })`                   | Typed factory: in-process subprocess (vite, wallet-server). |
| `job({ name, run, ... })`                           | Typed factory: run-once task.                            |
| `verify({ name, check })`                           | `Verify` action — read-only invariant.                   |
| `publish({ name, run, getStatus?, ... })`           | `Publish` action — low-level escape hatch.               |
| `definePublishAction({ name, sourcePath, ... })`    | `Publish` action with build + register + cache baked in. |
| `register({ name, run, ... })`                      | `Register` action.                                       |
| `seed({ name, run, getStatus?, liveNetworks? })`    | `Seed` action. Default-skipped on testnet/mainnet.       |
| `emit({ name, run, dependsOnKind, ... })`           | `Emit` action.                                           |

`containerService` / `hostProcess` / `job` are typed wrappers around `service` for cognitive
clarity at call sites. Same underlying `ServiceAction` shape — pick the one that matches the
intent. Plugin authors wire `provides: { registry: ... }` on these to repopulate registry
entries on warm-path skips without manually reimplementing the side effect inside `getStatus`.

### Helpers worth knowing

Subpath: `@mysten-incubation/devstack/helpers`.

- `publishMovePackage` — host-side or in-container `sui move build` + SDK publish. Caches by
  source-digest. `buildEnv: 'host' | 'container'`.
- `importMovePackage` — git-pinned imports via in-container
  `sui client test-publish --with-unpublished-dependencies`.
- `seedSharedObject` — common Seed pattern; `getStatus` checks the cached shared-object id is still
  live on-chain.
- `createLocalSuiClient(url, network?)` — minimal `SuiJsonRpcClient` constructor.
- `cliSigner({ alias })` / `envSigner({ name })` / `generatedKeypair()` — signer factories for
  `config.accounts`.

---

## React adapter

Subpath: `@mysten-incubation/devstack/react`. The surface is intentionally minimal and
manifest-driven — generic SDK ergonomics (signing transactions, binding codegen modules)
live in `@mysten/dapp-kit-react` / `@mysten/codegen` / your app's `lib/queries.ts`. Devstack
contributes the localnet config inputs that get spread into vanilla `createDAppKit({...})`
and `new WalrusClient({...})`.

```tsx
// dapp-kit.ts — vanilla `createDAppKit`; the spread is the only localnet-specific piece
import { createDAppKit } from '@mysten/dapp-kit-core';
import { devWalletInitializer } from '@mysten-incubation/dev-wallet';
import { createDevstackAdapterFromManifest } from '@mysten-incubation/dev-wallet/adapters';
import { localnetDappKitConfig } from '@mysten-incubation/devstack/react';
import { configureDevstackPanels, devstackPanels } from '@mysten-incubation/devstack-wallet-panels';
import { manifest } from 'virtual:devstack-manifest';

configureDevstackPanels(manifest);
const devstackAdapter = createDevstackAdapterFromManifest(manifest);

export const dAppKit = createDAppKit({
	...localnetDappKitConfig(manifest),
	walletInitializers: [
		devWalletInitializer({
			adapters: devstackAdapter ? [devstackAdapter] : [],
			panels: devstackPanels(),
			autoConnect: true,
			autoApprove: true,
			mountUI: true,
		}),
	],
});

declare module '@mysten/dapp-kit-react' {
	interface Register {
		dAppKit: typeof dAppKit;
	}
}
```

`localnetDappKitConfig(manifest)` returns the `defaultNetwork` / `networks` / `createClient`
triple plus pre-loaded MVR overrides keyed `@local/<kebab-name>`. App TSX calls codegen
builders directly — the SDK's `namedPackagesPlugin` resolves placeholders to live
`packageId`s at tx build time.

```ts
import { walletServer } from '@mysten-incubation/devstack';
// ...
plugins: [sui(), /* ... */, walletServer({ port: 9420 }), frontend({ port: 5174 })],
```

`walletServer()` spins up an in-process HTTP endpoint exposing every account devstack
resolved. Keys never enter the frontend bundle — `DevstackSignerAdapter` signs by HTTPing
the supervisor process.

```tsx
// main.tsx — no codegen-module registration; just the manifest
import { DevstackProvider } from '@mysten-incubation/devstack/react';
import { manifest } from 'virtual:devstack-manifest';

<DevstackProvider manifest={manifest}>
	<App />
</DevstackProvider>;
```

```tsx
// component.tsx — no devstack imports outside `useSignAndExecute` (app-local)
import { Transaction } from '@mysten/sui/transactions';
import * as connectFour from './generated/sui/connect_four/game';
import { useSignAndExecute } from './lib/queries';

const { mutateAsync, isPending } = useSignAndExecute({ invalidateKeys: [['arena']] });

const tx = new Transaction();
tx.add(connectFour.joinLobby({ arguments: [lobbyId] }));
await mutateAsync(tx);
```

`useSignAndExecute` is a thin app-local helper around `dAppKit.signAndExecuteTransaction`
+ `useMutation` — typically ~50 lines in `lib/queries.ts`. The four examples each carry
their own copy. Production app code looks identical; the only file that differs between
local and prod is `dapp-kit.ts` (drops the `localnetDappKitConfig` spread, supplies its
own RPC + real MVR or hardcoded packageIds).

---

## Manifest format

Per-stack on localnet at `<appDir>/.devstack/stacks/<stack>/manifest.json`; per-network on live nets
at `<appDir>/.devstack/manifests/<network>.json`.

```jsonc
{
	"app": "arena",
	"network": "localnet",
	"version": 2,
	"emittedAt": "2026-04-30T...",
	"registry": {
		"tokens": [...],
		"packages": [{ "name": "connect_four", "packageId": "0x...", "captured": {...} }],
		"accounts": [{ "name": "publisher", "address": "0x...", "funded": true }],
		"services": [{ "name": "sui-rpc", "url": "http://127.0.0.1:9000", ... }],
		"arena": { "sharedObjects": [{ "name": "openLobby", "objectId": "0x..." }] }
	}
}
```

`ManifestVersion = 1 | 2` is reserved for forward-compat; `readManifestWithMigration` from
`/runtime` walks the (currently empty) migration table.

---

## Layout

```
src/
  cli/         — up | apply | deploy | codegen | console | stack | down | reset
  core/        — Action / Plugin / Registry / Network types + requireLocalnetCtx
  registry/    — typed Proxy-backed Registry
  actions/     — build / service / containerService / hostProcess / job /
                 publish / definePublishAction / register / seed / emit / verify
  runtime/     — reconciler, supervisor, status renderer, file watcher,
                 manifest writer/reader (+ readManifestWithMigration),
                 one-shot (with actionScope), topo (with lenient mode),
                 accounts resolver, hash, active-stack
  plugin.ts    — definePlugin + expandPluginActions
  helpers/     — move-package (host or container build), imported-package,
                 sui-client, signers, keystore, seed-shared-object, ...
  plugins/     — sui | walrus | seal | codegen | imports | wallet-server | vite
  react/       — DevstackProvider | useDevstackManifest | useDevstackDeployed |
                 localnetDappKitConfig | localnetMvrOverrides | localnetWalrusOptions |
                 defaultMvrName
  vite/        — virtual:devstack-manifest plugin
  playwright/  — defineDevstackPlaywrightConfig (with manageStack) + helpers
  vitest/      — defineDevstackVitestConfig + AccountPool runtime
```
