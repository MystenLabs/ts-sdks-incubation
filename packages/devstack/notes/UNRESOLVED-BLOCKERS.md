# Devstack live blockers

Last updated: 2026-05-22.

This file tracks current release gates only. Closed investigations, worker logs, and historical
proof details belong in git history, not in the live blocker ledger.

## Current decisions

- The example set is curated. Deleted mini/examples stay deleted: `effect-app`, `hello-world`,
  `plugin-author-redis`, `postgres-mini`, `seal-mini`, and `walrus-mini`.
- Forking is a coming-soon feature, not a release gate. Do not advertise `fork-greeting` as a
  runnable release target until the fork runtime path has real product proof.
- Local DeepBook swaps remain unavailable until local DeepBook, Pyth, and pool acquisition are
  first-class. The shipped DeepBook demo stays localnet-only and shows the unavailable swap state.
- Walrus local-cluster images use upstream release tarballs only. Do not reintroduce Rust/Cargo
  source builds.
- Walrus release images are pinned to upstream `testnet-v1.49.1` tarballs. The image build verifies
  `walrus`, `walrus-node`, and `walrus-deploy` exist and match Docker's target architecture. If a
  future upstream release regresses, fail during image build instead of adding a source-build path.
- The public CLI surface is intentionally attached/direct only: `up`, `apply`, `status`, `doctor`,
  `config`, `schema --json`, `snapshot`, `prune`, and `wipe`. Do not reintroduce detached peer
  commands like `down`, `logs`, `exec`, `codegen`, `stack`, or `fork`.
- This repo is still prototype-only. Break wrong APIs directly; do not add shims, deprecated
  exports, or parallel v2 surfaces.

## P0 release gates

No open P0 release gates.

## Required release proof

Before a release candidate, rerun the current proof from a clean checkout and clean package build.
Keep any new failure above `P0 release gates` until it is fixed and reproved.

- Devstack package proof:
  - `pnpm --filter @mysten-incubation/devstack typecheck`
  - `pnpm --filter @mysten-incubation/devstack build`
  - `pnpm --filter @mysten-incubation/devstack test`
  - `pnpm --filter @mysten-incubation/devstack smoke:pack-consumer`
- Docs and scaffold proof:
  - `pnpm --filter @mysten-incubation/docs build`
  - `pnpm --filter @mysten-incubation/create-devstack-app typecheck`
  - `pnpm --filter @mysten-incubation/create-devstack-app build`
  - `pnpm --filter @mysten-incubation/create-devstack-app run check-template`
- Example typechecks against generated config:
  - `_template`
  - `connect-four`
  - `deepbook-trader`
  - `private-content`
  - `token-studio`
  - `fork-greeting`
- Private-content attached lifecycle proof remains required before release:
  - Build `@mysten-incubation/devstack` and `@mysten-incubation/dev-wallet` first.
  - From `examples/private-content`, run
    `DEVSTACK_APP=private-content node ../../packages/devstack/dist/cli/main.mjs up --renderer plain --verbose`.
  - Verify Sui, configured accounts, the Vault package, wallet, Seal, Walrus, and the Vite app all
    reach ready.
  - Verify `SIGINT` shuts the stack down cleanly, then run
    `DEVSTACK_APP=private-content node ../../packages/devstack/dist/cli/main.mjs wipe --yes --json`
    and confirm no stack-owned Docker resources remain.
- Browser/product proof:
  - `pnpm --filter @mysten-incubation/private-content test:e2e`
  - `pnpm --filter @mysten-incubation/token-studio test:e2e`
  - `pnpm --filter @mysten-incubation/deepbook-trader test:e2e`
- Real Docker proof:
  - `DEVSTACK_RUN_E2E=1 pnpm --filter @mysten-incubation/devstack test:e2e`
  - `node packages/devstack/dist/cli/main.mjs prune --dry-run --json`
- Preview-distribution proof:
  - The `Continuous Releases (pkg.pr.new)` PR workflow must pass.
  - A preview-installed scaffolded app must run `devstack apply`, verify its manifest identity, and
    wipe clean.

## Non-release follow-ups

These are intentionally not P0 release gates:

- Full fork-network runtime support.
- Full local DeepBook/Pyth/pool acquisition and real DeepBook swaps.
