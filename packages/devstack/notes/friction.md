# Friction journal — open friction

Per `CLAUDE.md`: when something hurts (hardcoded port, copy-paste, manual step, brittle
interaction), capture it here as a one-line entry + file path. Don't silently work around the pain —
the pain is the data; this file is the input to the next round of cleanup.

Closed-out PRs that were proposed and deferred with rationale live in [deferred.md](deferred.md).
Hands-on verification tasks owed but unchecked live in [verification.md](verification.md).

---

### Walrus release tarballs — `ubuntu-aarch64` is misnamed (contains x86_64)

`walrus-devnet-v1.48.0-ubuntu-aarch64.tgz` from the walrus GitHub release contains x86_64 ELF
binaries (verified with `file`), not aarch64 — same content as `ubuntu-x86_64.tgz`. On Apple
Silicon hosts the binaries fail to exec under Rosetta with `failed to open elf at
/lib64/ld-linux-x86-64.so.2`. Blocks the obvious "binary fetch instead of cargo compile" win
on arm64 hosts; on x86_64 it works fine.

**Workaround**: `packages/devstack/src/plugins/walrus/upstream.Dockerfile` cargo-builds all three
runtime binaries (`walrus`, `walrus-node`, `walrus-deploy`) from source. Marginal extra time
vs. building walrus-deploy alone since the workspace deps were already loading. Cold first
build: ~9–10 min on M-series. Subsequent version bumps: ~1–2 min via BuildKit cache mounts
(`/usr/local/cargo/{registry,git}` + `/walrus/target`).

**Fix shape**: file with walrus team to (a) fix the aarch64 release artifact and (b) ship
`walrus-deploy-<platform>` alongside the other binaries (the testbed bootstrap binary isn't
in any release today — also blocking a pure binary path). When both are fixed, the upstream
build collapses to a tarball-fetch like seal (~30 s).

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
needing `.core`'s nominal shape.

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

### Cross-host snapshot port collisions on `--push`

`devstack snapshot save --push <registry>` tags the seed images with names that include the
host-allocated ports (e.g. `walrus-node-0:port-31010`). Restoring the bundle on a host that
allocated a different port pool means the tags don't match what `restore` expects.

**Fix shape**: drop port-derived tag suffixes; key purely on the snapshot content hash. Ports are
runtime concerns and shouldn't leak into image identity.

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
