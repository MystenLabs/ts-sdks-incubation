# package

## Purpose

The `Package(name, sourcePath, opts)` factory and its sibling `KnownPackage(name, opts)` form the
Move-package service of devstack — the surface by which a user declares that a Move source tree
should be built and published to the chain (or, in the case of `KnownPackage`, that a fixed on-chain
package id should be threaded through the same pipelines as if it had been freshly published). The
factory returns a `LayeredTag` (a Context.Service-shaped Ref) that downstream consumers — `Codegen`,
`Action({needs:[pkg]})`, `Coin('SYMBOL')`, `bindings`/`@mysten/codegen`, the deepbook / pyth /
walrus composites, `Faucet`'s TreasuryCap mint strategies, the on-disk `manifest.json` emitter — all
`yield*` to obtain the resolved
`{packageId, upgradeCapId, coins, captured, sourcePath, mvrPlaceholder}` shape after the publish
side effect has landed.

The publish itself is content-hashed against the Move source tree and `chainId`: a no-op rebuild on
the same chain reuses the previously published `packageId` (via the substrate-level `withCache`
cache), while any edit to a tracked source file misses the cache and re-publishes, cascading through
`bindings` regen and downstream consumers via the `__upstreamKeys` dep graph. The `KnownPackage`
variant skips the build

- publish entirely and just declares a record into the same `PackageRegistry` — the type signature
  distinguishes locally-published packages (which satisfy `LocalPackage` with a `sourcePath`) from
  known ones (which satisfy only `Package`), so a `KnownPackage` cannot be passed where Move source
  is required (e.g. the `BindingsEmitter` that shells out to `sui move summary` against the source
  tree).

Project terminology defined the first time it appears below:

- **LayeredTag** — devstack's hand-rolled wrapper around an `Effect.Context.Service` that also
  carries an `__layer` / `__layers` Effect Layer, plus metadata for the dep graph
  (`__upstreamKeys`), the TUI dashboard (`__kind`, `__pluginName`, `display`), the file watcher
  (`__watchPaths`), and Codegen participation (`__codegenExclude`).
- **substrate** — the engine-internal helpers (`onChainArtifact`, `withCache`, `tag`, `provide`)
  shared across services. See `01-engine-core.md` / `02-engine-resources.md`.
- **on-chain artifact** — the unified `inputs → verify → produce → register` shape every on-chain
  primitive uses, factored out of `publishMove` into `engine/on-chain-artifact.ts`.
- **MVR** / **Move-Resolved-Reference placeholder** — the symbolic identifier that Codegen emitters
  substitute in generated TS instead of hard-coding the post-publish `packageId`, so emitted
  bindings stay portable across networks (`@local/<slug>` by default).
- **publish receipt** — the `objectChanges[]` array returned by `signer.signAndExecute(publishTx)`;
  carries `'published'` (package id) and `'created'` (object ids) entries the post-publish
  projection consumes.
- **coin auto-discovery** — the projection in `services/coin/discovery.ts` that walks the publish
  receipt for `0x2::coin::TreasuryCap<T>` + `0x2::coin::CoinMetadata<T>` pairs, cross-references
  them by inner coin type, and surfaces every coin the publish created as a `pkg.coins[<symbol>]`
  entry. Removes the need for the user to spell coins out explicitly.

## Current implementation

In-scope source files:

- `src/services/package.ts` (298 LOC) — the public factory `Package`, `/advanced`-only
  `PackageWithCapture`, the `Package` / `LocalPackage` / `Coin` TS interfaces + their `PackageTag` /
  `LocalPackageTag` / `CoinTag` Context.Service tag classes + Schema mirrors, the `Coin`/`CoinTag`
  declarations (the coin-side interface/tag lives here because every coin originates from a
  published Package), the `compileCapture` helper that compiles a declarative `capture:` Record-spec
  into a callback, and the re-export of `toSdkCoin` from `runtime/sdk-coin.js`.
- `src/services/package/internal.ts` (654 LOC) — `publishMove(opts)` itself: the
  `onChainArtifact`-based factory that wires `hashMoveSources` → `scrubCachedMoveLocks` →
  `buildMove` → `signer.signAndExecute(publishTx)` → fullnode ready-probe →
  `discoverCoinsFromPublish` + `fetchCoinMetadataMany` → `publishPackage` + `publishCoin` +
  `registerMintStrategies`. Also declares the per-call `Package<TCaptured>` runtime shape +
  compile-time `_LocalPackageCompatibilityCheck` to keep it structurally compatible with
  `LocalPackage`, the `mvrSlugify` helper, the `UPGRADE_CAP_TYPE_SUFFIX` constant, and the exported
  `hashMoveSources(sourcePath)` helper.
- `src/services/known-package.ts` (121 LOC) — `KnownPackage(name, opts)` factory that returns a
  `Package`-shaped LayeredTag without running a publish; the module-level `accumulatedSeedObjects`
  Set (read by `services/sui.ts`'s `buildFork` so fork stacks pre-seed KnownPackage-declared object
  ids); the `collectKnownPackageSeedObjects`
  - `clearKnownPackageSeedObjects` helpers that bridge the supervisor / Sui factory composition-time
    gap.
- `src/engine/registries.ts` (Package-specific portions only — approximately lines 30–36 for
  `PackageRecord`, 236–239 for the tag class, 307–311 for the Live layer + `publishPackage` +
  `requirePackageRegistry`).
- `src/engine/errors.ts` (Package-specific portion — line 151–165 for `PublishError`, plus
  `PublishPhases` defined at `engine/phases.ts:55-63`).
- `src/engine/known-deployments.ts` (441 LOC; in scope only insofar as `KnownPackage` typically
  pulls its `packageId` literal from `knownDeployments[<service>][<network>].packageId`, and the
  `resolveDeploymentNetwork(network)` helper exists for fork variants). The Walrus/Seal/Deepbook
  payload-specific fields are out of scope and covered in the per-service docs.

Total source LOC in scope (excluding `known-deployments.ts`, which is covered partially by other
docs): 298 + 654 + 121 = **1,073 LOC** in the package service core, plus the small Package-specific
slices of `registries.ts` and `errors.ts`.

Tests:

- `src/services/package/internal.test.ts` (233 LOC) — pure-unit exercise of `hashMoveSources` + a
  static assertion on the cache-key chainId fold.
- `src/engine/known-package.fork.test.ts` (125 LOC) — pure-unit coverage of
  `resolveDeploymentNetwork` mapping + `KnownPackage`-seed-object accumulator.
- (Indirect coverage: `src/engine/snapshot.docker.test.ts:113-138, 189-239` exercises the
  publishMove cache-key shape end-to-end; `engine.test.ts:184-208` exercises `PublishError`
  cause-chain extraction; `state-store-keys.test.ts:13-21` exercises the (apparently unused)
  `StateStoreKeys.publishMove` builder; `codegen/emitters/bindings.test.ts:305-355` exercises the
  KnownPackage-vs-LocalPackage branch in the bindings emitter; `services/codegen.test.ts:20-43`
  exercises the `Codegen({packages: [localTag, knownTag]})` type-discipline. These files are in
  other docs' scope but cover Package surface from the consumer side.)

Total test LOC primarily-in-scope: 233 + 125 = **358 LOC**.

## Configuration

`PackageOptions` (`services/package.ts:161-173`):

- `signer: LayeredTag<any, Account, any, any>` (REQUIRED) — the Account ref that signs the publish
  transaction and ends up holding the resulting `UpgradeCap`. Yielded as `upstream.signer` so the
  topological scheduler places `publishMove` strictly after its account
  (`services/package/internal.ts:556-563`).
- `mvr?: string` (DEFAULT `@local/${mvrSlugify(name)}`) — override for the MVR placeholder.
  `mvrSlugify` (`services/package/internal.ts:502-511`) lowercases, replaces non-`[a-z0-9-]` with
  `-`, collapses runs, strips leading/trailing dashes, prepends `pkg-` for digit-leading slugs, and
  falls back to `pkg` for fully-collapsed names.
- `codegen?: boolean | { emitters?: ReadonlyArray<unknown> }` (DEFAULT `true`) — `false` stamps
  `__codegenExclude: true` on the returned ref so `Codegen({packages: [...]})` filters this entry
  out at compose time (`services/package.ts:208-216`, `services/codegen.ts:195`). Per-package
  emitter override is declared in the type but the read-side wiring beyond the boolean exclusion is
  not visible in package.ts — see the codegen doc.

`PackageWithCaptureOptions` (`services/package.ts:250-265`) extends the above with a required
`capture: CaptureSpec<TCaptured>`. Two accepted shapes:

- **Record form** — `{ adminCapId: '::dao::AdminCap', registryId: '::dao::Registry' }`. Each value
  is a type-substring; the helper `compileCapture` (`services/package.ts:237-248`) compiles this to
  a callback that runs `pickCreatedByType(changes, {includes: typeSubstring})` per key and returns a
  `Record<key, string | undefined>`.
- **Callback form** — `(changes: ReadonlyArray<SuiObjectChange>) => TCaptured`. Pass-through.

`KnownPackageOptions` (`services/known-package.ts:20-41`):

- `packageId: string` (REQUIRED) — on-chain id this name resolves to.
- `mvrPlaceholder?: string` (DEFAULT undefined → downstream emitters use `name` directly).
- `upgradeCapId?: string` (DEFAULT undefined; rare — known packages typically don't expose the cap
  to the consumer).
- `seedObjects?: ReadonlyArray<string>` (DEFAULT undefined) — accumulated into the module-level
  `accumulatedSeedObjects` Set; `services/sui.ts:1665-1677` reads via
  `collectKnownPackageSeedObjects()` and unions into `Sui({fork: {seed:{objects}}})` so a fork stack
  pre-fetches them on first boot.

`PublishMoveOptions<Name, TCaptured>` (`services/package/internal.ts:187-239`) is the kitchen-sink
internal options shape `publishMove` consumes; both `Package` and `PackageWithCapture` project into
a subset. Notable internal-only fields:

- `path: string | Effect.Effect<string, never, any>` — accepts either a literal filesystem path
  (factory-time-known, the common case) or an Effect that resolves to a path at acquire time (used
  by Seal's `gitFetch` fallback to route vendored Move sources through `publishMove` —
  `services/package/internal.ts:201-211`). Runtime- resolved paths skip the file-watcher
  auto-attachment (`services/package/internal.ts:540`).

Environment / engine-level inputs (not direct PackageOptions but read indirectly):

- `SuiTag.chainId` — folded into the cache key (`engine/cache.ts:124-128`); a regenesis flips it and
  naturally misses the cache.
- `SuiTag.rpc.host` + `SuiTag.faucet?.host` — passed to `buildMove`
  (`services/package/internal.ts:328-331`).
- `SuiBuildImage` (Context.Reference; populated by `Sui()` when an in-container build is available)
  — dispatches `sui move build` inside the localnet's container instead of against the host CLI
  (`engine/sui-cli.ts:120-140`).
- `SuiBuildContainer` (optional Context.Service; the long-lived per-stack build container) —
  preferred over a fresh `docker run --rm` per build when reachable (`engine/sui-cli.ts:133-139`).
- `FaucetTag` (optional Context.Service) — when present, `registerMintStrategies`
  (`services/package/internal.ts:256-280`) auto-registers a `treasuryCapMintStrategy` per discovered
  coin whose cap the publisher still holds.
- `StateStore` — the cache backend; consumed indirectly via `withCache` (`engine/cache.ts:119-156`).
- `ChainProbe` — the typed `getObject(id)` accessor verify uses
  (`services/package/internal.ts:590-591`).

There are no env vars or CLI flags directly read by the package service. The Move-source build path
can be influenced by build-time factors `Sui()` sets up (`SuiBuildImage`, `SuiBuildContainer`),
documented in the sui doc; the build itself shells out to `sui move build` via
`engine/sui-cli.ts:113-236`.

## Capabilities CONSUMED

### Other devstack services / Context tags (LayeredTag-style)

- `SuiTag` (`services/package/internal.ts:599`, also referenced via `SuiTag.chainId` inside
  `onChainArtifact.ts:243-247`). Used for the chain handle (`sui.client.core.getObject`), the RPC
  URL passed to `buildMove(rpcUrl)`, and the optional faucet URL.
- `ChainProbe` (`engine/on-chain-artifact.ts:244,250`) — the verify probe calls
  `chain.getObject(cached.packageId)`.
- Per-call `signer` (declared as `upstream.signer` — `services/package/internal.ts:563`). Resolved
  to an `Account` shape with `address` + `signAndExecute(tx)` from `engine/shared.js`.
- `FaucetTag` (`services/package/internal.ts:26,261`) — optional; when in scope,
  `registerMintStrategies` registers a `treasuryCapMintStrategy` per coin. Best-effort: missing
  Faucet is a no-op.
- `PackageRegistry` (`engine/registries.ts:236-239`) — consumed by `KnownPackage` and `publishMove`
  via the `publishPackage(record)` free function (`engine/registries.ts:309`).
- `CoinRegistry` (`engine/registries.ts:251-253`) — consumed via the `publishCoin(record)` free
  function (`engine/registries.ts:331`).

### Engine resources (substrate)

- `onChainArtifact` substrate (`engine/on-chain-artifact.ts:189`) — composes `withCache` + a
  `register` step + `tag` into one wrapped LayeredTag. `publishMove`'s `inputs` / `verify` /
  `produce` / `register` callbacks are this substrate's contract.
  (`services/package/internal.ts:519-653`.)
- `withCache` (`engine/cache.ts:109`) — the `${namespace}/${chainId}/${contentHash(inputs)}` cache
  discipline. Inputs are `{sourceHash, signer.address}` for `publishMove`
  (`services/package/internal.ts:572-578`).
- `StateStore` (`engine/state-store.ts`, consumed via `withCache`) — the per-stack on-disk
  JSON-backed key-value store. Records the `publishMove/<chainId>/<inputsHash> → Package<TCaptured>`
  entries.
- `setPhase` (`advanced/tag.ts:73-79`, called at `services/package/internal.ts:320,343,360`) —
  narrates lifecycle to the TUI dashboard. Three phases announced: `'building move'`,
  `'publishing'`, `'capturing'`.
- `tag` (via `onChainArtifact`'s `return tag(...)` — `engine/on-chain-artifact.ts:292`) — produces
  the LayeredTag with identity `<name>`, kind `'action'`, plugin `'move'`.
- `pickCreatedByType` (`engine/sui-helpers.js`) — used in two places: (a) by `publishMove` for the
  UpgradeCap pick (`services/package/internal.ts:411-413`); (b) by `compileCapture` for the
  declarative `capture:` Record-spec (`services/package.ts:241-247`).
- `contentHash` / `createContentHasher` / `digestHex` (`engine/content-hash.ts`, imported at
  `services/package/internal.ts:18`) — feeds the source-tree hash reduction.
- `buildMove` (`engine/sui-cli.ts:113-236`, imported at `services/package/internal.ts:17`) — shells
  out to `sui move build` (host, container, or `docker exec` mode); returns
  `{modules, dependencies}` that `t.publish(...)` consumes.
- `scrubCachedMoveLocks` (`engine/sui-cli.ts:551-586`, imported at
  `services/package/internal.ts:17`) — scrubs `~/.move/git/**/Move.lock` files of `[pinned.<env>.*]`
  / `[env.<env>.*]` sections before the build, so vendored deps don't bake testnet/mainnet ids into
  bytecode.
- `stripPinnedSections` (`engine/sui-cli.ts:712`, re-exported through
  `services/package/internal.ts:17`) — the pure transform used by `hashMoveSources` so cache key
  digests don't flip on `sui move build` rewriting the lockfile (`internal.ts:79-81`).
- `discoverCoinsFromPublish` (`services/coin/discovery.ts:95-147`, imported at
  `services/package/internal.ts:28`) — pure projection from publish receipt →
  `ReadonlyArray<DiscoveredCoin>`.
- `fetchCoinMetadataMany` (`services/coin/loader.ts:140`, imported at
  `services/package/internal.ts:29`) — one concurrent batch RPC per publish to populate
  `symbol`/`displayName`/`iconUrl`/`decimals`.
- `treasuryCapMintStrategy` (`services/faucet/strategies/treasury-cap-mint.ts:43`, imported at
  `services/package/internal.ts:27`) — wrapped per coin inside `registerMintStrategies` so funding
  flows can mint from the publisher's cap.
- `setPhase` reads the ambient `CurrentTagKey` reference (`advanced/tag.ts:330`) populated by
  `tag()` so phase narration attributes to the right TUI row.

### Effect / Layer / Context machinery

- `Effect.gen`, `Effect.serviceOption`, `Effect.tryPromise`, `Effect.retry`, `Effect.timeoutOrElse`,
  `Effect.annotateCurrentSpan`, `Effect.withSpan`, `Effect.catchTag`, `Effect.fail`,
  `Effect.logWarning` — standard Effect v4 surface (`services/package/internal.ts`).
- `Schedule.spaced('200 millis')` (`services/package/internal.ts:398`) — the polling cadence for the
  post-publish fullnode ready probe.
- `Context.Service` (`services/package.ts:52,75,135`) — declaring the `PackageTag` /
  `LocalPackageTag` / `CoinTag` singleton-style tag classes.
- `Schema.Struct` / `Schema.UndefinedOr` / `Schema.Literals` / `Schema.TaggedErrorClass`
  (`services/package.ts:82-99,146-155`; `engine/errors.ts:151-165`) — runtime-validation mirrors and
  the `PublishError` Schema-tagged error.

### External / runtime resources

- Host `sui` CLI binary OR the per-stack `images/sui/` Docker image (consumed via `buildMove` — see
  sui doc for the build-mode matrix). The build dials the RPC URL passed in (`sui.rpc.host`) so the
  build resolver can resolve auto-deps against the right chain id.
- The `@mysten/sui` SDK (`Transaction`, `client.core.getObject`) — imported at
  `services/package/internal.ts:14` and consumed via the resolved `signer.signAndExecute(tx)` +
  `sui.client.core.getObject({objectId})`.
- The host filesystem — `FileSystem.FileSystem` from `@effect/platform`
  (`services/package/internal.ts:11,46`) is used to read source files for hashing.
- The `ChildProcessSpawner.ChildProcessSpawner` from `effect/unstable/process`
  (`services/package/internal.ts:12,297`) is in the produce body's R channel because it's required
  by `buildMove`'s shell-out.
- `~/.move/git/<repo>@<rev>/` — sui-cli's content-addressed git deps cache; `scrubCachedMoveLocks`
  walks this tree to strip pinned env sections. A host-wide `O_EXCL` advisory lock under
  `withMoveBuildLock(moveHome, ...)` serializes concurrent builds so two `publishMove`s don't race
  on the git index (`engine/sui-cli.ts:178-187`).

### Imports from other workspace packages / npm dependencies

- `effect` (FileSystem, Effect, Schema, Schedule, Context).
- `effect/unstable/process` (ChildProcessSpawner).
- `@mysten/sui/transactions` (Transaction).
- `node:path` (path.join, path.relative, path.dirname).
- Implicit: anything imported through `engine/sui-cli.ts` (which brings in `effect/platform-node`,
  `node:os`, etc.).

## Capabilities PRODUCED

### TypeScript exports consumed elsewhere

- `Package(name, path, opts)` factory (`services/package.ts:201`, re-exported from
  `services/index.ts:71` and root `index.ts:53`).
- `KnownPackage(name, opts)` factory (`services/known-package.ts:80`, re-exported from
  `services/index.ts:116` and root `index.ts:64`).
- `PackageWithCapture(name, path, opts)` factory (`services/package.ts:280`, exported only from
  `advanced/index.ts:84`).
- `Package` / `LocalPackage` interfaces (`services/package.ts:38-42,67-71`).
- `Coin` interface (`services/package.ts:120-133`) — the minimal coin contract every
  `pkg.coins[<key>]` and `Coin('SYMBOL')` resolved-value satisfies.
- `PackageTag` / `LocalPackageTag` / `CoinTag` Context.Service tag classes
  (`services/package.ts:52,75,135`).
- `PackageSchema` / `LocalPackageSchema` / `CoinSchema` Schema mirrors
  (`services/package.ts:82,92,146`).
- `PackageOptions` / `PackageWithCaptureOptions` / `CaptureSpec`
  (`services/package.ts:161-173,224-232,250-265`).
- `KnownPackageOptions` (`services/known-package.ts:20-41`).
- `collectKnownPackageSeedObjects()` / `clearKnownPackageSeedObjects()`
  (`services/known-package.ts:65-74`) — consumed by `services/sui.ts:1665-1677` (`buildFork`) and by
  `compose/devstack.ts` (to clear between two `devstack(...)` composes in one process).
- The re-exported `toSdkCoin` from `runtime/sdk-coin.js` (`services/package.ts:140`).
- Internal-only: `publishMove(opts)` (the underlying primitive — imported by
  `services/package.ts:25` only).
- Internal-only: `hashMoveSources(sourcePath)` (exported from `services/package/internal.ts:44` for
  test access).

### State-store entries

Cache key shape (`engine/cache.ts:171-178`, asserted at
`services/package/internal.test.ts:222-232`):

```
publishMove/<chainId>/<inputsHash>
```

Where `inputsHash` is
`contentHash(JSON.stringify({sourceHash, signer.address}, jsonBigintReplacer), {length: 16})`.

Value shape (`services/package/internal.ts:162-170`, `Package<TCaptured>`):

```ts
{
	name: string;
	packageId: string;
	upgradeCapId: string | undefined;
	captured: TCaptured;
	coins: Record<string, PublishedCoin>;
	sourcePath: string;
	mvrPlaceholder: string;
}
```

The `sourcePath` and `mvrPlaceholder` fields are mutated onto the resolved value in the `register`
step (`services/package/internal.ts:626-628`) AFTER the cache fetch; they are also stored in the
cached payload because `produceFreshPackage` populates them at
`services/package/internal.ts:483-484`.

The `coins[<key>]` entry is `PublishedCoin` (`services/package/internal.ts:116-154`):

```ts
{
  name: string;       // discovered symbol or witness-name fallback
  module: string;
  type: string;       // witness type name
  decimals: number;
  fullCoinType: string;
  sdkCoin: { address: string; type: string; scalar: number };
  treasuryCapId?: string;
  metadataId?: string;
  treasuryCapOwner?: string;
  publisherOwnsCap?: boolean;
  symbol?: string;
  displayName?: string;
  iconUrl?: string;
  packageId?: string;
}
```

Note: the older `StateStoreKeys.publishMove({packageName, sourceHash, chainId})` builder at
`engine/state-store-keys.ts:24-28` constructs a key of shape
`publishMove/<packageName>/<sourceHash>/<chainId>`, but this builder is unused in production (no
callers — confirmed by `grep`). The actual cache key built by `onChainArtifact` + `withCache`
follows `publishMove/<chainId>/<inputsHash>` — see `snapshot.docker.test.ts:113-116` for the
canonical shape comment and `services/package/internal.test.ts:222-232` for the chainId fold
assertion. This is an opportunity to clean up; see "Opportunities noticed".

### Registry entries

- `PackageRegistry`: a `PackageRecord` (`engine/registries.ts:30-36`):
  ```ts
  { name, packageId, upgradeCapId?, mvrPlaceholder?, captured? }
  ```
  Written by `publishPackage(...)` from:
  - `services/package/internal.ts:630-636` (publishMove's register step, on EVERY cycle hit and
    miss).
  - `services/known-package.ts:102-107` (KnownPackage's `tag(...)` build body).
- `CoinRegistry`: a `CoinRecord` (`engine/registries.ts:166-225`) per discovered coin. Written by
  `publishCoin(...)` from `services/package/internal.ts:638-650` for every entry of `pkg.coins`.
  KnownPackage does NOT auto-populate coins (no publish receipt to discover from).

### Events / lifecycle attribution

- TUI dashboard row — `kind: 'action'`, plugin `'move'`, `displayTitle: 'publish.<name>'`, primary
  line = `pkg.packageId`, extras = `'<N> coin(s)'` when present
  (`services/package/internal.ts:521-554`). KnownPackage uses `kind: 'package'`, plugin `'move'`,
  `displayTitle: 'packages.<name>'`, extras `['known']` (`services/known-package.ts:110-119`).
- Three lifecycle phases narrated via `setPhase`: `'building move'`, `'publishing'`, `'capturing'`.
  Visible in the row's status while acquiring.
- Span annotations: `publishMove.sourcePath` / `publishMove.sourceHash` on the
  `PublishMoveHashSources` span (`services/package/internal.ts:102-105`).

### File watcher participation

- Each `Package(name, path, opts)` with a literal `path` adds the path to the `__watchPaths` array
  on its returned LayeredTag (`services/package/internal.ts:526-541`). The supervisor aggregates
  these into the runtime watch set (`engine/supervisor.ts:1414-1431`); a `.move` / `Move.toml` edit
  under that root triggers a hot-restart. Today this is a whole-stack restart
  (`engine/supervisor.ts:1450-1452`).
- Runtime-resolved `path` (the Effect branch) is NOT auto-watched — vendored sources under
  `<appDir>/.devstack/git-cache/...` rely on the `gitFetch` primitive's own re-fetch logic on
  git-ref bumps.

### Dep graph upstream attribution

- The returned LayeredTag's `__upstreamKeys` includes the resolved `signer` LayeredTag's identity
  (`services/package/internal.ts:563`). This is what makes the topological scheduler place
  `publishMove` strictly after its account; without it, both would land in level 0 and the
  resolved-upstream `yield* options.signer` would fail with "Service not found".
- `SuiTag` and `ChainProbe` are implicit upstreams — the substrate yields them itself
  (`engine/on-chain-artifact.ts:114-119,243-247`) and they are NOT in `__upstreamKeys`. `Sui()`'s
  own `__layers` carry `ChainProbeLive` so the dep is satisfied in scope.

### Manifest fields

The `gatherManifest()` projection (`runtime/service.ts:310-318`) emits one entry per `PackageRecord`
under `packages[<name>]`:

```ts
{ id, captured: captured ?? {}, upgradeCapId?, mvr? }
```

Coins surface separately under `coins[<name>]` from `CoinRegistry`.

### CLI / file outputs

- No direct CLI command registration. Indirectly drives:
  - Bindings TS files (under `<output>/bindings/`) via the `BindingsEmitter` reading
    `CodegenPackage.sourcePath` for each LocalPackage.
  - `manifest.json`'s `packages` map written by the `manifest-emit` runtime step.
- Container images, volumes, host sockets: none owned by Package itself. The build container path is
  owned by Sui (`SuiBuildImage` / `SuiBuildContainer`).

## Lifecycle

### Startup (`publishMove`, per-package)

The substrate (`onChainArtifact` + `withCache`) drives the sequence; this is the per-package
per-cycle path:

1. **Acquire signer + SuiTag + ChainProbe.** The substrate yields `upstream.signer` first
   (`engine/on-chain-artifact.ts:228-238`), then `SuiTag`, then `ChainProbe`. Blocks until each is
   ready.
2. **Resolve sourcePath.** For literal-string paths, immediate. For Effect-form paths (`gitFetch`
   round-trip), runs the Effect now (`services/package/internal.ts:574-575`).
3. **Run `hashMoveSources(sourcePath)`.** Walks the tree, hashes every `.move` + `Move.toml` +
   scrubbed `Move.lock`, returns a 16-char hex digest (`services/package/internal.ts:44-107`).
4. **Compose the cache key.** `withCache` builds
   `publishMove/${sui.chainId}/${contentHash({sourceHash, signerAddress})}` and reads it from
   `StateStore` (`engine/cache.ts:119-135`).
5. **On cache hit:**
   - **Verify probe:** `chain.getObject(cached.packageId)` is called
     (`services/package/internal.ts:590-591`); returns the cached value when the object is
     queryable, `undefined` when not. `ChainProbe.getObject` is lenient (RPC failures map to
     `undefined`).
   - **Hit:** Log `'publishMove(<name>): cache hit'`, annotate span `cache.outcome: 'hit'`, skip
     build + publish, jump to step 9.
   - **Verify-fail:** Log `'publishMove(<name>): cache verify-fail'`, evict the entry, fall through
     to step 6.
6. **On miss / verify-fail — fresh publish:**
   - `scrubCachedMoveLocks(sourcePath)` strips `[pinned.<env>.*]` / `[env.<env>.*]` from
     `~/.move/git/**/Move.lock` (`services/package/internal.ts:308-318`).
   - `setPhase('building move')`.
   - `buildMove({path, rpcUrl: sui.rpc.host, faucetUrl})` shells out to `sui move build`
     (in-container exec / fresh container / host CLI fallback; see sui doc), returning
     `{modules, dependencies}` (`services/package/internal.ts:327-341`).
   - `setPhase('publishing')`.
   - `t.publish({modules, dependencies})` produces the UpgradeCap;
     `t.transferObjects([upgradeCap], signer.address)` transfers it to the publisher
     (`services/package/internal.ts:344-346`).
   - `signer.signAndExecute(t)` submits the tx (`services/package/internal.ts:348-358`).
   - `setPhase('capturing')`. Pick `'published'` change for `packageId`
     (`services/package/internal.ts:361-372`).
   - **Fullnode ready-probe:** `sui.client.core.getObject({objectId: packageId})` is polled at 200ms
     intervals with a 10s ceiling (`services/package/internal.ts:381-409`). Blocks until the indexer
     ingests the publish checkpoint — otherwise downstream `tx` builders fail with "Dependent
     package not found on-chain".
   - Pick `UpgradeCap` from `objectChanges` (`services/package/internal.ts:411-413`).
   - Run `options.capture(objectChanges)` if present (`services/package/internal.ts:415`).
   - `discoverCoinsFromPublish(objectChanges, signer.address)` walks for TreasuryCap + CoinMetadata
     pairs (`services/package/internal.ts:418-422`).
   - `fetchCoinMetadataMany(sui.client, allCoinTypes)` — one batch RPC populates
     symbol/decimals/iconUrl for every discovered coin (`services/package/internal.ts:425-429`).
   - Fold into `pkg.coins` keyed by `md?.symbol ?? witnessName`
     (`services/package/internal.ts:431-475`).
   - Build the final `Package<TCaptured>` value, persist into `StateStore`
     (`engine/cache.ts:154-156`).
7. **Register step — runs on EVERY cycle (hit AND miss):**
   - Mutate `sourcePath` + `mvrPlaceholder` onto the resolved value
     (`services/package/internal.ts:626-628`).
   - `publishPackage({name, packageId, upgradeCapId, mvrPlaceholder, captured})` writes the
     PackageRegistry record (`services/package/internal.ts:630-636`).
   - For each coin:
     `publishCoin({name, type, decimals, sdkCoin, symbol?, displayName?, iconUrl?, treasuryCapId?, metadataId?, packageId?})`
     writes the CoinRegistry record (`services/package/internal.ts:637-650`).
   - `registerMintStrategies(signer, Object.values(pkg.coins))` — for each coin with a
     `treasuryCapId` AND `publisherOwnsCap !== false`, registers a `treasuryCapMintStrategy` against
     the in-scope `FaucetTag` if present (`services/package/internal.ts:256-280,651`).
8. **Return the resolved value** to downstream `yield*`-ers.

### Startup (`KnownPackage`, per-package)

1. **Eagerly accumulate seedObjects.** On factory invocation (before the supervisor starts), every
   `KnownPackage` declaration with `seedObjects` pushes ids into the module-level
   `accumulatedSeedObjects` Set (`services/known-package.ts:86-88`). Same-id duplicates are absorbed
   by Set semantics.
2. **Layer build:** the LayeredTag's build body runs in scope:
   `publishPackage({name, packageId, upgradeCapId?, mvrPlaceholder?})` writes the PackageRegistry
   record (`services/known-package.ts:102-107`).
3. **Return shape:** `{name, packageId, upgradeCapId}` (the minimal `Package` contract — no
   `sourcePath`, no `coins`, no `captured`).

### Ready criteria

The substrate marks the LayeredTag `ready` when the build body completes — i.e., for `publishMove`,
after the register step (so the PackageRegistry + CoinRegistry + Faucet strategies are populated by
the time anyone downstream sees the value). For `KnownPackage`, ready = the registry write has
landed.

The fullnode ready-probe inside `produceFreshPackage` (`services/package/internal.ts:381-409`)
ensures the chain itself considers the package queryable before declaring ready; without this,
downstream `tx` primitives consuming `pkg.packageId` would fail.

### Restart behavior

- **Whole-stack hot restart on watched-file edit** — `engine/supervisor.ts:1392-1452` aggregates
  `__watchPaths` into the watch set and triggers a restart cascade. Today this is whole-stack even
  for a single `.move` edit; selective per-primitive tear-down is tracked under the G2a hot-restart
  follow-up (`services/package/internal.ts:531-532`).
- **Cache hit on same chain** — a stack-restart against an unchanged Move source + unchanged
  `signer.address` + unchanged `chainId` reuses the previously published `packageId`. Verified by
  `snapshot.docker.test.ts:223-232` (`'publishMove(connect_four): cache hit'` after restore).
- **Cache miss on regenesis** — `chainId` flips → cache miss → fresh publish → new `packageId`.
  Asserted by `services/package/internal.test.ts:222-232`. Downstream consumers carrying caches
  keyed off `packageId` (e.g. deepbook pools) themselves miss-and-rederive.
- **Cache verify-fail** — a partial state-store wipe or snapshot mismatch returns a cached
  `packageId` whose `getObject` fails; `withCache` evicts and `produceFreshPackage` re-runs. Lenient
  probe — transient RPC failures over-derive, the cheaper failure mode
  (`services/package/internal.ts:584-589`).
- **Hot-restart idempotency** — `publishPackage` / `publishCoin` use last-write-wins semantics
  (deduped by `name` in `gatherManifest` — `runtime/service.ts:274-277`), so re-running the register
  step on every cycle is safe even when the cache hit preserved the same record.

### Teardown

- The package primitive has no acquired resources to release — it's a pure layer-build effect with
  no `Scope.addFinalizer`. The on-chain object lives until the chain is wiped.
- KnownPackage same.
- The accumulated `accumulatedSeedObjects` Set survives the supervisor's life.
  `clearKnownPackageSeedObjects()` is called at the top of each `devstack(...)` compose
  (`services/known-package.ts:69-74`) so two composes in one process (test files) don't leak state.

## Hard requirements / invariants

1. **`hashMoveSources` MUST strip `[pinned.<env>.*]` and `[env.<env>.*]` sections from `Move.lock`
   before hashing.** Otherwise the FIRST warm restart after a cold publish misses the cache
   spuriously — the hash runs BEFORE the build, but the cached value was written AFTER (and the
   build rewrites those sections). Cited at `services/package/internal.ts:63-86` and asserted by
   `services/package/internal.test.ts:102-124`.

2. **`hashMoveSources` MUST exclude `build/` artifacts, hidden directories, and `node_modules`.**
   Hashing these would force a spurious miss on every supervisor cycle. Cited at
   `services/package/internal.ts:51-52` and asserted by `services/package/internal.test.ts:144-171`.

3. **`hashMoveSources` MUST be order-independent.** Files at each directory level are sorted
   (`services/package/internal.ts:50`) so two trees with the same `(relpath, content)` set produce
   the same digest. Asserted by `services/package/internal.test.ts:184-211`.

4. **Cache key MUST fold in `chainId`.** A regenesis (which flips `sui.chainId`) MUST miss the
   cache. Asserted by `services/package/internal.test.ts:222-232` and by the snapshot smoke test at
   `engine/snapshot.docker.test.ts:113-138`.

5. **`signer` MUST be in `upstream` (not implicit).** The topological scheduler reads
   `__upstreamKeys` to order primitives into levels. Without `upstream: { signer }`, both Package
   and the Account would land in level 0 and the resolved-upstream `yield*` would fail with "Service
   not found". Cited at `services/package/internal.ts:556-563`.

6. **Post-publish fullnode ready-probe MUST be polled.** The publish tx digest commits before the
   fullnode/indexer has ingested the checkpoint; downstream `tx` builders consuming `pkg.packageId`
   fail with "Dependent package not found on-chain" if they fire immediately. 200ms cadence, 10s
   ceiling. Cited at `services/package/internal.ts:374-409`.

7. **The `register` step MUST run on every cycle (hit AND miss).** `PackageRegistry` and
   `CoinRegistry` are in-memory per engine invocation; a cache hit MUST still surface the resolved
   package into them so downstream MVR resolution / manifest emission / etc. work. Cited at
   `services/package/internal.ts:611-618` and structurally guaranteed by the
   `OnChainArtifactSpec.register` contract (`engine/on-chain-artifact.ts:156-170`).

8. **The verify probe MUST be lenient.** Transient RPC failures must not fail the boot — they map to
   `undefined` so the produce body re-runs (over-derive on the next cycle). Cited at
   `services/package/internal.ts:584-589` and built into `ChainProbeLive.getObject`
   (`engine/chain-probe.ts:135-149`).

9. **The verify probe MUST consume a STABLE identifier.** Per RS2, the probe consumes
   `cached.packageId` (a value produced by the produce body), not a derived hash. Cited at
   `services/package/internal.ts:589-591`.

10. **`KnownPackage` MUST return a `Package`-shaped (NOT `LocalPackage`-shaped) tag.** Bindings emit
    MUST reject a KnownPackage at compose time because there's no source tree to feed
    `sui move summary`. Cited at `services/known-package.ts:10-13` and asserted indirectly by
    `codegen/emitters/bindings.test.ts:305-319`.

11. **`accumulatedSeedObjects` MUST be populated EAGERLY at factory time (not inside the Layer
    body).** The `Sui()` factory closures over `fork.seed.objects` at composition time;
    KnownPackages declared AFTER `Sui()` in factory order would otherwise miss the fork's seed list.
    Cited at `services/known-package.ts:81-88` and asserted by
    `engine/known-package.fork.test.ts:65-89`.

12. **Two `devstack(...)` composes in one process MUST NOT share `accumulatedSeedObjects` state.**
    `compose/devstack.ts` calls `clearKnownPackageSeedObjects()` at the top of every compose. Cited
    at `services/known-package.ts:69-74` and `engine/known-package.fork.test.ts:115-122`.

13. **Coin-key collision within a single package MUST be handled deterministically.** Discovery
    sorts by `coinType.localeCompare` (`services/coin/discovery.ts:144`), so on collision the second
    entry is logged and dropped — the publisher should fix the duplicate-symbol Move source. Cited
    at `services/package/internal.ts:460-473`.

14. **Coins with `publisherOwnsCap === false` MUST be skipped in `registerMintStrategies`.** Faucet
    auto-mint can't work when the cap is in a DAO / shared owner; the coin is still recorded so
    reads work, but funding via `Account({funding})` would surface a clean "no strategy registered"
    error. Cited at `services/package/internal.ts:266-272`.

15. **The MVR placeholder default MUST sanitize names to `[a-z0-9-]+`.** Dapp-kit's
    `validateOverrides` runtime check rejects underscores. Cited at
    `services/package/internal.ts:489-511`.

16. **The host-wide `~/.move` advisory lock MUST cover the entire build spawn (host, container, and
    exec paths).** Two concurrent `publishMove`s race git's per-repo index locks otherwise. Cited at
    `engine/sui-cli.ts:166-187` (consumed by Package via `buildMove`).

17. **`PublishMoveOptions.path` MAY be an `Effect.Effect<string>`.** This is how Seal's `gitFetch`
    fallback round-trips through `publishMove` instead of duplicating the publish flow. Runtime-
    resolved paths still participate in the `(sourceHash, chainId)` cache key the same way literal
    paths do. Cited at `services/package/internal.ts:201-211, 600-608`.

## Failure modes

`PublishError` (`engine/errors.ts:151-165`) is the load-bearing tagged error. Closed `phase` set
defined at `engine/phases.ts:55-63`:
`'hash' | 'scrub' | 'build' | 'publish-tx' | 'parse' | 'register-coins'`.

Throw sites (all in `services/package/internal.ts`):

| phase              | trigger                                                                                                           | location                                                                  | recovery path                                                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'hash'`           | `fs.readDirectory` / `fs.readFile` / `fs.stat` fail under the source root                                         | `internal.ts:90-99` (in `hashMoveSources.walk.catchTag('PlatformError')`) | Surface to user via pretty-error (the `sourcePath` field is meant to carry the failing tree but isn't populated by the current call — see Pain Points). User must fix permissions / symlink / disk issues.                              |
| `'scrub'`          | `scrubCachedMoveLocks` returns a `SuiCliError` (e.g. readDir of `~/.move/git` fails)                              | `internal.ts:308-318`                                                     | Best-effort: scrubbing failures don't surface in fresh-publish cycle; this branch only fires on a non-`PlatformError` `SuiCliError`. Recovery via `devstack wipe --keep-upstream-cache && devstack apply` if a transient locking issue. |
| `'build'`          | `buildMove` returns a `SuiCliError` — non-zero `sui move build` exit, parse failure, or container/network failure | `internal.ts:331-341`                                                     | Surfaced with cause-chain extraction (`engine.test.ts:184-208` — engine row pulls the deepest cause's message). User fixes the Move source / build env. `cause.stdout`/`cause.stderr` carries the verbatim sui-cli output.              |
| `'publish-tx'`     | `signer.signAndExecute(tx)` fails (`SignAndExecuteError`)                                                         | `internal.ts:348-358`                                                     | Common triggers: insufficient gas, Move VM verification failure (bytecode rejected by the chain), RPC connection failure. User checks signer funding (Account doc), build correctness, RPC liveness.                                    |
| `'parse'`          | No `'published'` change in the result                                                                             | `internal.ts:361-371`                                                     | Shouldn't happen on a successful publish tx — implies SDK shape drift. Bug.                                                                                                                                                             |
| `'parse'`          | `sui.client.core.getObject({objectId: packageId})` fails (initial attempt)                                        | `internal.ts:381-396`                                                     | Retried at 200ms cadence (see next row).                                                                                                                                                                                                |
| `'parse'`          | Fullnode ready-probe timeout (10s)                                                                                | `internal.ts:399-409`                                                     | Publish tx succeeded but the package never became queryable. Implies a stuck indexer / fullnode. User restarts Sui (`devstack restart`) or wipes.                                                                                       |
| `'register-coins'` | Reserved in the phase enum; not currently thrown                                                                  | n/a                                                                       | n/a                                                                                                                                                                                                                                     |

`KnownPackage` has no throw sites — the build body is a single `publishPackage(...)` write. Errors
there would propagate as the underlying registry's defect, not as a `PublishError`.

Other failure modes:

- **Coin metadata fetch failure** — `fetchCoinMetadataMany` flakes; individual entries degrade to
  `{symbol: undefined, decimals: 0}` with a warning logged (`services/package/internal.ts:425-475`).
  The next supervisor cycle picks them up. Non-fatal.
- **Coin key collision** — second occurrence dropped with a warning
  (`services/package/internal.ts:466-473`). Move-source bug.
- **Faucet not in scope** — `registerMintStrategies` is a no-op
  (`services/package/internal.ts:261-262`). Funding via `Account({funding})` for the affected coin
  will surface a clean "no strategy registered" error later.
- **`buildMove` git lock contention** — covered by the `~/.move` advisory lock
  (`engine/sui-cli.ts:166-187`); concurrent publish flows serialize at the lock instead of racing.

## Persistence model

### Survives restart (state-store entries)

- `publishMove/<chainId>/<inputsHash> → {name, packageId, upgradeCapId, captured, coins, sourcePath, mvrPlaceholder}`
  — keyed under `.devstack/stacks/<stack>/state.json` for localnet stacks,
  `.devstack/networks/<network>.json` for live nets (`engine/supervisor.ts:218-224`). One entry per
  (chain, package source-hash, signer) tuple.

### Survives snapshot

- The full state-store entry above. Snapshot's `save` captures `state.json` + the container tars;
  `restore` writes them back and the next `devstack apply` hits the cache
  (`devstack snapshot save/restore` flow, verified by `engine/snapshot.docker.test.ts:140-260`).
- The chain itself (containers under `images/sui/`) preserves the on-chain object identified by
  `packageId`. Verify probe re-confirms on first boot post-restore.

### Wiped on `devstack wipe`

- The state-store directory under `.devstack/stacks/<stack>/state.json` (full wipe drops all
  publishMove cache entries; the chain itself is also wiped via container removal).
- KnownPackage records aren't persisted — they're re-derived from the factory call on every compose.

### Process-local only

- `accumulatedSeedObjects` (`services/known-package.ts:59`) — module- level Set, lives until process
  exit or `clearKnownPackageSeedObjects()`.
- The in-memory `PackageRegistry` / `CoinRegistry` snapshots — wiped per supervisor invocation,
  repopulated by the register step.
- `FaucetTag`'s strategy table — same per-supervisor-cycle lifetime.

## Modes & variants

The Package surface presents three modes implicitly via the choice of factory + the surrounding
network. These map to the `local / live / fork` triplet the user's `Sui()` declaration drives.

| dimension         | local (Package + Sui localnet)                                                                                                                          | live (KnownPackage + Sui live net)                                                                                                       | fork — KnownPackage path (typical)                          | fork — Package path (republish-on-fork)                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| factory           | `Package(name, path, opts)`                                                                                                                             | `KnownPackage(name, opts)`                                                                                                               | `KnownPackage(name, opts)` against the fork's wrapped chain | `Package(name, path, opts)` (when the user's contracts aren't on the upstream chain yet)                                                                                                                                                        |
| container         | none owned by Package; uses Sui's build container (`SuiBuildContainer`) for in-container `sui move build` and the localnet container for the publish tx | none                                                                                                                                     | none (KnownPackage doesn't run a publish)                   | uses Sui's build container against the fork process                                                                                                                                                                                             |
| startup sequence  | acquire signer → hash sources → cache lookup → `scrub` + `build` + `publish-tx` + `parse` + `capture` (on miss) → `register` step (hit or miss)         | factory-time `accumulatedSeedObjects.add(...)` → layer build runs `publishPackage(...)` only                                             | same as live                                                | same as local, but the publish lands against the fork's RPC; the `sui-fork` constraint set determines whether the publish succeeds (some publish-time RPC surfaces may be unsupported — see `ForkUnsupportedError` for the proxy guard pattern) |
| ready criteria    | layer build completes (= register done, fullnode ingested)                                                                                              | layer build completes (= registry write done)                                                                                            | same as live                                                | same as local                                                                                                                                                                                                                                   |
| persistence       | `publishMove/<chainId>/<inputsHash>` entry under stack `state.json`                                                                                     | none (KnownPackage state lives only in the factory args)                                                                                 | none                                                        | `publishMove/<chainId>/<inputsHash>` under the fork stack's `state.json` (chainId distinguishes the fork from the upstream)                                                                                                                     |
| teardown          | no Package-owned resources                                                                                                                              | no Package-owned resources                                                                                                               | same                                                        | same                                                                                                                                                                                                                                            |
| failure modes     | full `PublishError` phase set (`hash` / `scrub` / `build` / `publish-tx` / `parse`); coin-metadata flake → degraded coin record                         | no Package-side failures; downstream `bindings` rejection at compose time when a KnownPackage is passed where a LocalPackage is required | same as live                                                | same as local, plus fork-only failures: `ForkUnsupportedError` if a publish-time RPC surface isn't backed by `sui-fork`; `SeedManifestMismatchError` if the fork's seed list disagrees with `accumulatedSeedObjects` content                    |
| dependencies      | `signer` Account; `Sui()` localnet; optional `FaucetTag`; `StateStore`; `ChainProbe`                                                                    | `signer` not required (omitted from `KnownPackageOptions`); `PackageRegistry`                                                            | same as live                                                | same as local plus the fork's seed-object pre-fetch from `accumulatedSeedObjects`                                                                                                                                                               |
| hard requirements | requirements 1–16 above                                                                                                                                 | requirements 10–12 above (the registry-write side); requirements 11–12 specifically about seed-object accumulation                       | same as live                                                | requirements 1–16 above PLUS fork constraints (see 05-sui.md)                                                                                                                                                                                   |

A given `devstack.config.ts` typically mixes these — e.g. `examples/private-content` has both
`Package('vault', VAULT_DIR, {signer: publisher})` (local) and a KnownPackage for Seal's testnet
key-server reference (live, against the resolved deployment). The `devstack-full` example threads
KnownPackage on fork mode through `resolveDeploymentNetwork` (`engine/known-deployments.ts:36-65`)
to map `mainnet-fork`/`testnet-fork`/`devnet-fork` to their upstream `KnownNetwork` keys for the
deployment lookup.

Some KnownPackages (Walrus' system object, Deepbook's registry/pools) need `seedObjects: [...]` so
the fork pre-fetches them on first boot — without this the fork's per-read GraphQL dial-out would
either error or silently degrade to `ObjectNotFound` (`services/known-package.ts:31-41`). On
non-fork stacks (live, local) this field is ignored.

## Test coverage

### `src/services/package/internal.test.ts` (233 LOC)

`describe('hashMoveSources')` — block at line 37, all 12 child `it`s:

- `'produces a stable 16-char hex digest for unchanged sources'` (53) — calling
  `hashMoveSources(root)` twice on the same tree returns the same value, matching
  `/^[0-9a-f]{16}$/`.
- `'two identical trees in different dirs produce the same digest'` (62) — relative-path encoding
  cancels out the root; same `(relpath, content)` set ⇒ same digest.
- `'editing a .move file changes the digest'` (72).
- `'editing Move.toml changes the digest'` (81).
- `'editing Move.lock changes the digest (dep pin awareness)'` (90) — proves dep-bump invalidation
  (Move.lock changes when a vendored dep's pin changes).
- `'Move.lock [pinned.<env>.*] / [env.<env>.*] sections do not affect the digest'` (102) — the
  load-bearing invariant that prevents warm-restart cache flapping. Asserts hard requirement 1.
- `'adding a new .move file changes the digest'` (126).
- `'removing a .move file changes the digest'` (135).
- `'build/ artifacts are excluded (no digest change)'` (144) — asserts hard requirement 2 part 1.
- `'hidden dirs are excluded (no digest change)'` (154) — asserts hard requirement 2 part 2.
- `'node_modules is excluded (no digest change)'` (164) — asserts hard requirement 2 part 3.
- `'non-Move files (e.g. README.md, .ts) do not affect the digest'` (173).
- `'digest is order-independent (sibling rename keeps digest stable if content unchanged)'` (184) —
  asserts hard requirement 3.

`describe('publishMove cacheKey shape (chainId fold)')` — block at line 222:

- `'encodes chainId so distinct chains never share a cache slot'` (223) — pin on the
  `publishMove/<chainId>/<inputsHash>` layout + the namespace-is-bare-`'publishMove'` contract. The
  test constructs the strings by hand (not by calling withCache); the intent is to lock the on-disk
  shape so a future refactor that changes the layout has to change this assertion too.

### `src/engine/known-package.fork.test.ts` (125 LOC)

`describe('Phase 3 P3.T1 — KnownPackage + fork-aware deployment lookup')` at line 22 (afterEach
clears the accumulator):

`describe('resolveDeploymentNetwork')` at line 28:

- `'maps fork variants to their upstream KnownNetwork keys'` (29) — `mainnet-fork → 'mainnet'`,
  `testnet-fork → 'testnet'`, `devnet-fork → 'devnet'`.
- `'passes live nets through unchanged'` (35).
- `'returns undefined for localnet (no canonical deployment)'` (40).
- `'drives known-deployment lookups: mainnet-fork resolves to the real walrus deployment'` (44) —
  composes `resolveDeploymentNetwork` with `knownDeployments.walrus[key]` and asserts
  `systemObjectId` matches `/^0x[0-9a-f]{64}$/`.
- `'drives known-deployment lookups: testnet-fork resolves to testnet deepbook'` (56) — same
  composition against `knownDeployments.deepbook`.

`describe('KnownPackage seedObjects accumulator (P3.7)')` at line 65:

- `'records seedObjects so the Sui fork builder picks them up at acquire time'` (66) — calls
  `KnownPackage('walrus', {packageId, seedObjects: [...]})`, then asserts
  `collectKnownPackageSeedObjects()` returns both ids. Asserts hard requirement 11.
- `'deduplicates seedObjects across multiple KnownPackage declarations'` (90) — two `KnownPackage`
  calls with overlapping seed ids → Set semantics collapse them.
- `'is a no-op when seedObjects is omitted'` (108) — KnownPackage with no `seedObjects` doesn't push
  anything.
- `'clearKnownPackageSeedObjects resets the accumulator'` (115) — asserts hard requirement 12.

### Indirect coverage from other docs' tests

(These tests are owned by other components but cover Package surface from the consumer side; listed
here so future readers don't lose the connection.)

- `src/engine/snapshot.docker.test.ts:113-260` — end-to-end Docker test that apply → snapshot → wipe
  → restore → apply preserves `packageId` for `Package('connect_four', ...)` from the
  `examples/arena` config. Smoking gun: the `'publishMove(connect_four): cache hit'` log line in
  `apply2.stdout` (line 231) — if absent, the chainId flipped and the publish re-ran.

- `src/engine/engine.test.ts:184-208` — `PublishError` cause-chain extraction. Constructs a
  `SuiCliError` ↑ `PublishError` chain, asserts the engine row's `error` summary is the innermost
  message (`"unexpected argument '--json' found"`) not the wrapper preamble
  (`'publishMove(demo): build failed'`).

- `src/engine/registries.test.ts:49-56` — `publishPackage` writes through the `PackageRegistry` Live
  layer; pin on the `defineRegistry`-derived publish + snapshot contract.

- `src/engine/state-store-keys.test.ts:13-21` — pins the
  `StateStoreKeys.publishMove({packageName, sourceHash, chainId}) = 'publishMove/<name>/<hash>/<chainId>'`
  shape. This builder is unused in production; see Opportunities noticed.

- `src/engine/errors.test.ts:79-148` — `PublishError` conforms to the phase-field rule (closed
  `Schema.Literals(PublishPhases)`).

- `src/codegen/emitters/bindings.test.ts:305-355` — KnownPackage entries (no `sourcePath`) are
  skipped by `BindingsEmitter`; pin on hard requirement 10.

- `src/services/codegen.test.ts:20-43` — type-discipline pin on
  `Codegen({packages: [localTag, knownTag]})`.

- `src/services/seal/internal.ts:878` — Seal's body yields `PackageRegistry` as a "happens-after"
  marker (no value used). This is the dep-order coupling between Seal's key-server registration and
  the package being already in the registry.

## Pain points today

1. **Two cache-key schemes coexist.** `engine/state-store-keys.ts:24-28` declares
   `StateStoreKeys.publishMove({packageName, sourceHash, chainId})` producing
   `publishMove/<packageName>/<sourceHash>/<chainId>`, but the production path uses
   `onChainArtifact` + `withCache` which produces `publishMove/<chainId>/<inputsHash>` (the
   `packageName` lives in the cached value, not the key). The `StateStoreKeys.publishMove` builder
   has zero non-test callers (verified by grep). The `state-store-keys.test.ts:13-21` assertion is
   therefore guarding a contract no one consumes.

2. **`sourcePath` is double-stored.** It's persisted into the cached value (`internal.ts:483`) AND
   mutated onto the resolved value in the `register` step (`internal.ts:626-628`). The mutation
   exists because the cached value from a previous boot captures the path-at-publish-time; if the
   user moves the directory between boots, the cache hit returns a stale path. The register step
   refreshes it. This works but is awkward — the value-field-vs-host-local-field split is implicit.

3. **`hashMoveSources`' `PublishError` doesn't carry `sourcePath`.** The throw site at
   `internal.ts:90-99` constructs `new PublishError({phase: 'hash', message: ...})` but doesn't
   populate the `sourcePath` field that `errors.ts:151-165` declared specifically for build/scrub
   failures. Pretty-error renders less information than it could.

4. **`PublishPhases` includes `'register-coins'` but nothing throws it.** The phase enum at
   `engine/phases.ts:55-63` carries a `'register-coins'` value, but no `register` step in
   `internal.ts:619-652` throws a `PublishError` with this phase. Dead enum entry (or a TODO that
   landed without its throw site).

5. **`registerMintStrategies` re-runs on every cache hit.** `internal.ts:619-652` is the register
   step, which runs on every cycle. Re-registering the same `treasuryCapMintStrategy` per cycle is
   harmless (Faucet's registry is in-memory per cycle and would be empty anyway), but the work is
   wasted on the hot path when nothing changed.

6. **`registerMintStrategies` swallows the missing-Faucet case.** `internal.ts:261-262` returns
   silently when no Faucet is in scope. The comment says this is "best-effort: only unit tests that
   build the publish layer without `devstack(...)`", but in practice this also fires when a user
   composes a stack without a Faucet — funding via `Account({funding: {<coinType>: amount}})` for a
   coin minted by such a Package will surface a "no strategy registered" error from the Account
   side, which is debuggable but doesn't trace back to the missing Faucet.

7. **`accumulatedSeedObjects` is a module-level mutable global.** The contract
   (`services/known-package.ts:55-58`) acknowledges this: "Lives at module scope (not in a registry)
   because the consumer is the _factory_ layer of `Sui()` — registries are only available inside
   Effect contexts during acquire." The factory- composition-time information flow forces the
   global; this fights the rest of the codebase's "everything is an Effect" architecture. It also
   requires the user to declare KnownPackages BEFORE `Sui()` in their config (otherwise the fork has
   already digested its seed list).

8. **`KnownPackage` doesn't auto-discover coins.** A `KnownPackage` for a coin-bearing remote
   contract (e.g. testnet USDC) doesn't surface coins in `pkg.coins` — there's no publish receipt to
   discover from. The user must declare coins separately. This is asymmetric with `Package(...)`'s
   "no `coins:` field" UX promise.

9. **The `LocalPackage` / `Package` interface split is mirrored three times.** Once as TS interfaces
   (`services/package.ts:38-42,67-71`), once as Schema mirrors (`services/package.ts:82-99`), and
   once structurally inside `Package<TCaptured>` in `internal.ts:162-170` with a compile-time guard
   (`_LocalPackageCompatibilityCheck`). The guard exists to keep these in sync, but the manual
   mirroring is fragile.

10. **`Coin` interface lives in `services/package.ts:120-133` (not `services/coin.ts`).** The
    comment at lines 18-22 justifies this (every coin originates from a published Package's coin
    registry), but it creates an out-of-place feel — anyone looking for the `Coin` TS interface
    naturally checks the `coin.ts` file first.

11. **`buildMove` failure path doesn't pass `sourcePath` to `PublishError`.** Same as pain point 3
    but for the `'build'` phase — `internal.ts:332-340` constructs a PublishError without the
    `sourcePath` field.

12. **Whole-stack hot-restart on Move source edit.** A `.move` edit triggers a full supervisor
    restart (`internal.ts:530-532`, `supervisor.ts:1450-1452`), tracked as the G2a follow-up.
    Selective per-primitive tear-down would let `publishMove` re-run without restarting Sui / Wallet
    / Codegen.

13. **`PackageWithCapture` lives on `/advanced` but its declarative `capture:` form is the common
    case for non-coin captures.** The split between `Package(...)` (no capture, coin-only) and
    `PackageWithCapture(...)` (with capture, on `/advanced`) forces users to import from a different
    barrel for what is structurally a small option. The user-facing factory could accept an optional
    `capture:` field directly. Cited at `services/package.ts:275-282`.

14. **`internal.ts` is 654 LOC.** Mixes the produce body, the coin discovery + metadata fold, the
    mint-strategy registration, the MVR slugifier, the cache-key derivation, and the
    `_LocalPackageCompatibilityCheck` ceremony. Could be split.

## Open questions

1. **Is `StateStoreKeys.publishMove` truly dead?** Grep shows zero non-test callers, but the test at
   `state-store-keys.test.ts:13-21` exists and the `engine/snapshot.docker.test.ts:127-138` filter
   on `key.startsWith('publishMove/')` is consistent with both schemes. **OPEN QUESTION: was
   `StateStoreKeys.publishMove` left behind by an incomplete refactor, or is there a planned future
   use?**

2. **What is the contract for `PackageWithCapture`'s `capture` running on cache-hit?** The
   produce-body branch (`internal.ts:415`) runs `options.capture(result.objectChanges)` only on
   miss; the cached value carries the captured record. But the register step (`internal.ts:619-652`)
   only mutates `sourcePath` + `mvrPlaceholder`, not `captured`. **OPEN QUESTION: if the user
   changes the `capture` function's body between boots (without changing source/signer), the cache
   hit would still return the OLD captured record. Is this intentional?** The cache key doesn't fold
   in the capture function identity.

3. **What's the relationship between the `Codegen({packages: [...]})` per-package `emitters`
   override and the package-level `codegen.emitters` option?** The factory accepts
   `codegen?: boolean | { emitters?: ReadonlyArray<unknown> }` (`services/package.ts:172`) but only
   the boolean `false` case reaches `__codegenExclude`. **OPEN QUESTION: where is the per-package
   emitter override actually consumed? Is it currently dead?**

4. **What's the policy for `'devnet'` as a `KnownNetwork`?** The type accepts `'devnet'`
   (`known-deployments.ts:34`) but `knownDeployments.deepbook`/`walrus`/`seal` all omit `devnet`
   entries (comment at line 389 says "no canonical deepbook-v3 deployment"). The only reachable use
   is via `resolveDeploymentNetwork('devnet-fork')` → `knownDeployments[<service>]['devnet']` =
   `undefined`. **OPEN QUESTION: is `devnet` in the type as future-proofing, or for an actual
   deployment the registry will be updated to include?**

5. **Does the verify probe handle the case where `cached.packageId` is on a DIFFERENT chain than
   `sui.chainId`?** The cache key already folds chainId, so a different chain ⇒ different cache slot
   ⇒ different cached value. But if someone externally tampers with `state.json` and writes a
   `publishMove/<chainId>/<inputsHash> → {packageId: <id-from-other-chain>}` entry, the verify
   probe's `chain.getObject(packageId)` would return undefined and the produce body would re-run.
   **OPEN QUESTION: is this an attack surface worth documenting, or is external state.json tampering
   considered out-of-scope?**

6. **`hashMoveSources`' max-recursion behavior?** The walk recurses without depth limit
   (`internal.ts:48-99`). **OPEN QUESTION: deeply nested or symlinked Move trees — what's the
   failure mode?** Symlinks aren't mentioned anywhere; the `stat.type === 'Directory'` branch would
   follow them blindly (potentially infinite loop on a symlink cycle).

7. **Why is `CoinTag` declared in `services/package.ts:135` instead of in `services/coin.ts`?** The
   comment explains it's because "every coin originates from a published Package's coin registry",
   but `Coin('SYMBOL')` (in `coin.ts`) is the user-facing factory and `coin.ts` imports
   `Coin as CoinShape` from `package.ts:38`. **OPEN QUESTION: is this just historical layering, or
   load-bearing for some import-cycle reason?**

8. **What's the contract when `publishMove` is invoked without a composed `Sui()`?** The substrate
   yields `SuiTag` and `ChainProbe` (`on-chain-artifact.ts:243-244`); these are provided by
   `Sui()`'s `__layers`. Without `Sui()` in the stack, `Layer.build` would fail with "Service not
   found". **OPEN QUESTION: is there a meaningful "test-only / no-Sui" path that wraps a fake
   SuiTag + ChainProbe layer?** The unit tests in `internal.test.ts` exercise `hashMoveSources`
   directly (which doesn't need either) but no test exercises the full `publishMove` body without a
   real chain.

9. **`KnownPackage` and `publishPackage`'s `captured` field.** The `PackageRecord` schema accepts
   `captured?: Record<string, unknown>` but `KnownPackage` doesn't accept a `captured` option — it
   couldn't, because there's no publish receipt. **OPEN QUESTION: should `KnownPackageOptions`
   accept a literal `captured` record the user spells out (mirroring how they spell out
   `packageId`)?** Useful for known DAOs / known registries where the user knows the cap/registry
   ids; today they'd have to pass them through `extras:` or a separate KnownPackage per id.

## Opportunities noticed

1. **Delete `StateStoreKeys.publishMove`.** It has zero non-test callers, and its key shape
   disagrees with the actual on-disk shape used by `onChainArtifact` + `withCache`. Removing the
   builder + its test removes a footgun for future readers who'd otherwise grep and assume the older
   shape is canonical.

2. **Remove the `'register-coins'` entry from `PublishPhases`.** Nothing throws it.

3. **Inline `compileCapture` into `PackageWithCapture`.** It's a 12-line helper used only in one
   place (`services/package.ts:237-248,290`); inlining would localize the Record-vs-callback
   discrimination.

4. **Consolidate `Coin` declarations.** `Coin` interface and `CoinTag` Context.Service tag live in
   `services/package.ts:120-135` but the user-facing `Coin('SYMBOL')` factory lives in
   `services/coin.ts:376`. The split is justified by the comment but creates discoverability
   friction — re-exporting `Coin` / `CoinTag` from `services/coin.ts` and treating the package.ts
   declarations as internal would be more conventional.

5. **Move `accumulatedSeedObjects` into a Context.Reference.** The module-level mutable global is a
   known wart (`services/known-package.ts:55-58`). A `Context.Reference<{seedObjects: Set<string>}>`
   with a default empty Set, set into scope by `defineDevstack(...)` and read by `Sui()`'s factory
   body, would remove the compose-order-dependency at the cost of slightly more wiring. This is
   essentially what the substrate already does for other factory-time shared state.

6. **Inline the `_LocalPackageCompatibilityCheck` compile-time guard into a TS `satisfies` clause.**
   The `const _check: ... = true; void _check;` pattern at `internal.ts:178-181` is hand-rolled; a
   `satisfies LocalPackage` on the `Package<TCaptured>` return shape (where appropriate) would
   express the same intent more idiomatically.

7. **Hoist `pkg.coins` to a separate per-package `CoinRegistry`-shaped projection.** Today coins are
   recorded in two places: as `pkg.coins[<key>]: PublishedCoin` on the resolved value AND as
   individual `CoinRecord` entries in `CoinRegistry`. The former is the per-package handle; the
   latter is the stack-wide one. A single source of truth (e.g. always going through the registry,
   with `pkg.coins` being a registry slice-by-package-name view) would remove the double-bookkeeping
   in `internal.ts:431-475` and `internal.ts:637-650`.

8. **Lift coin discovery out of `internal.ts`.** Lines 431–475 are coin-keyed bookkeeping that
   doesn't belong in a "publish a Move package" module. The pure projection already lives in
   `services/coin/discovery.ts`; the fold + metadata enrich step could move there as
   `enrichDiscoveredCoins(discovered, metadata)`.

9. **Fix the `'hash'` / `'build'` / `'scrub'` throw sites to populate `sourcePath`.** The error
   class already declared the field for this purpose (`errors.ts:160-162`); the constructor calls at
   `internal.ts:92-97, 311-317, 334-340, 351-357, 366-370, 392-396, 401-408` should pass it through.

10. **Stop running the in-`register` step `registerMintStrategies` on cache-hit.** Splitting the
    register step into "always-runs" (PackageRegistry / CoinRegistry — cheap dict writes) and
    "runs-once-after-fresh-publish" (Faucet mint strategy registration — wasted work on hit) would
    keep the hot path cheap.

11. **Merge `Package(...)` and `PackageWithCapture(...)`.** The second factory only adds a
    `capture:` field; the first could accept it as an optional. The split between root barrel and
    `/advanced` is the only thing keeping them separate today (`services/package.ts:267-298`).

12. **Document or remove `devnet` from `KnownNetwork`.** The type accepts it but no
    `knownDeployments[<service>]['devnet']` entries exist
    (`engine/known-deployments.ts:34, 389, 420, 439`).

13. **Add a `KnownPackage`-level smoke test that asserts the PackageRegistry write lands.** Today
    `known-package.fork.test.ts` covers the seed-object accumulator + the `resolveDeploymentNetwork`
    mapping but does NOT exercise the layer-build body — the `publishPackage(...)` call at
    `known-package.ts:102-107` is only covered indirectly via `registries.test.ts:49-56` (which uses
    the bare `publishPackage` function, not a real `KnownPackage(...)` factory).

14. **Lift `mvrSlugify` into a shared util.** It's a small, test-worthy function (MVR conventions
    are project-wide), but today it's private to `internal.ts:502-511` with no direct tests. If
    `KnownPackage` ever grows a similar default-slugify branch for its MVR placeholder, the logic
    would be duplicated.

15. **Define `LocalPackage` once.** The structural mirror in `internal.ts:162-170`
    (`Package<TCaptured>`) plus the explicit `LocalPackage` interface in `services/package.ts:67-71`
    plus the `LocalPackageSchema` in `services/package.ts:92-99` is triple bookkeeping for the same
    shape.

16. **Document that `Sui()` MUST be composed before any `Package(...)` works.** The substrate yields
    `SuiTag` / `ChainProbe` implicitly; without `Sui()` in the stack, the layer build fails with
    "Service not found". Mentioned in passing in `on-chain-artifact.ts:243-244` but not surfaced as
    a user-facing requirement.
