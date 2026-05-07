# Friction journal — open friction

Per `CLAUDE.md`: when something hurts (hardcoded port, copy-paste, manual step, brittle
interaction), capture it here as a one-line entry + file path. Don't silently work around the pain —
the pain is the data; this file is the input to the next round of cleanup.

Closed-out PRs that were proposed and deferred with rationale live in [deferred.md](deferred.md).
Hands-on verification tasks owed but unchecked live in [verification.md](verification.md).

---

### Public API redesign — Phases 1–10 landed (with named follow-ups)

Critical-design pass on `notes/public-api-surface.md` surfaced five recurring
issues: stringly-typed identifier graph, plugin/setup-action duplication,
subpath sprawl, convenience-tier accumulation, and action-contract leakage.
The redesign plan at `/Users/michaelhayes/.claude/plans/glittery-honking-nebula.md`
covered Phases 1–10. All phases landed across two commits:

**`d6d6f79`** — Phases 1–6, 7-focused, 8-focused, 10:

- **Phase 1** — Convenience deletions: `mintCoinDistribution`, `coinTokens`
  (public re-export), `seedSharedObject`, `selectService`/`Package`/
  `AccountMap`, `useDevstackDeployed`, `useSignAndExecute`, `Card`/`Field`,
  `Registry.ns<T>` proxy, `localnetDappKitConfig`/`localnetMvrOverrides`.
- **Phase 2** — Subpath consolidation: dropped `/vite`, `/manifest`. 14
  example/template imports migrated to `'./generated/manifest.js'`.
- **Phase 3** — `createWalletApp` moved into `/react`. `/app-setup`
  dropped. `DevstackProvider` deleted.
- **Phase 4** — `DevstackConfig.plugins + setup` → single `use:` array.
  `defineDevstackConfig` synthesizes `<app>-setup` plugin from bare
  actions. Dropped `SetupActionScope`, `Action.scope?`, `'test-only'`
  magic.
- **Phase 5** — Typed `needs:` via `Plugin<TProvides>` + `publishMove<const
  TNeeds>` phantom + `ValidateUse<TUse>` mapped-type validator. 8 of 9
  built-in plugins annotated.
- **Phase 6** — `onPublished` callback → `registerCoin` follow-on action.
- **Phase 7-focused** — `seed.liveNetworks` → `Action.networks`.
- **Phase 8-focused** — `DevstackConfig.networks` flattened. `test`
  field dropped.

**`0d0cc67`** — remaining deferred items:

- **Phase 5C** — Auto-inject `'accounts.fund'` into `needs:` for setup
  actions with `runsAs` when accounts plugin present. Six example
  configs lose the boilerplate `needs: ['accounts.fund']` lines.
- **Phase 7 — `provides.registry` shortcut removal** — top-level
  `registry: (ctx) => ...` opt dropped from every action factory;
  authors write `provides: { registry: ... }`. `mergeRegistryShortcut`
  helper deleted. Plugin callsites that relied on the auto-narrow-to-
  localnet behavior (sui, seal containerService) now call
  `requireLocalnetCtx(ctx)` explicitly.
- **Phase 7 — `appendLog` non-optional** — one-shot path provides a
  `process.stdout`-fallback default. Plugin callbacks drop the
  `??-fallback` dance.
- **Phase 8 — `frontend` committed to vite** — dropped `command:` and
  `appendPort:` opts (no consumer used them). The plugin runs
  `pnpm exec vite --port <port>`.
- **Phase 8 — walrus suiVersion / seal master keys** — both derive
  internally; opts removed.
- **Phase 9 — CLI verb cleanup** — `devstack deploy --network` folded
  into `devstack apply --network`. `applyFilter` now keeps Build on
  live nets (was `deployFilter`'s job). `devstack reset` renamed to
  `devstack wipe`. `snapshot hash` renamed to `snapshot id`.
- **Phase 10** — `notes/public-api-surface.md` rewritten against the
  post-redesign surface.

**Open follow-ups:**

- **`requireLocalnetCtx` removal** — would require `Action` to be
  generic over its run-context (`ServiceAction<TCtx>`, etc.), touching
  every plugin's `run` callback. Cleaner DX for plugin authors but
  invasive surgery; deferred until plugin-author DX is the bottleneck.
- **`walletServer` fold into `walletApp({ port, ... })`** — today
  `walletServer()` (server-side plugin) and `createWalletApp()`
  (browser-side factory) are paired but authored separately because
  they run in different processes. A clean fold isn't obvious; the
  current shape is honest. Revisit if the seam becomes a friction.
- **`imports` typed factories** — `gitImport()` and `localImport()`
  factories with discriminated `ImportSpec` narrowing. No example
  consumes `imports()` today, so the typing work has no immediate
  payoff. Restore when an example materializes.
- **DEVSTACK_POOL_* / DEVSTACK_E2E_TEARDOWN env vars** — should
  migrate to `defineDevstackPlaywrightConfig` opts. Currently
  documented but stringly-typed. Small surface; defer until a real
  CI scenario forces the issue.
- **Named coin shape** — apps still inline a `{ name; type; decimals }`
  type when they need to write to the `coin.tokens` registry kind.
  Could be exported as a public `Token` type; nobody's asked.

---

### Walrus binary distribution — upstream fixed, awaiting v1.49.0 release

Two upstream bugs blocked a pure binary-fetch path for the walrus image:

1. `walrus-deploy` (the testbed bootstrap binary) wasn't in the GitHub Release tarballs —
   only `walrus` + `walrus-node` shipped — so we had to cargo-build all three from source to
   get it. Cold first build ~9–10 min on M-series; ~1–2 min on version bumps via BuildKit
   cache mounts.
2. `walrus-devnet-v1.48.0-ubuntu-aarch64.tgz` actually contained x86_64 ELF (verified with
   `file`), so even after #1 the binary-fetch path wouldn't have worked on Apple Silicon
   (would have died under Rosetta with `failed to open elf at /lib64/ld-linux-x86-64.so.2`).

**Both fixed upstream**:

- [MystenLabs/walrus#3349](https://github.com/MystenLabs/walrus/pull/3349) — adds
  `walrus-deploy` to `binary-build-list.json`'s `release_binaries` set. Linux paths pull
  from `gs://mysten-walrus-binaries/{walrus,walrus-arm64}/<sha>/walrus-deploy` (mp3 extracts
  these from the existing `walrus-service` / `walrus-service-arm64` images); macOS builds
  cargo on the runner. Merged 2026-05-06, commit `02b34ab`.
- [MystenLabs/suiup#203](https://github.com/MystenLabs/suiup/pull/203) — registers
  walrus-deploy in suiup so end-users can `suiup install walrus-deploy`. Independent of the
  devstack's own fetch path but useful to know about. Merged 2026-05-06, commit `f99c2c0`.

The arm64 GCS prefix was confirmed to be genuine aarch64 ELF (spot-checked with
`curl -sr 0-512 gs://.../walrus-arm64/<sha>/walrus-deploy | file -`), and the
release-tarball workflow consumes that prefix — so v1.49.0+ tarballs should be correct on
all platforms.

**Status**: waiting on the next walrus release tag. Latest is `devnet-v1.48.0` from
2026-04-30. Devnet cadence over the last 8 releases is **14 days ± 2** (12–15d range), so
**devnet-v1.49.0 estimated ~2026-05-14**. Testnet typically follows ~1 week behind devnet,
mainnet ~1 week behind testnet.

**Workaround until v1.49.0 ships**: keep cargo-building all three from source.
`packages/devstack/src/plugins/walrus/upstream.Dockerfile`.

**Migration when v1.49.0 ships**:

1. In `packages/devstack/src/plugins/walrus/build.ts`, bump:
   - `WALRUS_VERSION` → `devnet-v1.49.0` (or whichever channel devstack tracks)
   - `UPSTREAM_REV` (so the upstream image cache busts; otherwise the new build is dead-cached)
   - Drop `WALRUS_RUST_TOOLCHAIN` (the binary-fetch path doesn't need it)
2. **Verify the aarch64 tarball is correct before relying on it**:
   ```sh
   curl -fsSL https://github.com/MystenLabs/walrus/releases/download/devnet-v1.49.0/walrus-devnet-v1.49.0-ubuntu-aarch64.tgz \
     | tar -xzO walrus-deploy | file -
   ```
   Expect `ELF 64-bit LSB shared object, ARM aarch64`. If it reports x86_64, the
   release-pipeline aarch64 packaging bug is still live and needs a separate ping —
   `gs://mysten-walrus-binaries/walrus-arm64/<sha>/` is correct, so the bug would be
   between GCS and the tarball.
3. Rewrite `upstream.Dockerfile` to fetch the tarball and extract all three binaries
   (mirrors the `seal` tarball-fetch shape). Drops the rust-toolchain stage, the apt-install
   of cmake/clang/libssl-dev/libpq-dev, the BuildKit cache mounts, and the `GIT_REVISION`
   plumbing for `walrus_utils::bin_version!` (binaries are version-stamped at upstream CI
   time). Cold first build drops to ~30 s.
4. Land the version bump + Dockerfile rewrite as one PR — the rewrite assumes the binary is
   in the tarball, so it's coupled to the version that ships it.
5. Remove this entry.

### Walrus aggregator daemon — verify the SDK doesn't need it

The walrus team's canonical procman testbed config exposes a separate `walrus aggregator
--bind-address 127.0.0.1:31415` daemon. We don't run one; our `WalrusClient` is configured with
storage-node URLs only (`packages/devstack/src/react/walrus.ts:24-34`). Worth confirming with the
walrus team that this is correct for browser SDK consumers, or whether the aggregator is becoming
the recommended client entrypoint. If the latter, plumb a `walrus.aggregator` Service action +
expose `aggregatorUrl` in the manifest's services registry.

### Per-action log files (procman-style)

`appendLog` currently routes per-action stdout/stderr through the supervisor's status renderer to
the terminal only (`packages/devstack/src/runtime/renderers/plain.ts:134-141`). Procman writes
each process's output to `<log_dir>/<name>.log` plus a combined `procman.log`, so post-run
debugging can `cat logs/procman/walrus.build.log` instead of scrolling history. Worth borrowing —
write each action's lines to `<stackDir>/.devstack/logs/<action>.log` as `appendLog` fires. Cheap
to add; helps "why did the build fail two days ago?" investigations.

### `useCurrentClient()` loses `.core` typing across module-augmentation boundary

`@mysten/dapp-kit-react`'s `useCurrentClient<TDAppKit extends DAppKit<any>>()` resolves `TDAppKit`
from the `Register['dAppKit']` augmentation. When the augmentation references a `dAppKit` whose type
comes from another package (e.g. `createWalletApp({manifest})` in
`@mysten-incubation/devstack-app-setup`), the immediate hover type of `useCurrentClient()` correctly
resolves to `SuiGrpcClient`, but `c.core` widens to `any`. With an explicit annotation
`const c: SuiGrpcClient = useCurrentClient()`, `c.core` correctly resolves to `GrpcCoreClient`.
Reproduced on TS 5.9.3 with both `module: "NodeNext"` and `module: "Bundler"`.

**Workaround in app code**: explicitly annotate `const client: SuiGrpcClient = useCurrentClient()`
whenever the caller dereferences a parametric-`Include` method (`getObject`, `listOwnedObjects`,
etc.) and depends on the response shape flowing through. Single-call patterns like
`client.core.getBalance(...)` work unannotated because TS resolves the call site directly without
needing `.core`'s nominal shape. The augmentation site is now
`@mysten-incubation/devstack/app-setup` (the subpath export in this repo); when it lived in the
external `@mysten-incubation/devstack-app-setup` package the same workaround applied.

**Fix shape**: probably an upstream TS resolver edge case around `ReturnType<TDAppKit['getClient']>`
when `TDAppKit` is a re-imported type alias. Worth a minimal repro + bug report to TypeScript or
dapp-kit if it's stable across newer TS versions.

### Walrus 1.48.0 storage nodes panic on TLS startup

Walrus-node 1.48.0 starts cleanly, opens RocksDB, binds REST API on `10.<octet>.0.10:9185`, then
panics in `axum-server-0.8.0/src/tls_rustls/mod.rs:204:14` (`JoinError::Cancelled`). Pre-existing
upstream issue; only `private-content` end-to-end blob upload is affected (Seal works without walrus
storage nodes; the upload path needs them). Other walrus-using flows are blocked.

**Fix shape (deferred — no upstream fix in flight)**: `MystenLabs/walrus@main` HEAD (5/01) has no
axum/TLS/panic-related commits in the last ~100; the v1.49.0 bump is just a version string.
Speculative `WALRUS_REV` bump would risk a 10-minute rebuild for no fix. Re-evaluate on next walrus
release tag, or report upstream with the `JoinError::Cancelled(Id(349))` stack trace + this localnet
repro:

```bash
cd examples/private-content && pnpm devstack apply
docker logs private-content-main-walrus-node-0 | grep tls_rustls
```

Workaround: the only consumer is `private-content`'s blob-upload e2e. Other walrus-using flows
(read-only, KeyServer registration, deploy outputs) work fine.

### inotify watch-cap on Linux >8192 files

The file-watcher behind `devstack up`'s source-watching silently fails on large monorepos when the
kernel's `fs.inotify.max_user_watches` is below the file count it needs to register. No error
surfaced — the watcher just doesn't fire on the affected paths.

**Fix shape**: detect the cap at `up` start (`/proc/sys/fs/inotify/max_user_watches`) and either
bump it via `sysctl` (root only) or print an actionable warning that names the sysctl line. macOS's
analogous limit (`kern.maxfiles`) hits a different failure mode and probably needs its own probe.

### Snapshot bundle non-atomicity

`devstack snapshot save` writes the host bundle in two steps: `<stackDir>/host/` is recursively
copied, then `snapshot.json` is written atomically. Both steps are individually atomic but not
jointly — a `kill -9` between them leaves a half-formed bundle (host dir present, manifest absent)
that `restore` mis-handles silently.

**Fix shape**: stage the whole bundle to a sibling tmp dir, then `renameSync` once. Cost is one
extra dir copy per snapshot; benefit is crash-safety.

### Live-net seed snapshot (forking real-network state)

There's no analog to Hardhat's `--fork-url` for seeding a localnet from a live testnet/mainnet
snapshot. Apps that want to develop against realistic on-chain state (object graphs, package
dependencies, account balances) have to hand-replicate it via `setup:` actions.

**Fix shape**: a `--fork-network testnet --fork-checkpoint <n>` flag on `devstack up` that pulls a
checkpoint snapshot, applies it to the localnet's genesis, and registers the fetched state in the
manifest. Big feature; deferred until someone needs it.

### Plugin source-hash not in snapshot id

The snapshot id derives from each plugin's declared `inputs:` map. If a plugin author edits the
plugin's implementation without bumping `inputs`, the snapshot id stays the same and a stale
snapshot restores against new plugin code — leaking subtle state-shape mismatches.

**Fix shape**: fold a digest of the plugin's source dir into the snapshot id alongside `inputs:`.
For workspace plugins, walk the package's `files:` set; for npm-installed plugins, use the
lockfile-resolved version.

### HostProcess pause/resume during snapshot quiesce

Snapshot quiesce currently pauses container-backed Service actions but HostProcess actions
(long-running in-process children — vite dev server, deepbook market-maker) keep running through the
quiesce window. They mostly survive because their state is in memory, but a HostProcess that holds a
file lock or a chain transaction in flight can race the snapshot capture.

**Fix shape**: extend the snapshot quiesce protocol to call a plugin-provided `pause()` hook on each
HostProcess action. Plugins implement it idempotently.

### Multi-instance plugin support (`imports() ×2`)

Two `imports()` calls in one config (e.g. one for vendor packages, one for org packages) collide on
action expansion — both produce `imports.<package>` action names that clash in the topo sorter.

**Fix shape**: namespace plugin instances when two of the same plugin appear
(`imports[0].<package>`, `imports[1].<package>`), or accept an explicit `instanceId:` parameter.

### Bearer token leak through manifest baked into bundle

`wallet-server`'s bearer token lives in the manifest, which Vite bakes into the production bundle. A
devstack-deployed dev build that's then hosted on a public URL would expose the token. Today this is
mitigated because devstack is dev-only — the bundle isn't supposed to leave the laptop — but the
failure mode is silent.

**Fix shape**: per-session tokens minted by the wallet-server on each listener start, written to
`<stackDir>` instead of the manifest. The frontend reads from a local file (Vite virtual module) at
dev time, errors out at build time. Long-term work; depends on a "production-mode" flag on the
manifest.
