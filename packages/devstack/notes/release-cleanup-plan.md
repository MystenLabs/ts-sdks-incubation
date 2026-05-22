# Devstack release cleanup plan

Last updated: 2026-05-22.

## Context

This audit was taken while the devstack package was mid-refactor. Treat red checks and stale docs as
integration evidence for the active refactor, not as permission to patch unrelated WIP in place.
Keep cleanup work scoped, break wrong APIs directly, and do not add compatibility shims.

The live blocker ledger remains `UNRESOLVED-BLOCKERS.md`. This file is the broader cleanup plan for
getting from "refactor in progress" to "release candidate".

## P0 release blockers

### 1. Finish the current public API refactor — completed

Current evidence:

- `pnpm --filter @mysten-incubation/devstack typecheck` passes.
- `pnpm --filter @mysten-incubation/devstack test` passes.
- `pnpm --filter @mysten-incubation/devstack build` passes.
- Built-ins, tests, examples, README, architecture docs, and devstack docs use the new
  resource-native plugin API.
- The cleanup marker scan over live source/docs/tests has no stale matches for the removed API names
  called out by the plugin API cleanup plan.

Completed scope:

- `start` is now `start()` for dependency-free plugins and `start(deps)` for dependencyful plugins.
- Composite rows use plugin metadata (`composite.key`) instead of a capability declaration.
- Projection updates are explicit `projection` capabilities instead of being inferred from strategy
  values.
- Strategy registration goes through the generic strategy-contributor sink.
- Callable mode namespaces replace the old namespace method form.
- The sample-only witness and sample plugin scaffolding has been removed from `src`.

### 2. Settle package contents and declaration generation

Current evidence:

- `package.json` publishes `src`, `dist`, and `images`, while explicitly excluding `src/generated`,
  `src/samples`, `dist/samples`, and `dist/node_modules`.
- Build still relies on `scripts/repair-effect-dts-imports.mjs` after `tsdown`.
- `UNRESOLVED-BLOCKERS.md` already calls the declaration repair path fragile and not release-ready.

Acceptance:

- Decide whether release packages should include `src` at all. If yes, document why; if no, move to
  a dist/images-only package.
- Replace or harden the declaration repair step so packed `.d.mts` files contain no
  `node_modules/effect` or `effect/dist` specifiers.
- `pnpm --filter @mysten-incubation/devstack build` and
  `pnpm --filter @mysten-incubation/devstack smoke:pack-consumer` pass from a clean checkout.
- `npm pack --dry-run` or equivalent confirms no generated app bindings, samples, nested
  `node_modules`, Move build output, or local runtime state are shipped.

### 3. Fix create-devstack-app template drift

Current evidence:

- `examples/_template/devstack.config.ts` is on the object-form app/service shape.
- `packages/create-devstack-app/template/devstack.config.ts` is stale: it imports `AnyMember` and
  uses the removed variadic `defineDevstack(...)` form.
- The scaffolder build runs `sync-template`, so the committed bundled template can drift from the
  source template unless release verification checks the generated package artifact.

Acceptance:

- `packages/create-devstack-app/template` is regenerated from `examples/_template`.
- Add or run a no-drift check that fails when the committed bundled template differs from the synced
  output.
- `pnpm --filter @mysten-incubation/create-devstack-app typecheck` and `build` pass.
- A temp installed/scaffolded app can run install, typecheck, and at least a minimal
  `devstack apply` or smoke boot from the packed packages.

### 4. Bring README and docs back to the live API

Current evidence:

- `packages/devstack/README.md` still describes `defineNodePlugin`, tag/provide primitives, and a
  flat-variadic `defineDevstack` surface.
- `packages/docs/content/devstack/reference/services.mdx` still has a custom plugin example using
  `start(_ctx, { sui })`.
- The live-network docs and tests are being edited for callable mode namespaces; finish the sweep
  after the active API refactor lands.

Acceptance:

- README describes the object-form stack composer, current plugin authoring helpers, and current
  package subpaths only.
- Docs snippets compile against the current source or are covered by a snippet/typecheck fixture.
- Mode namespace docs, tests, and examples use exactly one syntax.
- Docs no longer advertise commands excluded by the CLI surface decision.

### 5. Close product proof from the blocker ledger

Keep `UNRESOLVED-BLOCKERS.md` as the source of truth, but these are release blockers:

- `private-content` browser proof for encrypt -> Walrus store -> Walrus fetch -> Seal decrypt.
- Live TUI/operator proof: progress, log placement, endpoint grouping, failure rendering, shutdown,
  and hard-kill behavior.
- Installed-consumer boot from the packed package.
- Docker/manual lifecycle proof, including Docker Desktop grouping and the stale-network prune/wipe
  story for long-lived hosts.
- Current product evidence for wallet, token-studio, and fork-greeting.

## P1 cleanup before release candidate

### Samples and scaffold debt

`src/samples/*` is excluded from the package but still lives under `src` and can participate in
typecheck/refactor churn. It also still contains Phase 4 throw scaffolding and composite capability
usage. Either make samples real current-API examples with tests, move them out of `src`, or delete
them.

### Boundary cleanup

Carry forward the architecture/style open slots that affect release quality:

- Build integrations should share manifest discovery, decode, cold-start URL, and dapp-kit-slot
  behavior through `build-integrations/runtime`.
- Coin/package cross-plugin coupling should move to a substrate-raised event or another explicit
  public contract instead of one plugin importing another plugin's internals.
- `substrate/runtime/on-chain-artifact` naming should either become generic or move to the plugin
  layer if it remains Sui/on-chain-specific.

### Cast and residue sweep

Run a user-surface sweep for `as never`, `as any`, `as unknown as`, `displayHint`,
`CompositePrimitiveDecl`, `forNetwork`, `capabilityBuilder`, old `defineNodePlugin` terms, and phase
markers. Some casts in boundary/test code are legitimate; release cleanup should classify them and
remove the ones that leak into docs, examples, templates, public types, or built-in option surfaces.

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
pnpm --filter @mysten-incubation/create-devstack-app typecheck
pnpm --filter @mysten-incubation/create-devstack-app build
```

Docker/product lanes:

```bash
DEVSTACK_RUN_E2E=1 pnpm --filter @mysten-incubation/devstack test:e2e
pnpm --filter @mysten-incubation/private-content test:e2e
pnpm --filter @mysten-incubation/wallet test:e2e
pnpm --filter @mysten-incubation/token-studio test:e2e
pnpm --filter @mysten-incubation/deepbook-full test:e2e
```

Manual release proof:

- `npm pack --dry-run` / package file audit for devstack and create-devstack-app.
- Temp install from packed tarballs.
- Scaffold a temp app from the packed scaffolder.
- Boot a minimal installed-consumer stack.
- Run one live TUI session and record operator observations.
- Inspect Docker Desktop grouping and stale-resource cleanup behavior on a long-lived Docker host.
