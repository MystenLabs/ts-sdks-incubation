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
