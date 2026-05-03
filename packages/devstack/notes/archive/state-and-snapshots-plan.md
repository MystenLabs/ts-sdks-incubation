# Devstack: container-layer state model + reliable shared-stack testing

## Context

Devstack tests today have two acute problems and one architectural one:

1. **Cold starts dominate first-run cost.** Fresh `devstack up` on `examples/private-content` takes ~76 s (sui image build + walrus deploy + seal package publish). Warm runs short-circuit via `getStatus` skip-predicates to ~1–3 s, but every CI job and every fresh-checkout dev pays the full cold cost. State snapshots are explicitly parked in `notes/archive/phase1-friction.md`.
2. **The Playwright two-Supervisor handoff has a documented race.** `notes/architecture-review/23-playwright-integration.md:5-19` traces it: globalSetup runs `runUp({once:true})` which fires shutdown hooks, killing the in-process wallet-server and forgetting its token; the dev-server's `pnpm dev` Supervisor then mints a fresh token. The frontend bundle reads the new token from the manifest, but a Playwright page that loaded earlier still holds the dead one. Result: flaky `401` on signing.
3. **The state model is split between named volumes and the container layer**, with no consistent rule. Sui chain state lives in a named volume (`sui-data`), walrus deploy outputs live in a named volume (`walrus-deploy-outputs`), walrus storage-node RocksDB *accidentally* lives in the container layer (no volume declared), seal is stateless. This inconsistency means snapshots can't capture walrus storage-node state at all (volume-tar misses container layers), and it blocks future "release-published seeded images" because volumes shadow image-baked state.

## Constraints (from this conversation)

- **Shared docker containers across tests.** No per-test container churn; isolation comes from logical primitives (account leasing, package-once-per-session).
- **State is disposable; caching is best-effort optimization, not a guarantee.** Setup must be reproducible from configuration; snapshots are a speed cache, not a system of record.
- **Consistent experience across all services.** Same mental model for sui, walrus, seal, wallet-server. No per-plugin special cases.
- **Forward-compatible with release-published base images.** Future state where CI publishes pre-built (and eventually pre-seeded) images to GHCR; the architecture must compose with that without a rewrite.
- **Race fix mechanism**: apply-only globalSetup. Drop service-action shutdown from the test-bringup path; let `pnpm dev`'s Supervisor own service lifecycle.
- **`packages/devstack/CLAUDE.md` philosophy**: extract from evidence, not anticipation. We're past the "extract" trigger for these specific friction points (documented friction archive entries + race architecture review).

## Approach: one rule for state

> **State lives in exactly one of two places:**
> 1. **Container writable layer** — captured via `docker commit`, restored via `docker run` from a seeded image tag.
> 2. **Host filesystem under `<stackDir>/<plugin>/`** — captured via `fs.cpSync`, restored symmetrically.
>
> **No named volumes.** Cross-container coordination uses host bind mounts to `<stackDir>/<plugin>/` paths.

Every plugin author answers the same three questions:
1. Does my container have stateful in-process data? → If yes, declare `snapshot: { commit: true, quiesce: 'pause'|'stop' }`.
2. Do I produce artifacts that other containers need to read? → Write them to `<stackDir>/<plugin>/`; bind-mount that path into your readers.
3. Do I need a binary another plugin builds? → Bake it into your own image at build time, version-pinned via build-args.

Snapshot is the union: `docker commit` of every container with `commit: true`, plus a copy of `<stackDir>`. Restore is symmetric. No tar, no busybox dance, no per-volume ceremony.

## Phased rollout (seven PRs)

```
PR 1   runApply() + globalSetup race fix                                ~80 lines
PR 2   No-volumes refactor: sui, walrus, seal migrate state             ~400 lines
PR 3   Snapshot CLI: docker-commit + host-capture                       ~300 lines
PR 4   containerService.snapshot field — plugin contract                 ~50 lines
PR 5   App-level setup: ergonomic per-app pre-defined state             ~350 lines
PR 6   AccountPool wired into one example e2e (uses PR 5)               ~150 lines
PR 7   GHA cache + `devstack snapshot save --push <registry>`         workflow + ~100 lines
```

PRs 1, 2, 4 are framework foundation. PR 3 builds the snapshot machinery on top. PR 5 is the app-author seam — without it, framework snapshots only capture sui+walrus+seal in default state and apps still pay cold cost (~10–30 s of Move publishes + fixture creation) on every run. PRs 6 and 7 demonstrate value end-to-end. PRs 1 and 2 can land in parallel; the rest serialize.

---

## PR 1 — `runApply()` + globalSetup race fix

**Goal**: globalSetup brings the chain to known state without owning long-lived services. The webServer's `pnpm dev` Supervisor becomes sole authority on Service + HostProcess actions.

**Mechanism**: New Supervisor entry point `runApply()`.
1. Skips `HostProcess` action types entirely (wallet-server, vite-supervisor). Docker-managed `Service` actions still run — they survive process exit by design.
2. Does not fire shutdown hooks at end of cycle. Hooks are registered as usual but never invoked. Process exits, hooks GC. Containers keep running detached.

This is option (a) from `notes/architecture-review/23-playwright-integration.md:39-41`. The earlier failed `runApply` attempt (per `playwright/global-setup.ts:14-19`) tried to run HostProcess actions and leaked them; this version skips HostProcess types so there's nothing to leak.

**Files**:
- **NEW** `packages/devstack/src/cli/apply.ts` — `runApply(opts)`.
- **MODIFY** `packages/devstack/src/runtime/supervisor.ts` — accept `skipActionTypes?: ActionType[]`; skip shutdown phase when caller requests apply mode.
- **MODIFY** `packages/devstack/src/playwright/global-setup.ts:36-41` — replace `runUp({once: true})` with `runApply()`. Update stale comment block at lines 1-23.

**Verification**: `pnpm test:e2e` ten times in a row on `private-content`; zero `401` flakes. With `devstack watch` running concurrently, the watcher's wallet-token survives test runs.

---

## PR 2 — No-volumes refactor

**Goal**: every persistent piece of stack state lives in exactly one of two places — container writable layer or `<stackDir>/<plugin>/`. Three named volumes go away: `<sui-container>-data`, `sui-bin`, `walrus-deploy-outputs`.

### 2a. Sui plugin

`plugins/sui/index.ts:245-252` drops the volume mounts:
```ts
// before
volumes: [
  `${containerName}-data:/root/.sui`,
  `${suiBinVolumeName(ctx.appName, ctx.stack)}:/sui-bin`,
],
// after
// (no volumes field)
```

Container's writable layer holds `/root/.sui`. Stop/start preserves it (writable layer survives `docker stop`). `docker rm` is destructive — operator should `down`, not `rm` (pre-existing convention in `cli/stack.ts`).

The entrypoint's "copy sui binary into `/sui-bin`" step is dropped (no consumer). Sui binary stays in `/usr/local/bin/sui` where the upstream tarball put it.

Image-tag bumps are now uniformly destructive (today the volume preserved state across rebuilds; without the volume, `-rN` bumps wipe state). This matches the rev-suffix's intent — structural change implies state regeneration. Snapshot IDs include the image tag, so any bump invalidates cached snapshots correspondingly.

### 2b. Walrus plugin

**Drop `walrus-deploy-outputs` named volume; replace with `<stackDir>/walrus/deploy/` host bind mount.**

In `plugins/walrus/index.ts:233`:
```ts
// before
volumes: [`${deployOutputsVolume(ctx.appName, ctx.stack)}:/opt/walrus/outputs`],
// after
volumes: [`${stackDir(ctx.appDir, ctx.stack)}/walrus/deploy:/opt/walrus/outputs`],
```

In `plugins/walrus/index.ts:279-282` (storage-node spec):
```ts
// before
volumes: [
  `${suiBinVolumeName(ctx.appName, ctx.stack)}:/root/sui_bin`,
  `${deployOutputsVolume(ctx.appName, ctx.stack)}:/opt/walrus/outputs`,
],
// after
volumes: [`${stackDir(ctx.appDir, ctx.stack)}/walrus/deploy:/opt/walrus/outputs:ro`],
```

**Bake sui binary into walrus image at build time.** `plugins/walrus/build.ts` adds a `SUI_VERSION` build-arg + a stage that downloads the matching sui release tarball. Image size +~50 MB. Eliminates the runtime coupling via `sui-bin`. Drop `suiBinVolumeName` references entirely.

**Storage-node state stays in container writable layer** (where it accidentally is today). Snapshot via `docker commit` (PR 3).

**Deploy `getStatus` becomes file-based**:
```ts
getStatus: async (ctx) => {
  const file = resolve(stackDir(ctx.appDir, ctx.stack), 'walrus/deploy/deploy');
  if (!existsSync(file)) return { ok: false, detail: 'deploy outputs not present' };
  try {
    parseDeployFile(readFileSync(file, 'utf8'));
    return { ok: true, detail: 'deploy outputs present' };
  } catch {
    return { ok: false, detail: 'deploy outputs unparseable' };
  }
}
```

Container existence becomes irrelevant; the file IS the output. Snapshot restore writes the file → deploy `getStatus` ok → deploy never re-runs. Forward-compatible with future pre-deployed walrus testbed images: a baked-in deploy file in `/opt/walrus/outputs/` (read via `readContainerFile(node-0, ...)` as today's `register` action does) satisfies the same content check.

**Auto-`docker rm` deploy container on success.** Tail of `run`: once `waitForContainerExit(containerName)` returns 0, `removeContainer(containerName)`. Outputs are on host; the container is dead weight.

### 2c. Seal plugin

Stateless. No state migration needed. Plugin declares `snapshot: { commit: false, quiesce: 'none' }` once PR 4 lands. Master key already in `<stackDir>/.keys/seal-master-key.json`; on-chain KeyServer object already in sui chain (captured via sui's container snapshot).

### 2d. Stack-drop semantics

`cli/stack.ts:336-341` (`removeStackVolumes`) becomes a no-op (or deletes only legacy volumes for backward compat during migration). Stack drop reduces to: stop+remove containers, remove network, delete `<stackDir>`. Cleaner than today.

### Files (PR 2)

- **MODIFY** `packages/devstack/src/plugins/sui/index.ts` — drop volume mounts; drop `suiBinVolumeName`. Update entrypoint to skip the `/sui-bin` copy step.
- **MODIFY** `packages/devstack/src/plugins/sui/Dockerfile` + `entrypoint.sh` — drop `/sui-bin` write logic. Bump `-r6` → `-r7`.
- **MODIFY** `packages/devstack/src/plugins/walrus/index.ts` — bind-mount deploy dir; drop `sui-bin` mount; drop `deployOutputsVolume` references; file-based `getStatus`; auto-rm deploy container.
- **MODIFY** `packages/devstack/src/plugins/walrus/build.ts` — bake sui binary into image; bump `WRAPPER_REV` `r1` → `r2`.
- **MODIFY** `packages/devstack/src/cli/stack.ts:336-341` — drop volume-removal logic from drop path (or scope to legacy only).
- **MIGRATE** `packages/devstack/src/plugins/sui/index.ts:148` from raw `service()` to `containerService()` while we're touching it (the consolidation that commit `05d64cf` started but hadn't reached sui).

### Verification (PR 2)

- `cd examples/token-studio && pnpm devstack up` — completes successfully with no named volumes created.
- `docker volume ls --filter label=devstack.app=token-studio` — empty.
- Stop/start cycle preserves chain state and walrus storage-node state.
- `devstack stack drop main --yes --force` removes all containers + `<stackDir>` and leaves no zombies.
- Existing e2e tests pass with no behavior change beyond the volume elimination.

---

## PR 3 — Snapshot CLI: `docker commit` + host-capture

**Goal**: capture seeded state as portable images + a host-state directory; restore via `docker run` from the seeded tags + `fs.cpSync`.

### On-disk format

```
<appDir>/.devstack/snapshots/<sha-id>/
  snapshot.json                    # { id, alias?, createdAt, platform, images: { sui: "tag@digest", walrus-node-0: "...", ... } }
  host.tar.zst                     # tar of <stackDir> at capture time
  aliases/<human-name> -> <sha-id> # symlink
```

Images themselves live in the local docker daemon's image store, referenced by tag in `snapshot.json`. `--portable` flag triggers `docker save` of the seeded images into a `images.tar` next to `host.tar.zst` for offline distribution; default is local-only.

### Content-addressing

`<sha-id>` = `sha256(canonicalJSON({plugin-versions, base-image-tags, plugin-options, account-list, platform}))`. Reuses `runtime/hash.ts:stableHash`. Identical inputs → identical IDs by construction.

### Capture algorithm

1. Resolve target stack from `--stack` flag or active pointer.
2. Refuse if `HostProcess` actions are running (operator must `down` first or pass `--force`).
3. For each container declared `snapshot.commit: true`:
   - `docker pause` if `quiesce: 'pause'`, `docker stop` if `quiesce: 'stop'`.
   - `docker commit <container> dev-examples/<plugin>-seeded:<sha-id>-<plugin>` (and tag with the alias too if provided).
   - Resume.
4. `tar -I 'zstd -3' -cf host.tar.zst -C <stackDir> .`
5. Atomic-rename `snapshot.json.tmp` → `snapshot.json` (last; partial bundle without manifest is invalid; pattern from `runtime/manifest-writer.ts:64-76`).

### Restore algorithm

1. Resolve `<sha-id>` from arg (raw hex or alias symlink).
2. Refuse if any container labeled for the target stack is running.
3. Verify each image referenced in `snapshot.json` is present (`docker image inspect`); if `--portable` snapshot, load from `images.tar` first.
4. Drop existing `<stackDir>`; restore from `host.tar.zst`.
5. Done. Next `devstack up` runs containers from the seeded image tags. **Existing `getStatus` skip-predicates do all the work** — every probe returns ok because state is in the layers + host files.

### Invalidation

- Cross-arch: `snapshot.json.platform` records `process.arch + process.platform`. Restore refuses on mismatch unless `--force-arch`. CI (`linux/amd64`) and dev (`darwin/arm64`) get distinct IDs by construction.
- Stale-by-epoch-pruning: `snapshot.json.createdAt` + `epochsToRetain × 24h`. Restore warns; `--force-stale` to override.
- Image-tag drift: `<sha-id>` includes base image tags; bumping any → different ID; old snapshot still on disk but unrelated to new config.

### CLI

```
devstack stack snapshot save <alias> [--stack <name>] [--portable] [--force]
devstack stack snapshot restore <alias|id> [--stack <name>] [--force-arch] [--force-stale]
devstack stack snapshot list [--stack <name>]
devstack stack snapshot rm <alias|id>
devstack stack snapshot hash [--stack <name>]              # for CI cache key
devstack stack snapshot save <alias> --push <registry>     # PR 6
```

### Files (PR 3)

- **NEW** `packages/devstack/src/runtime/snapshot.ts` — `captureSnapshot`, `loadSnapshot`, `listSnapshots`, `removeSnapshot`, `pushSnapshot`, `computeSnapshotId`.
- **NEW** `packages/devstack/src/runtime/snapshot.test.ts` — unit tests with a fake docker layer.
- **NEW** `packages/devstack/src/cli/snapshot.ts` — argv parsing + dispatch, mirroring `cli/stack.ts:368-402` style.
- **MODIFY** `packages/devstack/src/cli/index.ts` — route `stack snapshot ...` subcommand.
- **MODIFY** `packages/docs/content/devstack/getting-started.mdx` — short section on snapshots.

### Verification (PR 3)

```bash
cd examples/token-studio
pnpm devstack up
pnpm devstack stack snapshot save baseline
pnpm devstack stack down
pnpm devstack stack drop main --yes --force
pnpm devstack stack snapshot restore baseline
pnpm devstack up                              # warm-start: every getStatus ok, ~10s total
```

Time-budget: cold seed ~76 s → snapshot restore + warm `up` < 15 s.

---

## PR 4 — `containerService.snapshot` plugin contract

**Goal**: per-plugin declaration of capture behavior. Whole-stack capture (PR 3) works without this for stateful Service actions via a default of `commit: true, quiesce: 'stop'` — but the explicit field documents intent and lets stateless plugins opt out cleanly.

### Type extension

```ts
// packages/devstack/src/actions/container-service.ts (lines 29-69)
export interface ContainerServiceOptions<TInputs extends Record<string, unknown>> {
  // ... existing fields ...
  snapshot?: {
    /** Capture this container's writable layer via `docker commit` on snapshot save.
     *  Default: true for Service actions. Set false for stateless services (seal). */
    commit?: boolean;
    /** Quiesce strategy. 'pause' (cgroup freezer, fast, RocksDB-safe for single
     *  writer), 'stop' (graceful SIGTERM, required for batched-write services
     *  like walrus storage nodes), 'none' (skip — stateless services). Default 'stop'. */
    quiesce?: 'pause' | 'stop' | 'none';
    /** Optional plugin-specific capture/restore for state outside the container
     *  layer or <stackDir>. Most plugins don't need this — the implicit host
     *  capture covers <stackDir>/<plugin>/ paths automatically. */
    capture?: (ctx: LocalnetActionRunContext) => Promise<unknown>;
    restore?: (ctx: LocalnetActionRunContext, blob: unknown) => Promise<void>;
  };
}
```

### Per-plugin declarations

| Plugin | commit | quiesce | Notes |
|---|---|---|---|
| sui.localnet | true | pause | RocksDB single-writer, cgroup-freezer-safe |
| walrus.deploy | n/a | n/a | Job action (one-shot), not Service. Output captured via host fs. |
| walrus.node-N | true | stop | Walrus needs graceful flush of write batches |
| walrus.proxy | false | none | Stateless nginx; config regenerated from registry on each `up` |
| seal.serve | false | none | Stateless; master key in env from `<stackDir>/.keys/` |
| wallet-server.serve | n/a | n/a | HostProcess, not Service; token in `<stackDir>/wallet-token` (host capture) |

### Files (PR 4)

- **MODIFY** `packages/devstack/src/actions/container-service.ts` — add `snapshot` field + thread through to action metadata.
- **MODIFY** `packages/devstack/src/core/types.ts` — add `snapshotMeta?` to `ServiceAction` so the snapshot orchestrator can read it.
- **MODIFY** `packages/devstack/src/plugins/sui/index.ts` (after migration to `containerService` in PR 2) — declare `snapshot: { commit: true, quiesce: 'pause' }`.
- **MODIFY** `packages/devstack/src/plugins/walrus/index.ts` — declare `snapshot: { commit: true, quiesce: 'stop' }` for nodes; `commit: false, quiesce: 'none'` for proxy.
- **MODIFY** `packages/devstack/src/plugins/seal/index.ts` — `snapshot: { commit: false, quiesce: 'none' }`.

### Plugin-author principle (doc)

Add to `packages/devstack/docs/principles.md` or equivalent:

> **getStatus must check content, not metadata.** Probe the actual state (chain reachable + checkpoint present, on-chain object exists, file readable + parseable) — not "container exists" or "host file path matches our convention." This makes plugins compose cleanly with state arriving via fresh seed, snapshot restore, or pre-published seeded base images.

This is the seam that makes future release-published seeded images Just Work without plugin changes.

---

## PR 5 — App-level `setup:` ergonomic config field

**Goal**: make per-app pre-defined state cheap to declare and snapshot. Apps need to publish their Move packages, mint fixture coins, create initial shared objects — without writing a full plugin. This is the seam that makes per-app snapshot caches a real shipping-quality optimization rather than a framework-internal one. Without it, snapshots only capture sui+walrus+seal in default state and apps still pay ~10–30 s of cold-start cost on every run for their own Move publishes and fixture creation.

### Mechanism

A new top-level `setup?: SetupAction[]` field on `DevstackConfig`. Items are ergonomic helpers that compile down to existing primitives (`definePublishAction`, `seed`, `register`).

```ts
// examples/token-studio/devstack.config.ts
import { localnetKey, publishMove, runTransaction, sui, walletServer } from '@mysten-incubation/devstack';

export default {
  app: 'token-studio',
  plugins: [sui(), walletServer()],
  accounts: { alice: localnetKey('alice'), bob: localnetKey('bob') },
  setup: [
    publishMove({
      name: 'token-studio',
      path: './move/token-studio',
      capture: { admin: '::admin::AdminCap' },
    }),
    runTransaction({
      name: 'mint-initial-supply',
      needs: ['token-studio'],
      signer: 'alice',
      build: (ctx, tx) => {
        const pkg = ctx.registry.packages.require('token-studio');
        tx.moveCall({
          target: `${pkg.packageId}::token::mint`,
          arguments: [tx.object(pkg.captured.admin), tx.pure.u64(1_000_000_000n)],
        });
      },
    }),
    runTransaction({
      name: 'create-test-fixtures',
      scope: 'test-only',
      needs: ['mint-initial-supply'],
      signer: 'alice',
      build: (ctx, tx) => { /* ... */ },
    }),
  ],
};
```

### How it works

- **`loadConfig()` converts `setup:` into a synthetic plugin** named `<app>-setup` and appends it to `plugins[]`. From the rest of the system's perspective it's a normal plugin — no special-casing in the action graph, supervisor, snapshot orchestrator.
- **`publishMove()` wraps `definePublishAction()`** with sensible defaults: auto `getStatus` probe (package present on chain by name), auto-captures admin caps via `capture: {}`. Tracks Move source files via input-hash for cache invalidation.
- **`runTransaction()` is a new helper that wraps `seed()`**:
  - `signer: 'alice'` resolves to `ctx.accounts.get('alice')`
  - `build(ctx, tx) => void` populates the transaction
  - Default `getStatus` checks the captured output objects' existence on chain; user can override with explicit `probe`
  - Auto-registers any returned object IDs in `registry.captured` if `capture: {}` provided

### `scope` for test-only setup

`scope: 'always' | 'localnet-only' | 'test-only'` (default `'always'`).
- `'always'` runs in every stack
- `'localnet-only'` skips on testnet/mainnet (analog of existing `seedRunsOn` behavior)
- `'test-only'` runs only when the active stack name starts with `test` (or `DEVSTACK_TEST=1`)

This lets apps differentiate "must always publish my package" from "fixture data only needed in test stacks". The `main` stack snapshot is leaner than the `test` stack snapshot; both have distinct `<sha-id>`s by construction (different action set → different hash) so they cache independently.

### Snapshot composition

- All `setup:` actions are part of the action graph → contribute to the snapshot's content-addressed `<sha-id>`
- Their effects (chain state) are captured via sui's container-layer commit (PR 3)
- Captured object IDs go to registry → manifest → host capture (PR 3)
- Restore brings it ALL back; existing `getStatus` skip-predicates short-circuit re-execution

So a snapshot of token-studio after PR 5 includes: sui chain with the token-studio Move package published + AdminCap captured + initial supply minted, plus all four nodes' walrus state, plus all keys/manifest/wallet-token. Restore = full ready-to-test state in <15 s.

### Files (PR 5)

- **NEW** `packages/devstack/src/actions/transaction.ts` — `runTransaction()` helper wrapping `seed()`.
- **NEW** `packages/devstack/src/actions/transaction.test.ts` — unit tests for the wrapper + scope filtering.
- **NEW** `packages/devstack/src/actions/publish-move.ts` — `publishMove()` ergonomic surface over `definePublishAction()`.
- **MODIFY** `packages/devstack/src/core/types.ts` — add `SetupAction` union; `setup?: SetupAction[]` on `DevstackConfig`; `scope?: SetupScope` field.
- **MODIFY** `packages/devstack/src/cli/loadConfig.ts` (or wherever config loading happens) — convert `setup:` into a synthetic plugin via `definePlugin()`; apply scope filtering against active stack name.
- **MODIFY** `packages/devstack/src/index.ts` — re-export `publishMove`, `runTransaction`, `localnetKey` if not already exported.
- **MODIFY** `packages/docs/content/devstack/getting-started.mdx` — section on app-level setup (after the snapshot section so the snapshot+setup interaction is clear).
- **MODIFY** `packages/devstack/CLAUDE.md` — anti-pattern note: "if you find yourself reaching for `definePlugin()` to wrap one or two app-specific actions, use `setup:` instead".

### Verification (PR 5)

- Convert one example app (token-studio) to use `setup:` instead of inline plugin; identical `devstack up` behavior.
- Snapshot before and after a `setup:` change; confirm `<sha-id>` differs; restore from old `<sha-id>` brings back old state.
- Add a `scope: 'test-only'` action; `devstack up --stack main` skips it; `devstack up --stack test` runs it.
- Snapshot main stack and test stack; confirm distinct IDs; restore each; confirm scope-appropriate state.
- Time-budget: cold seed of token-studio drops from ~80 s to ~10 s on snapshot restore (the ~70 s saved is what was previously app-level Move publish + fixture mint).

### Why this is critical for testing efficiency

Without PR 5: framework snapshots capture sui+walrus+seal in default state. Tests still pay 10–30 s every run for app-level Move publishes + fixtures. Snapshot restore saves only the framework-cold cost, not the app-cold cost. CI runs of test suites that need real chain state see only modest improvement.

With PR 5: app-level setup is in the snapshot. Restore = ready-to-test state including all app-published packages and fixture data. **A test suite that previously took 90 s to start now takes 10 s.** This is the value proposition that makes the whole snapshot story shipping-quality for app authors, not just framework-internal optimization.

---

## PR 6 — `AccountPool` wired into one example e2e (uses PR 5)

**Goal**: prove the per-test isolation pattern AND demonstrate the `setup:` field end-to-end. CLAUDE.md says "claim from a pool — never faucet-per-test"; the pool exists at `packages/devstack/src/vitest/accountPool.ts:57` but no test consumes it.

### Mechanism

Add a Playwright fixture that:
1. Reads the manifest from `<appDir>/.devstack/stacks/<stack>/manifest.json` at fixture init.
2. Constructs an `AccountPool` once per worker (idempotent prefund).
3. Exposes `lease()` / `release()` via Playwright `test.use()`.

### Choice of test

`examples/token-studio/e2e/create-coin.spec.ts` — already uses real chain + real wallet adapter. Conversion:
1. Migrate token-studio's hand-written setup to `setup:` field (proves PR 5 in a real app)
2. Convert hardcoded alice/bob to leased accounts (proves AccountPool)

The combination demonstrates the full per-test-isolation story: app pre-publishes its package via `setup:` → snapshot caches it → tests lease accounts and use the published package without faucet calls.

### Files (PR 6)

- **NEW** `packages/devstack/src/playwright/account-pool.ts` — `defineDevstackAccountPool()` returning a fixture object.
- **MODIFY** `packages/devstack/src/playwright/index.ts` — re-export.
- **MODIFY** `examples/token-studio/devstack.config.ts` — adopt `setup:` for the app's Move publish + initial-supply mint.
- **MODIFY** `examples/token-studio/e2e/create-coin.spec.ts` — convert to lease pattern.
- **MODIFY** `packages/docs/content/devstack/getting-started.mdx` — short section on the pattern.

### Verification (PR 6)

- Run `pnpm test:e2e` on token-studio; tests pass.
- Run twice back-to-back; second run does not leak state from first.
- Faucet calls: zero on warm runs (idempotent prefund).
- Snapshot the test stack after one successful run; restore on a fresh CI runner; tests pass without re-publishing the Move package.

---

## PR 7 — GHA cache + `devstack snapshot save --push <registry>`

**Goal**: CI inherits the cold-start win; org-shared snapshots become possible.

### `--push` mechanics

```
devstack stack snapshot save baseline --push ghcr.io/myorg/<app>-snapshots
```

Tags each committed image with `ghcr.io/myorg/<app>-snapshots/<plugin>:<alias>` and `docker push`es. `snapshot.json` records the registry tags; `restore` `docker pull`s any missing image before bringing the stack up.

### GHA recipe

```yaml
jobs:
  seed:
    runs-on: ubuntu-latest
    outputs:
      snapshot-id: ${{ steps.hash.outputs.id }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - id: hash
        run: |
          ID=$(pnpm devstack stack snapshot hash --config examples/token-studio/devstack.config.ts)
          echo "id=$ID" >> $GITHUB_OUTPUT
      - id: cache
        uses: actions/cache@v4
        with:
          path: examples/token-studio/.devstack/snapshots
          key: devstack-snapshot-host-${{ runner.arch }}-${{ steps.hash.outputs.id }}
      - if: steps.cache.outputs.cache-hit != 'true'
        run: |
          pnpm devstack up --config examples/token-studio/devstack.config.ts
          pnpm devstack stack snapshot save baseline --portable --config examples/token-studio/devstack.config.ts
          pnpm devstack stack down --config examples/token-studio/devstack.config.ts

  test-shard:
    needs: seed
    strategy:
      matrix: { shard: [1, 2, 3, 4] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/cache@v4
        with:
          path: examples/token-studio/.devstack/snapshots
          key: devstack-snapshot-host-${{ runner.arch }}-${{ needs.seed.outputs.snapshot-id }}
      - run: pnpm devstack stack snapshot restore baseline --config examples/token-studio/devstack.config.ts
      - run: pnpm test:e2e --shard ${{ matrix.shard }}/4
```

For org-shared snapshots, the seed job pushes to GHCR via `--push`; subsequent runs pull seeded images directly without GHA cache.

### Files (PR 7)

- **MODIFY** `packages/devstack/src/cli/snapshot.ts` (from PR 3) — `--push <registry>` flag.
- **MODIFY** `packages/devstack/src/runtime/snapshot.ts` — `pushSnapshot` + pull-on-restore path.
- **NEW** `.github/workflows/e2e.yml` — seed/test-shard pattern.
- **MODIFY** `packages/docs/content/devstack/getting-started.mdx` — CI section.

---

## Critical files

```
NEW
  packages/devstack/src/cli/apply.ts                          # PR 1
  packages/devstack/src/cli/snapshot.ts                       # PR 3
  packages/devstack/src/runtime/snapshot.ts                   # PR 3
  packages/devstack/src/runtime/snapshot.test.ts              # PR 3
  packages/devstack/src/actions/transaction.ts                # PR 5
  packages/devstack/src/actions/transaction.test.ts           # PR 5
  packages/devstack/src/actions/publish-move.ts               # PR 5
  packages/devstack/src/playwright/account-pool.ts            # PR 6
  .github/workflows/e2e.yml                                   # PR 7

MODIFY
  packages/devstack/src/cli/index.ts                          # PRs 1, 3
  packages/devstack/src/runtime/supervisor.ts                 # PR 1
  packages/devstack/src/playwright/global-setup.ts            # PR 1
  packages/devstack/src/playwright/index.ts                   # PR 6
  packages/devstack/src/plugins/sui/index.ts                  # PR 2 (drop volumes, migrate to containerService); PR 4 (snapshot field)
  packages/devstack/src/plugins/sui/Dockerfile                # PR 2
  packages/devstack/src/plugins/sui/entrypoint.sh             # PR 2
  packages/devstack/src/plugins/walrus/index.ts               # PR 2 (bind-mount, file-based getStatus); PR 4
  packages/devstack/src/plugins/walrus/build.ts               # PR 2 (bake sui binary)
  packages/devstack/src/plugins/seal/index.ts                 # PR 4
  packages/devstack/src/cli/stack.ts                          # PR 2 (drop volume cleanup)
  packages/devstack/src/actions/container-service.ts          # PR 4
  packages/devstack/src/core/types.ts                         # PR 4 (snapshotMeta); PR 5 (SetupAction, setup field)
  packages/devstack/src/cli/loadConfig.ts                     # PR 5 (synth plugin from setup:)
  packages/devstack/src/index.ts                              # PR 5 (re-export setup helpers)
  examples/token-studio/devstack.config.ts                    # PR 6 (adopt setup:)
  examples/token-studio/e2e/create-coin.spec.ts               # PR 6
  packages/docs/content/devstack/getting-started.mdx          # PRs 3, 5, 6, 7
  packages/devstack/docs/principles.md                        # PR 4 (getStatus principle)
  packages/devstack/CLAUDE.md                                 # PR 5 (setup: anti-pattern note)

REUSED (no changes)
  packages/devstack/src/runtime/hash.ts            (snapshot id derivation; setup: actions feed it)
  packages/devstack/src/runtime/manifest-writer.ts (atomic-write pattern)
  packages/devstack/src/cli/stack.ts:252-270       (label-based container enumeration)
  packages/devstack/src/plugins/sui/docker.ts      (dockerRun, inspectContainer helpers)
  packages/devstack/src/runtime/active-stack.ts    (stackDir, resolveStack — used by scope filtering)
  packages/devstack/src/vitest/accountPool.ts      (Pool class — wire from playwright side)
  packages/devstack/src/actions/publish.ts         (definePublishAction — publishMove wraps it)
  packages/devstack/src/actions/seed.ts            (seed factory — runTransaction wraps it)
  packages/devstack/src/plugin.ts                  (definePlugin — used to synthesize app-setup plugin)
```

---

## End-to-end verification

After all seven PRs:

1. **Cold start (no cache)**: `cd examples/token-studio && rm -rf .devstack && pnpm devstack up` ~75 s (no regression vs today).
2. **Snapshot save + restore**: `pnpm devstack stack snapshot save baseline`, `pnpm devstack stack drop main --yes --force`, `pnpm devstack stack snapshot restore baseline && pnpm devstack up` < 15 s total.
3. **No volumes**: `docker volume ls --filter label=devstack.app=token-studio` empty after every run.
4. **Race fix**: `pnpm test:e2e` ten times back-to-back on `private-content`, zero `401` flakes; concurrent `devstack watch` survives.
5. **App-level setup**: token-studio's `devstack.config.ts` declares its Move publish + initial-supply mint via `setup:`. Snapshot of post-setup state restores in <15 s with the package already published and AdminCap captured. Modifying a `setup:` action invalidates the snapshot's `<sha-id>` cleanly.
6. **Test-only scope**: `setup: [{ scope: 'test-only', ... }]` actions run on `--stack test` and skip on `--stack main`. Two distinct snapshots, two distinct `<sha-id>`s.
7. **AccountPool isolation**: `pnpm test:e2e` twice on token-studio; second run sees no state leakage from first; zero faucet calls on warm runs.
8. **CI cache hit**: open a no-op PR; workflow's seed job restores from cache; total CI time saves ~70 s × shard count.
9. **Forward compatibility**: when a release-published `ghcr.io/mysten/walrus-testbed:1.48.0-deployed` image becomes available, the walrus plugin pins it as `image:` and the deploy action's file-based `getStatus` skips automatically. No plugin code change required.

---

## Out of scope (deferred to friction-driven extraction)

| Idea | Why deferred |
|---|---|
| New `Restore` Action type that synthesizes into the topo graph | The CLI surface + existing `getStatus` skip-predicates do the same job. Adding an Action type is speculative complexity. |
| Per-test-file ephemeral stacks (`clone-<workerid>-<filehash>`) | Ruled out: pays full container startup per file. |
| Per-test walrus blob-namespace fixture | No friction reported yet. Add when a test needs it. |
| Shared-object-factory fixture | Same — extract from a real test that demands it. |
| Containerizing wallet-server | Apply-only globalSetup (PR 1) eliminates the race without this restructure. |
| Btrfs/ZFS snapshotter fast-path on Linux CI | Premature; `docker commit` is fast enough. |
| Release-pipeline workflow (CI publishes pre-seeded images to GHCR) | Out of scope for this plan but **enabled** by it. The local `docker commit` machinery is the same primitive a release pipeline would use. |
| `restic`/`kopia` for content-addressed dedup | Premature; revisit if snapshot disk usage becomes a real complaint. |
| `--mount type=image` instead of bind mounts | Requires Docker 4.40+; bake-into-image (sui binary in walrus image) is more portable and version-honest. |

---

## Architectural notes for future plugin authors

1. **State lives in container layer OR `<stackDir>/<plugin>/`. Never in named volumes.**
2. **`getStatus` checks content, not metadata.** Probe the actual state. Makes plugins compose with snapshot restore + future pre-seeded images.
3. **Cross-container coordination uses host bind mounts to `<stackDir>/<plugin>/`.** Snapshot host capture covers it for free.
4. **Cross-plugin binary dependencies are baked at build time.** Don't share via volume; bake into your own image with version-pinned build-args.
5. **Stateless plugins declare `snapshot: { commit: false, quiesce: 'none' }`.** Skip cleanly without orchestrator special-casing.
6. **Image tag is the seam where local-build, release-pull, snapshot-tag, and pre-seeded-image converge.** No new abstraction needed.

## Architectural notes for app authors

1. **Use `setup:` for app-specific Move publishes, fixture creation, initial transactions.** Don't write a `definePlugin()` wrapper for one or two actions.
2. **Use `scope: 'test-only'` for fixtures only needed in test stacks.** Keeps the `main` stack snapshot lean and the `test` stack snapshot complete.
3. **Capture object IDs you'll need later via `capture: { name: '::module::TypeName' }`.** They land in `registry.captured` and ride along in snapshots.
4. **Move source changes invalidate the snapshot ID automatically** (input hashed via `runtime/hash.ts`). No manual cache busting.
5. **Tests should lease accounts from the pool**, not faucet inline. Idempotent prefund means warm runs cost nothing.
6. **Per-test logical isolation, shared containers.** Don't try to spin up containers per test — pay container startup once per session, isolate via account leases + per-test object scoping.
