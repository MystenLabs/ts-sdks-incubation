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

User-visible behavior changes (minor-bump rationale):

- **Pyth types removed from the root barrel.** `PythFeed`, `PythHandle`, `PythOptions`, `PythPackageMember`, and `PythPriceFeedId` no longer re-export from `@mysten-incubation/devstack`. They remain reachable via the `DeepbookLocalOptions.pyth` field chain. The value helpers (`pythPriceFeedId`, `DEEP_PRICE_FEED_ID`, `SUI_PRICE_FEED_ID`, `USDC_PRICE_FEED_ID`) are kept because `examples/deepbook-trader/devstack.config.ts` is the market-maker case the architecture permits.
- **Postgres password format changed.** `derivePassword(app, stack, stackRoot)` now incorporates the stack's on-disk runtime root and an sha256 short hash. Existing dev databases created against the previous `pg-${app+stack}` format will fail to authenticate on first `pg_isready` probe. Either delete the existing container (`docker rm -f`) and let devstack recreate it, OR set `password` explicitly on `PostgresServiceOptions` for stable credentials across the upgrade. Multi-checkout shells of the same `(app, stack)` now derive distinct passwords by design.
- **CLI argv-parse failures now exit with code 64 (`USAGE`), not 1 (`GENERIC`).** Tests / CI scripts that pattern-match exit codes for "user error vs internal error" should treat 64 the same way they treat the `--help` exit code. `--json` mode now also emits a structured envelope for these failures instead of plain stderr.
- **`DevstackOptions.stateDir` is now honored.** The field was declared on the type but silently ignored by `runStack` (only `runtimeRoot` was read). Programs that set `defineDevstack({ stateDir })` previously had no effect; they now do. CLI `--state-dir` flag precedence is unchanged.
- **`setNetworkEnv` now save/restores `process.env.DEVSTACK_NETWORK`.** In-process CLI invocations (tests, embedded use) no longer leak `--network` env state into subsequent calls. Single-process CLI semantics are unchanged.
- **`stringifyCause` renamed to `formatUnknownError`.** Plugins importing the substrate helper directly need to update their import (canonical path: `substrate/runtime/format-unknown-error.ts`). The function's behavior is unchanged.
- **Wallet endpoint constant unified.** `WALLET_ENDPOINT_ALIAS` removed; `WALLET_ENDPOINT_KEY` is the single canonical name. All exports surface through the same module paths.
- **`EndpointEntry.wireProtocol`, `Endpoint.wireProtocol`, `ResolvedEndpoint.wireProtocol`** narrowed from `'http' | 'h2c' | string` to `'http' | 'h2c' | 'tcp'`. Persisted manifests and projections now reject other values at decode time. Plugins emitting custom wire protocols (none ship today) would need to extend the literal union.

dev-wallet:

- `DEVSTACK_WALLET_HTTP_PATH.EXECUTE` removed (devstack-side `/execute` endpoint deleted; the dapp-kit / dev-wallet path bypasses it and the protocol shape didn't match the Sui Wallet Standard).
