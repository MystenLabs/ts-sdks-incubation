# `@mysten-incubation/devstack`

A declarative reconciler and plugin harness for fully-seeded Sui local
development. Brings up sui-localnet (plus optional walrus, seal, deepbook),
publishes Move packages, runs codegen, and writes a typed manifest the
frontend consumes. The same `devstack.config.ts` drives localnet, testnet,
and mainnet — live nets skip Service / HostProcess actions but keep
Build / Publish / Register / Seed / Emit / Verify.

## Status

Initial release (0.1.0). The public API will follow semver — breaking
changes land at minor-version boundaries.

## Before you start

- **Node.js 24+.** devstack relies on Node's native TypeScript stripping to
  load `devstack.config.ts` directly — older Node throws
  `ERR_UNKNOWN_FILE_EXTENSION` on the config import.
- **Docker.** Required for localnet (sui-localnet, walrus, seal containers).
  The `devstack doctor` preflight reports a clear error if the daemon isn't
  reachable.
- **`pnpm create @mysten-incubation/devstack-app <name>`** — recommended
  starting point. Scaffolds a working app from the canonical template
  (`packages/create-devstack-app/`). Want to vendor the template by hand
  instead? Copy `examples/_template/` and follow the steps in its README.

## 30-second example

```ts
// devstack.config.ts
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	accounts,
	codegen,
	defineDevstackConfig,
	frontend,
	publishMove,
	runTransaction,
	sui,
	walletApp,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));

export default defineDevstackConfig({
	app: 'hello',
	accounts: ['alice', 'bob'],
	use: [
		sui(),
		accounts(),
		codegen(),
		walletApp(),
		frontend(),
		publishMove({
			name: 'hello',
			path: resolve(HERE, 'move/hello'),
			publisher: 'alice',
		}),
		runTransaction({
			name: 'mint-greeting',
			needs: ['hello'],
			signer: 'alice',
			build: (ctx, tx) => {
				const pkg = ctx.registry.packages.require('hello');
				tx.moveCall({
					target: `${pkg.packageId}::hello::mint`,
					arguments: [
						tx.pure.vector('u8', Array.from(new TextEncoder().encode('hi'))),
					],
				});
			},
		}),
	],
});
```

```jsonc
// package.json (excerpt)
{
	"scripts": {
		"dev": "devstack up",
		"apply": "devstack apply",
		"codegen": "devstack codegen",
		"deploy:testnet": "devstack apply --target testnet",
		"deploy:mainnet": "devstack apply --target mainnet",
		"stack": "devstack stack",
	},
}
```

`pnpm dev` brings up sui-localnet, funds accounts, publishes `move/hello`,
regenerates codegen bindings, fires `mint-greeting` once, and starts the
Vite dev server — all in one log stream. Re-runs short-circuit through
each action's `getStatus` skip predicate.

Requires Node.js 24+ (native TypeScript stripping — no tsx, no pre-build
of the config) and Docker.

`publisher:` is a literal account name. `publishMove` defaults `publisher`
to the literal account `'publisher'` — either declare it in `accounts:`
(e.g. `accounts: ['publisher', 'alice']`) or override per-action
(`publishMove({ publisher: 'alice' })`, as the example does).

## Subpath imports

| Subpath                                      | For                                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `@mysten-incubation/devstack`                | App authors — `defineDevstackConfig`, plugin factories, setup-action factories, registry types.                               |
| `@mysten-incubation/devstack/helpers`        | Side helpers (`createLocalSuiClient`, `cliSigner`, `envSigner`, `generatedKeypair`).                                          |
| `@mysten-incubation/devstack/react`          | React adapter — `createDevstackDappKit` factory + `localnetWalrusOptions`.                                                    |
| `@mysten-incubation/devstack/vitest`         | Vitest config builder.                                                                                                        |
| `@mysten-incubation/devstack/vitest/runtime` | Test-side: `AccountPool`, session helpers.                                                                                    |
| `@mysten-incubation/devstack/playwright`     | Playwright config builder + fixtures + page helpers.                                                                          |
| `@mysten-incubation/devstack/authoring`      | Plugin authors — `definePlugin` + raw action factories (`service`, `containerService`, `buildImage`, `hostProcess`, `publish`, `register`, `emit`, `verify`). App authors should NOT use this. |

## Built-in plugins

- `sui()` — Sui localnet container. Provides `sui.build`, `sui.indexer-db`, `sui.localnet`.
- `walrus()` — Walrus testbed (4-node committee, 100 shards). First build ~9–10 min; bumps ~1–2 min via BuildKit cache mounts.
- `seal()` — Seal key-server in Open mode. Pulls release binaries (~30 s, no compile).
- `deepbook({ pools, marketMakers })` — DeepBookV3 publish + pool init + optional grid market-maker hostprocesses.
- `accounts()` — Account funding action (`accounts.fund`) over the `sui` faucet.
- `codegen()` — Runs `@mysten/codegen`'s `generateFromPackageSummary` over every published package.
- `frontend()` — Vite dev-server hostprocess. Default port 5173.
- `walletApp()` — In-process HTTP signer endpoint (default port 9420) the dev-wallet adapter calls. Keys never enter the frontend bundle.
- `imports({ packages })` — Recursive Move-package imports from git or local paths. Per package: a Build (content-addressed source image) + a Publish action.

### `walletApp` (server) + `createDevstackDappKit` (browser)

The server-side plugin `walletApp` (from the main barrel) and the
browser-side factory `createDevstackDappKit` (from `/react`) form a
paired contract. The plugin runs an HTTP signer endpoint inside the
supervisor (default port 9420). The factory wires up dapp-kit + the
burner-wallet adapter pointed at that server, and (under `mountUI:
true`, the default) mounts the Faucet / Packages / Network panels.
Most apps import both — the plugin in `devstack.config.ts` and the
factory in `src/dapp-kit.ts`.

### Token references — `@reg/<name>`

Plugin specs that need to reference a coin published elsewhere in the
config accept the literal string `@reg/<name>` and resolve it at run
time against `coinTokens(registry).find(name).type`. The deepbook
plugin's `pools:` is the canonical consumer:

```ts
deepbook({
  pools: [
    {
      base: '@reg/deep',         // resolves to deepbook's own DEEP coin
      quote: '@reg/musdc',       // resolves to whatever publishMove({...}) +
                                 // registerCoin({ name: 'musdc', ... }) registered
      // ...
    },
  ],
}),
```

The spec is unresolved at config-load time — `@reg/musdc` is opaque
until the surrounding `use:[]` actually contains a matching
`registerCoin({ name: 'musdc', ... })`. The deepbook pool action's
`needs:` should list the matching `register-musdc` so the publish-and-
register fans out before the pool tx fires.

## Setup-action factories

Drop these directly into `use: [...]`. Each returns a typed `Action`.

- `publishMove({ name, path, publisher?, capture?, registryAs? })` — build + publish + register a Move package. Captures created objects by type-suffix into `registry.packages.<name>.captured`.
- `registerCoin({ from, module, type, decimals })` — typed follow-on for the common "publish coin → register in `coin.tokens` namespace" pattern.
- `seed({ name, run, getStatus?, inputs?, runsAs?, networks? })` — generic post-publish seeding. Localnet-only by default; opt into live nets via `networks: ['testnet']`.
- `runTransaction({ name, signer, build, getStatus? })` — fire a single transaction, idempotent via persisted reconciler state keyed by the input hash.

`register()` (from `/authoring`) has the same default as `seed()` —
opt into live nets via `networks: ['localnet', 'testnet', 'mainnet']`
if your custom register action should run on testnet/mainnet. Most
register flows wire dev-only bootstraps (key-server registration,
walrus deploy, faucet-fund follow-ons), so the safe default is the
conservative one — silent live-net fan-out is rarely intended.

## CLI

```
devstack up [config]                  Long-running supervisor (localnet only)
devstack apply [config] [--target]    Single-cycle reconcile against active stack or a target
devstack codegen [config] [--target]  Re-emit codegen against the prior manifest (read-only)
devstack status [config] [--target]   Print manifest action-graph state (read-only)
devstack doctor                       Preflight environment check
devstack down [config]                Stop a stack's containers; preserve volumes
devstack wipe [config] --yes          Wipe a stack — containers, volumes, host state
devstack stack list|new|use           Manage named per-app stacks
devstack snapshot save|restore|list|rm|id   Capture / restore named snapshots
devstack console [config] [--target]  REPL with manifest, client, accounts pre-bound
```

`--target` accepts `<network>`, `<stack>`, or `<network>:<stack>`:

- `devstack apply --target testnet` — bare network. Live network, full
  action graph minus Service / HostProcess.
- `devstack apply --target localnet:scratch` — explicit pair. Localnet
  with a specific named stack.
- `devstack apply --target scratch` — bare stack name (defaults network
  to localnet).

The supervisor (`up`) is localnet-only; live-network targets error with
a hint pointing at `apply`.

## Operations

Day-to-day commands beyond `up` / `apply`:

- **`devstack doctor`** — preflight check (docker daemon reachable, sui
  CLI present, Node version, inotify limits, manifest exists). Run it
  first when something's off; the supervisor's own preflight runs the
  same docker check, but `doctor` covers everything before you commit
  to a long cycle.
- **`devstack status [--target]`** — print the manifest's action-graph
  state without running a cycle. Read-only; no docker / RPC calls.
- **`devstack down [config]`** — stop a stack's containers but preserve
  its volumes and host state. Re-run `up` to resume from the same
  RocksDB / generated key material.
- **`devstack wipe [config] --yes`** — hard reset: containers, volumes,
  host state under `.devstack/stacks/<stack>/`, and (with `--images`)
  cached devstack-built images. Pair with `--dry-run` first to preview
  what would be deleted.
- **`devstack snapshot save <id>`** — capture the current stack as a
  named snapshot. Acquires the supervisor lock; if `devstack up` is
  running, save fails fast with "supervisor is running on stack '...'
  (PID ...). Stop it before saving." Pass `--dry-run` to preview the
  capture without acting (works with `--json` for CI consumption).

### Removing an action

Removing a setup action from `use:` (e.g. deleting a `publishMove` or
`runTransaction`) is not destructive — devstack will not undo what's
already on chain (Move packages are immutable). But the orphaned state
lingers:

- Codegen drops the per-package bindings on the next `apply` (good).
- The manifest's `actionStates` keeps the removed action's
  input-hash and last-run timestamp until the next manifest write
  overwrites it.
- Generated keypairs in `<appDir>/.devstack/stacks/<stack>/.keys/`
  stay on disk if the matching account was also removed from
  `accounts:`.
- Cached docker images for any plugin you removed stay in your local
  docker store.

For a clean slate after structural removal:

```sh
devstack wipe --yes              # this stack
devstack wipe --yes --images     # this stack + all cached devstack images (GLOBAL)
```

Re-adding an action with the same name as one you previously removed
reuses the persisted `actionStates` entry as the warm-path baseline.
If the inputs are byte-identical (same hash), the reconciler short-
circuits via `getStatus` (or directly, if no `getStatus` is defined) —
fine for an identical re-add. If the new action is structurally
different, the input hash mismatches and the action runs as a fresh
cycle. When in doubt, run `devstack wipe --yes` first so re-added
actions start from a clean baseline.

### Where logs go

- **Supervisor banner + status panel.** The renderer prints to stdout —
  the same stream as the rest of the CLI. There is no per-action log
  file on disk today; everything an action emits surfaces in the same
  combined stream as the supervisor.
- **Action `ctx.appendLog(...)`.** Plugin callbacks call `appendLog`
  inside `run()` / `getStatus()` to emit named log lines. The active
  renderer routes them — the TUI/plain renderer interleaves them with
  the live action-graph block; one-shot CLI paths forward them straight
  to `process.stdout`.
- **Container logs (sui-localnet, walrus, seal, etc.)** are owned by the
  Docker daemon and read via `docker logs <container>` (or
  `docker logs -f` to tail). Container names follow the pattern
  `<app>-<stack>-<service>` — `docker ps --filter label=devstack.app=<app>`
  lists the active set for a given app.

### Going to live nets

Apps declare per-network signers in `accounts: { ... }` and run
`devstack apply --target testnet|mainnet`. Localnet uses an implicit
`generatedKeypair()` factory if no slot is filled; live nets require an
explicit factory.

A typical testnet deploy goes like this:

1. Tell devstack which RPC to point at via `networks:` and add the
   per-network signing material under `accounts:`. The empty `{}` form
   is fine for accounts that only run on localnet — only the live-net
   slots need explicit factories.

   ```ts
   export default defineDevstackConfig({
   	app: 'hello',
   	networks: {
   		testnet: 'https://fullnode.testnet.sui.io:443',
   	},
   	accounts: {
   		publisher: {
   			testnet: cliSigner({ alias: 'release' }),
   			mainnet: envSigner({ name: 'MAINNET_PUBLISHER_KEY' }),
   		},
   	},
   	use: [/* ... */],
   });
   ```

2. Make sure `cliSigner({ alias: 'release' })` will resolve. The factory
   reads `~/.sui/sui_config/sui.aliases` to map the alias to a key in
   `~/.sui/sui_config/sui.keystore` — you switch to the alias once
   (`sui client switch --alias release`), and devstack picks up the same
   key on every run. `envSigner({ name })` reads the env var as
   `suiprivkey1...` material; CI workflows wire that through their secret
   store.

   > If your alias's address has no testnet gas, run `sui client faucet` first. Mainnet has no faucet — fund the address out of band.

3. `pnpm exec devstack apply --target testnet`. Build / Publish /
   Register / Seed (network-gated) / Emit / Verify run; Service +
   HostProcess are skipped (no docker daemon assumed on testnet).
   The resulting manifest lands at
   `<appDir>/.devstack/manifests/testnet.json`, separate from the
   localnet stack manifests under `.devstack/stacks/<stack>/`.

4. Sanity-check the deploy from the REPL:
   `pnpm exec devstack console --target testnet` — drops you into a
   Node REPL with `manifest`, `client`, and `accounts` pre-bound, so
   you can poke at the published packages or query on-chain state.

#### Production builds

> **Important**: the manifest contains a dev-time bearer token used by
> the server-side `walletApp()` plugin. Vite bakes the manifest into
> production builds, so a `pnpm build` after
> `devstack apply --target testnet` produces a bundle that ships the
> token. The token is dev-only — it authorizes transaction signing
> against the supervisor, which only runs on the developer's laptop —
> but it shouldn't end up on a public CDN.
>
> The codegen-emitted `src/generated/manifest.ts` is gitignored by
> default to prevent the dev-time bearer token from landing in git
> history. Apps regenerate the file locally via `devstack apply` —
> after cloning a devstack app, run `devstack apply` (or `pnpm dev`,
> which calls it) before `pnpm build` so the manifest exists.
>
> For production deploys to live nets:
>
> - Pass `mountUI: false` to
>   `createDevstackDappKit({ manifest, mountUI: false })` from `/react`
>   so the dev-wallet floating UI doesn't render. With `mountUI: false`
>   the panels module is not loaded, so production bundles drop the
>   panels code entirely (~30KB).
> - Better, use a separate `dapp-kit.ts` for production that swaps the
>   dev-wallet adapter for a real wallet (Slush, Suiet, etc.) and only
>   reads the live-net manifest fields the app actually needs.
>
> Tracked as a known limitation; the proper fix (per-session tokens
> written to `<stackDir>` rather than the manifest, gated by a
> production-mode flag) is on the post-0.1.0 roadmap.

For Ledger / KMS / vault factories, write your own matching the
`AccountFactory` contract (`(ctx) => Signer | Promise<Signer>`). See the
"Custom factory pattern" section in `helpers/signers.ts` for an
illustrative Ledger example.

## Image cache

Built images carry the label `devstack.cache=<kind>` and are tagged
`mysten-devstack/<name>:<rev>`. Successful rebuilds GC superseded tags
automatically (pinning a new `version:` triggers the new build to drop the
prior tag once it lands; in-use tags are kept). To force a full first-build
re-test:

```sh
devstack wipe --yes --images          # drops cached devstack-built images (GLOBAL)
devstack wipe --yes --images --dry-run # preview only
```

`--images` is global — it affects all apps sharing the docker engine. Pair
with `--dry-run` first.

## Networking

Every Docker `--publish` defaults to `127.0.0.1:` — sui-localnet RPC,
faucet, GraphQL, the seal key-server, walrus storage nodes, and walletApp
are reachable only from the developer's machine. Other devices on the same
LAN can't hit them. The default is deliberate: a localnet faucet on a
laptop in a coffee shop should not mint dev SUI for arbitrary strangers.

## Testing

Two test config builders. Both are config-load-time only and don't pull
the runtime into your test files.

```ts
// vitest.config.ts
import { defineDevstackVitestConfig } from '@mysten-incubation/devstack/vitest';

export default defineDevstackVitestConfig({ chain: true });
```

```ts
// playwright.config.ts
import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

export default await defineDevstackPlaywrightConfig({
	port: 5180,
	manageStack: true, // bring up + tear down a `test` stack hermetically
});
```

The `playwright` subpath also exports `connectAs` / `selectAccount` /
`waitForBalanceUpdate` page helpers and an `AccountPool` fixture
(`pool` session-scoped, `account` per-test).

#### `manageStack: true` lifecycle

- **Stack name** defaults to `'test'`. Override via the `DEVSTACK_STACK`
  env var (e.g. `DEVSTACK_STACK=ci-shard-2 pnpm test:e2e`); the same name
  is consumed by both globalSetup and globalTeardown.
- **globalSetup** brings the stack up (`runOneShot` with the test-setup
  filter — Build / Publish / Register / Seed / Emit / Verify run, Service
  containers start and detach, HostProcess actions stay off so the
  Playwright `webServer`'s `pnpm dev` Supervisor owns them) before any
  test file runs.
- **globalTeardown** runs after all tests finish, regardless of
  pass/fail. Disposition is configurable via the typed `teardown:` opt
  on `defineDevstackPlaywrightConfig` or the `DEVSTACK_E2E_TEARDOWN` env
  var:
  - `'down'` (default) — stop containers, preserve volumes (resumable).
  - `'drop'` — full wipe (containers, volumes, host state). CI mode.
  - `'none'` — leave the stack running for post-mortem debugging.

#### A test using `connectAs`

```ts
import { connectAs, expect, test } from '@mysten-incubation/devstack/playwright';

test('alice can sign a transaction', async ({ page }) => {
	await page.goto('/');
	await connectAs(page, 'alice');

	const balance = page.getByTestId('balance-alice-mycoin');
	const before = (await balance.textContent()) ?? '';

	await page.getByRole('button', { name: 'Mint 1' }).click();
	await expect(balance).not.toHaveText(before, { timeout: 15_000 });
});
```

> **Prereq**: `connectAs` reads the dapp-kit instance from
> `globalThis.__devstackDAppKit__`. The `createDevstackDappKit` factory
> from `@mysten-incubation/devstack/react` exposes it under DEV (vite
> dev server). If your app wires dapp-kit manually (without
> `createDevstackDappKit` from `/react`), set
> `globalThis.__devstackDAppKit__ = dAppKit` in your dev-time entry
> point.

`test` and `expect` come from the playwright subpath rather than
`@playwright/test` so the `pool` (session-scoped) and `account`
(per-test, leased from the pool) fixtures are available — useful when
a test needs an unrelated keypair separate from the named
`'alice' / 'publisher' / ...` wallets `connectAs` operates on.

For a fuller, real-world worked example, see
[`examples/wallet/e2e/panels.spec.ts`](https://github.com/MystenLabs/ts-sdks-incubation/blob/main/examples/wallet/e2e/panels.spec.ts).

## Architecture

The runtime is a declarative reconciler over an action graph. A plugin
contributes named actions of one of eight kinds (Build, Service,
HostProcess, Publish, Register, Seed, Emit, Verify). Each action declares
`needs: string[]` for ordering, `provides: { capabilities?, registry? }`
for capability declarations and a registry-rehydrate hook the reconciler
invokes on warm-path skips, plus `getStatus?(ctx)` — a probe that returns
`{ ok: true }` when the action's effect is already in place. The
reconciler hydrates the registry from the prior manifest, topo-sorts
actions (Kahn, stable tie-break, capability synthesis from `provides` ↔
`needs: ['cap:before']`), runs or skips each action, and writes the new
manifest.

For depth, see [`docs/devstack-design.md`](docs/devstack-design.md).

## Known limitations

- **Walrus 1.48.0 storage-node TLS panic.** The `private-content`
  example's end-to-end blob upload doesn't work on the current default
  `walrus({ version: 'devnet-v1.48.0' })`. Other walrus-using flows
  (read, registration, deploy outputs) work. Resolved by upstream's
  `devnet-v1.49.0`; bump the `version:` opt once it ships.
- **Bearer token in development manifest.** `devstack apply` emits a
  bearer token into `src/generated/manifest.ts` for the `walletApp`
  HTTP signer endpoint. The file is gitignored by default. Don't
  deploy a devstack-built bundle to a public URL until the
  token-rotation work lands — the dev-only token authorizes signing
  against the supervisor.
- **Post-clone `devstack apply` required.** The codegen-emitted
  `src/generated/manifest.ts` is gitignored, so a fresh clone needs
  `devstack apply` (or `pnpm dev`) before `pnpm build` succeeds.

## Writing your own plugin

Third-party plugins import from `@mysten-incubation/devstack/authoring`,
which exposes `definePlugin`, the raw action factories (`buildImage`,
`service`, `containerService`, `hostProcess`, `publish`, `register`,
`emit`, `verify`), the `requireLocalnetCtx` narrowing helper, and the
docker primitives a `containerService(spec)` callback typically reaches
for (`runContainer`, `appNetworkName`, `devstackContainerLabels`,
`requireDockerDaemon`, …).

For the full shape, see [`docs/devstack-design.md`](docs/devstack-design.md).
