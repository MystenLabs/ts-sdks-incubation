# Devstack architecture

The boundaries below are load-bearing. A violation either fixes the code OR — if the boundary is
genuinely wrong — produces a PR that updates this doc with justification first.

Companion: `STYLE_GUIDE.md` for code-level patterns.

---

## Layers

Every component lives in exactly one layer. The allowed-imports column is the contract.

| Layer                            | Contains                                                                                                                                                                                                                                                                   | Imports from                                                                                                                     | Never imports from                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **L0 substrate**                 | Kernel: scheduler, lifecycle SM, event/command channels, brokers (port/lease/lock), atomic-write, cache, cross-process protocol, decode helpers, retry policy, process supervisor, observability primitives, manifest envelope, ArtifactPublisher. Name-blind.             | External libs only (`effect`, `@effect/*`, Node stdlib).                                                                         | L1+. Plugin or capability-decl names.                       |
| **L1 runtime adapters**          | `ContainerRuntime` (Docker). One backend; a swap is a major rewrite, not a layer re-point. The `ContainerRuntimeService` re-export shim exists so the public API doesn't name `runtime/docker/` directly, but internal callers reach `runtime/docker/service.ts` directly. | L0.                                                                                                                              | L2+. Named plugins.                                         |
| **L2 plugins**                   | sui, postgres, walrus, seal, account, faucet, package, coin, wallet, action, deepbook, host-service. One folder each exposing `definePlugin({...})`. (TUI renderers live in L4 surfaces, not L2.)                                                                          | L0, L1, other plugins through public resource refs at factory boundaries (never internal modules).                               | Other plugins' internal modules.                            |
| **L3 orchestrators**             | snapshot, router (Traefik file-provider), watch-dispatcher, network resolver, manifest writer, codegen. Each walks a registry of plugin capability contributions; never names services.                                                                                    | L0, L1, capability decls from `contracts/`.                                                                                      | L2 internals, named plugins, hardcoded paths.               |
| **L4 surfaces**                  | CLI (`surfaces/cli/`), TUI (`surfaces/tui/`), programmable API, bin entry (`cli/main.ts`). Symmetric peers: subscribe to typed event stream + publish typed commands.                                                                                                      | L0 (events/commands/manifest schema), L3 capability decls + manifest writer output. Cascade-formatter.                           | L1 directly, any L2 module, any direct engine method calls. |
| **L5 build integrations + apps** | `build-integrations/{vitest,playwright,runtime}/` — host-facing integration packages. Example apps.                                                                                                                                                                        | Shared `build-integrations/runtime/` helpers, on-disk manifest, codegen-emitted files, env vars, typed global Playwright bridge. | L0–L3 directly. Engine subscription.                        |

### Layer composition lives at L3, not L0

L0 imports external libs only. Layer-composition seams (`runStackEffect` and friends that assemble
L0+L1+L2 into a runnable stack) are L3 work in `orchestrators/runtime-composition.ts`. They can't
live in `substrate/` because they import L1 by definition. If a "substrate" file imports
`runtime/docker/`, it's mislocated.

**Built-in defaults composition seam.** `orchestrators/built-in-plugin-layers.ts` and
`orchestrators/runtime-composition.ts` are the two L3 files that bind the built-in plugin set's L2
modules into the L3 orchestrator/runtime layer. They are consumed by `cli/main.ts` (the L4 bin
entry) and `api/run-stack.ts` (L4 library-embedder surface). L3 importing L2 in these two files is
permitted because the composition seam is exactly what these files are for; new L2 dependencies in
adjacent L3 modules need to route through this seam, not bypass it. The plugin-author equivalent —
when an embedder wants to extend the runtime context without forking the built-in composition — is
`RunStackOptions.extendContext`, which layers extra services into the `pluginContext` plugins reach
during `start`.

### Substrate name-blindness

Substrate code must not mention `walrus`, `sui`, `seal`, `wallet`, `account`, `coin`, `package`,
etc. Plugin-domain shapes live at L2. Per-stack registries that need plugin-domain keys are L2
wrapper services around the generic `defineScopedRefMap<K, V>(name)` primitive.

The Sui-named SDK-boundary helpers (sign + execute + envelope project, Move build + summary
projection, ledger object-ref) now live under `plugins/sui/{exec,move,ledger}` as part of the
simplification, so they no longer need a substrate name-blindness carve-out. New L1-adjacent
exceptions need explicit justification in this section.

The supervisor's projection vocabulary carries one additional documented exception: projection-key
prefixes `account/` and `package/` are named in the closed projection field shape at
`substrate/projection.ts` (and the `'account/'` prefix is matched in
`substrate/runtime/supervisor/start-supervisor.ts`'s `pendingAccountProjection` declaration) because
the supervisor maintains the closed-set projection registry as part of the engine's read-model. The
plugin-domain names are a closed exception, not a contract for new prefixes; new projection kinds
add their key under the existing prefix scheme rather than expanding the allowlist.

`test/substrate/name-blindness.test.ts` enforces the rule + tracks the small permanent allowlist
(including the `account/` / `package/` / `wallet/` projection-key prefix carve-out above).

### `ContainerRuntimeService` re-export indirection

The root barrel re-exports `ContainerRuntimeService` from `substrate/runtime/container-runtime.ts` —
a thin shim that itself re-exports from `runtime/docker/service.ts`. The shim exists so the public
API doesn't name `runtime/docker/` directly. The abstraction is one consumer deep: internal callers
(plugins, orchestrators) import from `runtime/docker/service.ts` directly. L1 is Docker — a backend
swap (podman, firecracker) is a major rewrite of the docker adapter, not a layer re-point.

---

## Capability contracts

Declared in `src/contracts/` as a discriminated `CapabilityDecl` union (one decl per file).

| Contract                | File                                | Purpose                                                                                                                                                                                                           | Used by                                                               |
| ----------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **ContainerRuntime**    | `contracts/container-runtime.ts`    | Docker-like backend: ensure/start/stop/commit/build/network/volume/logs/exec/save/load/tag.                                                                                                                       | Plugins managing long-running containers.                             |
| **Snapshotable**        | `contracts/snapshotable.ts`         | Capture/restore: `managedContainers` label tuples + host paths + identity guard + hooks.                                                                                                                          | Stateful plugins.                                                     |
| **Routable**            | `contracts/routable.ts`             | HTTP/TCP route contribution: entrypoint + dispatch id + wireProtocol + upstream resolver.                                                                                                                         | Plugins exposing endpoints.                                           |
| **Codegenable**         | `contracts/codegenable.ts`          | Emitter contribution. Optional `aggregate?: { bucket, project }` folds exports into a shared file (e.g. `accounts.ts`). Orchestrator treats `bucket` as opaque.                                                   | Every L2 plugin.                                                      |
| **ChainProbe**          | `contracts/chain-probe.ts`          | Chain reachability + facts (lenient verify pattern).                                                                                                                                                              | One per chain.                                                        |
| **StrategyContributor** | `contracts/strategy-contributor.ts` | Pluggable strategy injection.                                                                                                                                                                                     | Faucet strategies, account variants, custom plugin extensions.        |
| **Projection**          | `contracts/projection.ts`           | Read-model update emitted after acquisition. Shorthand `projection({ kind, key, payload })` stamps `tag` + `at`; the verbose `projection({ event: { tag: 'projection.updated', ... } })` form gives full control. | Plugins publishing UI/persisted state independent of strategy values. |

Infrastructure contracts (outside the capability-decl union):

- `Renderer` (`contracts/renderer.ts`) — subscribable-state-driven; substrate of L4 surfaces.
- `PluginExpander` (`contracts/plugin-expander.ts`) — compose-time plugin-rewrite hook. A plugin
  that cannot know its final `dependsOn` tuple at factory-call time (canonical case: wallet's
  `accounts: 'all'`) returns a PLACEHOLDER member with a `PLUGIN_EXPANDER` symbol-keyed closure
  attached. The composer (`api/define-devstack.ts`) detects the symbol, calls the expander with the
  full composed-member tuple, and substitutes the result. Substrate-owned symbol; the composer never
  imports any plugin module to perform the rewrite. Compose-time only — distinct from the runtime
  contribution-dispatch path (the supervisor replaying each plugin's buffered `ctx.*` emissions
  through the `ContributionDispatcher`) which fires AFTER plugin acquire.

### Funding contribution invariant

`AccountFundingStrategy` flows through the substrate's strategy registry via
`StrategyContributorDecl`. A plugin that wants to FUND an account at acquire-time MUST emit its
strategy with `ctx.provides(decl)` during `start` — the supervisor buffers it and registers it on
the strategy registry when it replays the buffer through the `ContributionDispatcher`. Direct calls
to `fundingStrategy.request(...)` without a sibling `ctx.provides` silently leave the registry empty
and the account starves on a `StrategyNotFoundError` (caught as a no-op for optional per-coin funds
— `plugins/account/funding.ts:510`; the SUI gas-faucet path at `:483` instead fails loudly).

Who contributes:

- **Coin plugins** — `plugins/coin/index.ts` builds a `StrategyContributorDecl` with capability key
  `coinType:<fullCoinType>` for every coin variant that declares `fundingStrategy`. Walrus and Seal
  contribute their WAL/SEAL strategies the same way through the coin barrel.
- **Faucet plugin** — `plugins/faucet/index.ts:defineFaucetStrategy({ chainId, strategy })` builds a
  contributor keyed `faucet:<chainId>` for SUI funding.
- **Custom plugins** — same surface; any plugin's `start` may build a
  `StrategyContributorDecl<Key, Strategy>` and emit it with `ctx.provides(decl)`, and the supervisor
  registers it on replay.

Shape:

```ts
{
	kind: 'strategy-contributor',
	capabilityKey: coinFundingCapabilityKey(resolved.fullCoinType),
	strategy: resolved.fundingStrategy,
	autoMounted: true,
} satisfies StrategyContributorDecl<`coinType:${string}`, AccountFundingStrategy>
```

Consumers (`plugins/account/funding.ts`) read with `registry.get<typeof key, Strategy>(key)` and
treat `StrategyNotFoundError` as "optional faucet is a no-op for this coin". The invariant:
`ctx.provides()` is the **only** way to expose a funding strategy across plugin boundaries —
bypassing it (e.g. a coin plugin calling `fundingStrategy.request` itself, or stashing the strategy
on its resolved value for a sibling to import) breaks the dep-graph-free decoupling that makes
custom funding plugins compose like built-ins.

---

## Plugin-author surface = user-surface

Custom plugin authors must be able to author plugins whose config-site experience is identical to
built-ins. No privileges built-ins have that customs can't replicate.

- `definePlugin({ id, role, section, dependsOn?, start, watch?, pluginKey?, endpointSection?, errorContributions?, keepAliveOnRestore? })`
  is the public authoring API. Contributions are emitted inside `start` via the `ctx.*` verbs —
  there is no `capabilities` field. `id`, `role`, `section`, and `start` are required; `role` is
  `'service' | 'task'` (long-lived host process vs. value-producer reaching `done`) and `section` is
  the dashboard bucket (`'service' | 'package' | 'account' | 'action' | 'app' | 'other'`) the
  supervisor stamps onto every row this plugin emits.
- Capability decl helpers and public contract types are reachable from the root package entrypoint.
- The callable `defineModeNamespace(network)` is available to custom plugins for mode-narrowed
  factories.
- The strategy-registry primitive is open — plugin authors call `defineFaucetStrategy()` or similar
  shapes.

The contribution set is CLOSED: there are exactly five built-in contribution kinds (snapshotable,
routable, codegenable, projection, strategy-contributor), dispatched by the typed
`ContributionDispatcher` (`substrate/runtime/supervisor/contribution-dispatcher.ts`). Custom plugins
do not register new kinds — they emit through the existing `ctx.*` verbs (`ctx.codegen`,
`ctx.endpoint`, `ctx.snapshotExtra`, `ctx.publish`, and `ctx.provides` for strategy contributions)
inside `start`, the same verbs the built-ins use. Embedders that need extra backing services in
scope layer them into `pluginContext` (below) rather than extending the dispatch surface.

For programmatic embedders, `RunStackOptions.extendContext` (`api/run-stack.ts`) is the seam: pass a
`(ctx) => Effect<Context>` to layer additional services on top of the built-in plugin runtime
context before the supervisor sees it.

If you add a built-in feature, ask: can a custom plugin do this? If no, expose the seam.

---

## Plugin start bodies

Public plugin `start` bodies receive resolved cross-plugin dependencies as the SOLE callback
argument. Substrate services come from `Effect.gen`'s R-channel:

```ts
start: (deps) =>
	Effect.gen(function* () {
		const runtime = yield* ContainerRuntimeService;
		const identity = yield* IdentityContext;
		const [sui, signer] = deps; // shape mirrors dependsOn
	});
```

`dependsOn` shape drives the callback-argument shape: tuple → tuple, object → object, single → bare
value. There is no separate `ctx` parameter — supervisor services flow through `yield*`.

No `acquireXxxFromCtx(...)` indirection. The supervisor's wiring Layer satisfies the requirements.

---

## Cross-process protocol

One stack identity maps to `<runtime-root>/stacks/<stack>`. Same stack name = same runtime root,
roster, command channel, snapshots, containers. `devstack up` is the live owner. `devstack apply`
publishes to that owner when the roster says it is live; otherwise falls back to one-shot
supervision.

| Artifact                            | Owner                                                     | Purpose                                                                                             |
| ----------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `stack.lock` (O_EXCL)               | `substrate/runtime/cross-process/stack-lock.ts`           | Short critical-section lock for roster, container-claim, snapshot-reservation, channel-file writes. |
| `roster.json`                       | `substrate/runtime/cross-process/roster.ts`               | Live supervisor roster: PID, host, startTime, heartbeat, intent.                                    |
| `commands.ndjson` / `events.ndjson` | `substrate/runtime/cross-process/command-channel/`        | Filesystem command channel for peer CLI commands.                                                   |
| `snapshot.reservation`              | `substrate/runtime/cross-process/snapshot-reservation.ts` | Cross-process O_EXCL on `capture`/`restore`/`prune`.                                                |

Liveness predicate: PID + startTime (`substrate/runtime/cross-process/liveness.ts`). Foreign-host
PIDs are conservatively-alive (NFS-safe).

`LivenessProbeScope` is a per-sweep Effect Service in the same module: one cache per sweep pass,
keyed on `(pid, startTime)`, so a sweep that inspects N roster rows referencing the same PID forks
the underlying `kill(0)` / `/proc` lookup once rather than N times. Common cases this prevents from
blowing up: a single supervisor parent overseeing many child plugin keys; a process restart where
the new PID is shared by multiple stale roster entries. The scope's lifetime is one sweep — it is
not a persistent cache.

---

## ArtifactPublisher

Pattern: `cache → verify(cached) → produce → register`. Substrate primitive at
`primitives/artifact-publisher.ts` + `substrate/runtime/cache/`. The produce body shape
is plugin-owned — write what fits the on-chain operation.

---

## Mode refusal at the type level

Mode-narrowed factory namespaces: `walrus.localOf(sui)` is the only valid local Walrus call;
`walrus()` on a fork-typed branch is a compile error. Similarly
`sealFor(forkNetwork).localKeygen(...)` is a compile error.

`defineModeNamespace` projects a plugin factory namespace to the branch matching the typed
`NetworkConfig` passed through `defineDevstackWith`. Branches that are not present collapse to
`never`, so illegal factory access fails at the call site.

The branded `__MissingProvidersError<Missing>` surfaces composition mistakes at the
`defineDevstack(...)` argument site. Don't add ad-hoc runtime mode checks the type system could have
caught.

---

## Closed projection field list

`SubscribableState` (`substrate/projection.ts`) carries exactly
`{ identity, cycle, rows, endpoints, accounts, packages, errors, lastEvent, stackBuild }`. Adding a
field requires updating `__ProjectionFieldsClosed` and surfaces as a TS error at the wiring site.
TUI's `__TuiDisplayVocabClean` is a second-layer guard.

`Row` is also closed via `__RowFieldsClosed`:
`{ key, role, status, phase, lastError, logTail, endpoints, selectiveRestartHighlight, section, endpointSection }`.

`Row.section` is plugin-declared at `definePlugin({ section, endpointSection })` time and stamped by
the supervisor at acquire. The renderer reads `row.section` directly; it must not pattern-match on
plugin-name substrings. `RowSection` is
`'service' | 'package' | 'account' | 'action' | 'app' | 'other'`.

The CODE is the source of truth for the closed field set. If you amend the shape, update the doc in
the same change.

---

## Apps never import devstack

Apps (dapp-kit, user code shipping to production) must not import from
`@mysten-incubation/devstack`. Runtime values flow via:

1. On-disk manifest at `<runtimeRoot>/.devstack/stacks/<stack>/manifest.json` (discovered by
   `build-integrations/runtime/discover.ts`).
2. Codegen-emitted files in `src/generated/*`.
3. Env vars (`DEVSTACK_STATE_DIR`, `DEVSTACK_MANIFEST_PATH`, etc.).
4. The typed global bridge slot (`__devstackDAppKit__`).

L5 build integrations are the only seam. Devstack is dev-tooling, not app-runtime.

---

## Surfaces are symmetric

CLI and TUI both subscribe to typed `EngineEvent` and publish typed `EngineCommand` values via the
same seams. No surface imports from `plugins/`, `orchestrators/`, or `runtime/docker/`. The TUI's
only non-projection import outside substrate is the cascade-formatter — documented as
surface-shared.

The bin entry (`cli/main.ts`) keeps `up` as a live attached path and routes the rest through
direct/offline deps. Direct-deps modules under `cli/` (`cli/prune-direct.ts`,
`cli/doctor-probes.ts`, etc.) are L4-adjacent composition infrastructure — they may import L3/L2/L0
barrels because they exist to wire them for the bin entry. The pure surfaces (`surfaces/cli/**`,
`surfaces/tui/**`) may not.

---

## Build integrations — `runtime/` is the substrate

`build-integrations/runtime/` owns:

- `discoverManifestPath` (env > override > cwd-walkup precedence).
- `readStackContext` (decode + project to `StackContext` with `EndpointRegistry`).
- `coldStartUrl` (conventional-route fallback; route table as parameter, not hardcoded).
- `ManifestDiscoveryError` / `ManifestShapeError` / `NoConventionalRouteError` (plain-class errors
  per build-integration's sync-API discipline).

Other integrations must delegate. Vitest and Playwright use the shared runtime
discovery/shape/cold-start primitives.

---

## Orchestrator boundaries

Three L3 orchestrators consume capability decls + L1 adapters; none import L2 internals.

| Orchestrator              | Walks                | Refuses                                                                                                                                                                                                                  |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orchestrators/snapshot/` | `SnapshotableDecl[]` | Empty contributed identity; concurrent capture (via `snapshot.reservation`).                                                                                                                                             |
| `orchestrators/router/`   | `RoutableDecl[]`     | HTTP/TCP wireProtocol mismatch with entrypoint family; cross-stack TCP port collision; collision on `(entrypoint, hostname)` for HTTP / `entrypoint` for TCP.                                                            |
| `orchestrators/codegen/`  | `CodegenableDecl[]`  | outputPath collision; emitterName collision (unless `allowEmitterNameRepetition`). Plugin-name-blind: never branches on `emitterName`. Aggregate projection delegated to plugin via `CodegenableDecl.aggregate.project`. |

**Wipe scope (coupled survivors):** `snapshot.wipe` tears down one `(app, stack)`'s containers,
networks, volumes, and per-stack on-disk state, but PRESERVES the snapshot catalog (`snapshots/`)
**and** the deploy cache (`cache/`) **together** by default. The two ride one flag (`keepSnapshots`,
default true) — there is no asymmetric "keep snapshots, drop cache". This coupling is load-bearing:
an ordinary wipe keeps the live deploy cache so a later restore REUSES it (the deploy ids — package
id, walrus/seal/deepbook objects — survive the teardown rather than re-running with fresh ids). A
hard reset (`keepSnapshots: false`) drops both so a fresh boot re-proves every on-chain artifact
against the next chain.

**Router carve-out:** the router owns its Traefik container lifecycle directly via
`orchestrators/router/traefik-container.ts` (raw `dockerRun(...)` calls) rather than through
`ContainerRuntimeService.ensureContainer(spec)`. It stamps `kind`/`subkind`/`specVersion` labels
instead of the per-stack `app`/`stack`/`plugin`/`role` tuple `EnsureContainerSpec` requires.
Widening L1 for one consumer was rejected.

**Endpoint ownership:** `RoutableDecl` + `RouterService.contributeRoute(...)` is the authoritative
public endpoint path for in-stack services. Resolved-value URL projection is fallback-only — for
plugins with no routable contribution (live/local-rpc network modes). Plugins may keep direct probe
/ loopback / `hostGateway` URLs on resolved values for sibling bootstrapping, but those fields
aren't public endpoint declarations once the plugin contributes a route.

Built-in router entrypoints are plugin-owned: each plugin exports its entrypoint declarations from
its own `routable.ts`; `plugins/router-entrypoints.ts` composes them.

---

## Plugin A ↔ Plugin B coupling

The aspirational rule "Plugin A may not import from Plugin B" admits three universal buses that are
intentional and stay:

- **Sui = chain-universal-bus.** Every chain-side plugin imports `SuiClient` / `SuiSdkShim` /
  `SuiProbeKey` / `suiResource` from `plugins/sui/`. Most imports are type-only.
- **Account = identity-bus.** Every plugin that signs or funds imports `AccountValue` /
  `AccountResourceId` / `TxResult` / `AccountFundingStrategy` from `plugins/account/`.
- **Host-service = endpoint-defaults bus.** Plugins addressing the host-service's routed origin
  (CORS, sibling access) import `HOST_SERVICE_DEFAULT_ENDPOINT_NAME` +
  `HOST_SERVICE_DEFAULT_ENTRYPOINT_PORT` from `plugins/host-service/`.

Two refinements:

1. **Internal-module reach is forbidden.** Cross-plugin imports go through the target's `index.ts`
   barrel — never `../sui/chain-probe.ts`, `../account/service.ts`, etc.
2. **Shared shapes that neither plugin owns** live in `src/contracts/` (the lift for
   `AccountFundingStrategy` killed the Account ↔ Coin / Walrus / Deepbook round-trip).

Do not add a new cross-plugin import outside the three buses without (a) lifting the shared shape to
`src/contracts/`, or (b) introducing a substrate-raised event the consumer subscribes to.

**Pyth is a deepbook implementation detail.** It exists to feed deepbook price oracles and has no
standalone use case for app developers. The deepbook plugin owns its lifecycle; promote to a
top-level plugin only if external market-makers need it.

---

## One-page summary

```
L0 substrate         — name-blind kernel: events/commands, paths, atomic-write,
                       cross-process protocol, artifact publisher, port-broker,
                       cache, strategy-registry, manifest envelope.

L1 runtime adapters  — Docker. One backend. The `ContainerRuntimeService`
                       shim names it for the public API; internal callers
                       reach `runtime/docker/service.ts` directly.

L2 plugins           — sui, postgres, walrus, seal, account, faucet, package,
                       coin, wallet, action, deepbook, host-service.
                       Plugin A → Plugin B goes through index.ts barrels
                       OR substrate contracts. Sui / Account /
                       host-service are documented universal buses.
                       (TUI renderers live in L4 surfaces.)

L3 orchestrators     — snapshot, router, codegen, network resolver, manifest
                       writer, watch dispatcher. Each walks capability decls;
                       never names a service.

L4 surfaces          — CLI, TUI, programmable API. CommandPublisher +
                       EventSubscriber only. Pluggable Renderer contract.

L5 build integrations— vitest/playwright/runtime helpers. Apps consume only
+ apps                 L5. Apps never import devstack engine. Runtime values
                       flow via codegen + manifest + env + typed global slot.
```

---

## When the rules are wrong

1. Find the rule in this document.
2. Open a PR that updates this doc with the new boundary + justification.
3. Run the migration.
4. Update `STYLE_GUIDE.md` if the rule has a code-level pattern.

Do not silently violate. Do not codify violations as "the new convention" without an explicit PR.
