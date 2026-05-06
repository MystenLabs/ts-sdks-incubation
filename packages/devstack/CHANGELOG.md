# Changelog

## 1.0.0 — Initial release

First public release. The package surface is small by design — only the
authoring symbols `examples/*` import are re-exported from the main
barrel. Plugin-authoring primitives (the raw `service` / `containerService`
/ `hostProcess` / `buildImage` / `register` / `emit` factories,
`definePlugin`) live on their source files but are not re-exported until
a consumer materializes.

### Surface

- **Main barrel `@mysten-incubation/devstack`** — `defineDevstackConfig`,
  `defineRegistryKind`, `coinTokens`, the action factories app code
  reaches for (`publishMove`, `seed`, `runTransaction`,
  `mintCoinDistribution`), and the built-in plugins (`sui`, `walrus`,
  `seal`, `accounts`, `codegen`, `imports`, `frontend`, `walletServer`,
  `deepbook`).
- **`/app-setup`** — `createWalletApp({ manifest })`, one-line dapp-kit
  bootstrap with the devstack burner-wallet adapter and panels.
- **`/helpers`** — `createLocalSuiClient`, `seedSharedObject`. Used by
  `setup:` action callbacks.
- **`/react`** — `DevstackProvider`, `useDevstackDeployed`,
  `useSignAndExecute`, `localnetDappKitConfig`, `localnetMvrOverrides`,
  `localnetWalrusOptions`.
- **`/react/ui`** — `Card`, `Field`. Tailwind-classed primitives shared
  across the example apps.
- **`/vite`** — `devstackVitePlugins`, `devstackManifestPlugin`. Provides
  the `virtual:devstack-manifest` virtual module that resolves to the
  active stack's manifest.
- **`/playwright`** — `defineDevstackPlaywrightConfig({ manageStack })`,
  `connectAs`, `selectAccount`, `waitForBalanceUpdate`, `test`, `expect`.
- **`/vitest`, `/vitest/runtime`** — `defineDevstackVitestConfig`,
  `AccountPool`, `getSessionAccountPool`. Chain-aware test integration.
- **`/manifest`** — ambient `Manifest` type for `.d.ts`-only consumption.

### Authoring contract

- `Plugin.actions: () => Action[]`. Bare action names auto-prefix with
  the plugin namespace (`'connect_four'` → `'arena.connect_four'`); bare
  `needs:` resolve locally; dotted needs cross plugins; `:before`
  suffixes hit the capability table.
- `provides: { capabilities?, registry? }` declares both capability
  providers and a per-cycle registry-population hook.
- Plugin name regex `/^[a-z][a-z0-9_-]*$/`. Action names are
  unconstrained.
- Top-level `accounts: { name: AccountSpec, ... }` in
  `defineDevstackConfig`. Empty `{}` gets a per-stack generated keypair
  on disk; per-network slots (`{ testnet: cliSigner({...}) }`) override
  for live deploys.
- `ctx.accounts.get(name): Signer` is the per-action signer accessor.
- `ActionRunContext = LocalnetActionRunContext | LiveNetActionRunContext`,
  discriminated on `ctx.network`. The localnet variant carries `stack`
  and `ports`; live-net does not. `requireLocalnetCtx(ctx)` narrows.

### CLI

- `devstack up [config]` — long-running supervisor with file watcher and
  per-cycle reconcile.
- `devstack apply [config]` — single-cycle reconcile.
- `devstack deploy [config] --target <network[:stack]>` — apply against a
  named target.
- `devstack codegen [config]` — Emit-only cycle (writes `manifest.ts`,
  binding directories, etc.).
- `devstack console [config]` — REPL with `.deploy`, `.tx`, `.balance`.
- `devstack snapshot save|restore|list|rm|hash [name]` — bundle
  `<stackDir>` + container fs into a content-addressed snapshot.
- `devstack stack new|use|list|rm|down|drop` — per-app named stacks.
- `devstack down`, `devstack reset --yes` — top-level shortcuts.

### Known limitations

These are documented in `notes/friction.md` and tracked for follow-up
releases:

- **Bearer-token leakage through the bundled manifest.** The
  `wallet-server` plugin writes the listener's bearer token into
  `endpointLabel` in the manifest, and Vite bakes that manifest into the
  production bundle. Devstack is dev-only — the bundle isn't supposed to
  leave the laptop — but `vite build` of a devstack project is not
  hardened against this leak. Don't host devstack-built bundles publicly.
- **Walrus binary distribution.** Until walrus `devnet-v1.49.0` lands, the
  walrus image cargo-builds three binaries from source (`walrus`,
  `walrus-node`, `walrus-deploy`). Cold first build ~9–10 min on
  M-series; ~1–2 min on version bumps via BuildKit cache mounts.
- **HostProcess pause/resume during snapshots.** Snapshots quiesce
  container-backed services but do not pause HostProcess actions
  (vite dev server, deepbook market-maker). State held purely in memory
  is fine; long-running file locks or in-flight transactions can race
  the snapshot capture.
- **Multi-instance plugins.** Two `imports()` calls in the same config
  collide on action namespacing. Workaround: a single `imports()` with
  every package in one `packages:` array.
