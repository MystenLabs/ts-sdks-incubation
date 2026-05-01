# Changelog

## 1.0.0 — 2026-04-30

First stable release. The v3 API refactor (`notes/api-refactor.md`) is now
landed end-to-end. All breaking changes from `1.0.0-rc.1` are listed below;
internal architecture (action graph, reconciler, registry, plugin model)
is unchanged.

### Breaking — plugin authoring contract

- **`Plugin.actions: () => Action[]`** — was `({ scope }) => Action[]`. Bare
  action names auto-prefix with the plugin namespace (`'connect_four'` →
  `'arena.connect_four'`). Bare `needs:` resolve locally; dotted needs
  cross plugins; `:before` / `:after` suffixes hit the capability table.
- **`provides: string[]`** replaces `before: string[]`. Capability queries
  (`needs: ['cap:before']`) are soft — silently dropped when no provider
  is loaded.
- **Plugin name regex tightened** to `/^[a-z][a-z0-9_-]*$/`. CamelCase
  plugin names are rejected. Action names are unconstrained.
- **`Plugin.schemas` removed** entirely. The field had no runtime reader.

### Breaking — accounts

- **Top-level `accounts: { name: AccountSpec, ... }`** in
  `defineDevstackConfig`. Replaces `sui({ accounts: [...] })`. Empty `{}`
  gets a per-stack generated keypair on disk; per-network slots
  (`{ testnet: cliSigner({...}) }`) override for live deploys.
- **`ctx.accounts.get(name): Signer`** replaces `ctx.signer`,
  `loadAccountKeypair`, and `ConsoleAccount.keypair`. `ctx.accounts.has`
  and `.names()` round out the API. `ctx.accounts` is required on every
  `ActionRunContext`.
- **`generatedKeypair()`** signer factory added — localnet-only; loads
  or creates `<stackDir>/.keys/<account>.key`.
- **`NetworkConfig.signer` removed** — now folded into per-network
  account slots.

### Breaking — discriminated context

- **`ActionRunContext = LocalnetActionRunContext | LiveNetActionRunContext`** —
  discriminated on `ctx.network`. The localnet variant carries `stack`;
  the live-net variant doesn't.
- **`requireLocalnetCtx(ctx)`** runtime narrowing helper — throws on
  testnet/mainnet with an actionable message.

### Breaking — public surface

- **Subpath-only exports.** `@mysten-incubation/devstack` is now the
  authoring surface only (types, action factories, plugins, signer
  factories). Runtime internals live on `/runtime`; CLI handlers on
  `/cli`; helpers (`publishMovePackage`, `seedSharedObject`,
  `createLocalSuiClient`, etc.) on `/helpers`; React adapter on `/react`.
- **`createLocalSuiClient(url, network?)`** added in `/helpers` — replaces
  the verbatim `function suiClient(url)` previously copy-pasted in 4 plugin
  files.

### New — workstreams

- **`imports({ packages })` plugin** — recursive Move-package imports from
  git. DeepBook, Pyth, etc. become a config-line. `await withRecursiveDeps([{...}])`
  walks Move.toml dep graphs at config-load time.
- **React adapter** (`@mysten-incubation/devstack/react`) — `DevstackProvider`,
  `useDevstackPackage(name)`, `useDevstackPackageOptional`,
  `useDevstackSignAndExecute({ invalidateKeys })`, `DevstackDebugPanel`,
  `createDevstackDappKit({ defaultNetwork, devKeys, walletInitializerFactory })`.
- **`apply` and `codegen` CLI verbs.** `apply` is a single-cycle reconcile;
  `codegen` is Emit-only with `readOnly: true`. Both accept `--target`.
- **`devstack down` and `devstack reset --yes`** top-level shortcuts.
- **`apply --actions a,b,c`** scopes the cycle to named actions + their
  `needs` deps + the codegen Emit cascade.
- **REPL `.deploy [pkg]`** — runs apply against the resolved target;
  optional `<pkg>` arg scopes via `actionScope`.
- **`ActionBase.watches?: string[]`** — extra paths the file watcher
  treats as inputs. Useful for non-Move-package inputs (GraphQL schemas,
  JSON configs).
- **`readManifestWithMigration({ appDir, stack, network })`** — version-aware
  manifest reader. `ManifestVersion = 1 | 2` is reserved for future
  schema migrations.
- **`definePublishAction({ name, sourcePath, ... })`** — higher-level
  Publish factory. Bakes in source-digest cache + `getStatus` (chainId
  match + on-chain liveness) + register + optional `onPublished` hook.
  Replaces the hand-rolled Publish boilerplate the example apps + seal
  plugin previously duplicated.
- **Live-network publish.** `publishMovePackage` accepts
  `buildEnv: 'host' | 'container'`. `definePublishAction` picks
  automatically — `'container'` on localnet, `'host'` on live nets
  (requires the host's sui CLI on PATH).
- **Topo lenient mode** — `topoSortActions(actions, { lenient: true })`
  drops `needs:` edges that point at filtered-out actions instead of
  throwing. `runOneShot` always passes `lenient: true`; the supervisor
  stays strict.
- **Hermetic e2e** — `defineDevstackPlaywrightConfig({ manageStack: true })`
  wires globalSetup (bring stack up) + globalTeardown (tear it down).
  `pnpm test:e2e` is now self-contained.

### Migration from `1.0.0-rc.1`

The `notes/api-refactor.md` session log walks every workstream chunk-by-chunk
with rationale. Three-line summary:

1. Move account names to top-level `accounts: { name: {} }`.
2. Replace `({ scope }) =>` with `() =>`; drop `scope()` calls; rename
   `before:` to `provides:` + capability queries.
3. Update `from '@mysten-incubation/devstack'` imports — runtime/cli/
   helpers symbols moved to subpaths.
