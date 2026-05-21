# 19 Codegen (distilled)

## Purpose

Codegen turns the live, in-memory runtime state of a devstack (package ids, endpoint URLs, account
addresses, coin metadata, captured object ids, user extras, plus per-service config blobs like
Deepbook pools and Pyth feeds) into a set of plain TypeScript source files that the user's
application imports directly. It is the bridge between the running stack and the app: everything the
app needs to know about the running environment arrives as ordinary checked-in-or-generated source
under a user-owned directory (default `./src/generated/`), not as a runtime dependency on devstack
itself.

Codegen also emits Move-to-TS bindings (per-package typed clients) from each local Move package's
`sui move summary` output, so the app's Move calls are typed against the same package the stack just
published.

## Hard boundary: apps consume codegen output, NOT devstack

This is the load-bearing constraint of the entire codegen subsystem.

- Application code MUST NOT import from the `devstack` package. No runtime value (no rpc URL, no
  package id, no account address, no captured object id, no extras blob, no wallet pair URL, no
  Deepbook pool list) is allowed to flow into app code by way of a `devstack` import.
- Every such runtime value reaches the app exclusively via files emitted by codegen into the user's
  source tree. The app imports those files like any other TypeScript module.
- Why this matters:
  - The app must remain runnable, type-checkable and buildable in environments where devstack is not
    installed (production, CI build steps, downstream consumers).
  - Devstack is a dev-time orchestrator; the app's dependency graph must not leak that orchestration
    into runtime.
  - Static-import-graph based tools (bundlers, tree shakers, type checkers) need a stable,
    devstack-free surface to reason about.
- What this excludes: helper functions in `devstack` that "read manifest at runtime", dynamic
  loaders, magic env-var reads from `devstack`, any pattern where the app's import path resolves
  into the devstack package.
- What this implies for the redesign: codegen output is the only legitimate channel from stack state
  to app code. The redesign must keep this channel closed-loop (one direction, file on disk) and
  treat any temptation to "expose a tiny devstack helper to the app" as a breach of the boundary.
- Exception nuance: codegen output is allowed to reference other published npm packages the app
  already depends on (e.g. the dapp-kit family, deepbook SDK, the dev-wallet adapter package). It
  must not reference devstack internals.

## Responsibilities

- Read a snapshot of every relevant runtime registry (packages, endpoints, accounts, coins, plus
  per-service state registries) at emit time.
- Resolve user-supplied `Extras` (an opaque Effect the user provided at stack composition) into a
  concrete blob suitable for embedding.
- Run an ordered set of emitters serially against a single shared, atomic staging directory.
- Promote the staging directory over the user-visible output directory using an atomic,
  all-or-nothing swap.
- Maintain a `.gitignore` inside the output directory that protects sensitive emitted files;
  preserve user-customized `.gitignore` content across runs.
- Apply tightened filesystem permissions on emitted files known to contain secrets (wallet tokens,
  user extras).
- Short-circuit when inputs have not changed, both per-file and (for the bindings emitter)
  per-emitter, to avoid touching file mtimes and triggering spurious dev-server hot-reloads.

Out of scope: validation, network calls, modifying engine state, mutating the user's app source tree
outside the chosen output directory.

## Codegenable capability contract

A "codegenable" participant is anything in the stack that wants something written into the user's
source tree. It declares (conceptually):

- A name. Unique across the codegen run; used both as a key in any emitted aggregate file and as the
  staging sub-path.
- The set of registries / services it needs to read. The codegen scheduler uses this to ensure those
  Layers have already produced their values before emit time.
- An emit operation. Given a resolved snapshot (packages, endpoint values, accounts, coins, extras,
  per-service state), it produces files under a shared staging directory. It is permitted to skip
  emission when its preconditions are not met (e.g. its service isn't running this cycle) and must
  log that decision rather than fail silently.
- Optional per-instance state. Allowed only for fingerprint / cache purposes that improve
  idempotency; never required for correctness across processes.
- Sensitivity flags on individual outputs. So codegen can apply tight permissions and gitignore
  coverage uniformly.

A "package" participant is a special case: it declares a codegen-relevant local source path and a
published id; the bindings emitter consumes the source path, the manifest-shaped emitters consume
the id and metadata.

Crucially, a codegenable participant declares WHAT it wants emitted, not HOW the codegen subsystem
schedules, stages, swaps, locks, or rolls back. That is the codegen subsystem's job.

## Outputs / emitted files

All outputs land under a single user-chosen directory (default `./src/generated/`), which must be
importable from the user's TypeScript project (i.e. inside `tsconfig.include` and resolvable by the
bundler). The output directory is owned and managed by codegen; users do not write into it.

Categories:

- **Move-to-TS bindings**: per-published-package typed client modules produced from each local Move
  package's summary. One subtree per package. Lets the app make typed calls into the
  freshly-published Move code.
- **Stack-handle files** (one file per concept, deterministic byte order):
  - Accounts: human-name → address map for funded test accounts.
  - Services: per-service endpoint URLs, network name, structured runtime info for every running
    service.
  - Captured: per-package extracted on-chain object ids (treasury caps, metadata ids, etc.) captured
    at publish time.
  - Packages: per-package published id + upgrade cap + MVR placeholder.
  - Coins: per-symbol coin metadata, including type tag, decimals, treasury cap, and (when present)
    Pyth feed info. Sensitive.
  - Extras: opaque user-supplied blob baked into the emitted tree. Sensitive.
- **App-kit config files**:
  - Dapp-kit config: pre-built configuration object the app spreads into its dapp-kit setup;
    includes rpc url, network name (with fork translation), MVR overrides, optional burner-wallet
    initializer wiring. Sensitive (carries wallet pair token).
  - Deepbook config: pre-built config object the deepbook SDK consumes; package ids, coin map,
    pools, margin pools, optional Pyth block.
- **Boundary helpers**:
  - A `.gitignore` inside the output directory, covering sensitive emitted files by default and
    preserving user customizations.

Each emitted file carries a generated-header banner; sensitive files carry an additional
do-not-commit banner.

The set of emitters is configurable. Built-ins exist for the categories above; users may add custom
emitters by implementing the codegenable contract.

## Lifecycle states

Codegen is not a long-running service; it is a phased operation that runs inside the stack's startup
graph after its declared upstream services have produced their values.

- **At-up (every supervisor cycle)**: codegen acquires once per stack Layer build. It resolves
  package refs, gathers a registry snapshot, resolves user extras, runs every emitter into a fresh
  staging directory, atomically promotes it over the output directory, then writes/preserves the
  `.gitignore`.
- **On-change (watched re-emit)**: when the supervisor restarts due to any watched input change,
  codegen re-runs as part of the new cycle. The output directory itself MUST be excluded from the
  watcher so the atomic rename does not feed back into a restart loop.
- **On-demand**: codegen runs whenever a fresh stack acquire happens (e.g. CLI-driven snapshot
  resume); the same emit pipeline applies.
- **Idempotency**: re-emit with identical inputs must produce identical bytes and must not touch
  file mtimes. Emitters either short-circuit per-file by comparing existing content, or per-emitter
  by hashing inputs (the bindings emitter walks Move source mtimes).
- **Serial within a cycle**: emitters run one at a time per cycle to avoid filesystem and
  external-tool races (e.g. shared Move build caches). Per-emitter internal parallelism is allowed
  where safe.
- **Single-shot**: codegen has no streaming or background mode. Each acquisition is one pass.
- **No teardown**: codegen's scope close is a no-op; the emitted files persist as ordinary repo
  files until the next emit or a manual delete.

## Inputs / dependencies

Codegen consumes, at emit time:

- All runtime registries that the configured emitters touch: package, endpoint, account, coin, and
  any per-service state registry (sui, walrus, seal, deepbook, pyth, postgres, deepbook-margin,
  deepbook-indexer, deepbook-server, etc.).
- The stack identity (network name, stack name, app name).
- The resolved user-supplied Extras blob.
- The current local Move source trees referenced by `Package` participants, for the bindings
  emitter.
- An external Move toolchain invocation (`sui move summary`), preferred through the pinned dev-image
  build container and falling back to a host binary only when the container path is unreachable.
  Pinned- version parity with the bindings generator is required.
- The chosen output directory path, resolved against the user's cwd.
- Any pre-existing `.gitignore` inside the output directory, for customization preservation.

Codegen does NOT consume: network state, RPC endpoints, ports, file locks, leases, the state-store,
or any persistent runtime cache.

## Invariants and constraints

- **Stable output paths**: the output directory and every file path within it are stable across
  runs. Apps reference them by static import.
- **Deterministic re-emit**: identical registry snapshots and extras produce byte-identical output.
  Keys are sorted; iteration order is fixed.
- **Atomic promotion**: the user-visible output directory is never seen in a half-emitted state. A
  staging directory receives all writes; a single rename promotes it. On any failure during emit,
  the previous output directory must remain intact and visible.
- **Snapshot-survivability**: emitted files live under the user's repo tree, not under the engine's
  dot-directory state. They are preserved across snapshot save/resume by virtue of being ordinary
  repo files.
- **No-stale on input change**: any change to a fingerprint-relevant input (Move source mtime,
  registry snapshot, extras) invalidates the cached output and forces re-emit.
- **No-touch on no change**: when inputs are unchanged, file mtimes do not move. This is
  load-bearing for dev-server HMR quietness.
- **Permission tightening**: sensitive emitted files have restrictive filesystem permissions,
  re-applied on every emit (not just on create) to recover from manual chmods.
- **Gitignore covers sensitive files by default**; user customizations to the gitignore survive the
  atomic swap.
- **Output dir excluded from watcher**: the supervisor's file watcher must never observe writes
  inside the output directory; otherwise the swap loops the watcher.
- **Codegen runs after every package it references**: scheduler ordering must place codegen strictly
  downstream of any package whose publish output it consumes.
- **Codegen is opt-in**: codegen is not part of the default stack composition. Users must explicitly
  add it to their stack to receive emitted files.
- **Skip-emit is explicit and logged**: if a required input is not yet present this cycle (e.g. a
  service hasn't booted), the emitter must log a skip and write nothing, rather than write a broken
  file.
- **Silent no-op from a downstream tool is a failure**: when an emitter invokes an external
  generator (Move-to-TS bindings) and the generator writes nothing, codegen must detect and fail
  loudly.
- **Duplicate participant names**: ambiguous package names must be deduped at emit time with a
  logged warning; ambiguous emitter names must fail at acquire time.

## Edge cases and known failure modes

- Missing upstream service for an emitter (e.g. dapp-kit emit before sui-rpc endpoint registers):
  skip-emit, log, retry next cycle.
- External Move toolchain unreachable: prefer container path; fall back to host; if both fail,
  surface a tagged failure.
- Move-to-TS generator silently produces no files: post-emit probe must detect and fail with a hint
  about the common `Move.toml` cause.
- Duplicate package names in the participant set: first-wins, second warned, no HMR storm. Without
  dedup the on-disk tree mismatches the fingerprint and re-emits forever.
- Cross-filesystem staging: same-FS rename is the fast path; a copy- fallback exists, but it loses
  atomicity. Output must be on the same filesystem as its parent.
- Mid-cycle interruption: staging directory is cleaned up; previous output remains intact. Stale
  leftover staging/backup siblings from a crashed run may need manual sweep.
- Re-emit timing window for the gitignore: the gitignore is written outside the atomic swap, so
  during a narrow window after the swap it may briefly reflect the old state. Only humans/git read
  it.
- Sensitive-file permission drift: a user or tool re-chmods a 0o600 file to 0o644; re-emit must
  restore 0o600 unconditionally.
- Network-name fork forms: a fork network name (e.g. `mainnet-fork`) is not accepted by downstream
  chain-id validators; emitted dapp-kit config must carry the stripped form for validators AND the
  original form for fork-aware consumers, alongside a structured `runtime` flag.
- Skip-emit does not delete a stale prior emit: if a cycle emits then a later cycle skips, the
  previous file persists. May or may not be a problem depending on the emitter; needs an explicit
  policy.

## Learnings from current implementation

- A shared, single-swap atomic primitive is essential. Multiple emitters writing into one staging
  dir then one rename is dramatically simpler than per-emitter swaps. Nested swaps inside an outer
  swap become redundant.
- Closure-scoped, per-instance fingerprint caches beat module-global ones (module-globals leaked
  across tests and across re-acquires).
- `writeIfChanged` (compare existing content, skip write if identical) plus a post-write chmod is
  the minimum baseline; without the chmod, no-op writes don't refresh perms and sensitive files
  drift to 0o644.
- The Move-to-TS generator can silently no-op when the source Move package is malformed (e.g.
  missing `[addresses]`). A post-emit probe with a concrete error message is the right place to
  catch this.
- The manifest-reading emitters resolve the same registry snapshot and the same `ExtrasResolved`
  multiple times per cycle. The redesign should hoist these into a single shared resolve, threaded
  into the emit context.
- Hand-rolled TS-object-literal rendering (`JSON.stringify` plus sort plus tab plus comma) drifts
  subtly between emitters; a small shared renderer would absorb the variation and own the bigint
  policy in one place.
- The bindings emitter is the only one that touches an external tool and the only one with a
  non-trivial cache. The other three are pure projection from a snapshot.
- The Deepbook config emitter accumulates a lot of domain knowledge (hard-coded SUI coin, manual
  DEEP seeding, Pyth merging, margin reverse-mapping). Some of that ought to move into the Deepbook
  registry surface and out of the emitter.
- Fork-network translation lives in two emitters; consolidating the network-form projection into the
  snapshot itself would let the emitters stay dumb.
- Emitted code that references external published packages must be written carefully: any import of
  a devstack-only symbol from emitted code is a boundary breach. The current implementation keeps
  emitted imports to dapp-kit, deepbook, dev-wallet, and the Sui core SDK.
- `coins.ts` is emitted but not directly covered by tests; the redesign's test plan must round out
  the unit tests so every emitted file has a parse-and-import smoke check.
- Codegen output sits in the user's source tree, so `wipe` semantics must be defined: state-store
  wipe alone does not clean `src/generated/`.

## Cross-component references

- Packages (14): supply `id`, `upgradeCapId`, `mvrPlaceholder`, `captured`, and (for local packages)
  a `sourcePath` for bindings.
- Accounts (12): supply named addresses for `accounts.ts`.
- Coins (13): supply per-symbol metadata for `coins.ts` and Deepbook.
- Sui (5) / Walrus (6) / Seal (7) / Deepbook (8) / Pyth (9) / Postgres (10) / Faucet (11): supply
  per-service registries that the manifest- reading emitters project.
- Wallet (15): supplies the wallet endpoint and pair token that the dapp-kit emitter embeds into the
  burner-wallet initializer block.
- Engine resources (02): file watcher exclusion, atomic-write helper, stage-and-swap primitive,
  shared registries and identity.
- Observability (03): emit-phase span annotations, log warnings for skip-emit, log infos for
  silenced normal paths.
- Action (16) / Snapshot (17) / Router (18): consume the emitted files by way of the user's app,
  never by way of devstack.
- CLI (20) / TUI (21): surface emit phases ("resolving packages", "emit: <name>") and surface emit
  errors with phase tags.

## Open questions / decisions deferred

- Does `wipe` clean the codegen output directory, or is it strictly out of scope?
- Per-package emitter override (object form of the `codegen:` flag): implement with clear "union vs
  replace" semantics, or drop the surface entirely.
- Bigint serialization in emitted literals: strings (current) or a typed wrapper preserving
  bigint-ness through to consumers?
- Should a stale prior emit be cleaned when a subsequent cycle skips emission? Per-file
  delete-on-skip, or accept the staleness?
- Selective per-emitter invalidation: should the redesign expose a general "emitter cache key" so
  non-bindings emitters can short- circuit early, not just at the file-write boundary?
- Should codegen be in default stack composition for app-mode stacks, rather than opt-in?
- Should the network-form projection (`network`, `devstackNetwork`, `runtime`) live in the snapshot
  itself so emitters stop duplicating fork-stripping?

## Opportunities noticed

- Hoist `gatherManifest` and `ExtrasResolved` to a single resolve per cycle, threaded into the emit
  context; emitters become pure projection.
- Extract a shared "render TS object literal as const" helper that owns key sort, bigint
  serialization, and identifier-safe quoting in one place; eliminate the per-emitter hand-rolled
  renderers.
- Define an explicit `Codegenable` capability on the participant tag surface (today the `Package`
  ref and emitter list are the only carriers); make every participant that wants emission declare it
  through one contract.
- Collapse the redundant nested stage-and-swap inside the bindings emitter when it runs under the
  outer Codegen swap; keep it only for standalone-emitter usage (e.g. unit tests).
- Move Deepbook's hard-coded SUI/DEEP coin seeding into the coin registry at supervisor boot; let
  the Deepbook emitter read a single uniform map.
- Project fork-network translation into the manifest itself; consumers read `network`,
  `devstackNetwork`, `runtime` directly, removing duplicated stripping logic from emitters.
- Lift Move-source-mtime fingerprinting into a shared utility so other emitters could opt into
  similar source-change invalidation without re-implementing the walk.
- Audit emitted files for any path that could ever transitively pull a devstack import; pin a
  build-time check that the user's app, with devstack removed from the dependency graph, still
  type-checks against the emitted files alone.
- Add a coverage test that imports every emitted file (including `coins.ts`) and asserts the runtime
  values round-trip.
- Define a `wipe-codegen` operation in the CLI so the output dir has a documented, supported reset
  path.
- Refine the `CodegenError` phase taxonomy: today `'generate'` conflates "emitter-collision at
  acquire", "binary shell-out failure", and "pure render failure"; splitting them improves error
  attribution.
