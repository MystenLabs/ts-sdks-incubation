# Devstack style guide

> Living document. Every review finding that surfaces a recurring code-level pattern lands here as a
> rule. Updates require justification in the PR/commit.

Companion: see `ARCHITECTURE.md` for layer / boundary rules.

Source-of-truth inputs that seeded this guide (consult before adding a new rule):

- `notes/reviews/substrate.md`
- `notes/reviews/runtime-docker.md`
- `notes/reviews/orchestrators.md`
- `notes/reviews/surfaces.md`
- `notes/reviews/build-integrations.md`
- `notes/reviews/stable-plugins.md`
- `notes/reviews/cross-cutting.md`
- `notes/api-comparison.md`, `notes/parity-matrix.md`
- `PHASE-3-NOTES.md` (type-system findings)

## How to use this guide

- Every PR + every dispatched agent must adhere.
- A violation found during review = fix + codify here.
- Open slots (marked **TBD — pending <decision-id>**) mean a decision is pending; do NOT pick
  arbitrarily — escalate, or wait for the named pass.
- "Self-evident" rules below MUST be caught at PR review; "Enforced" rules MUST be caught by
  typecheck / lint / build / invariant test.

---

## 1. Effect v4 idioms

The skill `writing-effect` is the authority. The recurring breakages found in PHASE-3 + reviews +
the PR1 typecheck sweep:

- `Effect.catch` not `Effect.catchAll`.
- `Context.Service<Self, Shape>()(id)` is the substrate primitive form — the L0 services
  (`scoped-ref-map`, `lease-broker`, `port-broker`, registries, etc.) MUST use this. The
  `Effect.Service` class form (recommended by writing-effect) is the L1+ default for
  application-level services. Pick by location: substrate primitives → `Context.Service`; everything
  else → `Effect.Service`.
- `Schema.Record(keySchema, valueSchema)` — POSITIONAL args. Not `Schema.Record({ key, value })`.
  (Three fixed sites in `manifest.ts`; do not regress.)
- `Logger.consolePretty()` + `Logger.layer([...])` — not `Logger.pretty`.
- `SubscriptionRef.changes(ref)` — function form, not `ref.changes`.
- `Schema.Schema<T>` — single-generic; not the 3-generic v3 form.
- `it.effect` from `@effect/vitest` for Effect-bearing tests; pure-data helpers use plain `it`.
- **`Effect.fork` split in v4.** Use `Effect.forkChild` for an unscoped fiber, or
  `Effect.forkScoped` for one tied to the surrounding scope. Plain `Effect.fork` is gone. (See
  `substrate/runtime/supervisor.ts` + `surfaces/tui/index.ts` for the canonical `forkScoped`
  pattern.)
- **`Effect.async` → `Effect.callback` in v4.** The name changed; the shape is the same
  `(resume) => void`. See `substrate/runtime/host-tree-tar/index.ts` + `port-broker/service.ts`.
- **`Cause` shape changed.** Reading the failure value via
  `cause._tag === 'Fail' ? cause.error : ...` is the v3 shape and is brittle on v4. Prefer
  `Exit.findErrorOption(exit): Option<E>` when the surrounding code has an `Exit`; otherwise use
  `Cause.failures(cause)` / the documented walkers. The v3 conditional pattern is allowed as a
  defensive guard at boundary code that may receive arbitrary cause shapes (see
  `plugins/sui/mode/local.ts`, `pretty-error.ts`), but new code should reach for
  `Exit.findErrorOption` first.
- **`Stream.unwrap` IS scope-binding in v4.** The R-channel signature reads
  `Exclude<R, Scope.Scope>` which looks like it discards `Scope`, but the implementation calls
  `Channel.unwrap` which provides the channel's surrounding scope to the inner Effect
  (`Scope.provide(scope)` at `effect/src/Channel.ts:7918`). Finalizers registered inside the inner
  `Effect.gen` (via `Effect.addFinalizer`) DO fire on stream completion. The R-channel `Exclude`
  means "the scope requirement is satisfied by the stream itself", not "the scope is dropped". No
  `Stream.unwrapScoped` exists in v4 — `Stream.unwrap` is the correct primitive for "Effect that
  acquires a scope-bound subprocess and returns a Stream". Reference uses:
  `host-tree-tar/index.ts:113`, `runtime/docker/image.ts:211`, `runtime/docker/logs.ts:39` — all
  correct as written.
- **`Effect.either` is GONE in v4.** The v3 `Effect.either(eff): Effect<Either<A, E>>` helper for
  promoting an error channel into the success channel does not exist on v4's namespace. Tests that
  need to assert on the error value MUST go via `Effect.exit(eff): Effect<Exit<A, E>>` and then
  `Exit.findErrorOption(exit): Option<E>` (or `Exit.isFailure(exit)` +
  `Cause.failureOption(exit.cause)` if the test cares about the cause shape). Reference:
  `test/substrate/runtime/lifecycle/*` uses `Exit.findErrorOption` exclusively.
- **`Cause.failures(cause)` is GONE in v4.** The Effect v3 walker that flattened a `Cause` into an
  array of `E` values is removed. Canonical replacement: `Exit.findErrorOption(exit)` returns
  `Option<E>` for the first typed failure (skips defects, interrupts, parallel branches the way
  you'd want for assertion code). For exhaustive cause walking, use `Cause.failureOption`,
  `Cause.defects`, `Cause.interruptors` — the documented v4 accessors. Per-test
  `cause._tag === 'Fail' ? cause.error : ...` is the brittle v3 shape (still allowed only as a
  defensive guard at boundary code that may receive arbitrary cause shapes — see
  `plugins/sui/mode/local.ts`, `pretty-error.ts` — but new code reaches for `Exit.findErrorOption`
  first; this duplicates the `Cause`-shape note above for emphasis because reviews keep catching
  v3-style `Cause.failures` calls).
- **`it.live` is required for tests that exercise wall-clock `Effect.sleep`.** `@effect/vitest`'s
  default `it.effect` runs against TestClock — `Effect.sleep` does NOT advance unless the test
  explicitly `TestClock.adjust`s. Tests that drive a real-time poll loop (file-channel watcher,
  port-broker bind-probe retry, lifecycle settle interval) MUST use `it.live` from `@effect/vitest`
  so `Effect.sleep` runs against the wall clock. Preferred alternative: replace the
  `Effect.sleep`-driven poll with a `Deferred` + `Effect.yieldNow` pattern when the test owns the
  production for/against signal (the deterministic shape — see
  `test/plugins/account/lease-broker-integration.test.ts` which uses Promise gates +
  `Effect.yieldNow` to pin enqueue order, no `it.live` needed). The `it.live` knob is reserved for
  tests that genuinely cannot avoid wall-clock dependencies (filesystem `inotify`, network
  round-trip).

When uncertain, defer to `.repos/effect-v4/` (cloned by `scripts/setup-repos.sh`).

---

## 2. Tagged errors

There is no package-wide error-class unification planned. Match the style of the subsystem boundary
that owns the value:

1. L2 plugins and public contracts use plain structural `_tag` interfaces plus factories for
   plugin-author/public boundary values.
2. Schema-bearing substrate/orchestrator failures use `Schema.TaggedErrorClass`.
3. Runtime adapters, CLI/cross-process/observability, and per-integration L5 errors use
   `Data.TaggedError`.
4. `build-integrations/runtime` synchronous reader errors use plain `Error` subclasses; Vitest,
   Playwright, and Browser integration-specific errors may use `Data.TaggedError`.
5. Orchestrator failures NEVER raise plain `new Error(...)`; downstream phase classifiers MUST
   pattern-match by tag, not by message substring. Reference: `snapshot/integrity.ts` +
   `snapshot/state-document.ts` use `Schema.TaggedErrorClass` with a discriminated `kind` field;
   `snapshot/restore.ts` consumes via `Effect.catchTag('SnapshotIntegrityError', ...)` /
   `Effect.catchTag('SnapshotStateDocumentError', ...)`. Any
   `cause instanceof Error && cause.message.includes(...)` check in an orchestrator is a violation —
   add a `kind` to the upstream tagged error and switch on it.

Rules that apply across all four styles:

- Do NOT introduce a fifth style.
- `cause` field: prefer `Schema.optional(Schema.Defect)` where the style permits it (this is the
  v4-idiomatic shape and round-trips cleanly through the cascade formatter and CLI envelope).
  Plain-interface plugins use `cause?: unknown` — fine, but document.
- One `_tag` literal per logical error type across the whole package — no duplicates.
  **`ForkIncompatibleError` was duplicated** in `plugins/walrus/errors.ts` +
  `plugins/seal/errors.ts`; PR1-E promoted the canonical shape to `substrate/runtime/mode-errors.ts`
  (O3 closed). The plugin-side duplicates remain pending PR3 delete; **do NOT add a second variant
  of any tag** when a canonical substrate shape exists.
- Tag naming: PascalCase. Suffix `Error` is preferred for "the error a caller catches"
  (`WalletBootError`, `SealError`); unsuffixed is acceptable for "the failure event variant"
  (`DaemonUnreachable`, `RecreateRefused`). Mixed today; convention is invisible — be consistent
  within a subsystem.
- Plugin author-facing errors MUST be surfaceable via `Effect.catchTag` / `catchTags` — never rely
  on `instanceof`.
- Plugins MUST NOT silently drop errors. The `Schema.decodeUnknownSync(...) as A` bare-cast pattern
  in `runtime/docker/*.ts` is the only sanctioned escape and is currently flagged for removal. New
  code uses `Schema.decodeUnknown` (Effect-returning).

Boundary decodes use `substrate/runtime/runtime-decode.ts` (`decodeUnknown`, `decodeJsonText`, and
sync variants) unless the boundary is specifically plugin config, in which case use
`substrate/runtime/config-validation.ts`.

---

## 3. Tests

- Vitest tests live in `packages/devstack/test/` mirroring the `src/` directory structure. **Never**
  as `*.test.ts` siblings inside `src/`. User-mandated 2026-05-19.
- Effect-bearing tests use `it.effect` from `@effect/vitest`.
- Browser/DOM tests opt into `@vitest/browser` per the repo's pattern (see `running-vitest` skill).
- **Subprocess-runner pattern is FORBIDDEN by default.** A `*-runner.cjs` + `*-impl.ts` pair that
  spawns a child `node --import tsx/esm <impl>.ts` from a vitest test body is the smell. Vitest 4
  transforms our `.ts`-extension re-exports natively (the vitest 2.1.9 SSR crash that motivated this
  shim is gone). Tests MUST import their implementation directly and assert on the in-process
  result. The only sanctioned exception is `test/plugins/barrel-imports.test.ts`-style "load this
  module in isolation per plugin and observe it doesn't throw at module-load time" — and only when
  in-process load would conflate side effects across plugin barrels. If you reach for this shim,
  write a one-line header comment explaining the load-bearing reason; absent that, it's a violation.
- The "no inline validation in parallel agents" memory directive applies: orchestrators may NOT run
  `pnpm typecheck` / `test` / `build` inside fanned-out agents — see
  `feedback_no_inline_validation_in_parallel_agents`.

---

## 4. Comments + JSDoc

- **Default: write nothing.** Only add when WHY is non-obvious.
- Never narrate WHAT — well-named identifiers say what.
- Never reference the current PR / task / session / fix in comments ("added for Y flow", "fixes
  #123", "Phase-5 wires this", "as of 2026-05-20").
- Header comments may explain WHY a non-obvious design choice was made: invariants, citations to
  `architecture.md`, why a specific cast/escape-hatch is acceptable.
- Comment lines that read as TODO + a phase number are violations of §5; rewrite or delete.
- Known bad pattern (see `notes/api-comparison.md` opportunity): comparison-era example configs
  carried 10-30 lines of "Differences from v3" header comments. **Strip during example cutover.**
  New examples must not adopt this style.

---

## 5. No phase markers / no scaffold debt

Per memory `feedback_no_compat_for_never_cases`:

- No `// Phase 4 wires X`, `// Phase 5 deferred`, `// will replace once Y lands`.
- No `<unresolved-*>` sentinel placeholder strings (the user reads these in example configs as
  `as never`).
- No `as never` / `as any` / `as unknown as ...` at the **user-facing surface** — they are
  diagnostic markers of incomplete substrate types and MUST be zero at cutover. Known sites flagged
  for removal: `wallet-rewrite/devstack.config.ts:130`, `deepbook-full-rewrite` chainId placeholder,
  connect-four's `sdkClient as { ... }`.
- Code either WORKS as written or DOESN'T EXIST. Phase markers are dead scaffold — delete.
- Substrate-side: same rule applies. No `// future` reservations, no orphan exports waiting for a
  wiring layer (`Logger` service, `SpanAttr` helpers, `LifecycleFact`, `PluginErrorContribution`,
  `*_ERROR_TAGS` arrays — all currently orphan; either wire or delete in the substrate triage pass).

As of 2026-05-26 the phase-marker sweep is complete: `grep -rE 'Phase [0-9]+|<unresolved-|// future|will replace once|TBD pending' src/` returns ZERO hits. New code MUST NOT introduce any.

**Sentinel literals at resolved-value surfaces** — sentinel literal strings (`'<...>'`, `'<TODO-fill-me>'`, `'<cache-hit-not-rehydrated>'`, `'<bls-pubkey-storage-node-${i}>'`) at any surface a user might read are scaffold debt. Fail at the factory (typed error or `Effect.fail`) or omit the field entirely instead — never ship a placeholder string that downstream consumers can mistake for real data. Substrate `ArtifactPublisher.publish` returns `Produced` on every path (the historical `Produced | Verified` discriminator union was collapsed 2026-05-26); plugin callers therefore project the cached payload directly without `'in artifact'` discrimination or synthetic-placeholder branches.

**`noUnusedLocals` quirk** — TypeScript's `noUnusedLocals` (enabled package-wide) is strict: an
underscore prefix (`_ctx`, `_unused`) exempts ONLY function parameters, not top-level locals. For an
unused local that must be retained for type-positional or design-comment reasons, use a trailing
`void <name>;` line — matches the existing `void Scope;` pattern at substrate L0 entrypoints and the
`void ctx;` design-doc pattern in `plugins/wallet/index.ts:142` (kept so the compose-time dependency
edge is documented even though the wallet body doesn't read the resolved value).

---

## 6. Naming

- Plugin factories: **lowercase** (`sui`, `walrus`, `postgres`, `account`, `localPackage`,
  `knownPackage`, `coin`, `wallet`, `seal`, `deepbook`, `action`, `faucet`). v3's PascalCase is
  dropped.
- Capability contracts: **PascalCase** (`Snapshotable`, `Routable`, `Codegenable`,
  `NetworkResolver`, `ChainProbe`, `StrategyContributor`, `Projection`, `Renderer`,
  `ContainerRuntime`).
- Tagged errors: PascalCase. See §2 for `Error` suffix discipline.
- Effect Services: PascalCase ending `Service` (`StrategyRegistryService`, `PortBrokerService`,
  `ArtifactPublisherService`, `ContainerRuntimeService`, `PackageRegistryService`,
  `CoinRegistryService`).
- Branded primitives: `AppName`, `StackName`, `ChainId`, `PluginKey`, `EndpointKey`, `ContentHash`,
  etc. — established in `substrate/brand.ts`.
- Type-only generics with phantom witnesses: `__PrefixedWithDoubleUnderscore` (e.g.
  `__MissingProvidersError<Missing>`, `__LifecycleTableShape`, `__ProjectionFieldsClosed`,
  `__TuiDisplayVocabClean`). Established convention — surfaces structural validation errors at the
  call-site argument.
- Per-instance resource id literal templates: `account/<name>`, `package:<name>`, `coin:<symbol>`,
  `action:<name>`, `deepbook/<name>`. Mixing `/` vs `:` separators is intentional per plugin
  convention; do not "normalize".
- File names: kebab-case (`stage-and-swap.ts`, `cross-process-lock.ts`). Effect-Service module shape
  commonly: `{ index, layer, service }.ts` when nontrivial.
- **`PluginKey` derivation** (substrate `lifecycle/dep-graph.ts:mintKey`):
  - Plugins that need a stable lifecycle key declare `pluginKey: PluginKey | string` in plugin
    metadata; the dep-graph reads it verbatim. Local service factories choose the key shape
    (`seal:${name}`, `walrus:${name}`) so routed services and persisted projection rows remain
    stable across cycles.
  - Plugins without a declared key mint `${member.id}#${ordinal}` where `ordinal` is the position in
    the surrounding member tuple. The `#N` suffix disambiguates two members providing the same
    resource id in one stack.
  - Plugin authors do NOT call `pluginKey(...)` for ordinary task plugins. Reserve declared keys for
    long-lived services or factories whose row identity must survive member reordering.

---

## 7. Imports

Hard rules (lint-enforceable; substrate of `ARCHITECTURE.md`):

- **Plugin A may NOT import from Plugin B.** Cross-plugin communication goes through explicit
  `dependsOn` resource values, public resource refs, or a higher-level runtime composition layer
  that is allowed to import both plugins. Do not import a sibling plugin's internal modules.
- **Substrate is name-blind:** substrate code MUST NOT mention plugin names. Plugin-domain services
  such as `CoinRegistryService` and `PackageRegistryService` are composed outside
  `substrate/runtime/` and injected through `pluginContext`.
- **Substrate must not depend on contract NAMES either.** `substrate/runtime/supervisor.ts:35-40`
  imports six named capability-decl modules; the substrate is name-blind only at the plugin level,
  but capability awareness is also a coupling. Pending inversion via a `CapabilitySinks` registry —
  see Open slot O6.
- **L5 build integrations use `build-integrations/runtime/` (canonical), NOT reimplement.** Today
  four sibling integrations (`vite/`, `vitest/`, `playwright/`, `browser/`) ship their own discovery
  / decode / cold-start / dapp-kit-slot — must consolidate to `runtime/`. See Open slot O7.
- **Apps NEVER import devstack.** L5 example apps consume codegen-emitted manifest + L5
  build-integration helpers only.
- Effect imports: bare `import { Effect, ... } from 'effect'` for the main runtime;
  `@effect/platform`, `@effect/platform-node`, `@effect/vitest` from their own subpaths.
- Cross-package imports inside this monorepo use `@mysten-incubation/devstack/<subpath>` for
  exported public subpaths; relative `.ts` imports inside the package use the explicit `.ts`
  extension because the package enables `allowImportingTsExtensions`.

---

## 8. File organization

- One Effect Service per file when nontrivial. Service modules typically:
  `<primitive>/{ index.ts, layer.ts, service.ts }` (e.g. `state-store/`, `cache/`, `port-broker/`,
  `cross-process/`).
- Plugin barrel (`plugins/<name>/index.ts`) re-exports only what is **user-public**. Plugin
  internals (mode files, registries, errors taxonomy) stay behind package-local imports unless an
  explicit package export exposes them.
- One capability decl per file when nontrivial; the decl barrel (`contracts/index.ts`) re-exports.
- Renderer modules use `.tsx` only when JSX is used (`surfaces/tui/*.tsx`); everything else stays
  `.ts`. Ink dependencies must be lazy-imported (see
  `surfaces/tui/index.ts:dynamic import('./mount-ink.tsx')`).
- File length: no hard limit, but `substrate/runtime/supervisor.ts` at 962 lines is the upper bound
  that has been accepted with a clear sub-module split path. New monoliths above ~700 lines invite a
  "factor by responsibility" review.

---

## 9. Test layout

(See §3 for the parallel-`test/` rule.)

Test directory mirrors source:

```
src/substrate/runtime/lifecycle/dep-graph.ts
test/substrate/runtime/lifecycle/dep-graph.test.ts
```

Existing dirs: `test/substrate/`, `test/plugins/`, `test/orchestrators/`, `test/surfaces/`,
`test/build-integrations/`, `test/e2e/`.

---

## 10. Mode-narrowed factory namespaces

For plugins with modes (sui local/local-rpc/live, walrus local-cluster/known, seal
local-keygen/live/fork-known, deepbook local/live/fork):

- Use `defineModeNamespace` and call the returned namespace with `network` (per
  `api/mode-narrowed-factory.ts`).
- Mode refusal lives at the **TYPE LEVEL**. `walrus.localOf(sui)` is the only valid local Walrus
  call; `walrus()` on a fork-typed branch is a compile error.
- Do NOT add runtime mode checks that the type system could have caught. Mode-narrowed factories use
  two `as` casts inside `defineModeNamespace` — that is the **sole** boundary between runtime
  breadth and type-level narrowness; do not add ad-hoc `if (mode === ...)` runtime guards
  downstream.
- Plugin SDK ergonomics: barre form (`walrus({ ... })`) defaults via the established network
  resolver; explicit form (`walrus.localOf(sui)({ ... })`) is the typed form. Both are first-class.

---

## 10b. L2 wrapper-service around `defineScopedRefMap`

When an L2 plugin owns a per-stack `K -> V` registry (Sui-coin's `CoinRegistry`, Move-package's
`PackageRegistry`, future chain-plugin registries), it MUST follow the wrapper-service shape:

```ts
const FooRefMap = defineScopedRefMap<FooKey, FooRecord>('FooRegistry'); // module-private inner primitive

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

Why:

- Substrate stays name-blind (it sees only `K`, `V`, and an opaque namespace string — see
  ARCHITECTURE.md § Substrate name-blindness).
- The L2 wrapper is the place plugin-specific lookups land (Sui-coin's `bySymbol` / `byWitness` /
  `byType` go on `CoinRegistry`, NOT on the substrate primitive).
- Consumers (CLI / e2e / sibling plugins) yield ONE name (`FooRegistryService`) and provide ONE
  layer (`layerFooRegistry`). They never reach the inner `defineScopedRefMap(...)` factory return.
- Even when the wrapper's surface is a 1:1 re-projection today (e.g. Move-package's
  `PackageRegistry` only re-exposes `set/find/has/entries/changes`), the shape MUST be present —
  it's the L2 plugin's API contract, and future plugin-specific methods land here without forcing
  every consumer to learn a new shape.

Do NOT directly export the `defineScopedRefMap(...)` factory return
(`export const FooRegistry = defineScopedRefMap(...)`). Consumers reaching `FooRegistry.Service` /
`FooRegistry.layer` is a stale pattern — refactor to the wrapper-service shape on touch.

**Convention rule (PR1.5 retro):** L2 plugins instantiate substrate generic primitives via the
wrapper-service pattern, not by re-exposing the factory directly. Two PR1.5 agents arrived at the
migration independently and chose inconsistent shapes (one re-exported the factory return, one
wrapped); the typecheck sweep caught the mismatch only because the rest of the package consumed the
wrapper shape. This rule prevents the recurrence — any future generic-primitive consumer
(chain-plugin registries, future per-stack maps) MUST wrap, not re-export.

---

## 11. artifact publisher usage

All cacheable produce/verify/register artifacts MUST go through `ArtifactPublisher` (substrate
primitive at `primitives/artifact-publisher.ts` + `substrate/runtime/artifact-publisher/`):

- Pattern: `cache → verify(cached) → produce → register`.
- Use `LENIENT_RETRY_PROFILE` for chain reads (cross-cutting convention).
- Do NOT write ad-hoc publish paths. Reference impls: `plugins/package/mode-local.ts:255+`,
  `plugins/coin/mint.ts:223+`.
- Typed seam for `ChainOperation<Produced>` is at
  `substrate/runtime/artifact-publisher/chain-operation.ts` (`sui-tx` / `shell-oneshot` /
  `register-only` variants); O1 closed in PR1-E. New produce bodies MUST express themselves as a
  `ChainOperation` variant; do NOT re-derive the produce shape per-plugin.

---

## 12. Container ensure boilerplate

Use `substrate/runtime/managed-container.ts` for long-running managed containers:

- `managedContainerLabels({ identity, plugin, role })` builds the canonical
  `{ app, stack, plugin, role }` ownership tuple.
- `ensureManagedContainer({ runtime, identity | labels, plugin, role, spec, mapError })` injects
  labels, adds the managed-container span attributes, and projects `ContainerRuntimeError` once.

Plugins own their domain error message through `mapError`; they do not hand-roll label tuples plus
`runtime.ensureContainer(...).pipe(Effect.catch(...))` at each callsite.

---

## 13. Container `exec` / image-op access

`ContainerRuntime.exec` is on the contract (`contracts/container-runtime.ts`) with an optional
`ExecOptions` knob (`user`, `env`, `workdir`). Plugins MUST consume the contract surface — do NOT
introduce per-plugin `containerExec` shims. Postgres's adapter (`plugins/postgres/service.ts`) is a
thin per-handle wrapper around `runtime.exec(handle, argv)`, kept only to project daemon-level
errors into a synthetic non-zero ExecResult; new plugins copy that wrapper if they need the same
projection, but do NOT reimplement the underlying exec.

`saveImage` / `loadImage` / `tagImage` are also on the contract (snapshot orchestrator dependency).
`saveImage(ref)` returns a `Stream<Uint8Array, …>` so large images don't materialise in memory;
`loadImage(tar)` accepts `Stream<Uint8Array, unknown>` and returns the resolved `ImageRef`;
`tagImage(src, newTag)` is an atomic tag move. Plugins MUST go through these — direct
`dockerCommand('save'|'load'|'tag', …)` from a plugin would breach the L1 → L2 boundary.

---

## 14. Cross-plugin dependencies

Public plugin authors declare upstreams with `definePlugin({ dependsOn })`. Do not introduce new
plugin code that reads dependency values through side-channel context APIs.

Use the shape of `dependsOn` to make the `start` callback ergonomic:

- tuple dependencies produce tuple deps: `dependsOn: [suiResource, accountRef]`;
- object dependencies produce object deps: `dependsOn: { sui: suiResource, signer }`;
- a single dependency produces that dependency's resolved value directly.

Built-in options should accept plugin/resource refs (`ResourceRef<id, value>`) rather than substrate
`StackMember` aliases. Preserve the actual plugin value in the factory generic so recursive
`defineDevstack` expansion can see plugin-valued dependencies. Do not add plugin-local casts such as
`deps as ...` to compensate for weak typing; fix the public helper types instead.

Production plugin barrels stay on `definePlugin`, and the engine consumes that resource-native shape
directly.

---

## 15. Per-key serialization (leases)

Substrate L0 owns the per-key lease primitive: `LeaseBrokerService` at
`substrate/runtime/lease-broker/`. Generic, name-blind, scope-bound release.

- Plugins requiring at-most-one-in-flight on an opaque resource (per-address sequence number,
  per-connection gate, per-slot work queue) yield `LeaseBrokerService` and call
  `broker.acquire(leaseKey('<plugin>:<key>'), '<owner>')`.
- Key encoding is a per-plugin convention: the broker treats the key as opaque. Account uses
  `account:<address>`.
- Release is scope-bound; there is no `release()` method. Wrap `broker.acquire(...)` in
  `Effect.scoped` (or call it inside a surrounding scope) and let the finalizer fire.
- Non-reentrant: the broker has no concept of re-entrancy by design. A same-owner nested `acquire`
  against a key the owner already holds will deadlock the inner call. If a caller needs to re-enter,
  restructure the caller — do NOT reintroduce a re-entrant local lock.
- Reference consumer: `plugins/account/lease.ts`
  (`withAddressLease(broker, accountName, address, effect)`) — used by both the funding pass
  (`funding.ts`) and the resolved-value sign/execute closures (`service.ts`).

---

## 15a. Endpoints

- `RoutableDecl` is the canonical declaration for public in-stack endpoints. The router mints the
  hostname and emits the `endpoint.registered` event; plugins do not separately publish their own
  guessed public URL for the same service.
- Resolved-value URL projection is fallback-only. The supervisor suppresses inferred `url`,
  `rpcUrl`, `faucetUrl`, and `graphqlUrl` endpoints when the plugin contributes any routable
  capability. This keeps direct loopback/probe URLs from competing with router-fronted URLs.
- Direct URLs used for boot probes, sibling containers, or host-gateway access must be named as such
  (`direct*`, `probe*`, `hostGateway`) and should not be treated as public endpoint declarations.
- For live/local-rpc modes with no router contribution, resolved-value URL fields may still surface
  as operational endpoints.

---

## 16. Observability

- `Effect.withSpan(...)` + `Effect.annotateCurrentSpan(...)` are the only span-instrumentation entry
  points. No `console.log/warn/error` in production code (zero today — preserve this).
- Span attribute keys MUST flow through `substrate/runtime/observability/spans.ts:SpanAttr`.
  Free-form strings (`'sui.chain'`, `'walrus.committeeSize'`) are a divergence flagged for cleanup —
  see Open slot O12.
- Log-level discipline: `logDebug` per-fetch / per-tick loops; `logInfo` lifecycle transitions;
  `logWarning` retryable failures; `logError` surfacing typed errors. Avoid raw `console.*`.
- Log messages are stable event text; dynamic values go in fields / log annotations. Do not format
  endpoint URLs, request ids, origins, exit codes, or retry causes into the message unless the value
  is the user-facing domain error itself. Renderers and log sinks own presentation.
- The structured `Logger` service (`substrate/runtime/observability/logger.ts`) is the plugin-facing
  buffered log sink. Long-running child processes should route stdout/stderr through
  `ProcessLines.observeProcessLines(...)` from the root plugin-authoring barrel; one-shot command
  capture should use `subprocess-capture.ts`; raw `Stream.decodeText() + Stream.splitLines` belongs
  only inside those substrate helpers.
- Host processes use `substrate/runtime/process-supervisor.ts` for spawn typing, exit/error races,
  exit-status description, and SIGTERM-to-SIGKILL teardown. Plugins should not reimplement
  `once('exit')` / `once('error')` races or shutdown escalation.
- HTTP readiness checks should use `HttpProbes.waitForHttpEndpoint(...)` from the root
  plugin-authoring barrel: callers provide the endpoint, total timeout, retry interval, optional
  per-request timeout, and an optional validator that may parse the response body and return whether
  the endpoint is actually ready.
- Request retry schedules use `substrate/runtime/retry-policy.ts`; do not build local
  `Schedule.exponential(...).pipe(Schedule.jittered, Schedule.both(...))` chains in plugins.
- The `Effect.annotateCurrentSpan` outside `Effect.withSpan` pattern silently drops annotations
  (caught by `runtime-docker.md` review at `container.ts:233`). Wrap in a span first.

---

## 17. Atomic writes

ONE atomic-write primitive: `substrate/runtime/atomic-write.ts`. Two surfaces — one file, one
tempfile dance:

- `atomicWriteFile` / `atomicWriteJson` — Effect/`FileSystem`-based. Used by state-store, cache, and
  manifest.
- `atomicWriteFileSync` / `atomicWriteJsonSync` — `node:fs`-sync. Used by the cross-process modules
  (roster, snapshot-reservation) that hold `stack.lock` and must keep their critical section
  non-yielding.

Rules:

- New code MUST call the canonical primitive. Do NOT inline tempfile + rename.
- **Random ID rule: `crypto.randomUUID().slice(0, 8)`.** Avoid `Math.random()`-based names
  (collision risk in parallel callers + non-cryptographic). The rule applies UNIFORMLY across every
  site that needs a short random suffix: tempfile names (centralised inside `atomic-write.ts`),
  one-shot container names (`runtime/docker/exec.ts`), snapshot reservation ids
  (`orchestrators/snapshot/service.ts`), and `runOneShot` invocations.

---

## 18. Cross-process protocol

- `stack.lock` (O_EXCL) + `roster.json` + `snapshot.reservation` are the three on-disk artifacts.
  Liveness via PID + startTime predicates centralised at
  `substrate/runtime/cross-process/liveness.ts`.
- ONE cross-process lock primitive: the typed `CrossProcessLock` Effect Service.
- Production wiring uses `layerCrossProcessLockFlock` (O_EXCL + PID/start-time liveness via
  `acquireStackLock`). Test wiring uses `layerCrossProcessLockInProcess` (in-memory semaphore —
  single-process only). State-store + cache yield `CrossProcessLock` and let wiring decide.
- Cross-process modules use sync `node:fs` (substrate-fix-plan #11 tracks unification onto Effect
  `FileSystem`); the canonical atomic-write primitive exposes both surfaces (§17) so duplication
  does not creep back in during the interim.
- **Router `contributeRoute` MUST hold the dispatch-file lock across both the file write AND the
  readiness probe** so a sibling contributor cannot publish over a half-staged dispatch file and
  cause Traefik to serve stale content under the same `dispatchFileId`. The probe runs INSIDE the
  surrounding `Effect.scoped(acquireStackLock(...))` block; releasing the lock between write and
  probe is a regression. Reference: `orchestrators/router/service.ts:contributeRoute`.
- Lock-acquire failures during scope-close cleanup MUST surface via `Effect.logWarning` (with the
  error annotated). `.pipe(Effect.ignore)` on `acquireStackLock(...)` silently swallows contention
  and IO errors and is a forbidden pattern — best-effort cleanup is fine, but the leak must be
  visible.

---

## 19. Stage-and-swap

`stage-and-swap.ts` lives in `orchestrators/snapshot/` today. The architecture promises a single
substrate primitive; codegen also needs it (per-cycle outer swap is missing —
`notes/reviews/orchestrators.md` codegen issue 5).

- `stage-and-swap` lives at `substrate/runtime/stage-and-swap/` (O14 closed in PR1-E). Snapshot
  keeps a thin forwarder at `orchestrators/snapshot/stage-and-swap.ts` pending PR3 consumer
  migration.
- New consumers MUST import from the substrate primitive. Do NOT re-implement.

---

## 20. Schema decode

Three patterns exist; ONE is canonical:

- **Canonical:** `decodeUnknown(schema, raw, { source, mkError })` and
  `decodeJsonText(schema, text, { source, mkError })` from `substrate/runtime/runtime-decode.ts` —
  Effect-returning, typed error projection with one parse / decode issue shape.
- **Plugin config:** use `substrate/runtime/config-validation.ts` at factory and boundary sites.
  `defineConfigError(tag)` keeps plugin-owned error tags, scalar `expect*` helpers cover common
  authoring guards, and `decodeConfig(...)` / `decodeConfigSync(...)` wrap Effect Schema failures in
  the same `ConfigIssue` shape. Custom plugin authors import the same helpers from the root
  `ConfigValidation` namespace.
- **Acceptable** (when surrounding context is sync, e.g. cross-process readers):
  `decodeUnknownSync(...)` / `decodeJsonTextSync(...)` inside a `try/catch` that maps corruption to
  a miss or typed error.
- **Banned:** `Schema.decodeUnknownSync(...) as A` bare cast — loses parse errors entirely. Known
  offenders must be migrated on touch.

NDJSON tail-decoders MUST treat per-line decode failure as "skip row + `logDebug`" — a truncated
line during atomic append (the writer is partway through `events.ndjson` when the tail polls) is
normal and MUST NOT kill the surrounding stream. Wrap the per-line decode in a `try`/`catch` that
returns `null` (or a sentinel), filter the sentinel out downstream, and emit `Effect.logDebug` for
diagnostic visibility. Reference: `cli/main.ts:tryDecodeEventRecord`.

---

## 21. Renderer projection — closed-field discipline

`SubscribableState` (substrate/projection.ts:22-40) is a **closed** field set:
`{ identity, cycle, rows, endpoints, errors, lastEvent, stackBuild }`. Adding a display-vocabulary
field (`title`, `primary`, `extras`) is a TS error at the wiring site via
`__ProjectionFieldsClosed`. The TUI carries a second-layer guard `__TuiDisplayVocabClean`.

- **Single source of truth: the code.** Update both the code AND the corresponding section in
  ARCHITECTURE.md in the same change — they must not split.
- Logs live INSIDE rows as `row.logTail`, not as a top-level `logs` field.

---

## 22. Sugar policy

Per `notes/api-comparison.md`, examples are 5-30% longer than v3 because sugar was deferred. The
**fix is to add sugar in the substrate**, not to have every example re-derive boilerplate.

Pending sugar additions (do not add new examples that work around these — instead, wait or fix the
substrate):

- Infer `stackName` from cwd / package.json (S4).
- Action body `ctx.signAndExecute(account, build)` substrate helper (S5).
- `coin.fromPackage(pkg, 'WITNESS')` shape (S10).
- Restore `extras:` field on `DevstackOptions` (S11).
- Root barrel re-exports every plugin factory (S2).

---

## 23. Closing-the-loop opportunities

Per `feedback_agents_report_cleanup_opportunities`: every dispatched agent ends with
`## Opportunities noticed`. Existing rules consolidating notes from all 7 reviews:

- Three duplicate atomic-writes → one (§17).
- Three duplicate Schema-decode patterns → one canonical (§20).
- Four duplicate manifest readers (build-integrations) → one (§7, Open slot O7).
- Three duplicate cold-start URL synthesisers (build-integrations) → one (§7, Open slot O7).
- Three duplicate dapp-kit-slot declarations (build-integrations) → one (§7, Open slot O7).
- Three duplicate `Endpoint` shape definitions → one.
- Per-orchestrator `failPhase` helpers → one (Snapshot, Router, Codegen each have one).
- Per-orchestrator "scope-bound register-with-finalizer" pattern (Ref + seqRef + finalizer) → one
  `makeRegistry<T>()` substrate helper.

When you SEE a duplicate, REPORT in the agent's Opportunities section. When you ADD code, do NOT
create the N+1th copy.

---

## Open slots — pending decisions

The following slots are referenced inline above. They are decision-pending; specific agents own
each.

| ID      | What                                                                                                                                                                                                                                                                                                                                                                                                                | Owner / pass                  | Where it shows up today                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| **O2**  | Tagged-error class style unification (3 → 1)                                                                                                                                                                                                                                                                                                                                                                        | cross-cutting audit           | every plugin + substrate + runtime                                                           |
| **O4**  | Keep boundary decode callsites on `runtime-decode.ts` / `config-validation.ts`; migrate any newly found direct `Schema.decodeUnknown*` wrappers on touch                                                                                                                                                                                                                                                            | substrate triage              | boundary readers and plugin config factories                                                 |
| **O5**  | Cross-plugin Coin↔Package coupling — lift `PublishReceipt` (today Package owns `PublishReceipt`/`PublishObjectChange` and Coin imports them; the proper fix is a substrate-raised `PublishReceiptEmitted` event the coin plugin subscribes to). Pending a substrate event-bus primitive (`substrate/runtime/event-bus/`) generic over event shapes — neither command nor lifecycle channels fit. Related cross-plugin gap: Account↔Coin bidirectional import (lift `AccountFundingStrategy` to `src/contracts/funding-strategy.ts`) and Sui→faucet reverse-import (sui-owned `sui-local` faucet strategy). | substrate / contract redesign | `plugins/coin/discovery.ts`, `plugins/package/coin-discovery.ts`, `plugins/account/funding.ts`, `plugins/sui/index.ts:64-65` |
| ~~**O6**~~  | ~~`CapabilitySinks` registry~~ — landed at `substrate/runtime/capability-sinks/`; supervisor harvest loop dispatches through it; plugin-author Layer composition can inject custom sinks. (Closed)                                                                                                                                                                                                            | closed                        | `substrate/runtime/capability-sinks/`, `supervisor.ts:1383+`                                |
| **O7**  | Consolidate build-integrations to `runtime/`                                                                                                                                                                                                                                                                                                                                                                        | build-integrations cleanup    | `vite/`, `vitest/`, `playwright/`, `browser/`                                                |
| **O8**  | Managed container helper is wired; migrate any newly added direct `runtime.ensureContainer` callsites on touch                                                                                                                                                                                                                                                                                                      | substrate triage              | future container-owning plugins                                                              |
| **O10** | Closed by the resource-native dependency callback model; `BuildContext.use(member)` no longer exists.                                                                                                                                                                                                                                                                                                               | closed                        | `src/substrate/plugin.ts`                                                                    |
| **O12** | `SpanAttr` is canonical for new/touched structured fields; migrate historical free-form span/log keys on touch                                                                                                                                                                                                                                                                                                      | observability cleanup         | older plugin/runtime span sites                                                              |
| ~~**O13**~~ | ~~Wire or delete substrate observability orphans~~ — `Logger` wired via supervisor's `withEventPublishingLogger`; `LifecycleFact` wired via `lifecycle-fact.ts`; `*_ERROR_TAGS` arrays wired via `pluginErrorContributions(...)` + `errorContributions:` in every plugin barrel; `SpanAttr` wired (64 callsites). Surviving sweep work for free-form span keys is tracked at O12. (Closed)                  | closed                        | every plugin's `index.ts`, `substrate/runtime/observability/`, `lifecycle-fact.ts`           |
| **O15** | Closed by resource refs in `dependsOn`; plugin/resource values are the cross-plugin reference mechanism.                                                                                                                                                                                                                                                                                                            | closed                        | every cross-plugin reference site                                                            |
| **O16** | Root-barrel re-export policy                                                                                                                                                                                                                                                                                                                                                                                        | API design pass               | `src/index.ts` (today no clear main entry)                                                   |

**Closed slots** (filled — see ARCHITECTURE.md substrate primitives roster + CHANGELOG):

- ~~O1~~: `ChainOperation<Produced>` typed seam landed (PR1-E).
- ~~O3~~: `ForkIncompatibleError` promoted to substrate at `substrate/runtime/mode-errors.ts`
  (PR1-E); plugin-side duplicates pending PR3 delete.
- ~~O9~~: `ContainerRuntime.exec` on the contract with `ExecOptions` (PR1-D).
- ~~O11~~: `LeaseBroker` substrate primitive (PR1-B); `plugins/account/lease.ts` consumes.
- ~~O14~~: `stage-and-swap` promoted to substrate (PR1-E).
- ~~O17~~: `runStack(stack, opts?) → RunHandle` lands at `src/api/run-stack.ts` (root-barrel
  re-exported); shared substrate Layer composition at `src/substrate/runtime/run.ts` consumed by
  both CLI `runUpLive` and the library surface. `Stack` value stays a struct per
  api-surface-design.md §3 — runtime execution is a separate seam.
- ~~O21~~: `host-tree-tar` primitive — host-tree leg filled at `substrate/runtime/host-tree-tar/`
  (PR1-E).
- ~~O22~~: `ContainerRuntime.{saveImage, loadImage, tagImage}` on the contract (PR1-D).

When a slot is filled by its owning pass, **move it to the Closed list above** (do not delete the ID
— keep the audit reference) and codify the resulting rule in the appropriate section above.

---

## Citations

Rules above derive from explicit findings in the review docs. When in doubt, search the reviews:

- substrate review for the L0 boundary rules.
- runtime-docker review for typed-error envelope shape + classifier centralisation + state-machine
  purity rules.
- orchestrators review for capability-driven dispatch + name-blindness.
- surfaces review for surface-equality and projection-only consumption.
- build-integrations review for the runtime/ consolidation.
- stable-plugins review for the cross-plugin coupling rules + capability-decl shape.
- cross-cutting review for the error-model + observability rules.

PHASE-3-NOTES.md is the type-system bible — every constraint-widening / inference-asymmetry
workaround documented there is load-bearing.
