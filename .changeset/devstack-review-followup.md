---
'@mysten-incubation/devstack': minor
---

Devstack: follow-up careful-review remediation pass — correctness fixes, an inert-layer removal, a dead-surface purge, and dedup. Builds on `devstack-review-fixes`.

User-visible API / behavior changes (pre-1.0 minor bump):

- **`Redactor` and `layerRedactor` removed from the public barrel.** The engine-wide secret-redaction service was never populated (`register` had zero callers), so it was inert. Redaction is now strictly inline-at-construction in the plugins that handle secrets (seal master keys, wallet pairing tokens), and the account variants (inline / env / keystore) no longer attach the raw secret via the error `cause`. The pure helpers (`redactText`, `RedactionRule`) remain.
- **`SeedManifestMismatchError` and `ForkMeta` removed from the public barrel.** The fork seed-manifest drift-detection apparatus was dead (the error was never raised; `fork-meta.json` was write-only). `fork-meta.json` is no longer written.
- **`ContainerExited` docker error removed.** It was declared and projected but never constructed — `catchTag('ContainerExited')` could never fire.
- **`ArtifactSpec.verifySchema` removed.** The field was populated by plugins but never consumed by the substrate publisher (`verify` is plugin-owned). Plugins providing it should drop the property; the `Verified` type is still pinned by the `verify` signature.
- **`FaucetBodyError.reason` no longer includes `'malformed-body'`** (never constructed; JSON-parse failures use `'invalid-json'`). **`ActionPhase` no longer includes `'parse'`** (never raised).
- **`snapshot prune` now sweeps committed snapshot images by a reserved `role=snapshot-image` ownership label** (stamped at `docker commit`). Previously it filtered by `{app, stack}`, which matched live plugin *build* images (untagging them, forcing silent rebuilds) and never matched the unlabelled snapshot byproducts it was meant to reap.
- **Sui snapshots now carry a `mode` discriminator in their restore identity.** A container-`local` snapshot and a `local-rpc` snapshot at the same chain id are no longer mutually restorable (the cross-mode restore was a silent no-op). **Migration:** sui snapshots captured before this change carry the old `{kind, chain}` identity and will be refused on restore against the new `{kind, mode, chain}` identity (fail-closed `IdentityMismatchError`, never silent corruption) — re-capture after upgrading, or delete the stale snapshot.
- **`dockerExec` gains an optional `timeoutMillis`**, and docker subprocess spawns now escalate SIGTERM→SIGKILL (`forceKillAfter`) so a CLI that ignores SIGTERM cannot wedge scope-close.

Correctness fixes (no API change):

- Supervisor selective-restart no longer wedges the command loop on an uncatchable lifecycle-transition defect (lifecycle reset routes status authoritatively to `pending`; the acquire-side self-transition is defect-tolerant).
- Cross-process `stack.lock` / snapshot-reservation reclaim re-stats (mtime + inode) immediately before `unlinkSync`, so a competitor's freshly-rewritten live lock can't be deleted (mutual-exclusion break).
- `ensureNetwork` adopts an owned network on a concurrent-create collision instead of failing boot.
- `stage-and-swap` restores the backup on an EXDEV cross-filesystem copy failure, and the EXDEV detection now reads the real (nested) errno off the `PlatformError`.
- host-service spawns the child and registers its terminator atomically (`Effect.uninterruptible`), so an interrupt mid-boot can't orphan a detached process; same hardening on `scoped-http-server`.
- deepbook pool matching is position-aware on `Pool<Base, Quote>` generics (reversed/overlapping pairs no longer collapse to one id).
- coin self-funding (publisher funded with its own coin) no longer deadlocks on the per-address lease.
- router `boot()` runs bootstrap once per supervisor lifetime even under concurrent plugin acquire.
- lifecycle-prune re-probes each victim's liveness immediately before removal (TOCTOU vs a concurrent `up`).
- command-channel tail handles UTF-8 multibyte sequences split across a short read.
- snapshot `recover-pending` distinguishes "already recovered" from a transient daemon error.
- playwright codegen-watch schema pins the engine-record discriminators (loud decode-failure on drift instead of a silent 5-minute deadlock).

Internal dedup (no behavior change): shared `makePhaseFailer` across snapshot orchestrators; `readLabels` lifted to `docker/labels.ts`; `inspectVolume` routed through `dockerInspectAndDecode`; single `WALRUS_ROUTER_PORT`; shared deepbook `stableContentHash`; single-source `DEFAULT_STACK_NAME`.
