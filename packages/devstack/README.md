# @mysten-incubation/devstack

Hermetic local Sui dev stack. Boots a Sui localnet, Walrus, Seal, DeepBook, and your Move packages
for end-to-end dApp development, and exposes the same services as composable Effect `Layer`s for
embedding in Effect programs.

`private: true`, workspace-only. Not yet on npm.

## Who this is for

**Writing a `devstack.config.ts` for `pnpm dev`.** Reach for `defineDevstack(...)`. You get a TUI,
hot-restart on file change, signal handlers, and a CLI (`devstack up`, `apply`, `status`, ...). This
is the shape every example under `examples/*` uses.

**Embedding Sui/Walrus/Seal/DeepBook services in an Effect program.** Reach for
`provideDevstack(...)`. Returns the same composed `Layer` without the launch loop — wire it into
your existing `Effect.provide` and consume the interface tags (`Sui`, `WalrusNetwork`, ...)
directly. `examples/effect-app/` shows the pattern.

Both surfaces consume the same primitives. The only thing that changes is whether you want the
runner attached.

## Quick start

### Writing a stack — CLI / TUI mode

```ts
// devstack.config.ts
import { Effect } from 'effect';
import {
	accounts,
	defineDevstack,
	manifest,
	publishMove,
	suiLocalnet,
	tx,
	walletApp,
} from '@mysten-incubation/devstack';

const a = accounts({ alice: {}, bob: {} });

const helloPublish = publishMove({
	name: 'hello',
	path: './move/hello',
	signer: a.alice,
});

const mintGreeting = tx({
	name: 'mint-greeting',
	signer: a.alice,
	dependsOn: [helloPublish],
	build: (t) =>
		Effect.gen(function* () {
			const pkg = yield* helloPublish;
			t.moveCall({ target: `${pkg.packageId}::hello::mint` });
		}),
});

export default defineDevstack([
	suiLocalnet(),
	a.alice,
	a.bob,
	helloPublish,
	mintGreeting,
	manifest(),
	walletApp({ accounts: [a.alice, a.bob] }),
]);
```

Then:

```sh
pnpm exec devstack up
```

`defineDevstack` accepts either an array of stack members or a config object
(`{ stack, stackName?, network?, renderer?, watch?, stateDir? }`). The returned `Devstack` exposes
`.run()` (programmatic Promise), `.runMain()` (NodeRuntime — CLI entry), `.layer` (for fixtures),
and `.config`.

### Embedding services — DI-only mode

```ts
// src/main.ts
import { Effect } from 'effect';
import { runMain } from '@effect/platform-node/NodeRuntime';
import {
	accounts,
	provideDevstack,
	Sui,
	suiLocalnet,
	suiTestnet,
} from '@mysten-incubation/devstack';

const a =
	process.env.NODE_ENV === 'production'
		? accounts({ alice: { from: 'env', key: 'ALICE_PRIVATE_KEY' } })
		: accounts({ alice: { from: 'ephemeral-funded' } });

const program = Effect.gen(function* () {
	const sui = yield* Sui;
	const alice = yield* a.alice;
	yield* Effect.log(`sui ${sui.network} @ ${sui.rpcUrl}`);
	yield* Effect.log(`alice: ${alice.address}`);
});

const layer =
	process.env.NODE_ENV === 'production'
		? provideDevstack([suiTestnet(), a.alice])
		: provideDevstack([suiLocalnet(), a.alice]);

runMain(program.pipe(Effect.provide(layer)));
```

The program depends on the `Sui` _interface tag_, not on a specific factory. Swap `suiLocalnet()`
for `suiTestnet()` / `suiMainnet()` / `suiCustom({...})` in one line and `program` is untouched. The
`from:` discriminator on `accounts` lets the same code bind the signer to different sources by env
(`'ephemeral-funded'` in dev, `'env'` / `'keystore'` / `'inline'` in prod).

## Primitives

User-facing factory tier. Import from the package root.

**Heads up — testnet/mainnet `*Known*` factories and the walrus committee**: the `KnownDeployments`
registry now carries real values sourced from the upstream SDKs for deepbook testnet/mainnet, walrus
testnet/mainnet (`systemObjectId` + `stakingPoolId` + aggregator/publisher URLs, plus testnet
`exchangeIds`), and seal testnet (`keyServerObjectId` + `keyServerUrl` for the Mysten
`mysten-testnet-1` Open-mode server). `subsidiesPackageId` is `undefined` on both walrus networks —
the `@mysten/walrus` SDK doesn't pin one, and typical blob consumers never need it. The walrus
storage-node committee is _not_ statically registered: testnet has 100+ nodes and the upstream SDK
fetches them dynamically from the staking pool, so `walrusKnownDeployment({ network })` throws at
factory time unless you supply `nodes: [...]` explicitly. For local testing, use
`walrusLocalCluster()` instead. Seal mainnet is intentionally absent — Mysten only offers mainnet
seal via Enoki signup; no public default to pin. The seal BLS public key is also intentionally not
in the registry: the `@mysten/seal` client retrieves it dynamically from
`<keyServerUrl>/v1/service`.

```ts
walrusKnownDeployment({ network: 'testnet', nodes: [...] }); // production
walrusLocalCluster();                                        // local testing
```

| Service        | Factories                                                             | Interface tags (yield to consume)                                            |
| -------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Sui            | `suiLocalnet`, `suiTestnet`, `suiMainnet`, `suiCustom`                | `Sui`                                                                        |
| Accounts       | `accounts({ name: { from: ... } })`                                   | per-account tag satisfies `AccountShape`                                     |
| Move package   | `publishMove({ name, path, signer })`                                 | per-name tag satisfies `LocalPackage` (extends `Package`)                    |
| Coin           | `publishMove({ coins: [...] })` shorthand, or `registerCoin({ ... })` | per-name tag satisfies `Coin`                                                |
| Deepbook       | `deepbookLocalDeploy`, `deepbookKnownPackage`                         | `DeepbookCore`; local-only adds `DeepbookAdmin`, `DeepbookMarketMaker`       |
| Walrus         | `walrusLocalCluster`, `walrusKnownDeployment`                         | `WalrusNetwork`, `WalrusNodes`; local-only adds `WalrusProxy`, `WalrusAdmin` |
| Seal           | `sealLocalKeygen`, `sealKnownKeyServer`                               | `SealKeyServer`; local-only adds `SealKeyManager`                            |
| DeepBook maker | `deepbookMarketMaker`                                                 | per-name tag carrying `DeepbookMarketMakerHandle`                            |
| Bindings       | `bindings({ packages, output })`                                      | codegen output (no runtime tag)                                              |
| Manifest       | `manifest({ extras? })`                                               | sidecar `.devstack/manifest.json` (no runtime tag)                           |
| Wallet app     | `walletApp({ name, accounts })`                                       | HTTP server + dev-wallet panels                                              |
| Generic        | `dockerContainer`, `hostProcess`, `tx`, `action`                      | escape hatches for one-off containers / processes / transactions / effects   |

Each primitive's canonical reference is `src/primitives/<name>.ts` — the file header documents
options, defaults, and the resulting tag shape.

### `manifest` extras

`manifest({ extras })` accepts three shapes — reach for the simplest one that fits.

```ts
// Static — no upstream deps.
manifest({ extras: { appName: 'arena', startedAt: Date.now() } });

// One-off function — runs once at acquire time.
manifest({ extras: () => ({ buildId: crypto.randomUUID() }) });

// Effect — yields tag values from upstream stack members.
manifest({
	extras: Effect.gen(function* () {
		const r = yield* openLobby;
		const lobbyId = pickCreatedByTypeSuffix(r.objectChanges, '::game::Lobby');
		return lobbyId === undefined ? {} : { lobbyId };
	}),
});
```

## Interface tags

Every multi-impl primitive produces a `Layer` for one of the canonical tags in `src/interfaces/`.
Consumers depend on the tag, not the factory:

```ts
import { Effect } from 'effect';
import { Sui } from '@mysten-incubation/devstack';

const showChain = Effect.gen(function* () {
	const sui = yield* Sui;
	yield* Effect.log(`${sui.network} ${sui.chainId}`);
});
```

The same `showChain` runs under `provideDevstack([suiLocalnet()])`,
`provideDevstack([suiTestnet()])`, or `provideDevstack([suiCustom({ rpcUrl, chainId })])`. That
orthogonality is the whole point of the interface/impl split — domain logic stays factory-agnostic.

Refined interfaces (`LocalPackage extends Package`, `WalrusAdmin`, `SealKeyManager`,
`DeepbookAdmin`) carry capabilities that are only meaningful when you boot the service locally.
Consumers that need admin power yield the refined tag; portable consumers yield the base.

### Using values with `@mysten/walrus` / `@mysten/seal`

Values yielded from `WalrusNetwork` and `SealKeyServer` pass directly to the upstream SDK
constructors — no shape conversion at the call site:

```ts
import { Effect } from 'effect';
import { Sui, WalrusNetwork, SealKeyServer } from '@mysten-incubation/devstack';
import { WalrusClient } from '@mysten/walrus';
import { SealClient } from '@mysten/seal';

const program = Effect.gen(function* () {
	const sui = yield* Sui;
	const walrus = yield* WalrusNetwork;
	const seal = yield* SealKeyServer;

	const walrusClient = new WalrusClient({
		suiClient: sui.client,
		packageConfig: walrus.packageConfig,
	});
	const sealClient = new SealClient({
		suiClient: sui.client,
		serverConfigs: seal.serverConfigs,
	});
	// ...
});
```

Both the local (`walrusLocalCluster`, `sealLocalKeygen`) and known (`walrusKnownDeployment`,
`sealKnownKeyServer`) factories surface the same SDK-ready shape. `@mysten/walrus` + `@mysten/seal`
are peer deps of the consumer app, not of `devstack` — install the version you need
separately.

### Using values with `@mysten/deepbook-v3`

`DeepbookCore.packageIds` is the SCREAMING_SNAKE_CASE projection `DeepBookClient` consumes verbatim.
`Coin.sdkCoin` (and every entry in `@mysten-incubation/devstack`'s coin records) mirrors the
SDK's `Coin` shape (`{address, type, scalar}`):

```ts
import { Effect } from 'effect';
import { Sui, DeepbookCore, Coin } from '@mysten-incubation/devstack';
import { DeepBookClient } from '@mysten/deepbook-v3';

const program = Effect.gen(function* () {
	const sui = yield* Sui;
	const dbk = yield* DeepbookCore;

	const client = new DeepBookClient({
		client: sui.client,
		address: '0xMY_ADDRESS',
		// SDK-ready — pass `packageIds` through with no shape conversion.
		packageIds: dbk.packageIds,
	});
	// ...
});
```

`deepbookLocalDeploy` populates `DEEPBOOK_PACKAGE_ID` / `REGISTRY_ID` from the just-published Move
package; `DEEP_TREASURY_ID` / `MARGIN_*` / `LIQUIDATION_*` stay empty / undefined because we don't
deploy those locally. `deepbookKnownPackage({network: 'testnet' | 'mainnet'})` pulls every id (plus
the canonical `coins` / `pools` / `marginPools` / `pyth` maps) from the registry in
`src/internal/known-deployments.ts`. The registry's snapshots are minimal; consumers that need
additional coins or pools can import the full `testnet*` / `mainnet*` constants from
`@mysten/deepbook-v3` directly.

## Subpath exports

| Subpath           | When to import it                                                                |
| ----------------- | -------------------------------------------------------------------------------- |
| `.`               | Configs and Effect programs — primitives + `defineDevstack` + `provideDevstack`. |
| `./plugin-author` | Building new primitives — `provideTag`, `dockerImage`, `gitFetch`, registries.   |
| `./vitest`        | `withDevstack(devstack)` — binds the layer to `@effect/vitest`'s `it.layer`.     |
| `./playwright`    | `setupDevstack(devstack)` — wires into `globalSetup` / `globalTeardown`.         |
| `./dapp-kit`      | `createDevstackDappKit`, localnet dapp-kit + walrus config helpers.              |

`@mysten/dapp-kit-*` and `@mysten-incubation/dev-wallet*` are optional peer deps — the rest of the
package stays usable without them.

**Peer dependencies**: the `./vitest`, `./playwright`, and `./dapp-kit` subpaths require
`@effect/vitest`, `@playwright/test`, and `@mysten/dapp-kit-core` / `@mysten/dapp-kit-react`
respectively. They're declared as optional peer deps — your project needs to install them explicitly
if you use the corresponding subpath.

## CLI

Bundled bin: `devstack` (built to `dist/cli/main.mjs`). Commands:

- `up [config-path]` — load `devstack.config.ts` (default `./devstack.config.ts`) and launch the
  stack.
- `apply` — reconcile target state against the running stack.
- `status` — dump the current acquired state of every stack member.
- `snapshot` — write a snapshot of the on-chain state for replay.
- `wipe` — tear down containers and clear `.devstack/`.
- `stack` — multi-stack management (list, switch, prune).
- `doctor` — preflight checks (Docker reachable, ports free, ...).
- `manifest` — dump or re-emit the manifest sidecar.

Built on `effect/unstable/cli` — unstable in v4 beta, expect minor drift.

The `--renderer tui|plain|silent` flag overrides the renderer pick. `tui` is the default when stdout
is a TTY; `plain` otherwise (CI, piped output).

### TUI layout and keybinds

The TUI uses the terminal's alternate screen buffer (no scrollback pollution — your prompt is back
exactly as you left it on exit) and splits the viewport into two regions:

```
┌──────────────────────────────────────────────────────────────────┐
│  13:42:01 INFO  acquiring sui (docker pull)                      │  ← log region
│  13:42:03 INFO  sui ready on http://127.0.0.1:9000               │     (streams latest at bottom)
│  ...                                                             │
│                                                                  │
│  devstack — live status                                          │  ← dashboard
│  ──────────────────────────                                      │     (pinned to bottom)
│  Services                                                        │
│    sui localnet      http://127.0.0.1:9000        ready          │
│    wallet            http://127.0.0.1:5180/?...   ready          │
│    dev-server        http://127.0.0.1:5180        acquiring      │
│                                                                  │
│  Actions                                                         │
│    publish hello     0xabc…123                    done           │
│    account alice     0x999…001                    done           │
│    tx mint-greeting  digest 0xdef…                done           │
│                                                                  │
│  [r]estart  [q]uit  Ctrl-C to exit                               │
└──────────────────────────────────────────────────────────────────┘
```

The dashboard organises rows around the user's mental model rather than
the engine's internal tag identifiers:

- **Services** — long-running daemons you can connect to. The row's
  primary cell is the URL/socket you'd hit (`sui.rpcUrl`,
  `walletApp.pairUrl`, `walrus.aggregatorUrl`, `hostProcess.endpoint`).
- **Actions** — one-shot work that produces an artifact. The primary
  cell is the artifact (`publishMove → packageId`, `accounts → address`,
  `tx → digest`, `bindings → output path`). Status reads as `done` once
  complete.
- **Other** — fallback section, only rendered when a primitive is
  unclassified (rare; hand-rolled layers without `provideTag`'s
  `{kind, display}` knobs).

Each primitive declares its kind + display projection at `provideTag` /
`makeTag` time so the dashboard shows the URL or artifact you care about
the moment the build completes.

Keybinds (single-character, no Enter required):

- **`r`** / **`R`** — hot-restart the stack (same path as a file-watcher event).
- **`q`** / **`Q`** — clean shutdown (re-emits SIGINT through NodeRuntime so finalizers run).
- **Ctrl-C** — SIGINT, same clean shutdown as `q`.

While the TUI is running, `Effect.log*` calls flow into the engine's bounded log buffer and render
in the log region — they don't race the frame writes onto stdout. In `plain` / `silent` modes the
default logger keeps writing to stderr so log aggregators see the same stream.

**Container scoping**: All containers spawned by devstack are named `dvst.{app}.{stack}.{name}` and
labelled `com.docker.compose.project=dvst.{app}.{stack}`, so Docker Desktop groups them. Orphans
from prior runs are auto-cleaned on startup.

### When a primitive fails

If a primitive's acquire fails (e.g. Docker `pull-access-denied`, port conflict, missing tool on
`PATH`), the failure shows in the TUI's status panel as a red `failed` row and the error message
appears in the log section. The TUI stays up — press `r` to retry the full stack, or `Ctrl-C` to
shut down.

The renderer attaches BEFORE `Layer.build` runs the user stack, so even a failure on the very first
primitive (a common shape with Docker hiccups) surfaces in the TUI instead of leaking onto stdout as
a fatal crash. Per-primitive failures are caught at the layer wrap so the TUI state reflects the
failure before the user stack tears down; cascading failures from downstream consumers
(`ServiceNotFound` on the failed tag) also surface as `failed` rows.

### Hot-restart

When `defineDevstack({ watch: [...] })` is set, file changes (debounced 250ms) tear down the running
stack and re-launch it from scratch. Disable with `hotRestart: false` to keep watching without
restarting.

Manual triggers:

- **TUI**: press `r` in the running terminal.
- **Signal**: `kill -USR2 <pid>`.

Both paths run the same teardown + rebuild loop. `Ctrl-C` / `SIGINT` tears down for good.

**Caveat**: hot-restart tears down the entire devstack scope and rebuilds it. If your
`devstack.config.ts` has a primitive that spawns long-running background work (e.g. an indexer cron,
a websocket server), that work is interrupted on each file-change restart. Hot-restart is designed
for dev iteration, not production-stable services — production usage should set `hotRestart: false`
(or omit `watch:`).

## Plugin authoring

See [`PLUGIN-AUTHORING.md`](./PLUGIN-AUTHORING.md) for the walkthrough. Short version: define an
interface tag (`Context.Service` class + shape), write a primary impl with
`provideTag(InterfaceTag, build)`, optionally add a `Known*` factory that does `Layer.succeed` from
config/registry. Re-export from `./plugin-author` if you're contributing back.

## Status

`@mysten-incubation/devstack` is **incubation-stage** — `private: true` in this monorepo,
consumed via `workspace:*`. We're battle-testing the Effect v4 interface-driven design against
`examples/wallet`, `examples/arena`, etc. Public npm release is gated on Effect v4 GA (no firm date
yet — see https://github.com/Effect-TS/effect for upstream tracking).

Until then, vendored consumption via `workspace:*` or `pnpm patch` is the supported path. Expect API
churn on the `examples/` integrations before GA; primitive-author surface (`provideTag`, the
interface tags) is more stable. Friction and known rough edges land in
[`notes/friction.md`](./notes/friction.md) rather than papering over them in code.

### Effect v4 beta

This package depends on Effect v4 (still in beta). Effect's pre-1.0 betas have shipped occasional
minor breaking changes; pinning `effect@<exact-beta-version>` in your lockfile is recommended until
Effect ships GA. We bump on each Effect beta — see CHANGELOG for which versions a given release
tracks.

## Repo pointers

- [`AGENTS.md`](./AGENTS.md) — conventions, v4-specific module locations, Effect patterns.
- [`notes/friction.md`](./notes/friction.md) — capture rough edges here.
- [`repos/effect-v4/`](../../repos/effect-v4/) — vendored Effect v4 source (read-only reference;
  grep when docs are stale).
- [`packages/devstack/`](../devstack/) — the v3 package this is porting from.
