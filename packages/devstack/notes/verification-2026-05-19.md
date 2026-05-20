# Lifecycle + parallel-stack verification — 2026-05-19

## Setup
- HEAD: `e68ffa35` (`fix(devstack/cli): rewire doctor/checks-locks import after E51 lock extraction`)
- Worktree: `.claude/worktrees/agent-a2c2298d292de5b8f`
- Docker server: `29.4.0`
- Examples used:
  - `examples/arena` — all three scenarios. Picked over `examples/wallet` for parallel-stack because arena's stack-acquire path is the same engine code (port-allocator + supervisor + per-stack state dir) and is ~5x faster (~25s ready vs ~3-5min for wallet which also publishes deepbook + runs a market maker). Arena exercises the same per-stack hostname/port machinery that wallet uses.
- Build/install steps before testing:
  - `pnpm install` (fixed dangling bin symlinks for `devstack` + `dev-wallet`)
  - `pnpm --filter @mysten-incubation/devstack --filter @mysten-incubation/dev-wallet build`
  - `pnpm install` again so `node_modules/.bin/devstack` resolves
- All invocations used the built CLI directly: `node ../../packages/devstack/dist/cli/main.mjs <subcommand>`.

## Scenario A: stack start / stop / resume

### Commands
```bash
cd examples/arena
DEVSTACK_STACK=verify-a node ../../packages/devstack/dist/cli/main.mjs up   # bg
# wait for "frontend.dev-server  acquiring → ready"
curl -s http://verify-a.dev.arena.localhost:5175/                           # 200
curl -X POST ... http://verify-a.sui.arena.localhost:9000/                  # chainId=702343dd
kill -INT <node-pid>                                                         # SIGINT
# wait for "Shutting down. Sui and other background services stay warm..."
DEVSTACK_STACK=verify-a node ../../packages/devstack/dist/cli/main.mjs up   # restart
```

### Observed
- Initial cold boot 17:58:52 → 17:59:25 (~33s). All services reached `ready`, frontend HTTP 200.
- During first boot, the engine self-restarted once (`[17:59:09] file change at build (kind=add, hash failed) — unowned watch path — restarting`) triggered by `sui move build` writing into `move/connect_four/build/` and `move/connect_four/build/.../package_summaries/`. Arena's `devstack.config.ts` disables `hotRestart` only under `PLAYWRIGHT=1`; in interactive `dev` runs the hot-restart fires once on first boot, then settles. Second pass had cache hits everywhere and reached ready in ~12s.
- On SIGINT, the supervisor printed:
  - `@devstack/SuiTag  ready → stopping`
  - `@devstack/SuiTag  stopping → stopped`
  - `Shutting down. Sui and other background services stay warm for a fast next start.`
  - Containers transitioned to `Exited (143)` (SIGTERM) and `Exited (0)` cleanly.
- On restart, the supervisor logged `INFO devstack: resuming stopped container 'arena-verify-a-sui-indexer-db'` / `'arena-verify-a-sui-localnet'` (i.e. `docker start`, not recreate). Reached ready in ~10s. Chain identifier preserved (`702343dd`). All `publishMove`/`Action` blocks logged `cache hit` against the same packageId from the first run.

### Result
PASS

### Notes
- The zsh wrapper around `node ../../packages/devstack/...` does not forward SIGINT to the child by default — sending `kill -INT` to the wrapper pid leaves node alive. Sending SIGINT directly to the node child pid triggers clean shutdown. This is a shell-invocation property, not a devstack issue, but worth knowing for terminal users: a real interactive `pnpm dev` shell sees the child as foreground process group and Ctrl-C works as expected.
- One observed inconsistency in process exit code: the first SIGINT-during-mid-acquire run exited 1, while SIGINTs after the stack had settled exited 0. Not a real bug (engine still cleaned up its containers), but the exit-code semantics on signal aren't quite uniform.

## Scenario B: snapshot save / wipe / restore

### Commands
```bash
# stack-a still running from scenario A — chain id 702343dd, connect_four 0xb88774...
DEVSTACK_STACK=verify-a node ../../packages/devstack/dist/cli/main.mjs snapshot save --label pre-wipe
# stop stack
kill -INT <node-pid>
DEVSTACK_STACK=verify-a node ../../packages/devstack/dist/cli/main.mjs wipe --yes
DEVSTACK_STACK=verify-a node ../../packages/devstack/dist/cli/main.mjs snapshot restore pre-wipe
DEVSTACK_STACK=verify-a node ../../packages/devstack/dist/cli/main.mjs up
```

### Observed
- `snapshot save --label pre-wipe`:
  - Output: `saved snapshot 20260520T010100-bc14-pre-wipe → .devstack/snapshots/20260520T010100-bc14-pre-wipe`
  - Wrote `runtime.tar` + 2 container tars (sui-localnet + sui-indexer-db).
- `wipe --yes`: `stopped 2 containers, removed 1 network, removed 0 volumes, removed 1 state file, cleared 2 stale move-git locks.` After wipe `docker ps -a --filter label=devstack.stack=verify-a` was empty, `.devstack/stacks/` empty, `.devstack/snapshots/` still contained `20260520T010100-bc14-pre-wipe` (expected — wipe preserves snapshots).
- `snapshot restore pre-wipe` (no `--yes` flag — restore doesn't have/need one): `restored snapshot 20260520T010100-bc14-pre-wipe into stack 'verify-a'. runtime/ extracted. loaded images: devstack-snap:...`. State.json + runtime/ + container images all restored.
- Post-restore `up` reached ready in ~16s. Containers came up from the canonical `devstack-sui.image:53a7e...` (the snap images were loaded but the supervisor selected the canonical image — this is correct: chain identity lives in the restored volume / runtime dir, not the image).
- Chain identifier after restore: `702343dd` (identical to pre-snapshot).
- `publishMove(connect_four): cache hit` against the same packageId `0xb88774...` from pre-wipe (proves state.json was restored intact).

### Result
PASS

### Notes
- `snapshot restore` does not accept `--yes` (other destructive commands do). Inconsistency between `wipe`, `snapshot delete`, and `snapshot restore` — see Opportunities below.
- The previously-loaded snapshot images sit in the local docker image store unused, taking ~700MB. The engine doesn't garbage-collect them on next `up` since they're not the active image. Worth a doctor warning eventually.

## Scenario C: parallel stacks

### Commands
```bash
# both stacks in fresh state
cd examples/arena
DEVSTACK_STACK=verify-a node ../../packages/devstack/dist/cli/main.mjs up   # bg
# wait until ready
DEVSTACK_STACK=verify-b node ../../packages/devstack/dist/cli/main.mjs up   # bg
# wait until ready

# verify
curl http://verify-a.dev.arena.localhost:5175/   # 200
curl http://verify-b.dev.arena.localhost:5175/   # 200
# capture distinct packageIds from each stack's manifest.json

# stop both
kill -INT <pid-a> <pid-b>
# wait for clean shutdown of both

# restart both
DEVSTACK_STACK=verify-a node ../../packages/devstack/dist/cli/main.mjs up   # bg
DEVSTACK_STACK=verify-b node ../../packages/devstack/dist/cli/main.mjs up   # bg
# wait until both ready, confirm same packageIds preserved

# clean up
kill -INT <pid-a> <pid-b>
DEVSTACK_STACK=verify-a node ../../packages/devstack/dist/cli/main.mjs wipe --yes
DEVSTACK_STACK=verify-b node ../../packages/devstack/dist/cli/main.mjs wipe --yes
```

### Observed
- Stack A came up at 18:04:54, ready 18:05:10 (~16s).
- Stack B started at 18:05:32 (while A was running), ready 18:05:49 (~17s). No `EADDRINUSE`, no port-allocator errors.
- Both stacks bound distinct host ports:
  - Stack A wallet-app on `127.0.0.1:5180`, stack B on `127.0.0.1:5181` (port-allocator scanned forward).
  - Stack A vite host listener on `*:5176`, stack B vite on `127.0.0.1:5181`-ish (managed via traefik subdomain routing — see below).
  - Shared traefik proxy on `127.0.0.1:5175` — both stacks reach their frontends via subdomain routing (`verify-a.dev.arena.localhost:5175` vs `verify-b.dev.arena.localhost:5175`). The 5175 listener is co-owned by the shared dev-wallet pair-flow router; per-stack vite/wallet-app processes run on distinct host ports.
- Both manifests show distinct `services.sui.rpc.url` (`verify-a.sui...` vs `verify-b.sui...`), distinct `accounts.*.address`, distinct `packages.connect_four.id`.
- Sample packageIds:
  - verify-a: `0x3e666e733c9feeee6f16035264d6236ff8bba376ba609bf80beba910679f1da4`
  - verify-b: `0xbd2525750cbec4fdfc8fc39da2ca4481532145b89d89d8ba3f35f511737cda5b`
- Stop + restart: both `kill -INT` succeeded cleanly (exit code 0 for both since they were idle). Restart took ~12s each, both logged `cache hit` against the original packageIds (`0x3e666...` and `0xbd2525...`). Port-reuse worked: same hostnames + same shared `:5175` traefik port + same per-stack 5180/5181 wallet-app ports.

### Result
PASS

## Real bugs found
None during these scenarios. The behavior is consistent with the design notes in `packages/devstack/notes/STATE-2026-05-19.md`.

Minor surface inconsistencies (not fixed — out of scope for verification, see Opportunities):

1. **`snapshot restore` doesn't accept `--yes`** while `wipe` and `snapshot delete` require it. `snapshot restore` is destructive (overwrites `state.json` + `runtime/` + reloads images); the asymmetry is surprising for scripting. (`packages/devstack/src/cli/commands/snapshot.ts:1` — restore command flag set.)
2. **Exit code on SIGINT** is sometimes 1, sometimes 0, depending on whether the supervisor was mid-acquire when the signal landed. Not a regression — Effect catches the supervisor's reservation cancellation as a failure and bubbles a non-zero exit. Worth normalizing to 130 (SIGINT default) or 0 (graceful) for shell pipeline ergonomics.
3. **Hot-restart on first boot of arena**: `sui move build`'s output dir (`move/connect_four/build/`) triggers the file watcher as an "unowned watch path" and causes one self-restart. Already explicitly disabled under PLAYWRIGHT=1 in `examples/arena/devstack.config.ts:68`; the doc comment notes the workaround. Could be hardened by adding `**/build/`, `**/package_summaries/`, `**/.move-*` to the watcher's default ignore list — would smooth the dev experience.

## Real fixes landed (commits)
None. No code edits this session.

## Opportunities noticed
- **Snapshot/wipe/restore flag uniformity**: standardize the `--yes` requirement and confirmation prompting across all destructive commands. Currently `wipe` requires `--yes` on non-TTY, `snapshot delete` requires `--yes` on non-TTY, `snapshot restore` accepts neither (just acts). Consider: every destructive command gates on `--yes` outside a TTY.
- **Stale snap-image GC**: `snapshot restore` `docker load`s the per-snapshot images (`devstack-snap:<id>-<svc>`), but the supervisor uses the canonical image. Those loaded images then sit around forever (each ~700MB for sui-localnet). Add a `devstack snapshot prune` or fold into existing `prune` to clean `devstack-snap:*` tags with no on-disk snapshot dir.
- **SIGINT/exit-code semantics**: normalize the supervisor's signal teardown to a single `exit(0)` (graceful) or `exit(130)` (SIGINT convention). The current "sometimes 1, sometimes 0" depends on whether any service was mid-acquire when the signal landed, which is a leaky abstraction.
- **First-boot hot-restart on arena**: the file watcher trips on `move/<pkg>/build/` and `package_summaries/` (sui move's own outputs). The example's config opt-outs of hot-restart under playwright; the underlying watcher could blanket-ignore Move build outputs so other examples don't have to opt out manually.
- **Wallet example unverified for parallel-stack** specifically: the deepbook + market-maker flow has more moving parts (`DeepbookMarketMaker` opens an Effect.fiber, listens on chain). If parallel-stack ever does break, wallet's the more likely victim. Worth adding a CI smoke for `DEVSTACK_STACK=a/b examples/wallet` in a follow-up.
- **CLI directory pollution**: `pnpm install` had to be run twice (first to populate `node_modules/`, then again after `pnpm --filter ... build` to fix bin symlinks). The `package.json#bin` declarations point at `dist/cli/main.mjs` which doesn't exist before the first build, so pnpm logs `WARN  Failed to create bin` for every consumer. Either (a) ship a prebuilt `dist/` in the checkout (no — bad), (b) declare a `prepare` script that runs `tsdown` before installs (heavy but standard), or (c) document the two-step install. Currently undocumented.

## Scenario D: wallet parallel stacks (added 2026-05-19)

- Setup: examples/wallet, two stacks (verify-a, verify-b), HEAD `a91c30ab`
- Worktree: `.claude/worktrees/agent-a7945e34a5d0dcba9`
- Build steps:
  - `pnpm install` (twice — bin-symlink chicken-and-egg, same as Scenario A)
  - `pnpm --filter @mysten-incubation/devstack --filter @mysten-incubation/dev-wallet build`
- Invocation: `node ../../packages/devstack/dist/cli/main.mjs apply` from `examples/wallet/`
- Wallet exercises deepbook publish (~6k LoC vendored Move package) + an in-process market maker on top of two mock-coin publishes, two seedTokens transactions, and two pool creates.

### Commands run

```bash
# Cold-boot, both stacks in parallel
DEVSTACK_STACK=verify-a node .../main.mjs apply > /tmp/wallet-verify-a-apply.log &
DEVSTACK_STACK=verify-b node .../main.mjs apply > /tmp/wallet-verify-b-apply.log &
# wait
# Stack-a apply ok, stack-b apply FAILED (exit 137 mid-`sui move build` of deepbook).

# Stack-b retry (alone) — succeeded
DEVSTACK_STACK=verify-b node .../main.mjs apply

# Restart both stacks sequentially (to verify cache hits)
DEVSTACK_STACK=verify-a node .../main.mjs apply  # FAILED on cache verify
# (didn't reach stack-b restart)

# Cleanup
DEVSTACK_STACK=verify-a node .../main.mjs wipe --yes
DEVSTACK_STACK=verify-b node .../main.mjs wipe --yes
```

### Per-stack port allocation (verified PASS)

Wallet `apply` brings up `sui-localnet` + `sui-indexer-db` only (deepbook server/indexer are reserved for tests; the example config doesn't include `DeepbookServer`/`DeepbookIndexer`). Per-stack hostnames in manifest.json are distinct:

- Stack A sui RPC: `http://verify-a.sui.wallet.localhost:9000`
- Stack B sui RPC: `http://verify-b.sui.wallet.localhost:9000`
- Stack A faucet: `http://verify-a.faucet.wallet.localhost:9123`
- Stack B faucet: `http://verify-b.faucet.wallet.localhost:9123`
- Stack A indexer-db: `postgres://sui:sui@sui-indexer-db:5432/sui_indexer`
- Stack B indexer-db: `postgres://sui:sui@sui-indexer-db:5432/sui_indexer`

Both share traefik on `:9000` / `:9123` / `:9125` and route by per-stack subdomain. No `EADDRINUSE` observed. ✅ PASS

Containers (devstack-labelled) listed during apply only; `apply` is one-shot and tears down containers on exit. Inspected mid-flight via `docker ps`: stack-a and stack-b each had their own `wallet-verify-a-sui-localnet` / `wallet-verify-a-sui-indexer-db` and `wallet-verify-b-*` containers respectively.

### Per-stack packageIds (verified PASS — all distinct)

```
=== Stack-A packageIds ===
mock_usdc:        0xedc13ccfc87adc41361fe0e665c9474c328bf766641c3f3cacee13e73024a0d4
mock_weth:        0x0835858553f2af35aec2fa64e37866b6a1d9ea60a0455c2fec7a4b960677ec5d
deepbook.publish: 0x6a4bbea15f65254bf69eb406b52de9eb125da591abe2f947a61179527eb2ae67
deepbook:         0x6a4bbea15f65254bf69eb406b52de9eb125da591abe2f947a61179527eb2ae67

=== Stack-B packageIds ===
mock_weth:        0xefe56631909fd769a52c6fdae2476e9668272abeaaa71aaec779eae3a1d505ca
mock_usdc:        0x062a7e085c4abf692aeac2189146d4226eb47f75e1523e6b03b00dcf4e1668d6
deepbook.publish: 0x8d5b17447fa034615f5d9f78747dfce9447722bd1048948ae2e90843bcaf9021
deepbook:         0x8d5b17447fa034615f5d9f78747dfce9447722bd1048948ae2e90843bcaf9021
```

Two chainIds (`BVRDmWfXVsXjErSx9NesaLRuoakuy9gFSDEr3au8sf3r` vs `AwduwqZrqzmKEHqXCmwCr7nchxy6PFdernA2WcGwHvF6`), distinct deepbook registries, distinct pool ids, distinct accounts.

### Per-stack state dirs (verified PASS)

```
.devstack/stacks/verify-a/state.json
.devstack/stacks/verify-a/manifest.json
.devstack/stacks/verify-b/state.json
.devstack/stacks/verify-b/manifest.json
```

Two independent state trees, both load-bearing data isolated. ✅ PASS

### Restart cache-hit log lines

Restart could NOT be verified end-to-end because the cache-verify path for `deepbookLocalDeploy` throws `TypeError: cached.pools.map is not a function` on resume (see Bug #2 below). Partial cache hits that did fire during the restart attempt:

```
[18:41:57.877] publishMove(mock_usdc): cache hit
[18:41:57.878] publishMove(mock_weth): cache hit
[18:41:57.883] Action(wallet.seedTokens): cache hit
[18:41:57.908] publishMove(deepbook.publish): cache hit
                                          ↑ then crashed in deepbookLocalDeploy verify
```

So the foundational caches (publish + Action) DO resume correctly; the deepbook-specific composite is broken.

### Result: ❌ FAIL — two real bugs

1. **Cross-stack `docker rm -f` race on apply teardown** (Scenario D, parallel)
2. **deepbookLocalDeploy cache-verify TypeError on resume** (Scenario D, restart — but reproduces single-stack too)

---

### Real bugs found

#### Bug 1: cross-stack SuiBuildContainer race kills mid-build peer (exit 137)

**Symptom:** With two `apply` invocations against the same app + different stacks running concurrently, whichever stack finishes first runs `docker rm -f devstack-<app>-build` in its layer scope teardown, which SIGKILLs any `docker exec sui move build` still running for the other stack's deepbook publish. Surfaces as `sui move build exited 137`. Reliably reproducible on cold-cache wallet because deepbook's build takes ~5s and the two stacks' applies finish only seconds apart.

**Mechanism:**

`packages/devstack/src/engine/sui-build-container.ts:119` defines:
```ts
export const containerNameFor = (identity: { app: string; stack?: string }): string =>
    `devstack-${identity.app}-build`;
```

The comment immediately above acknowledges the design intent: the build container is shared across stacks of the same app to maximize `~/.move` cache reuse + container warmth. `withMoveBuildLock` (`engine/move-build-lock.ts`) serializes the `docker exec` calls cross-process so they don't race for `~/.move/git/`'s git locks.

But `SuiBuildContainerLive` (`engine/sui-build-container.ts:355-392`) registers a `dockerRm` finalizer:
```ts
yield* Scope.addFinalizer(cleanupScope, dockerRm(spawner, containerName));
```

Where `dockerRm` is `docker rm -f <containerName>`. When stack-a's scope closes (apply exits), it `docker rm -f devstack-wallet-build` — but stack-b is still mid-`docker exec` against that same container. `-f` (force) kills the running container, taking the exec's child process with it, exit 137.

**Impact:** parallel `apply`/`up` against two stacks of the same app is unreliable. Whichever stack apply-completes first wins; the other one fails with a confusing 137 (apparent OOM). Single-stack workflows are unaffected.

**Fix shape (NOT applied — bigger than one-line):**

Either (a) shard the container name by stack (gives up the cross-stack cache reuse the comment defends), (b) refcount the container via a cross-process file-lock so the finalizer only `docker rm`s when no other devstack process is using it, or (c) drop `-f`: a `docker rm` (no force) refuses to delete a container with running execs, surfacing the contention as a warning instead of silently killing the peer. (c) is the smallest change but lets the container leak across hard-killed peers; (b) matches the spirit of the move-build-lock primitive.

#### Bug 2: deepbookLocalDeploy cache-verify TypeError on resume

**Symptom:** Single-stack OR multi-stack — any wallet (or other deepbookLocalDeploy-using) apply that follows a previous successful apply crashes with:
```
TypeError: cached.pools.map is not a function
    at Object.verify (.../local-deploy.mjs:140:71)
    at Object.verify (.../on-chain-artifact.mjs:41:29)
    at Array.<anonymous> (.../cache.mjs:40:32)
```

The persisted state.json under `deepbook/pools/<chainId>/<hash>` has `pools` as an OBJECT keyed by pool name (`{sui_usdc: {...}, sui_weth: {...}}`), but `verify` expects `pools: ReadonlyArray<CachedDeepbookPool>` and calls `.map(...)`.

**Mechanism:**

- `deepbookLocalDeploy.produce` returns `{pools: Array<CachedDeepbookPool>, ...}` (`services/deepbook/local-deploy.ts:592-599`).
- `withCache` (`engine/cache.ts:155`) calls `state.put(key, fresh)`. The first `put` persist runs JSON.stringify against the array form — disk OK at this moment.
- `onChainArtifact` then runs `spec.register({value: fresh, deps})` (`engine/on-chain-artifact.ts:253-255`).
- `deepbookLocalDeploy.register` (`local-deploy.ts:638-649`) MUTATES the cached value in-place: `rich.pools = poolsRecord` where `poolsRecord` is `Record<name, DeepbookPool>` (object form). The comment explicitly says this is by design: "we mutate in place because the substrate returns `value` after `register` runs (per `onChainArtifact`'s contract), so this is the single point where the cache-hit and cache-miss paths converge on the same observable shape".
- `state-store.ts:516-519`: `put` stores the SAME reference in the in-memory Map, then runs `persistAndWarn`. Subsequent `put` calls (from publishMove of other deps, balance-manager creates, etc.) trigger `persistAndWarn` which re-serializes the WHOLE map. By that point the mutated record-form `pools` is what JSON sees.
- On resume, `state.get<CachedDeepbookPools>` returns the record-form `pools`. `verify`'s `cached.pools.map(...)` blows up.

**Impact:** wallet cannot resume from cache. Every restart triggers a TypeError, which currently exits with an uncaught throw (no graceful recovery to "treat as cache miss"). Same for any other primitive that uses `onChainArtifact` + mutates the cached value in `register`.

**Fix shape (NOT applied — bigger than one-line):**

Options ordered by blast radius:
- **(local fix)** Change `deepbookLocalDeploy.register` to attach `poolsRecord`/`poolIds`/`findPool`/`packageIds` under DIFFERENT keys on the rich shape (e.g. `value.poolsRecord = ...` instead of overwriting `value.pools`). Update downstream consumers (`coreLayer`/`marketMakerLayer`/`tickPool` closures) + tests to read the new keys. Cached `pools` stays an array; downstream reads the derived record. ~50 LoC change + test churn.
- **(substrate fix)** Have `state-store.put` deep-clone the value (JSON-roundtrip via the bigint codec) so caller mutations after `put` don't bleed into the persisted map. Single point of containment, simpler than the local fix, but touches the substrate every primitive relies on. Worth doing.
- **(API-contract fix)** Change `onChainArtifact`'s `register` signature to RETURN the rich-shape value rather than mutate. Cleaner but ripples through every consumer of `onChainArtifact`.

### Cleanup

- `DEVSTACK_STACK=verify-a wipe --yes` — stopped 2 containers, removed 1 network, 0 volumes, 1 state file, cleared 2 stale move-git locks.
- `DEVSTACK_STACK=verify-b wipe --yes` — stopped 2 containers, removed 1 network, 0 volumes, 1 state file.
- `docker ps -a --filter label=devstack` empty after wipe.
- `.devstack/stacks/` empty after wipe.

### Real fixes landed (commits)

None — both bugs are bigger than a one-line fix and are documented above for a follow-up.

### Opportunities noticed

- **Cross-stack lifecycle primitives need a refcount, not just a lock.** `withMoveBuildLock` correctly serializes the EXEC across stacks, but the CONTAINER lifecycle (the `dockerRm` finalizer) is per-stack. Same pattern probably exists wherever the build/wiring layer shares state across stacks; audit `sui-fork`'s registry, the codegen overlay, any other "warm" container/dir.
- **`state-store.put` should snapshot the value.** Callers shouldn't have to know that mutating a value they handed to `put` will bleed into future persists. A JSON-roundtrip clone (using the existing `jsonBigintReplacer`/`jsonBigintReviver`) inside `put` would containment-fix Bug 2 + protect every other primitive that uses `register` to attach derived fields.
- **`onChainArtifact.register` shouldn't be defined as a mutation point.** The current contract ("mutate the resolved value in-place; whatever you write becomes downstream's view") rewards exactly the bug pattern we hit. Consider changing the signature to `register: (...) => Effect<Rich, ...>` so the substrate handles the merge.
- **`apply` exit-code on parallel teardown race**: stack-b's failure should attribute `137` to "killed by peer container teardown" not generic `SuiCliError`. The error envelope already has `exitCode`; a follow-up could detect `137` from inside-container exec + add a hint about Bug 1.
- **Wallet resume isn't tested by CI** — the failure surfaced first on Scenario D restart because Scenario A/B/C tested arena (no deepbook). A vitest-or-playwright e2e that does `apply → wipe runtime/ but not state.json → apply` against wallet would have caught Bug 2 weeks ago. Worth adding as a fast smoke (wallet `apply` is ~30s warm, fits CI envelope).
- **Cross-stack apply hangs the worse stack on `docker rm -f`** because the wait loop doesn't surface "your build container is being killed by a peer" — the failure manifests as an `exited 137` deep in `sui move build`'s output, three layers down. Worth detecting "our container vanished mid-exec" and emitting a typed error.
