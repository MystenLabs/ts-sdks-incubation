# Devstack live blockers

Last updated: 2026-05-22.

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

### Private-content browser proof - resolved 2026-05-22

Private-content now has real app code and a Playwright spec for:

`encrypt -> Walrus store -> Walrus fetch -> Seal decrypt`

Current boot evidence verifies the stack shape and resolved Walrus/Seal values. The real browser
roundtrip has now been rerun after the latest Walrus/Sui readiness fix.

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

Current evidence:

- `pnpm --filter @mysten-incubation/private-content test:e2e` passed on 2026-05-22.
- The test booted Sui, accounts, the vault package, Seal, wallet, Walrus, and the host app, then
  passed `e2e/seal-flow.spec.ts` in Chromium.

### Live TUI/operator proof - resolved 2026-05-22

The TUI/CLI surface has targeted tests and a manual live proof against a real stack lifecycle:

- boot/progress display
- log stream placement
- endpoint/extras grouping
- failure cause rendering
- shutdown
- hard-kill/second-signal behavior

Current evidence:

- The live proof found and fixed a real router-profile blocker before closing this item. Router
  profiles now prefer the stable Docker endpoint context identity over daemon ID when both are
  available. The previous daemon-ID profile tried to bind the fixed router ports while an older
  context-profile router was already running; the rebuilt CLI now resolves to the context profile
  and adopts the existing router singleton.
- TUI row grouping now uses a renderer-owned classifier table and has built-in-family coverage in
  `test/surfaces/tui/display-derivation.test.ts`.
- CLI reference docs are pinned to `COMMAND_TREE` by `test/surfaces/cli/docs-drift.test.ts`.
- Focused operator verification passed on 2026-05-22:
  `pnpm --filter @mysten-incubation/devstack exec vitest run test/surfaces/tui/display-derivation.test.ts test/surfaces/tui/dashboard.test.tsx test/surfaces/tui/plain-renderer.test.ts test/surfaces/tui/no-display-vocab.test.ts test/cli/main.test.ts test/cli/flags.test.ts test/surfaces/cli/dispatch.test.ts test/surfaces/cli/envelope.test.ts test/surfaces/cli/docs-drift.test.ts test/substrate/runtime/projection/persisted.test.ts test/substrate/runtime/projection/update.test.ts`
  (11 files / 104 tests).
- Focused router-profile verification passed on 2026-05-22:
  `pnpm --filter @mysten-incubation/devstack exec vitest run test/orchestrators/router/runtime-composition.test.ts test/orchestrators/router/traefik-container.test.ts test/surfaces/cli/commands/doctor-probes.test.ts`
  (3 files / 23 tests).
- Focused signal/escalation verification passed on 2026-05-22:
  `pnpm --filter @mysten-incubation/devstack exec vitest run test/surfaces/tui/input-commands.test.ts test/surfaces/tui/event-log.test.ts test/surfaces/tui/plain-renderer.test.ts test/substrate/runtime/supervisor.test.ts`
  (4 files / 40 tests).
- Real-Docker router traffic passed on 2026-05-22:
  `pnpm --filter @mysten-incubation/devstack exec env DEVSTACK_RUN_E2E=1 vitest run test/e2e/router-real-traffic.test.ts`
  (1 file / 1 test).
- Manual live TUI proof passed on 2026-05-22 from `examples/_template`:
  `node ../../packages/devstack/dist/cli/main.mjs up --app tui-proof --stack main --state-dir .devstack-tui-proof --renderer tui --verbose`.
  The PTY reached `running`, `6/6 ready`, 5 URLs, 2 accounts, 1 package, and no errors. The visible
  rows grouped Services, Packages, and Accounts; showed Sui `rpc`/`faucet`/`graphql`, wallet, and
  app URLs; showed the `hello` package ID/MVR; and showed Alice/Bob addresses.
- The same manual session handled `SIGINT`: the TUI logged
  `Stack shutdown requested; waiting for graceful stop`, displayed `shutting-down`, showed
  App/Wallet as stopped and Sui as stopping, then exited cleanly. A follow-up
  `wipe --app tui-proof --stack main --state-dir .devstack-tui-proof --yes --json` returned
  `ok: true`, and no `tui-proof` containers, networks, or volumes remained.
- `pnpm --filter @mysten-incubation/docs build` passed on 2026-05-22.
- `pnpm --filter @mysten-incubation/devstack typecheck` and
  `pnpm --filter @mysten-incubation/devstack build` passed on 2026-05-22 after the parallel boundary
  lane settled. They were rerun after the router-profile fix.

### Installed-consumer boot - resolved 2026-05-22

The packed-consumer smoke now packs the current devstack package, installs it into a clean temp
consumer, verifies root/Vite/runtime imports, verifies removed `contracts` and `substrate` subpaths
stay unexported, runs `devstack apply` against a minimal plugin stack from the installed package,
checks the manifest and marker file, checks stack-context reads, and runs a skip-lib-check consumer
typecheck.

Current evidence:

- `pnpm --filter @mysten-incubation/devstack smoke:pack-consumer` passed on 2026-05-22 with the
  dist/images-only package shape.

### Docker/manual lifecycle proof

Current status:

- Docker Desktop grouping labels are implemented and unit-pinned for containers, networks, and
  volumes. Docker Desktop visual grouping was manually verified by the user on 2026-05-22.
- `wipe` has a stack-scoped managed-resource path that removes containers, networks, and volumes by
  ownership labels. The runtime also classifies Docker bridge-pool exhaustion as
  `network-address-pool-exhausted` with a wipe/prune/subnet hint.
- The broader long-lived-host story is closed for devstack-owned resources: `prune` inventories
  devstack-labeled containers, networks, volumes, and managed images; defaults to containers,
  networks, and volumes; removes managed networks best-effort with active-endpoint/in-use skips; and
  leaves shared router profile groups unselected by default.
- Unlabelled/foreign Docker networks remain outside devstack's destructive scope by design.

Current evidence:

- Focused Docker cleanup checks passed on 2026-05-22:
  `pnpm --filter @mysten-incubation/devstack exec vitest run test/runtime/docker/remove-managed-resources.test.ts test/orchestrators/snapshot/cleanup.test.ts test/runtime/docker/error-mapping.test.ts test/surfaces/cli/dispatch.test.ts`
  (4 files / 37 tests).
- Built CLI dry-run passed on 2026-05-22:
  `node packages/devstack/dist/cli/main.mjs prune --dry-run --json`. The inventory reported 5
  devstack-labeled networks, selected 3 non-shared networks for dry-run removal, and left shared
  router profile groups unselected by default.

### Final package preview proof

Local tarball proof is current, but the real preview-distribution path still needs one final manual
pass after the release branch settles.

Current evidence:

- `pnpm --filter @mysten-incubation/devstack smoke:pack-consumer` packs devstack, installs the
  tarball into a clean temp consumer, verifies root/Vite/runtime imports, verifies removed subpaths
  stay unexported, boots a minimal installed stack, checks the manifest and stack context, and runs
  a skip-lib-check consumer typecheck. It was rerun after the router-profile fix.
- `pnpm --filter @mysten-incubation/devstack exec npm pack --dry-run --json` passed on 2026-05-22.
  The file list is `dist`, `images`, `README.md`, and `package.json`; no `src`, generated app
  bindings, samples, nested `node_modules`, Move build output, or local runtime state are shipped.
- `pnpm --filter @mysten-incubation/create-devstack-app exec npm pack --dry-run --json` passed on
  2026-05-22. The file list is `dist`, `template`, `README.md`, and `package.json`.
- A create-devstack-app tarball smoke passed on 2026-05-22: install the local `.tgz`, run the
  published `create-devstack-app` bin with `--no-install --no-git`, verify the generated app name
  and `DEVSTACK_APP` scripts are rewritten, verify the router origin is rewritten, and verify
  `src/generated` is absent.

Still open:

- Run the actual `pkg.pr.new` / `pkg.new` preview flow.
- Install/scaffold from the preview packages instead of local tarballs, then boot one minimal stack
  from those preview packages.

## Resolved P1 blockers and release classifications

- Packed declaration repair step resolved on 2026-05-22.
  `packages/devstack/scripts/repair-effect-dts-imports.mjs` was removed, and
  `packages/devstack/package.json` now builds with plain `tsdown`. The root cause was the
  devstack-local catch-all `paths: { "*": ["./*"] }` mapping, which made declaration generation name
  Effect helper subpaths as physical `node_modules/effect/dist/*` specifiers. With that mapping
  removed from `packages/devstack/tsconfig.json`, `tsdown` emits public Effect subpaths directly.
  `test/build-integrations/release-surface.test.ts` now scans packed `.d.mts` files for
  package-local Effect specifiers, `.pnpm/effect`, and `.js` Effect subpath imports.
- Release docs current API sweep passed on 2026-05-22:
  `pnpm --filter @mysten-incubation/docs build`, plus a stale-marker scan over README, docs,
  examples, and the scaffolder template for removed API terms.
- Snapshot identity conflict rejection and start-time/PID identity resolved on 2026-05-22. The
  identity guard now has focused conflict/fail-closed coverage, and snapshot reservations have
  focused PID/start-time tests for live-holder refusal, finalizer cleanup, and stale same-PID
  start-time orphan sweep. The orphan sweep bug where parsed reservations were treated as
  foreign-host alive was fixed by forcing the reservation liveness check through the same-host path.
  Verification:
  `pnpm --filter @mysten-incubation/devstack exec vitest run test/orchestrators/snapshot/identity-guard.test.ts test/orchestrators/snapshot/restore.test.ts test/substrate/runtime/cross-process/snapshot-reservation.test.ts test/substrate/runtime/cross-process/roster.test.ts test/substrate/runtime/cross-process/stack-lock.test.ts test/surfaces/cli/commands/supervisor-presence.test.ts`
  (6 files / 45 tests).
- Wallet product proof resolved on 2026-05-22: `pnpm --filter @mysten-incubation/wallet test:e2e`
  passed both browser send flows against a real devstack stack.
- Token-studio product proof resolved on 2026-05-22:
  `pnpm --filter @mysten-incubation/token-studio test:e2e` passed both browser mint/transfer flows
  against a real devstack stack.
- Fork-greeting is no longer a release blocker. Forking is a coming-soon feature, so
  `examples/fork-greeting` remains prototype coverage but is no longer advertised as a runnable
  release target. Fork network selection now fails explicitly with a coming-soon error through the
  CLI/env parser, and direct `sui({ mode: 'fork', ... })` usage throws `SuiForkComingSoonError`.
- Docker-dependent tests that soft-skip are classified as follows: Docker absence is an environment
  gap for release-gate lanes, not a passing result; fake-Docker runtime tests remain the normal
  package regression lane; real-Docker e2e files belong in a separate Docker lane. The prior
  `test/e2e/router-real-traffic.test.ts` fixture label mismatch is resolved; keep future failures
  classified by current evidence rather than the stale `ForeignDockerResource` defect.
- Exported example/template `devstack.config.ts` declarations no longer infer internal package
  `dist` paths. `Stack` now has an erased public annotation form, and direct node-config checks
  passed for `wallet`, `token-studio`, `private-content`, `deepbook-full`, `connect-four`,
  `_template`, plus `example-fork-greeting` package typecheck.

## Current evidence

- `examples/README.md` now lists only `_template`, `deepbook-full`, `private-content`,
  `token-studio`, and `wallet` as runnable apps. `connect-four` is listed as a stack/config target.
  `fork-greeting` is marked coming soon.
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
