# AGENTS.md — `@mysten-incubation/devstack`

**Additive** package-specific style for devstack. Repo-wide habits (typed errors, reuse before
re-implementation, version persisted state, prototype-stage discipline) live in the root
[`AGENTS.md`](../../AGENTS.md) and apply here too — this file only covers what's specific to
devstack and assumes you've read root first.

Skills that apply inside this package:

- `.claude/skills/writing-effect/SKILL.md` — devstack is the package's main Effect-TS consumer. Use
  it whenever you touch a file importing from `effect` or `@effect/*`. It covers `Effect.gen`,
  `Effect.fn`, `Schema`, `catchTag`/`catchTags`, observability, and `@effect/vitest`.

Background reading: `.review-findings/synthesis/00-architecture.md` (if present) — descriptive
writeup of the substrate. This file is the _prescriptive_ counterpart.

## Breaking changes are fine

This package is unreleased. Do not add deprecation warnings, soft-deprecation paths, "default keeps
existing behavior" defenses, schema-version fallback loaders, or back-compat shims. When the new API
ships, the old API is deleted in the same change. When the new schema ships, the loader rejects the
old shape. Migrations happen in one direction.

Concretely: don't ship a new option "as opt-in, keep the old default"; flip the default and delete
the old path. Don't keep a legacy field "working with a warning"; remove it. Don't add a `v<N-1>`
fallback in a schema loader; bump the version and require callers to be on the new one. Don't
preserve the old factory name with a re-export; rename it and migrate every callsite in the same
commit.

The repo has zero external consumers. Acting otherwise accretes carry that will outlive its value.

## What devstack is

An Effect-Layer-based declarative supervisor for local Sui development stacks. The user composes a
`devstack(...)` call out of service factories (`Sui()`, `Walrus()`, `Account('alice')`,
`Package('hello', './move')`, …); the supervisor builds a Layer graph, acquires each tag in
dependency order, narrates progress in a TUI, and re-runs on hot-restart.

Two mental models hold most things together: **tags as LayeredTags** (the substrate) and
**registries as a pub/sub bus** (how services tell the rest of the stack what they produced).

## The tag substrate

Every acquirable resource is a `LayeredTag` — a class object carrying a `__layer` producer Effect,
optional metadata (`__kind` / `__displayTitle` / `__watchPaths` / `__hidden`), a `DevstackTagBrand`
unique-symbol brand for runtime discrimination, and a phantom `TagIdentity<Name>` that makes two
structurally-identical tags TS-incompatible. The substrate name `LayeredTag` composes two
Effect-canonical terms (Tag + Layer) without overloading `Effect.Ref` (mutable cell). Two factory
primitives create them:

- **`tag(name, build, options)`** — creates an anonymous LayeredTag. Use when each call should be
  its own identity: `Account('alice')` and `Account('bob')` are separate tags.
- **`provide(TagClass, build, options)`** — installs a build effect on an **externally declared**
  `Context.Service` class (e.g. `SuiTag`). Use when multiple dispatch paths
  (localnet/testnet/mainnet) should target the _same_ tag, so consumers `yield* SuiTag` regardless
  of which builder ran.

### Naming convention

- `<Name>Tag` (PascalCase class) — a bare `Context.Service` class. Singleton services declare these
  (`SuiTag`, `FaucetTag`, `PackageTag`, `CoinTag`). Effect-native pattern; the runtime identity is
  the `'@devstack/<Name>Tag'` Context key.
- `LayeredTag<Name, A, R, E>` (from `'../advanced/tag.js'`) — the user-facing yieldable bundle every
  factory returns. Yield it inside an Effect to get the resolved shape; pass it as `signer` /
  `needs` / etc. to compose stacks.
- No alias for a factory's return type. Reach for `ReturnType<typeof Factory>` if you need to spell
  it.

`composeLayers({ inner?, primary, projections? })` flattens a service's child layers into a
`__layers` array in dependency order. Prefer it when a service has sub-tags (e.g. `Seal` having a
Move-build layer + a key-server container layer).

Don't strip `TagIdentity` with `as`. Don't construct `@devstack/…` Context keys inline — use the
canonical tag class for the service.

### Tag-key naming

Interface tag classes end in `Tag` and their Context-Service key is `@devstack/<ClassName>` (i.e.
the key matches the class name exactly): `SuiTag` → `'@devstack/SuiTag'`, `FaucetTag` →
`'@devstack/FaucetTag'`, `WalrusNetworkTag` → `'@devstack/WalrusNetworkTag'`. Engine-internal
Services (`Identity`, `Registry`, `Leasing`, `Extras`, the `*Registry` classes) don't carry the
`Tag` suffix — they're not service-domain tags. When in doubt: if the class name ends in `Tag`, the
key must end in `Tag` too.

## Service factory shape

Pick a shape by asking "can the user have N of these in one stack?"

- **Pure-object options** — domain-level singletons: `Sui(opts?)`, `Walrus(opts?)`, `Seal(opts)`,
  `Deepbook(opts)`, `Wallet(opts)`.
- **Positional name + options** — per-instance identity: `Account(name, opts?)`,
  `Package(name, path, opts)`, `Action(name, opts)`.

Singleton factories do NOT accept a `name?:` override. The tag name is the canonical endpoint
constant for the service (`EndpointName.WALLET_APP`, etc.). Multiple instances of a singleton in one
stack are unsupported; use separate stacks for separate UIs.

Inside the build effect, `yield* <Dependency>Tag` for everything you depend on — the engine resolves
dep order. If you depend on what another service _published_ (rather than its tag value), yield the
**registry**, not the service tag.

### Signer signatures

Every factory accepting a signer takes `LayeredTag<any, Account, any, any>` — the resolved-Account
tag, not the raw `Account` value. This forces composition through the `Account(...)` factory so the
supervisor's tag-substrate (`__layer`, hot-restart, snapshot participation) lights up. Raw `Account`
/ `Signer` types stay internal (`services/faucet/strategies/*.ts` and the acquire-body inside
`services/seal/internal.ts` consume them after a `yield* signerTag`); they never appear in a
factory's public options interface. Existing callsites that match: `Package`, `Action`, `Coin`,
`Seal`, `Deepbook`'s `market-maker` + `mint` + `local-deploy`, `Pyth`'s `local-deploy` + `pusher`.
New factories accepting a signer follow the same shape.

### Discriminator naming

Tagged-union options use **`kind:`** as the discriminator field. `AccountSpec` is the precedent:
`Account('alice', {kind: 'env', key: 'ALICE_PRIVATE_KEY'})`,
`Account('bob', {kind: 'keystore', alias: 'bob'})`. Don't introduce a new discriminator name
(`from`, `type`, `tag`, `mode`) — every new tagged union uses `kind:` so the convention is
monomorphic.

Per-job factories that overload on input shape (`Coin('SYMBOL')`, `Coin.fromPackage(pkg, witness)`,
`Coin('0x...::T')`, `Coin.builtin('sui')`) do NOT need a discriminator: the input shape selects the
branch and TS narrows automatically. Use that precedent when "this thing has one job; overload on
input shape" applies.

### `Package(...)` contract

`Package(name, path, { signer, mvr?, codegen? })` publishes a local Move package. The resolved value
carries `{ packageId, upgradeCapId, coins, captured, sourcePath, mvrPlaceholder }`.

Coin auto-discovery is implicit: every `coin::create_currency<W>(witness, decimals, b"SYMBOL", ...)`
call in the package's `init` surfaces as `pkg.coins[<symbol>]` carrying
`{ name, fullCoinType, decimals, sdkCoin, treasuryCapId?, metadataId?, symbol?, displayName?, iconUrl? }`.
The TreasuryCap mint strategy auto-registers with the implicit Faucet so `Account({ funding })` can
mint user coins without explicit wiring. The `UpgradeCap` is auto-captured into `pkg.upgradeCapId`.

Address coins three ways:

- `Coin('SYMBOL')` — registry lookup (case-insensitive, matches on CoinMetadata symbol or witness
  type name).
- `Coin.fromPackage(pkg, 'WITNESS')` — explicit per-package lookup; forces a dependency edge on
  `pkg`. Use when the symbol is ambiguous or you want the dep edge encoded in types.
- `Coin('0x...::module::TYPE')` — bare on-chain coin type (live-net or vendored package coins);
  routes through a direct `getCoinMetadata(coinType)` RPC.
- `Coin.builtin('sui')` — hardcoded `0x2::sui::SUI` (no registry, no RPC).

**No `capture:` field, no `coins:` field on `PackageOptions`.** Plugin authors who need to extract
object ids beyond what auto-discovery surfaces (admin caps, registries, DAO objects, custom shared
objects) reach for `PackageWithCapture` on `/advanced`:

```ts
import { PackageWithCapture } from '@mysten-incubation/devstack/advanced';

const dao = PackageWithCapture('dao', './move/dao', {
	signer: publisher,
	capture: {
		adminCapId: '::dao::AdminCap',
		registryId: '::dao::Registry',
	},
});
// Resolved: dao.captured.{adminCapId, registryId}
```

Coin auto-discovery still runs alongside `PackageWithCapture`; the `capture` lambda only adds
non-coin ids to `pkg.captured`.

### Implicit Faucet

`devstack(...)` auto-mounts a `Faucet()` when the user doesn't supply one. Plugin authors writing
custom faucet strategies (e.g. a CI-specific RPC fund spigot) reach for
`Faucet({ strategies: [...] })` from `@mysten-incubation/devstack/advanced` and pass it explicitly —
the auto-mount detects the user-supplied ref via tag key prefix (`faucet/...`) and skips the
synthetic one.

What the auto-mount registers:

- **SUI HTTP strategy** — best-effort, when `SuiTag.faucet` is reachable (localnet always; testnet
  often).
- **Per-coin TreasuryCap mint strategies** — registered automatically by `Package(...)` via the coin
  auto-discovery pass. Each coin whose TreasuryCap is held by the publisher account becomes
  addressable through `Account({ funding: { '<symbol-or-coinType>': amount } })` and through the
  dev-wallet UI's "Get <symbol>" panel.

What the auto-mount does NOT register:

- **WAL exchange strategy** — wired by the `Walrus(...)` factory's internal layer when present, but
  not added by the default mount.
- **Custom strategies** — anything you want beyond the built-ins goes through
  `Faucet({ strategies })` on `/advanced`.

The auto-mount lives in `compose/defaults.ts` (same place `Sui()` auto-fills); composing your own
stack via `defineDevstack` from `/advanced` bypasses `fillDefaults` and gives you full control over
which provider refs land in the layer graph.

## The `internal.ts` / directory split

When does a service get more than one file?

- **Single file (`service.ts`)** — total ≲ 600 LoC, no sub-factory state to share. Default.
- **Facade + monolithic internal (`service.ts` + `service/internal.ts`)** — small public facade,
  bulk logic privately in one module.
- **Facade + concern-modules (`service.ts` + `service/<concern>.ts`)** — three or more
  independently-testable concerns. The directory replaces `internal.ts`; never have both
  `service/internal.ts` and `service/<concern>.ts` siblings.

"Internal" in a filename always means "private to `/advanced` or below," never "exported from the
package root."

The rule above applies to **new services**. Several existing services predate it and stay monolithic
past the 600-LoC threshold — `services/sui.ts` (~1.1k), `services/account.ts` (~960),
`services/seal/internal.ts` (~1.2k), `services/walrus/internal.ts` (~890). Don't reach for these as
templates; they're historical. When adding the _next_ concern to one of them, splitting it down the
rule is the right call, not following its current shape.

## Lifecycle: per-primitive scopes, selective restart

Every primitive (each `tag()` / `provide()` call) builds on its own Layer scope — Effect's
`Layer.effect` forks one scope per entry via the supervisor's MemoMap, and the `withEngineLifecycle`
wrap registers that scope with the engine so it can be closed selectively. There is no `lifecycle`
option: deleted in the selective-restart sweep, along with the old `engine/long-lived-scope.ts`
substitution.

What survives a hot-restart now is decided by the dep graph + the watch event, not by an annotation:

- **User-driven `r` / SIGUSR2** — closes the supervisor's outer scope, cascading finalize to every
  primitive. Everything tears down + rebuilds.
- **File-watch fire** — `engine.invalidateSubset(affected)` closes only the affected primitives'
  scopes (owner + its strictly-downstream consumers from the dep graph). Siblings keep their value,
  their scope, and their TUI row state. Sui / Walrus / Seal survive a `.move` edit because they
  aren't downstream of the changed primitive — no opt-in needed.

If you find a primitive that's getting torn down on watch-fires when it shouldn't, the fix is in the
dep graph (`__upstreamKeys`), not in a lifecycle annotation. The plan's R4 mitigation surfaces a
reboot-cost warning when heavy infra ends up in an affected set; the fix for that warning is "fix
the graph," not "silence the warning."

## Registries are an append-only pub/sub bus

`engine/registries.ts` defines the canonical registries (`PackageRegistry`, `EndpointRegistry`,
`AccountRegistry`, `CoinRegistry`, plus per-service state registries for Sui, Seal, Walrus,
Deepbook, Pyth, Postgres, DeepbookIndexer, DeepbookServer, DeepbookMargin). Services publish into
them; readers (manifest emitter, codegen, CLI status, TUI) consume at finalization or on demand.

- Publish via the helpers: `publishEndpoint`, `publishPackage`, `publishAccount`, `publishCoin`,
  `publishSuiState`, `publishSealState`, `publishWalrusState`, `publishDeepbookState`, etc.
- Don't `yield*` another service's tag to learn what it published — yield the registry.
  Service-to-service tag yields are reserved for genuine ordering dependencies (e.g. a service that
  must run after another's Move package publishes).
- Registries are singletons inside `InfraLive`; don't define your own.

### Adding a registry

Three lines:

```ts
// 1. The record interface.
export interface MyRecord {
	readonly name: string;
	readonly /* ... */;
}

// 2. The Context.Service tag.
export class MyRegistry extends Context.Service<MyRegistry, RegistryShape<MyRecord>>()(
	'@devstack/MyRegistry',
) {}

// 3. Live + publish + require via `defineRegistry`.
export const {
	Live: MyRegistryLive,
	publish: publishMyRecord,
	require: requireMyRegistry,
} = defineRegistry<MyRegistry, MyRecord>(MyRegistry);
```

The factory (`engine/define-registry.ts`) absorbs the per-registry boilerplate
(`Layer.effect(...)` + `(yield* X).register(entry)` wrapper) so the per-service declarations stay
small. Keep the `Context.Service` class declaration at the call site — that's where tag identity
narrows; the factory is type-erased over the record type.

## The manifest is the wire format

`runtime/manifest-schema.ts` (currently v5) is the contract between the running supervisor and every
downstream consumer (codegen, Playwright, dev-wallet, CLI). Read it via `gatherManifest()`
(in-Effect, live registries) — surfaced from `/advanced` for plugin authors. Node-only consumers
reading the on-disk JSON parse it directly
(`JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest`); the v5 schema is all-strings so no
reviver is needed today. Never re-walk the filesystem looking for the manifest — call
`discoverManifestPath()`.

Endpoint names are a closed set in `runtime/endpoint-names.ts`. Adding a new externally-addressable
URL is a one-declaration operation: one `defineEndpoint(...)` call carries the conventional-route +
manifest-field metadata that the cold-start router (`runtime/conventional-routes.ts`) and the
manifest grouper (`runtime/service.ts`) both consult. The factory lives in
`engine/define-endpoint.ts`.

```ts
const postgres = defineEndpoint({
	name: 'postgres',
	conventional: { service: 'postgres', port: 5432 },
	manifestField: { path: 'services.postgres.endpoint' },
	publishedBy: 'Postgres()',
});

export const EndpointName = {
	// ...
	POSTGRES: postgres.name,
} as const;
```

The producer calls `publishEndpoint({ name: EndpointName.X, url })` at acquire time; the rest
(conventional routing, grouper projection) derives from the declaration. Endpoints surfaced under a
heterogeneous manifest shape (sibling state record + endpoint URL — e.g. Sui's
`services.sui.{rpc, faucet, ...}` + `chainId`) still need a grouper that knows how to fold the state
record in, but the field-name table is data-driven from `manifestField.path`. The
`runtime/service.test.ts` `EndpointName constants` describe locks the string values so a typo at
declaration time fails loudly.

## State-store keys

`engine/state-store.ts` is the disk-backed K/V for cached deploys, derived artifacts, keys, etc.
Root AGENTS.md already requires versioning persisted state; devstack's concrete format and
additional rules:

- Key format: `<service>/<artifact>/v<N>/<chainId>/...`. The version segment is mandatory.
- Don't write a migration unless the artifact is expensive to recompute. The default behavior is to
  bump `v<N>`, accept a decode miss as cache invalidation, and re-derive.
- Locks are per-stack and acquired when the state-store opens; don't roll your own lockfile.

## Observability — spans and annotations

Span names are PascalCase service-domain phrases — `SuiBoot`, `WalrusPublishPackage`,
`SealKeyServer`, `PackagePublish`. Existing non-conforming spans (`manifest.write`, `git-fetch`,
etc.) get migrated as their files are touched; new code uses the PascalCase form.

Annotation keys carry a service-name prefix and a dot-separated path: `sui.chainId`, `walrus.epoch`,
`package.name`, `account.address`. Three keys are universally stamped via
`engine/observability.ts`'s `annotateDevstackContext(service)` helper — `service.name`,
`devstack.stack`, `devstack.app` — so spans inside a primitive's `Effect.withSpan(...)` block carry
enough context to correlate across services within one supervisor cycle.

```ts
yield* dockerRun(...).pipe(
  Effect.tap(() => annotateDevstackContext('sui')),
  Effect.withSpan('SuiBoot'),
);
```

## Errors

The unified tagged-error catalog lives in `engine/errors.ts`. On top of the root AGENTS.md "typed,
tagged, contextual" rule:

- The canonical "which step" field is `phase: string`. Engine pretty-printing and the TUI status row
  key on this name; alternates (`stage` / `op` / `command`) render blank.
- **Phase-field shape rule:** `phase` is a closed `Schema.Literals(...)` union, required for
  lifecycle errors (acquire / discover / configure / start / ready / finalize — the ones that
  surface in the TUI's per-row status), and marked `Schema.optional` for service-internal errors
  that callers don't pattern-match on. Never `Schema.String` (open) on a new error — the open shape
  makes catch sites brittle to typos. The exceptions today (`HostProcessError`, `DockerError`)
  accept open strings because they wrap arbitrary subprocess errors and the phase carries free-form
  CLI argv context; new errors don't get the same latitude.
- Identity field naming convention: `accountName`, `packageName`, `emitterName`, etc. — whichever
  named entity the error is about.
- Subprocess wrappers carry truncated `stderr`/`stdout` and `exitCode`; `pretty-error.ts` truncates
  `stderr` at 8 KiB.
- Use `Schema.TaggedErrorClass`. `Data.TaggedError` appears in some older modules (codegen, faucet,
  CLI) and gets migrated as those files are touched.
- Re-export every error a user might `catchTag` from the package root, not only from `/advanced`. A
  consumer catching a faucet failure shouldn't have to reach into the plugin-author barrel to import
  the type.

## Shared helpers — use these before writing your own

Use the in-tree helper rather than inlining a near-copy.

| If you're about to write…                      | Use                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Extract created object ID from `objectChanges` | `engine/sui-helpers.ts` `pickCreatedByType(changes, { suffix \| includes \| prefix, all? })`                                                                                                                                                                                               |
| Atomic state-file write                        | `engine/atomic-write.ts`                                                                                                                                                                                                                                                                   |
| "Where is the manifest?"                       | `runtime/discover-manifest.ts` `discoverManifestPath`                                                                                                                                                                                                                                      |
| "Which stack is the user on?" (CLI)            | `cli/stack-resolution.ts` `resolveStack` / `resolveStackFromEnv`                                                                                                                                                                                                                           |
| "Where does the user's devstack app live?"     | `engine/resolve-app-dir.ts` `resolveAppDir()` (CLI re-export at `cli/stack-resolution.ts`) — never inline `process.env.DEVSTACK_APP_DIR ?? process.cwd()`                                                                                                                                  |
| "Load `devstack.config.ts`"                    | `cli/loaders.ts` `loadConfigModule` / `requireLaunchEffect`                                                                                                                                                                                                                                |
| Content-addressed Docker image build           | `advanced/plugin-author/docker-image.ts` `dockerImage`                                                                                                                                                                                                                                     |
| Build a one-shot container action              | `advanced/plugin-author/docker-one-shot.ts` `dockerOneShot`                                                                                                                                                                                                                                |
| Sync filesystem lock with stale-PID reclaim    | `engine/file-lock.ts` `tryClaimLockSync` / `releaseLockSync` — wraps the wx-mode acquire + `process-liveness.ts` stale check. Port allocator + sui-fork data lock both use it. State-store's lock has its own Effect-platform retry loop (jittered exponential backoff) and stays distinct |
| New devstack registry                          | `engine/define-registry.ts` `defineRegistry<I, T>(Tag)` — produces `{Live, publish, require}` from a `Context.Service` class declaration                                                                                                                                                   |
| New devstack endpoint                          | `engine/define-endpoint.ts` `defineEndpoint({name, conventional?, manifestField?, publishedBy?})` — one site drives conventional-route lookup + manifest grouper                                                                                                                           |
| Wrap a `LayeredTag` as a service factory       | `advanced/make-service.ts` `makeService(name, body)` — stamps `__kind`/`__pluginName` so the supervisor + TUI categorise it correctly. Reach for it when authoring a new built-in or plugin-author-grade factory                                                                           |
| Map `DockerError` into your error type         | `engine/docker/wrap.ts` `wrapDocker(makeError)` — combinator for converting docker subprocess failures into a service's tagged-error shape inside an `Effect.gen` body                                                                                                                     |
| Content-addressed cache around a build step    | `engine/cache.ts` `withCache(spec)` — wrap any cache-keyed compute with a `verify` probe; failures of `verify` evict the cache entry and re-run. Used by the package publish, walrus deploy, and seal keygen caches today                                                                  |
| Compute a content hash (sha256 → hex)          | `engine/content-hash.ts` `contentHash(input, options?)` / streaming `createContentHasher()` — the canonical hasher for cache keys, replacing several inline `createHash('sha256')` callsites                                                                                               |
| Write-if-changed for emitter output            | Local `writeIfChanged` in `codegen/emitters/{stack-handle,dapp-kit-config}.ts` — duplicated today; extract to `codegen/` if your emitter would be the third caller                                                                                                                         |

## CLI conventions

Three reporting patterns; the rule is whichever you pick, don't double-print:

- **Mutating commands** — `Console.error()` the human diagnostic, then fail with
  `AlreadyReportedError`. `failAlreadyReported` in `cli/already-reported.ts` is the shorthand. The
  top-level `Effect.tapCause` in `cli/index.ts` skips the second print on this sentinel.
- **Mutating commands with structured output** — `apply`-style: explicit `catch`, render (JSON or
  plain text), fail with `AlreadyReportedError`.
- **Read-only inspection** — `status`, `doctor`: tolerate errors and emit a partial result. No
  sentinel needed; errors flow through `tapCause` and print normally.

Stack resolution always goes through `cli/stack-resolution.ts` — no inline
flag-vs-env-vs-active-file precedence chains.

### Underscore-prefixed files (`_*.ts`)

A file in `cli/commands/` whose basename starts with `_` is a **helper module, not a registered
command**. Today the only example is `cli/commands/_prune-stack.ts`, which factors out the
container/volume sweep used by `down`, `wipe`, and `reset`. The underscore signals to the reader
(and to future tooling that walks the commands directory) that the module isn't wired into the
top-level command registry in `cli/index.ts` — it exists only to be imported by sibling commands. If
you add another such helper, keep the same `_` prefix so the convention stays grep-able.

## Codegen contract

An `Emitter<R>` is `{ name, emit(ctx): Effect<void, CodegenError, R> }`. Each emitter sees the same
immutable `CodegenContext`. Rules:

- Don't move directories yourself — the top-level Codegen layer handles the atomic swap between the
  staging tree and `outputDir`.
- Read live stack state via `gatherManifest()`. The one defensible exception is `BindingsEmitter`
  reading `ctx.packages[].sourcePath`, because source-tree metadata doesn't belong in the manifest
  schema (see `codegen/emitters/bindings.ts` header comment).
- Use `writeIfChanged` so Vite HMR doesn't get re-triggered on every codegen pass.
- File modes: `0o600` if the file contains secrets (extras), `0o644` otherwise. The mode is part of
  the contract.
- **Output path:** All emitters write under `./src/generated/` (the `DEFAULT_CODEGEN_OUTPUT`
  constant in `services/codegen.ts`). Don't write outside that tree — downstream consumers (bindings
  imports, dapp-kit config imports, generated coin records) all read from there. The deepbook
  plugin-expansion plan once cited `src/devstack/deepbook-config.ts`; that's stale — the emitter
  writes to `src/generated/deepbook/...` per the codegen contract.
- **Default emitter list:** the `Codegen()` factory in `services/codegen.ts` ships a default list
  (`BindingsEmitter`, `StackHandleEmitter`, `DappKitConfigEmitter`, `DeepbookConfigEmitter`). A new
  emitter joins this list only when it short-circuits cleanly on services that aren't present in the
  stack — `DappKitConfigEmitter` is the precedent: it returns `Effect.void` when no Sui service is
  mounted. Emitters that crash, log spuriously, or assume their input service is always present
  don't go in the default list; users add them explicitly via
  `Codegen({ emitters: [MyEmitter()] })`.

## Snapshot participation

Every container-backed service answers three questions in its top-of-file docstring under a
`Snapshot participation:` heading:

1. **What does this service persist?** (state-store keys, `runtime/<svc>/` files, container writable
   layers.)
2. **What re-derives from on-chain state on apply?** (Cached deploy outputs keyed by source-hash +
   chainId.)
3. **What is intentionally lost on snapshot restore?** (Account balances if not re-fauceted;
   in-memory caches.)

A grep of `'Snapshot participation:'` should hit every container-backed service. If you're adding
one, add the section.

## Running tests — fast vs. slow

`pnpm --filter @mysten-incubation/devstack test` runs everything, including the docker-backed
suites:

- `src/engine/docker.test.ts` — exercises the Docker engine bindings.
- `src/engine/snapshot.docker.test.ts` — full save → wipe → restore cycle against a real Docker
  daemon (the gold-standard regression test for the snapshot subsystem).

These start real containers, load images, and bind host ports — they're expensive and they don't
compose with concurrent vitest runs. For iteration:

```bash
# Fast: skip docker-backed tests
pnpm --filter @mysten-incubation/devstack exec vitest run --exclude '**/*.docker.test.ts'

# Just the docker tests
pnpm --filter @mysten-incubation/devstack exec vitest run '**/*.docker.test.ts'

# Single docker test, by name
pnpm --filter @mysten-incubation/devstack exec vitest run src/engine/snapshot.docker.test.ts -t 'partial name'
```

**Parallel sub-agents (architecture review, batch refactors) should not run docker tests.** They
contend on the same host Docker daemon and port range, and twenty agents each spinning containers is
a worst case. Sub-agents default to the fast subset; the full suite (including docker) runs once at
the end as a single verification pass.

### Test harnesses (`testkit` files)

The `*.testkit.ts` filename suffix marks a **non-test test harness** — a module that boots real
infrastructure (containers, scope-scoped resources, pinned upstream state) for other test files to
borrow, but doesn't itself declare `describe` / `it` blocks. They sit alongside the modules they
support and follow this contract:

- Their default export (or named helper) returns an Effect that acquires the harness — typically
  wrapped in a `Scope` so the per-test scope cascades the teardown.
- They `expose Scope finalizers` so the daemon is left clean on pass OR fail.
- They are **not** discovered by vitest's default include glob (which is `*.test.ts`), so they don't
  cost CI time on their own.
- The current example is `engine/sui-fork.testkit.ts` — boots a `sui-fork` container at a pinned
  testnet checkpoint and surfaces a `SuiGrpcClient` + `ForkControl` adapter. Every fork-mode
  integration test goes through this harness rather than calling `Docker.run` directly.

If you find yourself spawning the same infra in multiple `*.test.ts` files, extract it into a
sibling `*.testkit.ts` and re-export the harness rather than copy-pasting setup code.

### Add a new endpoint

1. Append a `defineEndpoint(...)` constant to `runtime/endpoint-names.ts` with the `name`, optional
   `conventional: {service, port}` (for traefik-routed URLs), and optional `manifestField: {path}`
   (for endpoints projected into structured `services.X.Y` / `app.X` manifest slots).
2. Expose its `.name` under `EndpointName` so consumers can reach for the constant.
3. At the producer, `yield* publishEndpoint({ name: EndpointName.X, url })`.
4. If the manifest projection is heterogeneous (state record + endpoint URL merged into one services
   block — Sui-shaped), edit the corresponding `group*` helper in `runtime/service.ts` to fold the
   new field in. For simple `services.<svc>.<field>` projections the `manifestLeafUnder` helper
   already derives the field name from the declaration.
5. The `EndpointName constants` describe in `runtime/service.test.ts` locks the string value — add
   the new key alongside the others.

### Add a new service

1. Decide factory shape (singleton → pure options; per-instance → positional name).
2. Define the tag — `Context.Service` class if multiple dispatch paths target it; anonymous `tag()`
   otherwise.
3. Add a state-store key with `/v1`.
4. Publish into registries via the `publish*` helpers (or roll your own registry via
   `defineRegistry` — see [§ Adding a registry](#adding-a-registry)).
5. If it exposes a URL, run the [endpoint cookbook](#add-a-new-endpoint).
6. Add the `Snapshot participation:` block.
7. Add a service test using `@effect/vitest` `it.layer`.

### Add a new emitter

1. `defineEmitter({ name, emit: (ctx) => Effect.gen(function* () { ... }) })`.
2. Read live state via `gatherManifest()`; don't touch registries directly unless you're
   `BindingsEmitter`-shaped (source-tree metadata).
3. Use `writeIfChanged`; don't manage the output directory yourself.
4. Pick file mode 0o600 vs 0o644 per the [codegen contract](#codegen-contract).
5. Tests should include a string-match for emitted shape **and** a test that imports a generated
   symbol — string-match alone won't catch a compile-time regression.

### Add a CLI command

1. Pick a reporting pattern from [CLI conventions](#cli-conventions).
2. Resolve the stack name via `resolveStack` / `resolveStackFromEnv` — no inline precedence chains.
3. If you need the manifest, call `discoverManifestPath` and parse the resulting file with
   `JSON.parse(readFileSync(p, 'utf-8')) as Manifest` — don't re-walk the filesystem.
4. Wire it into the root command in `cli/index.ts`.

## Out of scope (call it out)

- Generic Effect-TS questions — read `.claude/skills/writing-effect/SKILL.md`.
- Repo-wide habits — they're in the root [`AGENTS.md`](../../AGENTS.md). This file only covers
  what's specific to devstack.
- Plugin-author surface design — guidance in `src/advanced/index.ts`'s header comment is current;
  this file points at it rather than duplicating it.
