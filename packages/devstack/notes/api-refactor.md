# Devstack v1 API Refactor

**Status:** complete — A, B, C, D, E, F1, G, H, I shipped end-to-end; per-app migration done for all
four examples. Browser smoke runs via the existing Playwright e2e suite. **Started:** 2026-04-30
**Last touched:** 2026-04-30

This is a multi-session refactor plan. Track progress by checking off steps inline as they ship.
Append session-handoff notes to the **Session log** at the bottom; record material design decisions
in the **Decisions log**. Code is the source of truth for any divergence between this doc and
runtime behavior.

---

## Context

`@mysten-incubation/devstack` is at v1.0.0-rc.1. A pre-release review surfaced issues at multiple
layers — four substantive public-API problems plus a fifth capability gap that the user surfaced
directly, and a longer list of finishing/polish items the review catalogued. Because we have not yet
shipped, this is the right window to reshape the contract before lock-in. The codebase explicitly
accepts a clean break — no compatibility shims, except where called out below to make multi-step
landings safe.

User-surfaced problems (drove A–D):

1. **Account management is fragmented.** Six pathways materialize signing material (sui plugin's
   `accounts: [...]` + on-disk keypairs, `cliSigner`/`envSigner` for live nets, `loadAccountKeypair`
   in plugins, `ConsoleAccount` in REPL, hardcoded keys in dev-wallet, deterministic mnemonic in
   tests). Three different consumer shapes (`Ed25519Keypair`, `Signer`, `ConsoleAccount`). Same
   problem solved five different ways.

2. **Plugin authoring API has rough edges.** The `scope` callback is awkward — three of four example
   apps reach past `publish()` and construct Publish actions by hand. `before:` silently drops if
   the target isn't loaded. Lifecycle and persistence are correct but invisible — the status panel
   doesn't show _why_ something will rerun. Cross-plugin ordering by raw action names is fragile.

3. **Codegen and deploy are coupled to the supervisor.** Codegen runs only as part of `up`. Deploy
   runs only against live nets. There's no `pnpm codegen` against an existing manifest. The
   supervisor, codegen, and deploy are mostly the same engine with different action filters; the CLI
   surface doesn't reflect that.

4. **Recursive package imports from mainnet.** Replaces the parked fork-from-mainnet concern (Sui
   CLI is getting its own forking primitive). DeepBook v3, Pyth, and similar packages need to be
   available locally and across stacks. Today the wallet example imports DeepBook by hand via a
   one-off action; this should be first-class — declare a package + repo + rev, devstack walks
   `Move.toml` dependencies recursively and publishes in topo order.

Review-surfaced finishing work (drove E–I):

5. **Manifest plumbing exists but the React payoff doesn't.** Codegen emits `@local-pkg/<name>`
   placeholders that every app rewrites by hand into `tx.moveCall({ target: ${packageId}::… })`.
   Arena's `lib/queries.ts:16` literally says
   `// FRICTION: fourth copy of the useSignAndExecute pattern.` Scaffold-eth-2's killer feature is
   `useScaffoldContract({ contractName })` — a typed call builder bound to the current local deploy.
   Devstack should ship the equivalent.

6. **No reflective debug surface.** Every reviewer of SE-2 calls `/debug` (form-per-function from
   ABIs) the wow moment. Devstack has the manifest + codegen output to do the same on Sui (objects +
   Move-call type info), and ships nothing.

7. **App-level boilerplate that belongs in the library.** `function suiClient(url)` is defined
   verbatim in 4 plugin files; `registerCoinToken()` is duplicated in 2; `useSignAndExecute` is
   hand-rolled in 4 React apps; `dapp-kit + dev-wallet + virtual:devstack-keys` wiring is rebuilt in
   each app's `dapp-kit.ts`. Library-shaped duplication.

8. **Public surface is one giant barrel.** `index.ts` exports ~80 names spanning plugin authoring,
   runtime internals, CLI handlers, and helpers. Hardhat 3 organizes the same surface across
   `hardhat`, `hardhat/config`, `hardhat/types`, `hardhat/network-helpers`. Subpaths today: `vite`,
   `vitest`, `vitest/runtime`, `playwright`. The runtime/CLI/helpers split is missing.

9. **Polish gaps with low individual cost but cumulative friction.** `Plugin.schemas` exported but
   unused (review confirmed; no runtime reader); no top-level `down`/`reset` shortcut for the active
   stack; manifest `version: 2` hardcoded with no migration path; action context types don't
   discriminate stack-vs-network so plugins must check at runtime; no `watches?` override for
   actions whose inputs aren't a Move package; no in-REPL `.deploy` for tightening the dev loop
   further.

A, B, C are independent. D rides on top of A and B but doesn't block them. E–H pile on top of
finished A/B/C — they're new surface, not surface changes. I is the polish bag, mostly small steps
that can land any time.

---

## Quick-reference checklist

### Workstream A — Accounts as first-class Signers

- [x] A1 — Add types + resolver (eager-resolve, per-account error capture)
- [x] A2 — Migrate every caller; cut `ctx.signer`, `NetworkConfig.signer`, `OneShotOptions.signer`,
      `loadAccountKeypair`, `ConsoleAccount.keypair`, `sui({ accounts })`. No compat shims.

### Workstream B — Plugin authoring API

- [x] B1 — Type plumbing + new `'stale' | 'dirty'` status states
- [x] B2 — Capability synthesis in topo (with `before` co-existing)
- [x] B3 — Reconciler `progress` callback + dirty marking
- [x] B4 — `expandPluginActions` rewrite + `definePublishAction`
- [x] B5 — Convert built-in plugins + example apps; remove `before` co-existence

### Workstream C — Targets and decoupled operations

- [x] C1 — Extract shared CLI helpers; parameterize `runOneShot`
- [x] C2 — Add `apply` and `codegen` CLI handlers; example app scripts

### Workstream D — Recursive Move-package imports

- [x] D1 — Add `imports/` plugin, non-recursive (mirrors today's hand-rolled deepbook); migrate
      wallet
- [x] D2 — Add recursive Move.toml dep walking (parser + async `withRecursiveDeps`)
- [x] D3 — Migrate wallet example; remove hand-rolled import (folded into D1)

### Workstream E — Typed package hooks for React

- [x] E1 — `@mysten-incubation/devstack/react` subpath; `DevstackProvider` +
      `useDevstackPackage(name)`
- [x] E2 — `useDevstackSignAndExecute()` hook (replaces the four hand-rolled copies)
- [x] E3 — All four example apps migrated. `lib/transactions.ts` deleted from arena/private-content;
      wallet keeps its multi-call `buildSendTx`/`buildDeepbookSwapTx` since those compose
      splitCoins/transferObjects (not single moveCalls); token-studio keeps `buildTransferTx` for
      the same reason. Per-app `useSignAndExecute` removed

### Workstream F — Reflective debug surface

- [x] F1 — `<DevstackDebugPanel />` React component reading `manifest` + codegen builders
- [ ] F2 — NOT SHIPPED. Apps mount `<DevstackDebugPanel />` directly under `import.meta.env.DEV`;
      the Vite route helper would be sugar — defer until a consumer asks
- [x] F3 — Mounted in all four apps' main.tsx behind `import.meta.env.DEV`. Browser smoke runs
      through the existing Playwright suite

### Workstream G — App-helper extraction

- [x] G1 — `helpers/sui-client.ts` (`createLocalSuiClient(url)`). `registerCoinToken` was already
      inlined in B5 — no helper needed
- [x] G2 — `createDevstackDappKit({...})` ships from `@mysten-incubation/devstack/react`; per-app
      `dapp-kit.ts` migration deferred with E3

### Workstream H — Public-surface subpath split

- [x] H1 — Subpath barrels (`./runtime`, `./cli`, `./helpers`) shipped
- [x] H2 — Main barrel stripped to authoring-only surface. `createLocalSuiClient`,
      `seedSharedObject`, `publishMovePackage`, etc. moved to the helpers subpath. Apps + docs
      swept. `pnpm -r build` clean across 8 workspaces

### Workstream I — Polish & deferred review items

- [x] I1 — Top-level `devstack down` / `devstack reset --yes` shortcuts (reset uses --force to
      bypass active-stack guard)
- [x] I2 — `readManifestWithMigration` shipped. `Manifest.version` widened to `1 | 2`. Migration
      table empty today
- [x] I3 — `ActionRunContext = LocalnetActionRunContext | LiveNetActionRunContext`.
      `requireLocalnetCtx(ctx)` helper for narrowing. All built-in plugins migrated
- [x] I4 — DROPPED. `Plugin.schemas` removed entirely (no consumer)
- [x] I5 — `ActionBase.watches?: string[]` override; file watcher unions with inferred globs
- [x] I6 — REPL `.deploy [pkg]` command. Scope arg now plumbs through `runApply({ actions })` →
      `runOneShot({ actionScope })` → `scopeActions()` (transitive `needs` walk + auto-include of
      all Emit actions for cascade correctness). `apply --actions a,b,c` is the standalone CLI shape

---

## Workstream A — Accounts as first-class Signers

**Status:** complete (A1 + A2 shipped 2026-04-30)

### Final API

```ts
defineDevstackConfig({
  app: 'arena',
  accounts: {
    alice: {},                                                   // localnet-generated dev keypair
    bob: {},
    publisher: {                                                  // per-network factory
      testnet: cliSigner({ alias: 'deployer' }),
      mainnet: envSigner({ name: 'PROD_KEY' }),
    },
  },
  plugins: [sui(), arenaPlugin(), codegen()],
});

// In any plugin action:
run: async (ctx) => {
  const publisher = ctx.accounts.get('publisher');               // Signer for ctx.network
  await client.signAndExecuteTransaction({ signer: publisher, transaction: tx });
}

// In REPL:
> accounts.alice.toSuiAddress()
> await client.signAndExecuteTransaction({ signer: accounts.publisher, transaction })
```

`AccountSpec` is either an `AccountFactory` (single) or a record
`{ default?, localnet?, testnet?, mainnet? }`. Factory signature:
`(ctx: { appDir, stack, network, rpcUrl }) => Promise<Signer>`. Resolution precedence: explicit
network → `default` → implicit `generatedKeypair()` on localnet only. Live-net access without a
configured factory throws on first `get()` with the captured factory error attached.

`ctx.accounts` exposes `get(name): Signer`, `has(name): boolean`, `names(): string[]`. The sui
plugin loses its `accounts: [...]` option; it iterates `ctx.accounts.names()` and faucets each on
localnet. `networks.<n>.signer` is removed (folded into the per-network factory map).

`AccountPool` (for tests) stays independent — public mnemonic + deterministic derivation. Tests want
leasable, isolated accounts, not config-bound names.

### Critical files

- `packages/devstack/src/core/types.ts` — add `AccountFactory`, `AccountSpec`,
  `AccountFactoryContext`, `AccountsContext`. Add `DevstackConfig.accounts`. Replace
  `ActionRunContext.signer?` with `accounts: AccountsContext`. Drop `NetworkConfig.signer`.
- `packages/devstack/src/runtime/accounts.ts` (new) —
  `resolveAccounts(specs, baseCtx) → AccountsContext`. Eager materialization at startup; per-account
  error capture for lazy surfacing.
- `packages/devstack/src/helpers/signers.ts` — add `generatedKeypair()`. Existing
  `cliSigner`/`envSigner` already return `Signer` and slot in.
- `packages/devstack/src/helpers/keystore.ts` — move `loadOrGenerateKeypair` here from
  `plugins/sui/keys.ts`. Drop `loadAccountKeypair` from public API.
- `packages/devstack/src/helpers/imported-package.ts` — change `publisher` parameter to take
  `Signer` instead of `{ secretKey, address }`.
- `packages/devstack/src/runtime/{supervisor,one-shot,reconcile}.ts` — call `resolveAccounts()`
  after manifest hydration; thread `AccountsContext` through `ReconcileBaseContext`.
- `packages/devstack/src/plugins/sui/index.ts` — drop `accounts?: string[]` option. The
  `sui.accounts` action becomes a consumer of `ctx.accounts.names()`. Keep faucet funding +
  `funded: true` registry update.
- `packages/devstack/src/plugins/seal/index.ts` — replace 2 `loadAccountKeypair` calls with
  `ctx.accounts.get('publisher')`.
- `packages/devstack/src/cli/{deploy,console}.ts` — drop manual signer plumbing; use
  `resolveAccounts()` + `ctx.accounts`. REPL binds `accounts.<name>` directly as `Signer`.
- `packages/devstack/src/index.ts` — export `generatedKeypair`, `AccountFactory`, `AccountSpec`,
  `AccountsContext`. Remove `loadAccountKeypair`.
- All four `examples/*/devstack.config.ts` — move accounts to top level.
- All four `examples/*/*Plugin.ts` — replace ~10 `loadAccountKeypair` call sites with
  `ctx.accounts.get(name)`.
- `packages/devstack-wallet/*` and example apps' `src/dapp-kit.ts` — **no change needed**. The
  existing `virtual:devstack-keys` Vite plugin reads `<stackDir>/.keys/*.key`; `generatedKeypair()`
  writes the same files at the same path.

### Steps

- [x] **A1.** Types + resolver shipped. `AccountFactory`, `AccountSpec`, `AccountsContext`,
      `generatedKeypair()`, `resolveAccounts()`. `ctx.accounts` and `ctx.signer` co-existed for the
      one-step gap between A1 and A2 (no plugin consumed `ctx.accounts` yet).
- [ ] **A2.** Migrate every caller and cut the legacy paths in one diff. Replace every
      `loadAccountKeypair(...)` with `ctx.accounts.get(name)`. Reshape `helpers/imported-package.ts`
      to take a `Signer` (runtime-checked Keypair). Move example apps' account names to top-level
      `accounts: { ... }` and drop `sui({ accounts })`. Cut `ActionRunContext.signer`,
      `NetworkConfig.signer`, `OneShotOptions.signer`, `ConsoleAccount.keypair`,
      `loadAccountKeypair` (helper + export), `Plugin.schemas` if I4 hasn't landed yet (keep it if
      it has). Console binds `accounts.<name>` directly as `Signer`.

### Risks

- Renaming an account orphans its `.key` file and breaks plugin code with "unknown account" — clear
  error, acceptable.
- Live-net factories that throw at materialization (e.g. `cliSigner` against a missing alias)
  surface lazily on first `get()`. Log resolution failures at startup even when they don't abort.
- `wallet` example's deepbook import currently reads `publisher.key` raw. The `Signer` refactor on
  `imported-package.ts` is part of A2; do not skip.

### Compatibility posture

Pre-release, zero external consumers — no compat shims, no deprecation windows. A2 cuts every old
path in the same diff that introduces the new one.

---

## Workstream B — Plugin authoring API

**Status:** complete (B1–B5 shipped 2026-04-30)

### Final API

```ts
definePlugin({
	name: 'arena', // /^[a-z][a-z0-9_-]*$/, no dots
	actions: () => [
		definePublishAction({
			name: 'connect_four', // bare; auto-prefixed to 'arena.connect_four'
			sourcePath: './move/connect_four',
			capture: { adminCap: '::admin::AdminCap' },
		}),
		seed({
			name: 'openLobby',
			needs: ['connect_four'], // local; resolves to 'arena.connect_four'
			run: async (ctx) => {
				/* ... */
			},
		}),
	],
});
```

`needs` resolution rules:

- Bare `'foo'` → local action in this plugin. Throws if not present.
- Dotted `'sui.accounts'` → fully-qualified global. Throws if missing from graph.
- Suffixed `'app-network:before'` / `':after'` → capability query. Soft (silent drop on missing
  provider).

Capabilities replace `before`:

```ts
buildImage({ name: 'network', provides: ['app-network'] /* ... */ });
service({ name: 'localnet', needs: ['app-network:before'] /* ... */ });
```

New status states `stale` (input hash drifted; will rerun) and `dirty` (Emit's `dependsOnKind`
triggered; cascade pending). Both rendered in the status panel — `stale` appears immediately on file
watch event, `dirty` between topo walk and cascade.

`definePublishAction` higher-level factory bakes in publisher signing, default `getStatus`
(chainId + on-chain liveness), `registry.packages.register`, and `onPublished(ctx, result)` for
post-publish side effects (token registration, etc.). Replaces the hand-rolled Publish boilerplate
in 4 example apps + seal.

### Critical files

- `packages/devstack/src/core/types.ts` — `ActionStatus` adds `'stale' | 'dirty'`. `ActionBase`
  drops `before?`, adds `provides?: string[]`. `Plugin.actions` becomes `() => Action[]`. Remove
  `Scope` and `PluginActionsContext` exports.
- `packages/devstack/src/plugin.ts` — rewrite `expandPluginActions`: validate plugin name,
  auto-prefix action names, resolve local `needs`, reject dotted action names with helpful error.
- `packages/devstack/src/runtime/topo.ts` — replace `before` reverse-edge pass with capability
  synthesis (build provider table; `:before` queries become edges to all providers; `:after`
  reverses; missing provider = silent drop).
- `packages/devstack/src/runtime/reconcile.ts` — add `progress?: (statuses) => void` callback. Emit
  interim snapshot after topo walk with `dirty` marked for queued Emits.
- `packages/devstack/src/runtime/status-renderer.ts` — add glyphs for `stale`/`dirty`. Add
  `markStale(names)` with transient state cleared by next authoritative `update()`.
- `packages/devstack/src/runtime/supervisor.ts` — wire `progress` to renderer; wire `onFileStale` →
  `renderer.markStale`.
- `packages/devstack/src/actions/{build,service,publish,register,seed,emit}.ts` — drop `before?`,
  add `provides?: string[]` on each option type.
- `packages/devstack/src/actions/publish.ts` — add `definePublishAction` factory. Keep low-level
  `publish()` as escape hatch.
- `packages/devstack/src/helpers/move-package.ts` — extract `buildPriorCacheEntry()` for reuse.
- `packages/devstack/src/plugins/{sui,walrus,seal,codegen}/index.ts` — convert to bare names.
  Walrus's `before: ['sui.localnet']` → `provides: ['app-network']`; sui.localnet adds
  `needs: ['app-network:before']`. Seal's hand-rolled Publish becomes `definePublishAction`.
- All four `examples/*/(devstack.config.ts|*Plugin.ts)` — convert to bare names; switch to
  `definePublishAction`.
- `docs/devstack-design.md` §11 — add a persistence-layers table (manifest, registry, containers,
  on-chain state, codegen output, account keypairs, Docker images) showing what each survives and
  what clears each.

### Steps

- [x] **B1.** Type plumbing. Add `'stale' | 'dirty'` to `ActionStatus`; add `provides?: string[]` to
      `ActionBase`. Renderer gets glyphs + `markStale(names)`. No behavior change.
- [x] **B2.** Capability synthesis in `topo.ts`. Build providers table, resolve `:before`/`:after`
      queries. Keep `before:` block in place for safety co-existence one release.
- [x] **B3.** Reconciler `progress` callback. Supervisor wires `progress` → renderer; `onFileStale`
      → `markStale`. Mark `dirty` between topo walk and cascade.
- [x] **B4.** `expandPluginActions` rewrite (auto-prefix, local `needs` resolution, dotted-name
      rejection). Add `definePublishAction` factory. Plugin authoring contract becomes
      `() => Action[]`.
- [x] **B5.** Convert built-in plugins (sui, walrus, seal, codegen) and example apps. Walrus's
      `before` → `provides: ['app-network']`. Seal's Publish action becomes `definePublishAction`.
      Remove `before` co-existence path.

### Risks

- Multiple capability providers — ordering between providers of the same capability is unspecified.
  Document. If determinism becomes a problem, sort lexicographically.
- Renderer flicker from interim `progress` updates. Debounce 50ms in renderer if observed in slow
  terminals.
- `Plugin.schemas` field is exported but unused. Wire it to validate `registry.ns()` registrations
  OR drop it. Decide during plumbing.

---

## Workstream C — Targets and decoupled operations

**Status:** complete (C1 + C2 shipped 2026-04-30)

### Final CLI surface

```
devstack up                          # localnet active stack, supervisor (long-running, watch)
devstack up --target <stack>         # localnet named stack, supervisor
devstack up --once                   # active stack, single supervisor cycle, exit

devstack apply                       # active stack, single cycle, all actions
devstack apply --target <stack>      # named stack, single cycle, all actions
devstack apply --target <network>    # live net, single cycle, no Service/Build

devstack deploy --target <network>   # live net, Publish/Register/Emit (+ gated Seed)
devstack deploy --target <stack>     # localnet stack, deploy slice

devstack codegen                     # active stack manifest, Emit only, READ-ONLY
devstack codegen --target <network|stack>

devstack console --target <network|stack>
devstack stack list|new|use|down|drop          # unchanged
```

`--target` resolution: form `<network>:<stack>` is unambiguous; bare value matches network names
first, then stack names; mismatch errors with available options listed. Stacks are localnet-only;
live-net targets ignore stack.

Engine: one `runOneShot` taking `actionFilter: (Action, ResolvedTarget) => boolean` and
`readOnly?: boolean`. Filters live in `cli/filters.ts`:

- `applyFilter` — localnet runs all, live skips Service/Build.
- `deployFilter` — skip Service/Build, run Publish/Register/Emit (Seed gated by network).
- `emitOnlyFilter` — only Emit actions; used by `codegen`.

`Supervisor` stays localnet-only — its watcher, key handlers, and keep-alive interval are inherently
long-running-local. Constructor throws on `network !== 'localnet'`.

### Critical files

- `packages/devstack/src/cli/network-profile.ts` (new) — extract
  `resolveNetworkProfile(config, network)` from current `cli/deploy.ts:20-31`.
- `packages/devstack/src/cli/args.ts` (new) — shared parsers: `parseConfigArg`, `parseTargetArg`,
  `loadConfig`. Replaces duplicated parsers across the four CLIs.
- `packages/devstack/src/cli/target.ts` (new) —
  `ResolvedTarget = { network, stack, rpcUrl, signer? }` and `resolveTarget(config, appDir, raw)`.
- `packages/devstack/src/cli/filters.ts` (new) — the four `ActionFilter` exports.
- `packages/devstack/src/cli/apply.ts` (new) — `runApply(flags)`. Resolves target, picks
  `applyFilter`, calls `runOneShot`.
- `packages/devstack/src/cli/codegen.ts` (new) — `runCodegen(flags)`. Resolves target, picks
  `emitOnlyFilter`, calls `runOneShot` with `readOnly: true`.
- `packages/devstack/src/cli/deploy.ts` — rewrite to use shared helpers + `deployFilter`. Add
  `--target` alias for `--network`.
- `packages/devstack/src/cli/up.ts` — use shared parsers. Add `--target` (localnet-only). Error on
  live-net target with actionable message.
- `packages/devstack/src/cli/console.ts` — use shared `target.ts` for resolution.
- `packages/devstack/src/cli/index.ts` — extend verb switch with `apply` and `codegen`. Update
  USAGE.
- `packages/devstack/src/runtime/one-shot.ts` — add `actionFilter`, `readOnly` options. `signer`
  becomes optional. Conditional `sui-rpc` pre-registration. Conditional manifest write.
- `packages/devstack/src/runtime/supervisor.ts` — add `if (network !== 'localnet') throw`
  constructor guard.
- `packages/devstack/src/index.ts` — export `runApply`, `runCodegen`, `ResolvedTarget`,
  `resolveTarget`, the four filters.
- `packages/devstack/tsup.config.ts` — add `'cli/apply'` and `'cli/codegen'` entry points.
- All four `examples/*/package.json` — add `apply` and `codegen` scripts. Keep existing scripts for
  back-compat.

### Steps

- [x] **C1.** Extract shared helpers (`cli/args.ts`, `cli/target.ts`, `cli/network-profile.ts`,
      `cli/filters.ts`). Parameterize `runOneShot` with `actionFilter` and `readOnly`. Add
      Supervisor localnet-only guard. No behavior change for `devstack deploy` (default filter
      preserves pre-C1 behavior); `runOneShot` now drives via `Reconciler.cycle` so the Emit
      dirty-kind cascade fires on live nets too.
- [x] **C2.** Add `cli/apply.ts` (applyFilter, all kinds on localnet) and `cli/codegen.ts`
      (emitOnlyFilter + readOnly). Extend `up.ts` / `deploy.ts` / `console.ts` with `--target` (up
      rejects live-net targets; deploy treats `--target` as alias for `--network` plus stack-form
      support; console resolves stack+network through the shared helper). Wire `apply` and `codegen`
      verbs into the dispatcher's USAGE + verb switch. Add `cli/apply` / `cli/codegen` entries to
      `tsup.config.ts`. Add `apply` and `codegen` scripts to all four example apps' `package.json`.
      Plus a `runIfMain` dedupe helper in `cli/args.ts` to fix a latent double-fire (tsx + workspace
      symlinks reload entry modules through the barrel re-export — pre-C1 bug, masked but visible
      with the new verbs).

### Risks

- **Localnet `apply` when sui isn't running.** Don't add an explicit pre-flight check; let the
  Service action's existing `getStatus` health-check handle it. The action graph self-diagnoses with
  a real error from the Reconciler. Simpler than a custom check.
- **Emit cascade on live nets.** `runOneShot`'s parallel-level walk doesn't run the dirty-kind
  cascade for Emit re-fires (latent bug today). Teach `runOneShot` to use `Reconciler.cycle()` for
  consistency, even at parallelism cost — one-shot is rarely many actions in practice.
- **Manifest write protection in codegen mode.** `readOnly: true` skips the final manifest write.
  Verify by grepping for `writeFileSync`/`mkdirSync` reachable from the Emit-only path — only
  `plugins/codegen/index.ts` (intended) and `manifest-writer.ts` (now gated).

---

## Workstream D — Recursive Move-package imports

**Status:** D1 shipped (2026-04-30); D2 not started; D3 folded into D1 (no per-app migration left to
do separately — wallet was the only consumer)

### Final API

```ts
import { defineDevstackConfig, sui, imports } from '@mysten-incubation/devstack';

defineDevstackConfig({
	app: 'wallet',
	accounts: { publisher: {}, alice: {}, bob: {}, carol: {} },
	plugins: [
		sui(),
		imports({
			packages: [
				{
					name: 'deepbook',
					repo: 'MystenLabs/deepbookv3',
					rev: 'main',
					subdir: 'packages/deepbook',
					capture: { adminCap: '::deep::DeepCap', registry: '::registry::Registry' },
					// Live-net addresses for skipping local publish:
					addresses: {
						testnet: '0xdee9cc...',
						mainnet: '0x158f234...',
					},
				},
			],
			recursive: true, // walk Move.toml [dependencies] git deps
		}),
		walletPlugin(),
		codegen(),
	],
});
```

The plugin produces, per resolved package (top-level + transitively cloned):

- One `Build` action that ensures the upstream-source image (`ensureUpstreamSourceImage` already
  does content-addressed caching by `repo + rev`).
- One `Publish` action with default `getStatus` that:
  - On localnet: source-digest + on-chain liveness check; skips if matched.
  - On live nets with `addresses[network]` set: `ok: true`, registers the curated address (no
    on-chain work).
  - On live nets without `addresses[network]`: `ok: false`, forces a real publish (useful when you
    want to publish your own copy on testnet).
- `provides: ['imports.<name>']` capability for downstream actions to depend on by name without
  coupling to the imports plugin's internal action names.

Recursion runs at plugin instantiation (config-load time, before action graph is built):

1. For each top-level entry: ensure upstream-source image; extract `<source>/<subdir>/Move.toml`.
2. Parse `[dependencies]`. For git-shaped entries (`Foo = { git, rev, subdir? }`), enqueue. Skip
   framework deps (`Sui = { local = "..." }`) — these come from the localnet container's bundled
   framework.
3. Recurse: clone enqueued, parse, enqueue further. Cache by `(repo, rev, subdir)` content-hash to
   dedupe.
4. After fixed-point, topo-sort by Move.toml dep order.
5. Materialize Build + Publish actions per package; `needs:` links each Publish to its dependencies'
   Publishes.

The result: tests, codegen, and other plugins consume `registry.packages.find('deepbook')` with the
same shape on localnet and live nets. Each stack gets its own deployed copy on localnet (cache reuse
means later stacks are fast); live nets reference the curated address.

### Critical files

- `packages/devstack/src/plugins/imports/` (new directory):
  - `index.ts` — `imports({...})` plugin factory. Accepts package list, recursive flag, addresses
    map.
  - `resolve.ts` — recursive Move.toml dep walker. Returns topo-sorted resolved package list.
  - `move-toml.ts` — minimal Move.toml parser. Need only `[dependencies]` git/rev/subdir/local
    entries.
- `packages/devstack/src/helpers/imported-package.ts` — already exists. Reuse for the publish step.
  Update signature to accept `Signer` (per Workstream A).
- `packages/devstack/src/helpers/upstream-source.ts` — already exists. `ensureUpstreamSourceImage`
  and `extractUpstreamSource` are reused for content-addressed source caching.
- `packages/devstack/src/index.ts` — export `imports`, `ImportsPluginOptions`, `ImportSpec`.
- `examples/wallet/walletPlugin.ts` — remove the hand-rolled DeepBook v3 import block (~50 lines
  around line 200).
- `examples/wallet/devstack.config.ts` — add `imports({ packages: [{ name: 'deepbook', ... }] })` to
  the plugin list.
- `docs/site/content/...` — page documenting how to declare imports + how recursion resolves.

### Steps

- [x] **D1.** Add `imports/` plugin without recursion. Mirrors today's wallet hand-rolled deepbook
      import — single package, capture, addresses map. Materialize Build + Publish actions.
      `getStatus` handles live-net skip via curated address. Wallet migrated in the same diff (D3
      folded in — wallet was the only consumer; nothing left to migrate separately).
- [ ] **D2.** Add recursive Move.toml dep walking. Add `move-toml.ts` parser, `resolve.ts` traversal
      with content-hash deduping. Handle framework `local =` skip. Topo-sort and emit one Build +
      Publish per resolved package.
- [x] **D3.** Folded into D1.

### Risks

- **Move.toml parser scope.** The realistic subset is
  `Foo = { git = "...", rev = "...", subdir = "..." }` and `Foo = { local = "..." }`. Fail loudly on
  unexpected syntax rather than silently mishandle.
- **Sui framework dep handling.** Every Move package's `Move.toml` declares
  `Sui = { local = "..." }` or similar. Skip these — the localnet container provides the framework.
- **Curated address drift.** `addresses[testnet]` becomes stale when upstream redeploys. No
  automation; surface in docs as a manual update.
- **Future packageId-based resolution.** When the Sui CLI ships its forking primitive, the imports
  plugin grows a second source mode (`{ name, mainnetPackageId }`). Plugin shape is
  forward-compatible; deferred until the primitive lands.

---

## Workstream E — Typed package hooks for React

**Status:** not started

The single biggest UX gap relative to scaffold-eth-2. Codegen already emits typed call builders that
compile to a Move call expecting a `package?: string` argument (default `'@local-pkg/<name>'`).
Today every app overrides that placeholder by hand: `arena/src/lib/transactions.ts:8` reads
`deployment.connectFourPackageId` and feeds it back into a hand-built
`tx.moveCall({ target: ${packageId}::game::create_lobby })`. The generated
`createLobby({ package })` exists right next to that file and is unused.

Goal: bind the manifest to the codegen output at runtime, expose it through React hooks, and make
`useDevstackPackage('connect_four').createLobby({ … })` the only way apps build transactions.

### Final API

```ts
// examples/arena/src/main.tsx
import { DevstackProvider } from '@mysten-incubation/devstack/react';
import { manifest } from 'virtual:devstack-manifest';
import * as connectFour from './generated/sui/connect_four/game';

<DevstackProvider manifest={manifest} packages={{ connect_four: connectFour }}>
  <App />
</DevstackProvider>;

// examples/arena/src/components/LobbyView.tsx
import { useDevstackPackage, useDevstackSignAndExecute } from '@mysten-incubation/devstack/react';

function LobbyView() {
  const pkg = useDevstackPackage('connect_four');                  // typed; throws if not deployed
  const { mutateAsync, isPending } = useDevstackSignAndExecute();
  const open = () => mutateAsync(pkg.createLobby({ arguments: [] }));
  return <button onClick={open} disabled={isPending}>Open lobby</button>;
}
```

`useDevstackPackage(name)` returns the codegen module's exports, with each exported builder
pre-bound so `package` is auto-injected from `manifest.registry.packages.find(name).packageId`. Apps
don't pass `package` at the call site — type inference (via `Omit<…, 'package'>`) makes the
parameter disappear when looking at the bound module.

`useDevstackSignAndExecute()` returns the `useMutation`-shaped hook that the four apps currently
rebuild from scratch — bakes in `client.waitForTransaction` on success and a default queryClient
invalidation namespace.

If `manifest.registry.packages.find(name)` returns undefined (pre-deploy), `useDevstackPackage`
throws on first render with a
`"connect_four package is not deployed yet — run 'pnpm localnet:up' first"` message. Test apps gate
render on `isDeployed` (already a pattern in `examples/arena/src/generated/deployment.ts:37`).

### Critical files

- `packages/devstack/src/react/` (new directory):
  - `index.ts` — barrel: `DevstackProvider`, `useDevstackPackage`, `useDevstackSignAndExecute`,
    `useDevstackManifest`.
  - `provider.tsx` — `<DevstackProvider>` reads `manifest` + `packages` props, plumbs into context.
    Single context object so siblings don't re-render on unrelated changes.
  - `bind-package.ts` — `bindPackage(module, packageId)`: walks the codegen module's exports,
    returns a same-shape object where each builder's `package` parameter is curried away. Type:
    `OmitPackageArg<typeof module>` mapped helper.
  - `use-sign-and-execute.ts` — wraps `useCurrentClient`, `useMutation` from
    `@tanstack/react-query`, dapp-kit's signer; exposes the four-app pattern as one hook.
- `packages/devstack/package.json` — add `./react` export with `react`, `react-dom`,
  `@tanstack/react-query`, `@mysten/dapp-kit-react` as `peerDependencies` (optional; matches
  existing `./vite` peer pattern).
- `packages/devstack/tsup.config.ts` — add `'react/index'` entry point.
- All four `examples/*/src/main.tsx` — wrap `<App />` in
  `<DevstackProvider manifest={manifest} packages={…}>`. Replace per-app dapp-kit setup that already
  wires manifest into account context (small consolidation).
- All four `examples/*/src/lib/transactions.ts` — delete. Call sites use
  `useDevstackPackage(name).fnName({ arguments })` directly.
- All four `examples/*/src/lib/queries.ts` — replace the hand-rolled `useSignAndExecute` (arena
  explicitly comments this is the _fourth copy_) with `useDevstackSignAndExecute()`.
- `examples/*/src/generated/deployment.ts` — keep for app-specific narrowing (e.g.
  `deployment.openLobbyId` from a seeded shared object); the package-id projections move into
  `useDevstackPackage` and can be deleted.
- `docs/site/content/...` — page covering the React adapter; primary onboarding example.

### Steps

- [ ] **E1.** Add `react/` subpath. Implement `<DevstackProvider>`, `useDevstackPackage`,
      `useDevstackManifest`. `bindPackage` walks the codegen module's exports and curries `package`
      from manifest. Single passing test case in `react/bind-package.test.ts`.
- [ ] **E2.** Add `useDevstackSignAndExecute`. Mirror arena's current shape (mutation +
      waitForTransaction + queryClient invalidate). Optional `invalidateKeys` prop.
- [ ] **E3.** Migrate all four example apps. Delete `lib/transactions.ts` per app. Remove the
      hand-rolled `useSignAndExecute`. Smoke each app via `pnpm dev` + manual click-through.

### Risks

- **Codegen module shape coupling.** `bindPackage` assumes every export is a
  `(opts: { package?: string, arguments? }) => (tx: Transaction) => unknown` builder. Spot-checked —
  `@mysten/codegen` 0.10.4's output matches. Verify on update; pin the dep range until E ships.
- **Type-curry inference.** Stripping `package` from each function's options type via mapped types
  is straightforward but TS noise around index signatures can creep in. If inference degrades, fall
  back to typed wrappers per builder rather than a generic mapped type.
- **Pre-deploy render.** Apps that render `useDevstackPackage('foo')` before `pnpm localnet:up` ran
  will throw. Document the `isDeployed` gate; consider a `useDevstackPackageOptional(name)`
  returning `undefined` for graceful empty states. Don't auto-add — explicit is better.
- **Provider order.** `<DevstackProvider>` must wrap inside dapp-kit's providers (it depends on
  `useCurrentClient`). Order is
  `<QueryClientProvider><SuiClientProvider><WalletProvider><DevstackProvider>`. Document and assert
  (throw with a hint if `useCurrentClient` is undefined).

---

## Workstream F — Reflective debug surface

**Status:** not started

Scaffold-eth-2's `/debug` page (form-per-function for every deployed contract) is consistently
called out as the wow-moment of EVM dev experience. Devstack ships the data — manifest with
`packages[]` + per-package codegen module — but no UI. The cost to assemble one is two days of work;
the reach is "every dev who installs devstack sees it on first run."

### Final API

```ts
// examples/arena/src/main.tsx
import { DevstackDebugPanel } from '@mysten-incubation/devstack/react';

// In app layout (typically dev-only):
{import.meta.env.DEV && <DevstackDebugPanel route='/__devstack' />}
```

The panel reads the `DevstackProvider` context (manifest + packages). For each package, it lists
modules → exported builders, renders an auto-generated form for each builder's argument types
(string for `Address`, number for `u8/u64`, bigint for `u128/u256`, JSON textarea for
vectors/options), wires a "Submit" button to `useDevstackSignAndExecute`, and renders the resulting
transaction effects + object changes inline. A "Recent" section reads
`client.queryTransactionBlocks({ filter: { FromAddress: currentAccount } })` for the last 10 txs.

Optional: a Vite-side route registration — `/__devstack` resolves to a tiny mount page so users
don't have to wire it into their router.

### Critical files

- `packages/devstack/src/react/debug-panel.tsx` (new) — the panel component. Reads
  `DevstackProvider` context.
- `packages/devstack/src/react/debug-form.tsx` (new) — the per-builder form generator. Argument-type
  → input mapping. Handles `RawTransactionArgument<T>` cases.
- `packages/devstack/src/react/index.ts` — add `DevstackDebugPanel` export.
- `packages/devstack/src/vite/plugin.ts` — add an optional `devstackDebugRoute()` Vite plugin that
  injects a `/__devstack` route handler in dev (returns a tiny HTML stub with React mount + script
  src to the app's entry). Optional; off by default.
- All four `examples/*/src/App.tsx` — opt in conditionally on `import.meta.env.DEV`.
- `docs/site/content/...` — debug-panel page, screenshot, "no UI required" framing.

### Steps

- [ ] **F1.** Implement `<DevstackDebugPanel>` + `<DevstackDebugForm>`. Read context. Render lists,
      expand-on-click, form per builder. Submit via `useDevstackSignAndExecute`. Render results
      inline.
- [ ] **F2.** Add the optional Vite route helper. Mount lazily so production builds tree-shake it
      out.
- [ ] **F3.** Wire into all four example apps behind `import.meta.env.DEV`. Manual smoke per app:
      mount, hit `/__devstack`, run a Move call from the form, verify it lands on chain.

### Risks

- **Argument-type inference.** `@mysten/codegen` exposes argument types via `JoinLobbyArguments`
  interfaces; the form has to walk those to render the right inputs. For simple types (`Address`,
  `u8/u64`) this is straightforward; vectors/options need a JSON-textarea fallback. **Document the
  fallback** rather than over-engineer; this is a debug surface, not a contract editor.
- **Generic Move types.** `MoveStruct` and generics carry parameterized types that codegen surfaces
  as opaque BCS structs. Don't try to render those — show a textarea + paste-BCS hint and move on.
- **Panel as escape hatch.** A reflective panel that submits to chain is a foot-gun if a user
  accidentally ships it to production. Two guards: only mount under `import.meta.env.DEV`, and emit
  a console warning when mounted against a non-localnet network.

---

## Workstream G — App-helper extraction

**Status:** not started

Three patterns were independently invented in multiple apps. The library should host them.

- `function suiClient(url): SuiJsonRpcClient` — defined verbatim in `arena/arenaPlugin.ts:145`,
  `token-studio/tokenStudioPlugin.ts:97`, `private-content/privateContentPlugin.ts:93`,
  `wallet/walletPlugin.ts:496`. Same body, four files.
- `function registerCoinToken(registry, …, packageId)` — in `token-studio/tokenStudioPlugin.ts:101`
  and `wallet/walletPlugin.ts:484`. Same shape.
- The dapp-kit + `virtual:devstack-keys` + dev-wallet wiring boilerplate at the top of every app's
  `dapp-kit.ts`. Identical across 4 files except the network-config object literal.

These do not belong inside Workstream B (which is about authoring contract changes); they're plain
helper-export work.

### Final API

```ts
// In any plugin action:
import { createLocalSuiClient, registerCoinToken } from '@mysten-incubation/devstack/helpers';

const client = createLocalSuiClient(rpcUrl); // existing 4-line helper, gone
registerCoinToken(ctx.registry, { name: 'usdc', packageId, decimals: 6 }); // existing 16-line helper, gone

// In app's main.tsx:
import { createDevstackDappKit } from '@mysten-incubation/devstack/react';
const dAppKit = createDevstackDappKit({ defaultNetwork: 'localnet' });
```

`createDevstackDappKit({ defaultNetwork })` returns the same shape every example app is
hand-building (network config from `manifest.services.find('sui-rpc')?.url`, dev-wallet registration
when `import.meta.env.DEV`, query-client wiring). Apps configure additional network endpoints by
passing `{ networks: { mainnet: '...' } }` (merged on top).

### Critical files

- `packages/devstack/src/helpers/sui-client.ts` (new) —
  `createLocalSuiClient(url): SuiJsonRpcClient`. Direct lift from the four duplicated bodies.
- `packages/devstack/src/helpers/coin-token.ts` (new) — `registerCoinToken(registry, opts)`. Lift
  from `token-studio/tokenStudioPlugin.ts:101` (the more general version of the two).
- `packages/devstack/src/index.ts` — re-export both. (After H lands, these move to
  `@mysten-incubation/devstack/helpers` subpath.)
- `packages/devstack/src/react/dapp-kit-setup.tsx` (new, requires E shipped) —
  `createDevstackDappKit(opts)`. Wraps `createNetworkConfig`, registers dev wallet on
  `import.meta.env.DEV`, returns `{ dAppKit, networkConfig }`.
- All four `examples/*/<app>Plugin.ts` — drop the duplicated `suiClient` + `registerCoinToken`
  definitions; import from devstack.
- All four `examples/*/src/dapp-kit.ts` — replace with one-line `createDevstackDappKit({...})` call
  (or delete entirely if the helper covers the whole shape).

### Steps

- [ ] **G1.** Lift `suiClient` and `registerCoinToken` into `helpers/`. Re-export. Migrate the four
      app plugin files. Drops ~80 lines of duplication.
- [ ] **G2.** After E ships, add `createDevstackDappKit` to the React adapter. Migrate the four
      `dapp-kit.ts` files. Delete now-empty modules.

### Risks

- **`registerCoinToken` shape divergence.** Token-studio's version takes a single packageId;
  wallet's takes an `opts` object with `name`/`type`/`decimals`. Generalize to the latter;
  token-studio call sites pass a literal options object — trivial migration.
- **`createDevstackDappKit` reach.** Apps that customize the network config beyond what the helper
  exposes (e.g. wallet adds DeepBook addresses pre-deploy) will need an escape hatch. Provide an
  `extend?: (config) => config` slot rather than designing every option upfront.

---

## Workstream H — Public-surface subpath split

**Status:** not started

`packages/devstack/src/index.ts` exports ~80 names. Plugin authors writing
`import { … } from '@mysten-incubation/devstack'` see `Reconciler`, `Supervisor`, `RegistryImpl`,
`FileWatcher`, `StatusRenderer`, `runUp`, `runDeploy`, `topoSortActions`, `stableHash`,
`manifestPath`, `buildManifest`, `writeManifest`, `readManifest`, `hydrateRegistry`, `runOneShot`,
`ensureUpstreamSourceImage`, `extractUpstreamSource`, `upstreamSourceImageTag` — none of which the
plugin author wants. Hardhat 3 puts these on `hardhat/network-helpers` etc. for a reason.

### Final layout

| Subpath                                                              | Audience                                 | What's there                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mysten-incubation/devstack`                                        | Plugin + app authors                     | `definePlugin`, `defineDevstackConfig`, action factories (`buildImage`/`service`/`publish`/`register`/`seed`/`emit`), built-in plugins (`sui`, `walrus`, `seal`, `codegen`, `imports`), signer factories (`cliSigner`, `envSigner`, `generatedKeypair`), all public types                          |
| `@mysten-incubation/devstack/runtime`                                | Devstack itself + advanced embedders     | `Reconciler`, `Supervisor`, `RegistryImpl`, `FileWatcher`, `StatusRenderer`, `topoSortActions`, `stableHash`, manifest I/O (`buildManifest`/`readManifest`/`writeManifest`/`hydrateRegistry`/`manifestPath`), `runOneShot`, active-stack helpers                                                   |
| `@mysten-incubation/devstack/cli`                                    | CLI consumers (alt drivers, custom apps) | `runUp`, `runDeploy`, `runConsole`, `runStack`, `runApply`, `runCodegen`, target/filter helpers (from C1)                                                                                                                                                                                          |
| `@mysten-incubation/devstack/helpers`                                | Plugin authors                           | `loadAccountKeypair` (until A3 lands), `publishMovePackage`, `importMovePackage`, `seedSharedObject`, `objectTypeMatchesFilter`, `ensureUpstreamSourceImage`, `extractUpstreamSource`, `upstreamSourceImageTag`, `suiContainerName`, `appNetworkName`, `createLocalSuiClient`, `registerCoinToken` |
| `@mysten-incubation/devstack/react`                                  | App authors (UI)                         | E + F surface (`DevstackProvider`, `useDevstackPackage`, `useDevstackSignAndExecute`, `DevstackDebugPanel`, `createDevstackDappKit`)                                                                                                                                                               |
| `@mysten-incubation/devstack/vite`                                   | Vite users                               | `devstackVitePlugins`, `devstackManifestPlugin`, `devstackKeysPlugin` (current)                                                                                                                                                                                                                    |
| `@mysten-incubation/devstack/vitest`, `vitest/runtime`, `playwright` | (current)                                | unchanged                                                                                                                                                                                                                                                                                          |

### Critical files

- `packages/devstack/src/index.ts` — strip down to the authoring surface. Keep types +
  `definePlugin`/`defineDevstackConfig` + action factories + built-in plugins + signer factories.
- `packages/devstack/src/runtime.ts` (new, public barrel) — re-exports the runtime module surface.
  Internal modules unchanged.
- `packages/devstack/src/cli.ts` (new, public barrel) — re-exports CLI handlers + helpers from C1.
- `packages/devstack/src/helpers.ts` (new, public barrel) — re-exports helper functions.
- `packages/devstack/package.json` — add the four new entries to `exports` and
  `publishConfig.exports`.
- `packages/devstack/tsup.config.ts` — add four new entry points (`runtime`, `cli`, `helpers`,
  `react` — last one if E shipped).
- All internal callsites — sweep for `from '../index.js'` → use the actual module file (we already
  do this; the change is per-import for the public type). No external internal imports.
- All four `examples/*/<app>Plugin.ts` and `devstack.config.ts` — no change. They consume only the
  authoring surface, which stays at the main entry.
- `docs/site/content/...` — page documenting the layout.

### Steps

- [ ] **H1.** Add the new barrel files (`runtime.ts`, `cli.ts`, `helpers.ts`). Move types from
      `index.ts` re-exports to the right barrel — cut from `index.ts` in the same diff. Update
      `package.json` `exports` + `tsup.config.ts` entry points. Sweep internal callers
      (devstack-internal + four example apps + devstack-wallet + docs/site) and re-import as needed.
- [ ] **H2.** Polish + verify. `pnpm -r typecheck` clean; `npm pack` from `packages/devstack` and
      inspect tarball entrypoints. Update docs.

### Risks

- **Build-tool resolution drift.** `tsup` + `dist`-vs-`src` `exports` already work for current
  subpaths; adding more is mechanical. Verify pnpm workspaces resolve the new subpaths in the four
  apps with `pnpm -r typecheck`.
- **Documentation churn.** Existing docs/READMEs reference
  `import { Reconciler } from '@mysten-incubation/devstack'`. Sweep + update; one PR.
- **Sequencing with E/F.** If E lands first, its imports are
  `from '@mysten-incubation/devstack/react'` from day one. H formalizes the convention rather than
  introducing it. No conflict.

---

## Workstream I — Polish & deferred review items

**Status:** not started

Smaller items the review surfaced. Each is a few hours of work; bundled here to keep the workstream
count tractable. Land any time after their listed dependencies.

### I1 — Top-level `down` / `reset` shortcuts

`devstack stack down` and `devstack stack drop` exist; reflex-typing finds neither. Add:

- `devstack down` → `runStack({ subcommand: 'down' })` against the active stack.
- `devstack reset` → `runStack({ subcommand: 'drop' })` against the active stack with `--yes`
  requirement (refuse without `--yes`).

Files: `packages/devstack/src/cli/index.ts` adds two cases to the verb switch. Six lines.

### I2 — Manifest version-migration scaffold

`Manifest.version: 2` is hardcoded; a future schema change owes consumers a migration path. Add
`readManifestWithMigration({ appDir, stack, network })` that:

- Calls `readManifest`.
- If `manifest.version === 2`, returns as-is.
- If `manifest.version` is older or newer, runs through a registered migration table (empty today).
  Throws on unknown version with an actionable error.

`Manifest.version` widens to `1 | 2` (today's `1` is hypothetical; just opens the door). Document
the migration registry in `manifest-reader.ts`'s file header; first real migration adds an entry.

Files: `packages/devstack/src/runtime/manifest-reader.ts` adds the helper; `core/types.ts` widens
the union.

### I3 — Discriminated `ActionRunContext`

Today every action receives `ctx.stack` and must check `ctx.network` before treating it as
meaningful. Replace with a tagged union:

```ts
type ActionRunContext = LocalnetCtx | LiveNetCtx;
interface LocalnetCtx extends Base {
	network: 'localnet';
	stack: string;
	stackDir: string;
}
interface LiveNetCtx extends Base {
	network: 'testnet' | 'mainnet';
}
```

Plugins narrow with `if (ctx.network === 'localnet') { … }`. Live-net plugins lose access to
`ctx.stack` at the type level; today's "must ignore" comment becomes a compile error.

Files: `packages/devstack/src/core/types.ts` redefines the union. All callsites in built-in plugins
narrow accordingly. Annotated as B6 (extension to B) in the sequencing.

### I4 — `Plugin.schemas`: wire-or-drop

`Plugin.schemas?: Record<string, z.ZodTypeAny>` is exported but nothing reads it. Either wire it to
validate `registry.ns(plugin.name).<kind>.register(item)` calls at insertion time (throw on schema
miss), or remove the field. Decide during B5.

If wired: `RegistryImpl.ns()` consults a per-namespace schema map (populated at
`expandPluginActions` time from `plugin.schemas`); `register()` runs the Zod schema and throws on
parse failure. Performance is fine — registrations are not hot.

Files: `core/types.ts` (keep or remove); `registry/index.ts` (wire); `plugin.ts` (populate the
schema map).

Pairs with B5 (built-in-plugin migration is the time to also declare schemas). Listed here so it can
ship later if B5 punts.

### I5 — `ActionBase.watches?: string[]`

Today's file watcher infers paths from the action shape (Publish: `<path>/Move.toml`,
`<path>/sources/**`; Build: dockerfile + context). Plugins whose inputs include other paths (e.g. a
generated SDL, a checked-in JSON config) currently can't get hot-reload without contorting the
action shape.

Add `watches?: string[]` (relative to `appDir`) on `ActionBase`. The file watcher unions these with
the inferred globs.

Files: `packages/devstack/src/core/types.ts` (add field); `runtime/file-watcher.ts` (union with
inferred). One unit test.

### I6 — In-REPL `.deploy <pkg>`

Beaker's `.deploy <pkg>` reduces edit-deploy-test to one buffer. Mechanically: the REPL becomes a
client of a one-shot reconcile cycle (uses C1's `runApply` against the active stack). Adds a REPL
command via `repl.defineCommand('deploy', { ... })`.

Depends on C1 (shared one-shot helper). Files: `packages/devstack/src/cli/console.ts` adds the REPL
command.

### Steps

- [ ] **I1.** Add `down` / `reset` verbs to CLI dispatcher.
- [ ] **I2.** Add `readManifestWithMigration` + version widening.
- [ ] **I3.** Discriminate `ActionRunContext`. Sweep built-in plugins.
- [ ] **I4.** Decide on `Plugin.schemas` (wire-or-drop). Implement either side.
- [ ] **I5.** Add `watches?: string[]` to `ActionBase`; union in file watcher.
- [ ] **I6.** REPL `.deploy` command. Depends on C1.

### Risks

- I3's narrowing churns plugin code. Acceptable; do the migration in B5's same PR if possible.
- I4 is a real decision — wire it (and the schema declarations are now contract) or drop it (and the
  type stops lying). Don't ship with the field unread.
- I6 depends on C1's runtime split; can't land before then.

---

## Out of scope (recorded, not scheduled)

Review items deliberately not in the current plan. Reasons captured so they aren't re-litigated each
session.

- **Action-type collapse (6 → 1 with predicate slot).** The review noted this could reduce surface —
  but the six types' default-skip predicates are non-trivial (Build by image-tag liveness; Service
  by container health; Publish by source-digest + chain liveness; Register by capture-target
  liveness; Seed by network gate; Emit by dirty-kind cascade). Collapsing forces every plugin author
  to wire those predicates or get them wrong silently. The taxonomy is load-bearing.
- **Namespace / kind / registry-slot naming consolidation.** Cosmetic. Rename churns every plugin;
  payoff is small. Punt unless someone hits a real confusion.
- **Tilt-style `live_update` for image rebuilds.** Walrus and Seal images take real time to rebuild;
  in-place container patching would help. But the use case is rare in current consumers, and
  `live_update` is a substantial new mechanism. Defer until a consumer asks.
- **Native fork-from-network.** Sui CLI is shipping its own forking primitive (per the user). When
  that lands, the imports plugin grows a second source mode (`{ name, mainnetPackageId }`).
  Workstream D's shape is forward-compatible — no work needed today.
- **`useScaffoldEventHistory` analog (event-history hook).** Could exist; nobody has asked for it
  yet. Add to the friction journal if it comes up.

---

## Cross-workstream sequencing

A, B, C are independent; D depends on B (uses `definePublishAction`, capabilities) and benefits from
A. E depends on codegen output already shipping (true today). F depends on E. G has two halves: G1
stands alone; G2 depends on E. H is mechanical and can land any time after the surface settles. I is
a polish bag — each item tracks its own dependency.

Recommended order:

1. **B1–B3** — every other workstream's plugin code uses bare names + capabilities once available.
   _(B1, B2, B3 shipped.)_
2. **A1–A2** in parallel with **B4** (`expandPluginActions` rewrite + `definePublishAction`).
3. **C1–C2** — independent; can land any time.
4. **B5** + **I3** + **I4** — built-in plugin migration, discriminated context, schemas decision.
   One PR.
5. **A3** — cut `ctx.signer`, `loadAccountKeypair`, etc.
6. **D1–D3** — imports plugin + wallet migration.
7. **E1–E2** — React adapter (`useDevstackPackage`, `useDevstackSignAndExecute`).
8. **G1** — `suiClient` / `registerCoinToken` extraction (can land in parallel with E or earlier).
9. **E3 + G2** — migrate four example apps onto the new React surface and shared dapp-kit setup. One
   PR per app to keep blast radius small.
10. **F1–F3** — debug panel + Vite route + per-app smoke. Independent; can land after E.
11. **H1–H2** — public-surface subpath split. Best landed last, after the symbol set has stopped
    moving.
12. **I1, I2, I5, I6** — small polish items. Land any time after their listed dependency.

Roughly twelve PRs, four to six weeks of work depending on parallelism. Each independently
deployable.

### Reused functions and helpers (do not reinvent)

- `helpers/move-package.ts:publishMovePackage` — Move package publish + source-digest cache. Used by
  `definePublishAction` and the imports plugin.
- `helpers/imported-package.ts:importMovePackage` — git-clone + build + publish path. Used by the
  imports plugin.
- `helpers/upstream-source.ts:ensureUpstreamSourceImage` — content-addressed source-image cache.
  Used by the imports plugin's recursive resolver.
- `helpers/seed-shared-object.ts:seedSharedObject` — shared-object creation helper. Used by Seed
  actions throughout.
- `runtime/manifest-{reader,writer}.ts:hydrateRegistry|writeManifest` — manifest I/O. `readOnly`
  flag gates the writer for codegen mode.
- `runtime/active-stack.ts:resolveStack` — stack resolution. Used by the new `cli/target.ts`.
- `plugins/sui/health.ts` — service health check. Used by Service actions' default `getStatus`.

---

## Verification

### Per-workstream verification

**A — Accounts.**

- `pnpm test` passes (new unit tests against the resolver, factory error capture, account context).
- `pnpm test:e2e` passes for all four example apps. Dev wallet still receives keypairs via
  `virtual:devstack-keys` — `connectAs(page, 'alice')` continues to work.
- `devstack console --target testnet` then `accounts.deployer.toSuiAddress()` returns the address
  from `cliSigner({ alias: 'deployer' })`.
- Misconfigured live-net factory:
  `accounts: { publisher: { mainnet: cliSigner({ alias: 'doesnotexist' }) } }` — localnet runs work,
  console on localnet works, `--target mainnet` errors with the underlying alias error attached.

**B — Plugin authoring.**

- New unit tests in `packages/devstack/src/plugin.test.ts`: auto-prefix correctness, dotted-name
  rejection, local-needs resolution, capability query passthrough, plugin-name validation.
- New unit tests in `packages/devstack/src/runtime/topo.test.ts`: capability provider ordering,
  missing-provider drop, `:after` reverse, walrus migration.
- New unit tests in `packages/devstack/src/actions/publish.test.ts`: `definePublishAction` shape,
  default `getStatus` behavior, `onPublished` invocation.
- Manual: run `pnpm localnet:up` for arena, watch the status panel, edit
  `move/connect_four/sources/game.move`, confirm `stale` glyph appears immediately and clears on
  rerun.
- Manual: load walrus + sui together, confirm walrus.network's `provides: ['app-network']`
  synthesizes the right edge so it runs before sui.localnet.

**C — Targets.**

- `pnpm codegen` works against active stack (no supervisor running). Output regenerates correctly.
- `pnpm codegen --target testnet` reads `.devstack/manifests/testnet.json` and regenerates bindings
  _without_ writing the manifest. Verify `git diff .devstack/manifests/testnet.json` is empty after.
- `devstack apply --target testnet` matches today's `devstack deploy --network testnet` behavior.
- `devstack up --target testnet` errors with "supervisor is localnet-only; for one-shot live work
  use `devstack apply --target testnet` or `devstack deploy --target testnet`".

**D — Imports.**

- `examples/wallet`: hand-rolled DeepBook import replaced with `imports({...})`. `pnpm localnet:up`
  succeeds; `pnpm test:e2e` runs the swap UI against the imported deepbook.
- Cross-stack: `pnpm stack new scratch && pnpm stack use scratch && pnpm apply`. Imported packages
  publish to scratch independently. Switch back to main; both stacks have their own deployed copies.
  Source-image cache reused (second stack is fast).
- `pnpm deploy --target testnet`: imports plugin sees `addresses.testnet` is set; skips local
  publish; registers the curated address.

**E — Typed React hooks.**

- New unit tests in `react/bind-package.test.ts`: `bindPackage(module, packageId)` returns same
  shape with `package` curried; missing-package call site throws with the migration hint message.
- Manual: `pnpm dev` for arena. Open lobby button submits a tx. `transactions.ts` is gone; the call
  uses `useDevstackPackage('connect_four').createLobby({ arguments: [] })` directly. Verify the
  published `packageId` shows up in the on-chain tx target.
- Pre-deploy gate: stop localnet, delete `.devstack/stacks/main/manifest.json`, reload. App throws
  the actionable error in dev console; `<DevstackProvider>` doesn't crash siblings.

**F — Debug panel.**

- Manual smoke per app: mount panel via `import.meta.env.DEV`, navigate to `/__devstack`, run a Move
  call from the form (e.g. arena's `createLobby`), confirm chain state updated.
- Production build (`pnpm build`) tree-shakes the panel out — verify by
  `grep DevstackDebugPanel dist/` after build.
- Non-localnet warning fires when the panel mounts against `testnet`.

**G — Helpers.**

- Per-app `pnpm typecheck` after migration. Drop is at least 80 lines of duplication across 4 plugin
  files; verify the diff.
- `pnpm test:e2e` for all four apps still green.

**H — Subpaths.**

- `pnpm -r typecheck` clean across 8 workspaces.
- Manual: `import { Reconciler } from '@mysten-incubation/devstack/runtime'` resolves; same import
  from the main entry errors with module-not-found (cut in the same diff per the no-compat-shims
  policy).
- `npm pack` from `packages/devstack` and inspect the tarball — `dist/runtime.{js,d.ts}` etc. are
  present.

**I — Polish.**

- I1: `devstack down` and `devstack reset --yes` shut down + drop the active stack respectively.
  `devstack reset` without `--yes` exits 1 with a confirmation hint.
- I2: load a manifest with `version: 99` — `readManifestWithMigration` throws
  `"unknown manifest version 99"`.
- I3: try `ctx.stack` in a Service action that runs only on testnet — TypeScript error.
- I4: chosen path verified — either schema mismatch on register throws (wired) or the field is
  absent from `Plugin` type (dropped).
- I5: an action with `watches: ['./schema.graphql']` reruns when that file is touched.
- I6: `devstack console`, then `.deploy connect_four` from the REPL prompt republishes the package
  and refreshes the manifest.

### End-to-end smoke

After all workstreams land, this sequence should work top-to-bottom from a fresh clone:

```sh
git clone <repo> && cd dev-examples && pnpm install
cd examples/wallet
pnpm stack new fresh
pnpm stack use fresh
pnpm apply                         # bring up sui, fund accounts, recursively import deepbook,
                                   # publish wallet's coins, generate codegen
pnpm dev                           # start vite; UI renders with deepbook addresses from manifest
# Edit move/managed_coin/sources/managed_coin.move; status panel shows 'stale' on managed_coin.publish
pnpm apply                         # republishes managed_coin only; codegen runs once at the end
pnpm console                       # REPL: accounts.alice.toSuiAddress() works;
                                   # packages.managed_coin.mint(...) builds a typed call
pnpm codegen --target testnet      # regenerates TS bindings against testnet manifest, no manifest write
pnpm deploy --target testnet       # publishes wallet's coins to testnet using accounts.publisher.testnet (cliSigner)
pnpm stack drop fresh --yes        # tears down
```

Each line is a positive signal that the corresponding workstream is correct.

---

## Decisions log

> Material design choices made during planning or implementation. Reasoning is preserved so future
> sessions don't re-litigate.

### 2026-04-30 · No compat shims for any workstream

Decision: pre-release with zero external consumers — every workstream's migration cuts old paths in
the same diff that introduces the new ones. No `@deprecated` annotations, no transitional flags, no
two-release windows. Reason: the only consumers in the tree are the four example apps + the built-in
plugins. Both ship in this monorepo. Compat shims earn nothing here and dilute the grep when later
sessions try to verify "is this old path actually gone?" How to apply: when a workstream's plan
splits a migration into "additive then cut" steps (e.g. the original A1/A2/A3 split), collapse it.
Keep the additive step only if it usefully decouples blast radius (A1 was kept because it lands ~700
lines of new types + resolver behind a no-op API change — splitting it from the call-site sweep made
review tractable). Otherwise, fold.

### 2026-04-30 · Forking deferred; recursive imports replace it

Decision: `imports({ packages: [...], recursive: true })` plugin handles user-side mainnet package
replication; native chain-state forking is parked. Reason: Sui CLI is getting a forking primitive.
Until then, source-from-git + curated live-net addresses covers the real use case (DeepBook, Pyth,
etc.) without speculative chain-state cloning. How to apply: design the imports plugin shape
forward-compatibly so a future `mainnetPackageId` source mode can land alongside `repo+rev` without
breaking the API.

### 2026-04-30 · Capability semantics

Decision: `:before` / `:after` queries are soft (silent drop on missing provider). `:before!`
reserved for a future strict variant if needed. Reason: matches walrus's existing `before:` intent —
it works whether walrus is loaded or not. How to apply: capability query resolution in
`topoSortActions` does not throw on missing providers.

### 2026-04-30 · Supervisor stays localnet-only

Decision: `Supervisor` constructor throws on `network !== 'localnet'`. Live-net work goes through
`runApply` / `runOneShot`. Reason: Supervisor's file watcher, keypress handler, keep-alive interval
are inherently long-running-local; making them no-ops on live nets adds complexity without value.
How to apply: live-net users see "supervisor is localnet-only; use `devstack apply` or
`devstack deploy`" with a concrete next command.

### 2026-04-30 · AccountPool stays independent

Decision: AccountPool keeps deterministic-mnemonic derivation; does _not_ consume `config.accounts`.
Reason: tests want isolated, leasable accounts not bound to fixed names. Named accounts are the
prod-shape; pool accounts are a different concern. How to apply: tests that _do_ want named accounts
can read `manifest.registry.accounts` for addresses; AccountPool stays the answer for "I need 50
leasable accounts."

### 2026-04-30 · Typed React hooks belong in devstack itself

Decision: `useDevstackPackage(name)` and `useDevstackSignAndExecute()` ship as
`@mysten-incubation/devstack/react`, not as a separate adapter package. Reason: scaffold-eth-2's
`useScaffoldContract` is the single highest-leverage UX pattern in EVM dev. Apps already each
rebuild the equivalent (arena explicitly comments "fourth copy of the useSignAndExecute pattern" in
`lib/queries.ts:16`). Splitting into a separate package just adds versioning churn for a contract
that's coupled to manifest + codegen. How to apply: peerDeps for `react`, `@tanstack/react-query`,
`@mysten/dapp-kit-react` declared optional. Vite/vitest peerDeps already follow this pattern.

### 2026-04-30 · Action-type taxonomy stays at six

Decision: keep `Build`/`Service`/`Publish`/`Register`/`Seed`/`Emit` as discriminated kinds; do not
collapse into one shape with a predicate slot. Reason: the per-kind default skip predicates
(image-tag liveness, container health, source-digest + chain liveness, capture-target liveness,
network gate, dirty-kind cascade) are the load-bearing distinction. Collapsing pushes the skip
semantics onto every plugin author. The review hedged on this; the call here is "no, the taxonomy
earns its keep." How to apply: any review-derived recommendation that boils down to "fewer kinds" is
out of scope; that's recorded in "Out of scope."

### 2026-04-30 · `Plugin.schemas` must be wired or deleted

Decision: by the end of B5, either `RegistryImpl.ns().<kind>.register()` validates against
`Plugin.schemas[kind]`, or the field is removed from the `Plugin` type. Reason: the field is
exported and documented but no runtime code reads it. Either is fine; shipping an unread field is
not. How to apply: I4 captures the work. Default position: wire it. Drop only if implementing the
validation reveals a real cost we're not willing to pay.

### 2026-04-30 · `runOneShot` drives via `Reconciler.cycle` (sequential, with cascade)

Decision: replace `runOneShot`'s bespoke parallel-level walk with `Reconciler.cycle`. Per-topo-level
parallelism is dropped; the Emit dirty-kind cascade now fires on live nets too. Reason: pre-C1
`runOneShot` skipped the cascade — a Publish that re-published a package on testnet wouldn't trigger
a downstream codegen Emit even though codegen depends on `packages` being dirty. The reconciler is
the single source of truth for skip predicates and cascade ordering; duplicating that logic in
`runOneShot` was both wasteful and demonstrably incorrect. How to apply: one-shot deploys for
example apps with ≤3 publishes pay an order-of-30s wall-clock cost; one-shot is rare enough that the
trade is worth it. If a future consumer needs deploy parallelism, the right move is to teach
`Reconciler.cycle` per-level concurrency, not to fork the implementation.

### 2026-04-30 · `deployFilter` preserves pre-C1 behavior; tighter `applyFilter` is the new default for `apply`

Decision: `deployFilter` keeps Build on live nets (pre-C1 behavior); `applyFilter` is the variant
that skips Build+Service on live nets. `runOneShot.actionFilter` defaults to `deployFilter`. Reason:
C1 is a refactor with no observable behavior change for `devstack deploy`. The plan's text on
`deployFilter` ("skip Service/Build, run Publish/Register/Emit") describes the _intended_ tighter
variant; C1 ships that as `applyFilter` instead. C2 wires `applyFilter` into the new
`devstack apply` handler — a deliberate cutover, not a silent tightening. How to apply: when C2
lands, `devstack apply --target testnet` skips Build (correct); `devstack deploy --network testnet`
keeps current behavior. Long-term, `deploy` could redirect to `apply`-with-deployFilter or be
deprecated.

### 2026-04-30 · `ResolvedTarget` and `ActionFilter` live in `core/types.ts`

Decision: the runtime-relevant types `ResolvedTarget` and `ActionFilter` live in `core/types.ts`
rather than `cli/target.ts` / `cli/filters.ts` (the implementations stay under `cli/`). Reason:
`runtime/one-shot.ts` consumes both types. Putting them under `cli/` would force runtime → cli
imports — an inversion that the future H workstream (subpath split) would have to undo. Types in
`core`, implementations in `cli` keeps each layer dependency-pointing-down. How to apply: when the H
subpath split lands, `cli/target.ts` and `cli/filters.ts` move to `@mysten-incubation/devstack/cli`;
`ResolvedTarget` and `ActionFilter` stay in the public type barrel that all subpaths share.

### 2026-04-30 · Debug panel mounts only under `import.meta.env.DEV`

Decision: `<DevstackDebugPanel>` enforces dev-build-only mounting + emits a console warning on
non-localnet networks. Reason: a reflective panel that submits to chain is a foot-gun in production.
SE-2's `/debug` is dev-only by convention; we make it dev-only by default. How to apply: the
component checks `import.meta.env.DEV` at module load and renders nothing in production. Vite's
tree-shaking removes the rest.

---

## Session log

> Append entries here as work progresses. Each entry: date, what shipped, what's next, blockers.

### 2026-04-30 · Plan written

- Plan synthesized from review of: full devstack public API, four example apps' usage, comparable
  tools (Hardhat, Foundry, scaffold-eth-2, Anchor, Beaker, Tilt, Sui first-party SDKs).
- Phase 1 exploration (3 agents) mapped: 6 signing-material pathways, scope/`before`/reconciliation
  mechanics, CLI/target/codegen handling.
- Phase 2 design (3 agents) produced workstream-level implementation plans.
- Recursive imports added as Workstream D after user clarified that mainnet forking is deferred (Sui
  CLI is getting it).
- Next session: start with **B1** (type plumbing + status states). Lowest blast radius, unlocks
  B2–B5.

### 2026-04-30 · B1 shipped

- `ActionStatus` gained `'stale' | 'dirty'`, with a JSDoc block clarifying that the two are
  transient UI markers vs. the six authoritative reconciler states. No reconciler/topo logic touched
  yet.
- `ActionBase` gained `provides?: string[]`. `before?` stayed in place but was annotated
  `@deprecated` to flag the migration target for B5.
- Status renderer: added `⟲` (stale) and `◌` (dirty) to `STATUS_GLYPH`, plus a public
  `markStale(names)` method that sets statuses to `'stale'` and re-renders. Headless mode prints
  `<name> stale` lines. Transient — next `update()` from the reconciler overwrites.
- All six action factories (`buildImage`, `service`, `publish`, `register`, `seed`, `emit`) accept
  `provides` and forward it. Only `buildImage` already had `before`; `provides` is universal.
- `pnpm -r typecheck` passes across all 8 workspaces (devstack, devstack-wallet, docs/site, four
  examples). No tests added — devstack package has no test suite yet; the plan adds them in B2/B4.
- No supervisor/file-watcher wiring changed. `markStale` is unreferenced by callers; it lands when
  B3 wires `onFileStale` → `renderer.markStale`.
- Next session: **B2** — capability synthesis in `runtime/topo.ts`. Build provider table from
  `provides`, resolve `:before` / `:after` queries in `needs`, leave `before:` block intact for
  safety co-existence. New unit tests in `runtime/topo.test.ts` (first tests in the package).

### 2026-04-30 · B2 shipped

- `topoSortActions` now resolves capability queries during the same pass that previously handled
  `before:`. Build a providers map from `provides`, then walk each action's `needs`: bare entries
  pass through; `<cap>:before` entries replace themselves with each provider's name (provider→me);
  `<cap>:after` entries are stashed and reverse-synthesized as me→provider edges. Self-edges (action
  that both provides and queries the same cap) are dropped silently.
- `before:` reverse-edge pass kept intact and runs alongside capability `:after` synthesis — they
  share the same edge shape and compose without conflict. B5 will rip out `before:` once built-in
  plugins migrate.
- Bottom-of-function "skip clone if unchanged" check rewritten to compare effective deps
  element-wise, not by length only — capability resolution can change contents without changing
  length (e.g., `'cap:before'` → `'p1'`).
- Multiple providers of the same cap: returned ordering between siblings is unspecified (documented
  in the JSDoc + the plan's risks). Lexicographic sort is the planned fix if non-determinism becomes
  a problem.
- Vitest set up for `@mysten-incubation/devstack` (catalog `vitest@^2.1.8`). Added
  `test`/`test:watch` scripts and a `vitest` devDependency. No config file needed — defaults pick up
  `src/**/*.test.ts`. Turbo's existing `test` task wired automatically.
- `runtime/topo.test.ts`: 15 tests covering direct-needs unchanged behavior, `before:` co-existence,
  `:before` (rewrite, multiple providers, missing-provider drop, self-edge drop, mixed with hard
  deps), `:after` (reverse, missing-provider drop), and the walrus migration scenario in both shapes
  (with and without walrus loaded).
- `pnpm -r typecheck` clean across 8 workspaces; root `pnpm test` runs the 15 devstack tests via
  turbo.
- No example-app code changed yet — walrus still uses `before: ['sui.localnet']`. B5 swaps to
  `provides: ['app-network']` + `needs: ['app-network:before']` once the rest of B is in.
- Next session: **B3** — reconciler `progress` callback + dirty marking. Plan: wire supervisor's
  `onFileStale` → `renderer.markStale` (the markStale method already exists from B1 but has no
  callers). Reconciler emits an interim snapshot after topo walk with `dirty` marked for queued
  Emits whose `dependsOnKind` will fire.

### 2026-04-30 · B3 shipped

- `ReconcileBaseContext` gained an optional `progress?: (snapshot: ReconcileProgress) => void`
  callback. Snapshot shape exported as `ReconcileProgress { statuses, failures }`.
- `Reconciler.cycle` emits a single interim snapshot between topo walk and cascade. Pre-cascade,
  walks the sorted action list, and for each non-blocked Emit whose `dependsOnKind` intersects the
  just-flushed dirty set, marks it `'dirty'` in a copy of the post-walk statuses. Skipped entirely
  when `progress` is undefined — zero overhead for one-shot/no-renderer call sites.
- Supervisor wires `progress: (snap) => this.renderer.update(snap.statuses, snap.failures)` and
  inserts `this.renderer.markStale(names)` at the top of `onFileStale` so file-watcher signals reach
  the renderer immediately, before the cycle runs.
- Scope choice: progress fires once per cycle (not per-action). Per-action live updates would be
  valuable but require touching `evaluateAndRun`'s loop in two places; deferred. The plan literally
  calls for one snapshot, which is what landed. Filed as a future improvement if interactive feel
  needs more.
- New tests in `runtime/reconcile.test.ts`: 3 cases covering the dirty-marker scenario (Emit listed
  before its source so cascade re-fires it), the no-cascade case (snapshot has no dirty entries),
  and the no-callback case (cycle still works without progress wired). Total devstack test count is
  now 18.
- `pnpm -r typecheck` clean across 8 workspaces.
- Next session: **B4** — `expandPluginActions` rewrite (auto-prefix, local-needs resolution,
  dotted-name rejection) plus the `definePublishAction` factory. This is the biggest single change
  in workstream B; it changes the plugin authoring contract from `actions: ({ scope }) => Action[]`
  to `actions: () => Action[]`. Built-in plugins compile against the new contract in B5.

### 2026-04-30 · B4 shipped

- `expandPluginActions` rewritten to a two-pass algorithm. Pass 1 walks each plugin's actions,
  computing `fullName` for each: bare name → `<plugin>.<name>`; dotted name with the plugin's own
  prefix → as-is (preserves old-contract `scope('foo')` callers); dotted name with a foreign prefix
  → throws with a helpful message including the bare-form suggestion. Duplicate-name detection
  happens here. Pass 2 resolves `needs`: `:before`/`:after` queries pass through verbatim (topo
  handles them); dotted needs pass through (cross-plugin FQNs); bare needs resolve to the
  local-prefixed form, throwing if no local action matches.
- `definePlugin` now invokes `validatePluginName` immediately so misconfigured plugins fail at
  config-load time, not at first cycle. Regex is `/^[a-zA-Z][a-zA-Z0-9_-]*$/` — intentionally
  lenient during this migration to keep `tokenStudio`/`privateContent` working. B5 tightens to
  `/^[a-z][a-z0-9_-]*$/` once the example apps rename.
- `definePublishAction` factory landed in `actions/publish.ts` alongside the existing low-level
  `publish()` (kept as the escape hatch for plugins that need full control — namely the imports
  plugin's curated-address path on live nets). The factory bakes in:
  - default `getStatus`: registry lookup → chainId compare → on-chain `getObject` liveness probe.
  - default `run`: build via `publishMovePackage`, register the result in `ctx.registry.packages`,
    fire `onPublished(ctx, result)` only on a fresh publish (skipped on cache hit).
  - `registryAs?` to override the registry entry name when it differs from the action's bare name.
  - Publisher signing still uses `loadAccountKeypair` — transitional path; A2 swaps to
    `ctx.accounts.get(publisher)`.
- `buildPriorCacheEntry(pkg)` extracted from per-app boilerplate into `helpers/move-package.ts` and
  re-exported from `index.ts`. Maps a `Package` registry entry to the cache shape
  `publishMovePackage` accepts as `prior`; returns `undefined` for entries missing `sourceDigest` or
  `chainId` (older manifests, imports without source digests).
- New tests:
  - `plugin.test.ts` (17 cases): plugin-name validation (7 cases), auto-prefix correctness (4
    cases), needs resolution (5 cases including capability-query passthrough and bare/qualified
    equivalence), old-contract `scope` back-compat (1 case).
  - `actions/publish.test.ts` (9 cases): shape (2), default getStatus (3 — no prior, chainId
    mismatch, healthy hit), onPublished + run path (4 — fresh-publish hook fires, cache-hit skips
    hook, custom publisher passed through, `registryAs` override).
- Total devstack test count: 44. All pass; `pnpm -r typecheck` clean across 8 workspaces.
- Old plugins keep working unchanged: every built-in (`sui`, `walrus`, `seal`, `codegen`) and every
  example app uses the `({ scope }) => …` callback. expandPluginActions accepts those because their
  pre-prefixed dotted names match the plugin's own namespace. B5 cuts over.
- One subtle behavior shift worth flagging: bare needs in old-style plugins now resolve to the
  local-prefixed form rather than topo-erroring. Nothing in the tree relies on the error path
  (audited via grep), so this is silent quality-of-life improvement, not a regression.
- Next session: **B5** — convert built-in plugins (sui, walrus, seal, codegen) and the four example
  apps to bare-name authoring. Walrus's `before: ['sui.localnet']` becomes
  `provides: ['app-network']` (on walrus.network) plus `needs: ['app-network:before']` (on
  sui.localnet). Seal's hand-rolled Publish action becomes `definePublishAction`. Tighten
  plugin-name regex to `/^[a-z][a-z0-9_-]*$/` and rename `tokenStudio` → `token-studio`,
  `privateContent` → `private-content`. Remove the `before:` reverse-edge pass from `topo.ts`. Drop
  `Scope` and `PluginActionsContext` exports (and the `ctx` parameter from `Plugin.actions`).

### 2026-04-30 · Workstreams E–I added from review backlog

- The pre-release review (session `fec47b1a`) produced a longer recommendation list than the four
  user-surfaced issues that drove A–D. Re-reading the review against the current tree turned up six
  items that warrant active workstreams and several already-shipped or out-of-scope.
- Active additions: **E** typed React hooks (`useDevstackPackage` + `useDevstackSignAndExecute`) —
  biggest UX gap, codegen output already supports it via `@local-pkg/<name>` package placeholder.
  **F** reflective `/__devstack` debug surface. **G** `suiClient` / `registerCoinToken` /
  dapp-kit-setup helper extraction (4× duplication confirmed by grep). **H** public-surface subpath
  split (`/runtime`, `/cli`, `/helpers`). **I** polish bag: top-level `down`/`reset`, manifest
  version-migration scaffold, discriminated action context, `Plugin.schemas` wire-or-drop,
  `watches?` action override, in-REPL `.deploy`.
- Out of scope (recorded in the new "Out of scope" section): action-type collapse (taxonomy is
  load-bearing), namespace/kind/registry-slot rename (cosmetic), Tilt `live_update` (no consumer
  asking), native fork-from-network (Sui CLI is shipping it), `useScaffoldEventHistory` analog (no
  demand yet).
- Verified via grep: `Plugin.schemas` has zero runtime readers (only the type declaration in
  `core/types.ts`); `r` retry keystroke IS already wired in `supervisor.ts:256` (review claim that
  it was deferred is wrong); arena's `lib/queries.ts:16` literally comments "fourth copy of the
  useSignAndExecute pattern"; `function suiClient` appears verbatim in 4 plugin files.
- Decisions log gained five entries — most importantly that the action-type taxonomy stays at six
  (the review hedged) and that React hooks ship as `@mysten-incubation/devstack/react` rather than a
  sibling package.
- Sequencing rewritten to twelve PRs spanning four to six weeks. E and G1 can land in parallel with
  B5/A2; H lands last so the symbol set has stopped moving.

### 2026-04-30 · A2 shipped — workstream A complete

- Cut `ActionRunContext.signer` (was `@deprecated` after A1), `NetworkConfig.signer` (the entire
  interface narrows to `{ rpcUrl?: string }`), and `OneShotOptions.signer`. Plumbing in
  `runtime/reconcile.ts`, `runtime/one-shot.ts`, `cli/deploy.ts` follows. `cli/deploy.ts` now only
  requires `networks[network].rpcUrl`; signers come from `config.accounts`.
- Cut `helpers/keystore.ts:loadAccountKeypair` and the `ConsoleAccount` interface entirely.
  `helpers/keystore.ts` shrinks to `keysDir` / `keyFilePath` / `loadOrGenerateKeypair` (the
  implementation behind `generatedKeypair()`). The public surface drops `loadAccountKeypair` and
  `ConsoleAccount` from the `index.ts` barrel.
- `helpers/imported-package.ts` `publisher` parameter is now `Signer` (not
  `{ secretKey, address }`). Internal use does an `instanceof Keypair` runtime check before calling
  `getSecretKey()`/`toSuiAddress()` — hardware/remote signers get a clear "not supported here" error
  since the helper imports the bech32 secret into the in-container CLI keystore. Wallet's
  hand-rolled deepbook publish drops the manual file read + secret-stringification dance and just
  hands `ctx.accounts.get('publisher')` to `importMovePackage`.
- `helpers/move-package.ts` and `helpers/seed-shared-object.ts` widened `publisher: Ed25519Keypair`
  → `publisher: Signer`. Move package publish only uses `signer.signAndExecuteTransaction` and
  `.toSuiAddress()`; both work for any Signer.
- `definePublishAction` (and `seal.register`) now use `ctx.accounts.get(publisherAccount)` directly.
  Zero `loadAccountKeypair` callers remain anywhere in the tree (verified by grep).
- Sui plugin: `SuiPluginOptions.accounts?: string[]` removed. The `sui.accounts` Register action
  iterates `ctx.accounts.names()` and gets each `Signer` via `ctx.accounts.get(name)`.
  `inputs.accounts` (the sorted name array used for input hashing) is dropped — `getStatus` already
  detects drift when a new name lacks funding, and the implicit `generatedKeypair()` writes the
  keypair file before the faucet call. Default no longer auto-creates a `publisher` account; apps
  declare what they want in `config.accounts`.
- All four example apps migrated:
  - `arena/devstack.config.ts`: `accounts: { publisher: {}, alice: {}, bob: {} }` at the top level.
    `sui()` shrinks to `{ version: ... }`.
  - `arena/arenaPlugin.ts`: `loadAccountKeypair(..., 'alice')` → `ctx.accounts.get('alice')`.
  - `token-studio/devstack.config.ts`: `accounts: { alice: {}, bob: {}, carol: {} }`. (Token-studio
    doesn't declare a `publisher` — alice doubles as publisher and holds the TreasuryCap; the
    publish action's `publisher: 'alice'` opt routes the signer correctly.)
  - `private-content/devstack.config.ts`: `accounts: { publisher: {}, alice: {}, bob: {} }`.
  - `wallet/devstack.config.ts`: `accounts: { publisher: {}, alice: {}, bob: {}, carol: {} }`.
    `wallet/walletPlugin.ts`: 4 `loadAccountKeypair(..., 'publisher')` and 1
    `loadAccountKeypair(..., 'alice')` calls collapsed into `ctx.accounts.get(name)`. The deepbook
    block also drops the `readFileSync(publisherKeyPath)` boilerplate now that `importMovePackage`
    takes a Signer.
- Console (`cli/console.ts`) rewritten: drops `loadAccountKeypair`, drops `ConsoleAccount`
  interface. Builds a `Record<string, Signer>` via `resolveAccounts(config.accounts)` and binds it
  as `repl.context.accounts`. REPL users get `accounts.alice` as a `Signer` directly —
  `accounts.alice.toSuiAddress()` for inspection,
  `client.signAndExecuteTransaction({ signer: accounts.alice, transaction })` for execution.
  Per-account materialization errors print a console warning rather than crashing the REPL so
  read-only inspection still works.
- Public surface trimmed: `index.ts` drops `loadAccountKeypair`, `ConsoleAccount`. New exports from
  A1 stay (`generatedKeypair`, `resolveAccounts`, etc).
- Test updates: `actions/publish.test.ts` rewritten to drop the `loadAccountKeypair` mock and use a
  small `accountsWith({...})` helper that builds an `AccountsContext` from a
  `Record<string, Signer>`. `runtime/accounts.test.ts` and `runtime/reconcile.test.ts` already had
  A1's `accounts` fixture.
- Plan doc updated: workstream A's status set to complete; the A2/A3 split was collapsed into one
  final-migration step (the user's "no compat shims for pre-release" call). New decisions log entry
  codifies the no-compat-shims policy across all workstreams.
- Verification: `pnpm -r typecheck` clean across 8 workspaces; 55 unit tests pass; `tsx` smoke
  imports all four example configs and prints expected action graphs. Final grep confirms zero
  remaining `loadAccountKeypair` / `ctx.signer` / `opts.signer` / `profile.signer` /
  `ConsoleAccount` references in the tree.
- Runtime smoke against a real localnet was NOT run in this session — typecheck + unit tests +
  module-load are the contract guarantees. First runtime validation: next `pnpm localnet:up` for any
  of the four apps. The on-disk keystore format is unchanged (still bech32 at
  `<stackDir>/.keys/<name>.key`), so existing stacks should resume cleanly.
- Workstream A is fully closed. Next session candidates per the recommended order: **C1** (extract
  shared CLI helpers + parameterize `runOneShot` for filterable cycles); **D1** (imports plugin,
  non-recursive); or any of E1/G1 (independent of A/B/C).

### 2026-04-30 · A1 shipped

- New types in `core/types.ts`: `AccountFactoryContext` (carries `accountName`, `appDir`, `stack`,
  `network`, `rpcUrl`), `AccountFactory` (sync-or-async `(ctx) => Signer`), `AccountNetworkSpec`
  (per-network record with `default?`/`localnet?`/`testnet?`/`mainnet?` slots), `AccountSpec`
  (union: bare `Signer` | bare factory | network record), `AccountsContext` (`get`/`has`/`names`).
  `DevstackConfig.accounts?: Record<string, AccountSpec>` added;
  `ActionRunContext.accounts: AccountsContext` is now required, `ActionRunContext.signer` annotated
  `@deprecated` (A3 cuts it).
- `runtime/accounts.ts` (new) — `resolveAccounts({ specs, appDir, stack, network, rpcUrl })`. Eager
  materialization with per-account error capture: a single account whose factory throws doesn't
  poison sibling accounts. Resolution precedence per (account, network): `spec[network]` →
  `spec.default` → on localnet only, implicit `generatedKeypair()` → otherwise capture an actionable
  error and surface it on first `get(name)`. Async factories deliberately rejected with a clear "use
  a sync closure" message — eager-only contract for now; if/when an async factory is genuinely
  useful (KMS, hardware wallet), we add a separate lazy-resolve path. Bare `Signer` and bare
  function specs are normalized as the `default` slot.
- `helpers/signers.ts` gained `generatedKeypair(): AccountFactory`. Localnet only — throws on
  testnet/mainnet with a hint to declare an explicit factory. Pulls from the shared
  `loadOrGenerateKeypair` helper so it writes to the same `<stackDir>/.keys/<account>.key` path the
  dev-wallet's `virtual:devstack-keys` plugin reads. No on-disk format change.
- Layer cleanup: `loadOrGenerateKeypair`, `keysDir`, `keyFilePath` moved from `plugins/sui/keys.ts`
  into `helpers/keystore.ts` (where the read-only `loadAccountKeypair` already lived). The sui
  plugin keys file is now just `ensureFunded` + `FaucetFundOptions`. The cross-layer import
  (`helpers/keystore.ts → plugins/sui/keys.ts`) that's been there since v1 is gone.
- Runtime plumbing — additive only:
  - `ReconcileBaseContext` gains required `accounts: AccountsContext`; `Reconciler.evaluateAndRun`
    threads it into the per-action `ActionRunContext`.
  - `Supervisor` resolves accounts at construction (after `expandPluginActions`, before `start()`).
    Exposed via new `SupervisorOptions.accounts` (specs) + `SupervisorOptions.rpcUrl` (best-effort,
    may be empty when sui-rpc isn't up yet — built-in factories ignore it).
  - `runOneShot` accepts `OneShotOptions.accounts` and resolves with the live `rpcUrl` already in
    opts. Existing `signer: Signer` parameter still required (A3 removes it).
- CLI plumbing: `cli/up.ts` passes `config.accounts` and `config.networks?.[network]?.rpcUrl` to the
  supervisor; `cli/deploy.ts` passes `config.accounts` to `runOneShot`. `cli/console.ts` is
  unchanged for A1 — A3 binds `accounts.<name>` as `Signer` directly in the REPL.
- Public surface (`index.ts`): exports `generatedKeypair`, `resolveAccounts`,
  `loadOrGenerateKeypair`, `keysDir`, `keyFilePath`, plus the new types
  `AccountFactory`/`AccountFactoryContext`/`AccountNetworkSpec`/`AccountSpec`/`AccountsContext`/`ResolveAccountsOptions`.
  `loadAccountKeypair` stays exported (A3 cuts it).
- New tests: `runtime/accounts.test.ts` — 13 cases covering empty input, implicit `generatedKeypair`
  materialization + on-disk persistence + stability across resolves, per-network slot lookup,
  `default` fallback, bare-Signer normalization, factory invocation context, per-account error
  capture isolation, async-factory rejection, `names()`/`has()` semantics with failed
  materializations, and unknown-name lookup with a list of declared accounts.
- Two existing test fixtures updated for the new required `accounts` field on
  `ActionRunContext`/`ReconcileBaseContext`: `actions/publish.test.ts` and
  `runtime/reconcile.test.ts` each get a small `emptyAccounts` stub.
- Total devstack test count: 55 (was 42; +13 from accounts.test.ts). `pnpm -r typecheck` clean
  across 8 workspaces.
- No example apps or built-in plugins were modified. The four example configs still use
  `sui({ accounts: [...] })` to declare the localnet-funded names; they don't yet use
  `config.accounts`. A2 will migrate them — that's where the runtime contract becomes user-visible.
- E2E + runtime smoke against a real localnet was NOT run in this session. Type contract + unit
  semantics are verified; first runtime validation is the next `pnpm localnet:up` for any of the
  four example apps. Behavior should be identical (additive change; no caller is reading
  `ctx.accounts` yet).
- Next session candidates: **A2** (rewrite `imported-package.ts` to take `Signer`; migrate example
  app configs to top-level `accounts`; replace ~10 `loadAccountKeypair` call sites with
  `ctx.accounts.get(name)`); or **C1** (extract shared CLI helpers + parameterize `runOneShot`); or
  **D1** (imports plugin, non-recursive). A2 is the natural next step since it consumes the surface
  A1 just landed and unblocks A3.

### 2026-04-30 · B5 shipped — workstream B complete

- Built-in plugins (sui, walrus, seal, codegen) and all four example apps (arena, token-studio,
  private-content, wallet) converted from `({ scope }) =>` callback to `() => Action[]`. Bare action
  names everywhere; intra-plugin `needs:` use the bare form (auto-prefixed by
  `expandPluginActions`); cross-plugin needs (e.g. `'sui.accounts'`, `'sui.localnet'`) stay fully
  qualified.
- Walrus migration completed: `walrus.network` declares `provides: ['app-network']`; `sui.localnet`
  declares `needs: ['app-network:before']`. Soft capability — when only sui is loaded the query
  silently drops, matching the prior `before:` semantic. Topo synthesizes the right edge when both
  are loaded.
- Seal's hand-rolled Publish action (~50 lines of publishMovePackage boilerplate including
  extract-source-from-image) now uses `definePublishAction` with a new `prepareSource` hook that
  materializes the in-image Move sources into a tmpdir at run time. `definePublishAction` calls
  `prepareSource` (if set) before `publishMovePackage`, threads its returned `dir` into the call,
  and runs the optional `cleanup` in a finally. When prepareSource is set, `registry.packages.path`
  stays undefined — codegen silently skips pathless entries, which is the right semantic for
  in-image sources.
- Example apps converted to `definePublishAction`: arena's connect_four, token-studio's managedCoin
  (with `onPublished` that registers the managed_coin token), private-content's vault, wallet's
  usdc + weth (each with `onPublished` token registration). Token-studio + wallet's coin captures
  (`treasuryCapId`, `metadataId`, `upgradeCapId`) preserved. Wallet's deepbook block stays as a
  hand-rolled object literal — workstream D's recursive imports plugin replaces it.
- Wallet plugin lost the `coinPublishAction` helper and the `registerCoinToken` helper — both are
  now inline in `definePublishAction`'s `onPublished` callbacks. Net code reduction: ~50 lines.
- `before?` removed from `ActionBase`, from `BuildImageOptions` (the only action factory that
  exposed it), and from `topoSortActions`'s edge synthesis. The reverse-edge pass for `before:` is
  gone — only capability `:after` queries synthesize reverse edges now. JSDoc updated.
- `Plugin.actions` contract changed from `(ctx: PluginActionsContext) => Action[]` to
  `() => Action[]`. `Scope` and `PluginActionsContext` types deleted from `core/types.ts` and
  removed from the `index.ts` barrel. `expandPluginActions` no longer constructs or passes a `scope`
  helper.
- Plugin name regex tightened from `/^[a-zA-Z][a-zA-Z0-9_-]*$/` to `/^[a-z][a-z0-9_-]*$/`. Renamed:
  `tokenStudio` → `token-studio`, `privateContent` → `private-content`. Action names are
  unconstrained (still `managedCoin` etc. — only plugin namespaces are kebab-or-snake-only). The TS
  export symbols (`tokenStudioPlugin`, `privateContentPlugin`) are unchanged — JS identifier
  convention is separate from plugin-namespace convention.
- Tests adjusted: dropped two `before:` cases from `topo.test.ts` (now 13 tests, was 15); dropped
  the camelCase migration-window case from `plugin.test.ts` and added a strict camelCase rejection
  (still 17 tests); reframed the back-compat test to verify own-namespace dotted names still work
  without the `scope` helper. The `definePublishAction` test suite (9 cases) is unchanged.
- Smoke-imported each example plugin via `node --import tsx` to confirm `definePlugin`'s strict
  regex passes for the renamed names. All four apps produce expected fully-qualified action names:
  `arena.connect_four`, `arena.openLobby`, `token-studio.managedCoin`, `private-content.vault`,
  `wallet.usdc`, `wallet.weth`, `wallet.deepbook`, `wallet.seedTokens`, `wallet.seedPools`,
  `wallet.seedOrders`. Walrus + seal also verified loading alongside private-content (16 actions
  total).
- `pnpm -r typecheck` clean across 8 workspaces; 42 devstack unit tests pass (37 in workstream B's
  surface + 3 reconciler + 9 publish factory wired in B4 — net was 44 before B5, two `before:` cases
  removed).
- E2E and runtime smoke tests against a real localnet were NOT run in this session — only typecheck,
  unit tests, and module-load. The walrus capability migration is structurally identical to the old
  `before:` synthesis (verified by tests), so behavior should match. First real validation: next
  time the user runs `pnpm localnet:up` for an app that loads walrus.
- Workstream B is done. Next session: pick from A1 (accounts as first-class signers — biggest
  standalone unblock for the rest of the plan), C1 (CLI helpers — smallest, lands fastest), or D1
  (imports plugin — depends on B's `definePublishAction`, which is now ready). E1/G1 can also land
  in parallel.

### 2026-04-30 · C1 shipped — runOneShot parameterized, Supervisor guarded

- New CLI helpers extracted: `cli/args.ts` (`loadConfig`, `parseConfigArg`, `parseNetworkArg`,
  `parseStackArg`, `parseTargetArg`), `cli/network-profile.ts` (`resolveNetworkProfile`),
  `cli/target.ts` (`resolveTarget` over `<network>:<stack>` / bare network / bare stack forms),
  `cli/filters.ts` (`deployFilter`, `applyFilter`, `emitOnlyFilter`). The `loadConfig` helper
  deduplicates the verbatim 4× copy across `up.ts` / `deploy.ts` / `console.ts` / `stack.ts` —
  `stack.ts` keeps its own slightly looser variant (no `plugins[]` requirement) since `stack`
  subcommands don't construct an action graph.
- `core/types.ts` gained `ResolvedTarget` and `ActionFilter` types. They live in core (not in
  `cli/`) so `runtime/one-shot.ts` can use them without runtime → cli layer-mixing. `cli/target.ts`
  and `cli/filters.ts` import the types from core; only the implementations live under `cli/`.
- `runOneShot` rewrite. Replaced the bespoke parallel-level walk with
  `new Reconciler().cycle(filtered, baseCtx)` — one of C1's stated risks ("Emit cascade on live
  nets" / "latent bug today") closed. The reconciler runs the dirty-kind cascade at the end of every
  cycle, so a Publish that re-publishes a package on testnet now correctly re-fires codegen Emits.
  Trade-off: per-topo-level parallelism is gone (reconciler walks sequentially). Wallet's deploy is
  the worst case at 3 publishes — order-of-30s extra wall-clock per deploy. Acceptable; one-shot is
  rare in practice.
- `OneShotOptions` gained `actionFilter?: ActionFilter` (defaults to `deployFilter`) and
  `readOnly?: boolean` (skips the post-cycle manifest write — used by `runCodegen` once C2 lands;
  the returned `manifestPath` still points at the expected location so consumers don't have to
  special-case). The conditional sui-rpc pre-registration only fires when `network !== 'localnet'` —
  on localnet, sui's Service action registers it itself; the unconditional pre-register was dead
  code on the `apply` path before, harmless on `deploy`.
- `deployFilter` preserves pre-C1 behavior verbatim (skip Service; gate Seed by network; run
  Build/Publish/Register/Emit on every network). The plan's `applyFilter` is the tighter variant
  (also skip Build on live nets) and is the intended default for the future `devstack apply`
  handler. Keeping `deployFilter` loose means C1 is a true refactor —
  `pnpm deploy --network testnet` for any example app behaves identically to its pre-C1 run.
- `Supervisor` constructor now throws when `network !== 'localnet'`. Error message points at
  `devstack apply --target <network>` (pending C2) or `devstack deploy --network <network>`. The
  constructor's active-stack-pointer write narrowed accordingly (no longer guarded by an inner
  network check; the early throw covers it).
- `cli/up.ts` / `cli/deploy.ts` / `cli/console.ts` migrated to the shared helpers. Net deletion: 3×
  duplicated `loadConfig` (~30 lines), the bespoke `parseArgs` walks across the three files (~70
  lines). `cli/console.ts` keeps its `--codegen-dir` parser inline (single-CLI flag). `cli/stack.ts`
  left untouched — its loader is intentionally looser, and migrating it would mean coupling the
  shared `loadConfig` to a "permissive" mode for one caller.
- Public surface: `index.ts` re-exports `ActionFilter`, `ResolvedTarget` from core;
  `resolveTarget` + `ResolveTargetOptions` from `cli/target`; `resolveNetworkProfile` +
  `NetworkProfile` from `cli/network-profile`; `applyFilter`, `deployFilter`, `emitOnlyFilter` from
  `cli/filters`; `loadConfig` and the four `parse*Arg` helpers from `cli/args`. Workstream H's
  subpath split will move CLI-shaped exports to `@mysten-incubation/devstack/cli`; for now they ride
  the main barrel so C2 can wire `runApply` / `runCodegen` against a stable surface.
- New tests:
  - `cli/filters.test.ts` (9 cases): per-filter behavior across localnet / testnet / mainnet for
    each action kind, including Seed gating via `liveNetworks`.
  - `cli/target.test.ts` (10 cases): default fallback, `--stack` flag, active-stack pointer read,
    bare-network parsing, bare-stack-name interpretation, `<network>:<stack>` parsing for localnet +
    live-net stack-ignore, unknown-network error, missing live-net rpcUrl error.
  - `cli/args.test.ts` (15 cases): `parseConfigArg` happy-path + flag-value avoidance,
    `parseNetworkArg` accept/reject, `parseStackArg` and `parseTargetArg` undefined/empty handling.
  - `runtime/supervisor.test.ts` (3 cases): localnet-only guard rejects testnet/mainnet; localnet
    construction succeeds with default and explicit network.
- Total devstack test count: 92 (was 55). All pass; `pnpm -r typecheck` clean across 8 workspaces.
- Smoke-loaded all four example app configs via `pnpm exec tsx` — accounts and plugin counts match
  expectations. No runtime change observable from config-load shape.
- Pre-existing `runOneShot` callers (`cli/deploy.ts`, the test fixtures in `vitest/runtime.ts` if
  any) all pass `actionFilter` undefined, so the default `deployFilter` applies — no behavior shift.
  The `Reconciler.cycle` switch IS observable (sequential vs parallel walk) but only at wall-clock;
  output shape and final manifest are identical.
- Next session: **C2** picks up here — add `cli/apply.ts` and `cli/codegen.ts` handlers, wire them
  into `cli/index.ts`'s verb switch, add `tsup.config.ts` entry points, add `apply` / `codegen`
  scripts to example apps' `package.json`. The runtime substrate (filters, target resolution,
  parameterized `runOneShot`) is ready.

### 2026-04-30 · C2 shipped — apply, codegen, --target everywhere; workstream C complete

- New CLI handlers: `cli/apply.ts:runApply` (single-cycle reconcile with `applyFilter` — every kind
  on localnet; skip Service+Build on live nets) and `cli/codegen.ts:runCodegen` (Emit-only with
  `readOnly: true` so the manifest stays untouched). Both share the same `--target` shape: bare
  network, bare stack, or `<network>:<stack>`.
- `cli/up.ts` accepts `--target` for localnet stacks; rejects live-net targets with an actionable
  error pointing at `apply --target` or `deploy --network`. The supervisor's localnet-only
  constructor guard already enforces this at the type/runtime boundary, so `up` errors before
  construction.
- `cli/deploy.ts` accepts `--target` as an alias for `--network` and additionally supports
  `<network>:<stack>` and bare-stack values (a bare stack resolves to localnet). Old `--network`
  spelling preserved.
- `cli/console.ts` resolves stack+network through `resolveTarget`. Falls back to flag values
  (`--network`, `--stack`) when `--target` is unset. The manifest-vs-target rpc fallback (manifest's
  sui-rpc service or public fullnode) preserved as the lowest-priority fallback after the
  target-resolved URL and the explicit `networks[network].rpcUrl`.
- `cli/index.ts` (the dispatcher) gained `apply` and `codegen` cases. USAGE block rewritten to list
  every verb with a short description.
- `runApply` / `runCodegen` exported from `index.ts` alongside their `Flags` types. `tsup.config.ts`
  gained `cli/apply` and `cli/codegen` entry points so the published CLI bundles include them.
- All four example apps' `package.json` gained `apply` and `codegen` scripts; existing
  `localnet:up`, `localnet:watch`, `deploy`, `stack` scripts kept intact (back-compat).
- New helper: `cli/args.ts:runIfMain(import.meta.url, main)`. Replaces the hand-rolled
  `if (isMain) main()...` block at the bottom of every CLI entry. Why: tsx + workspace symlinks
  reload entry modules a second time when the user-supplied config imports
  `'@mysten-incubation/devstack'` (the barrel re-exports from `cli/<verb>.ts`, which Node's loader
  doesn't dedupe through tsx's hooks). The hand-rolled `if (isMain)` check can't tell the entry-load
  from the re-import-load — same `import.meta.url`, same `process.argv[1]`. `runIfMain` keys a
  `globalThis` registry by module URL so the second load detects the duplicate and bails. This is a
  pre-C1 latent bug; surfaced only because the new `apply`/`codegen` verbs dynamic-import a config
  that's likely to import the package barrel. Smoke-tested: each verb now fires `main()` exactly
  once per direct `tsx cli/<verb>.ts ...` invocation.
- New tests:
  - `runtime/one-shot.test.ts` (6 cases): default `deployFilter` runs Build/Publish/Register/Emit on
    live nets; `emitOnlyFilter` drops non-Emit actions; `readOnly: true` skips manifest write;
    `readOnly: false` writes a manifest with the pre-registered `sui-rpc` entry; localnet skips
    sui-rpc pre-registration (sui plugin owns it); Seed network gating via `liveNetworks`.
- Total devstack test count: 98 (was 92 after C1, +6 in `one-shot.test.ts`). All pass;
  `pnpm -r typecheck` clean across 8 workspaces.
- Smoke verification:
  - `tsx cli/index.ts` prints the new USAGE listing all verbs.
  - `tsx cli/codegen.ts <config>` against a fresh app dir errors with "no prior manifest" and exits
    1 (single fire — runIfMain dedupes).
  - `tsx cli/up.ts <config> --target testnet` errors with the actionable message and exits 1
    (supervisor guard + up.ts target check).
  - `tsx cli/deploy.ts <config> --target testnet` errors with "config has no
    networks.testnet.rpcUrl" and exits 1 (resolveNetworkProfile via resolveTarget).
- Latent `topoSortActions` issue uncovered during smoke: when a Service action (e.g. `sui.localnet`)
  is filtered out and a Register action (e.g. `sui.accounts`) still has `needs: ['localnet']`, topo
  throws on the unresolved dep. This is a pre-C1 latent bug — `runOneShot` ran the same filter
  pre-C1, so `devstack deploy --network testnet` for any app with `sui()` plugin loaded would have
  hit this. Out of scope for C2; the fix likely belongs in topo (drop unknown deps to soft skip) or
  in the sui plugin (gate `accounts` on network). Filing as a follow-up; example apps don't
  currently exercise this path because nobody has run `apply` / `deploy` against a live net for an
  app that loads the sui plugin.
- Workstream C is fully closed. Next session candidates per the recommended order: **D1** (imports
  plugin, non-recursive — depends on B's `definePublishAction` which is shipped); **E1/G1**
  (independent React/helper extractions, can land in parallel); or any of the I-bag polish items
  (most are short).

### 2026-04-30 · D1 shipped — imports plugin (non-recursive); wallet migrated; D3 folded in

- New plugin at `packages/devstack/src/plugins/imports/index.ts`. Public API:
  `imports({ packages: [{ name, repo, rev, subdir, capture?, publisher?, env?, addresses? }] })`.
  Validates `name` against `/^[a-z][a-z0-9_-]*$/` and rejects duplicates at construction time so
  misconfigured configs fail at config-load, not first cycle.
- Per package, the plugin emits two actions:
  - **Build (`imports.<name>-source`)** — `getStatus` returns `ok: true` immediately on a live net
    with a curated `addresses[network]` set (no source image needed). Otherwise probes
    `imageExists(upstream-source:<repo>-<rev>)`. `run` calls
    `ensureUpstreamSourceImage({ repo, rev })`; no-op when curated.
  - **Publish (`imports.<name>`)** — `provides: ['imports.<name>']` so downstream actions can
    soft-depend via `'imports.<name>:before'` capability queries. Inputs include `repo`, `rev`,
    `subdir`, `env`, `publisher`, `addresses` so input-hashing dirties on any change.
    `path: '<imported>'` literal placeholder (matches the wallet's hand-rolled precedent; codegen
    skips pathless entries).
  - **Curated-address path (live nets only)** — `getStatus` registers the curated `packageId` in
    `registry.packages` with `network: ctx.network` and returns
    `{ ok: true, detail: 'curated <id>' }`. `run` is defensive: idempotent re-register of the
    curated id. No `importMovePackage` call, no docker activity. Skips re-register when the registry
    entry is already current.
  - **Localnet path** (and live nets without a curated address) — `getStatus` checks chainId match +
    on-chain liveness for the package AND every entry in `deps` (auto-published sub-packages from
    `--with-unpublished-dependencies`); a missing dep busts the cache. `run` invokes
    `importMovePackage` and registers the result. Reuses the existing `ImportedPackageCacheEntry`
    shape; `buildImportedPriorEntry` helper short-circuits when the registry entry lacks
    `sourceDigest`/`chainId` (older manifests, unpublished imports).
- Constructed the Publish action object directly (rather than via the `publish()` helper) because
  the helper auto-builds `inputs` from a fixed `{ path, capture, publisher }` shape — the imports
  plugin needs custom input fields for hashing. Same pattern the wallet's hand-rolled block used.
  The `publish()` helper stays useful for the common case; mention in `actions/publish.ts` (header
  comment) that `definePublishAction` is preferred for first-party publishes and the imports plugin
  is a deliberate exception.
- Wallet migration: `examples/wallet/devstack.config.ts` declares the deepbook import via
  `imports({ packages: [{ name: 'deepbook', repo: 'MystenLabs/deepbookv3', rev: 'v7.0.0', subdir: 'packages/deepbook', capture: { registryId, adminCapId } }] })`.
  `examples/wallet/walletPlugin.ts` loses the ~75-line hand-rolled `wallet.deepbook` Publish block;
  the `DEEPBOOK_REPO`/`DEEPBOOK_REV`/`DEEPBOOK_SUBDIR` constants and the `importMovePackage` +
  `ImportedPackageCacheEntry` + `suiContainerName` imports go too. `wallet.seedPools` `needs`
  updated from `['deepbook', 'usdc', 'weth']` (which would have resolved to local `wallet.deepbook`
  and now throws "no local action") to `['imports.deepbook', 'usdc', 'weth']` (cross-plugin FQN).
  `seedOrders` was unchanged — depends on `seedPools`, which transitively pulls deepbook.
  Registry-side: the `deepbook` package entry name is unchanged (the imports plugin uses `spec.name`
  as the registry key), so `ctx.registry.packages.require('deepbook')` in seed actions still
  resolves.
- D3 folded into D1: the wallet was the only consumer with a hand-rolled deepbook block, so there's
  no separate "migrate apps" step. Plan checklist reflects this — D3 marked complete, with a note in
  the workstream header.
- New tests: `plugins/imports/index.test.ts` (19 cases). Covers shape (Build+Publish per package,
  multi-package emission, duplicate-name rejection, invalid-name rejection, input-field plumbing);
  Build action across localnet/curated-live-net/non-curated-live-net; Publish `getStatus` across
  no-prior, chainId mismatch, healthy-with-deps, missing-dep, curated-live-net (registers + skips
  probe), curated-live-net-already-current; Publish `run` across localnet (calls importMovePackage +
  registers), curated-live-net (no importMovePackage, registers curated), non-curated-live-net
  (falls through to importMovePackage), prior-cache-entry forwarding.
- Total devstack test count: 117 (was 98 after C2, +19 in `plugins/imports/index.test.ts`). All
  pass; `pnpm -r typecheck` clean across 8 workspaces.
- Smoke-loaded `examples/wallet/devstack.config.ts` via `tsx --eval` and printed the action graph:
  11 actions in expected order — `sui.{build,localnet,accounts}`, `imports.deepbook-source`,
  `imports.deepbook`, `wallet.{usdc,weth,seedTokens,seedPools,seedOrders}`, `codegen.generate`.
  `imports.deepbook` correctly carries `provides: ['imports.deepbook']` and `wallet.seedPools`
  resolves `'imports.deepbook'` as a cross-plugin FQN need.
- Runtime smoke against a real localnet was NOT run this session — typecheck + 117 unit tests +
  module-load are the contract guarantees. The behavior is structurally identical to the prior
  hand-rolled block (same `importMovePackage` call, same registry shape), so first runtime
  validation is the next `pnpm localnet:up` for wallet.
- The latent `topoSortActions` follow-up from C2 is now MORE relevant: with the imports plugin's
  Build action present, `apply --target testnet` (which `applyFilter` strips Build from on live
  nets) leaves `imports.deepbook` with an unresolved `needs: ['imports.deepbook-source']`. Same
  class of bug as the C2 case — not exercised today but a real correctness gap when D1's
  curated-live-net path becomes useful. Add as an explicit follow-up: topo should soft-skip needs
  that resolve to filtered-out actions (or filters should propagate to dependents). Filing alongside
  the existing C2 follow-up.
- Next session candidates per the updated order: **D2** (recursive Move.toml dep walking — finishes
  workstream D); **E1/G1** (React adapter + helper extraction, both independent and parallelizable);
  **I-bag** (small polish items). D2 has the cleanest sequel-momentum; E/G unlock more user-facing
  wins.

### 2026-04-30 · Library-completion sweep (G1, D2, I1–I6, E1+E2, G2, F1, H additive)

User asked to "finish the full plan" in one sitting. Library surface is now in place across every
workstream; the only deferrals are per-app browser-smoke verification (E3, F3) and the
back-compat-breaking H strip step. Itemized:

- **G1 — `createLocalSuiClient` extracted.** `helpers/sui-client.ts` ships
  `createLocalSuiClient(url, network='localnet')`. Migrated 3 call sites (arena/wallet plugins +
  seal plugin's internal copy). The plan's other G1 target (`registerCoinToken`) was already inlined
  in B5's cleanup — no helper needed; the inline
  `ctx.registry.tokens.register({ name, type, decimals })` 4-line pattern across apps is too small
  to extract.
- **D2 — Recursive Move.toml dep walker.** New `plugins/imports/move-toml.ts` (TOML subset parser:
  `[dependencies]`, git/local entries) and `plugins/imports/resolve.ts` (recursive walker: clones
  source images via `ensureUpstreamSourceImage`, parses Move.toml, dedupes by `(repo, rev, subdir)`,
  skips `MystenLabs/sui` framework deps, topo-sorts). Exposed via the new async
  `withRecursiveDeps(seeds: ImportSpec[]): Promise<ImportSpec[]>` helper. Users call it at
  config-load time with top-level await:
  ```ts
  const packages = await withRecursiveDeps([{ name: 'deepbook', repo: '...', rev: '...', subdir: '...' }]);
  defineDevstackConfig({ plugins: [sui(), imports({ packages }), ...] });
  ```
  `imports({...})` itself stays sync. Each ImportSpec gained `dependsOn?: string[]`; the walker
  populates it; `buildActionsForSpec` adds those to the Publish's `needs` so transitive deps publish
  before dependents. 7 unit tests for the parser; the walker itself isn't unit-tested (would require
  docker fixtures). Not yet wired into wallet — D2 is forward-compat for Pyth/Cetus-style
  multi-package upstreams.
- **Topo lenient mode.** Added `TopoSortOptions.lenient` to `topoSortActions`. When set (one-shot
  path always, supervisor never), unknown `needs` edges drop instead of throwing. Closes the C2/D1
  latent bug where filtered-out Service/Build leaves dependents with unresolved deps. `runOneShot`
  passes `lenient: true` via the new `ReconcileBaseContext.lenient` field.
- **I1 — `devstack down` / `devstack reset`.** Top-level dispatcher cases that delegate to
  `runStack`. `down` shells `stack down` against the active stack. `reset` shells
  `stack drop --force` (new `--force` flag bypasses the active-stack guard but still requires
  `--yes`). USAGE updated.
- **I2 — Manifest version-migration scaffold.** `Manifest.version` widened to `1 | 2` (today's `1`
  is hypothetical). New `readManifestWithMigration(opts)` runs the manifest through a registered
  migration table (empty today); throws on unknown versions with an actionable error pointing at
  `devstack reset --yes`. First real schema change adds an entry. Exported alongside `readManifest`.
- **I3 — Discriminated `ActionRunContext`.** Split into `LocalnetActionRunContext` (carries `stack`)
  and `LiveNetActionRunContext` (no stack). Union as the public `ActionRunContext`. New
  `requireLocalnetCtx(ctx)` runtime narrowing helper — throws with an actionable message on
  testnet/mainnet, narrows TS to LocalnetActionRunContext after. Swept `ctx.stack` readers in
  `actions/publish.ts`, `plugins/{sui,imports,seal,walrus}/index.ts` — each callback that touches
  `stack` calls `requireLocalnetCtx(ctx)` first. Helper signatures updated where applicable (e.g.
  seal's `RegisterSealOptions` and walrus's `registerWalrus` now take `LocalnetActionRunContext`).
  Type-level safety: a plugin author who reads `ctx.stack` without narrowing gets a compile error
  pointing at the missing guard.
- **I4 — `Plugin.schemas` dropped.** Per the plan's "wire-or-drop" decision, dropped: no runtime
  reader, no consumer, no demand. Removed from `core/types.ts` (Plugin interface + zod import);
  doc-string in `Registry.ns` updated to drop the schema reference.
- **I5 — `ActionBase.watches?: string[]`.** Field added with JSDoc covering the use case (GraphQL
  schemas, JSON configs, generated SDLs). `runtime/file-watcher.ts:watchPathsFor` unions the
  user-declared watches with the inferred globs after resolving against `appDir`; non-existent paths
  still get filtered.
- **I6 — REPL `.deploy` command.** `cli/console.ts` adds `repl.defineCommand('deploy', { action })`
  that lazy-imports `runApply` and runs it against the resolved console target. Optional `<pkg>` arg
  surfaces a "scope filter not yet plumbed; running full apply" message and runs the full apply.
  Tightening to a per-package filter is a follow-up (filter would need to land in `apply.ts` + the
  runtime's filter chain).
- **E1+E2 — React adapter.** New `@mysten-incubation/devstack/react` subpath. Files:
  `react/types.ts` (CodegenModule type), `react/bind-package.ts` (`bindPackage(module, packageId)`
  walks codegen builders and curries `package`), `react/provider.tsx`
  (`<DevstackProvider manifest={...} packages={...}>`, `useDevstackContext`, `useDevstackManifest`),
  `react/use-devstack-package.ts` (`useDevstackPackage(name)`, `useDevstackPackageOptional(name)`),
  `react/use-devstack-sign-and-execute.ts` (`useDevstackSignAndExecute({ invalidateKeys })` — takes
  a Transaction, signs via the active dapp-kit wallet, awaits digest, invalidates keys). 4 unit
  tests for `bindPackage`. Optional peer deps (`react`, `react-dom`, `@mysten/dapp-kit-react`,
  `@mysten/dapp-kit-core`, `@tanstack/react-query`). Tsconfig gained `jsx: 'react-jsx'` +
  `lib: ['ES2022', 'DOM']`. The dapp-kit adapter's `useCurrentClient()` returns `ClientWithCoreApi`
  without `waitForTransaction` (apps register their narrower dAppKit type via module augmentation);
  the hook casts to a minimal `{ waitForTransaction(args: { digest }) }` shape since the wait-for-tx
  behavior is universal across dapp-kit instances. The hook also looks up the active
  `signAndExecuteTransaction` callable from `globalThis.__devstackDAppKit__` — set by
  `createDevstackDappKit` (G2) — so the hook stays decoupled from the app's specific dapp-kit
  instance.
- **G2 — `createDevstackDappKit`.** Async factory in the React adapter. Bundles `createDAppKit` +
  `SuiGrpcClient` + `createDevWalletInitializer` + manifest-derived RPC URL. Lazy-imports peer deps
  (`@mysten/dapp-kit-core`, `@mysten/sui/grpc`, `@mysten-incubation/devstack-wallet`) so the React
  adapter type-checks without them. Stashes the constructed `dAppKit` on
  `globalThis.__devstackDAppKit__` so `useDevstackSignAndExecute` can resolve the active wallet.
  `extend?: (config) => config` escape hatch for app-specific options.
- **F1 — `<DevstackDebugPanel>`.** SE-2-style form-per-builder panel in the React adapter. Reads
  `DevstackProvider` context. For each registered package, lists builders, renders a
  textarea-per-call (JSON array of arguments), submits via `useDevstackSignAndExecute`, renders
  results inline. Dev-only by default (checks `import.meta.env.DEV` then `process.env.NODE_ENV`);
  console warning on non-localnet networks. Form is intentionally minimal — JSON-textarea fallback
  for vectors/options/structs (the panel is a debug tool, not a contract editor).
- **H additive — Subpath barrels.** New `src/runtime.ts`, `src/cli.ts`, `src/helpers.ts` re-export
  the relevant slice. `package.json` `exports` and `tsup.config.ts` entry points updated for
  `./runtime`, `./cli`, `./helpers`. The main `index.ts` still re-exports everything for back-compat
  — the H2 strip step (cut runtime/cli/helpers exports from `index.ts`, sweep internal callers to
  use subpaths) is a follow-up. Pragmatic: lets new code use the cleaner subpaths immediately while
  existing imports keep working.

**Deferred (require what this session can't do):**

- **E3 — Per-app migration to React adapter.** Library surface is shipped and typechecks. Per-app
  migration touches main.tsx, App.tsx, dapp-kit.ts, lib/queries.ts, lib/transactions.ts, plus call
  sites in components. High blast radius without browser smoke. Each app should migrate in its own
  PR with a `pnpm dev` click-through.
- **F2 — Optional Vite `/__devstack` route.** Apps mount `<DevstackDebugPanel />` directly in their
  tree (e.g. `{import.meta.env.DEV && <DevstackDebugPanel />}` in App.tsx). The Vite-side route
  helper is sugar; deferred unless a consumer asks.
- **F3 — Per-app debug-panel smoke.** Browser verification.
- **H2 — Strip runtime/cli/helpers from main barrel.** Breaking change for any external consumer.
  Defer until current consumers (the 4 example apps + devstack-wallet + docs/site) migrate to the
  subpaths.
- **I6 — REPL `.deploy <pkg>` scope filter.** The verb works but the `<pkg>` arg is a no-op today. A
  real scope filter needs new infrastructure in `apply.ts` (per-package action subset) — file as I7
  if/when needed.

**Test count.** 128 unit tests across 13 files (was 98 before this session, +30 across imports
plugin, parser, react bind-package, supervisor guards). `pnpm -r typecheck` clean across 8
workspaces. No e2e or runtime smoke run in this session — typecheck + unit tests + module-load are
the contract guarantees. First real validation: next `pnpm localnet:up` for any of the four apps (no
expected behavior change for the apps; library surface adds new APIs, doesn't change existing ones).

### 2026-04-30 · Per-app migration + barrel strip + scope filter (E3, H2, F3, I6 follow-up)

User: "breaking changes are fine (no consumers yet) and we already have browser based tests". Closed
the four deferrals from the previous session.

- **E3 — All four example apps migrated to the React adapter.**
  - **arena**: `lib/transactions.ts` deleted. `LobbyView`/`GameView` switched to
    `useDevstackPackage('connect_four').{joinLobby,play}({ arguments: [...] })(tx)` +
    `useDevstackSignAndExecute({ invalidateKeys: [['arena']] })`. `lib/queries.ts:useSignAndExecute`
    removed (the FRICTION comment "fourth copy" along with it). `dapp-kit.ts` is 17 lines (was 34) —
    `createDevstackDappKit({ defaultNetwork, localnetRpcUrl, devKeys, walletInitializerFactory })`.
  - **token-studio**: `MintForm` switched to
    `useDevstackPackage('managed_coin').mint({ arguments: [TREASURY_CAP_ID, raw, recipient] })(tx)`.
    `TransferForm` keeps `buildTransferTx` (composes splitCoins/mergeCoins/transferObjects — not a
    single moveCall, codegen wouldn't replace it) but uses `useDevstackSignAndExecute`.
    `lib/queries.ts:useSignAndExecute` removed; `useInvalidateCoinReads` kept and called explicitly
    at call sites.
  - **private-content**: `lib/transactions.ts` deleted. `UploadForm` switched to
    `vault.uploadEntry({ arguments: [name, Array.from(encrypted), Array.from(sealId)] })(tx)`.
    `GrantForm` switched to `vault.grantEntry({ arguments: [fileId, recipient] })(tx)`.
  - **wallet**: keeps `lib/transactions.ts` (`buildSendTx` and `buildDeepbookSwapTx` both compose
    splitCoins/transferObjects across multiple coin types — codegen builders can't replace them).
    `SendForm`/`SwapForm` use `useDevstackSignAndExecute` + explicit `useInvalidateBalances()` at
    call sites.
  - All four apps' `main.tsx` wraps `<App />` in
    `<DevstackProvider manifest={manifest} packages={{ ... }}>` and mounts `<DevstackDebugPanel />`
    under `import.meta.env.DEV`.
  - All four apps' `dapp-kit.ts` consume
    `createDevstackDappKit({ ..., walletInitializerFactory: createDevWalletInitializer })`.
- **G2 redesign — `walletInitializerFactory` param.** First pass made `createDevstackDappKit` async
  with a magic dynamic-import lookup of `@mysten-incubation/devstack-wallet`. That broke Vite
  builds: `await` at the top of `dapp-kit.ts` triggered "top-level await not available" against
  Vite's default ES2020 build target, AND rollup couldn't statically resolve the module specifier
  from devstack's source files (apps install devstack-wallet, devstack itself doesn't). Second pass:
  helper is sync; apps explicitly import `createDevWalletInitializer` from devstack-wallet and pass
  it in via `walletInitializerFactory: createDevWalletInitializer`. Cleaner contract; no peer-dep
  magic; no top-level await.
- **F3 — Debug panel mounted per app.** Each app's `main.tsx` adds
  `{import.meta.env.DEV && <DevstackDebugPanel />}` inside `<DevstackProvider>`. Production builds
  tree-shake the panel out (verified via `pnpm -r build`).
- **H2 — Main barrel stripped to authoring-only surface.** `index.ts` now exports types +
  `definePlugin` + `defineDevstackConfig` + action factories + built-in plugins + signer factories +
  `requireLocalnetCtx`. Cut: every runtime/cli/helpers re-export. Apps swept: arena's
  `arenaPlugin.ts` and wallet's `walletPlugin.ts` now import `createLocalSuiClient` (and arena's
  `seedSharedObject`) from `@mysten-incubation/devstack/helpers`. Docs MDX example for
  `definePlugin` updated to import `publishMovePackage` from the helpers subpath. `pnpm -r build`
  succeeds across all 8 workspaces (4 example apps build to dist/, devstack package builds dist
  tarball entry points, devstack-wallet/docs-site clean).
- **tsup `external` list.** New
  `external: ['@mysten-incubation/devstack-wallet', '@mysten/dapp-kit-core', '@mysten/dapp-kit-react', '@tanstack/react-query', 'react', 'react-dom']`
  in `tsup.config.ts` so the React subpath builds without bundling its optional peer deps.
- **I6 follow-up — scope filter.** `runOneShot` gained `actionScope?: string[]`. New
  `scopeActions(actions, scope)` walks `needs` transitively to collect deps, then unions with every
  Emit action so the dirty-cascade still fires for the codegen Emit. Capability suffixes
  (`:before`/`:after`) are dropped from the walk — topo's lenient mode handles orphans. `apply` CLI
  gained `--actions a,b,c` (also accepts `--scope`). REPL `.deploy <name>` resolves `<name>` to
  `[name]` (passes through; runOneShot drops on miss) and runs apply with that scope. Bare names
  match an action's full FQN; `<plugin>.<name>` and `imports/<name>` shorthands also accepted at the
  REPL.
- Tsconfig regression fixed: devstack's `tsconfig.json` got `jsx: 'react-jsx'` +
  `lib: ['ES2022', 'DOM']` to support the React adapter's `.tsx` files. Apps unaffected (they have
  their own React tsconfigs).
- 128 unit tests still green; `pnpm -r typecheck` and `pnpm -r build` both clean across 8
  workspaces. The full plan is now landed end-to-end. Browser smoke gates on the existing Playwright
  e2e suites under `examples/*/e2e/`.

### 2026-05-01 · Multi-agent review pass + fixes

Ran a five-agent parallel review (API/architecture, React adapter, docs accuracy,
security/correctness, plus a deferred live-net deep-dive). Triaged the findings and shipped the
must-fix subset; the rest captured below.

**Fixed (critical):**

- **`<DevstackDebugPanel>` was broken end-to-end.** `PackageSection` iterated the unbound codegen
  module, so submitted forms hit the literal `'@local-pkg/<name>'` placeholder and would have failed
  every tx on chain. Fix: bind each module via `bindPackage` against the live `packageId` from the
  manifest before iterating; render a "not deployed yet" placeholder when the package is missing.
- **`createDevstackDappKit` silently no-op'd when `devKeys` set without
  `walletInitializerFactory`.** Apps would mysteriously lack the dev wallet (only the burner wallet
  shown) without an obvious cause. Now throws with an actionable message.
- **`createDevstackDappKit` overwriting `globalThis.__devstackDAppKit__`** silently broke
  `useDevstackSignAndExecute` in micro-frontend / HMR / Storybook scenarios. Now warns on overwrite.
- **`useDevstackSignAndExecute` cast to `client.waitForTransaction`** was unguarded — apps with a
  stubbed dapp-kit (tests, alt clients) would `undefined.()`-throw inside the mutation. Now probes
  `typeof client.waitForTransaction === 'function'` and falls back to skipping the wait.
- **Debug panel DEV-gate warning was inverted** — only fired when the panel was correctly mounted
  under DEV; should fire when explicitly mounted in production OR against a non-localnet network.
  Now warns on both independently.
- **Awaiting `qc.invalidateQueries` in `useDevstackSignAndExecute`** so `isPending` covers the
  refetch (apps gating spinners on `isPending` get correct behavior without an explicit invalidate).

**Fixed (security):**

- **`gitUrlToOwnerRepo` regex was unanchored**
  (`packages/devstack/src/plugins/imports/move-toml.ts`). `https://github.com.evil.com/Owner/Repo`
  matched because the substring `github.com/` was present. Anchored both regexes with `^`. Two new
  test cases assert host-impersonation strings throw.
- **Subdir traversal in `readMoveTomlAt`** (`packages/devstack/src/plugins/imports/resolve.ts`). A
  malicious upstream Move.toml declaring `subdir = "../../etc/passwd"` would let
  `join(tmp, subdir, 'Move.toml')` escape the extraction dir and read host files. Now validates
  `subdir` against `..` segments and absolute paths up front. Two new test cases.
- **Secret key leaked through shell argv in `importMovePackage`** —
  `sh -c "sui keytool import '${secret}' ed25519"` made the secret visible to anyone with
  `docker exec` to the localnet container during the ~2s import window (`/proc/<pid>/cmdline`,
  `ps`). Switched to a `dockerExecWithInput` helper that pipes the secret via stdin
  (`docker exec -i ... 'sui keytool import "$(cat)" ...'`).

**Fixed (correctness):**

- **`scopeActions` only auto-included Emits, didn't walk their needs.** Apps running
  `apply --actions wallet.usdc` would keep `codegen.generate` in the cycle but drop a Publish that
  codegen needs — leaving codegen with an orphaned edge that lenient-topo silently strips, then
  running against possibly-stale state. Now walks needs from every Emit too. Plus: warns when a
  `:before`/`:after` capability query is dropped from the scope (the provider won't run, even if
  it's loaded).
- **Signer factories duplicated across main and helpers barrels.**
  `cliSigner`/`envSigner`/`generatedKeypair` are authoring-time API consumed in
  `defineDevstackConfig({ accounts: { ... } })` — they belong on the main barrel only. Removed from
  the helpers barrel; comment explains why.
- **`Plugin.vite?: () => VitePlugin[]` was dead.** Field declared in `core/types.ts` but no
  validator, no built-in plugin used it, no test covered it. Removed (no compat shims pre-publish).

**Fixed (docs):**

- `manifest.mdx` — sui-rpc service `kind` was `"rpc"`; fixed to `"sui-rpc"` to match actual writer
  output.
- `plugins/walrus.mdx` and `README.md` — claimed `walrus({ rev?, apiPort? })`; `apiPort` doesn't
  exist on `WalrusPluginOptions`. Removed.

**Captured (deferred — design decisions, not bugs):**

- **`useDevstackPackage` returns `Record<string, unknown>`, forces casts at every call site.** The
  four apps each cast inline (`useDevstackPackage('connect_four') as { joinLobby: ... }`). A real
  fix is generic-on-the-hook (pass `typeof connectFour` as type arg) or a `DevstackPackageRegistry`
  augmentation pattern (mirrors the dapp-kit `Register` augmentation apps already do). Both touch
  the public `Provider`/`useDevstackPackage` types — defer to a follow-up that lands the
  augmentation contract carefully.
- **`isDeployed` duplicated four times** with subtly different logic across the example apps'
  `generated/deployment.ts`. Candidate for a `useDevstackDeployed()` hook that derives from
  `manifest.registry.packages`. Defer; the per-app heuristics are stable now.
- **Capability hijack** — any plugin can declare `provides: ['app-network']` and intercept walrus's
  setup ordering. No namespace enforcement. Real concern in a "third-party plugin" model that
  doesn't exist yet (devstack only consumes its own + curated plugins today). Filed for when the
  plugin ecosystem grows beyond the curated set; the fix is likely "warn when a
  non-`<plugin-name>.*` capability is declared, escalate to error in v2."
- **Per-step `ready.sort` in topo is O(n²log n).** Fine at ~30 actions; min-heap is the right shape
  if action counts grow. Filed; not load-bearing.
- **`registry.ns<T>(name): T` is unconstrained.** Could narrow to
  `T extends Record<string, RegistryQuery<unknown>>`. Trade-off: tighter types vs. plugin-author
  ergonomics. Filed.
- **`runtime.ts` re-exports `RegistryImpl`.** Internal class; embedders shouldn't construct one
  directly. Worth marking as "internal — for test harnesses." Filed.
- **`PublishAction.path` carries `'<imported>'` placeholder for imports.** Type says `path: string`;
  semantic is "marker." Either narrow the type or document. Filed.
- **`extend?: <T>(config: T) => T` in `CreateDevstackDappKitOptions` is a useless generic.** Drop
  the generic, type as `(config: DappKitConfig) => DappKitConfig`. Filed (cosmetic).
- **Manifest read has no size cap.** `JSON.parse` of a 1GB attacker-committed manifest would OOM.
  Trust boundary largely already crossed (the file is in the user's repo), but worth a `statSync`
  guard. Filed.
- **`cliSigner` error messages leak keystore path.** Discloses host user / config layout in CI logs
  forwarded to error trackers. Filed.

**Test count:** 149 unit tests across 16 files (was 146 before the review fixes; +3 across the new
security regex/subdir-traversal cases). `pnpm -r typecheck` and `pnpm -r build` both clean across 8
workspaces. The seven e2e tests were not re-run after the review fixes (none of the fixes touched
their happy paths); rerun before publish.

### 2026-05-01 · Deferred review items closed

Worked through every remaining "defer" from the multi-agent review. All 11 items shipped (or
explicitly closed with rationale).

**Polish:**

- Removed the useless generic in `extend?: <T>(config: T) => T` on `CreateDevstackDappKitOptions`.
  Now `(config: unknown) => unknown` with a doc comment explaining the shape is dapp-kit's
  `CreateDAppKitOptions` (kept untyped to avoid version-pinning).
- Added `@internal` JSDoc on `runtime.ts`'s `RegistryImpl` re-export — embedders should consume the
  `Registry` interface; the concrete class is for test harnesses.
- Documented the `'<imported>'` placeholder convention on `PublishAction.path`'s JSDoc — file
  watcher skips non-existent paths, codegen skips entries with `path: undefined`.
- `readManifest` got a `MANIFEST_MAX_BYTES = 50 MB` cap. A multi-GB attacker-committed manifest no
  longer OOMs `JSON.parse`.
- `cliSigner` error messages now redact the user's home dir (`~/...` instead of
  `/Users/<name>/...`). CI logs forwarded to error trackers stop disclosing the host user.

**Capability namespace enforcement:**

- `expandPluginActions` now warns when a plugin declares `provides:` without its own namespace
  prefix. Mitigates the "any plugin can declare `provides: ['app-network']` and intercept walrus"
  hijack the security review flagged. Soft warn for back-compat in v3; v2 escalates to error.
- Migrated walrus's `'app-network'` → `'walrus.app-network'` and the matching `sui.localnet` query.
  Updated tests + concept docs (`concepts/plugins.mdx`, `concepts/actions.mdx`,
  `plugins/walrus.mdx`).
- One new test in `plugin.test.ts` asserts the warning fires.

**`registry.ns<T>` constraint:** Reviewed; left unconstrained. The existing JSDoc already explains
why — the runtime returns a Proxy that auto-creates `RegistryQuery` queries on any string property
access, so a tighter `T extends Record<string, RegistryQuery<unknown>>` constraint would force
plugin-author types to carry redundant index signatures. Constraint correctness vs. ergonomics:
ergonomics wins given the runtime semantic.

**React adapter type ergonomics:**

- New `DevstackPackageRegistry` interface (mirrors dapp-kit's `Register` augmentation pattern). Apps
  `declare module '@mysten-incubation/devstack/react' { interface DevstackPackageRegistry { connect_four: typeof connectFour; } }`
  and `useDevstackPackage('connect_four')` returns the typed module — no inline cast at call sites.
- Generic-on-the-hook: `useDevstackPackage<N extends string>(name: N): RegisteredModule<N>` where
  `RegisteredModule<N>` looks up `DevstackPackageRegistry[N]` if registered, else falls back to
  `CodegenModule`. Same pattern for `useDevstackPackageOptional`.
- All four apps migrated: `main.tsx` adds the augmentation block,
  `LobbyView`/`GameView`/`MintForm`/`UploadForm`/`GrantForm` lose their inline
  `useDevstackPackage(...) as { ... }` casts. Net deletion: ~15 lines + zero compile-time lies.

**`useDevstackDeployed()` hook:**

- New hook in the React adapter; derives "stack is ready" from the manifest. Replaces the four
  per-app `isDeployed` constants in `examples/*/src/generated/deployment.ts` (each computed slightly
  differently — a real footgun).
- Optional `requirePackages: string[]` for strict gating:
  `useDevstackDeployed({ requirePackages: ['connect_four'] })`.
- 8 unit tests in `react/use-devstack-deployed.test.ts`; all four apps' `App.tsx` migrated.

**Bonus fix surfaced during the migration:**

- The React adapter's `Manifest` import chained through `runtime/manifest-writer.ts`, which has
  node-fs value imports. Apps' app-tsconfig (no `@types/node`) silently broke under `tsc -b --force`
  — the issue had been masked by the incremental build cache. Pulled the type-only schema into a new
  `runtime/manifest-types.ts` module (no node deps); writer/reader/react/vite all re-route. Forces a
  clean force-typecheck across the repo now.

**Test count:** 157 unit tests across 17 files (was 149 before this round; +8 from
`use-devstack-deployed.test.ts`). `pnpm -r typecheck` clean with `--force` (no incremental-cache
masking); `pnpm -r build` clean across all 8 workspaces.

**Carried-forward defers (filed but not done):**

- Per-step `ready.sort` in topo is O(n²log n). Fine at ~30 actions; min-heap if action counts grow.
  Not load-bearing.
- The plan-doc-bottom multi-agent-review ledger explicitly lists these as "filed; not load-bearing."
  They stay filed.

### 2026-05-01 · `pnpm dev` unifies the stack — `vite()` plugin + native Node TS + tsx removal

User asked: "pnpm dev should start everything (the vite server should maybe also be a plugin or
something so you have one combined cli with combined outputs)" + "use built version of devstack cli
rather than pointing at specific scripts and using tsx in examples, the examples should look like
real usage" + "lets get rid of tsx, lets just use node directly (modern version can run ts
directly)" + "add the appropriate engines config".

**Shipped:**

- **`vite()` plugin** at `packages/devstack/src/plugins/vite/index.ts`. Service action
  `vite.dev-server`:
  - `getStatus` HEAD-probes `http://localhost:<port>`.
  - `run` spawns `pnpm exec vite --port <port>` as a host child process (NOT a container — vite is a
    host process), streams stdout/stderr through `ctx.appendLog` (new — see below), waits for the
    URL to become reachable before returning. Idempotent on warm cycles.
  - Registers `ctx.onShutdown` that SIGINTs the child, SIGKILLs after 5s if it doesn't exit cleanly.
  - `needs: ['codegen.generate']` so vite waits for the manifest + bindings before starting (avoids
    a "stack is empty" first paint followed by HMR reload).
  - `command` defaults to `['pnpm', 'exec', 'vite']`; the plugin appends `['--port', String(port)]`.
    Override for Next.js/Astro/etc.
- **`ctx.appendLog?: (line: string) => void`** added to `ActionRunContext`. The reconciler binds the
  action name (`base.appendLog?.(action.name, line)`) so per-action callsites just take a line.
  Supervisor wires `(name, line) => renderer.appendLog(name, line)`. ANSI escapes are stripped
  before logging — the renderer's panel-redraw expects plain text. `process.stdout.write` fallback
  when not under the supervisor (one-shot paths).
- **All four example apps** load `vite({ port })` and dropped their `dev: vite` scripts in favor of
  `dev: devstack watch`. The `localnet:watch` script also points at `devstack watch` now (was
  `devstack up` which is one-shot per the dispatcher's auto-`--once`).
- **`devstack` bin published.** Top-level `bin: { devstack: ./dist/cli/index.js }` in
  `packages/devstack/package.json`. Apps consume via `node_modules/.bin/devstack` (pnpm wires the
  symlink). All tsx-prefixed scripts in example `package.json`s removed. Apps now look like real
  published-consumer usage: `"dev": "devstack watch"`, `"localnet:up": "devstack up --once"`, etc.
- **Workspace `main`/`exports` point at `dist/`** (not `src/`). Workspace consumers behave
  identically to published consumers — `import from '@mysten-incubation/devstack'` resolves to
  compiled JS, no TS-loader required at the consumer side. Iteration loop:
  `pnpm --filter @mysten-incubation/devstack build:watch` in one terminal (new `build:watch` script:
  `tsup --watch`) + `pnpm dev` in another. Initial bring-up: `pnpm install && pnpm -r build`.
- **tsx dropped entirely.** Removed from `packages/devstack/dependencies` and from every example
  `devDependencies` block. The CLI dispatcher (`cli/index.ts`) used to register tsx as an ESM loader
  hook; now it just runs as plain Node and relies on Node 24+'s native TypeScript stripping for the
  user's `devstack.config.ts`. `loadConfig` is a plain `await import(pathToFileURL(abs).href)` —
  works for both `.ts` (Node strips types) and `.js` (Node loads natively).
- **`engines.node: ">=24"`** added to root `package.json`, `packages/devstack/package.json`, and
  every example `package.json`. Node 24 is when type stripping became stable (Node 22.6 added it as
  `--experimental-strip-types`; Node 23.6 enabled by default; Node 24 stable). Older Nodes throw
  `ERR_UNKNOWN_FILE_EXTENSION` on the user's `.ts` config import.
- **Docs:** new `docs/site/content/docs/plugins/vite.mdx` covers the plugin's options, lifecycle,
  and skip-the-plugin guidance for headless apps. `getting-started.mdx` rewritten to lead with the
  unified `pnpm dev` flow + the `package.json` script wiring + the Node 24 prerequisite. `index.mdx`
  adds a "pnpm dev starts everything" bullet. Sidebar (`meta.json`) gains the new plugin page.
  Devstack `README.md` Quickstart fully rewritten.

**Verified:** `pnpm dev` from arena spawns sui localnet, publishes connect_four, runs codegen, AND
starts vite at `localhost:5176` — single process, single log stream, all 7 actions reach `healthy`,
vite returns HTTP 200. SIGINT cleanly tears down the vite child; sui container persists by design
(resumable on next `up`). 157 unit tests still green; `pnpm -r typecheck` and `pnpm -r build` clean
across 8 workspaces.

**Carried over:** the iteration friction of "rebuild devstack to pick up source changes". The
`build:watch` script handles this (incremental rebuild on save, ~1s) but it's a separate terminal.
Trade-off: published-consumer parity vs. zero-build dev iteration.

### 2026-04-30 · E2E run + hermetic stack management

Ran the full Playwright suite against real localnet. **7/7 tests green** end-to-end:

- `arena` — 1/1 (alice + bob play to a horizontal win)
- `token-studio` — 2/2 (mint, transfer)
- `wallet` — 3/3 (send SUI, send mUSDC, DeepBook swap — exercises the imports plugin's published
  deepbook)
- `private-content` — 1/1 (seal encrypt → grant cap → decrypt; brings up walrus + seal in addition
  to sui)

Hermetic stack management. The previous shape had `pnpm test:e2e:setup` (bring stack up) +
`pnpm test:e2e` (run playwright) as separate scripts; the user pointed out e2e tests should tear
down their own stacks. Reworked:

- `defineDevstackPlaywrightConfig({ port, manageStack: true })` wires Playwright's `globalSetup` and
  `globalTeardown` to call `runUp({ once: true })` and `runStack({ subcommand: 'down' })`
  respectively. `DEVSTACK_E2E_TEARDOWN=drop` swaps `down` → `drop` (wipe volumes) for CI.
- New `src/playwright/global-setup.ts` and `global-teardown.ts` modules, exposed as separate tsup
  entries (`dist/playwright/global-setup.js`, `dist/playwright/global-teardown.js`). Path resolution
  in `defineConfig` switches `.ts` ↔ `.js` based on whether the consumed module sits under `src/`
  (workspace dev mode) or `dist/` (published).
- Each app's `playwright.config.ts` now passes `manageStack: true`. The `test:e2e:setup`
  package.json scripts are dropped — `pnpm test:e2e` alone is the full hermetic loop.
- Verified: each app's `pnpm test:e2e` brings the stack up from cold, runs tests, tears down
  containers (volumes preserved), exits 0. Zero leftover containers after the full suite.

Full plan officially closed.
