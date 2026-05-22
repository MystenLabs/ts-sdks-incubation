# Devstack live blockers

Last updated: 2026-05-21.

This file is intentionally short. Resolved worker logs and migration history were removed so future
sessions start from the current product truth instead of old cleanup noise. Use git history for
archaeology.

## Current decisions

- The example set is curated. Deleted mini/examples stay deleted: `effect-app`, `hello-world`,
  `plugin-author-redis`, `postgres-mini`, `seal-mini`, and `walrus-mini`.
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

## Open P0 blockers

### Private-content browser proof

Private-content now has real app code and a Playwright spec for:

`encrypt -> Walrus store -> Walrus fetch -> Seal decrypt`

Current boot evidence verifies the stack shape and resolved Walrus/Seal values, but the real browser
roundtrip has not been rerun since the latest Walrus/Sui readiness fix.

Resolved 2026-05-21: the previous local Walrus readiness failure was not a Walrus release-binary
problem. The root cause was Sui localnet pruning. `packages/devstack/images/sui/entrypoint.sh`
patched only `fullnode.yaml`, while `sui start` localnet also reads `network.yaml` and per-validator
YAML files that still had aggressive pruning (`num-epochs-to-retain: 0`). Walrus then bootstrapped
from a package-publish checkpoint that Sui had already pruned, producing
`Checkpoint 20194 not found` and shutting the storage node down.

Current status:

- Sui entrypoint now patches every generated YAML containing `authority-store-pruning-config`,
  including `num-epochs-to-retain-for-checkpoints`.
- Docker image content hashes now include files under the build context, so entrypoint/script edits
  invalidate managed image tags instead of reusing stale images.
- `pnpm --filter @mysten-incubation/private-content typecheck` passed on 2026-05-21 after
  `devstack apply` booted Sui, accounts, the vault package, Seal, wallet, and Walrus. The old
  `storage-node-3 never became ready` / `Checkpoint ... not found` failure did not recur.

Still open:

- Run `pnpm --filter @mysten-incubation/private-content test:e2e` to prove the browser roundtrip.
- The latest apply still warned that the wallet origin allowlist is empty because this stack has no
  Vite plugin and no `allowedOrigins`. If browser proof fails at wallet connection/pairing, fix the
  private-content wallet/Vite origin path before reopening Walrus readiness.

### Live TUI/operator proof

The TUI/CLI surface has targeted tests, but still needs a manual live proof against a real stack
lifecycle:

- boot/progress display
- log stream placement
- endpoint/extras grouping
- failure cause rendering
- shutdown
- hard-kill/second-signal behavior

### Installed-consumer boot

The preview/tarball smoke already covered install/import/browser/Vite/Vitest paths at the last clean
checkpoint, but a clean temp consumer still needs to boot a minimal stack from the installed
package.

### Docker/manual lifecycle proof

Current status:

- Docker Desktop grouping labels are implemented and unit-pinned for containers, networks, and
  volumes, but the actual Docker Desktop visual grouping has not been manually verified.
- `wipe` has a stack-scoped managed-resource path that removes containers, networks, and volumes by
  ownership labels. The runtime also classifies Docker bridge-pool exhaustion as
  `network-address-pool-exhausted` with a wipe/prune/subnet hint.
- The broader long-lived-host story is still not closed: `prune` currently sweeps snapshot catalog
  entries and managed images, not stale managed networks, and unlabelled/foreign networks remain
  outside devstack's destructive scope by design.

Still open:

- Docker Desktop visual grouping.
- Broader stale-network prune/wipe story for long-lived Docker hosts.

## Open P1 blockers

- Release docs still need a current API sweep.
- Snapshot identity conflict rejection and start-time/PID identity need final evidence.
- Wallet/token-studio/fork-greeting need current product evidence appropriate to their advertised
  behavior.
- Docker-dependent tests that soft-skip are classified as follows: Docker absence is an environment
  gap for release-gate lanes, not a passing result; fake-Docker runtime tests remain the normal
  package regression lane; real-Docker e2e files belong in a separate Docker lane. The prior
  `test/e2e/router-real-traffic.test.ts` fixture label mismatch is resolved; keep future failures
  classified by current evidence rather than the stale `ForeignDockerResource` defect.

## Current evidence

- `examples/README.md` now lists only `_template`, `deepbook-full`, `private-content`,
  `token-studio`, and `wallet` as runnable apps. `arena` and `fork-greeting` are listed as
  stack/config targets.
- Stale e2e boot tests for deleted examples were removed. Remaining boot tests point at final
  directory names instead of `*-rewrite`.
- `private-content-boot.test.ts` uses the test-owned
  `packages/devstack/test/e2e/fixtures/walrus-stub` fixture instead of the deleted
  `examples/walrus-mini` path.
- Private-content now builds workspace dependencies before `devstack apply` in its build/typecheck
  scripts so a clean checkout has `@mysten-incubation/devstack` and `@mysten-incubation/dev-wallet`
  `dist/` outputs before Vite/TypeScript load package exports.
- Sui pruning patch syntax check passed: `sh -n packages/devstack/images/sui/entrypoint.sh`.
- Docker build-cache regression check passed:
  `pnpm --filter @mysten-incubation/devstack exec vitest run test/runtime/docker/build-content-hash.test.ts`
  (1 file / 5 tests).
- Package build passed after the Docker build-context hash change:
  `pnpm --filter @mysten-incubation/devstack build`.
- Private-content typecheck passed after the Walrus/Sui readiness and dependency-build fixes:
  `pnpm --filter @mysten-incubation/private-content typecheck`.
- Private-content boot passed after building devstack from the working tree:
  `DEVSTACK_RUN_E2E=1 pnpm --filter @mysten-incubation/devstack exec vitest run test/e2e/private-content-boot.test.ts test/e2e/deepbook-boot.test.ts`
  (2 files / 6 tests).
- `deepbook-full` is now a real Vite/React browser app. It consumes generated `deepbook/deepbook`
  bindings, renders the known testnet DeepBook package/registry/Pyth handles, and offers a market
  console that queries DeepBook pool id, registration, mid price, vault balances, trade/book params,
  order book ticks, and Pyth price-object age through `@mysten/deepbook-v3`.
- DeepBook app checks passed: `pnpm --filter @mysten-incubation/deepbook-full typecheck`,
  `pnpm --filter @mysten-incubation/deepbook-full build`,
  `pnpm --filter @mysten-incubation/deepbook-full exec vitest run` (no test files by design; the
  current repo resolves Vitest 2 against Vite 7 for examples), and
  `pnpm --filter @mysten-incubation/deepbook-full test:e2e` (1 Chromium smoke).
- Devstack focused boot/plugin checks passed:
  `pnpm --filter @mysten-incubation/devstack exec vitest run test/plugins/deepbook/factory.test.ts`
  (1 file / 14 tests) and
  `pnpm --filter @mysten-incubation/devstack exec env DEVSTACK_RUN_E2E=1 vitest run test/e2e/deepbook-boot.test.ts test/e2e/private-content-boot.test.ts`
  (2 files / 6 tests).
- Local Pyth publishing remains unwired and intentionally absent from the public local DeepBook
  options until it has real acquire behavior; the shipped `deepbook-full` demo is explicitly a
  known-deployment/testnet market console.
- Seal now derives a deterministic per-stack Docker subnet and passes it to `ensureNetwork`,
  avoiding the local `network-address-pool-exhausted` failure seen at `seal:seal#6`.
- DeepBook known deployments include Pyth state IDs for testnet/mainnet, and `deepbook-network`
  generated bindings emit those IDs.
- Focused tests passed:
  `pnpm --filter @mysten-incubation/devstack exec vitest run test/plugins/deepbook/factory.test.ts test/plugins/seal/key-server-spec.test.ts test/plugins/walrus/storage-nodes.test.ts`
  (3 files / 35 tests).
- Package typecheck passed: `pnpm --filter @mysten-incubation/devstack typecheck`.
- CLI surface was rebuilt around Stricli command-scoped parsing. Focused CLI/TUI tests passed:
  `pnpm --filter @mysten-incubation/devstack exec vitest run test/surfaces/cli test/cli test/surfaces/tui/input-commands.test.ts test/surfaces/tui/plain-renderer.test.ts test/surfaces/tui/error-pane.test.ts`
  (13 files / 76 tests).
- CLI prune is now direct/offline, `wipe` and `snapshot restore` refuse to mutate while an attached
  `devstack up` session is live, and removed peer commands fail as unknown routes.
- Built CLI smoke passed for `schema --json`, `prune --dry-run --json`, invalid
  `apply --renderer plain`, invalid `snapshot restore --config`, and removed `down --json`.
- Package build passed after the CLI rewrite: `pnpm --filter @mysten-incubation/devstack build`.
- Earlier working-tree checks also passed: `pnpm --filter @mysten-incubation/devstack build`,
  `pnpm --filter @mysten-incubation/example-deepbook-full typecheck`, and
  `pnpm --filter @mysten-incubation/devstack exec vitest run test/plugins/seal/key-server-spec.test.ts test/plugins/walrus/storage-nodes.test.ts`.
- Docker host was reachable locally on 2026-05-21: `docker info --format '{{.ServerVersion}}'`
  returned `29.4.0`.
- Docker runtime regression suite passed:
  `pnpm --filter @mysten-incubation/devstack exec vitest run test/runtime/docker` (12 files / 97
  tests).
- Focused Docker lifecycle/image roundtrip passed:
  `pnpm --filter @mysten-incubation/devstack exec env DEVSTACK_RUN_E2E=1 vitest run test/e2e/snapshot-container-image-roundtrip.test.ts`
  (1 file / 1 test).
- Focused real-Docker router traffic passed after the fixture pre-created the router network with
  router-managed labels (`app=devstack-router`, `stack=<profile.networkName>`, `composeUi: false`)
  instead of `router-real-traffic/e2e` labels:
  `DEVSTACK_RUN_E2E=1 pnpm --filter @mysten-incubation/devstack exec vitest run test/e2e/router-real-traffic.test.ts`
  (1 file / 1 test).
