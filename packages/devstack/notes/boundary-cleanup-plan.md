# Devstack boundary cleanup plan

Last updated: 2026-05-22.

## Goal

Remove the remaining architecture leaks that were left out of the node-kind / composite /
lifted-sibling cleanup. The target architecture is:

- L0 substrate stays plugin-name-blind.
- L2 plugins own plugin-domain services and domain-shaped records.
- L3 orchestrators consume declared capabilities without knowing plugin internals.
- L5 build integrations share one runtime implementation instead of copying discovery/context code.

This repo is still prototype-stage. Do direct breaking cleanup in place; do not add compatibility
aliases, deprecated shims, or v2 surfaces.

## Implementation status

Completed on 2026-05-22.

Implemented decisions:

- Package/Coin decoupling does **not** introduce a core `PublishReceipt`. Package owns
  `LocalPackagePublishOutput` and emits a package-owned contribution; Coin registers a sink for that
  contribution from the built-in plugin runtime composer.
- Plugin-owned registry layers now compose outside `substrate/runtime/`; the substrate runtime
  builds only name-blind services.
- `on-chain-artifact` was renamed to the generic `artifact-publisher` primitive because its real API
  is cache/verify/produce/register rather than Sui-specific chain semantics.
- Capability delivery now uses sink registrations keyed by contribution `kind`; the substrate
  default layer only owns the generic registry and `error-contribution` formatter sink.
- Router entrypoint ownership moved next to the plugins. The central router keeps only registry
  construction and collision checks. There is no ownerless `redis-tcp` built-in entrypoint.
- Build integrations now share runtime helpers for identity discovery, manifest projection, cold
  start route tables, and dapp-kit slot handling.
- Additional host-process cleanup: wallet's in-process HTTP server now uses a shared
  `scoped-http-server` runtime primitive for bind/close lifecycle; wallet keeps only domain request
  routing, auth, and body handling.

Verification completed:

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack test
pnpm --filter @mysten-incubation/devstack build
pnpm --filter @mysten-incubation/devstack smoke:pack-consumer
```

## Work order

Do these in order. The first two are coupled; the later lanes can be split once the core boundary is
cleaner.

## 1. Decouple Coin and Package through a receipt event

Current issue:

- `plugins/coin/discovery.ts` imports `PublishReceipt` / `PublishObjectChange` from the Package
  plugin.
- `plugins/package/index.ts` imports `CoinRegistryService` and calls the Coin discovery walker after
  local package publish.
- This violates the L2 rule that one plugin should not import another plugin's internals.

Plan:

1. Move the publish receipt contract out of `plugins/package/` into a neutral contract module, for
   example `contracts/publish-receipt.ts` or `contracts/package-receipt.ts`.
2. Add a substrate event or contribution for publish receipts, for example:
   - `PublishReceiptEmitted`
   - fields: publishing package name, package id, chain, receipt, row key / plugin key context.
3. Have Package emit the receipt after a successful fresh publish or verified cache hit.
4. Have Coin subscribe/harvest that receipt and run `discoverCoinsFromPublish` from the Coin side.
5. Remove Package's direct dependency on `CoinRegistryService` and `discoverCoinsFromPublish`.
6. Remove Coin's import from the Package barrel.

Files to touch:

- `src/plugins/package/index.ts`
- `src/plugins/package/publish-receipt.ts`
- `src/plugins/coin/discovery.ts`
- `src/plugins/coin/index.ts`
- `src/contracts/`
- `src/substrate/events.ts` or `src/substrate/runtime/capability-sinks/`
- package/coin tests covering coin auto-discovery from package publish.

Verification:

- Add a focused test proving `localPackage` publish still populates `coin.fromPackage(...)`.
- Add a residue scan that fails on `plugins/coin` importing from `plugins/package` and vice versa.

## 2. Move plugin-owned registry layers out of substrate runtime assembly

Current issue:

- `substrate/runtime/run.ts` imports `CoinRegistryService`, `coinRegistryLayer`,
  `PackageRegistryService`, and `layerPackageRegistry`.
- That makes the substrate runtime aware of plugin-owned services.

Plan:

1. Split the current layer builder into:
   - a name-blind substrate layer builder, containing identity, paths, cache, strategy registry,
     container runtime, port/lease brokers, post-acquire tasks, logging, and redaction.
   - a built-in plugin layer composer outside `substrate/runtime/`, allowed to import
     `plugins/coin/registry.ts` and `plugins/package/registry.ts`.
2. Keep the plugin context assembly explicit: substrate provides core services, the built-in plugin
   composer provides built-in plugin services.
3. After Workstream 1, confirm Package no longer needs Coin registry access during acquire. If Coin
   still needs its registry for its own factories, that layer remains plugin-owned but is no longer
   substrate-owned.
4. Update `runStack` / boot helpers to call the higher-level composer, not the pure substrate one.
5. Add a boundary test or scan asserting `src/substrate/**` does not import from `src/plugins/**`.

Files to touch:

- `src/substrate/runtime/run.ts`
- likely a new `src/plugins/runtime-layers.ts` or `src/runtime/built-in-plugin-layers.ts`
- `src/api/run-stack.ts`
- boot/e2e helpers that build the runtime context.

Verification:

- `rg "from '../../plugins|from '../plugins|src/plugins" packages/devstack/src/substrate` should
  have no live source matches.
- Run `test/substrate/runtime/run.test.ts`, supervisor tests, and boot-config tests.

## 3. Settle `on-chain-artifact` ownership and naming

Current issue:

- `substrate/runtime/on-chain-artifact/` is substrate-located but domain-named as "on-chain".
- It may be a generic artifact publisher, or it may really be Sui/plugin infrastructure.

Plan:

1. Audit all consumers: Package, Coin, Action, Walrus, Seal, DeepBook.
2. Decide based on the real API:
   - If the abstraction is generic cache/verify/produce/register, rename it to `artifact-publisher`
     and remove on-chain-specific names from public types.
   - If the abstraction is Sui/on-chain-specific, move it out of L0 substrate into an L1/L2 module
     with an explicit exception documented in `ARCHITECTURE.md`.
3. Rename types and service tags directly. No deprecated aliases.
4. Update spans, docs, and tests.

Files to touch:

- `src/substrate/runtime/on-chain-artifact/`
- `src/primitives/on-chain-artifact.ts`
- plugin consumers under `src/plugins/{package,coin,action,walrus,seal,deepbook}/`
- architecture/style docs.

Verification:

- Residue scan for old chosen-away names.
- Focused plugin tests for Package, Coin, Action, Walrus, Seal, and DeepBook publish paths.

## 4. Make capability sinks a registry instead of named slots

Current issue:

- The capability sink layer still imports every built-in capability declaration type and exposes one
  callback slot per built-in kind.
- This is name-blind at the plugin level, but still couples substrate to contract names.

Plan:

1. Make `CapabilitySinksService` a registry keyed by `decl.kind`.
2. Register built-in sinks from the orchestrator/runtime-composition layer, not from a substrate
   switch shape.
3. Preserve the current behavior for unknown contribution kinds: no-op unless a sink is registered.
4. Keep plugin error contributions as a separate built-in sink or convert them into the same
   registry shape if that simplifies dispatch.
5. Delete the one-property-per-kind `OrchestratorSinks` shape once all callsites register by kind.

Files to touch:

- `src/substrate/runtime/capability-sinks/`
- `src/substrate/runtime/supervisor.ts`
- `src/orchestrators/runtime-composition.ts`
- capability authoring tests and orchestrator tests.

Verification:

- Custom capability authoring test still passes.
- Add a test proving an unregistered custom kind is ignored and a registered custom kind is
  dispatched without substrate changes.

## 5. Move router default entrypoints next to plugins

Current issue:

- `orchestrators/router/entrypoints.ts:DEFAULT_ENTRYPOINTS` hardcodes plugin/service names such as
  `wallet-app`, `walrus-node-0`, `seal-key-server`, `postgres-tcp`, and `redis-tcp`.

Plan:

1. Introduce an entrypoint declaration surface owned by plugins, or extend routable declarations so
   plugins can declare their required public entrypoints.
2. Move each default entrypoint block next to the plugin that owns it.
3. Compose the entrypoint registry at supervisor/router boot.
4. Keep router collision checks in the router orchestrator; only ownership of names/ports moves.
5. Delete the central plugin-name-laden default list.

Files to touch:

- `src/orchestrators/router/entrypoints.ts`
- `src/orchestrators/router/service.ts`
- plugin routable modules for wallet, walrus, seal, postgres, faucet/redis if present.
- router tests and real-traffic tests.

Verification:

- Router tests still prove collision handling.
- Residue scan for plugin-owned endpoint names in central router defaults.

## 6. Consolidate build integrations onto `build-integrations/runtime`

Current issue:

- `vite`, `vitest`, `playwright`, and `browser` integrations each carry variants of discovery,
  decoding, cold-start URL, dapp-kit slot, and stack-context code.

Plan:

1. Inventory duplicate logic across:
   - `build-integrations/vite/`
   - `build-integrations/vitest/`
   - `build-integrations/playwright/`
   - `build-integrations/browser/`
   - `build-integrations/runtime/`
2. Promote the shared pieces into `build-integrations/runtime/` with stable, framework-neutral
   functions.
3. Rewrite each integration as a thin adapter over runtime helpers.
4. Keep framework-specific config glue in the framework package only.
5. Add tests that compare equivalent behavior across integrations using the same runtime fixtures.

Files to touch:

- `src/build-integrations/runtime/*`
- `src/build-integrations/{vite,vitest,playwright,browser}/*`
- integration tests under `test/build-integrations/`
- docs for build integration usage if public imports change.

Verification:

- Run all build-integration tests.
- Run packed-consumer smoke if public subpath exports change.

## Final verification checklist

Run after each workstream:

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run <focused files>
```

Run after all workstreams:

```bash
pnpm --filter @mysten-incubation/devstack test
pnpm --filter @mysten-incubation/devstack build
pnpm --filter @mysten-incubation/devstack smoke:pack-consumer
```

Residue scans to keep:

```bash
rg -n "from ['\"].*plugins/" packages/devstack/src/substrate
rg -n "from ['\"].*package" packages/devstack/src/plugins/coin
rg -n "from ['\"].*coin" packages/devstack/src/plugins/package
rg -n "wallet-app|walrus-node-0|seal-key-server|postgres-tcp|redis-tcp" packages/devstack/src/orchestrators/router
```
