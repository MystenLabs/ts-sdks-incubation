# Friction journal — what's left

Per `CLAUDE.md`: when something hurts (hardcoded port, copy-paste, manual
step, brittle interaction), capture it here as a one-line entry + file
path. Don't silently work around the pain — the pain is the data; this
file is the input to the next round of cleanup.

This is the **what's-left log**: open friction we haven't fixed yet,
deferred PRs from prior rounds, plus verification work that's owed but
hasn't been hands-on-checked. Closed entries live in
[archive/friction-closed.md](archive/friction-closed.md). Closed plan
documents live in [archive/](archive/).

---

## Open friction

### `useCurrentClient()` loses `.core` typing across module-augmentation boundary

`@mysten/dapp-kit-react`'s `useCurrentClient<TDAppKit extends DAppKit<any>>()`
resolves `TDAppKit` from the `Register['dAppKit']` augmentation. When the
augmentation references a `dAppKit` whose type comes from another package
(e.g. `createWalletApp({manifest})` in `@mysten-incubation/devstack-app-setup`),
the immediate hover type of `useCurrentClient()` correctly resolves to
`SuiGrpcClient`, but `c.core` widens to `any`. With an explicit annotation
`const c: SuiGrpcClient = useCurrentClient()`, `c.core` correctly resolves
to `GrpcCoreClient`. Reproduced on TS 5.9.3 with both `module: "NodeNext"`
and `module: "Bundler"`.

**Workaround in app code**: explicitly annotate `const client: SuiGrpcClient = useCurrentClient()`
whenever the caller dereferences a parametric-`Include` method (`getObject`,
`listOwnedObjects`, etc.) and depends on the response shape flowing
through. Single-call patterns like `client.core.getBalance(...)` work
unannotated because TS resolves the call site directly without needing
`.core`'s nominal shape.

**Fix shape**: probably an upstream TS resolver edge case around
`ReturnType<TDAppKit['getClient']>` when `TDAppKit` is a re-imported type
alias. Worth a minimal repro + bug report to TypeScript or dapp-kit if
it's stable across newer TS versions.

### Walrus 1.48.0 storage nodes panic on TLS startup

Walrus-node 1.48.0 starts cleanly, opens RocksDB, binds REST API on
`10.<octet>.0.10:9185`, then panics in
`axum-server-0.8.0/src/tls_rustls/mod.rs:204:14` (`JoinError::Cancelled`).
Pre-existing upstream issue; only `private-content` end-to-end blob upload
is affected (Seal works without walrus storage nodes; the upload path
needs them). Other walrus-using flows are blocked.

**Fix shape (deferred — no upstream fix in flight)**: `MystenLabs/walrus@main`
HEAD (5/01) has no axum/TLS/panic-related commits in the last ~100; the
v1.49.0 bump is just a version string. Speculative `WALRUS_REV` bump would
risk a 10-minute rebuild for no fix. Re-evaluate on next walrus release
tag, or report upstream with the `JoinError::Cancelled(Id(349))` stack
trace + this localnet repro:

```bash
cd examples/private-content && pnpm devstack apply
docker logs private-content-main-walrus-node-0 | grep tls_rustls
```

Workaround: the only consumer is `private-content`'s blob-upload e2e.
Other walrus-using flows (read-only, KeyServer registration, deploy
outputs) work fine.

### inotify watch-cap on Linux >8192 files

The file-watcher behind `devstack up`'s source-watching silently fails on
large monorepos when the kernel's `fs.inotify.max_user_watches` is below
the file count it needs to register. No error surfaced — the watcher just
doesn't fire on the affected paths.

**Fix shape**: detect the cap at `up` start (`/proc/sys/fs/inotify/max_user_watches`)
and either bump it via `sysctl` (root only) or print an actionable
warning that names the sysctl line. macOS's analogous limit (`kern.maxfiles`)
hits a different failure mode and probably needs its own probe.

### Snapshot bundle non-atomicity

`devstack snapshot save` writes the host bundle in two steps:
`<stackDir>/host/` is recursively copied, then `snapshot.json` is written
atomically. Both steps are individually atomic but not jointly — a `kill -9`
between them leaves a half-formed bundle (host dir present, manifest
absent) that `restore` mis-handles silently.

**Fix shape**: stage the whole bundle to a sibling tmp dir, then
`renameSync` once. Cost is one extra dir copy per snapshot; benefit is
crash-safety.

### Cross-host snapshot port collisions on `--push`

`devstack snapshot save --push <registry>` tags the seed images with names
that include the host-allocated ports (e.g. `walrus-node-0:port-31010`).
Restoring the bundle on a host that allocated a different port pool means
the tags don't match what `restore` expects.

**Fix shape**: drop port-derived tag suffixes; key purely on the snapshot
content hash. Ports are runtime concerns and shouldn't leak into image
identity.

### Live-net seed snapshot (forking real-network state)

There's no analog to Hardhat's `--fork-url` for seeding a localnet from a
live testnet/mainnet snapshot. Apps that want to develop against
realistic on-chain state (object graphs, package dependencies, account
balances) have to hand-replicate it via `setup:` actions.

**Fix shape**: a `--fork-network testnet --fork-checkpoint <n>` flag on
`devstack up` that pulls a checkpoint snapshot, applies it to the
localnet's genesis, and registers the fetched state in the manifest. Big
feature; deferred until someone needs it.

### Plugin source-hash not in snapshot id

The snapshot id derives from each plugin's declared `inputs:` map. If a
plugin author edits the plugin's implementation without bumping `inputs`,
the snapshot id stays the same and a stale snapshot restores against new
plugin code — leaking subtle state-shape mismatches.

**Fix shape**: fold a digest of the plugin's source dir into the snapshot
id alongside `inputs:`. For workspace plugins, walk the package's
`files:` set; for npm-installed plugins, use the lockfile-resolved
version.

### HostProcess pause/resume during snapshot quiesce

Snapshot quiesce currently pauses container-backed Service actions but
HostProcess actions (long-running in-process children — vite dev server,
deepbook market-maker) keep running through the quiesce window. They
mostly survive because their state is in memory, but a HostProcess that
holds a file lock or a chain transaction in flight can race the snapshot
capture.

**Fix shape**: extend the snapshot quiesce protocol to call a
plugin-provided `pause()` hook on each HostProcess action. Plugins
implement it idempotently.

### Multi-instance plugin support (`imports() ×2`)

Two `imports()` calls in one config (e.g. one for vendor packages, one
for org packages) collide on action expansion — both produce
`imports.<package>` action names that clash in the topo sorter.

**Fix shape**: namespace plugin instances when two of the same plugin
appear (`imports[0].<package>`, `imports[1].<package>`), or accept an
explicit `instanceId:` parameter.

### Bearer token leak through manifest baked into bundle

`wallet-server`'s bearer token lives in the manifest, which Vite bakes
into the production bundle. A devstack-deployed dev build that's then
hosted on a public URL would expose the token. Today this is mitigated
because devstack is dev-only — the bundle isn't supposed to leave the
laptop — but the failure mode is silent.

**Fix shape**: per-session tokens minted by the wallet-server on each
listener start, written to `<stackDir>` instead of the manifest. The
frontend reads from a local file (Vite virtual module) at dev time,
errors out at build time. Long-term work; depends on a "production-mode"
flag on the manifest.

---

## Deferred PRs from round 4

PRs proposed during the round-4 architecture review and later deferred
with rationale. The plan that closed round 4 is at
[archive/round-4-plan.md](archive/round-4-plan.md). Each item below is a
thumb-sketch — the plan archive has the original framing.

### B7 — deepbook `poolNeeds` auto-derive

Pool specs reference `@reg/<name>` tokens that get registered at run time
inside `onPublished` hooks. Auto-deriving `needs:` from the references
would require mapping `@reg/<name>` → registering action at expansion
time, but the registering action only exists post-publish — so the
derivation is fragile by construction. Manual `poolNeeds` continues to
work; this is the original B7 entry from round 4.

### C2 — npm publishing

No near-term plan. Devstack is a prototype; consumers live in this
monorepo via `workspace:*`. Publishing requires bumping
`@mysten-incubation/devstack` to a real version, dropping `private: true`
from `@mysten-incubation/tsconfig`, then `pnpm publish`. Revisit on a
release decision.

### E1 — `loadFixture()` for parallel e2e

Every plausible mechanism trades against a different cost: per-test
snapshot restore is ~15 s on `docker commit`-based snapshots (too slow);
per-stack-per-test means N parallel containers; in-memory revert needs a
Sui-side checkpoint API we don't have. Capture-only — revisit when a
specific e2e suite is measurably bottlenecked by `mode: 'serial'`.

### E2 — Supervisor-TUI manual action triggers

Hotkeys for re-running specific actions (a debug aid for plugin
authors). Lower-priority QoL; deferred.

### G5 — Move `packages/docs` → `apps/docs`

Per AGENTS.md, docs sites belong under `apps/`. Cosmetic alignment;
blocked because the Vercel deployment's "Root Directory" is set to
`packages/docs/` via the project UI — moving from this side breaks
deploys until a UI change. Revisit on a release decision.

### F1 sui — `genesis` opt

Bind-mount a pre-baked genesis blob into the localnet container. The
upstream container generates genesis on `--force-regenesis` so this is
strictly an advanced case. Worth a friction entry first to capture the
specific use case before committing to an API shape.

### F2 walrus — `appendLog` supervisor-TUI plumbing, `nodeCount` opt, per-node `verify()` actions

- `appendLog`: walrus's build streams stderr. The missing piece is
  routing that stream through the supervisor's TUI panel via
  `ctx.appendLog`; bigger than just the walrus side.
- `nodeCount`: `NODE_COUNT = 4` is hardcoded across 8 sites (subnet IPs,
  port range, container names, config-gen). Refactor lift; defer until
  there's a concrete reason to need a different count.
- Per-node `verify()` actions: real new actions (one per node, probing
  REST API liveness). Worth its own focused PR.

---

## Verification still owed

Hands-on tasks that complete round 4's "done criteria" but can't be
checked from a typecheck pass.

- **Three sequential `apply` runs healthy on arena.** Proves PR 0
  (state hydration) + A1 (sui.accounts non-mutating getStatus) + A3
  (transient probe failures) work end-to-end.
- **Real cold/warm cycle timings on a fixed hardware profile.** The
  README claims got stripped (C3) because they didn't reproduce; we owe
  ourselves real numbers next time someone has a clean box and a
  stopwatch.
- **G3 e2e CI matrix runs green.** The workflow rewrite covers all 4
  examples × 2 shards but hasn't been pushed yet — first push to a PR
  is the proof.
- **`pnpm create @mysten-incubation/devstack-app smoke` produces an
  installable scaffolded app.** C1 made the rewriting work; whether the
  result actually `pnpm install`s end-to-end depends on the workspace
  packages being publishable, which is C2-gated.
