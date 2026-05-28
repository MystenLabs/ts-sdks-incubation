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

dev-wallet:

- `DEVSTACK_WALLET_HTTP_PATH.EXECUTE` removed (devstack-side `/execute` endpoint deleted; the dapp-kit / dev-wallet path bypasses it and the protocol shape didn't match the Sui Wallet Standard).
