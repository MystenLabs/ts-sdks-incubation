# Plugin API cleanup plan

Last updated: 2026-05-22.

## Context

The resource-native plugin API has been migrated into `packages/devstack`, but the audit found a
few areas where old engine concepts or over-generalized capability patterns still leak into the
plugin-author surface.

This package is unreleased. Do not add compatibility shims, deprecated aliases, or parallel v2
exports. Break the API directly and update every callsite in the same patch.

## Goals

- Make the plugin-author API smaller and more composable.
- Move static topology metadata out of post-acquire capability declarations.
- Remove public helpers and exported types that have no real built-in use.
- Keep important runtime behavior intact: recursive plugin dependencies, explicit stack-root Sui
  providers, wallet `accounts: 'all'`, strategy lookups, router/codegen/snapshot delivery,
  examples, and full package verification.

## Audit findings

### Composite plugins are modeled at the wrong layer

Current shape:

- `CompositePrimitiveDecl` is a capability declaration.
- The dep graph needs composite keys and inner participants before any plugin starts.
- Walrus, Seal, and DeepBook currently return composite declarations from dynamic capability
  factories, which is too late for graph keying.
- `CompositePrimitiveDecl.liftedSiblings` duplicates `PluginSpec.liftedSiblings`.
- Real built-ins mostly set `innerParticipants: []`, so the separate composite builder files add
  ceremony without delivering topology.

Target shape:

- Composite identity/topology is static plugin metadata, not a capability.
- Capability arrays remain for post-acquire contributions such as routable/codegen/snapshot and
  dynamic strategy values.

### `StartContext` is empty

Current shape:

- Public `start` receives `start(ctx, deps)`.
- `StartContext` is an empty interface.
- Built-ins and tests mostly use `_ctx`.
- Substrate services already arrive through the Effect R-channel.

Target shape:

- Dependency-free plugins use `start: () => Effect`.
- Plugins with dependencies use `start: (deps) => Effect`.
- Delete `StartContext` from the root API.

### Mode namespace syntax is noisy

Current shape:

- `defineModeNamespace(...)` returns `{ for(network) }`.
- Comments and docs already drift between `deepbookFor(network)` and `deepbookFor.for(network)`.

Target shape:

- `defineModeNamespace(...)` returns a callable namespace: `namespace(network).local(...)`.
- Built-ins expose `suiFor(network)`, `walrusFor(network)`, `sealFor(network)`,
  and `deepbookFor(network)`.
- Delete `forNetwork`.

### StrategyContributor is overloaded

Current shape:

- Some strategy contributors are real runtime strategies.
- Some are marker-only declarations.
- Some are used by the default sink to publish `account.updated` and `package.updated` events by
  parsing hardcoded string keys.
- Sui and Walrus register some strategies directly in `start`, then also emit marker declarations.

Target shape:

- `StrategyContributorDecl` means "register this strategy in `StrategyRegistryService`".
- Projection/event payloads use a separate explicit projection capability.
- Marker-only declarations are deleted unless a real consumer depends on them.
- Substrate sinks stay generic and do not parse account/package capability-key strings.

### Public surface has residue

Cleanup candidates:

- `capabilityBuilder` is unexported and unused. Delete it.
- `displayHint` is stored on rows but unused by renderers or built-ins. Delete it.
- `Lifeness*` exported names contain a typo. Rename to `Liveness*` while keeping the capability
  kind string `liveness-classifier`.
- `RoutableHttpDecl.wireProtocol` is optional only for old pre-TCP compatibility. Make it required.
- Witness helpers are sample-only. Delete them unless a real built-in adopts the witness pattern in
  the same patch.
- `src/samples/*` contains Phase 4 throw scaffolding. Either make samples runnable under the current
  API or remove them from the package.

## Implementation plan

### 1. Simplify `definePlugin`

Update `src/substrate/plugin.ts` and the `src/api/define-plugin.ts` re-export.

- Replace `PluginStart<Deps>` with conditional start signatures:
  - `Deps` absent: `() => Effect.Effect<Value, Error, Requirements>`.
  - `Deps` present: `(deps: Deps) => Effect.Effect<Value, Error, Requirements>`.
- Delete `StartContext`.
- Add plugin-level composite metadata:

```ts
interface CompositePluginMetadata {
	readonly key: PluginKey | string;
	readonly innerParticipants?: ReadonlyArray<AnyPlugin>;
}

interface PluginSpecBase<...> {
	readonly id: Id;
	readonly kind: PluginKind;
	readonly start: Start;
	readonly capabilities?: CapabilitySource<StartValue<Start>, Caps>;
	readonly composite?: CompositePluginMetadata;
	readonly liftedSiblings?: Siblings;
	readonly rebootCost?: RebootCost;
	readonly watch?: WatchDecl;
	readonly errorContributions?: ReadonlyArray<PluginErrorContribution>;
}
```

- Preserve the existing tuple/object/single-ref dependency inference.
- Keep dynamic capability factories in the current `{ value, runtime }` authoring shape.

### 2. Update the lifecycle engine

Update dep-graph and supervisor code to consume the new shape.

- In `lifecycle/dep-graph.ts`, mint composite keys from `member.composite?.key`.
- Expand `member.composite?.innerParticipants ?? []`.
- Remove `readStaticCapabilities`, `isCompositePrimitiveDecl`, and all composite capability scans.
- In the supervisor, call plugin start functions with no empty context:
  - no dependencies: `start()`;
  - dependencies: `start(deps)`.
- Remove row `displayHint` plumbing from plugin types, projection row shape, persisted schema,
  lifecycle facts/tests, and TUI display derivation tests.

### 3. Convert built-in composites

Update Walrus, Seal, and DeepBook.

- Replace `makeWalrusComposite`, `makeSealComposite`, and `makeDeepbookComposite` with lightweight
  key helpers where needed.
- Set `composite: { key, innerParticipants }` directly on local composite plugins.
- Keep `liftedSiblings` on the plugin spec only.
- Remove composite declarations from dynamic capability arrays.
- Delete `contracts/composite-primitive.ts`, the capability registry entry, default sink slot,
  root export, and related tests.
- Replace DeepBook composite tests with plugin metadata/keying tests.

### 4. Split strategy registration from projection

Keep this focused. Do not build a generic event bus in this patch.

- Update the default `strategy-contributor` sink to register the declared strategy with
  `StrategyRegistryService` and publish `strategy.registered` / finalizer-backed
  `strategy.unregistered` events.
- Add a small projection capability for post-acquire state events, for example:

```ts
type ProjectionDecl =
	| { readonly kind: 'projection'; readonly event: Extract<EngineEvent, { tag: 'account.updated' }> }
	| { readonly kind: 'projection'; readonly event: Extract<EngineEvent, { tag: 'package.updated' }> };
```

- Use projection declarations for Account and Package state updates instead of parsing
  `strategy-contributor` payloads in substrate.
- Convert Sui chain-probe, faucet request, funds-ready, seed-objects, and Walrus WAL strategy
  registration to real `StrategyContributorDecl` output where the strategy is available at
  capability-harvest time.
- Keep direct `StrategyRegistryService.register(...)` only when a strategy cannot be expressed as a
  post-acquire declaration without exposing the wrong internal state.
- Delete marker-only declarations such as faucet dispatcher markers and registry placeholder
  markers if no runtime consumer reads them.
- Update registry comments in Package/Coin/Walrus so they no longer claim siblings read
  package/coin registries through StrategyContributor when they actually use L2 services.

### 5. Tighten smaller public contracts

- Make HTTP routables write `wireProtocol: 'http'` or `'h2c'` explicitly.
- Rename `LifenessClassifierDecl`, `LifenessClassification`, and `LifenessHints` to
  `LivenessClassifierDecl`, `LivenessClassification`, and `LivenessHints`.
- Delete `capabilityBuilder` and its builder interface.
- Delete `forNetwork`; make `defineModeNamespace` callable.
- Delete witness helpers if the samples are removed and no built-in uses them.
- Update root exports and packed-consumer expectations.

### 6. Deduplicate composer validation

- Extract the duplicated missing-provider, sibling-conflict, and witness validation types from
  `define-devstack.ts` and `define-devstack-with.ts` into one internal helper module.
- Keep public diagnostics unchanged:
  - `__MissingProvidersError<...>`
  - `__SiblingHashConflictError<...>`
  - `__UnsatisfiedWitnessesError<...>` if witnesses remain.

### 7. Update docs, examples, and samples

- Update `packages/docs/content/devstack` examples from `start(_ctx, deps)` to `start(deps)`.
- Update README layout text that still mentions `defineNodePlugin`, tags, and old capability
  builders.
- Update architecture/style guide sections for:
  - composite key derivation,
  - plugin start bodies,
  - mode-narrowed factories,
  - StrategyContributor semantics,
  - removed witness/sample-only surface.
- Ensure examples continue to compose from app/service entrypoints and do not need casts.

## Verification plan

Run these after implementation:

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run \
	test/api/define-devstack.test.ts \
	test/api/capability-authoring.test.ts \
	test/substrate/runtime/supervisor.test.ts \
	test/e2e/capability-sinks-boot.test.ts \
	test/e2e/snapshot-orchestrator-boot.test.ts \
	test/plugins/wallet/accounts-all.test.ts \
	test/plugins/account/variants.test.ts \
	test/plugins/package/public-ergonomics.test-d.ts \
	test/plugins/coin/registry.test.ts \
	test/plugins/deepbook/factory.test.ts \
	test/plugins/deepbook/type-refusal.test-d.ts \
	test/plugins/seal/public-refs.test.ts \
	test/plugins/seal/keygen.test.ts \
	test/plugins/walrus/seed-accounts.test.ts
pnpm --filter @mysten-incubation/devstack build
pnpm --filter @mysten-incubation/devstack smoke:pack-consumer
pnpm --filter @mysten-incubation/devstack test
```

If the known local Vitest timeout pattern appears in a Docker/TUI file, rerun the isolated timed-out
file before treating the full suite as failed.

## Acceptance criteria

- No source matches for removed public concepts outside historical notes:
  - `StartContext`
  - `CompositePrimitiveDecl`
  - `composite-primitive`
  - `capabilityBuilder`
  - `displayHint`
  - `forNetwork`
  - `defineNodePlugin`, `defineTag`, `consumeMember`, `consumeMembers`, `readConsumedTag`
- Built-in plugin start callbacks no longer accept `_ctx`.
- Composite plugins receive stable keys from plugin metadata even when their capabilities are
  dynamic.
- Strategy declarations register real strategies; projection declarations publish account/package
  events without substrate parsing plugin-specific key strings.
- Root package exports only the intended plugin-author vocabulary.
- Package typecheck, focused tests, build, packed-consumer smoke, and full Vitest complete.

## Out of scope

- A new generic plugin event bus.
- Large Coin/Package decoupling beyond removing StrategyContributor projection overload.
- Reworking wallet `accounts: 'all'` into a general expansion hook unless required by the cleanup.
- DeepBook feature expansion beyond preserving its current behavior through the API cleanup.
