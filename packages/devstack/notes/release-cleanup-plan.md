# Devstack release cleanup plan

Last updated: 2026-05-22.

## Context

This audit was taken while the devstack package was mid-refactor. Treat red checks and stale docs as
integration evidence for the active refactor, not as permission to patch unrelated WIP in place.
Keep cleanup work scoped, break wrong APIs directly, and do not add compatibility shims.

The live blocker ledger remains `UNRESOLVED-BLOCKERS.md`. This file is the broader cleanup plan for
getting from "refactor in progress" to "release candidate".

## P0 release checklist

### 1. Finish the current public API refactor - completed

Current evidence:

- `pnpm --filter @mysten-incubation/devstack typecheck` passes.
- `pnpm --filter @mysten-incubation/devstack test` passes.
- `pnpm --filter @mysten-incubation/devstack build` passes.
- Built-ins, tests, examples, README, architecture docs, and devstack docs use the new
  resource-native plugin API.
- The cleanup marker scan over live source/docs/tests has no stale matches for the removed API names
  from the completed plugin API cleanup.

Completed scope:

- `start` is now `start()` for dependency-free plugins and `start(deps)` for dependencyful plugins.
- Composite rows use plugin metadata (`composite.key`) instead of a capability declaration.
- Projection updates are explicit `projection` capabilities instead of being inferred from strategy
  values.
- Strategy registration goes through the generic strategy-contributor sink.
- Callable mode namespaces replace the old namespace method form.
- The sample-only witness and sample plugin scaffolding has been removed from `src`.

### 2. Settle package contents and declaration generation - completed

Current evidence:

- `package.json` publishes `dist` and `images`; source is not shipped.
- The post-`tsdown` declaration repair script is removed. The root cause was the devstack-local
  catch-all `paths: { "*": ["./*"] }` mapping, which made TypeScript name Effect helper subpaths as
  package-local `node_modules/effect/dist/*` specifiers during declaration generation.
- `packages/devstack/tsconfig.json` no longer defines that catch-all path mapping, so `tsdown` emits
  public Effect subpaths such as `effect/Types` and `effect/Cause` directly.
- `test/build-integrations/release-surface.test.ts` scans packed declaration files and fails on
  package-local Effect specifiers or `.js` Effect subpath imports.
- `pnpm --filter @mysten-incubation/devstack smoke:pack-consumer` passes with the dist/images-only
  package shape.
- A dry-run package audit confirms no `src/`, generated app bindings, samples, nested
  `node_modules`, Move build output, or local runtime state are shipped.

Completed scope:

- Devstack package contents are now dist/images-only.
- Declaration generation uses normal `tsdown` output without a post-build text repair.
- Packed-consumer import, CLI, minimal boot, stack-context, removed-subpath, and skip-lib-check
  typecheck smokes pass from the packed tarball.

### 3. Fix create-devstack-app template drift - completed

Current evidence:

- `examples/_template/devstack.config.ts` is on the object-form app/service shape.
- `packages/create-devstack-app/template/devstack.config.ts` is synced from `examples/_template`.
- `pnpm --filter @mysten-incubation/create-devstack-app run check-template` compares the bundled
  template against a fresh temp sync and passes.
- `pnpm --filter @mysten-incubation/create-devstack-app typecheck` passes.
- `pnpm --filter @mysten-incubation/create-devstack-app build` passes.
- A `skipInstall`/`skipGit` scaffold smoke rewrites package scripts to `DEVSTACK_APP=smoke-app`,
  rewrites the router origin to `dev.smoke-app.localhost`, and does not copy `src/generated`.
- A dry-run package audit confirms the scaffolder tarball contains `dist` and `template`, with no
  generated app bindings, nested `node_modules`, local runtime state, Move build output, or source
  package files.

Completed scope:

- `packages/create-devstack-app/template` is regenerated from `examples/_template`.
- Added a no-drift check that fails when the committed bundled template differs from the synced
  output.
- Generated template bindings are filtered out at both sync and scaffold-copy time.

### 4. Bring README and docs back to the live API - completed

Current evidence:

- `packages/devstack/README.md` describes the object-form composer, current plugin authoring
  helpers, capability helpers, mode-narrowed factories, and dist/images package shape.
- Docs no longer match stale public API markers for `defineNodePlugin`, `NodePlugin`, `forNetwork`,
  `.for(...)`, `tag/provide`, `capabilityBuilder`, `CompositePrimitiveDecl`, `displayHint`, phase
  markers, or placeholder generated package paths.
- `pnpm --filter @mysten-incubation/docs build` passes.

Completed scope:

- README and docs are aligned to the live public API surface covered by the marker scan.
- Generated output docs use `package/<mvr-placeholder>.ts`.
- Refs/dependency docs no longer advertise witness helpers or composite capabilities.

### 5. Close product proof from the blocker ledger

Keep `UNRESOLVED-BLOCKERS.md` as the source of truth. These were the P0 release gates:

- `private-content` browser proof for encrypt -> Walrus store -> Walrus fetch -> Seal decrypt:
  resolved 2026-05-22.
- Live TUI/operator proof: resolved 2026-05-22. A real `_template` TUI session reached `running`,
  `6/6 ready`, 5 URLs, 2 accounts, 1 package, and no errors; showed Services/Packages/Accounts
  grouping with Sui, wallet, app, package, and account rows; handled `SIGINT` graceful shutdown; and
  wiped the proof stack clean. Focused hard-kill/second-signal tests and real-Docker router traffic
  also passed.
- Installed-consumer boot from the packed package: resolved 2026-05-22.
- Docker/manual lifecycle proof: Docker Desktop grouping was manually verified by the user on
  2026-05-22. The stale-network prune/wipe story for long-lived hosts is resolved for devstack-owned
  resources: `wipe` removes stack-scoped containers/networks/volumes, and built CLI
  `prune --dry-run --json` inventoried devstack-labeled networks, selected non-shared stale
  networks, and left shared router profile groups unselected by default. Unlabelled/foreign networks
  remain outside devstack's destructive scope by design.
- Wallet-backed browser proof: resolved 2026-05-22 through `examples/deepbook-trader`, which now
  connects the dev wallet on localnet and shows SUI plus local DEEP funding. Real DeepBook swaps
  remain blocked on local DeepBook/Pyth acquisition.
- Token-studio browser proof: resolved 2026-05-22 with
  `pnpm --filter @mysten-incubation/token-studio test:e2e`.
- Fork-greeting is no longer release-gated. Forking is marked as a coming-soon feature, and
  `examples/fork-greeting` is no longer advertised as a runnable release target. Fork network
  selection now fails explicitly with a coming-soon error through the CLI/env parser, and direct
  `sui({ mode: 'fork', ... })` usage throws `SuiForkComingSoonError`.
- Snapshot identity conflict rejection and start-time/PID identity proof resolved on 2026-05-22 with
  focused identity-guard, restore, snapshot-reservation, roster, stack-lock, and supervisor-presence
  tests. The snapshot-reservation orphan sweep now forces the PID/start-time check through the
  same-host path so stale same-PID reservations are swept instead of being treated as foreign-host
  alive.
- Package-preview proof is resolved for both tarballs and the real preview-distribution path:
  devstack pack-consumer boot passes, `npm pack --dry-run --json` passes for devstack and
  create-devstack-app, a create-devstack-app tarball install/bin smoke generated a correctly
  rewritten app without generated artifacts, and the actual `pkg.pr.new` PR workflow published
  preview packages that were installed into a scaffolded temp app and booted with `devstack apply`.
- The live TUI proof exposed and fixed the router-profile conflict caused by preferring daemon ID
  over Docker context identity. Router profiles now prefer stable context/host identity, so the CLI
  adopts the existing router singleton instead of creating a second fixed-port router profile when
  daemon ID lookup becomes available later.

## P1 cleanup before release candidate

### Samples and scaffold debt - completed

Current evidence:

- `packages/devstack/src/samples` contains no tracked files.
- `packages/devstack/examples-test` no longer imports sample plugins.
- The package dry-run audit confirms no `src/` or `dist/samples/` files are shipped.
- `packages/devstack/test/build-integrations/release-surface.test.ts` now pins the dist/images-only
  package surface.

### Boundary cleanup - completed

The boundary cleanup lane is complete; details and verification live in
`packages/devstack/notes/boundary-cleanup-plan.md`.

Completed scope:

- Build integrations share runtime helpers for identity discovery, manifest projection, cold-start
  route tables, and dapp-kit slot handling.
- Package/Coin publish-output coupling moved out of substrate internals and through a plugin-owned
  contribution path.
- `on-chain-artifact` was renamed to the generic `artifact-publisher` primitive.

### Cast and residue sweep

Run a user-surface sweep for `as never`, `as any`, `as unknown as`, `displayHint`,
`CompositePrimitiveDecl`, `forNetwork`, `capabilityBuilder`, old `defineNodePlugin` terms, and phase
markers. Current stale public API marker scans over README, docs, examples, and the scaffolder
template are clean; remaining source matches are either historical notes, style-guide examples,
engine/service identifiers, or implementation comments that need separate classification before
release.

### Example and docs evidence

Examples should be either:

- a runnable app with `dev`, `typecheck`, build, and browser/e2e evidence; or
- a config-only example clearly labeled as such.

Do not keep examples that need generated files committed to work. Generated files under
`src/generated` stay ignored and must be recreated by `devstack apply`.

## Release verification checklist

Run after the active refactor has a coherent API:

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack build
pnpm --filter @mysten-incubation/devstack exec vitest run
pnpm --filter @mysten-incubation/devstack smoke:pack-consumer
pnpm --filter @mysten-incubation/token-studio exec tsc -p tsconfig.node.json --noEmit
pnpm --filter @mysten-incubation/private-content exec tsc -p tsconfig.node.json --noEmit
pnpm --filter @mysten-incubation/deepbook-trader exec tsc -p tsconfig.node.json --noEmit
pnpm --filter @mysten-incubation/connect-four exec tsc -p tsconfig.node.json --noEmit
pnpm --filter @mysten-incubation/_template exec tsc -p tsconfig.node.json --noEmit
pnpm --filter @mysten-incubation/example-fork-greeting typecheck
pnpm --filter @mysten-incubation/create-devstack-app typecheck
pnpm --filter @mysten-incubation/create-devstack-app build
```

Docker/product lanes:

```bash
DEVSTACK_RUN_E2E=1 pnpm --filter @mysten-incubation/devstack test:e2e
pnpm --filter @mysten-incubation/private-content test:e2e
pnpm --filter @mysten-incubation/token-studio test:e2e
pnpm --filter @mysten-incubation/deepbook-trader test:e2e
```

Manual release proof completed on 2026-05-22:

- The actual `pkg.pr.new` PR workflow published preview packages for `create-devstack-app`,
  `dev-wallet`, `devstack`, and `tsconfig`.
- A temp app was scaffolded from the preview `create-devstack-app`, installed against the preview
  devstack/dev-wallet/tsconfig packages, booted with `devstack apply`, verified its manifest, and
  wiped clean.
