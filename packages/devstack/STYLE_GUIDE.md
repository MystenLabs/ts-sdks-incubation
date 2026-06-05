# Devstack style guide

Code-level patterns. Companion: `ARCHITECTURE.md` for layer / boundary rules.

Rules in this guide are caught at review (when not enforceable by typecheck/lint/build/invariant
test). A violation found during review = fix + codify here.

---

## 1. Effect v4

The `writing-effect` skill is the authority on Effect v4 idioms. When uncertain, defer to
`.repos/effect-v4/` (cloned by `scripts/setup-repos.sh`). A few rules that come up enough to pin
locally:

- `Context.Service<Self, Shape>()(id)` is the substrate primitive form — L0 services use this.
  `Effect.Service` class form is the default at L1+.
- `Schema.Record(keySchema, valueSchema)` is positional, not `{ key, value }`.
- `it.effect` from `@effect/vitest` for Effect-bearing tests; pure-data helpers use plain `it`.
- `it.live` only when the test genuinely depends on wall-clock (filesystem `inotify`, network
  round-trip). Default to `Deferred` + `Effect.yieldNow` patterns to pin ordering without sleeping.
- Read failure values via `Exit.findErrorOption(exit)` when you have an `Exit`. The
  `cause._tag === 'Fail'` pattern is allowed only as a defensive guard at boundary code that may
  receive arbitrary cause shapes.

---

## 2. Tagged errors

Match the style of the subsystem boundary that owns the value:

1. L2 plugins and public contracts → plain structural `_tag` interfaces + factories.
2. Schema-bearing substrate / orchestrator failures → `Schema.TaggedErrorClass`.
3. Runtime adapters, CLI / cross-process / observability, per-integration L5 errors →
   `Data.TaggedError`.
4. `build-integrations/runtime` synchronous reader errors → plain `Error` subclasses.
   Per-integration Vitest / Playwright / Browser errors may use `Data.TaggedError`.
5. Orchestrator failures never raise plain `new Error(...)` — phase classifiers pattern-match by
   tag. `cause instanceof Error && cause.message.includes(...)` in an orchestrator is a violation;
   add a `kind` field to the upstream tagged error and switch on it.

Rules across all four styles:

- **Failed conditions surface as return-channel discriminated unions, not error-channel failures.**
  On-chain outcomes (`$kind: 'Transaction' | 'FailedTransaction'`) are return values the caller
  dispatches on. Tagged errors cover only transport / lifecycle failures (sign refused, RPC
  unreachable, finality timeout). The error channel is for "the operation couldn't proceed"; the
  return channel for "the operation produced an outcome — here's which".
- Phase enums describe WHAT STEP failed, not WHAT KIND OF FAILURE happened. Overloading a phase with
  multiple distinct failure semantics is a violation — split into discrete phases.
- One `_tag` literal per logical error type across the whole package — no duplicates.
- `cause` field: prefer `Schema.optional(Schema.Defect)` where the style permits. Plain-interface
  plugins use `cause?: unknown`.
- Tag naming: PascalCase. Suffix `Error` for "the error a caller catches" (`WalletBootError`,
  `SealError`); unsuffixed for "the failure event variant" (`DaemonUnreachable`).
- Plugin author-facing errors must be surfaceable via `Effect.catchTag` / `catchTags` — never rely
  on `instanceof`.
- Plugins must not silently drop errors. `Schema.decodeUnknownSync(...) as A` bare-cast is banned.
- Boundary decodes use `substrate/runtime/runtime-decode.ts`. Plugin config uses
  `substrate/runtime/config-validation.ts`.

---

## 3. Tests

- Vitest tests live in `packages/devstack/test/` mirroring the `src/` directory structure. Never as
  `*.test.ts` siblings inside `src/`.
- Effect-bearing tests use `it.effect` from `@effect/vitest`.
- Browser / DOM tests opt into `@vitest/browser` per the repo pattern (see `running-vitest` skill).
- The subprocess-runner pattern (`*-runner.cjs` + `*-impl.ts` that spawns a child
  `node --import tsx/esm <impl>.ts`) is forbidden by default. Tests import their implementation
  directly. The only sanctioned exception is per-plugin barrel module-load isolation; write a
  one-line header comment explaining the load-bearing reason or it's a violation.
- Lock-ordering invariants ("router dispatch lock held across the readiness probe") are pinned via
  source-structure tests, not real-time fiber racing. If a lock-state question is more complex than
  a structural check, refactor the locking primitive to an `Effect.Service` and provide a recording
  test Layer.

The "no inline validation in parallel agents" memory directive applies: orchestrators may not run
`pnpm typecheck` / `test` / `build` inside fanned-out agents.

---

## 4. Comments + JSDoc

- **Default: write nothing.** Only add when WHY is non-obvious.
- Never narrate WHAT — well-named identifiers say what.
- Never reference the current PR / task / session / fix in comments.
- Header comments may explain WHY a non-obvious design choice was made: invariants, citations to
  `ARCHITECTURE.md`, why a specific cast / escape-hatch is acceptable.

---

## 5. No scaffold debt

- No phase markers, no `<unresolved-*>` sentinel placeholders, no "will replace once Y lands".
- No `as never` / `as any` / `as unknown as ...` at the user-facing surface. Plugin barrels + `api/`
  have a sanctioned-cast manifest (`test/style/no-unknown-as.test.ts`) tracking the per-file
  counts + the reason each cast persists; adding a cast at one of those files (or removing one)
  requires updating the manifest. Substrate / runtime / orchestrator code is out of scope — those
  layers have their own decode + typed-error discipline (§2 + §20).
- Code either WORKS or DOESN'T EXIST. No orphan exports waiting for a wiring layer.
- Effect Service tag identifiers must use the current package namespace (`'@devstack/...'`).
- Sentinel literals at resolved-value surfaces (`'<...>'`, `'<TODO-fill-me>'`,
  `'<cache-hit-not-rehydrated>'`) are scaffold debt. Fail at the factory (typed error or
  `Effect.fail`) or omit the field entirely.

**`noUnusedLocals` quirk:** TypeScript's `noUnusedLocals` is strict — an underscore prefix exempts
only function parameters, not top-level locals. For unused locals retained for type-positional or
design-comment reasons, use a trailing `void <name>;` line.

---

## 6. Naming

- Plugin factories: **lowercase** (`sui`, `walrus`, `account`, `localPackage`, `knownPackage`,
  `coin`, `wallet`, `seal`, `deepbook`, `action`, `faucet`).
- Capability contracts: **PascalCase** (`Snapshotable`, `Routable`, `Codegenable`, `ChainProbe`,
  `StrategyContributor`, `Projection`, `Renderer`, `ContainerRuntime`).
- Tagged errors: PascalCase. See §2 for `Error` suffix discipline.
- Effect Services: PascalCase ending `Service` (`StrategyRegistryService`, `PortBrokerService`,
  `ArtifactPublisherService`, `ContainerRuntimeService`).
- Branded primitives: `AppName`, `StackName`, `ChainId`, `PluginKey`, `EndpointKey`, `ContentHash`
  (established in `substrate/brand.ts`).
- Type-only generics with phantom witnesses: `__PrefixedWithDoubleUnderscore`
  (`__MissingProvidersError<Missing>`, `__ProjectionFieldsClosed`, `__RowFieldsClosed`).
- Per-instance resource id templates: `account/<name>`, `package:<name>`, `coin:<symbol>`,
  `action:<name>`, `deepbook/<name>`. Mixing `/` vs `:` separators is intentional per plugin
  convention; do not normalize.
- File names: kebab-case. Effect Service module shape commonly: `{ index, layer, service }.ts` when
  nontrivial.
- Effect `Layer` exports use the `layerXxx` prefix (`layerLogger`, `layerCrossProcessLockFlock`,
  `layerProductionOrchestrators`). New code follows the prefix shape; suffix-shape exports are
  renamed on touch.

**`PluginKey` derivation** (`lifecycle/dep-graph.ts:mintKey`):

- Plugins that need a stable lifecycle key declare `pluginKey: PluginKey | string` in plugin
  metadata; the dep-graph reads it verbatim. Local service factories choose the key shape
  (`seal:${name}`, `walrus:${name}`).
- Plugins without a declared key mint `${member.id}#${ordinal}` where `ordinal` is the position in
  the surrounding member tuple. The `#N` suffix disambiguates two members providing the same
  resource id.
- Reserve declared keys for long-lived services whose row identity must survive member reordering.

---

## 7. Imports

- **Plugin A may not import from Plugin B's internal modules.** Cross-plugin imports go through the
  target plugin's `index.ts` barrel. The three documented universal buses (Sui, Account,
  host-service — see ARCHITECTURE.md) flow through barrels too.
- **Shared cross-plugin contract types live in `src/contracts/`.** When two plugins need to agree on
  a shape that neither owns, lift the type to a substrate-neutral file. Plugin barrels may re-export
  for ergonomics (often with a narrowed generic).
- **Substrate is name-blind.** Substrate code does not mention plugin names.
- **L1 (`runtime/docker/*`) labels carry generic `kind` / `subkind` / `specVersion` slots.** Never
  add orchestrator-named label keys or sweep helpers (`listDevstackRouterContainers`) to L1. The
  router orchestrator owns the literal `'router'` it stamps; the generic
  `listDevstackContainersByKind(...)` helpers stay plugin-blind.
- **Substrate must not depend on capability-contract names either.** Plugins emit their
  contributions inline during `start` via the typed `ctx.*` verbs (`codegen` / `endpoint` /
  `snapshotExtra` / `publish` / `provides`); the supervisor buffers them and, after a successful
  `start`, replays the buffer through the closed `ContributionDispatcher`
  (`dispatchBufferedContributions` in `acquire-node.ts`). The dispatch switches only on the
  contribution's `kind` discriminant — it never names a plugin or a capability.
- **L2 plugins must not import L3 orchestrators.** When an orchestrator helper turns out to be pure
  / substrate-blind and L2 needs it (canonical case: URL composition + routed-hostname minting),
  lift the pure logic into `substrate/runtime/` and have the orchestrator re-export or adapt for its
  own callers.
- **Orchestrators are plugin-name-blind.** No L3 may branch on an `emitterName` / plugin-id literal
  or invoke a CLI binary named after a plugin. Aggregate cross-plugin renderings live in plugin
  contributors via `CodegenableDecl.aggregate.{bucket, project}`. Domain subprocesses (e.g.
  `sui move summary`) live in the plugin (the orchestrator references an abstract
  `MoveSummaryRunnerService`).
- **L4 surfaces vs. `cli/main.ts`-adjacent infrastructure.** `cli/main.ts`-side modules
  (`cli/prune-direct.ts`, `cli/doctor-probes.ts`, `cli/snapshot-reader.ts`, etc.) are L4-adjacent
  composition infrastructure — they may import L3 / L2 / substrate barrels because they exist to
  compose those layers for the bin entry. Pure L4 surfaces (`surfaces/cli/**`, `surfaces/tui/**`)
  consume only typed event / command channels + cascade-formatter + codegen helpers. Enforced by
  `test/style/l4-boundary.test.ts`.
- **L5 build integrations use `build-integrations/runtime/`** as the canonical substrate;
  per-integration reimplementations of manifest discovery / decode / cold-start / dapp-kit-slot
  consolidate there.
- **Apps never import devstack.** L5 example apps consume codegen-emitted manifest + L5
  build-integration helpers only.
- Effect imports: bare `import { Effect, ... } from 'effect'` for the main runtime;
  `@effect/platform`, `@effect/platform-node`, `@effect/vitest` from their own subpaths.
- Cross-package imports use `@mysten-incubation/devstack/<subpath>` for exported public subpaths;
  relative `.ts` imports inside the package use the explicit `.ts` extension because the package
  enables `allowImportingTsExtensions`.

---

## 8. File organization

- One Effect Service per file when nontrivial. Service modules typically:
  `<primitive>/{ index, layer, service }.ts`.
- Plugin barrel (`plugins/<name>/index.ts`) re-exports only what is user-public. Plugin internals
  stay behind package-local imports unless an explicit package export exposes them.
- One capability decl per file when nontrivial. Contract types reach users only through the root
  barrel (`src/index.ts`); there is no `contracts/index.ts` barrel — package-internal callers import
  the per-decl module directly.
- Renderer modules use `.tsx` only when JSX is used. Ink dependencies must be lazy-imported.

**File length is a smell, not a threshold.** If a file is hard to navigate, factor by
responsibility. If it's coherent, leave it. Don't split because a file crossed a number. No lint
rule enforces a numeric LOC ceiling; review judgement is the gate.

Reference shape for genuine multi-concern decomposition: `substrate/runtime/supervisor/` (each file
scoped to one concern, currently each fits in a single editor screen).

```
supervisor/
├── index.ts                  — public surface re-exports
├── start-supervisor.ts       — orchestrating boot body
├── command-loop.ts           — handleCommand + commandLoop
├── acquire-node.ts           — per-plugin acquire pipeline + buffered-contribution replay
├── contribution-dispatcher.ts — closed `ContributionDispatcher` seam (kind-discriminated)
├── teardown.ts               — slice teardown + selective restart
├── background-tasks.ts       — snapshot / restart / post-acquire fork helpers
├── shutdown.ts               — shutdown branches
├── state.ts                  — shared-state record
├── types.ts                  — boundary-shape types
├── errors.ts                 — typed error surface
└── wiring.ts                 — substrate-wiring helpers + OptionalService<T>
```

When splitting a monolith, group locals into a typed shared-state record rather than threading every
closure capture through helper signatures. When NOT splitting: large composition surfaces
(`cli/main.ts`) are coherent — scattering a wiring function 8 ways scatters the wiring.

---

## 9. Mode-narrowed factory namespaces

For plugins with modes (sui local/local-rpc/live, walrus local-cluster/known, seal
local-keygen/live/fork-known, deepbook local/live/fork):

- Use `defineModeNamespace` and call the returned namespace with `network`.
- Mode refusal lives at the **type level**. `walrus.localOf(sui)` is the only valid local Walrus
  call; `walrus()` on a fork-typed branch is a compile error.
- Do not add runtime mode checks the type system could have caught. Mode-narrowed factories use two
  `as` casts inside `defineModeNamespace` — that is the sole boundary between runtime breadth and
  type-level narrowness; no ad-hoc `if (mode === ...)` runtime guards downstream.
- Plugin SDK ergonomics: bare form (`walrus({ ... })`) defaults via the network resolver; explicit
  form (`walrus.localOf(sui)({ ... })`) is the typed form. Both are first-class.

---

## 10. L2 wrapper-service around `defineScopedRefMap`

When an L2 plugin owns a per-stack `K → V` registry **and adds plugin-specific methods** (Sui-coin's
`CoinRegistry` exposes `byWitness` / `byType` / `list` / `register`), use the wrapper-service shape:

```ts
const FooRefMap = defineScopedRefMap<FooKey, FooRecord>('FooRegistry');

export interface FooRegistry {
	/* plugin-specific API */
}

export class FooRegistryService extends Context.Service<FooRegistryService, FooRegistry>()(
	'@devstack/plugins/foo/FooRegistry',
) {}

export const layerFooRegistry: Layer.Layer<FooRegistryService> = Layer.effect(
	FooRegistryService,
	Effect.gen(function* () {
		const refMap = yield* FooRefMap.Service;
		return FooRegistryService.of(wrapRefMap(refMap));
	}),
).pipe(Layer.provide(FooRefMap.layer));
```

When the surface is a 1:1 re-projection of `set/find/has/entries/changes` and no plugin-specific
methods exist today, consume `defineScopedRefMap(...)` directly. Don't wrap for symmetry. Switch to
the wrapper shape when the first plugin-specific method lands.

---

## 11. ArtifactPublisher

All cacheable produce / verify / register artifacts go through `ArtifactPublisher`
(`primitives/artifact-publisher.ts` + `substrate/runtime/cache/`):

- Pattern: `cache → verify(cached) → produce → register`.
- Use `LENIENT_RETRY_PROFILE` for chain reads.
- The substrate enforces the cache → verify → produce → register pattern. The produce body is
  plugin-owned — write the shape that fits the on-chain operation.

---

## 12. Container ensure + exec + image ops

For long-running managed containers, use `substrate/runtime/managed-container.ts`:

- `managedContainerLabels({ identity, plugin, role })` builds the canonical
  `{ app, stack, plugin, role }` ownership tuple.
- `ensureManagedContainer({ runtime, identity | labels, plugin, role, spec, mapError })` injects
  labels, adds the managed-container span attributes, and projects `ContainerRuntimeError` once.

Plugins own their domain error message via `mapError`. They do not hand-roll label tuples plus
`runtime.ensureContainer(...).pipe(Effect.catch(...))` at each callsite.

`ContainerRuntime.exec` is on the contract (`contracts/container-runtime.ts`) with optional
`ExecOptions` (`user`, `env`, `workdir`). Plugins consume the contract surface — no per-plugin
`containerExec` shims.

`saveImage` / `loadImage` / `tagImage` are also on the contract. `saveImage(ref)` returns a
`Stream<Uint8Array, …>` so large images don't materialise in memory. Plugins go through these —
direct `dockerCommand('save' | 'load' | 'tag', …)` from a plugin breaches the L1 → L2 boundary.

---

## 13. Cross-plugin dependencies

Public plugin authors declare upstreams with `definePlugin({ dependsOn })`. The `start` callback's
sole argument is the resolved dependency value(s):

- Tuple `dependsOn` produces tuple deps: `dependsOn: [suiResource, accountRef]`.
- Object `dependsOn` produces object deps: `dependsOn: { sui: suiResource, signer }`.
- A single dependency produces that dependency's resolved value directly.

Built-in options accept plugin / resource refs (`ResourceRef<id, value>`) rather than substrate
`StackMember` aliases. Preserve the actual plugin value in the factory generic so recursive
`defineDevstack` expansion can see plugin-valued dependencies.

---

## 14. Per-key serialization (leases)

`LeaseBrokerService` at `substrate/runtime/lease-broker/`. Generic, name-blind, scope-bound release.

- Plugins requiring at-most-one-in-flight on an opaque resource (per-address sequence number,
  per-connection gate, per-slot work queue) yield `LeaseBrokerService` and call
  `broker.acquire(leaseKey('<plugin>:<key>'), '<owner>')`.
- Key encoding is per-plugin convention; the broker treats keys as opaque. Account uses
  `account:<address>`.
- Release is scope-bound. No `release()` method. Wrap `broker.acquire(...)` in `Effect.scoped` (or
  call inside a surrounding scope) and let the finalizer fire.
- Non-reentrant. A same-owner nested `acquire` against a held key deadlocks the inner call. If a
  caller needs to re-enter, restructure the caller.

---

## 15. Endpoints

- `RoutableDecl` is the canonical declaration for public in-stack endpoints. The router mints the
  hostname and emits `endpoint.registered`; plugins do not separately publish their own guessed
  public URL for the same service.
- Resolved-value URL projection is fallback-only. The supervisor suppresses inferred `url`,
  `rpcUrl`, `faucetUrl`, `graphqlUrl` endpoints when the plugin contributes any routable capability.
- Direct URLs used for boot probes, sibling containers, or host-gateway access must be named as such
  (`direct*`, `probe*`, `hostGateway`) and aren't public endpoint declarations.
- For live / local-rpc modes with no router contribution, resolved-value URL fields may still
  surface as operational endpoints.

---

## 16. Observability

- `Effect.withSpan(...)` + `Effect.annotateCurrentSpan(...)` are the only span-instrumentation entry
  points. No `console.log/warn/error` in production code.
- Span attribute keys flow through a namespace constant. Substrate-owned engine-dimensional keys
  live in `substrate/runtime/observability/spans.ts:SpanAttr`. Plugin-domain keys live in
  `src/plugins/<name>/spans.ts` (`WalletSpans`, `AccountSpans`, etc.). Cross-plugin reads go through
  the source plugin's barrel. Free-form string literals are a violation.
- Log-level discipline: `logDebug` per-fetch / per-tick loops; `logInfo` lifecycle transitions;
  `logWarning` retryable failures; `logError` typed-error surfacing.
- Log messages are stable event text; dynamic values go in fields / log annotations. Do not format
  endpoint URLs, request ids, origins, exit codes, or retry causes into the message.
- The structured `Logger` service is the plugin-facing buffered log sink. Long-running child
  processes route stdout/stderr through `ProcessLines.observeProcessLines(...)`; one-shot command
  capture uses `subprocess-capture.ts`; raw `Stream.decodeText() + Stream.splitLines` belongs only
  inside those substrate helpers.
- Host processes use `substrate/runtime/process-supervisor.ts` for spawn typing, exit / error races,
  exit-status description, and SIGTERM-to-SIGKILL teardown.
- HTTP readiness checks use `HttpProbes.waitForHttpEndpoint(...)` from the root plugin-authoring
  barrel: endpoint, total timeout, retry interval, optional per-request timeout, optional response
  validator.
- Request retry schedules use `substrate/runtime/retry-policy.ts`. Do not build local
  `Schedule.exponential(...).pipe(Schedule.jittered, Schedule.both(...))` chains in plugins.
- `Effect.annotateCurrentSpan` outside `Effect.withSpan` silently drops annotations. Wrap in a span
  first.

**Canonical substrate helpers — the four classes of plugin-side bespoke code that must migrate:**

| Class                | Canonical substrate helper                                                                            | Anti-pattern                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Request retry        | `retry-policy.ts` (`makeExponentialRetrySchedule` / `makeSpacedRetrySchedule` / named profiles)       | Hand-rolled `Schedule.exponential(...).pipe(Schedule.jittered, ...)` |
| Balance / poll loop  | `retry-policy.ts` (`makeBoundedSpacedSchedule` + named profiles)                                      | `for(;;)` with `Date.now()` + `Effect.sleep` deadline check          |
| JSON / Schema decode | `runtime-decode.ts` (`decodeJsonText` / `decodeJsonTextSync` / `decodeUnknown` / `decodeUnknownSync`) | Bare `JSON.parse` + `Schema.decodeUnknown*` with try / catch swallow |
| HTTP readiness probe | `http-probe.ts` (`waitForHttpEndpoint` + `HttpProbes` namespace)                                      | Hand-rolled `fetch` + `AbortSignal.timeout` poll loop                |

Named retry profiles in `retry-policy.ts` are for shapes reused across plugins. A one-off retry with
no sibling reuse stays inline — don't fabricate a profile name for a single consumer. Reuse drives
the lift, not aesthetic uniformity.

**Sui chain access goes through `@mysten/sui`'s gRPC `core` surface.** Construct a `SuiGrpcClient`
and call `core.getObject` / `core.getTransaction` / `core.executeTransaction` / etc. Do not
hand-roll JSON-RPC POSTs — JSON-RPC is deprecated upstream and the gRPC core API exposes typed
`SuiClientTypes` responses. Owner discriminants mirror `SuiClientTypes.ObjectOwner` (`AddressOwner`
/ `ObjectOwner` / `Shared` / `Immutable` / `ConsensusAddressOwner` / `Unknown`).

**Single sanctioned SDK client cast at plugin boundaries: `ClientWithCoreApi`** (re-exported from
`plugins/sui/index.ts`; lives at `@mysten/sui/client`). `SuiSdkShim.client` is typed as
`ClientWithCoreApi` already, so passing `sui.sdk.client` to `Transaction.build({ client })` or
`client.core.*` needs no cast. Do not cast to inline shapes — `ClientWithCoreApi` already covers
them. The lone exception is `SuiGrpcClient`-only surfaces (`ledgerService`,
`transactionExecutionService`, `stateService`, etc.) reachable only off the concrete gRPC class: use
`sdk.client as unknown as { ... }` and document inline why the surface isn't on `core`.

---

## 17. Atomic writes

One primitive: `substrate/runtime/atomic-write.ts`. Two surfaces:

- `atomicWriteFile` / `atomicWriteJson` — Effect / `FileSystem`-based. State-store, cache, manifest.
- `atomicWriteFileSync` / `atomicWriteJsonSync` — `node:fs`-sync. Cross-process modules (roster,
  snapshot-reservation) that hold `stack.lock` and must keep their critical section non-yielding.

Rules:

- New code calls the canonical primitive. No inline tempfile + rename.
- **Random ID rule: `crypto.randomUUID().slice(0, 8)`.** Avoid `Math.random()`-based names
  (collision risk in parallel callers + non-cryptographic). Applies uniformly across every site that
  needs a short random suffix: tempfile names (centralised in `atomic-write.ts`), one-shot container
  names, snapshot reservation ids, `runOneShot` invocations.

---

## 18. Cross-process protocol

- `stack.lock` (O_EXCL) + `roster.json` + `snapshot.reservation` are the three on-disk artifacts.
  Liveness via PID + startTime predicates at `substrate/runtime/cross-process/liveness.ts`.
- One cross-process lock primitive: the typed `CrossProcessLock` Effect Service. Production wiring
  uses `layerCrossProcessLockFlock`; test wiring uses `layerCrossProcessLockInProcess`.
  State-store + cache yield `CrossProcessLock` and let wiring decide.
- Router `contributeRoute` holds the dispatch-file lock across both the file write AND the readiness
  probe so a sibling contributor cannot publish over a half-staged dispatch file. The probe runs
  INSIDE the surrounding `Effect.scoped(acquireStackLock(...))` block; releasing the lock between
  write and probe is a regression.
- Lock-acquire failures during scope-close cleanup surface via `Effect.logWarning` (with the error
  annotated). `.pipe(Effect.ignore)` on `acquireStackLock(...)` silently swallows contention and IO
  errors and is forbidden — best-effort cleanup is fine, but the leak must be visible.

---

## 19. Schema decode

- **Canonical:** `decodeUnknown(schema, raw, { source, mkError })` and
  `decodeJsonText(schema, text, { source, mkError })` from `substrate/runtime/runtime-decode.ts`.
  Effect-returning, typed error projection with one parse / decode issue shape.
- **Plugin config:** `substrate/runtime/config-validation.ts` at factory and boundary sites.
  `defineConfigError(tag)` keeps plugin-owned error tags. Scalar `expect*` validators throw the
  plugin-tagged `ConfigIssue` shape; route Schema decodes through `decodeUnknown(Sync)` in
  `substrate/runtime/runtime-decode.ts`.
- **Sync acceptable** (cross-process readers, cache / state reads): `decodeUnknownSync(...)` /
  `decodeJsonTextSync(...)` inside a `try/catch` that maps corruption to a miss or typed error.
- **Banned:** `Schema.decodeUnknownSync(...) as A` bare cast — loses parse errors entirely.

NDJSON tail-decoders treat per-line decode failure as "skip row + `logDebug`". A truncated line
during atomic append (writer partway through `events.ndjson` when the tail polls) is normal and must
not kill the surrounding stream. Wrap the per-line decode in `try / catch` that returns `null`,
filter the sentinel downstream, emit `Effect.logDebug`.

---

## 20. Renderer projection

The projection field set (`SubscribableState` + `Row`) is closed — see ARCHITECTURE.md "Closed
projection field list" for the canonical fields and the `__*FieldsClosed` guards.

Code-level rules that follow from the closure:

- Logs live INSIDE rows as `row.logTail`, not as a top-level `logs` field.
- `Row.section` is plugin-declared at `definePlugin({ section })` time. The renderer reads it
  directly and must not pattern-match on plugin-name substrings to derive a section.
- Substrate projection events are name-blind. The only projection-shaped event is
  `projection.updated` carrying `{ kind: string, key: string, payload: unknown, at: number }`. New
  plugin-specific projection shapes contribute a decoder branch to the reducer's
  `projection.updated` case — they do NOT add a new event variant.

---

## 21. Cookbook

Reusable patterns. Each entry pairs a substrate primitive with the discipline for using it.

### 21.1 `as const` on `HostServiceAfter` / `ReadonlyArray<AnyResourceRef>` tuples

**Plugin-author tuples declared as a `HostServiceAfter`-style list must be `as const`.** Without it,
TypeScript widens the tuple to `AnyResourceRef[]` and the generic capture loses the per-element
narrowing the plugin's `After` parameter relies on.

```ts
// Wrong — widened to AnyResourceRef[]; downstream type-level narrowing breaks.
hostService({ command: 'pnpm', after: [neededMember] });

// Right — narrows the tuple length and element types.
hostService({ command: 'pnpm', after: [neededMember] as const });
```

**Rule:** when a plugin factory generic parameter extends a `ReadonlyArray<...Ref>` tuple, the
caller writes `[…] as const`.

### 21.2 `OptionalService` discipline

`OptionalService(tag)` at `substrate/runtime/supervisor/wiring.ts` is the canonical "probe
`pluginContext` for a service; fall back if absent" lookup. The internal cast
(`ctx as Context.Context<I>`) is structural: `pluginContext` is typed `Context.Context<never>` and
the probe is intentional. Hand-rolled `Context.getOption` plus a cast at the callsite is the
anti-pattern.

```ts
const Logger = OptionalService(LoggerService);
const logger = Logger.read(pluginContext, noopLogger);
const sinks = yield * Logger.readEffect(pluginContext, buildDefaultSinks);
```

**Rule:** probe optional services through `OptionalService(tag).read` / `.readEffect`. Don't
open-code the lookup.

### 21.3 Stage-and-swap primitive

`stageAndSwap` at `src/substrate/runtime/stage-and-swap/index.ts` is the canonical
"build-then-publish atomically" primitive. The build effect populates `stagingPath`; on success the
helper backs up the current target, renames staging into place, and drops the backup. On failure the
previous target is restored verbatim. The build effect's error tag passes through unchanged.

Two call shapes:

- **`idSuffix`** — the primitive mints `<targetPath>.staging.<idSuffix>` /
  `<targetPath>.bak.<idSuffix>`. Use when the staging-name convention is owned in one place
  (codegen, snapshot).
- **explicit `stagingPath` + `backupPath`** — caller picks both names. Use when bespoke sibling
  names are load-bearing (Seal's `.backup.`, fixtures pinning literal names).

```ts
yield *
	stageAndSwap({
		targetPath,
		idSuffix: crypto.randomUUID().slice(0, 8),
		build: Effect.gen(function* () {
			// populate stagingPath
		}),
	});
```

**Rule:** publish-then-swap goes through `stageAndSwap`. No inline
`mkdir(tmp) + rename(tmp, target)`.

### 21.4 `versionedDocSchema` migration procedure

`versionedDocSchema(N, payload)` at `substrate/versioned-doc-schema.ts` centralises the
`{ version: Literal<N>, ...payload }` shape every persisted cross-process document shares (roster,
container-claim, snapshot-reservation, port-reservation).

```ts
// v1
const DocSchema = versionedDocSchema(1, { pid: Schema.Number, host: Schema.String });

// v2 migration — union the two versions at the read site.
const DocSchema = Schema.Union(
	versionedDocSchema(1, { pid: Schema.Number, host: Schema.String }),
	versionedDocSchema(2, { pid: Schema.Number, host: Schema.String, startTime: Schema.Number }),
);
```

**Rule:** new versioned cross-process documents use `versionedDocSchema`. v2+ schemas read through
`Schema.Union(versionedDocSchema(1, ...), versionedDocSchema(2, ...), ...)`. Don't hand-roll the
discriminator field.

### 21.5 `plugins/internal/` directory

Modules under `src/plugins/internal/` are shared plugin helpers that are NOT plugins themselves
(`acquire-on-chain-artifact.ts`, `codegen-helpers.ts`, `funding-failure-error.ts`). Sibling plugins
import from `plugins/internal/<helper>.ts` directly — there is no barrel.

```ts
// Right
import { acquireOnChainArtifact } from '../internal/acquire-on-chain-artifact.ts';

// Wrong — no barrel exists, and adding one would invite cross-plugin reach.
import { acquireOnChainArtifact } from '../internal/index.ts';
```

**Rule:** shared plugin-side helpers live in `plugins/internal/` with per-file imports. No barrel.

### 21.6 `withTempRoot` test helper

Tests needing a tempdir use `withTempRoot` / `withTempRootSync` / `withTempRootAsync` from
`test/helpers/with-temp-root.ts`. Cleanup is unconditional (Effect finalizer, `try/finally`).

```ts
it.effect('writes manifest', () =>
	withTempRoot('manifest-test', (root) =>
		Effect.gen(function* () {
			yield* writeManifest(join(root, 'manifest.json'));
		}),
	),
);
```

**Rule:** tests do not call `mkdtempSync` + ad-hoc `try/finally`. Use the helper — it closes several
historical leak-on-throw bugs in one place.

### 21.7 Minimal `definePlugin` skeleton

The shortest compiling plugin declares `id`, `role`, `section`, and `start`. `dependsOn`,
`capabilities`, `watch`, `errorContributions`, `pluginKey`, and `endpointSection` are all optional.
The `start` callback receives the resolved `dependsOn` value as its sole argument; tuple `dependsOn`
projects to a tuple, object to an object, single ref to the bare resolved value.

```ts
import { Effect } from 'effect';
import { definePlugin, resource } from '@mysten-incubation/devstack';

const fooResource = resource<'foo', { readonly id: string }>('foo');

export const foo = () =>
	definePlugin({
		id: fooResource.id,
		role: 'task', // 'task' = value-producer reaches done; 'service' = long-lived host process
		section: 'other', // dashboard bucket the supervisor stamps onto every row
		start: (deps) =>
			Effect.gen(function* () {
				// Substrate services come from yield*; cross-plugin values from `deps`.
				void deps;
				return { id: 'foo-1' };
			}),
	});
```

**Rule:** new plugins start from this shape. Add `dependsOn` / `capabilities` only when the plugin
genuinely needs them — don't pre-declare empty arrays.

### 21.8 `StrategyContributorDecl` registration shape

The substrate's strategy registry decouples sibling plugins that contribute funding / chain-probe /
fund-ready strategies. A plugin builds one or more `StrategyContributorDecl<Key, Strategy>` and
emits each inline during `start` via `ctx.provides(decl)`. The supervisor buffers that emission and,
after a successful `start`, replays it through the `ContributionDispatcher`, which registers it on
`StrategyRegistryService` keyed by `capabilityKey` and publishes `strategy.registered`. Consumers
retrieve with `StrategyRegistryService.get<Key, Strategy>(key)`.

Contributor (real example, `plugins/coin/index.ts` — the `coinContributions` decl-builder):

```ts
const fundingContribution = {
	kind: 'strategy-contributor',
	capabilityKey: coinFundingCapabilityKey(resolved.fullCoinType),
	strategy: resolved.fundingStrategy,
	autoMounted: true, // hides from renderer rows; user-supplied contributors are visible
} satisfies StrategyContributorDecl<`coinType:${string}`, AccountFundingStrategy>;
// emitted during `start`: ctx.provides(fundingContribution)
```

Consumer (real example, `plugins/account/funding.ts:475`):

```ts
const strategy =
	yield *
	registry
		.get<typeof coinKey, AccountFundingStrategy>(coinKey)
		.pipe(Effect.catchTag('StrategyNotFoundError', () => Effect.succeed(null)));
```

**Rule:** sibling-plugin strategy hand-off goes through `ctx.provides()` and the strategy registry.
Do not stash a strategy on a plugin's resolved value for another plugin to import — it bypasses the
dep-graph-free decoupling and breaks parity between built-in and custom contributors. See
`ARCHITECTURE.md`'s "Funding contribution invariant" for the full failure mode.
