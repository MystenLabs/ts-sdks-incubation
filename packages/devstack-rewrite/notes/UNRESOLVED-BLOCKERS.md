# Unresolved blockers

Last updated: 2026-05-21.

This is the live blocker ledger. Do not remove an item until the fix is landed, the verification
evidence is recorded, and any stale review/backlog entry is either updated or deleted. Historical
notes were deleted after migration; this ledger is the current checklist.

## P0: CLI/TUI operator surface is not old-devstack quality

- Restore the old log-stream-above-status pattern. The rewrite currently focuses on row tails and
  does not provide the same global stream above the main status area.
- Show startup pending/acquiring work before Docker has fully booted. Startup failures must leave a
  visible failed state, not a permanent `booting` state.
- Surface Seal/private-content root causes with stderr/cause context in the TUI and plain renderer.
- Group output intuitively by service/package/account/action/app, with friendly labels, primary
  values, extras, endpoints, and plugin ownership. Opaque internal keys are not acceptable as the
  main operator vocabulary.
- Wire row focus/selection into details/log panes.
- Add graceful `q`/quit behavior during startup and steady state.
- Add an explicit hard-kill path and make second-signal behavior testable. TUI-only blocker:
  `EngineCommand` currently has `shutdown.requested` but no explicit hard-kill or second-signal
  command/ack state for the renderer to publish or assert against.
- Re-evaluate the CLI library/design. Help now has a command tree, but subcommand help, standard CLI
  behavior, and `up` integration still need a product-level acceptance pass.
- `up` must route through the dispatcher or the parser split must be intentionally documented and
  verified.
- Required verb parity includes `apply`, `wipe`, `stack`, `fork`, `doctor`, `status`, `logs`,
  `snapshot save`, `snapshot restore`, `snapshot list`, `snapshot delete`, and shutdown/down flows.
- `exec` must mirror the child exit code.

Acceptance evidence:

- A startup failure, including Seal/private-content failure, shows a failed state and useful cause.
- Logs stream above the dashboard/status area.
- Rows are grouped and labeled with endpoints/extras visible.
- Row focus changes detail/log display.
- `q` works during startup and shutdown.
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

## P0: Engine state, errors, and logs are not wired as a reliable product

- Tagged-error style is split across plain interfaces, `Schema.TaggedErrorClass`, and
  `Data.TaggedError`; unify or document the final subsystem rule before release.

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

## P0: Docker ownership and lifecycle safety

- Docker Desktop grouping labels were added, but manual visual verification remains open.
- Docker image/build contexts must keep required runtime assets available after packing.

Acceptance evidence:

- Foreign-label containers/networks/volumes are refused or handled only under an explicit
  destructive policy.
- Resume failure and malformed inspect output have tests.
- Docker Desktop shows stack grouping equivalent to the old implementation, with router singleton
  behavior intentionally handled.
- `pnpm pack --dry-run` includes Dockerfile/image contexts needed by Sui/Postgres/Walrus/Seal.

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

## P0: Package/export/build-integration release surface is broken

- Package metadata still says `@mysten-incubation/devstack-rewrite` and is private. Final cutover
  rename remains deferred.
- Build integrations must finish delegating to the shared runtime manifest path, decode, cold-start
  URL, and dapp-kit slot helpers. Path, slot, and low-risk cold-start formatting are now
  consolidated; a final manifest/version constant audit remains.
- Manifest schema/version constants must not diverge at cutover.
- The root barrel and `./substrate` leak internals such as runtime services, identity internals,
  registry/cache/mint helpers, wallet server helpers, and error-contribution machinery.

Acceptance evidence:

- `pnpm pack --dry-run` includes required runtime assets and excludes generated junk.
- Install-from-tarball smoke imports every exported subpath and boots a minimal stack.
- Browser-facing subpaths are node-free by static import audit.
- Root exports match the intended app/plugin-author vocabulary only.
- Vite, Vitest, Playwright, and browser integrations all read the same manifest/version contract.

Closed evidence:

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

## P0: Public API ergonomics and unsupported options are not release-quality

- Auto `sui()` is still required manually in configs that should infer it.
- `stackName` inference from cwd/package metadata is still missing or needs acceptance evidence.
- Wallet `accounts: 'all'` shorthand must work.
- `extras`/manifest contribution seam must support values examples need to surface.
- Cross-plugin references should be direct values, not strings or `.provides` ceremony.
- Package/coin/action ergonomics must restore the intended surface: `PackageWithCapture`-style
  capture, `pkg.coins[...]`, `pickCreatedByType`, `coin.fromPackage(...)`, and
  `ctx.signAndExecute(account, build)`.
- Walrus `seedAccounts` must work.
- Account env/private-key variants must support effect-app prod paths.
- Seal signer/key-server/server refs must use account/value refs, not `{ accountName: string }`
  magic strings; key/server refs must be exported where examples need them.
- DeepBook must expose real defaults/helpers for coins, margin defaults, and `marketMaker`.
- Sui exposes `image.pull`, but local mode fails at runtime with "not yet wired".
- Unknown `DEVSTACK_NETWORK` silently falls back to localnet.
- DeepBook exposes local pools/Pyth/margin/postgres/indexer/server/market-maker/coins options that
  are rejected or not real during acquire.

Acceptance evidence:

- Unsupported options are deleted from public types or implemented.
- Unknown network input fails with a typed error.
- DeepBook public options only represent real behavior.
- The key examples compile without `as never`, placeholder strings, magic identity strings, or
  handwritten SDK boilerplate that belongs in the substrate/API.

## P0: Codegen contracts are inconsistent

- Codegen comments promise staged atomic promotion, while files and Move bindings are written
  directly under output paths.
- Package emitters can run twice, once to collect bindings and again to render files.
- Bigint formatting emits a string like `"123n"` while comments say consumers call
  `BigInt(<string>)`.
- Generated-import proof can skip when `sui` is unavailable, so the always-on gate is weak.
- Build integrations and generated files must not pull devstack source into browser app bundles.

Acceptance evidence:

- Codegen emit is single-evaluation and atomic/idempotent, or the atomic claim is removed.
- Bigint output is valid for the documented consumer API.
- Generated code is imported/typechecked in an always-on test path.
- Apps consume manifest/codegen/env/bridge only; app code does not import devstack engine modules.

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

- Release docs are rewritten against the rewrite API or removed until accurate.
- Public examples are either product-runnable and tested, or explicitly internal/experimental.

## Worktree and checkpoint blockers

- Clean generated artifacts before staging.
- Regenerate the lockfile after removing stale generated importers.
- Exclude unrelated dev-wallet/changeset/old `examples/wallet` dirty files.
- Do not create a giant checkpoint commit. Use the checkpoint sequence in `CURRENT-HANDOFF.md`.

## Partially completed items that still need verification

- Command-tree/help work landed, but standard CLI behavior and subcommand UX still need acceptance.
- TUI renderer selection and `q` routing partially landed, but startup failure, logs, grouping,
  endpoints, shutdown progress, row focus, and hard-kill are unresolved.
- Startup pending display had partial early-handle work; verify against real startup and failure.
- Docker Desktop grouping labels were implemented, but visual verification remains open.
- Router/profile/traffic work has strong tests, but manual parallel-stack and bad-state checks
  remain open.
- Snapshot ID/integrity/transaction staging work landed, but full product save/restore remains open.
