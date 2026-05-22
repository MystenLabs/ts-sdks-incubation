# @mysten-incubation/devstack

> **Current-state warning (2026-05-21):** this package is not release-ready. For current handoff,
> blocker status, and orchestration instructions, start with `notes/UNRESOLVED-BLOCKERS.md`.
> Historical notes/reviews were deleted; use git history for archaeology.

The next-generation devstack substrate: type-system, user-facing API surface, runtime,
orchestrators, and plugins.

This directory is the canonical `@mysten-incubation/devstack` package after the package-directory
cutover. The example, docs, CI, and install-smoke follow-up work remains tracked in the blocker
ledger.

## Scope

This package contains:

- The nine capability contracts as TypeScript interfaces.
- The substrate primitives (lifecycle, plugin shape, manifest envelope, renderer projection,
  state-store, cross-process roster protocol, typed events/commands, OnChainArtifactPublisher,
  lifted-sibling, cache).
- The user-facing API: `defineDevstack` (flat-variadic + callback forms), plugin authoring helpers,
  tag/provide primitives, the typed capability builder, and substrate-minted witnesses.
- L2 plugins (sui, walrus, seal, deepbook, postgres, account, wallet, package, coin, faucet,
  action).
- Orchestrators (snapshot, router, codegen) and surfaces (CLI, TUI).
- Internal/sample plugins used for development experiments. These are not release surface unless the
  blocker ledger explicitly clears them.

For agents/orchestrators picking up this work, start with the rolling blocker ledger at
`notes/UNRESOLVED-BLOCKERS.md`. That compact first-read file is enough to begin a clean
orchestration session.

## Boundary

Plugin authors and engine implementers import from this package. **Apps do not.** Apps consume
codegen output emitted via the `Codegenable` contract; the engine, contracts, and substrate
primitives are not reachable from L5 example code. This is enforced at lint time and observable here
through the absence of any app-shaped entry point.

## Layout

```
src/
  substrate/      lifecycle SM, NodePlugin shape, manifest, projection,
                  state-store, cross-process protocol, typed events
  contracts/      the nine capability contracts
  primitives/     on-chain-artifact publisher, lifted-sibling, cache
  api/            defineDevstack (both forms), defineNodePlugin,
                  defineCapabilities (typed builder), tag/provide,
                  defineWitness
  plugins/        L2 plugins (sui, walrus, seal, deepbook, postgres,
                  account, wallet, package, coin, faucet, action)
  orchestrators/  snapshot, router, codegen
  surfaces/       CLI + TUI
  samples/        trivial leaf + composite (Walrus-shaped) plugins
```

## Effect v4

This package targets Effect v4 beta (catalog pin). The substrate uses `Scope`, `Layer`, `Context`,
`Effect.gen`, and `Schema` for runtime contracts. App-facing generated outputs avoid Effect types;
plugin-author and engine surfaces intentionally expose them.

### Packed consumer typechecking

The package-level smoke audit uses the common application posture of `skipLibCheck: true`. Devstack's
plugin-author and engine surfaces intentionally expose Effect v4 beta types, so strict library
checking would typecheck Effect's beta declarations rather than just devstack's package boundary. The
smoke audit packs the package, installs it in a clean temp consumer, checks the installed CLI, checks
ESM imports for the root, `/vite`, and `/runtime` exports, boots a minimal stack, and verifies the
consumer compiles with `skipLibCheck` enabled:

```bash
pnpm --filter @mysten-incubation/devstack build
pnpm --filter @mysten-incubation/devstack smoke:pack-consumer
```
