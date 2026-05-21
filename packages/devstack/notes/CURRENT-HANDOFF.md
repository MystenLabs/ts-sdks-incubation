# Current handoff

Last updated: 2026-05-21.

## Clean-session directive

Start design-first. Before dispatching agents or writing code, derive the governing design
principles and core architecture from `STYLE_GUIDE.md`, `ARCHITECTURE.md`, this handoff, and
`UNRESOLVED-BLOCKERS.md`.

The design summary should make these points explicit:

- L0 substrate is name-blind; plugin-domain facts live in L2 or higher.
- L1 runtime adapters are replaceable backends; Docker is the reference implementation, not a plugin
  policy layer.
- L2 plugins and custom plugins use the same authoring surface; built-ins get no private powers.
- L3 orchestrators walk capability declarations and own cross-plugin products such as router,
  snapshot, manifest, and codegen output.
- L4 surfaces publish commands and subscribe to events/projection only; CLI, TUI, and library entry
  points are peer surfaces.
- L5 build integrations and apps consume manifest, codegen, env, and typed bridge slots only.
- The user API should be convention-heavy but direct: values not strings, one root barrel, config
  declares intent, codegen carries resolved values, and adding a plugin should not move existing
  lines.
- This package is unreleased. Fix the surface directly; do not add shims, deprecations, or v2 paths.

Only after that summary exists should the orchestrator choose phase order, assign bounded subagents,
and write acceptance criteria.

## Current status

The package is not release-ready. Treat the implementation as untrusted until the blocker ledger is
fixed and verified. Release-readiness claims belong in `UNRESOLVED-BLOCKERS.md` with evidence, not
only in chat.

Checkpoint commits now exist on `integrate-devstack`:

- `eb8625fb checkpoint(devstack-rewrite): preserve current rewrite state`
- `f2f77904 fix(devstack-rewrite): close first P0 runtime blockers`
- `c09662fe fix(devstack-rewrite): tighten public API and codegen contracts`
- `efabe942 fix(devstack-rewrite): close operator and API ergonomics gaps`

The package-directory cutover has been performed: the old package was deleted after preserving its
load-bearing redesign/v2 notes, and the implementation now lives at `packages/devstack` with the
canonical `@mysten-incubation/devstack` package identity. The example, docs, CI, lockfile, and
install-smoke cutover work remains open for orchestrator validation.

Generated artifacts and stale generated state must be cleaned before staging:

- Do not commit `packages/devstack/{dist,.turbo,node_modules}`,
  `packages/devstack/src/generated/`, runtime wallet token state, example `dist/.turbo`
  output, example `tsconfig.tsbuildinfo`, example generated source, or Move `build/` and
  `package_summaries/` trees.
- Regenerate the lockfile after cleanup. It currently contains a stale generated importer for
  `packages/devstack/test/e2e/fixtures/seal-stub/build/seal_stub/debug_info/dependencies/Sui`.
- Exclude unrelated dev-wallet/changeset/old-example dirty files from package checkpoints unless the
  user explicitly folds them into this effort.

## Orchestrator process rules

- The orchestrator owns phase order and acceptance criteria.
- Subagents get bounded ownership slices. They can investigate or implement, but they do not choose
  the release plan or next phase.
- Do not use `git stash`, `git checkout`, `git restore`, or `git reset`.
- Do not run broad validation (`pnpm typecheck`, `pnpm test`, `pnpm build`, or full turbo gates)
  inside parallel fanout agents. The orchestrator runs validation after a wave lands.
- Every finding must land in `UNRESOLVED-BLOCKERS.md`, a focused note, or be closed with concrete
  evidence. Do not leave release claims only in chat.
- Do not create new stale parallel plans. Keep the current handoff and blocker ledger authoritative.
- For high-risk "landed" or "already wired" claims, grep-verify the signature before closing the
  blocker.

## Live check clusters

Use these clusters as compact reminders of facts migrated from the historical plans and reviews. The
blocker ledger owns the open/closed state.

### API and ergonomics

- Auto-mount `sui()` when a stack needs Sui but omits it.
- Infer `stackName` from cwd/package metadata, with an explicit override.
- Restore wallet `accounts: 'all'` shorthand.
- Restore an `extras`/manifest contribution seam for values such as `openLobbyId` and key-server
  refs.
- Preserve direct member refs: users pass `publisher`, `pkg`, `account`, or `deepbook` refs, not
  string identities or `.provides` ceremony.
- Restore package/coin/action sugar: `PackageWithCapture`-style capture, `pkg.coins[...]`,
  `pickCreatedByType`, `coin.fromPackage(...)`, and action `ctx.signAndExecute(account, build)`.
- Restore Walrus `seedAccounts`.
- Restore account env/private-key variants for prod branches.
- Seal signer/key-server/server refs must be value refs, not `{ accountName: string }` magic.
- DeepBook defaults and ergonomic helpers must cover margin defaults, coins, and `marketMaker`.

### CLI/TUI/operator parity

- The old operator UX is the quality bar: grouped service/package/account/action/app rows, friendly
  labels, endpoints, extras, copyable URLs, visible pending/acquiring/ready/failed/shutdown states,
  root-cause errors, global logs above status, graceful quit, and second-signal/hard-kill behavior.
- Verbs needing parity/acceptance include `apply`, `wipe`, `stack`, `fork`, `doctor`, `status`,
  `logs`, `snapshot`, and `up`.
- `up` must route through the dispatcher or the parser split must be intentionally documented.
- `logs` must have a real stream contract, including NDJSON/envelope behavior for machine mode.
- `exec` must mirror the child exit code.
- TUI row focus/selection must be wired into log/detail panes instead of being dead state.

### Product evidence

- Product e2e evidence must prove behavior, not only harness stubs.
- Required targets include wallet coin balances and endpoint reachability; postgres databases,
  route, and snapshot; private-content encrypt -> Walrus store/fetch -> decrypt; redis routed path
  plus route collision; effect-app dev/prod branches; fork-greeting; Walrus/Seal restore and
  codegen; and parallel-stack manual verification per service.
- Docker/Sui soft skips cannot be the release gate. Separate optional lanes from required product
  evidence.

### Architecture and runtime checks

- Unify tagged-error style or document the final subsystem rule before release.
- Fix the `PublishReceipt` seam; Coin and Package should not directly import each other long term.
- Preserve `Endpoint.pluginKey`/row attribution and keep router entries owned by contributors where
  practical.
- Keep substrate name-blind and move plugin-domain shapes out of L0.
- Resolve post-acquire capability/factory behavior; failures must not produce ready plugins with
  empty capabilities.
- Codegen must be atomic, single-evaluation, idempotent, and always typecheck/import generated code.
- Router entrypoint ownership and TOCTOU collision checks need acceptance evidence.
- Snapshot tests must cover non-empty restore, identity conflicts, and PID/startTime correctness.
- Docker must refuse foreign resources, distinguish inspect not-found from daemon/decode errors, and
  route resume failures through an explicit recreate/refuse policy.
- Browser/build integrations must use the shared runtime path/version rules and avoid node imports
  from browser-facing subpaths.

### TypeScript pitfalls from the prototype

- `StackMember` has four generics; the `Siblings` generic is load-bearing for literal sibling-hash
  checks.
- Phantom witnesses should stay covariant, usually `() => T` in return position.
- For tuple helper inference, prefer an unconstrained generic plus an outer
  `Members extends ReadonlyArray<unknown> ? ... : never` conditional; constraining the generic
  directly can widen `Members[number]`.
- Empty tuple tag-id inference can widen to `string`; use an explicit `length: 0` branch before
  inferring tag ids.
- Keep `ConflictingGroups`-style validation inlined when helper factoring erases narrow inference.
- `@ts-expect-error` only applies to the next line; place directives on the exact diagnostic line.
- Effect v4 pitfalls live in `STYLE_GUIDE.md`; do not reintroduce v3 helpers such as
  `Effect.either`, `Cause.failures`, or `Effect.fork`.

## Current blocker entrypoint

Use `UNRESOLVED-BLOCKERS.md` as the blocker ledger. The current P0 areas are:

1. CLI/TUI/operator UX parity with the old implementation.
2. Engine state, structured errors, and production log event plumbing.
3. Docker ownership/reuse safety and resume/inspect policy.
4. Package/export/build-integration/browser-safety release surface.
5. Public API pruning and ergonomics for unsupported or regressed options.
6. Codegen atomicity/contract correctness.
7. Product evidence: e2e tests must prove product behavior, not only harness stubs.
8. Docs/examples cleanup so public material matches the current API and behavior.

## Checkpoint plan

Do not commit the current tree as one blob. First clean generated artifacts and exclude unrelated
dirty files. Then checkpoint in reviewable batches:

1. Package scaffold + public surface.
2. Docker runtime + images.
3. Orchestrators: router, codegen, snapshot, runtime composition.
4. Plugins, split if needed between stable plugins and composite-heavy Walrus/Seal/DeepBook.
5. CLI/TUI surfaces.
6. Build integrations.
7. Examples + workspace metadata + regenerated lockfile.

Each checkpoint needs a specific gate. At minimum: package typecheck, targeted tests for the touched
area, and a final full build/test pass before calling the package release-ready.

## New orchestrator goal

Bring `packages/devstack` from the current untrusted, dirty prototype state to a reviewable,
release-quality package by making the design principles and architecture explicit, fixing the live
blocker ledger, restoring old CLI/TUI operator parity where it matters, pruning and improving the
public surface, proving Docker/codegen/snapshot behavior with production-path tests, cleaning
generated artifacts, and landing progress in incremental verified checkpoints.

## New orchestrator prompt

```text
You are taking over orchestration for `/Users/michaelhayes/code/ts-sdks-incubation`.

Primary objective: finish `packages/devstack` to release-quality standards, not merely make
tests pass. The current implementation is untrusted until audited/fixed. Own phase order and
acceptance criteria yourself; subagents can investigate or implement bounded slices, but they do not
decide the next phase.

Required first reads:
- `/Users/michaelhayes/code/ts-sdks-incubation/AGENTS.md`
- `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/README.md`
- `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/notes/README.md`
- `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/notes/CURRENT-HANDOFF.md`
- `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/notes/UNRESOLVED-BLOCKERS.md`
- `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/STYLE_GUIDE.md`
- `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/ARCHITECTURE.md`

First task before fanout or implementation:
1. Write a short design brief from those files: design principles, L0-L5 layer model, public API
   goals, runtime/orchestrator boundaries, and release-quality acceptance themes.
2. Convert that design brief into a phase plan and acceptance evidence.
3. Only then dispatch bounded subagents for reads or implementation.

Operating rules:
- Treat `CURRENT-HANDOFF.md` and `UNRESOLVED-BLOCKERS.md` as authoritative current notes.
- Open `api-surface-design.md`, `phase-f-manual-scenarios.md`, or `pr7-cutover-plan.md` only when
  the current task specifically needs that reference.
- Do not look for deleted historical notes or reviews; unresolved facts were migrated into the
  compact current notes.
- Do not drop unresolved findings. Migrate them into the blocker ledger or close them with evidence.
- Do not claim release readiness while any P0 in `UNRESOLVED-BLOCKERS.md` is open.
- Do not add shims/deprecations/compat layers; this package is unreleased and APIs should be fixed
  directly.
- Do not use `git stash`, `git checkout`, `git restore`, or `git reset`.
- Do not commit generated artifacts or unrelated dirty files.
- Do not run broad validation inside parallel fanout agents; the orchestrator validates after each
  wave.
- Create reviewable checkpoint commits only after cleanup and verification.
- Every agent finding must end up in `UNRESOLVED-BLOCKERS.md`, a focused note, or a verified close.

Immediate sequence:
1. Verify the working tree and generated-artifact cleanup list.
2. Fix/verify P0 engine state, error, log, shutdown, and old CLI/TUI parity blockers first.
3. Fix Docker ownership/reuse/resume policy.
4. Fix public release surface: package metadata/files, exports, build integrations, browser safety,
   unsupported options, and API ergonomics.
5. Fix codegen and snapshot contract blockers.
6. Split tests into product evidence vs harness tests; add production-path gates.
7. Only then prepare checkpoint commits and refresh the cutover plan.
```
