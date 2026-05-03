# Project review — consolidated findings

Synthesis of an 8-agent parallel review of `packages/devstack/` + the
four examples + the docs (commit `2969a98` on `integrate-devstack`).
Each finding carries a `file:line` ref; severities are P0 (broken /
correctness) → P3 (polish).

The review covered: public API surface, plugin + reconciler
architecture, built-in plugins, state/snapshots/ports, CLI + DX,
examples + tests, docs, and code quality. Findings below are
deduped + grouped by theme, not by reviewer.

---

## P0 — Broken on the floor

These ship today and either crash, silently produce wrong output, or
leave the system in a known-bad state. Fix in next pass.

### Reconciler

- **Cascade Emits don't `consumeDirty` after firing.**
  `runtime/reconcile.ts:267-290` — the topo-walk path at line 206-211
  consumes the dirty kinds after a successful Emit; the cascade loop
  doesn't. The same Emit re-fires every cascade round until
  `maxCascade=4` swallows it. Add `if (status === 'healthy')
  base.registry.consumeDirty(emit.dependsOnKind ?? [])` after line 286.

### Examples (will silently break their own e2e)

- **`arena/playwright.config.ts:3` and `private-content/playwright.
  config.ts:3` are missing `await`** on `defineDevstackPlaywrightConfig`.
  The helper is `async`; the config object is a Promise; Playwright
  consumes a Promise where it expects a config. token-studio + wallet
  do `await` correctly.

### Docs

- **50+ broken cross-links** use `/docs/...` instead of `/devstack/...`
  / `/dev-wallet/...`. `lib/source.ts:8` sets `baseUrl: '/'` so the
  shorter form is correct. Affected files include
  `devstack/index.mdx:45,51,54,56,58,59,61,62,64,65`,
  `devstack/getting-started.mdx:60-151`,
  `devstack/concepts/setup.mdx:57`,
  `concepts/ports.mdx:104,106`,
  `concepts/snapshots.mdx:18,124,131-133`,
  `concepts/state-model.mdx:36,115-117`,
  `concepts/plugins.mdx:80-85`,
  `authoring/define-plugin.mdx:7,57`,
  `authoring/action-helpers.mdx:14,24,42`,
  `concepts/registry-and-manifest.mdx:107`,
  `plugins/sui.mdx:23`. One sweep + a regex check in
  `validate-llm-docs.ts`.

- **`plugins/wallet-server.mdx:21` still imports `vite,`** which no
  longer exists; should be `frontend,` like `getting-started.mdx`.

- **JSX bug in `adapters/react.mdx:76-84`** — three `<Provider>`
  opens, only two closes. `</DAppKitProvider>` is missing; the snippet
  doesn't compile.

- **Anchor `#snapshot-meta` referenced from
  `concepts/snapshots.mdx:24,133` and `state-model.mdx:36`** points
  at a heading that doesn't exist in `plugins/sui.mdx`. Add the
  section or repoint.

- **`adapters/react.mdx:204` documents `defaultMvrName`** but the
  symbol isn't re-exported from `react/index.ts` or `index.ts`. Same
  false claim in `README.md:167`. Either drop or re-export.

- **`plugins/wallet-server.mdx:67,93-94` claims `signPersonalMessage`
  is unsupported.** It is supported (`server.ts:110` registers
  `POST /api/v1/devstack/sign-personal-message`;
  `dev-wallet/src/adapters/devstack-adapter.ts:131` implements it).
  Doc inherited the constraint from `RemoteCliAdapter`.

- **`dist/llms-index.md` is broadly stale**: says "six action kinds"
  (it's eight); references `plugins/vite.md`,
  `concepts/registry.md`, `concepts/manifests.md`, `authoring/
  accounts.md` — none of those filenames exist post-restructure.
  Missing: `state-model`, `setup`, `snapshots`, `ports`, `deepbook`.
  `dist/devstack/plugins/vite.md` artifact still on disk.

### CLI

- **`stack` and `console` ignore `--help`/`-h`.** Every other verb
  short-circuits (`up.ts:92-95`, `apply.ts:72-76`, etc.).
  `cli/stack.ts:314-352` and `cli/console.ts:305-323` fall straight
  into `parseArgs`/`runStack` and throw `unknown subcommand '--help'`.

### Snapshots — ID under-specified

- **Most state-affecting inputs aren't in the snapshot id hash.**
  `cli/snapshot.ts:56-65` + `runtime/snapshot.ts:532-547`:
  `snapshotIdFromConfig` only includes `{appName, stack, platform,
  suiImage, accountNames, plugins:[name, version]}`. No plugin sets
  `version`. So bumping `WALRUS_REV` / `SEAL_REV` / `deepbook.rev`,
  changing plugin options, or editing `setup:` actions does **not**
  invalidate the snapshot id. Plan called for `{plugin-versions,
  base-image-tags, plugin-options, account-list, platform}`. We're
  missing four of the five.

  Fix shape: each plugin emits a stable `inputs` summary (image tag,
  rev, structurally-significant options, action-set fingerprint for
  the synthetic `<app>-setup` plugin); thread through to
  `computeSnapshotId.plugins[*].inputs`.

- **Restored `<stackDir>/ports.json` can resurrect ports a sibling
  stack now claims.** `runtime/snapshot.ts:351-357`. The allocator's
  sibling check (`port-allocator.ts:51,83-103`) only runs for slots
  not already in cache; restored ports.json is treated as
  authoritative. Result: `docker run --publish` collides at `up`.

---

## P1 — Real but workable

### Reconciler / plugin contract

- **`runsAs` is unconstrained `string`.** `core/types.ts:211`. Typo
  (`runsAs: 'publishr'`) silently disables the same-signer guard for
  the typo'd action. Validate at expansion time when `accounts` is
  available, or at least at `ctx.accounts.get` failure attribute it
  to the action name with an upgrade hint. (Public API agent.)

- **Cycle restart after a failed action loses `lastInputHash`** —
  `runtime/reconcile.ts:399`. On `run` throw with no `prior`,
  `lastInputHash` becomes undefined; next cycle's `hashMatches` is
  false; `getStatus` is not consulted; action is force-rerun. Probably
  intentional, but worth a test + comment.

- **Capability suffix queries with no provider are silently dropped**
  (`plugin.ts` / `topo.ts:82-85`). Typo in
  `'sui.unknown:before'` is invisible. Warn in non-lenient mode.

- **`Function.toString()` for `runTransaction` build-callback hashing
  misses closure state.** `actions/transaction.ts:78-83`. Already
  documented at lines 73-77, but the implication (closure
  `const recipient = '0xABC'` change won't invalidate marker) belongs
  in `friction.md`.

### Built-in plugins

- **Three plugins lack `runsAs` on their signing actions:**
  `plugins/deepbook/publish.ts:30-84` (signs as `opts.admin`),
  `plugins/imports/index.ts:248-349` (signs as `publisherAccount`),
  `plugins/seal/index.ts:297` (hardcodes `'publisher'`). Same pattern
  as the wallet's `seedTokens` race. Add `runsAs:` and, for seal, an
  `opts.publisher` knob.

- **`walrus.register` has no `provides.registry` hook.**
  `plugins/walrus/index.ts:418-470`. Compare `seal.register` (line
  168) which republishes the registry on warm-skip. Walrus's
  `walrus`/`wal`/nodes are invisible to dependents on a cold cycle
  with `getStatus.ok=true`. Likely a real bug for snapshot-restore
  paths.

- **`walrus.deploy` lacks explicit `snapshot:` meta** — falls back
  to defaults that don't matter today, but explicit `commit: false,
  quiesce: 'none'` matches the documented intent.

### Examples

- **`useSignAndExecute` is duplicated 4× nearly byte-identically**
  (`wallet/src/lib/queries.ts:53-86`, `arena:9-55`, `token-studio:
  19-49`, `private-content:21-54`). Strongest extract trigger;
  natural home is `@mysten-incubation/devstack/react`.

- **`Card.tsx`, `dapp-kit.ts`, `main.tsx`, `index.css`,
  `vite-env.d.ts`, `vitest.config.ts`** are all byte-identical (or
  comment-diff-only) across all 4 example apps.
  `architecture-review-followups.md:42` already notes this; agent
  confirms it's still pending.

- **`shortAddress` and `labelFor` exist as 4 drifted copies**
  (`wallet/src/lib/format.ts:32-44`, `arena/src/lib/format.ts:1-12`,
  `private-content/src/lib/format.ts:1-13`,
  `token-studio/src/lib/coin.ts:71-82`).

- **Stale `*.{js,d.ts}` build artifacts** still tracked in
  `examples/arena/` and `examples/private-content/` referencing the
  old `definePlugin` API. `.gitignore` + remove.

- **`examples/_template/` referenced in `examples/README.md:28-48`
  doesn't exist.**

### CLI / DX

- **One-shot (`apply`/`deploy`) has no `appendLog` or `progress`
  callback wired** (`runtime/one-shot.ts:131-148`). Per-action build
  + publish output is invisible until a failure dumps it. CI diagnosis
  is "stare at the summary table". Wire `appendLog` to stderr in
  one-shot.

- **One-shot has no `SIGINT` handler.** Reconciler cycle running
  `docker run` won't propagate; the container stays. Compare
  `supervisor.ts:291-308`.

- **One-shot uses `console.warn` for scope misses + dropped
  capabilities** (`one-shot.ts:194-198,235-239`). Tears up the TTY
  panel.

- **`apply --actions` silently mismatches** when the named action
  exists in the config but is filtered out by `applyFilter`
  (`one-shot.ts:191-199` builds `byName` from post-filter actions).
  Confusing error.

- **No `--json` output mode anywhere.** CI consumers regex-parse
  human strings.

- **`stack new` not in top-level `cli/index.ts:27` USAGE.**
  Discoverability hole.

- **Status-renderer headless mode is noisy** —
  `runtime/status-renderer.ts:67-73` logs every per-action transition
  each cycle, easily 100s of lines on a cold first-run. No log-level
  knob.

- **Three positional config conventions** in usage strings
  (`<config>`, `[config]`, none). Pick one.

### State / snapshots

- **`captureSnapshot` refuses to operate when no Service containers
  exist** (`runtime/snapshot.ts:142-148`). HostProcess-only stacks
  (e.g. wallet-server + frontend, no sui visible to the user) can't
  snapshot their `<stackDir>` even though that's a well-formed
  state under the rule. Soften.

- **Quiesce/un-quiesce is non-atomic.** `runtime/snapshot.ts:165-228`
  — `docker commit` failure leaves earlier paused/stopped containers
  paused/stopped. Wrap in `try/finally`.

- **`host.tar.zst` documented but not implemented.**
  `runtime/snapshot.ts:236` is a plain `cpSync`, not `tar.zst`. Header
  comment at lines 10-22 is now lying. Either implement or update the
  comment + plan note.

- **`--portable` (`docker save` + `docker load`) unimplemented.**
  Plan called for it; today the only transport is registry push. The
  offline / cross-machine without GHCR case fails entirely.

### Hidden coupling — load-bearing strings

- **Container name format `${appName}-${stack}-<service>` is
  imported directly across plugins** via `suiContainerName`
  (`plugins/sui/index.ts:115`, consumed by `actions/publish.ts:166`,
  `plugins/imports/index.ts:301`, `plugins/deepbook/publish.ts:58`).
  The core `actions/publish.ts` factory imports from a specific
  plugin; renaming sui's container breaks every Publish caller.
  Surface through `ctx.containers.find('sui')?.name` or registry.

- **`'sui-rpc'` service slot name appears at 9+ sites.** Renaming
  requires multi-file find/replace. Extract a typed constant.

---

## P2 — Quality / consistency

### API surface gaps

- **`PortAllocator` and `PortRequest` not in `index.ts`** despite
  being part of every plugin's `ctx.ports.allocate(...)` contract.
  Plugins use deep `import('../../core/types.js')` workarounds.

- **Asymmetric option-type exports.** `PublishMoveOptions` +
  `RunTransactionOptions` are public; `BuildImageOptions`,
  `ServiceOptions`, `HostProcessOptions`, `RegisterOptions`,
  `SeedOptions`, `VerifyOptions`, `EmitOptions`, `JobOptions`,
  `ContainerServiceOptions`, `PublishOptions` aren't. Pick a rule
  (export all factory option types, or none).

- **`DevstackPlaywrightExtend` not re-exported from
  `playwright/index.ts:1-3`** even though it types
  `DevstackPlaywrightOptions.extend`.

- **`ImportSpec` exported but `GitImportSpec`/`LocalImportSpec`
  members aren't.** Apps can't narrow.

- **`Provides` and `ProvidesObject` are both exported as the same
  type alias** (`core/types.ts:87`). One name should win.

### Built-in plugin convention drift

- **`sui` open-codes container lifecycle** that `containerService()`
  exists for (`plugins/sui/index.ts:192-311`). The `containerService`
  `probe` hook is the right surface; pre-run-network-rebuild logic
  could be a flag.

- **`sui` declares snapshot via `devstackContainerLabels({ snapshot
  })`** (`plugins/sui/index.ts:287`) rather than the `snapshot:` field
  on `containerService()` (walrus/seal pattern). Two paths, same
  outcome — drift opportunity.

- **`deepbookNs(registry)` accessor exists; `walrusNs`/`sealNs`
  don't.** Pick one shape across plugins.

- **`deepbook.publish` is a hand-rolled `PublishAction` literal**
  rather than wrapping `definePublishAction`. Justified by the
  imported-deps walk; comment the divergence so future readers don't
  refactor it accidentally. Or unify (see DRY below).

- **No app-author hooks on `walrus.register` / `walrus.seedWal`.**
  Compare deepbook's `poolNeeds` + `marketMakers[].needs`. Apps
  wanting "wait for X before seedWal" have no escape.

### DRY (extract triggers met)

- **`createLocalSuiClient(ctx.registry.services.require('sui-rpc').
  url, ctx.network)` — 9 sites.** Extract to `helpers/sui-client.ts`
  as `openSuiRpcClient(ctx)`. Sites:
  `actions/transaction.ts:94`,
  `plugins/deepbook/{market-maker.ts:177,pools.ts:98,127,publish.ts:88}`,
  `plugins/imports/index.ts:382`,
  `plugins/seal/index.ts:188,298`,
  `plugins/walrus/index.ts:482,571`.

- **`splitInputCoin` duplicated verbatim** across
  `plugins/deepbook/swap.ts:80-109` and
  `plugins/deepbook/market-maker.ts:343-374`.

- **`probeUrl` / `waitForReachable` copy-pasted** in
  `plugins/frontend/index.ts:164-194`,
  `plugins/wallet-server/index.ts:225-232`,
  `plugins/walrus/index.ts:714-730`. Three slightly different
  semantics — needs an option-bag if extracted.

- **`buildPriorEntry`** duplicated in
  `plugins/deepbook/publish.ts:91-101` and
  `plugins/imports/index.ts:367-379`.

- **Curated-address-vs-import publish-getStatus body** duplicated
  in `plugins/deepbook/publish.ts:36-54` and
  `plugins/imports/index.ts:254-286`.

### Tests

- **Zero unit tests in any of the 4 example apps** despite all 4
  shipping `vitest.config.ts`. Pure functions like `lib/format.ts`,
  `wallet/src/lib/transactions.ts:16-57` are easy wins.

- **No test for Emit + `runsAs` interaction.** The same-signer tests
  use `type: 'Publish'` only (`runtime/reconcile.test.ts:349-433`).
  Worth pinning that the Emit serialization rule + `runsAs` compose
  cleanly.

- **17 source files >150 lines without sibling `.test.ts`.** Top
  culprits: `plugins/walrus/index.ts` (757),
  `plugins/sui/{index.ts:441,docker.ts:478}`, `plugins/seal/index.ts`
  (461), `plugins/deepbook/market-maker.ts` (391),
  `cli/{stack,console}.ts` (354/326), `cli/snapshot.ts` (270),
  `plugins/wallet-server/index.ts` (232), `plugins/frontend/index.ts`
  (225).

- **`AccountPool` fixture exists but no example uses it**
  (`packages/devstack/src/playwright/account-pool.ts`).
  `architecture-review-followups.md` flagged this; followup fixture
  doc gap below.

### Docs gaps

- **`plugin-authoring.mdx` and `troubleshooting.mdx` don't exist.**
  Both flagged in `architecture-review-followups.md:122-124`.
  `authoring/define-plugin.mdx` is reference, not a recipe.

- **`runsAs:` deserves more than the one paragraph in
  `concepts/actions.mdx:28-33`** — same-signer serialization
  rationale + per-factory defaults (`publishMove` / `runTransaction`
  / explicit `seed` opt-in) belong in their own subsection.

- **`AccountPool` fixture undocumented.**
  `concepts/snapshots.mdx:124` directs readers to "the Playwright
  adapter for AccountPool fixture"; `adapters/playwright.mdx` only
  lists `connectAs` / `selectAccount` / `waitForBalanceUpdate`.

- **17 `dev-wallet/` MDX files missing `description:`.** Already
  warned about; safe to land before a real fix.

### Code quality

- **`require('node:fs')` inside an ESM module:**
  `plugins/codegen/index.ts:278` (`readdirSyncSafe`). Move to
  top-level `import { readdirSync }`.

- **Three `port as number` casts** (`plugins/sui/index.ts:140`,
  `plugins/wallet-server/index.ts:79`, `plugins/seal/index.ts:118`,
  `plugins/frontend/index.ts:77`, `runtime/port-allocator.ts:72,161`).
  `PortAllocator.allocate` already returns `number[]`; casts are
  dead weight (or `noUncheckedIndexedAccess` is poking through;
  destructure with a fallback).

- **Comment-quality drift.** `runtime/reconcile.ts:419-430` JSDoc
  attached to wrong function; `plugins/walrus/index.ts:663-679`
  stacked orphan JSDoc; long banner-style file headers narrate
  structure rather than explain WHY (sui, walrus, supervisor,
  filters, transaction). CLAUDE.md says no narration.

- **References to design-doc sections (`§9.4`, `Q5`, `Q11`, `Q12`,
  `Discovery 2026-04-29`)** in comments will rot.

### Inconsistencies

- **Move `edition` mixed.** `wallet/move/mock_usdc/Move.toml:3` uses
  `2024.beta`; `arena/move/connect_four/Move.toml:3` uses `2024`.
  Pick one across all 4 apps.

- **`token-studio/src/components/Balances.tsx:62` lacks
  `data-testid`** that wallet's Balances has, blocking parallel
  e2e patterns.

- **Stack/UPDATE messages reference "volumes"** (`cli/index.ts:24`)
  even though the no-volumes refactor landed.

---

## P3 — Polish

- `runtime/snapshot.ts:550` `snapshotDirFor` exported but unused
  outside tests.
- `cli/snapshot.ts:175` `suiContainerName` re-export has no
  callers.
- `helpers.ts:35` re-exports `keyFilePath`/`keysDir` etc. that no
  one uses.
- `plugins/walrus/index.ts:222-289` `walrus.deploy` should declare
  `snapshot: { commit: false, quiesce: 'none' }` for documentation
  clarity.
- `plugins/sui/index.ts:133`, `plugins/walrus/index.ts:143-144`
  inline `import('../../core/types.js').PortAllocator` instead of
  hoisting.
- `actions/transaction.ts:39,51` — same `Transaction` symbol
  imported twice (type + value-as-rename).
- `runtime/snapshot.ts:418,478` `JSON.parse(...) as ...` with no
  validation — minor surface for stale on-disk bundle exploitation.
- `runtime/topo.ts:79` regex-capture casts should comment why the
  match guarantees the type.
- `cli/snapshot.ts:103-105` no per-image progress on `--push`.
- `cli/codegen.ts:55-58` exit-1 message references `apply` first
  even when `--target testnet`.
- `cli/stack.ts:111` first-run hint says `pnpm localnet:up` (an
  example-script convention), should say `devstack up`.
- Missing CLI verbs the user wants: `devstack ps`, `devstack logs`,
  `devstack diff`, `devstack accounts`, `devstack manifest`.
- Document `up --once` or remove from examples
  (`examples/wallet/package.json:15`, three more).
- `lib/source.ts` `baseUrl` could land in the validate-llm-docs
  regex check so future stale `/docs/...` links fail CI.

---

## Recommended sequencing

1. **P0 doc + example sweep** (one PR) — link prefix, JSX bug,
   stale symbols, llms-index regen, missing `await`, build-artifact
   gitignore. ~2 hours, broad blast radius, no runtime changes.

2. **P0 reconciler cascade fix** (one PR) — consumeDirty, plus the
   matching `runsAs` + Emit interaction test. <50 lines.

3. **P0 snapshot id reform** (one PR) — `Plugin.inputs` shape +
   thread through `computeSnapshotId`. Touches every built-in but
   each delta is small. ~150 lines.

4. **P1 plugin runsAs + walrus.register provides.registry** (one
   PR) — three plugins pick up `runsAs`, walrus.register gets a
   registry hook. <80 lines.

5. **P1 examples extract pass** (one PR) — `useSignAndExecute` →
   `@mysten-incubation/devstack/react`; `Card.tsx`, `dapp-kit.ts`,
   `shortAddress` decisions. Bigger lift; needs a place to live
   (option A vs B from architecture-review-followups.md).

6. **P1 CLI: one-shot logging + --json** (one PR).

7. **P2 docs gaps** — `runsAs` subsection, `AccountPool` doc,
   plugin-authoring + troubleshooting recipes. Sequence after the
   extract pass so the docs reflect the consolidated API.

P3 items are ambient cleanup; bundle into "while you're here" tags
on whichever PR touches the file.

---

## Out of scope (expected — confirms nothing surprising)

- No named-volume violations anywhere (rule honored).
- No circular imports.
- No `git checkout`/`process.exit(1)`/`--no-verify` anti-patterns.
- Port allocator dual-stack bind is correct.
- Snapshot meta wired through `containerService` + labels (with the
  one sui drift noted).
- All e2e tests pass; cold + warm `devstack apply` succeed; the
  three friction-cleanup PRs (16-18) verified end-to-end.

Strong overall — the issues above are real but the architecture
(action graph + reconciler + per-plugin namespace + manifest as the
serialization seam) holds up under review. The two clearest wins
are the snapshot-id reform (real correctness gap that's invisible
today because no one's hit it yet) and the doc-link sweep (50+ broken
links in user-facing docs).

---

## Round 2 findings (after the first 4 PRs landed)

While verifying PR 19-22 + measuring e2e timings, three more issues
surfaced that belong in the next round of work.

### R1. Walrus subnet hardcoded at `10.0.0.0/24` blocks per-stack siblings (P0)

`packages/devstack/src/plugins/walrus/index.ts:77-78` pins the docker
network at `10.0.0.0/24` and assigns storage nodes to fixed IPs
`10.0.0.10–13`. Two walrus-using stacks (e.g. `private-content/main`
+ `/test`) collide with `Pool overlaps with other one on this address
space`. Same architectural shape as the original "hardcoded ports"
friction the per-stack port allocator closed.

**Tried** — derive `octet` from `hash(appName/stack)` and use
`10.<octet>.0.0/24`. Plugin-side change is ~30 lines and clean;
**but** the upstream `MystenLabs/walrus@<rev>:docker/local-testbed/
files/deploy-walrus.sh` script bakes the hardcoded `10.0.0.10–13`
IPs into the per-node YAML configs at deploy time. Storage nodes
start with the new IPs, then panic with `Cannot assign requested
address` because their YAML still references the old subnet.

**Fix shape**: `sed`-patch `deploy-walrus.sh` during `walrus.build`
to read IPs from env vars (`WALRUS_NODE_IPS`), then thread the
resolved octet's IPs from `walrus.deploy.run`. Mirrors the existing
`RUN sed -i 's|--storage-price 5|--with-wal-exchange ...|'` patch
in `build.ts:78`. The plugin-side change can be re-instated as soon
as the script accepts external IPs.

Captured in `notes/friction.md` as a closed-shape friction.

### R2. Warm e2e double-walks the action graph (~5s recoverable per run) (P1)

`globalSetup` calls `runApply` (one full reconcile cycle, ~5s warm).
`webServer` runs `pnpm dev = devstack up` which **walks the same
graph again** before vite spawns. Every action skips on getStatus.ok=
true, so the second walk produces zero on-chain changes — but pays
~5s of getStatus probes (faucet check, RPC calls, on-chain object
existence checks).

Measured: warm wallet e2e is 32s total; tests sum to 11s; bring-up
overhead is ~21s (≈5s globalSetup + ~12s webServer + ~3-5s teardown).
The webServer reconcile is the largest single overhead bucket.

**Fix shape**: `pnpm dev` should detect "stack already at known
state from this process's prior `runApply`" and skip straight to
spawning HostProcess actions. Two routes:
1. Cheap — pass `DEVSTACK_E2E_GLOBAL_SETUP_RAN=1` env from
   globalSetup; supervisor skips the initial reconcile cycle.
2. Cleaner — `runApply` returns a "manifest digest"; `up` reads
   the stored digest from `<stackDir>/last-apply` and skips its
   first cycle when the digest matches.

Either way, the recoverable time is ~5s per warm e2e run × every CI
job × every dev run.

### R3. `alice sends 100 mUSDC` test flakes intermittently (P1)

Test #5 (`e2e/send-sui.spec.ts:38`) failed 2/4 cold runs while
gathering timing data; passes consistently on warm runs. Failure
mode: `expect(sendCard.getByText(/Last tx:/i)).toBeVisible({ timeout:
20_000 })` times out, but the tx itself succeeds (balance updates
on next manual click).

Hypothesis: race between (a) `useSignAndExecute.mutateAsync`
resolving and `setLastDigest`'s render, and (b) `useInvalidateBalances`
clearing query state — the component may re-render with empty
state during the window where `Last tx:` should be visible. Worth a
look but probably not framework-side.

**Investigate**: bump the timeout? Add a fence between the two
state writes? Inspect SendCard's render path. ~30min triage.

---

## Round 2 sequencing (additions to the original 7-step list)

8. **R1 walrus subnet via deploy-script patch** (one PR) —
   sed-patch `deploy-walrus.sh` in `walrus.build`, plumb env-var IPs
   from `walrus.deploy.run`, re-instate the per-stack octet logic.
   Unblocks parallel walrus stacks. ~80 lines incl. the previously
   reverted `walrusOctet`/`walrusSubnet`/`walrusNodeIp` helpers.

9. **R2 warm-path single-reconcile** (one PR) — wire
   globalSetup's apply-completion signal into the `pnpm dev`
   supervisor so the second cycle short-circuits. ~50 lines + a
   verification test that reads timing from progress callbacks.

10. **R3 mUSDC-send flake triage** (one PR) — investigation, then
    either harden the test or fix the race. <50 lines.

After Round 2 lands: continue with the original Round 1 punch-list
items (5-7: examples extract pass, CLI logging/JSON, docs gaps).

The order matters: R1 unblocks any future cross-stack timing work
on private-content; R2 cuts e2e overhead by ~15% across the board;
R3 stops blocking CI on a flake. All three are tractable and have
specific measurements driving them.
