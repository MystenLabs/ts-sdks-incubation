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

## 2026-05-02 — Reconciler runs same-signer transactions in parallel

The reconciler schedules independent actions concurrently up to its
worker pool size (`packages/devstack/src/runtime/reconcile.ts:119`).
Two `publishMove({ name: 'usdc', needs: ['sui.accounts'] })` and
`publishMove({ name: 'weth', needs: ['sui.accounts'] })` actions both
default to the `publisher` account, so they sign concurrent
transactions that touch the same gas object — Sui's validator
equivocation guard rejects the second one with
"Object … already locked by a different transaction".

Fix shape (deferred): the reconciler reads each Publish/Seed
action's signer (already on the action surface for publish; would
need to plumb through seed/runTransaction) and serializes actions
that share a signer. Until then, app authors have to add explicit
`needs:` between same-signer actions, which is non-obvious — the
graph models data deps, not signer-account deps.

Workaround in `examples/wallet/devstack.config.ts`: weth depends on
usdc via `needs: ['usdc']`. Comment in-config flags the workaround.
