# Devstack architecture guide

> Living document. The boundaries below are LOAD-BEARING. A violation either fixes the code OR — if
> the boundary is genuinely wrong — produces a PR that updates this doc with justification first.

Anchor doc: `notes/redesign/architecture.md` (2813 lines, 7 revision rounds). This guide distills
the invariants; that doc is the design source of truth.

Companion: see `STYLE_GUIDE.md` for code-level patterns. See `notes/UNRESOLVED-BLOCKERS.md` for the
current release gate.

---

## The 6 layers

The architecture is L0–L5. Every component lives in exactly one layer; the allowed-imports column is
the contract.

| Layer                            | What lives here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Imports from                                                                                                                                         | NEVER imports from                                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **L0 substrate**                 | kernel, branded primitives, scheduler, lifecycle SM, event/command channels, paths, identity, port broker, lease broker, lock broker, atomic-write, cache, state-store, cross-process protocol, runtime decode helpers, retry policy, process supervisor, observability primitives, manifest envelope schema, OnChainArtifactPublisher, strategy-registry, generic scoped-ref-map. **Name-blind post PR1.5** — the `per-stack-registries` Sui/Move-shaped legacy primitive is deleted; plugin-domain shapes live at L2. One documented L1-adjacent exception: `substrate/runtime/sui-execute/` (see § Substrate name-blindness). | external libs only (`effect`, `@effect/*`, Node stdlib)                                                                                              | L1+, named plugins, capability decls (today's supervisor violates capability-decl awareness — see Open slot O6 in STYLE_GUIDE, PR2-A in flight) |
| **L1 runtime adapters**          | `ContainerRuntime` (Docker reference impl), `InProcessRuntime`, `ReverseProxyRuntime` (Traefik reference impl), image-build primitive, shared per-line streaming sink, signal-forwarding entrypoint shell, network attach + IP-readback                                                                                                                                                                                                                                                                                                                                                                                          | L0                                                                                                                                                   | L2+, named plugins                                                                                                                              |
| **L2 plugins**                   | sui, postgres, walrus, seal, account, faucet, package, coin, wallet, action, deepbook — one folder each exposing `definePlugin({ id, dependsOn, start, capabilities })` factories. Renderer plugins (TUI Ink, plain, silent) also here. Per-plugin tagged errors, Snapshotable / Routable / NetworkResolver-mode / Codegenable / StrategyContributor decls.                                                                                                                                                                                                                                                                      | L0, L1, other plugins through public resource/plugin refs at factory boundaries; never internal service modules                                      | other plugin INTERNAL modules. Other services' source.                                                                                          |
| **L3 orchestrators**             | snapshot, router (Traefik file-provider), watch-dispatcher, network resolver, manifest writer, codegen orchestrator. Each walks a registry of plugin capability contributions; never names services.                                                                                                                                                                                                                                                                                                                                                                                                                             | L0, L1, capability decls from `contracts/`                                                                                                           | L2 plugin INTERNALS, named plugins. Hardcoded paths.                                                                                            |
| **L4 surfaces**                  | CLI (`surfaces/cli/`), TUI (`surfaces/tui/`), programmable API, bin entry (`cli/main.ts`). All surfaces are symmetric peers: subscribe to typed event stream + publish typed commands.                                                                                                                                                                                                                                                                                                                                                                                                                                           | L0 (events/commands/manifest schema), L3 (Codegenable decls; manifest writer output). Cascade-formatter (surface-shared exception per architecture). | L1 directly. Any L2 plugin module. Any direct engine method calls — only `CommandPublisher` + `EventSubscriber`.                                |
| **L5 build integrations + apps** | `build-integrations/{vite,vitest,playwright,browser,runtime}/` — host-facing integration packages. Example apps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | The shared `build-integrations/runtime/` helpers + the on-disk manifest + codegen-emitted files + env vars + the typed global bridge slot            | L0–L3 directly. Engine subscription.                                                                                                            |

### Substrate name-blindness

Substrate must be **name-aware-of-nothing**. If substrate code mentions `walrus`, `sui`, `seal`,
`wallet`, `account`, `coin`, `package`, etc. — it's a boundary violation.

L0 substrate is **name-blind** after PR1.5: `substrate/runtime/per-stack-registries/` has been
DELETED and replaced by L2 wrapper services (`plugins/coin/registry.ts`,
`plugins/package/registry.ts`) that instantiate the generic `defineScopedRefMap<K, V>(name)`
primitive at `substrate/runtime/scoped-ref-map/`. Plugin-domain names (`CoinRecord.witness`,
`ResolvedLocalPackage.packageId`) live at L2 where they belong.

**Documented exceptions** (substrate is name-blind, but a few targeted helpers live at
substrate-L1-adjacent):

- `substrate/runtime/sui-execute/` — Sui-aware substrate helper consumed by
  `package/publish-executor.ts` (PR1-E) + `action/execute.ts` (PR3 wiring). This is an L1-adjacent
  exception, documented in the module header. Rationale: the Sui SDK boundary (sign + execute +
  envelope project) is mechanical enough that two plugin authors copied 80% of the same body, and
  the helper is plugin-agnostic at the API surface even though it names Sui in the type signatures.
  New L1-adjacent exceptions need explicit justification in this section.
- `substrate/runtime/on-chain-artifact/` framing names "on-chain" — pending rename to generic
  `artifact-publisher` OR move to L2 alongside Sui plugins. Tracked as a residual name-leak.

---

## Capability contracts

Declared in `src/contracts/`. The discriminated union is `CapabilityDecl`
(`contracts/capability-decl.ts`). One capability decl per file.

| Contract                | Declared in                         | Purpose                                                                                                                                       | When to use                                                                                                                       |
| ----------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **ContainerRuntime**    | `contracts/container-runtime.ts`    | Docker-like execution backend: ensure / inspect / start / stop / commit / build / network / volume / logs / labels / exec / save / load / tag | Plugins that manage long-running containers (sui, walrus, seal, postgres)                                                         |
| **Snapshotable**        | `contracts/snapshotable.ts`         | Capture/restore declaration: `managedContainers` label tuples + host subtree paths + identity guard payload + pre/post hooks                  | Stateful plugins (postgres, walrus, seal, account-ephemeral, sui-local, package, coin)                                            |
| **Routable**            | `contracts/routable.ts`             | HTTP/TCP route contribution: entrypoint name + dispatch id + wireProtocol + upstream resolver                                                 | Plugins exposing endpoints (wallet, walrus-aggregator/publisher, seal, postgres `route: true`)                                    |
| **Codegenable**         | `contracts/codegenable.ts`          | Emitter contribution: `emit(ctx)` writes exports/imports through `CodegenEmitContext` and returns `ctx.done()`                                | Any plugin emitting type-safe bindings (every L2 plugin today)                                                                    |
| **NetworkResolver**     | `contracts/network-resolver.ts`     | Chain id / network identity / funds-ready gate                                                                                                | One per chain (sui owns `chain-probe:sui`; future chains add their own)                                                           |
| **ChainProbe**          | `contracts/chain-probe.ts`          | Chain reachability + facts (lenient verify pattern)                                                                                           | One per chain; consumed by OCA verify, account funding gates                                                                      |
| **StrategyContributor** | `contracts/strategy-contributor.ts` | Pluggable strategy injection (faucet strategies, account variants, OCA produce bodies)                                                        | Faucet strategies (sui-local/sui-live/sui-fork/wal-exchange/treasury-cap-mint), account variants, custom plugin-author extensions |
| **Projection**          | `contracts/projection.ts`           | Read-model update emitted by a plugin after acquisition, such as account/package row state                                                    | Plugins that publish UI/persisted state independent of callable strategy values                                                   |

Additional infrastructure contracts (not in the capability decl union):

- `Renderer` (`contracts/renderer.ts`) — subscribable-state-driven; substrate-of-surfaces. Pluggable
  rendering.
- `LivenessClassifier` (`contracts/liveness-classifier.ts`) — narrow contract for one-shot vs
  long-running discrimination.

---

## Plugin-author surface = user-surface

Per memory `project-devstack-plugin-author-symmetry`: custom plugin authors MUST be able to author
plugins whose config-site experience is identical to built-ins. No privileges built-ins have that
customs can't replicate.

Concretely:

- `definePlugin({ id, dependsOn, kind, start, capabilities })` is the explicit authoring API
  (`api/define-plugin.ts`).
- Capability decl helpers and public contract types are reachable from the root package entrypoint.
- The callable `defineModeNamespace(network)` API is available to custom plugins for mode-narrowed
  factories.
- The strategy-registry primitive is open: plugins like `faucet` expose `defineFaucetStrategy()`;
  the same shape works for any plugin's strategy injection.

If you ADD a built-in feature, ask: "can a custom plugin do this?" If no — you have introduced an
asymmetry. Either expose the seam, or you are wrong to add the feature.

### Plugin-author extension via Layer composition

A custom plugin author registering a sink for a brand-new `CapabilityDecl` kind composes a Layer
that yields `CapabilitySinksService` and calls `registerSink({ kind: 'my-custom', accept })`. The
composed Layer flows into the supervisor through `pluginContext` — the same vehicle used for every
other substrate service (Logger, RuntimeRoot, ContainerRuntime, etc.).

The mechanic:

```ts
const customOverlay = Layer.effectDiscard(
    Effect.gen(function* () {
        const sinks = yield* CapabilitySinksService;
        yield* sinks.registerSink({ kind: 'my-custom', accept: ... });
    }),
);

const sinksLayer = customOverlay.pipe(
    Layer.provideMerge(layerCapabilitySinksDefault(orchestratorBag)),
);

// Compose into pluginContext alongside other substrate services:
const sinksService = Context.get(yield* Layer.build(sinksLayer), CapabilitySinksService);
const pluginContext = baseContext.pipe(Context.add(CapabilitySinksService, sinksService));

yield* supervise(stack, identity, state, pluginContext);
```

`supervise()` checks `pluginContext` for a pre-built `CapabilitySinksService` and harvests through
THAT instance when present. Only when context carries no service does the supervisor fall back to
building its own from the `sinks: OrchestratorSinks` argument — preserving the bare smoke-test path.

This is the SAME pattern the supervisor already uses for `Logger` (see `supervisor.ts:805-811`):
check context, fall back to no-op default. No new mechanism, no special "plugin author API" — Layer
composition IS the API.

The previous shape (`Layer.build(layerCapabilitySinksDefault(sinks))` unconditionally inside
`supervise()`) was a real plugin-author-symmetry break: callers had no way to swap the registry.
Documented + fixed in PR2-A; the harvest test at `test/substrate/runtime/supervisor.test.ts`
(`'plugin-author Layer composition adds a custom-kind sink the supervisor harvests through'`) pins
the invariant.

---

## Cross-process protocol

Three on-disk artifacts; one liveness predicate.

| Artifact               | Owner module                                              | Purpose                                                                                                 |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `stack.lock` (O_EXCL)  | `substrate/runtime/cross-process/stack-lock.ts`           | Single-supervisor-per-stack mutex. Holds owner PID + startTime.                                         |
| `roster.json`          | `substrate/runtime/cross-process/roster.ts`               | Cross-stack process roster — which stacks are live, on which host, owned by which PID.                  |
| `snapshot.reservation` | `substrate/runtime/cross-process/snapshot-reservation.ts` | Cross-process O_EXCL on `capture` / `restore` / `prune` so concurrent snapshot is structurally refused. |

Predicate: PID + startTime liveness (`substrate/runtime/cross-process/liveness.ts:115-132`).
Foreign-host PIDs are conservatively-alive (NFS-safe).

ONE atomic-write primitive (today 3 duplicates exist — substrate triage will consolidate; see
STYLE_GUIDE §17). ONE cross-process lock primitive (the typed `CrossProcessLock` Effect Service —
but currently the real flock impl lives separately and the typed service has only an in-process
Layer; substrate triage will wire — see STYLE_GUIDE §18 / Open slot O18 below).

---

## Plugin start bodies and substrate services

Public plugin `start` bodies receive resolved cross-plugin dependencies as the second callback
argument. Substrate services still come from `Effect.gen`'s R-channel:

```ts
start: (_ctx, { signer }) =>
	Effect.gen(function* () {
		const runtime = yield* ContainerRuntimeService;
		const identity = yield* IdentityContext;
		const registry = yield* StrategyRegistryService;
		// `signer` is the resolved value from `dependsOn: { signer }`.
		// ...
	});
```

No stub helpers. No `acquireXxxFromCtx(...)` indirection. The supervisor's wiring Layer satisfies
the requirements.

Cross-plugin references in public plugin code use `definePlugin({ dependsOn })`; dependency values
come through the `start(deps)` callback. Do not add alternate dependency-read paths or engine
adapters.

---

## OnChainArtifactPublisher (OCA)

Pattern: `cache → verify(cached) → produce → register`. Substrate primitive at
`primitives/on-chain-artifact.ts` + `substrate/runtime/on-chain-artifact/`.

Exemplary consumers (study before adding a third):

- `plugins/package/mode-local.ts:255+` — `namespace: 'package'`, content-hash from
  `(sourceHash, publisherAddress)`, 5-phase produce (scrub → build → publish-tx → wait → parse).
- `plugins/coin/mint.ts:223+` — `namespace: 'coin-mint'`, content-hash from
  `(treasuryCapId, recipient, amount)`, produce builds `0x2::coin::mint_and_transfer<T>` tx.

Typed seam for the produce body is `ChainOperation<Produced>` at
`substrate/runtime/on-chain-artifact/chain-operation.ts` — `sui-tx` / `shell-oneshot` /
`register-only` variants (O1 closed in PR1-E). Walrus + seal + deepbook produce bodies adopt the
`shell-oneshot` or `sui-tx` variant in PR3.

---

## Composite refusal at TYPE level

Mode-narrowed factory namespaces: `walrus.localOf(sui)` is the only valid local Walrus call;
`walrus()` on a fork-typed branch is a compile error. Similarly
`sealFor(forkNetwork).localKeygen(...)` is a compile error.

Mechanics: return-position phantom witnesses + `Exclude<RequiredWitnesses, ProvidedWitnesses>`
(`api/witness.ts`, `substrate/witness.ts`).

The branded structured-error machinery surfaces composition mistakes at the `defineDevstack(...)`
call-site argument:

- `__MissingProvidersError<Missing>` — names missing tag-id literal.
- `__SiblingHashConflictError<G>` — names conflicting group key.
- `__UnsatisfiedWitnessesError<W>` — names unfulfilled witness contract.

Per PHASE-3-NOTES, this is the strongest part of the type system. Three `@ts-expect-error`
directives in `examples-test/complex.ts` verify this on every typecheck.

**Witness pattern is defined but unused by real plugins** (only `samples/composite-plugin.ts`).
Either adopt in walrus/seal (where fork-mode refusal lives), or remove and update architecture
Tension 11. **TBD — Open slot O17.**

---

## Closed projection field list

`SubscribableState` (`substrate/projection.ts:99-119`) carries exactly:

```ts
{
	(identity, cycle, rows, endpoints, errors, lastEvent, stackBuild);
}
```

Adding a field requires updating `__ProjectionFieldsClosed` and surfaces as a TS error at the wiring
site. TUI's `__TuiDisplayVocabClean` is a second-layer guard.

`Row` (the per-plugin row inside `state.rows`) carries display state. `Row.logTail` is the bounded
ring buffer the LogPane reads. **Do NOT add `Row.title` / `Row.primary` / `Row.extras` /
`Row.buildLog` / `Row.logs`** — these are stale notions from earlier drafts.

The CODE (`substrate/projection.ts`) is the source of truth for the closed projection field set. If
you need to amend the shape, update both the code AND this doc in the same change — they must not
split.

---

## Apps NEVER import devstack

Apps (dapp-kit, user code shipping to production) MUST NOT import from
`@mysten-incubation/devstack`.

Runtime values flow via:

1. The on-disk manifest (`<runtimeRoot>/.devstack/stacks/<stack>/manifest.json`), discovered by
   `build-integrations/runtime/discover.ts`.
2. Codegen-emitted files in `src/generated/*`.
3. Env vars (`DEVSTACK_STATE_DIR`, `DEVSTACK_MANIFEST_PATH`, etc. — registered in `vitest/env.ts`).
4. The typed global bridge slot (`__devstackDAppKit__` — owned by
   `build-integrations/vite/dapp-kit-slot.ts`).

L5 build integrations are the only seam. Devstack is dev-tooling, not app-runtime.

**Known boundary violation flagged for cleanup:** today four build integrations (vite, vitest,
playwright, browser) re-implement manifest discovery / decode / cold-start / dapp-kit-slot instead
of delegating to `build-integrations/runtime/`. Vite reads from the wrong path
(`~/.devstack/<app>/<stack>/...`) instead of cwd-walkup (`<cwd>/.devstack/stacks/<stack>/...`) —
release blocker per `build-integrations.md`.

---

## Surfaces are symmetric — `CommandPublisher` + `EventSubscriber` only

Both CLI and TUI subscribe to typed `EngineEvent` and publish typed `EngineCommand` values via the
same seams. No surface imports from `plugins/`, `orchestrators/`, or `runtime/docker/`. The TUI's
only non-projection import outside substrate is the cascade-formatter — and that is documented
surface-shared.

Today's bin entry (`cli/main.ts`) bypasses the dispatcher for the `up` verb — known issue per
`notes/reviews/surfaces.md`. Either route `up` through the dispatcher OR document the parser split
as intentional.

---

## Build integrations — `runtime/` is the substrate

`build-integrations/runtime/` owns:

- `discoverManifestPath` (env > override > cwd-walkup precedence)
- `readStackContext` (decode + project to `StackContext` w/ `EndpointRegistry`)
- `coldStartUrl` (conventional-route fallback; route table as PARAMETER, not hardcoded)
- `ManifestDiscoveryError` / `ManifestShapeError` / `NoConventionalRouteError` (plain-class errors
  per build-integration's sync-API discipline)

Other integrations MUST delegate. Today vite/vitest/playwright/browser each reimplement — release
blocker; see STYLE_GUIDE §7 / Open slot O7.

Only `build-integrations/runtime` synchronous reader errors use plain `Error` subclasses. They are
sync-blocking app startup reads, so callers use plain `try` / `catch`. Per-integration Vite, Vitest,
Playwright, and Browser errors may use `Data.TaggedError` for integration-specific failures; they
still delegate manifest discovery/shape/cold-start behavior to `runtime/`.

---

## Substrate primitives roster

Current substrate primitives (`src/substrate/runtime/` + `src/primitives/`):

| Primitive                                                       | Location                                                                                                                          | Status              | Notes                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler / dep-graph / lifecycle SM                            | `substrate/runtime/lifecycle/{dep-graph,state-machine,ready-gate,selective-restart,signals,watch-attribution,plugin-registry}.ts` | OK                  | Selective-restart slice math is pure data.                                                                                                                                                                                                                                                                    |
| Dependency reader (`start(ctx, deps)`)                          | `substrate/plugin.ts` (type) + `substrate/runtime/lifecycle/plugin-registry.ts` (impl)                                            | OK                  | Plugin bodies receive resolved dependency values in the authored `dependsOn` shape. The registry still guards runtime reads by normalized resource id so cast escapes cannot read undeclared upstreams.                                                                                                       |
| Event bus + command channel                                     | `substrate/events.ts` + supervisor wiring                                                                                         | OK                  | Closed sums, exhaustive switches.                                                                                                                                                                                                                                                                             |
| Atomic write                                                    | `substrate/runtime/atomic-write.ts`                                                                                               | CANONICAL           | Single owner for both surfaces: `atomicWriteFile`/`atomicWriteJson` (Effect/FileSystem, used by state-store + cache + manifest) and `atomicWriteFileSync`/`atomicWriteJsonSync` (`node:fs` sync, used by the cross-process modules that hold `stack.lock` and must keep their critical section non-yielding). |
| Cross-process lock                                              | `substrate/runtime/cross-process-lock.ts` (typed service + Layers) + `cross-process/stack-lock.ts` (O_EXCL impl)                  | WIRED               | `layerCrossProcessLockFlock` adapts `acquireStackLock` (O_EXCL + PID/start-time liveness) onto the typed `CrossProcessLock` service; consumed by state-store / cache / lifted-sibling registry. `layerCrossProcessLockInProcess` is the test-only in-process semaphore.                                       |
| State store                                                     | `substrate/runtime/state-store/`                                                                                                  | OK                  | Typed `StateKey<T>` + on-disk JSON.                                                                                                                                                                                                                                                                           |
| Cache                                                           | `substrate/runtime/cache/`                                                                                                        | OK                  | Content-addressed image cache; `get` / `put` / `lookup` with cross-process lock + atomic write.                                                                                                                                                                                                               |
| Lifted-sibling registry                                         | `substrate/runtime/lifted-sibling-registry/`                                                                                      | OK                  | Compile-time `__SiblingHashConflictError`.                                                                                                                                                                                                                                                                    |
| Port broker                                                     | `substrate/runtime/port-broker/`                                                                                                  | OK                  | First-class service.                                                                                                                                                                                                                                                                                          |
| Lease broker                                                    | `substrate/runtime/lease-broker/`                                                                                                 | OK (PR1-B)          | Generic per-key serialization keyed by opaque `LeaseKey`. Scope-bound release (no explicit `release()` method); FIFO blocking `acquire` + non-blocking `tryAcquire`. Substrate-blind. Consumed by `plugins/account/lease.ts` (O11 closed).                                                                    |
| Strategy registry                                               | `substrate/runtime/strategy-registry/`                                                                                            | OK                  | Capability-keyed pub/sub.                                                                                                                                                                                                                                                                                     |
| Scoped Ref-Map (generic)                                        | `substrate/runtime/scoped-ref-map/`                                                                                               | OK (PR1-C)          | Name-blind `defineScopedRefMap<K, V>(name)` factory: each call returns a typed `Context.Service` + scope-bound Layer + `changes` Stream. L2 plugins instantiate this for their domain via the wrapper-service pattern (Sui-coin's `CoinRegistry`, Move-package's `PackageRegistry`).                          |
| ~~Per-stack registry (sui/move legacy)~~                        | ~~`substrate/runtime/per-stack-registries/`~~                                                                                     | DELETED (PR1.5-B/C) | Replaced by L2 wrapper-service Layers around `defineScopedRefMap`: `plugins/coin/registry.ts` + `plugins/package/registry.ts`. Substrate stays name-blind.                                                                                                                                                    |
| Managed containers                                              | `substrate/runtime/managed-container.ts`                                                                                          | OK                  | Canonical helper for long-running managed container labels, span attributes, and `ContainerRuntimeError` projection. Plugins own domain error messages, but no longer hand-roll `{ app, stack, plugin, role }` + `runtime.ensureContainer(...).pipe(Effect.catch(...))`.                                      |
| OnChainArtifactPublisher                                        | `primitives/on-chain-artifact.ts` + `substrate/runtime/on-chain-artifact/`                                                        | OK (PR1-E)          | Pattern: cache → verify → produce → register. `ChainOperation<Produced>` typed seam in `chain-operation.ts` — `sui-tx` / `shell-oneshot` / `register-only` variants compile to the spec's `produce` Effect (O1 closed).                                                                                       |
| Stage-and-swap                                                  | `substrate/runtime/stage-and-swap/`                                                                                               | OK (PR1-E)          | Lifted from snapshot orchestrator (O14 closed). Snapshot keeps a thin forwarder at `orchestrators/snapshot/stage-and-swap.ts` pending PR3 consumer migration.                                                                                                                                                 |
| Host-tree tar                                                   | `substrate/runtime/host-tree-tar/`                                                                                                | OK (PR1-E)          | System-`tar`-backed `Stream<Uint8Array>` round-trip with mode-bit preservation (O21 closed). Snapshot's `tarHostTree` / `untarHostTree` STUBs migrate in PR3.                                                                                                                                                 |
| ContainerRuntime image ops                                      | `contracts/container-runtime.ts` + `runtime/docker/image.ts`                                                                      | OK (PR1-D)          | `saveImage(ref) → Stream<Uint8Array, ...>`, `loadImage(tar) → ImageRef`, `tagImage(src, newTag)` atomic tag move (O22 closed).                                                                                                                                                                                |
| ContainerRuntime exec                                           | `contracts/container-runtime.ts`                                                                                                  | OK (PR1-D)          | `exec(handle, argv, opts?)` with `ExecOptions` (`user`, `env`, `workdir`) (O9 closed).                                                                                                                                                                                                                        |
| CacheService wired                                              | `runtime/docker/service.ts` + `substrate/runtime/cache/`                                                                          | OK (PR1-D)          | `ensureImageCached` wired into ContainerRuntime impl.                                                                                                                                                                                                                                                         |
| perNameLock                                                     | `runtime/docker/container.ts`                                                                                                     | OK (PR1-D)          | `acquirePerNameLock` + scope-bound release; invariant honored.                                                                                                                                                                                                                                                |
| sui-execute                                                     | `substrate/runtime/sui-execute/`                                                                                                  | OK (PR1-E)          | L1-adjacent — blessed Sui-aware substrate helper (architecture exception, documented in module header). Consumed by `package` publish-executor + `action` execute in PR3.                                                                                                                                     |
| Composite errors — `ForkIncompatibleError`                      | `substrate/runtime/composite-errors.ts`                                                                                           | OK (PR1-E)          | Single canonical shape via `Schema.TaggedErrorClass` (O3 closed). Plugin-side duplicates in `walrus/errors.ts` + `seal/errors.ts` pending PR3 delete.                                                                                                                                                         |
| Manifest envelope                                               | `substrate/manifest.ts` + `substrate/runtime/manifest/`                                                                           | OK                  | Schema-decoded; envelope is name-blind.                                                                                                                                                                                                                                                                       |
| Identity                                                        | `substrate/identity.ts` + `substrate/brand.ts`                                                                                    | OK                  | Branded constructors reject malformed values.                                                                                                                                                                                                                                                                 |
| Paths                                                           | `substrate/runtime/paths.ts` (`StackPathsService`)                                                                                | OK                  | One source for env > config > default.                                                                                                                                                                                                                                                                        |
| Config validation                                               | `substrate/runtime/config-validation.ts`                                                                                          | OK                  | Name-blind `ConfigIssue` helpers. Plugins own concrete tags via `defineConfigError(tag)`; factory/boundary validators throw or fail with plugin-tagged config errors instead of hand-rolled message checks.                                                                                                   |
| Runtime decode                                                  | `substrate/runtime/runtime-decode.ts`                                                                                             | OK                  | Canonical boundary decode helpers for JSON text and unknown SDK/RPC values. Cross-process readers, cache/state reads, and plugin RPC probes project parse/decode failure through one `RuntimeDecodeIssue` shape instead of hand-rolled `JSON.parse` / `Schema.decodeUnknown*` blocks.                         |
| Retry policy                                                    | `substrate/runtime/retry-policy.ts`                                                                                               | OK                  | Shared schedule constructors for request retry/backoff. Plugins select a profile but do not hand-roll `Schedule.exponential(...).pipe(Schedule.jittered, Schedule.both(...))`.                                                                                                                                |
| HTTP probes                                                     | `substrate/runtime/http-probe.ts` + `substrate/runtime/probes.ts`                                                                 | OK                  | Endpoint readiness is "URL + timeout/interval + optional response validator"; plugins no longer own bespoke socket/HTTP polling loops.                                                                                                                                                                        |
| Process supervisor                                              | `substrate/runtime/process-supervisor.ts`                                                                                         | OK                  | Shared child-process types, spawn adapter, exit/error readiness race, exit-status description, and SIGTERM-to-SIGKILL teardown. Host-process plugins do not reimplement process lifecycle plumbing.                                                                                                           |
| Observability — `Logger`                                        | `substrate/runtime/observability/logger.ts`                                                                                       | WIRED               | Buffered plugin log sink. Long-running process output flows through `observeProcessLines(...)`; one-shot capture remains `subprocess-capture.ts`. Plugin log messages are stable event text; dynamic values belong in structured fields / annotations for renderers to present.                               |
| Observability — process line helpers                            | `substrate/runtime/observability/process-lines.ts`                                                                                | OK                  | Shared UTF-8 line splitting and stdout/stderr observation. L2/L1 callers do not reimplement `decodeText + splitLines` when routing child-process logs.                                                                                                                                                        |
| Observability — `SpanAttr`                                      | `substrate/runtime/observability/spans.ts`                                                                                        | WIRED               | Canonical key vocabulary for touched span/log annotations. New structured fields go through `SpanAttr`; remaining free-form historical keys migrate on touch.                                                                                                                                                 |
| Observability — `LifecycleFact`                                 | `substrate/lifecycle.ts`                                                                                                          | IN-FLIGHT (PR2-A)   | Interface declared; zero use sites today. PR2-A wires or drops.                                                                                                                                                                                                                                               |
| Observability — cascade formatter                               | `substrate/runtime/observability/cascade-formatter.ts`                                                                            | OK                  | Walks `Cause` by `_tag`; never imports concrete error classes.                                                                                                                                                                                                                                                |
| Observability — `PluginErrorContribution` + `FormatterRegistry` | `substrate/plugin.ts` + `substrate/runtime/observability/`                                                                        | IN-FLIGHT (PR2-A)   | `*_ERROR_TAGS` arrays in 10 plugins are the contributors; PR2-A's supervisor harvest loop wires them into the cascade-formatter registry.                                                                                                                                                                     |
| `CapabilitySinks` kind→sink registry                            | `substrate/runtime/supervisor.ts` (target)                                                                                        | IN-FLIGHT (PR2-A)   | Inverts supervisor's hardcoded contract dispatches (`supervisor.ts:35-40,285-312`).                                                                                                                                                                                                                           |
| Subprocess capture                                              | `substrate/runtime/observability/subprocess-capture.ts`                                                                           | OK                  | `CaptureError` shape aligns with cascade-formatter fields.                                                                                                                                                                                                                                                    |
| Supervisor                                                      | `substrate/runtime/supervisor.ts`                                                                                                 | LEAKY               | Still imports 6 named capability-decl modules. ~960 LOC — internal sub-module split recommended. PR2-A's `CapabilitySinks` inversion is the unblock.                                                                                                                                                          |

**TBD (Open slots):** the following are pending substrate work:

- O19: image-override registry to replace env-var sniffing (architecture-mandated).
- O20: minimatch / thick-watcher primitive (today `exactPrefixMatch` fallback).

---

## Orchestrator boundaries

Three L3 orchestrators exist; all consume capability decls + L1 adapters; none import L2 plugin
internals.

| Orchestrator              | Walks                | Refuses                                                                                                                                                      |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orchestrators/snapshot/` | `SnapshotableDecl[]` | empty identity (today silently passes — release blocker per orchestrators review); concurrent capture (via `snapshot.reservation`)                           |
| `orchestrators/router/`   | `RoutableDecl[]`     | HTTP/TCP wireProtocol mismatch with entrypoint family; cross-stack TCP port collision; collision on `(entrypoint, hostname)` for HTTP / `entrypoint` for TCP |
| `orchestrators/codegen/`  | `CodegenableDecl[]`  | outputPath collision; emitterName collision across non-`package` decls                                                                                       |

Endpoint ownership rule: `RoutableDecl` + `RouterService.contributeRoute(...)` is the authoritative
public endpoint path for in-stack services. Resolved-value URL projection is a fallback only for
plugins with no routable contribution, such as live/external network modes. Plugins may keep direct
probe, loopback, or `hostGateway` URLs on their resolved values for sibling bootstrapping, but those
fields are not public endpoint declarations once the plugin contributes a route.

**Known name leak (release blocker per orchestrators review):**
`orchestrators/router/entrypoints.ts:DEFAULT_ENTRYPOINTS` hardcodes plugin names (`wallet-app`,
`walrus-node-0`, `seal-key-server`, `postgres-tcp`, `redis-tcp`). The orchestrator is
"plugin-name-agnostic" but the package owns a name-laden default. Fix: move each block of
entrypoints next to its plugin and compose the registry at supervisor boot.

---

## Plugin A ↔ Plugin B coupling — known design gap (Open slot O5 still violated)

The L2 invariant "Plugin A may NOT import from Plugin B" is broken at the Coin↔Package boundary and
is **MORE visible after PR1.5**:

- `plugins/package/coin-discovery.ts` owns the `PublishReceipt` + `PublishObjectChange` shapes
  (PR1.5 moved them out of `package/index.ts`).
- `plugins/coin/discovery.ts` imports `PublishObjectChange` + `PublishReceipt` from
  `../package/index.ts` (which re-exports from `coin-discovery.ts`).
- `plugins/package/index.ts` consumes coin-discovery via its own internal accumulator — the package
  barrel re-exports `PublishReceipt` / `PublishObjectChange` because external siblings (coin,
  codegen) read them off the package's surface.

The right fix is a substrate-raised **`PublishReceiptEmitted` event** that the coin plugin
subscribes to — the `PublishReceipt` shape lives at substrate/contracts, package raises the event
after a successful publish, coin discovers via subscription rather than a direct import.

This is pending either:

1. **PR2-A's harvest loop** completing (the supervisor's plugin-contribution scan could provide the
   event seam as a side-effect of broader wiring).
2. **A future event-bus primitive** at substrate (`substrate/runtime/event-bus/`) generic over event
   shapes — currently the substrate has command + lifecycle channels but no plugin-author-extensible
   event seam.

Documented as a known design gap so future agents understand: the Coin/Package cross-import is
intentional in the interim, NOT a missed cleanup; do NOT add a third plugin's cross-import in the
same shape.

---

## The 5 layers — one-page summary card

```
L0 substrate         — name-blind kernel: events/commands, paths, atomic-write,
                       cross-process protocol, OCA, port-broker, state-store, cache,
                       strategy-registry, lifted-sibling registry, manifest envelope.
                       NO plugin names. NO capability decl names (today: leaky).

L1 runtime adapters  — Docker (reference), in-process, Traefik reverse-proxy.
                       Generic per backend kind. Each replaceable.

L2 plugins           — sui, postgres, walrus, seal, account, faucet,
                       package, coin, wallet, action. Plus renderer plugins.
                       (deepbook slot pending PR3 fresh rebuild.)
                       Plugin A ≠ Plugin B (no direct imports). Cross-plugin refs
                       go through resource refs via `dependsOn`.

L3 orchestrators     — snapshot, router, codegen, network resolver, manifest writer,
                       watch dispatcher. Each walks capability decls; never names a service.

L4 surfaces          — CLI, TUI, programmable API. CommandPublisher + EventSubscriber only.
                       Pluggable Renderer contract.

L5 build integrations— vite/vitest/playwright/browser presets. Apps consume only L5.
+ apps                 Apps NEVER import devstack engine. Runtime values flow via
                       codegen + manifest + env + typed global slot.
```

---

## Cutover gate — minimal viable

Per `notes/parity-matrix.md`, no row marked CLOSE may remain when cutover executes. Top 5 cutover
blockers (priority order, from parity-matrix):

1. **`up`-time CLI verb wiring** — `cli/main.ts:makeLightDeps` returns buffered publishers; non-`up`
   verbs dispatch but never reach a running supervisor.
2. **`doctor` probes are empty** — env / ports / locks / fork probes must re-wire (currently
   `probes: []`).
3. ~~**`Stack` lacks a runnable handle**~~ — RESOLVED: `runStack(stack, opts?) → RunHandle` lands at
   `src/api/run-stack.ts`; shared substrate-Layer composition at `src/substrate/runtime/run.ts`
   consumed by CLI + library.
4. **`Action.body` sugar regression** — arena hand-rolls 160 lines; need
   `ctx.signAndExecute(account, build)` substrate helper.
5. **`apply` + `stack {list,new,use,drop,drop-fork}` + `wipe` CLI verbs missing** — CI/multi-stack
   flows.

The package cannot ship while these CLOSE rows are open. WIN / PARITY / ACCEPT_GAP rows are fine.

---

## When the rules above are wrong

Process for changing a load-bearing boundary:

1. Find the rule's citation in `notes/reviews/*.md` or `notes/redesign/architecture.md`.
2. Open a PR that updates THIS doc with the new boundary + justification.
3. Run the migration (lift code into / out of the affected layer; consolidate / split files; etc.).
4. Update `STYLE_GUIDE.md` if the rule has a code-level pattern.
5. Update `notes/parity-matrix.md` if the rule moves a row's verdict.

DO NOT silently violate. DO NOT codify violations as "the new convention" without an explicit PR.

---

## Citations

The 6-layer model + 9 capability contracts come from `../devstack/notes/redesign/architecture.md`.
Specific section anchors:

- L0–L5 definitions: § "Layer model" (lines 49-291)
- Component placement table: § "Component placement" (lines 294-340)
- 11 capability contracts (9 declared today): § "Capability contracts (conceptual)" (lines 342-994)
- Cross-process protocol: § "Cross-process safety protocol" (lines 1431-1610)
- Tensions resolved: § "Tensions resolved" (lines 1871-2032) — especially Tension 11 (composite
  refusal as type vs runtime).
- Substrate violations + structural prevention: § "Substrate violations: structural prevention"
  (lines 2033-2113).

Specific implementation findings come from:

- `notes/reviews/substrate.md` — boundary leaks (per-stack-registries/coin.ts + package.ts),
  atomic-write duplication, CrossProcessLock wiring gap.
- `notes/reviews/runtime-docker.md` — typed-error envelope, classifier centralization,
  `decideRunAction` purity, `CacheService` phantom, `perNameLock` unused, `followLogs` scope.
- `notes/reviews/orchestrators.md` — snapshot stubs (release blocker), router `DEFAULT_ENTRYPOINTS`
  name leak (release blocker), codegen stage-and-swap absence.
- `notes/reviews/surfaces.md` — closed-field discipline, `up` bypassing dispatcher, exec exit-code
  drop.
- `notes/reviews/build-integrations.md` — `runtime/` consolidation (release blocker), manifest-path
  divergence (release blocker), `dappKitConfigPath` unwired.
- `notes/reviews/stable-plugins.md` — Plugin A ↔ Plugin B (Coin/Package) coupling, `ctx.get` cast
  escape, container ensure boilerplate, `containerExec` missing.
- `notes/reviews/cross-cutting.md` — error-model split (3 styles), `ForkIncompatibleError`
  collision, observability orphans.
- `notes/api-comparison.md` — sugar debt + S1-S12 fixes.
- `notes/parity-matrix.md` — the cutover gate.
- `PHASE-3-NOTES.md` — type-system findings (load-bearing for the validation machinery).
