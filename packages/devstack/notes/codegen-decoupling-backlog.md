# Codegen decoupling — backlog

Tracking for the "decouple `build` from stack-booting `apply`" effort. Model:
codegen is a deterministic, stack-free fn; on-chain ids are loaded config data
(committed `src/generated` carries id-free bindings + a `config.ts` that resolves
ids at runtime via `config-runtime.ts`); `up`/`apply` only write
`.devstack/.../devstack-ids.json`; the vite plugin injects ids (dev: live file,
prod: a committed id-config file via the `ids` option / `DEVSTACK_IDS_FILE`).

Status keys: ✅ done · 🔄 in progress · ⬜ todo · ❗ needs owner decision

---

## 1. Example + template migration

- ✅ connect-four, deepbook-trader, dashboard-demo (config-only), token-studio,
  private-content — migrated, build stack-free (`tsc -b && vite build`).
- ✅ `create-devstack-app/templates/app` — migrated.
- ✅ `examples/fork-greeting` — `codegen` script added; regenerated (stale
  blanket-`*` `.gitignore` → "track"); bindings not-ignored + staged; typecheck
  passes stack-free.
- ✅ `create-devstack-app/templates/ts` — `typecheck` dropped `devstack apply`,
  `codegen` script added; scaffolder tests 42/42.
- ✅ Final consistency sweep — all 6 examples + both templates uniform; no
  `apply &&` in any build/typecheck; no blanket-`*` `.gitignore` anywhere; all
  move bindings trackable + staged. (fork-greeting was the last stale one.)

## 2. Checking in the bindings (typecheck without a build)

- ✅ Removed root `.gitignore` `**/src/generated/` blanket-ignore.
- ✅ Managed in-tree `.gitignore` now TRACKS the committed tree.
- 🔄 fork-greeting stale ignore (fixed by regen, item 1).
- ✅ **Committed** as `c2e1f03c0` (owner: commit everything, no separate WIP in
  progress). 215 files, no `.devstack` (no-churn held). Working tree clean →
  "don't disturb sibling WIP" guardrail LIFTED; normal git workflow from here.
- ⬜ **CI drift-guard**: run `devstack codegen` in CI, fail on a non-empty
  `git diff` of `src/generated` (catches stale committed bindings when Move
  source changed without re-running codegen).

## 3. ✅ Dev-wallet / `generated-extras` regression (FIXED via §8 — unit-verified; e2e gate pending)

RESOLUTION (implemented): dev-wallet is a per-network option (§8), ON for every
network except mainnet. Boot's post-acquire hook now CONDITIONALLY flushes the
buffered runtime `generated-extras` contributions via the new
`CodegenOrchestratorService.emitExtras()` when `resolveNetworkOptions(network).
devWallet` is on. `emitExtras` filters registered decls to `generated-extras`-
located ones and writes ONLY that tree (no stage-and-swap of the runtime tree,
committed `src/generated` untouched). Unit-locked by `test/orchestrators/codegen/
service.test.ts` (writes dev-wallet.ts + accounts.ts @ 0o600, skips `generated`
decls; no-op when empty) + `test/orchestrators/network-options.test.ts` (policy).
- ⬜ REMAINING GATE: connect-four playwright `connectAs` e2e on a CLEAN tree
  (delete `.devstack/.../generated-extras`, boot, run suite) — confirms the
  end-to-end dev-wallet mount.

The rework dropped the step that writes the `generated-extras` tree (dev-wallet +
accounts: acquire-resolved, can't be statically derived). On a clean checkout
nothing writes it → the vite `load` hook no-ops dev-wallet injection
(`vite/index.ts:~500`) → dev wallet never mounts → connect-four `connectAs` e2e
fails. Currently "passes" only on STALE local artifacts (non-hermetic).
- ✅ DECISION made (see RESOLUTION above): conditional boot emit, gated on the
  per-network dev-wallet flag.
- ⚠️ Do NOT delete any `generated-extras`/`@devstack-dev` machinery until §8 lands
  (it's the read side of a write side that needs restoring).
- Verify: delete `examples/connect-four/.devstack/.../generated-extras`, run the
  connect-four playwright suite — should fail today.

## 4. Dead-code / simplification (audit, ranked by impact × safety)

- 🔄 **#1a (DECIDED, in progress) Collapse `@generated` to a STATIC alias** →
  `<root>/src/generated`. Keep the alias (bundler import boundary) + `options.
  alias`/`options.generatedDir` escape hatches + `@devstack-dev` extras overlay +
  the `__DEVSTACK_IDS__` define injection. REMOVE the dead dynamic resolution:
  `readGeneratedDirFromManifest`, the eager-vs-lazy vitest `@generated` split, the
  `existsSync` stale-manifest fallback (moot once static). Update the 3
  manifest-overlay vite tests (now testing dead behavior — they broke when the
  fallback landed). Leave the `manifest.codegen.generatedDir` FIELD written by
  boot for now (just stop reading it) — schema removal is #1b.
- ⬜ **#1b Collapse the dead live-`generated` overlay** (HIGH, follow-up to #1a).
  Nothing writes a per-stack live `generated` tree anymore. Touch:
  `output-location.ts`
  (`outputDir`/`liveOutputDir`/`stackSubdir`), `boot.ts` (per-stack
  `CodegenPathsService` wiring + `manifest.codegen.generatedDir` write),
  `layers.ts`/`api/run-stack-internal.ts`, `manifest.ts` (drop `generatedDir`
  field), `vite/index.ts` (`readGeneratedDirFromManifest` + eager/lazy split →
  `@generated` always `src/generated`). Risk: medium (manifest schema + vite
  alias + tests). Keep `idsFile`/`extrasDir` — real readers.
- ⬜ **#2 Simplify vitest lazy-`@generated` branch** (`isVitest`,
  `resolveGeneratedImport`, `config.test` detection). Confirm how vitest gets ids
  (likely `setup.ts`, not vite `define`) before removing.
- ⬜ **#3 Remove `trackTree:false` gitignore branch + param** (`gitignore.ts`
  `ignoreAllHeader` + `else` branch; `service.ts` `trackTree`/`sensitivePaths`).
  Low risk. Update tests exercising the false branch.
- ⬜ **#4 Dedupe `isPackageBindings`** (`service.ts` + `plugins/package/
  codegen.ts`) → one shared definition. Trivial.
- ⬜ **#5 Fix false "bakes into .devstack tree" docs** (`bucket-config-bindings.ts`,
  `config-bindings.ts`, `sui/codegen.ts`, `output-location.ts` header,
  `manifest.ts`). Docs only — the live path feeds the id-config, writes no file.
- ⬜ **#6 Drop committed-tree `sensitivePaths`** (always empty now; sensitive
  material routes to `generated-extras`). Fold into #3.
- ⬜ **#7 (optional, defer) Strip dead file-emission attrs from live decls**
  (`outputPath`/`emit`/`outputLocation`) if `assembleIdConfig` is refactored to
  call `projectLiveConfig`/`liveValuesOf` directly.
- ⬜ Drop `stackSubdir` (after #1; always null in practice; touches the public
  `codegen` option surface — confirm no example pins it).

### Structural dedup (flagged by the implementation agents)

- ⬜ **Lift `MoveSummaryRunnerService` + `MoveCodegenService` out of
  `layerProductionOrchestrators`** into the `codegen`-verb-only composition —
  boot composes them but no longer uses them (only the verb needs Move compile).
  Overlaps with #1.
- ⬜ **Collapse `packageDecl` into `configCodegenable`** via a
  `configCodegenable(set, how, { extraExports })` option, so the package plugin
  emits `packageBindings` through that hook instead of a bespoke wrapper (~15
  near-dup lines). (#4 `isPackageBindings` dedupe is the related half.)
- ⬜ **Promote `plugins/internal/bucket-config-bindings.ts` into
  `contracts/config-bindings.ts`** as a thin instance-keyed `ConfigBindingSet`
  variant — removes the `plugins/internal` shim / conceptual overlap.
- ⬜ **De-duplicate the inline structural type strings** across coin/deepbook/
  walrus/seal (each re-states its `*Bindings` interface as a `tsType` string —
  drift risk). Consider a `tsTypeOf`-style helper or emitting the named interface
  into the generated bucket and casting to it.
- ⬜ `DeepbookPoolBinding` per-pool typed shape is now informational only (pools
  resolve as one blob) — inline if no consumer imports it.
- ⬜ Sweep dead `stubMoveCodegen`/`stubMoveSummaryRunner` imports in
  `test/e2e/boot-config-impl.ts` (boot no longer codegens).
- ⬜ id-config `accounts` field may be redundant for the runtime config (accounts
  inject via the `@devstack-dev` overlay, not `__DEVSTACK_IDS__`) — revisit
  alongside the §3 dev-wallet decision.

## 5. DX frictions (the new model created repetitive boilerplate)

- ⬜ Generated `resolveActiveNetwork()` helper in `config-runtime.ts` — removes
  the repeated `config.networks[config.network]` index-signature footgun that bit
  connect-four / token-studio / private-content `dapp-kit.ts`.
- ⬜ `resolveValueOptional()` (non-throwing, returns `undefined`) — coin apps
  hand-roll a tolerant wrapper for discovery-only ids
  (`token-studio` `discoveryId` for `treasuryCapId`/`metadataId`).
- ⬜ First-class "declared-when-known" `BucketField` helper — removes the
  literal-vs-resolved branching duplicated across coin/deepbook/walrus/seal.
- ✅ Single-source the id-config schema doc (deduped to `codegen.mdx` link).

## 6. Minor / noted

- ⬜ Benign external `Failed to read Move.toml …` log during codegen (from the
  `sui` CLI / `@mysten/codegen` child process). Left documented — filtering
  external stderr risks masking real errors; only quiet if provably safe.
- ⬜ Example doc-prose drift to the runtime-resolution model (e.g.
  `token-studio/src/lib/deployment.ts` header).
- ⬜ Hoist the `containsBakedRuntimeValue` `0x…`/URL regex to a shared test util
  (now load-bearing in multiple spots).
- ⬜ `packages/docs/dist/**` generated markdown drifts from `content/*.mdx` —
  confirm CI regenerates or gitignore `dist/`.

## 7. Owner decisions

- ✅ walrus/seal/coin/deepbook KNOWN mode → bake ids as literals (like
  `knownPackage`); local/dynamic stay resolver-backed. Implemented + guard-locked.
- 🔁 Dev-wallet / `generated-extras` writer (§3) — RESOLUTION DIRECTION set by
  owner: handle via network-scoped config options (§8), not a one-off. Dev wallet
  enabled per-network (on for localnet/testnet, off for mainnet).

## 8. Network-scoped config options — ✅ MECHANISM SHIPPED (devWallet wired)

IMPLEMENTED: `DevstackOptions.networkOptions?: Record<string, unknown>` (opaque,
name-blind substrate forwards verbatim — mirrors the `network` field). Typed
shape + policy live in `orchestrators/network-options.ts` (`NetworkScopedOptions
{ devWallet, faucet, autoApproveSigning }`, `defaultNetworkOptions`,
`resolveNetworkOptions`) — OUTSIDE substrate because it names plugin conveniences.
Authoring surface `DevstackOptionsWith<Mode>` narrows keys to `DevstackNetworkName`.
Default policy: ON for every network except live `mainnet` (forks stay ON).
Threaded `stack.options.networkOptions` → `ProductionBootOptions` → post-acquire
hook (resolves on `ctx.identity.network`). `devWallet` is FULLY wired (gates
`emitExtras`). `faucet`/`autoApproveSigning` are DECLARED but NOT yet wired to a
consumer — follow-up below.
- ⬜ Wire `faucet` to the sui plugin's faucet-strategy decision (already
  mode-conditional; thread the flag to force-disable) + `autoApproveSigning` to
  the dev-wallet test bridge, OR document as declared-pending if it needs new
  machinery. Don't ship dead options long-term.

### 8-orig. (original notes)

Owner: this is IN SCOPE for the decoupling effort (not a follow-up). A CONSISTENT,
general mechanism to declare per-network options in the devstack config, instead
of one-off flags. Dev-wallet enablement is the first consumer.
DECIDED default policy (owner delegated): dev conveniences (dev wallet, faucet,
auto-approve signing) ON for every network EXCEPT mainnet; OFF for mainnet.
- ⬜ Design where network-scoped options live in the config schema (e.g.
  `networkOptions` / per-network overrides keyed by network name) and how they
  flow to boot (whether to write `generated-extras` / mount the dev wallet),
  codegen, and the vite plugin (whether to inject the dev-wallet module).
- ⬜ Candidate per-network options beyond dev-wallet: faucet on/off, auto-approve
  signing, indexer on/off, account funding — survey what's currently global or
  env-driven that should be network-scoped.
- ✅ Default policy DECIDED: dev conveniences ON for every non-mainnet network,
  OFF for mainnet. Initial network-scoped set: dev-wallet (must-have), faucet,
  auto-approve signing — expand as the survey above surfaces more.
- This SUPERSEDES §3's "just restore the writer": the writer/injection becomes
  conditional on the resolved per-network option. Until designed, do NOT delete
  `generated-extras`/`@devstack-dev` machinery.

## 9. Open questions / needs investigation

- ✅ **Warm-boot + snapshot/restore × the id-config** — AUDITED, VERDICT SOUND.
  Warm restart (`command-loop.ts:54-72`) re-runs the post-acquire hook
  (`maybeRunPostAcquire`) → re-derives `devstack-ids.json` deterministically from
  the SAME live container state (no re-publish → same ids). Snapshot does NOT
  capture `devstack-ids.json`, but it DOES capture the deploy-cache namespaces
  (`descriptor.ts:191-199`: walrus-deploy/package/seal/deepbook/coin-mint/action)
  carrying the on-chain object ids; restore re-derives the ids file post-acquire
  from restored state. STABLE by construction. Guarded by
  `test/e2e/private-content-boot.test.ts:570-652` which runs a WARM restart and
  asserts chainId + vault packageId + seal objectId/serverConfigs + walrus/WAL
  packageIds all survive. No code change needed.
- ⬜ **CI codegen drift-guard** (ergonomic, low-risk): CI runs `apply` (one-shot
  boot) but no `git diff --exit-code src/generated/` after a `devstack codegen`.
  Stack-free design + dev-time vite id-injection mitigate, but a stale committed
  binding could slip in silently. Add a drift-guard step (verify `devstack codegen`
  toolchain availability in the CI job first).
- ⬜ **Prod id-config export ergonomics** (ergonomic): no CLI verb to dump a known
  deployment's `devstack-ids.json`; operators hand-copy or set `DEVSTACK_IDS_FILE`.
  Candidate: `devstack config dump-ids [--output]`. Implement if cheap, else doc.
- ✅ **Commit timing** RESOLVED: commit INCREMENTALLY as work progresses (owner).
  First increment = the done work below once suite is green.
- NOTE: my `existsSync` stale-manifest band-aid was REVERTED (it broke 3 vite
  overlay tests). Tree is now green (typecheck + vite tests confirmed; changelog
  test removed). The stale-manifest footgun is folded into #1a (the static-alias
  collapse makes it moot). NOTHING is committed yet; generated trees + the
  changelog deletion are STAGED.
- ⬜ fork-greeting emits `@generated` bindings its own `src/**` never imports —
  intentionally a pure-config/fork demo, or should it demonstrate `@generated`
  usage like the others?
- ⬜ `apply` script indirection differs by example family (frontend: `apply: pnpm
  run devstack:apply` extra hop; node: inline) — flatten for consistency (minor).

## Pre-existing (NOT this effort)

- ✅ `changelog-subpath-parity.test.ts` REMOVED (owner: low-value bookkeeping
  test — asserted every package.json export subpath is name-dropped in
  CHANGELOG.md; was the lone red test). devstack suite now fully green.
