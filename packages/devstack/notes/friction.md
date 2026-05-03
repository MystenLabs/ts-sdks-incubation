# Friction journal

Per `CLAUDE.md`: when something hurts (hardcoded port, copy-paste, manual
step, brittle interaction), capture it here as a one-line entry + file
path. Phase 2+ extracts patterns from the journal — don't silently work
around the pain, the pain is the data.

Entries are roughly chronological. New entries at the bottom.

---

## 2026-05-02 — Hardcoded ports across plugin instantiations [CLOSED — PR 8]

`packages/devstack/src/plugins/sui/index.ts:73-76` lets apps pin
`rpcPort` / `faucetPort` per plugin instance, but the actual ports are
chosen by hand in each app's `devstack.config.ts`:
- `examples/token-studio/devstack.config.ts:27-28` — 9059, 9984
- `examples/arena/devstack.config.ts` — different pair
- `examples/wallet/devstack.config.ts` — different pair

Two consequences:

1. **Stack-stack collision within an app.** Sui plugin uses the same
   `rpcPort` regardless of stack name (e.g., `main` vs `test`). Trying
   to run `main` and `test` at the same time in the same app fails with
   `Bind for 0.0.0.0:9059 failed: port is already allocated`. Reproduced
   in the `state-and-snapshots-plan.md` verification: had to `down` main
   before running `test:e2e`. **Tests should always use dynamic port
   allocation** so a developer's `devstack watch` on `main` doesn't
   block `pnpm test:e2e` on `test`.

2. **App-app collision across the dev box.** Token-studio + arena +
   wallet are explicitly given different ports in their configs to
   avoid each other. Adding a fourth example app means picking yet
   another port from a manually-tracked allocation table. CLAUDE.md's
   anti-patterns explicitly call out "hardcoded ports anywhere outside
   the port allocator" — the allocator doesn't exist yet.

**What a port allocator looks like**: per-app `<appDir>/.devstack/ports.json`
(or per-stack) records the resolved port for each named port slot. On
first `devstack up` with no entry, allocate a free port via `:0` bind
+ resolve, persist, write to manifest. Subsequent runs reuse from the
persisted file. Plugin authors stop hardcoding ports; their `port`
option becomes a hint (preferred port if free, fall back to allocated).

Tests get dynamic ports automatically — each stack gets its own slot.
The manifest carries the actually-bound port; frontend reads it from
the manifest as today (no caller-side change).

Files to revisit:
- `packages/devstack/src/plugins/sui/index.ts` (rpcPort, faucetPort)
- `packages/devstack/src/plugins/wallet-server/index.ts` (port)
- `packages/devstack/src/plugins/walrus/index.ts` (nodeHostPortBase)
- `packages/devstack/src/plugins/seal/index.ts` (port)
- `packages/devstack/src/plugins/frontend/index.ts` (port)

## 2026-05-02 — wallet-server manifest race on cold-first-run after PR 1 race fix

After the PR 1 race fix
(`packages/devstack/src/playwright/global-setup.ts`), Playwright
globalSetup now uses `applyTestSetupFilter` which skips `HostProcess`
actions. The wallet-server is HostProcess, so its `populateRegistry`
hook never fires during globalSetup. On a **cold first-run** of the
test stack:

1. globalSetup writes `<stackDir>/manifest.json` without a wallet-server
   entry.
2. Playwright launches `pnpm dev` (the long-running supervisor).
3. The supervisor brings up wallet-server, registers it, rewrites
   manifest. But Playwright also navigates the browser to `/` as soon
   as Vite's port is reachable.
4. If the browser's `virtual:devstack-manifest` import lands BEFORE the
   supervisor's manifest rewrite, the bundle gets `manifest.registry
   .services` missing wallet-server. `createDevstackAdapterFromManifest`
   returns undefined. The dev wallet doesn't register. Tests fail at
   `connectAs(page, 'alice')` with "Connected as" never visible.

Reproduced in token-studio e2e during the snapshot/state-model
verification (PR 1's first cold cycle on the `test` stack). Subsequent
runs work because manifest hydration preserves the prior wallet-server
entry — only the cold-first-run is broken.

The old race (token mismatch) is gone, replaced by a different one
(manifest-entry-missing). Both stem from the same root cause:
**wallet-server's URL+token registration is coupled to the actual
server starting**, so any path that doesn't start the server doesn't
register the entry.

Possible fixes (deferred — no design picked):
- Split wallet-server into a Register action (writes manifest entry,
  runs in `apply`) + a HostProcess action (the listener, separate
  lifecycle). The Register action computes a deterministic URL +
  reads/mints a persisted token, populates the manifest. HostProcess
  binds the same URL/token. Manifest is correct from the moment
  globalSetup completes.
- Make the Vite `virtual:devstack-manifest` plugin block on a
  `wallet-server` entry being present (or poll until it is). Brittle.
- Containerize wallet-server so its lifecycle decouples from supervisor
  (was option C in `notes/architecture-review/23-playwright-integration.md`).

The Register-then-HostProcess split feels right and is a natural
follow-up to PR 1.

**Closed by PR 9** (state-and-snapshots follow-up plan): the split
landed and cold-first-run e2e on token-studio now passes. Manifest
contains the wallet-server entry as soon as globalSetup completes;
the listener starts in a separate HostProcess action that
applyTestSetupFilter skips.

## 2026-05-02 — Faucet 500 on cold-first-bring-up [CLOSED — keys.ts retry]

Surfaced repeatedly in the state-and-snapshots e2e verification:
`sui.accounts` fails on the first cycle of a fresh sui container with
`faucet http://127.0.0.1:9984/v2/gas → 500: {"status":{"Failure":{"Internal":"Failed to execute transaction after 2 retries"}}}`.
The faucet HTTP endpoint is reachable (waitForFaucet returned ok),
but its first txn submission fails the validator's "execute after N
retries" path. Always succeeds on the next retry, so this is a brief
ready-but-not-quite window between RPC up and the validator able to
execute coin txns.

`packages/devstack/src/plugins/sui/keys.ts:19-29`'s `ensureFunded`
has no retry. CLAUDE.md anti-pattern explicitly calls out
"long-running processes that `process.exit(1)` on transient errors
with no restart" — `ensureFunded` should retry the faucet call with
exponential backoff.

## 2026-05-02 — Playwright `defineDevstackPlaywrightConfig` baseURL is hardcoded [CLOSED — PR 16]

`packages/devstack/src/playwright/defineConfig.ts:46-47`:

```
const baseURL = `http://localhost:${port}`;
```

`port` came from the user's option (default 5173). With the port
allocator the actual frontend port could differ when sibling stacks
claimed the preferred port — running `pnpm test:e2e` while another
stack of the same app held 5173 landed the test stack's frontend on
a kernel-allocated port (e.g. 51202). Playwright polled
`http://localhost:5173` and timed out after 5 minutes.

**Closed by PR 16**: `defineDevstackPlaywrightConfig` already routed
through the per-stack allocator on `manageStack: true`, but
`extend.webServer` and `extend.use` overrides clobbered the resolved
URL. PR 16 splits those out and shallow-merges them over the defaults
— `extend.webServer = { timeout: 180_000 }` now keeps the resolved
`url` + `command`. Verified: with `main` stack holding 5174, test
stack's allocator picks 65218; all 7 wallet e2e tests pass without
the prior workaround.

## 2026-05-02 — Reconciler runs same-signer transactions in parallel [CLOSED — PR 17]

The reconciler scheduled independent actions concurrently up to its
worker pool size. Two `publishMove({ name: 'usdc' })` and
`publishMove({ name: 'weth' })` actions both defaulted to the
`publisher` account, so they signed concurrent transactions that
touched the same gas object — Sui's validator equivocation guard
rejected the second one.

**Closed by PR 17**: `ActionBase` gained a `runsAs?: string` field;
the reconciler treats it as a soft constraint ("at most one inflight
action per distinct `runsAs` value"). `publish`/`definePublishAction`/
`publishMove` thread `publisher` → `runsAs` automatically;
`runTransaction` does the same for `signer`; raw `seed()` accepts
explicit `runsAs:` for action bodies that sign via
`ctx.accounts.get(...)` directly. Wallet config dropped both manual
edges (`weth needs ['usdc']`, `seedTokens needs ['deepbook.pools']`)
and now declares `seedTokens.runsAs = 'publisher'` — cold + warm
apply healthy; all 7 e2e tests pass.

## 2026-05-02 — Walrus subnet hardcoded at `10.0.0.0/24` blocks per-stack siblings [CLOSED — PR 23]

`packages/devstack/src/plugins/walrus/index.ts:77-78`. The walrus
plugin pins the docker network's IPAM at `10.0.0.0/24` and assigns
storage nodes to fixed IPs `10.0.0.10–13`. Two stacks of the same
walrus-using app (e.g. `private-content/main` + `private-content/test`,
or two app's stacks both using walrus) try to claim the same
`10.0.0.0/24` and the second-to-up errors with
`docker network create … failed: invalid pool request: Pool overlaps
with other one on this address space`. Reproduced while gathering
e2e timings — `private-content` cold apply blocked by a leftover
`private-content-test-net` from yesterday.

Same architectural shape as the original "hardcoded ports" friction
that the per-stack port allocator closed: the subnet is global where
it should be per-stack.

Fix shape attempted: derive a deterministic `octet` from
`hash(appName/stack)`, place each stack on `10.<octet>.0.0/24`. The
walrus plugin code change is small (~30 lines) and went in cleanly,
but the upstream `MystenLabs/walrus@<rev>:docker/local-testbed/files/
deploy-walrus.sh` script bakes the hardcoded IPs into the per-node
YAML configs at deploy time. The storage nodes start, fail to bind
their metrics endpoint to the now-mismatched IP (`Cannot assign
requested address`), and panic. The fix needs either:

1. Patch `deploy-walrus.sh` (sed it during `walrus.build`) to read
   `WALRUS_NODE_IPS` env vars, then pass them through from
   `walrus.deploy`. Same shape as the existing `RUN sed -i 's|--
   storage-price 5|--with-wal-exchange --storage-price 5|'` patch in
   `build.ts:78`.
2. Or fork the upstream local-testbed scripts into the plugin and
   maintain locally — heavier-weight; defer.

Workaround for now: walrus-using apps run one stack at a time. The
non-walrus-using apps (wallet, arena, token-studio) coexist freely
since their docker networks land on `bridge`-default `172.x.0.0/16`
pools that don't collide.

**Closed by PR 23**: `walrusOctet(appName, stack)` picks per-stack
octet; `walrusSubnet(octet)` and `walrusNodeIp(octet, idx)` produce
the per-stack `/24` and IPs. The deploy script is sed-patched at
`walrus.build` to take `${WALRUS_NODE_IPS}` from env (set by
`walrus.deploy.run`) and to redirect each node's
`storage_path` from the read-only outputs bind-mount to
`/var/walrus/storage` in the writable layer. Verified: cold apply
on `private-content` puts walrus.network on `10.90.0.0/24`, deploy
generates configs with the new IPs, nodes open RocksDB + bind REST
API successfully.

## 2026-05-02 — Same-account signer used by both supervisor + browser path equivocates [CLOSED — PR 31]

The wallet's market-maker action signed as `alice` every 10s (refresh
tick). The e2e SUI-send test connected as `alice` and signed via
dApp Kit → wallet-server → `ctx.accounts.get('alice').sign(...)`.
Both paths share alice's keypair object in the same supervisor
process, but neither knows about the other's inflight tx. Sui's
validator-equivocation guard rejected whichever user-side tx happened
to land while the maker's tick was unresolved:

> Transaction is rejected as invalid by more than 1/3 of validators
> by stake (non-retriable). Non-retriable errors: [Object
> (0x1970..., SequenceNumber(2374), o#8GqbJn...) already locked by
> a different transaction: TransactionDigest(82E7z9...) {
> k#99f25ef6.. } with 10000 stake].

Reproduced twice on cold e2e runs (test 4 = `alice sends 0.5 SUI
to bob`).

**Closed by PR 31**: dedicate a `mm` account in the wallet config;
maker uses `signer: 'mm'`. seedTokens distribution adds an `mm`
share so the maker has inventory.

The reconciler's `runsAs` constraint serialized action-to-action
same-signer races (closed by PR 17). This was a NEW shape: action-
to-browser-tx race. The framework can't know about browser txs that
go through wallet-server's HTTP endpoint. The right architectural
fix is a per-account mutex inside the keypair, scoped to the entire
supervisor process — but that's a bigger lift. For now the
ergonomic answer is "use a dedicated maker account so its 10s
schedule doesn't collide with user-side txs".

## 2026-05-02 — Walrus 1.48.0 storage nodes panic on TLS startup

After PR 23's per-stack-subnet work landed and storage nodes
opened their DBs cleanly, walrus-node 1.48.0 panics with
`tls_rustls/mod.rs:204:14: called Result::unwrap() on an Err
value: JoinError::Cancelled(Id(349))` shortly after binding REST
API on `10.<octet>.0.10:9185`. The node is up briefly — the
metrics endpoint starts, the REST API starts on `:9185`, then the
TLS-server task is cancelled and the runtime panics.

Likely an upstream issue with axum-server 0.8.0 or the walrus rev
itself; not caused by the per-stack-subnet change (the same panic
reproduces with the pre-PR-23 hardcoded `10.0.0.10` as well, as
of the May 2 timing run that surfaced this). Pre-existing.

`private-content` e2e (`seal-flow.spec.ts`) doesn't actually need
the storage nodes to be healthy on a fresh stack — Seal works
without walrus, walrus is only needed for the blob upload path.
Worth either bumping `WALRUS_REV` to a fixed upstream rev or
gating walrus-node liveness behind a non-strict probe (warn but
don't block downstream).
