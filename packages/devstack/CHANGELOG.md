# Changelog

## 0.1.0

Initial public release. Stage-2 work tracked in
`notes/stage-2-plan.md`; the published surface stabilizes here.

### Engine

- Producer-graph engine (`define`, `defineSchema`, `dep`, `exclusiveDep`)
  with typed `Dep<TConsumerView>` references — one type parameter on the
  public surface, hidden runtime fields keyed off `Dep<never>` for
  engine-internal positions.
- `Engine.settle({ maxCycles? })` drains a cascade in one call; bounded
  to surface flapping producers as cycle-budget errors instead of hangs.
- Rank-by-rank + greedy conflict-graph parallel execution within a
  cycle (`engine/scheduling.ts`). `exclusiveDep({ get, lockKey })`
  declares same-resource mutexes; the engine refuses to parallel-batch
  consumers whose lockKeys intersect.
- `runsAs?: string` deleted — same-resource serialization expresses on
  the producer that owns the resource via `exclusiveDep`, not on the
  consumer node.
- Single-instance stack locking via `persistence/withStackLock` —
  atomic `O_EXCL` lock file with PID-reuse defense (`ps -o lstart=`),
  stale-lock replacement, and a `StackLockBusyError` that names the
  holder + the path to remove if stale.

### CLI

- `devstack apply` / `up` / `status` / `snapshot` (save | restore | list
  | delete) / `wipe` / `stack` (list | new | use | down | drop) /
  `doctor`. All mutating verbs go through `withStackLock`.
- `wipe` requires `--yes` explicitly. `--images` runs
  `docker image prune -f` after the wipe.
- `stack drop <name> --yes` = `wipe --stack <name> --yes`.

### Test integration

- `@mysten-incubation/devstack/vitest` — `setup` / `teardown` /
  `setupWithConfig` / `readManifest<TExtras>` / `readSnapshot` /
  `getNodeState`. globalSetup auto-detects `appDir` (cwd-walk) +
  `stack` (`DEVSTACK_STACK ?? 'test'`).
- `@mysten-incubation/devstack/playwright` — pre-extended `test` +
  `expect`, worker-scoped `manifest` / `rpcUrl` / `stack` /
  `signerPool` fixtures. `webServer({ endpoint })` fails loudly when
  the manifest endpoint is missing. UI helpers `connectAs` /
  `selectAccount` / `waitForBalanceUpdate` co-located here.
- `@mysten-incubation/devstack/leasing` — `SignerPool.fromManifest`,
  `withLease`, leak diagnostics with acquire-site stack traces.

### Shapes & manifest

- `Manifest<TExtras>` lives in `@mysten-incubation/devstack/shapes` —
  one source of truth. The `manifest()` plugin's emitted TS imports
  this type rather than redeclaring it.

### Frontend

- `@mysten-incubation/devstack/dapp-kit` —
  `createDevstackDappKit({ manifest })` + `localnetDappKitConfig` +
  `localnetMvrOverrides` + `localnetWalrusOptions`. No
  `@mysten-incubation/devstack/react` subpath (no React bindings).
