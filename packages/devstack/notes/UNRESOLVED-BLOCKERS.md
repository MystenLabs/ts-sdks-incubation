# Unresolved blockers

Last updated: 2026-05-21.

This is the live blocker ledger. Do not remove an item until the fix is landed, the verification
evidence is recorded, and any stale review/backlog entry is either updated or deleted. Historical
notes were deleted after migration; this ledger is the current checklist.

## P0: CLI/TUI operator surface is not old-devstack quality

- Re-evaluate the CLI library/design. Help now has a command tree, but subcommand help, standard CLI
  behavior, and `up` integration still need a product-level acceptance pass against the live
  product.
- `up` intentionally remains split in the bin entry for outer-runtime/signal ownership; the split
  must stay verified.
- Required verb parity includes `apply`, `wipe`, `stack`, `fork`, `doctor`, `status`, `logs`,
  `snapshot save`, `snapshot restore`, `snapshot list`, `snapshot delete`, and shutdown/down flows.

Acceptance evidence:

- Manual live-operator proof covers startup pending/acquiring work, failure state/cause visibility,
  log stream placement, endpoint/extras grouping, row focus, and shutdown progress in the real TUI.
- Hard kill is available and tested.
- `devstack up --help`, subcommand help, `apply`, `wipe`, `stack`, `fork`, `doctor`, `status`,
  `logs`, `snapshot`, `exec`, and shutdown commands are production-real.

Evidence landed 2026-05-21:

- TUI renderer consumes the `EngineEvent` stream in Ink mode and renders bounded operator scrollback
  above the dashboard/status region. Targeted test: `test/surfaces/tui/event-log.test.ts`.
- TUI rows are grouped into service/package/account/action/app sections with friendly labels, owner
  chips, inline endpoint/value details, and selected-row detail/log panes. Targeted test:
  `test/surfaces/tui/display-derivation.test.ts`.
- TUI input maps `q`/Ctrl-C to `shutdown.requested` even before the first projection frame, and
  up/down/j/k move local row focus. Targeted test: `test/surfaces/tui/input-commands.test.ts`.
- CLI `exec` is exposed as a release verb, runs a child command through a surface-local runner, and
  mirrors the child exit code through both dispatcher and bin-entry wiring. Targeted tests:
  `test/surfaces/cli/dispatch.test.ts` / "exec mirrors the child exit code" and
  `test/cli/main.test.ts` / "exec through runCli mirrors the child exit code".
- Required CLI verb/subcommand help is generated from the command tree for `apply`, `wipe`, `stack`,
  `fork`, `doctor`, `status`, `logs`, `snapshot save|restore|list|delete`, `exec`, and `down`.
  Targeted test: `test/surfaces/cli/dispatch.test.ts` / "required release verbs and nested
  subcommands have command-tree help".
- The bin-entry `up` live path keeps its intentional dispatcher split covered: `up --help`
  short-circuits through the shared parser without loading config or starting the live path.
  Targeted tests: `test/surfaces/cli/dispatch.test.ts` and `test/cli/main.test.ts`.
- Plain renderer and TUI error-pane formatting keep startup failure cause/stderr chains visible.
  Targeted tests: `test/surfaces/tui/plain-renderer.test.ts` and
  `test/surfaces/tui/error-pane.test.ts`.
- Operator/API/extras wave targeted tests passed for CLI/TUI dispatch/rendering, including exec,
  help, command split, TUI event log, display derivation, input commands, plain rendering, and error
  panes.
- 2026-05-21 Worker Hard Kill: `EngineCommand` now includes `shutdown.hardKillRequested`; the L0
  signal handler publishes it on the second handled SIGINT/SIGTERM before scheduling process exit;
  the supervisor consumes it, flips shutdown state, and emits `shutdown.escalated` for
  renderers/plain logs; the command-channel publisher and ack path round-trip the hard-kill tag.
  Targeted tests passed:
  `pnpm --filter @mysten-incubation/devstack-rewrite exec vitest run test/substrate/runtime/lifecycle/signals.test.ts test/substrate/runtime/supervisor.test.ts test/substrate/runtime/cross-process/command-channel.test.ts test/surfaces/tui/input-commands.test.ts test/surfaces/tui/plain-renderer.test.ts test/surfaces/tui/event-log.test.ts`.

## P0: Engine state, errors, and logs are not wired as a reliable product

Acceptance evidence:

- Production logger publishes events consumed by projection, TUI, and `devstack logs`.
- Acquire and capability failures produce structured errors with plugin identity.
- Failed startup becomes an observable failed state.
- Production `status` reads persisted/replayed real state or is removed until real.
- Error tags are unique and catchable through the chosen public error style.

Evidence landed 2026-05-21:

- `layerLogger` is now part of the production substrate context; the supervisor wraps it so
  plugin-attributed logger calls publish `log.appended` events to the projection and event hub.
  Targeted test: `test/substrate/runtime/supervisor.test.ts` / "publishes logger lines as
  log.appended events and row log tails".
- Acquire failures now publish `error.reported` with the plugin key, set the row `failed`, attach
  `lastError`, and settle the cycle out of `booting`. Targeted test:
  `test/substrate/runtime/supervisor.test.ts` / "acquire failure publishes structured error and
  leaves a failed row".
- Dynamic capability factory throws now fail the plugin with `CapabilityFactoryFailed` instead of
  silently returning empty capabilities and marking ready. Targeted test:
  `test/substrate/runtime/supervisor.test.ts` / "capability factory failure reports a structured
  error instead of marking ready".
- Production `devstack up` persists the live projection to `projection.v1.json`; channel-backed
  `devstack status` reads that snapshot instead of a hard-coded null reader. Targeted test:
  `test/substrate/runtime/projection/persisted.test.ts`.
- Channel-backed `devstack logs` no longer uses a completed shutdown effect; the existing logs
  command NDJSON/envelope behavior remains covered by `test/surfaces/cli/commands/logs.test.ts`.
- Tagged-error style now has a final subsystem rule in `STYLE_GUIDE.md` §2. `ARCHITECTURE.md`
  narrows plain `Error` discipline to `build-integrations/runtime` synchronous readers, and the
  orphan WAL swap public export was removed so Walrus exports stay aligned with `WalrusError` and
  `WALRUS_ERROR_TAGS`.

## P0: Docker ownership and lifecycle safety

- Docker Desktop grouping labels were added, but manual visual verification remains open.
- Docker image/build contexts must keep required runtime assets available after packing.
- Native `linux/arm64` Walrus local-cluster image support remains unresolved: upstream Walrus
  `ubuntu-aarch64` devnet assets appear to contain x86-64 binaries. The CI `linux/amd64` path is
  covered by the deploy-capable release pin and binary preflight, but Apple Silicon/native arm64
  local Walrus needs an explicit platform policy, upstream fixed asset, or source-build fallback.
- Long-lived Docker hosts can still block local private-content apply before deploy when stale
  devstack networks exhaust Docker's predefined bridge address pools. Local repro after plugin
  network scoping failed with `all predefined address pools have been fully subnetted`; this needs a
  prune/wipe path or explicit network-subnet policy before relying on repeated local seed runs.

Acceptance evidence:

- Foreign-label containers/networks/volumes are refused or handled only under an explicit
  destructive policy.
- Resume failure and malformed inspect output have tests.
- Docker Desktop shows stack grouping equivalent to the old implementation, with router singleton
  behavior intentionally handled.
- `pnpm pack --dry-run` includes Dockerfile/image contexts needed by Sui/Postgres/Walrus/Seal.
- Walrus local-cluster image behavior is verified on `linux/amd64` and native `linux/arm64`, or the
  unsupported platform path fails early with a typed, actionable error.

Closed evidence:

- 2026-05-21 Worker F: container `inspect` now returns `null` only for not-found; daemon exits
  remain `DaemonUnreachable`, other non-notfound exits fail as `DockerInspectFailed`, and
  malformed/empty JSON fails as `DockerInspectDecodeFailed`. Targeted test:
  `test/runtime/docker/ownership-lifecycle.test.ts`.
- 2026-05-21 Worker F: same-name containers, networks, and volumes must match exact expected
  `devstack.*` ownership labels before reuse or mutation; handle-based
  exec/pause/commit/unpause/stop re-inspect the current container id and labels before acting.
  Targeted test: `test/runtime/docker/ownership-lifecycle.test.ts`.
- 2026-05-21 Worker F: secondary network attach uses the runtime connect classifier, so Docker's
  already-attached stderr is idempotent success while other connect failures remain typed. Targeted
  test: `test/runtime/docker/ownership-lifecycle.test.ts`.
- 2026-05-21 Worker F: stopped-container resume failures route through recreate policy; `never`
  refuses with `resume-failed` instead of rethrowing the raw start failure. Targeted test:
  `test/runtime/docker/ownership-lifecycle.test.ts`.
- 2026-05-21 Worker E: package `files` now includes `images` and excludes samples from packed
  source/dist; `npm pack --dry-run --json` showed all Sui/Postgres/Walrus/Seal image context files
  and `samples: []`.
- 2026-05-21 Walrus CI path: default Walrus release was bumped to `devnet-v1.49.0`; the Dockerfile
  and deploy script preflight required `walrus`, `walrus-node`, `walrus-deploy`, and `sui` binaries;
  deploy failures include stdout/stderr excerpts. Orchestrator validation built the Walrus image on
  `linux/amd64`, covering the previous missing-`walrus-deploy` exit-127 failure.

## P0: Package/export/build-integration release surface is broken

- Workspace-level cutover validation remains open for examples, docs, CI, lockfile, and installer
  smoke after the package-directory move.
- Install-from-tarball smoke still needs to import every exported subpath and boot a minimal stack
  after the package-directory move.
- `.github/workflows/devstack-e2e.yml` still targets the old example/product-test shape. Before
  workspace cutover, update the matrix/scripts or add equivalent replacement Playwright suites so CI
  exercises the replacement package, not stale v3 assumptions.

Acceptance evidence:

- `pnpm pack --dry-run` includes required runtime assets and excludes generated junk.
- Install-from-tarball smoke imports every exported subpath and boots a minimal stack.
- Browser-facing subpaths are node-free by static import audit.
- Root exports match the intended app/plugin-author vocabulary only.
- Vite, Vitest, Playwright, and browser integrations all read the same manifest/version contract.

Closed evidence:

- 2026-05-21 Package-directory cutover: generated/runtime outputs were removed before the move
  (`packages/devstack/{dist,node_modules,.turbo,.devstack}` and
  `packages/devstack-rewrite/{dist,node_modules,.turbo,.devstack,src/generated}` where present); old
  `notes/redesign`, `notes/v2-requirements`, `AGENTS.md`, and the snapshot smoke runbook were
  preserved under `packages/devstack/notes/`; the old package directory was deleted; the replacement
  implementation was moved to `packages/devstack`; `package.json` is now named
  `@mysten-incubation/devstack` with no `private` field.
- 2026-05-21 Preview Publish Audit: `pkg-pr-new.yml` already builds and publishes `./packages/*`; no
  workflow change is needed if cutover replaces old `packages/devstack` in place and leaves the
  replacement implementation as the sole non-private `@mysten-incubation/devstack` package.
- 2026-05-21 Worker E: `./samples` was removed from package exports and tsdown entries, and `files`
  excludes `src/samples`/`dist/samples`; `npm pack --dry-run --json` returned `samples: []`.
- 2026-05-21 Worker E: Vitest/browser setup injection now uses flat public subpaths
  `@mysten-incubation/devstack/vitest/setup` and `@mysten-incubation/devstack/browser/setup`;
  package exports include `./vitest/setup` and `./browser/setup`.
- 2026-05-21 Worker E: browser setup and browser barrel import the slot-only
  `build-integrations/runtime/browser.ts` barrel, avoiding the node-backed runtime barrel for
  browser-facing slot access.
- 2026-05-21 Worker E: `vitest` is now an optional peer dependency for the public Vitest/browser
  config subpaths.
- 2026-05-21 Worker E: targeted checks passed:
  `pnpm --filter @mysten-incubation/devstack-rewrite exec vitest run test/build-integrations/release-surface.test.ts test/build-integrations/browser/config.test.ts test/build-integrations/vitest/config.test.ts test/build-integrations/playwright/stack-context.test.ts test/build-integrations/runtime/cold-start-url.test.ts test/build-integrations/vite/cold-start-url.test.ts`
  and targeted `prettier -c`/`oxlint` on touched files.
- 2026-05-21 Worker Release Surface: root barrel and `./substrate` now exclude runtime service tags,
  identity context internals, plugin error-contribution machinery, plugin error-tag arrays, coin
  registry/cache/mint helpers, wallet HTTP/server helpers, and private engine protocol/state
  modules. Targeted test: `test/build-integrations/release-surface.test.ts` / "keeps root and
  substrate barrels on public vocabulary only".
- 2026-05-21 Worker Release Surface: build-integration manifest version parity is pinned against the
  substrate writer's `CURRENT_MANIFEST_VERSION`, and the runtime reader continues decoding through
  the shared `ManifestEnvelopeSchema`. Targeted test:
  `test/build-integrations/release-surface.test.ts` / "pins build-integration manifest version to
  the writer version".
- 2026-05-21 Worker Ledger Cleanup: build integrations now resolve the manifest stack as explicit
  stack option, then `DEVSTACK_STACK`, then `main`; package metadata remains app identity only.
  Manifest parity and adjacent discovery tests pass.
- 2026-05-21 Worker Ledger Cleanup: browser-facing static node-import audit passed with no matches
  in `src/build-integrations/browser` or `src/build-integrations/runtime/browser.ts`.
- 2026-05-21 Worker Ledger Cleanup: old nested build-integration/sample specifier audit passed with
  no matches.
- 2026-05-21 Worker Ledger Cleanup: after build, pack audit passed with required image/setup files
  present, `samples: 0`, `dist/node_modules: 0`, and `entries: 978`.
- 2026-05-21 Worker Ledger Finalize: package build and checkpoint pack/browser/static audits pass:
  pack includes required image/setup files and excludes samples/dist-node_modules; browser-facing
  static node-import audit has no matches; old nested specifier audit has no matches.
- 2026-05-21 Worker Release Surface: package metadata/exports were re-audited; the final rename to
  `@mysten-incubation/devstack` remains deferred because this branch still carries the
  `@mysten-incubation/devstack-rewrite` package identity and matching example imports.
- 2026-05-21 Worker Release Surface: targeted checks passed:
  `pnpm --filter @mysten-incubation/devstack-rewrite exec tsc --noEmit --pretty false`,
  `pnpm --filter @mysten-incubation/devstack-rewrite exec vitest run test/build-integrations/release-surface.test.ts test/build-integrations/manifest-path-parity.test.ts test/build-integrations/runtime/read-stack-context.test.ts test/build-integrations/vitest/config.test.ts test/build-integrations/browser/config.test.ts`,
  `npm pack --dry-run --json`, and targeted `prettier` on touched release-surface files.
- 2026-05-21 Worker Preview Manifest Discovery: `StackPathsService` now resolves stack roots as
  `<runtimeRoot>/stacks/<stack>`, so production `runStack` writes the manifest at the same
  stack-scoped location the public runtime resolver walks from an installed app root. The no-Docker
  `runStack` smoke boots a leaf stack with `runtimeRoot = <appRoot>/.devstack`, then proves both
  `discoverManifestPath({ cwd: appRoot, env: {}, stack: 'main' })` and `readStackContext(...)` find
  and read `<appRoot>/.devstack/stacks/main/manifest.json`. Targeted check passed:
  `pnpm --filter @mysten-incubation/devstack-rewrite exec vitest run test/api/run-stack.test.ts test/build-integrations/runtime/discover.test.ts test/build-integrations/runtime/read-stack-context.test.ts test/build-integrations/manifest-path-parity.test.ts`.
- 2026-05-21 Worker Preview Install Metadata: `tsdown` now emits release declarations, package
  `types` / `exports.*.types` point at `dist/**/*.d.mts`, and `files` excludes `src/generated` while
  preserving `src`, `dist`, and Docker image contexts. `release-surface.test.ts` now pins every
  exported subpath to matching built JS + declaration entries, verifies the CLI shebang stays out of
  declarations, and runs `npm pack --dry-run --json` to prove image contexts are included while
  `src/generated`, samples, and `dist/node_modules` are excluded. Focused checks passed:
  `pnpm --filter @mysten-incubation/devstack-rewrite build`,
  `pnpm --filter @mysten-incubation/devstack-rewrite exec vitest run test/build-integrations/release-surface.test.ts`,
  and a temporary NodeNext consumer type-smoke importing every exported subpath through package
  exports with `skipLibCheck: true`. Caveat: strict consumer `tsc` without `skipLibCheck` still
  fails inside third-party Effect/fast-check declarations before reporting package export errors;
  final package name/private and final install-from-tarball boot smoke remain open until cutover.
- 2026-05-21 Strict Consumer Closure: clean tarball install, `npx devstack --help`, and ESM runtime
  imports passed, but strict consumer `tsc` without `skipLibCheck` fails solely in
  `effect@4.0.0-beta.65` at `dist/internal/schema/schema.d.ts(3,15)` because `SchemaErrorTypeId` is
  referenced without a declaration. Published Effect v4 betas through `4.0.0-beta.70` still carry
  the same declaration bug, and importing even `effect/Effect` or `effect/Cause` reaches it through
  Effect's own declaration graph, so there is no safe dependency/catalog correction in this repo.
  Until Effect publishes a fixed v4 beta, strict packed consumers need `skipLibCheck: true`. Focused
  audit: `pnpm --filter @mysten-incubation/devstack smoke:pack-consumer`, which packs to a temp
  directory, installs in a clean consumer, checks `npx devstack --help`, checks runtime ESM imports
  for the root, `/vite`, and `/runtime` exports, and fails on any unexpected consumer type error.

## P0: Public API ergonomics and unsupported options are not release-quality

Acceptance evidence:

- Unsupported options are deleted from public types or implemented.
- Unknown network input fails with a typed error.
- DeepBook public options only represent real behavior.
- The key examples compile without `as never`, placeholder strings, magic identity strings, or
  handwritten SDK boilerplate that belongs in the substrate/API.
- Cross-plugin references use direct values unless a remaining exact exception is documented here.

Closed evidence:

- 2026-05-21 Worker Public API: `defineDevstack(account('alice'))` auto-mounts `sui()` for built-in
  and plugin-author members that consume `SuiTag`, preserves explicit Sui members, and keeps the
  auto-mounted member in the returned type/runtime tuple. Targeted test:
  `test/api/define-devstack.test.ts`.
- 2026-05-21 Worker Public API: stack names resolve by explicit option, `DEVSTACK_STACK`, nearest
  package metadata, then `main`; unknown `DEVSTACK_NETWORK` values now throw
  `DevstackNetworkParseError` instead of silently falling back. Targeted tests:
  `test/api/inference-network.test.ts` and `test/plugins/network-defaults.test.ts`.
- 2026-05-21 Worker Public API: wallet `accounts: 'all'` and bare `wallet()` expand against inferred
  account members, respect auto-mounted Sui, and empty resolved accounts fail with a typed
  `WalletBootError`. Targeted test: `test/plugins/wallet/accounts-all.test.ts`.
- 2026-05-21 Worker Public API: account env and inline private-key variants use the final public
  `key` / `privateKey` option names, and `examples/effect-app-rewrite/devstack.config.ts` now uses
  `{ kind: 'env', key: 'ALICE_PRIVATE_KEY' }`.
- 2026-05-21 Worker Public API: Sui local `image.pull` routes through the runtime pull path instead
  of the unwired local branch. Targeted test: `test/plugins/sui/local-image.test.ts`.
- 2026-05-21 Worker Public API: Walrus `local.seedAccounts` accepts direct account member refs and
  threads each account tag through `consumes`; the private-content example boot shape uses
  `walrus({ local: { seedAccounts: [publisher, alice, bob] } })`.
- 2026-05-21 Worker Public API: Seal local-keygen signer is a direct account member ref, the
  resolved value exposes key-server fields plus a manager slot through `SealResolved`, and
  unsupported manager tag constructors stay out of the public/root barrels. Targeted tests:
  `test/plugins/seal/public-refs.test.ts`, `test/plugins/seal/public-refs.test-d.ts`, and
  `test/build-integrations/release-surface.test.ts`.
- 2026-05-21 Worker Public API: DeepBook local mode exposes only real release behavior; unsupported
  local pools and market-maker options are refused at the type boundary, margin/Pyth/pool-spec and
  market-maker helper exports that cannot acquire real behavior are absent from the root release
  barrel, and the e2e smoke no longer pretends pools prove boot. Actual local pool creation, Pyth,
  margin, and market-maker helpers are deferred as non-P0 until they have real acquire behavior.
  Targeted tests: `test/plugins/deepbook/type-refusal.test-d.ts`,
  `test/plugins/deepbook/factory.test.ts`, and `test/e2e/deepbook-boot.test.ts`.
- 2026-05-21 Worker Package/Coin/Action Ergonomics: `localPackage` now supports declarative
  `capture: { key: '::module::Type' }`, packages expose discovered publish-receipt coins through
  `pkg.coins[...]`, the shared `pickCreatedByType` helper works for package publish changes and
  action receipts, and the package-scoped coin factory is the final `coin.fromPackage(pkg, witness)`
  name. `examples/fork-greeting-rewrite/devstack.config.ts`,
  `examples/token-studio-rewrite/devstack.config.ts`, and
  `examples/wallet-rewrite/devstack.config.ts` use the direct surfaces.
- 2026-05-21 Worker Package/Coin/Action Ergonomics: focused compile/runtime evidence passed:
  `pnpm --filter @mysten-incubation/devstack-rewrite exec vitest run test/plugins/package/capture.test.ts test/plugins/action/execute.test.ts test/plugins/coin/discovery.test.ts`,
  `pnpm --filter @mysten-incubation/devstack-rewrite exec tsc --noEmit --pretty false --target ES2022 --module NodeNext --moduleResolution NodeNext --lib ES2022,DOM --types node --jsx react-jsx --strict --allowImportingTsExtensions --skipLibCheck test/plugins/package/public-ergonomics.test-d.ts`,
  `pnpm --filter @mysten-incubation/devstack-rewrite exec tsc --noEmit --pretty false --target ES2022 --module NodeNext --moduleResolution NodeNext --lib ES2022,DOM --types node --jsx react-jsx --strict --allowImportingTsExtensions --skipLibCheck ../../examples/wallet-rewrite/devstack.config.ts ../../examples/token-studio-rewrite/devstack.config.ts ../../examples/fork-greeting-rewrite/devstack.config.ts`,
  and targeted `oxlint` on touched package/coin/action/example files.
- 2026-05-21 Worker Extras/Manifest Seam: stack-level `extras` now resolve after acquire through a
  direct member-value context, write through the manifest envelope's `extras` slot, and emit
  sensitive `extras.ts` through the normal codegen renderer. Targeted tests:
  `test/substrate/manifest-extras.test.ts`,
  `test/build-integrations/runtime/read-stack-context.test.ts`, and
  `test/orchestrators/codegen/service.test.ts`; targeted typecheck:
  `pnpm --filter @mysten-incubation/devstack-rewrite exec tsc --noEmit --pretty false`.
- 2026-05-21 Worker Ledger Finalize: direct cross-plugin references are closed for the known API
  wave surfaces: package/coin/action, Seal, Walrus, DeepBook, and stack extras now use direct public
  values or refuse unsupported options at the public boundary.
- 2026-05-21 Worker Ledger Finalize: targeted operator/API/extras tests passed across package, coin,
  action, DeepBook, manifest extras, build-integration runtime read context, and codegen service
  coverage.

## P0: Codegen contracts are inconsistent

Acceptance evidence:

- Codegen emit is single-evaluation and per-file atomic/idempotent; the false cycle-level staged
  promotion claim is removed.
- Bigint output is valid for the documented consumer API.
- Generated code is imported/typechecked in an always-on test path.
- Apps consume manifest/codegen/env/bridge only; app code does not import devstack engine modules.

Closed evidence:

- 2026-05-21 Worker Codegen: package emitters are evaluated once per cycle and the same emitted
  record feeds package pointer rendering, aggregate package output, and Move binding collection.
  Targeted test: `test/orchestrators/codegen/service.test.ts` / "evaluates each package emitter once
  while collecting bindings".
- 2026-05-21 Worker Codegen: Move bindings now write through the shared per-file atomic/idempotent
  emitter, and unchanged binding files are reported as no-write on a second cycle. Targeted test:
  `test/orchestrators/codegen/service.test.ts` / "imports generated package pointer, aggregate, and
  Move binding modules without sui".
- 2026-05-21 Worker Codegen: bigint rendering emits quoted decimal strings without an `n` suffix, so
  `BigInt(<string>)` is valid. Targeted test: `test/orchestrators/codegen/format.test.ts`.
- 2026-05-21 Worker Codegen: generated package pointer, aggregate package file, and generated Move
  binding modules are imported in an always-on stubbed codegen test path that does not depend on a
  host `sui` binary. Targeted test: `test/orchestrators/codegen/service.test.ts`.
- 2026-05-21 Worker Codegen: generated-file rendering rejects imports from devstack package exports
  or relative `src/` paths, keeping generated browser-consumed files from pulling devstack source
  into app bundles. Targeted test: `test/orchestrators/codegen/format.test.ts`.
- 2026-05-21 Worker Codegen: targeted checks passed:
  `pnpm --filter @mysten-incubation/devstack-rewrite exec vitest run test/orchestrators/codegen/service.test.ts test/orchestrators/codegen/format.test.ts test/orchestrators/codegen/gitignore.test.ts test/orchestrators/codegen/permissions.test.ts`
  and targeted `prettier -c` on touched codegen files.
- 2026-05-21 Worker Docker Summary: production Move summary codegen runs through the vendored Sui
  CLI Docker image instead of host `sui`, and the one-shot command re-owns/chmods the mounted
  summary scratch directory on container exit so CI can clean root-written package summary files.
  Targeted test passed: `test/orchestrators/codegen/bindings.test.ts`; orchestrator validation
  passed `pnpm turbo build --filter=@mysten-incubation/_template`, covering the previous
  `EACCES: permission denied, unlink .../package_summaries/address_mapping.json` failure.
- 2026-05-21 Worker Move Cache Scrub: host `scrubLocksHost` still fails on unreadable/unwritable
  package-owned `Move.lock` files, but cached `~/.move/git/**/Move.lock` files are best-effort so
  root-owned Docker cache entries do not break Docker-backed production builds before the container
  scrub runs. Targeted test passed: `test/substrate/runtime/sui-move-build/sui-move-build.test.ts`.
- 2026-05-21 Worker Snapshot Scrub: Docker-backed package publish now declares when the build path
  scrubs inside the container, allowing host `scrubLocksHost` to treat package-owned `Move.lock`
  rewrite failures as best-effort only for that container-backed path while keeping host-only builds
  strict. Targeted test passed: `test/substrate/runtime/sui-move-build/sui-move-build.test.ts`; an
  isolated arena proof ran `apply`, made `move/connect_four/Move.lock` read-only, then
  `snapshot save baseline` successfully captured.

## P1: Product evidence is too stub-heavy

- Several e2e tests prove harness wiring or stub outputs rather than real product behavior.
- Shared boot harness uses stub Traefik and stub Move codegen in places where product tests need the
  real orchestrators.
- Private-content must prove encrypt -> Walrus store -> Walrus fetch -> decrypt.
- DeepBook boot tests are not Docker-driven product evidence.
- Redis routable behavior is described but not proven through the routed path or collision path.
- Docker-dependent tests can soft-skip with warnings, which weakens release evidence.
- Wallet needs coin balance and endpoint reachability evidence.
- Postgres needs DB existence, route, and snapshot evidence.
- Effect-app needs dev/prod branch evidence.
- Fork-greeting needs either fork-mode evidence or an explicit cutover deferral.
- Walrus/Seal need restore/codegen evidence.
- Manual verification must cover parallel stacks per service: Sui, faucet, wallet, Walrus, Seal,
  DeepBook, Postgres, and plugin-author Redis.

Acceptance evidence:

- Tests are classified as unit/harness/product e2e.
- Docker/Sui skips are explicit release-gate failures in CI or a clearly separate optional lane.
- Public examples have Playwright/product tests for their advertised behavior.
- Manual scenario signoff is recorded only after P0 blockers are closed.

## P1: Snapshot identity and restore behavior

- Snapshot capture can merge conflicting identity keys by last-write-wins before restore-time
  conflict detection runs.
- Wallet/Seal/Walrus snapshot coverage needs behavior roundtrips, not only declaration-shape tests.
- Full save/restore command routing and non-empty capture/restore flows remain open.
- Snapshot start-time/PID identity must not use stub or zero values.

Acceptance evidence:

- Capture rejects conflicting identity contributions before artifact creation.
- Product snapshot tests prove non-empty capture and restore for representative plugins.
- Restore preserves plugin identity and state without cross-stack identity drift.

## P1: Architecture and layering cleanup

- L0 substrate composition must not import L2 plugin registries or concrete Docker layers in runtime
  composition paths. Move composition upward and keep substrate name-blind.
- Router default entrypoints still encode plugin names centrally. Plugin routable contributions
  should own entrypoint declarations where practical.
- Router entrypoint ownership and TOCTOU collision checks need acceptance evidence.
- The Coin/Package `PublishReceipt` relationship needs a substrate-raised event or another explicit
  seam; do not add more direct plugin cross-imports.
- `Endpoint.pluginKey`/row attribution must remain available for projection, manifest, and operator
  surfaces.
- Runtime/build-integration duplication and stale self-references must be reconciled before cutover.
- Phase markers, scaffold text, compatibility/shim language, and broad `as never` / `as unknown as`
  casts still need a release sweep.
- Post-acquire capability behavior must not allow ready plugins with silently empty capabilities.

Acceptance evidence:

- Grep checks for phase markers, scaffold language, samples, sentinel strings, and forbidden casts
  are clean or each remaining hit has a documented owner and reason.
- Layering audits show substrate remains name-blind except documented allowed primitives.
- Router, endpoint, and PublishReceipt seams have tests or documented accepted tradeoffs.

## P1: Docs and examples do not match release truth

- Public docs still show old PascalCase API imports and old codegen/snapshot behavior.
- Snapshot docs claim cross-stack restore is allowed while runtime identity guard rejects stack
  mismatches.
- Examples mix public runnable apps, smoke/config examples, incomplete private-content,
  typecheck-only DeepBook, and stale deferred Playwright text.
- Example comments that explain "differences from v3" or future phase work must be removed or
  replaced by working API.

Acceptance evidence:

- Release docs are rewritten against the current API or removed until accurate.
- Public examples are either product-runnable and tested, or explicitly internal/experimental.

## Worktree and checkpoint blockers

- Clean generated artifacts before staging.
- Package generated/runtime outputs were cleaned before the package-directory move; example-side
  generated/runtime cleanup remains open for the workspace cutover.
- Regenerate the lockfile after removing stale generated importers.
- Exclude unrelated dev-wallet/changeset/old `examples/wallet` dirty files.
- Do not create a giant checkpoint commit. Use the checkpoint sequence in `CURRENT-HANDOFF.md`.

Closed evidence:

- 2026-05-21 Worker Ledger Cleanup: after typecheck cleanup, these commands pass:
  `pnpm --filter @mysten-incubation/devstack-rewrite typecheck`,
  `pnpm --filter @mysten-incubation/example-effect-app-rewrite typecheck`, and
  `pnpm --filter @mysten-incubation/example-deepbook-full-rewrite typecheck`.
- 2026-05-21 Worker Ledger Finalize: package typecheck passes:
  `pnpm --filter @mysten-incubation/devstack-rewrite typecheck`.
- 2026-05-21 Worker Ledger Finalize: changed-file formatting passes using Prettier on changed files,
  and changed-file oxlint passes with 0 warnings / 0 errors.
- 2026-05-21 Worker Ledger Finalize: targeted operator/API/extras wave tests pass across 17 files /
  95 tests covering CLI/TUI dispatch/rendering, package/coin/action, DeepBook, manifest extras,
  build-integration runtime read context, and codegen service.
- 2026-05-21 Worker Ledger Finalize: example typechecks pass for
  `@mysten-incubation/example-wallet-rewrite`, `@mysten-incubation/example-token-studio-rewrite`,
  `@mysten-incubation/example-fork-greeting-rewrite`, and
  `@mysten-incubation/example-deepbook-full-rewrite`. Wallet and token-studio typecheck scripts run
  `devstack apply` and logged non-fatal `sui#0` acquire failures, so this is typecheck/config
  evidence only, not product boot evidence.
- 2026-05-21 Worker Ledger Cleanup: combined targeted test wave passes across 35 files / 217 tests
  covering API inference/runStack, CLI flags, release surface/build integrations, codegen,
  wallet/account/Sui, Seal/Walrus, DeepBook, and adjusted e2e smoke.
- 2026-05-21 Worker Ledger Cleanup: package build passes:
  `pnpm --filter @mysten-incubation/devstack-rewrite build`.
- 2026-05-21 Worker Ledger Finalize: package build passes:
  `pnpm --filter @mysten-incubation/devstack-rewrite build`.
- 2026-05-21 Orchestrator Runtime/Error Checkpoint: package typecheck, package build, and full
  package tests passed after the hard-kill/error-style wave:
  `pnpm --filter @mysten-incubation/devstack-rewrite typecheck`,
  `pnpm --filter @mysten-incubation/devstack-rewrite build`, and
  `pnpm --filter @mysten-incubation/devstack-rewrite test` (126 files / 829 tests). Focused
  hard-kill/stage-and-swap tests also passed across 7 files / 43 tests; changed-file Prettier,
  changed-file oxlint, and `git diff --check` passed.
- 2026-05-21 Worker Full-Suite Timeout: the two isolation-green tests that exceeded Vitest's 5s
  in-process default under full-suite load now carry explicit 10s test timeouts while keeping their
  existing assertions and internal waits intact. Focused check passed:
  `pnpm --filter @mysten-incubation/devstack-rewrite exec vitest run test/orchestrators/snapshot/restore.test.ts test/runtime/docker/ensure-container-paused.test.ts --bail=1`.

## Partially completed items that still need verification

- Command-tree/help work landed, but standard CLI behavior and subcommand UX still need acceptance.
- TUI renderer selection, log stream, grouping, endpoints, cause rendering, `q` routing, and
  hard-kill/second-signal behavior have targeted tests, but manual live operator proof remains open.
- Startup pending display had partial early-handle work; verify against real startup and failure in
  manual product evidence.
- Docker Desktop grouping labels were implemented, but visual verification remains open.
- Router/profile/traffic work has strong tests, but manual parallel-stack and bad-state checks
  remain open.
- Snapshot ID/integrity/transaction staging work landed, but full product save/restore remains open.
