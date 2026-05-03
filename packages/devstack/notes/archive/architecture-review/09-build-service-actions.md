# `build` and `service` action types

**Verdict**: Build B+, Service C — Build is fine; Service is overloaded into 4 distinct shapes (long-running container, one-shot container, host process, network setup). The under-specification leaks into every plugin.

## Architecture (clean contract, leaky in places)

The four-slot model is sound: `inputs` becomes a stable hash for cache invalidation (`runtime/hash.ts`), `getStatus` is the skip predicate that runs first, `run` is the work, `needs`/`provides` resolve to a topo order. The skip-predicate decision matrix in `reconcile.ts:8-13` is well-defined and has good cold-cycle behavior (manifest-rehydrated state survives supervisor restart).

The leak is between `getStatus` and `run`. Look at `sui.localnet:160-192` — `getStatus` calls `registerServices()` to repopulate the registry on warm paths because the reconciler skips `run`. Same pattern in `seal.key-server` and `walrus.register`. This is pervasive: every Service action that registers a `Service` record has to mirror that registration in `getStatus`, or downstream actions break on supervisor restart. The contract should make `getStatus` ok=true mean "everything that `run` would do is already true," but that's a culture, not a constraint — the `getStatus` shape `{ok, detail}` doesn't carry registry mutations the reconciler could replay.

A second leak: `getStatus` is run *before* the input-hash check (`reconcile.ts:306-321`). If `getStatus` returns ok=true, the action skips even when inputs changed. This is intentional for warm-skip, but it means an action can never be invalidated solely by inputs drift if `getStatus` is defined — counter to the doc's "hash mismatch + getStatus.ok=true → skip" rule.

## Problem fit

**Build** is a clean fit. Six callsites — five docker-image builds and one docker-network creation (`walrus.network`). The "produce an artifact, idempotent on cache key" model maps. The one outlier is `walrus.network`, which uses `buildImage` for a non-image artifact (a Docker network). The `buildImage` name lies; it's really `produceArtifact`.

**Service** is overloaded and plugins are reaching across the boundary. Service is used for at least four distinct shapes:

1. **Long-running detached container** (`sui.localnet`, `seal.key-server`, walrus nodes, walrus proxy) — what the type name suggests.
2. **One-shot container that exits successfully** (`walrus.deploy`) — `getStatus` checks `exited(0)`, not `running`. This is a build, semantically: produce an output volume, run once, idempotent. It's a Service because Build doesn't have a way to express "run a container against the network."
3. **Long-running host process** (`vite.dev-server`, `wallet-server.serve`) — neither containerized nor cleanly killable; both manage module-scoped child handles to dedupe. Both shadow the reconciler's idempotency layer with their own `if (active) return` checks.
4. **Network setup** (`walrus.network`) — declared as Build but conceptually a service-like prerequisite.

The pattern in (3) — `let activeServer` at module scope — is a workaround for the absence of a `lifecycle` slot. The reconciler doesn't carry a per-action handle, so plugins maintain their own.

## Integration

The reconciler treats the two types identically except in filters (`cli/filters.ts`: live-net targets drop Service; `applyFilter` drops Build+Service). Concurrency is uniform — both can run up to 4 parallel. File-watcher special-cases Build (`inputs.dockerfile` + `inputs.context`) and Publish; Service has no implicit watch paths, which is correct for containers but a gap for `vite.dev-server` (changes to the vite config don't restart it).

Shutdown hooks via `ctx.onShutdown` are well-thought-out (LIFO is documented, parallel teardown explained — `supervisor.ts:170-203`). But the comment "Service actions that detach a container generally don't need this" is contradicted by every container-using Service in scope: `sui.localnet`, `seal.key-server`, walrus nodes, walrus proxy all register hooks. The "containers persist by design" idea is aspirational; in practice, Ctrl-C should clean up.

## Customizability + gaps

Boilerplate I saw repeatedly across plugins:

- **Container `getStatus` shape**: every plugin reimplements `inspectContainer + check running + check healthy + format detail`. The walrus nodes (`walrus/index.ts:258-267`) and `seal.key-server` are near-clones. A `containerService({ containerName, healthCheck })` helper would eliminate ~40% of each plugin file.
- **Warm-path service re-registration**: every Service that registers in the `services` registry duplicates the call in `getStatus`. A `provides: { service: { name, kind, url } }` slot the reconciler could re-register on skip would fix this.
- **Idempotent run logic**: every container Service does `inspect → if matches return → if exists remove → run`. Could be a helper.
- **No retry**: a transient docker network blip kills the action. Plugins like vite/wallet-server have no retry; failure is final until `r` keystroke.
- **No timeout**: `walrus.deploy` can hang forever on a stuck `sui faucet`; only the stack `waitForRpc` calls have explicit timeouts.
- **No resource limits / health budget**.
- **No composition**: an action can't invoke another action; you reach for `needs` ordering instead.

## Testing

**There are no tests for `actions/build.ts` or `actions/service.ts`** — the only `actions/*.test.ts` is `publish.test.ts`. The factories are trivial enough that this is defensible (they're pass-throughs), but the contract semantics — `getStatus` runs before hash check, skip-on-ok, etc. — are exercised only indirectly through `reconcile.test.ts`, and that file uses Register/Emit, not Build/Service. The `cli/filters.test.ts` covers type-based filtering. Net: the wrappers themselves are covered by typecheck only, and the integration pattern (`getStatus` as warm-path register) is enforced by convention with no tests catching plugins that forget it.

## Top recommendations

1. **Split `service` into three action types**: `containerService` (managed lifecycle, healthcheck-aware skip), `hostProcess` (subprocess, signal teardown), and `Job` (run-once, exit(0)=healthy — `walrus.deploy`'s shape). Each removes a class of boilerplate.
2. **Rename `buildImage` → `produceArtifact`** and accept non-image kinds (network, generated config). The current name lies for `walrus.network`.
3. **Add a `provides: { services: [...], packages: [...] }` slot** on the action ABI so the reconciler can replay registry mutations on skip without plugins duplicating the logic in `getStatus`.
4. **Add unit tests for the action factories themselves** plus a contract test asserting `getStatus` warm-path behavior is consistent across the plugin set.
