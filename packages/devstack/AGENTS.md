# AGENTS.md — `@mysten-incubation/devstack`

**Additive** package-specific style for devstack. Repo-wide habits (typed errors,
reuse before re-implementation, version persisted state, prototype-stage
discipline) live in the root [`AGENTS.md`](../../AGENTS.md) and apply here too —
this file only covers what's specific to devstack and assumes you've read root
first.

Skills that apply inside this package:

- `.claude/skills/writing-effect/SKILL.md` — devstack is the package's main
  Effect-TS consumer. Use it whenever you touch a file importing from `effect`
  or `@effect/*`. It covers `Effect.gen`, `Effect.fn`, `Schema`,
  `catchTag`/`catchTags`, observability, and `@effect/vitest`.

Background reading: `.review-findings/synthesis/00-architecture.md` (if
present) — descriptive writeup of the substrate. This file is the
*prescriptive* counterpart.

## What devstack is

An Effect-Layer-based declarative supervisor for local Sui development stacks.
The user composes a `devstack(...)` call out of service factories
(`Sui()`, `Walrus()`, `Account('alice')`, `Package('hello', './move')`, …); the
supervisor builds a Layer graph, acquires each tag in dependency order, narrates
progress in a TUI, and re-runs on hot-restart.

Two mental models hold most things together: **tags as LayeredTags** (the
substrate) and **registries as a pub/sub bus** (how services tell the rest of
the stack what they produced).

## The tag substrate

Every acquirable resource is a `LayeredTag` — a class object carrying a `__layer`
producer Effect, optional metadata (`__kind` / `__displayTitle` / `__watchPaths` /
`__hidden`), a `DevstackTagBrand` unique-symbol brand for runtime discrimination,
and a phantom `TagIdentity<Name>` that makes two structurally-identical tags
TS-incompatible. The substrate name `LayeredTag` composes two Effect-canonical
terms (Tag + Layer) without overloading `Effect.Ref` (mutable cell). Two factory
primitives create them:

- **`tag(name, build, options)`** — creates an anonymous LayeredTag. Use when each
  call should be its own identity: `Account('alice')` and `Account('bob')` are
  separate tags.
- **`provide(TagClass, build, options)`** — installs a build effect on an
  **externally declared** `Context.Service` class (e.g. `SuiTag`). Use when
  multiple dispatch paths (localnet/testnet/mainnet) should target the *same*
  tag, so consumers `yield* SuiTag` regardless of which builder ran.

### Naming convention

- `<Name>Tag` (PascalCase class) — a bare `Context.Service` class. Singleton
  services declare these (`SuiTag`, `FaucetTag`, `PackageTag`, `CoinTag`).
  Effect-native pattern; the runtime identity is the `'@devstack/<Name>Tag'`
  Context key.
- `LayeredTag<Name, A, R, E>` (from `'../advanced/tag.js'`) — the
  user-facing yieldable bundle every factory returns. Yield it inside an
  Effect to get the resolved shape; pass it as `signer` / `needs` / etc. to
  compose stacks.
- No alias for a factory's return type. Reach for `ReturnType<typeof Factory>`
  if you need to spell it.

`composeLayers({ inner?, primary, projections? })` flattens a service's child
layers into a `__layers` array in dependency order. Prefer it when a service
has sub-tags (e.g. `Seal` having a Move-build layer + a key-server container
layer).

Don't strip `TagIdentity` with `as`. Don't construct `@devstack/…` Context keys
inline — use the canonical tag class for the service.

### Tag-key naming

Interface tag classes end in `Tag` and their Context-Service key is
`@devstack/<ClassName>` (i.e. the key matches the class name exactly):
`SuiTag` → `'@devstack/SuiTag'`, `FaucetTag` → `'@devstack/FaucetTag'`,
`WalrusNetworkTag` → `'@devstack/WalrusNetworkTag'`. Engine-internal Services
(`Identity`, `Devstack`, `Registry`, `Leasing`, `Extras`, the `*Registry`
classes) don't carry the `Tag` suffix — they're not service-domain tags. When
in doubt: if the class name ends in `Tag`, the key must end in `Tag` too.

## Service factory shape

Pick a shape by asking "can the user have N of these in one stack?"

- **Pure-object options** — domain-level singletons: `Sui(opts?)`,
  `Walrus(opts?)`, `Seal(opts)`, `Deepbook(opts)`.
- **Positional name + options** — per-instance identity: `Account(name, opts?)`,
  `Package(name, path, opts)`, `Action(name, opts)`.

Inside the build effect, `yield* <Dependency>Tag` for everything you depend on
— the engine resolves dep order. If you depend on what another service
*published* (rather than its tag value), yield the **registry**, not the
service tag.

## The `internal.ts` / directory split

When does a service get more than one file?

- **Single file (`service.ts`)** — total ≲ 600 LoC, no sub-factory state to
  share. Default.
- **Facade + monolithic internal (`service.ts` + `service/internal.ts`)** —
  small public facade, bulk logic privately in one module.
- **Facade + concern-modules (`service.ts` + `service/<concern>.ts`)** — three
  or more independently-testable concerns. The directory replaces
  `internal.ts`; never have both `service/internal.ts` and
  `service/<concern>.ts` siblings.

"Internal" in a filename always means "private to `/advanced` or below," never
"exported from the package root."

The rule above applies to **new services**. Several existing services predate
it and stay monolithic past the 600-LoC threshold — `services/sui.ts` (~1.1k),
`services/account.ts` (~960), `services/seal/internal.ts` (~1.2k),
`services/walrus/internal.ts` (~890). Don't reach for these as templates;
they're historical. When adding the *next* concern to one of them, splitting
it down the rule is the right call, not following its current shape.

## Lifecycle: `'per-cycle'` default, `'long-lived'` opt-in

Every tag picks a lifetime; the default is `'per-cycle'` (torn down on every
hot-restart). Annotate as `'long-lived'` for any resource whose external state
or rebuild cost should survive `r`:

- Container-backed network services with on-disk state (chain DBs, key servers).
- Anything whose acquire cost dominates the cycle wall time.

Stick with `'per-cycle'` for accounts, actions, package publishes, dev
processes, wallet HTTP servers — quick to re-spawn; state in the registry or
state-store, not in-memory.

Implementation lives in `engine/long-lived-scope.ts`. The annotation triggers a
`Scope.Scope` substitution so finalizers attach to the long-lived scope; you
shouldn't poke at `LongLivedScope` directly unless you have a reason
(`/advanced` exports it for that case).

## Registries are an append-only pub/sub bus

`engine/registries.ts` defines eight registries (`PackageRegistry`,
`EndpointRegistry`, `AccountRegistry`, `CoinRegistry`, plus per-service state
registries). Services publish into them; readers (manifest emitter, codegen,
CLI status, TUI) consume at finalization or on demand.

- Publish via the helpers: `publishEndpoint`, `publishPackage`,
  `publishAccount`, `publishCoin`, `publishSuiState`, `publishSealState`,
  `publishWalrusState`, `publishDeepbookState`.
- Don't `yield*` another service's tag to learn what it published — yield the
  registry. Service-to-service tag yields are reserved for genuine ordering
  dependencies (e.g. a service that must run after another's Move package
  publishes).
- Registries are singletons inside `InfraLive`; don't define your own.

## The manifest is the wire format

`runtime/manifest-schema.ts` (currently v4) is the contract between the running
supervisor and every downstream consumer (codegen, Playwright, dev-wallet,
CLI). Read it via `gatherManifest()` (in-Effect, live registries) or
`fromManifest()` (Node-only, parses a `manifest.json` from disk). Never re-walk
the filesystem looking for the manifest — call `discoverManifestPath()`.

Endpoint names are a closed set in `runtime/endpoint-names.ts`. Adding a new
externally-addressable URL is a five-step operation:

1. Add a constant to `EndpointName`.
2. `publishEndpoint(EndpointName.X, ...)` at the producer.
3. Add a grouper case in `runtime/service.ts` mapping the constant into the
   manifest shape.
4. Add an entry in `runtime/conventional-routes.ts` for cold-boot fallback.
5. Lock the string value with an assertion in the `EndpointName constants`
   describe in `runtime/service.test.ts`.

Forgetting step 4 silently breaks pre-supervisor consumers (Playwright
`webServer`, dapp-kit cold-boot fallback) — they fall back to `undefined`.
Forgetting step 3 makes the endpoint vanish from the manifest grouper.

## State-store keys

`engine/state-store.ts` is the disk-backed K/V for cached deploys, derived
artifacts, keys, etc. Root AGENTS.md already requires versioning persisted
state; devstack's concrete format and additional rules:

- Key format: `<service>/<artifact>/v<N>/<chainId>/...`. The version segment is
  mandatory.
- Don't write a migration unless the artifact is expensive to recompute. The
  default behavior is to bump `v<N>`, accept a decode miss as cache invalidation,
  and re-derive.
- Locks are per-stack and acquired when the state-store opens; don't roll your
  own lockfile.

## Errors

The unified tagged-error catalog lives in `engine/errors.ts`. On top of the
root AGENTS.md "typed, tagged, contextual" rule:

- The canonical "which step" field is `phase: string`. Engine pretty-printing
  and the TUI status row key on this name; alternates (`stage` / `op` /
  `command`) render blank.
- Identity field naming convention: `accountName`, `packageName`,
  `emitterName`, etc. — whichever named entity the error is about.
- Subprocess wrappers carry truncated `stderr`/`stdout` and `exitCode`;
  `pretty-error.ts` truncates `stderr` at 8 KiB.
- Use `Schema.TaggedErrorClass`. `Data.TaggedError` appears in some older
  modules (codegen, faucet, CLI) and gets migrated as those files are touched.
- Re-export every error a user might `catchTag` from the package root, not
  only from `/advanced`. A consumer catching a faucet failure shouldn't have
  to reach into the plugin-author barrel to import the type.

## Shared helpers — use these before writing your own

Use the in-tree helper rather than inlining a near-copy.

| If you're about to write…                       | Use                                                                 |
|-------------------------------------------------|---------------------------------------------------------------------|
| Extract created object ID from `objectChanges`  | `engine/sui-helpers.ts` `pickCreatedByTypeIncludes` / `pickCreatedByTypeSuffix` |
| Atomic state-file write                         | `engine/atomic-write.ts`                                            |
| "Where is the manifest?"                        | `runtime/discover-manifest.ts` `discoverManifestPath`               |
| "Which stack is the user on?" (CLI)             | `cli/stack-resolution.ts` `resolveStack` / `resolveStackFromEnv`    |
| "Load `devstack.config.ts`"                     | `cli/loaders.ts` `loadConfigModule` / `requireLaunchEffect`          |
| Content-addressed Docker image build            | `advanced/plugin-author/docker-image.ts` `dockerImage`              |
| Build a one-shot container action               | `advanced/plugin-author/docker-one-shot.ts` `dockerOneShot`         |
| Liveness of a PID-holding lockfile              | Pattern in `engine/state-store.ts` + `engine/port-allocator.ts`; not yet a public helper — extract one when you'd be the third caller |
| Write-if-changed for emitter output             | Local `writeIfChanged` in `codegen/emitters/{stack-handle,dapp-kit-config}.ts` — duplicated today; extract to `codegen/` if your emitter would be the third caller |

## CLI conventions

Three reporting patterns; the rule is whichever you pick, don't double-print:

- **Mutating commands** — `Console.error()` the human diagnostic, then fail
  with `AlreadyReportedError`. `failAlreadyReported` in
  `cli/already-reported.ts` is the shorthand. The top-level `Effect.tapCause`
  in `cli/index.ts` skips the second print on this sentinel.
- **Mutating commands with structured output** — `apply`-style: explicit
  `catch`, render (JSON or plain text), fail with `AlreadyReportedError`.
- **Read-only inspection** — `status`, `doctor`: tolerate errors and emit a
  partial result. No sentinel needed; errors flow through `tapCause` and
  print normally.

Stack resolution always goes through `cli/stack-resolution.ts` — no inline
flag-vs-env-vs-active-file precedence chains.

## Codegen contract

An `Emitter<R>` is `{ name, emit(ctx): Effect<void, CodegenError, R> }`. Each
emitter sees the same immutable `CodegenContext`. Rules:

- Don't move directories yourself — the top-level Codegen layer handles the
  atomic swap between the staging tree and `outputDir`.
- Read live stack state via `gatherManifest()`. The one defensible exception
  is `BindingsEmitter` reading `ctx.packages[].sourcePath`, because source-tree
  metadata doesn't belong in the manifest schema (see
  `codegen/emitters/bindings.ts` header comment).
- Use `writeIfChanged` so Vite HMR doesn't get re-triggered on every codegen
  pass.
- File modes: `0o600` if the file contains secrets (extras), `0o644`
  otherwise. The mode is part of the contract.

## Snapshot participation

Every container-backed service answers three questions in its top-of-file
docstring under a `Snapshot participation:` heading:

1. **What does this service persist?** (state-store keys, `runtime/<svc>/`
   files, container writable layers.)
2. **What re-derives from on-chain state on apply?** (Cached deploy outputs
   keyed by source-hash + chainId.)
3. **What is intentionally lost on snapshot restore?** (Account balances if
   not re-fauceted; in-memory caches.)

A grep of `'Snapshot participation:'` should hit every container-backed
service. If you're adding one, add the section.

## Running tests — fast vs. slow

`pnpm --filter @mysten-incubation/devstack test` runs everything, including the
docker-backed suites:

- `src/engine/docker.test.ts` — exercises the Docker engine bindings.
- `src/engine/snapshot.docker.test.ts` — full save → wipe → restore cycle
  against a real Docker daemon (the gold-standard regression test for the
  snapshot subsystem).

These start real containers, load images, and bind host ports — they're
expensive and they don't compose with concurrent vitest runs. For iteration:

```bash
# Fast: skip docker-backed tests
pnpm --filter @mysten-incubation/devstack exec vitest run --exclude '**/*.docker.test.ts'

# Just the docker tests
pnpm --filter @mysten-incubation/devstack exec vitest run '**/*.docker.test.ts'

# Single docker test, by name
pnpm --filter @mysten-incubation/devstack exec vitest run src/engine/snapshot.docker.test.ts -t 'partial name'
```

**Parallel sub-agents (architecture review, batch refactors) should not run
docker tests.** They contend on the same host Docker daemon and port range, and
twenty agents each spinning containers is a worst case. Sub-agents default to
the fast subset; the full suite (including docker) runs once at the end as a
single verification pass.

### Add a new endpoint

Follow the five steps in [§ The manifest is the wire format](#the-manifest-is-the-wire-format).

### Add a new service

1. Decide factory shape (singleton → pure options; per-instance → positional
   name).
2. Decide lifecycle (`'long-lived'` for container-backed network state; default
   otherwise).
3. Define the tag — `Context.Service` class if multiple dispatch paths target
   it; anonymous `tag()` otherwise.
4. Add a state-store key with `/v1`.
5. `publishEndpoint` / `publishPackage` / etc. for anything other services or
   manifest readers will need.
6. If it exposes a URL, run the [endpoint cookbook](#add-a-new-endpoint).
7. Add the `Snapshot participation:` block.
8. Add a service test using `@effect/vitest` `it.layer`.

### Add a new emitter

1. `defineEmitter({ name, emit: (ctx) => Effect.gen(function* () { ... }) })`.
2. Read live state via `gatherManifest()`; don't touch registries directly
   unless you're `BindingsEmitter`-shaped (source-tree metadata).
3. Use `writeIfChanged`; don't manage the output directory yourself.
4. Pick file mode 0o600 vs 0o644 per the [codegen contract](#codegen-contract).
5. Tests should include a string-match for emitted shape **and** a test that
   imports a generated symbol — string-match alone won't catch a compile-time
   regression.

### Add a CLI command

1. Pick a reporting pattern from [CLI conventions](#cli-conventions).
2. Resolve the stack name via `resolveStack` / `resolveStackFromEnv` — no
   inline precedence chains.
3. If you need the manifest, call `discoverManifestPath` + `fromManifest` —
   don't re-walk the filesystem.
4. Wire it into the root command in `cli/index.ts`.

## Out of scope (call it out)

- Generic Effect-TS questions — read `.claude/skills/writing-effect/SKILL.md`.
- Repo-wide habits — they're in the root [`AGENTS.md`](../../AGENTS.md). This
  file only covers what's specific to devstack.
- Plugin-author surface design — guidance in `src/advanced/index.ts`'s header
  comment is current; this file points at it rather than duplicating it.
