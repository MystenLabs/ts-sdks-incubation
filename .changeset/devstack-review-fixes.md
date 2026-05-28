---
'@mysten-incubation/devstack': minor
'@mysten-incubation/dev-wallet': minor
---

Devstack: thorough-review remediation pass plus follow-up cleanup round.

Highlights:

- `runStack({ layers })` replaced by `runStack({ extendContext })`. Custom context extension now goes through a typed seam.
- `executeSuiTx` returns a discriminated union (`$kind: 'ExecutedSuccess' | 'ExecutedFailure'`). On-chain failure is a value, not an error. Plugins that previously caught the failure-tag in the error channel must dispatch on `$kind` instead.
- New substrate helper `signAndDispatch` compacts the `withTransactionSigner → build → sign → execute → $kind dispatch` pattern across five publisher plugins.
- Supervisor module (1.8k LOC) split into 11 per-concern modules under `substrate/runtime/supervisor/`. No behavior change.
- New `built-in-plugin-layers.ts` lives in `orchestrators/`, not `runtime/` — `run.ts` lifted into `orchestrators/` similarly. Layer composition now lives at L3 only.
- New L0 helper `routed-url.ts` for `renderUrl`/`routedHostname`; L3 router/hostname.ts retained as an intra-L3 adapter.
- Docker image builds now stamp ownership labels (`expectedImageOwnershipLabels`); prune can reach previously-unlabelled images. New `BuildOptions.labels` on the container-runtime contract.
- Sweep evicts own endpoints and surfaces remaining `ForeignNetworkHolder` rather than failing silently.
- Per-app shared-stack pinning: `_per-app_` stacks (e.g. shared chain-build cache) are pinned while any app sibling is live.
- `atomicWriteFile` cleanup is now whole-pipeline (open/write/fsync/rename) via `Effect.onError`, not rename-only.
- `cross-process-lock` typed errors: `StackLockTimeoutError | StackLockIoError` in the E channel; no more `Effect.orDie`.
- Plugin-domain span/log keys namespaced via per-plugin `spans.ts` files.
- `ChainOperation` typed seam removed (zero plugin adoption signal); `ClientWithCoreApi` is the sanctioned SDK cast at plugin boundaries.
- ARCHITECTURE.md / STYLE_GUIDE.md rewritten to describe current state (537→308, 894→477 lines).
- New style-enforcement tests: `l4-boundary`, `no-unknown-as` (globs every plugin barrel), `plugin-boundary`, `span-attr-namespace`, `substrate/name-blindness`.

Dead-code purge and substrate race fixes:

- Orphan modules removed (no consumers): `orchestrators/codegen/extras.ts` (inlined into `runtime-composition.ts`); `plugins/deepbook/routable.ts` + the `DEEPBOOK_ENTRYPOINTS` aggregation; `plugins/sui/live-faucet-strategy.ts` (`suiLiveStrategy`, `LIVE_FAUCET_URLS`, `SuiLiveNetwork`, `SuiLiveStrategyOptions`); `plugins/sui/seed-objects.ts` (`SeedObjectsAccumulator`, `makeSeedObjectsAccumulator`, `SEED_OBJECTS_CAPABILITY_KEY`). The sui plugin's emitted-capability count drops from 5 to 4.
- `plugins/walrus/faucet-strategy.ts`: `makeWalFaucetContribution` removed; `makeWalFaucetStrategy` unaffected.
- `orchestrators/router/index.ts`: unused `STATIC_PROVIDER_FILENAME` export removed.
- `plugins/sui/fork-orchestration.ts`: `ForkGuardedSdk<Sdk>` derived type alias removed; `wrapWithForkGuard` now returns `Sdk` directly (behavior identical).
- Capability-sink registration race fixed: install + finalizer wrapped in `Effect.uninterruptible` so an interrupt between `Ref.modify` and `addFinalizer` cannot leak the sink past scope close.
- Cross-process command channel short-read fix: `readSync` may short-return on NFS / cross-FS; offset advances by `bytesRead` rather than the requested length, with a clean bail on `bytesRead <= 0`.
- Cross-process roster PID-recycle hazard fixed: `heartbeat` / `release` / `setIntent` now match holders via `(pid, hostname, startTime)` triple via a new `isOwnEntry` helper (was matching `(pid, hostname)` only).
- Background snapshot interrupt now awaits via `Fiber.interrupt(fiber)` (was fire-and-forget `fiber.interruptUnsafe()`) so a follow-up capture can't start while the previous fiber is still inside `pauseAndCommit` / `saveImages`.
- CLI restructure: `cli/main.ts` (1338 LOC) split into per-verb wirings under `cli/wirings/{up,apply,snapshot,wipe,prune}.ts` plus shared `build-verb-layers.ts` / `identity.ts` / `config-loader.ts` helpers. `main.ts` is now argv → identity → deps → dispatch only (~290 LOC).
- Cross-process command-channel `ack` / `error` records gain an optional `payload: unknown` field plumbed through `awaitCompletion`. `snapshot.capture` now carries the captured metadata (or failure summary / skipped reason) on the reply directly — the CLI no longer tail-fibers `events.ndjson` for the completion event.
- Repo-wide Prettier reformat.

dev-wallet:

- `DEVSTACK_WALLET_HTTP_PATH.EXECUTE` removed (devstack-side `/execute` endpoint deleted; the dapp-kit / dev-wallet path bypasses it and the protocol shape didn't match the Sui Wallet Standard).
