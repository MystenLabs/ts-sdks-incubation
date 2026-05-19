# Integration contract redesign

**Status:** Design proposal, read-only audit. **Author:** integration-contract-redesign subagent,
2026-05-19. **Scope:** every primitive under `packages/devstack/src/services/**` plus the two
long-lived container plugins
(`packages/devstack/src/advanced/plugin-author/docker-{container,one-shot}.ts`).

## 1. Motivation

The recent E2E + lifecycle audit produced roughly twelve bugs that look, once you line them up, like
one bug repeated N times. Almost every primitive that publishes something on-chain and then
registers it re-implements the same flow by hand:

1. compute a hash of the inputs;
2. look in `StateStore`;
3. probe chain to verify the cache;
4. on miss/fail, produce the artifact;
5. write to registries;
6. declare upstream tags so the topological scheduler places it correctly.

The bug shapes that fell out of this duplication, all encountered in the last week:

| #   | Bug                                                                                                                                                                                                                                                                                                                                                          | Root cause                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `deepbookLocalDeploy` verify probe read `.objectType` off the SDK response root; the real shape is `.object.type`. Cache verify never returned true on resume, every restart re-fired `create_pool_admin`, which `register_pool`-aborted because (base,quote) was already registered.                                                                        | Each primitive hand-rolls the SDK accessor; mocks in unit tests don't match runtime shape. (`services/deepbook/local-deploy.ts:362-401`)                   |
| B2  | `pythLocalDeploy` only accepted a literal `movePackagePath: string`, no `vendor: LayeredTag<...>` variant — symmetric to `deepbookLocalDeploy`, which has both. (Task #46 currently in-flight.)                                                                                                                                                              | Each primitive hand-rolls Move-source resolution; cross-pollination of the `Effect.Effect<string>` form on `publishMove.options.path` hasn't happened.     |
| B3  | `walletApp` example crashed on second `apply` because `deepbookMarketMaker` re-minted BalanceManager objects when its in-memory cache had survived but chain had been wiped. Pre-fix had no `withCache`; bolted-on inline verify still passes a raw `client.core.getObject` result. (`services/deepbook/market-maker.ts:175-209`)                            | Each primitive's verify probe is hand-coded instead of going through a typed `ChainProbe.getObject(id) -> {type, owner, version, ...}`.                    |
| B4  | `vendorDeepbook` PACKAGE_PATHS sandbox bug — vendor inner tag's sibling resolution wasn't registered in `__upstreamKeys`, so the topo scheduler placed the consumer ahead of the vendor's inner `gitFetch`.                                                                                                                                                  | `__upstreamKeys` is manually maintained on every composite, including conditional siblings. Easy to miss inner tags.                                       |
| B5  | `deepbookMargin.captured` reached `.objectType` on the SDK response (one of many sites) but actually a different (unrelated) site read `.object.type`; gRPC long-form `objectType` vs hand-authored short-form `objectType` matchers gave silent false-negatives until `moveTypeStartsWith`/`Equals` was introduced. (`services/deepbook/margin.ts:473-490`) | Hand-rolled `startsWith` against `objectType` ignored address-form-agnosticism.                                                                            |
| B6  | `sui-build-container` race — `inspect → start → rm → run` was non-atomic. Two concurrent apply cycles or vitest workers hit a TOCTOU on `docker rm` ("No such container" vs "container is restarting").                                                                                                                                                      | Each long-running container primitive hand-rolls its own race-aware container-up logic.                                                                    |
| B7  | Margin-seed cache hit returned a `SupplierCap` that was missing on chain because the verify probe only checked existence, not type.                                                                                                                                                                                                                          | Verify probes have to compare a typed accessor's `objectType` against a canonical Move type; today each site re-derives the type and the comparison logic. |
| B8  | `seal` keygen + register caches were two `withCache` calls that needed to invalidate together. The intra-primitive eviction cascade is hand-coded (`services/seal/internal.ts:435-451`) and isn't a reusable shape.                                                                                                                                          | The contract today doesn't express "this cache depends on that cache."                                                                                     |
| B9  | `walrus` deploy cache verify probe needs to check both `systemObject` AND `stakingObject`. The double-probe is hand-coded in walrus only; deepbook has its own loop in `verifyCached`.                                                                                                                                                                       | Multi-object verify probes are hand-rolled per primitive.                                                                                                  |
| B10 | `wal-exchange` swap cache verify reads `client.core.listCoins` and sums balances. The defensive "is `listCoins` even on the client?" guard at `services/walrus/internal.ts:843-847` is a verify probe that doesn't use the typed accessor it would be best served by.                                                                                        | No typed `ChainProbe.balance(...)` accessor.                                                                                                               |
| B11 | Several upstream-key declarations missed transitively-yielded inner tags (account/publisher omitted, coin/fromPackage missed in deepbook market-maker pool spec base+quote, pyth feeds, margin asset coin tags). All caused "Service not found" at runtime.                                                                                                  | `__upstreamKeys` is manual; no compile-time hint that `yield* X` requires `X` in `upstreamKeys`.                                                           |
| B12 | `seal-internal` and `walrus-internal` both use `docker network create` + `docker run --network` flows independently. Each invents its own per-stack subnet derivation, container naming, and adoption probe.                                                                                                                                                 | No shared "ensure container, race-safe, scope-bound, attached to per-stack network" primitive.                                                             |

The PGR plan landed `withCache(spec)`, `wrapDocker`, `makeService`, `composeLayers`,
`moveTypeStartsWith/Equals`, and `pickCreatedByType`. Adoption is partial: only `publishMove`
(`services/package/internal.ts`), `walrus.deploy/register/seed-wal` (`services/walrus/internal.ts`),
and `seal.keygen/keyServerId` (`services/seal/internal.ts`) flow through `withCache`. Every other
on-chain primitive (`deepbookLocalDeploy`, `deepbookMargin`, `deepbookMarginSeed`,
`deepbookMarketMaker`, `pythLocalDeploy`, `mintFromTreasury`, `Action`) still has its own bespoke
cache + verify dance.

The pattern is clear and the win is large.

## 2. Current state

### 2.1 The shared pattern (everywhere)

Every "publish-something-on-chain-then-register-it" primitive follows the same eight-step shape:

(a) resolve `SuiTag`/`signer`/`StateStore`; (b) yield inner sibling tags (publish, vendor,
gitFetch); (c) hash inputs; (d) `state.get → verifyCached → state.remove or hydrate`; (e) build/send
tx on miss; (f) `pickCreatedByType` for each output; (g) `state.put`; (h) publish to in-process
registries (PackageRegistry / CoinRegistry / DeepbookStateRegistry / EndpointRegistry). The tag
carries an `upstreamKeys: [SuiTag.key, options.signer, ...inner siblings, ...dependsOn]` array.

Repeated verbatim in: `deepbookLocalDeploy` (`local-deploy.ts:248-629`), `deepbookMargin`
(`margin.ts:352-933`), `deepbookMarginSeed` (`margin-seed.ts:100-326`), `pythLocalDeploy`
(`local-deploy.ts:125-355`), `mintFromTreasury` (`coin.ts:460-612`). Per site: ~80 lines of cache +
verify boilerplate plus ~60 lines of upstreamKeys that must be hand-maintained.

### 2.2 What `publishMove` does _right_

`services/package/internal.ts:482-663` is the only primitive that wraps its produce body in
`withCache(spec)`. Its discipline:

- `inputs: Effect.succeed({ sourceHash, signer: signer.address })` — canonical, hashable, fed into
  the cache key.
- `verify: (pkg) => probe(pkg.packageId)` — typed accessor, returns the cached value on success or
  `undefined` to invalidate.
- `produce: produceFreshPackage(...)` — the fresh-publish body.
- A `registerAll(pkg)` step run on every cycle regardless of cache outcome — registers the package +
  every published coin + every faucet mint strategy.

The reason this is the model: the verify probe is the ONLY chain probe that runs per cycle; the
`registerAll` call is the ONLY code that touches in-process registries; the cache key derivation is
canonical. Any future change (e.g. switching the cache backend) is a `withCache` edit.

The remaining 5 primitives haven't adopted this — they have hand-rolled equivalents that drifted in
subtle ways. B1 (deepbook objectType) and B7 (seal SupplierCap) are both consequences of that drift.

### 2.3 Container plumbing & SDK shape access

`walrus.acquireLocalCluster`, `sealLocalKeygen`, and `engine/sui-build-container.ts` each hand-roll:
per-stack docker network derivation (`walrus-${name}-net` vs. `<app>-<stack>-seal-image`),
adopt-if-running vs. `rm -f` race, traefik labels, ready-probe vs. `docker wait`. `dockerContainer`
covers the single-leaf case but multi-container composites (walrus N storage nodes, deepbook
indexer+server) still hand-roll. Bug B6 (sui-build-container TOCTOU race) lives only in
`engine/sui-build-container.ts`.

Every verify probe casts the raw SDK response differently:

```ts
// deepbookMargin (margin.ts:473-490):
... as unknown as Promise<{objectType?: string}>
// deepbookLocalDeploy (local-deploy.ts:380-401):
res as unknown as { object?: { type?: unknown } }
// pythLocalDeploy (local-deploy.ts:170-175):
(res as unknown as { objectType?: unknown }).objectType
```

Three sites, three shapes. A typed `ChainProbe.getObject(id)` returning `{type, owner, version}`
validated through `Schema` collapses the entire class.

### 2.4 `__upstreamKeys` is manual

Composite primitives maintain
`upstreamKeys: [SuiTag.key, signer, ...siblings, ...specs.flatMap(...) ]` arrays. Conditional
siblings, coin tags inside pool specs, Pyth feed tags inside margin asset configs are easy to miss;
no compile-time check. A runtime tracer that wraps `Effect.gen` body's `yield*` calls and diffs
against the declared list turns B11-shaped bugs into deterministic test failures on first acquire.

## 3. Proposed contract

### 3.1 Core shape: `onChainArtifact`

A single helper subsuming every "publish, cache, verify, register" primitive. Strawman
(`packages/devstack/src/advanced/on-chain-artifact.ts`):

```ts
export interface OnChainArtifactSpec<Name, T, EV, RV, EP, RP, ER, RR> {
  // Tag identity & TUI
  readonly name: Name;
  readonly kind: TagKind;
  readonly plugin: string;
  readonly displayTitle?: string;
  readonly display?: (shape: T) => TuiDisplay;

  // Cache discipline (folded into key alongside Sui.chainId).
  readonly namespace: string;

  // Dep declaration: substrate flattens into `__upstreamKeys` AND uses
  // for typed dep edges. Conditional siblings may be `undefined`.
  readonly upstream: ReadonlyArray<LayeredTag<any, any, any, any> | undefined>;

  // Canonical hashable inputs (Effect form lets callers yield runtime
  // values — sibling publish's packageId, signer.address). Stringified
  // with `jsonBigintReplacer` before contentHash.
  readonly inputs: Effect.Effect<Record<string, unknown>, never, never>;

  // Verify probe. Receives `ChainProbe` instead of raw SDK client; returns
  // cached on success or `undefined` to invalidate. Errors → undefined
  // (don't fail boot on transient RPC).
  readonly verify: (cached: T, chain: ChainProbe) => Effect.Effect<T | undefined, EV, RV>;

  // Fresh produce on miss / verify-fail.
  readonly produce: Effect.Effect<T, EP, RP>;

  // Runs every cycle (HIT AND MISS) after the value is resolved, before
  // it yields to consumers. Used for PackageRegistry / CoinRegistry /
  // DeepbookStateRegistry / EndpointRegistry / faucet strategies — the
  // load-bearing "register-on-cache-hit-too" semantics today's
  // `publishMove.registerAll` already implements.
  readonly register: (value: T) => Effect.Effect<void, ER, RR>;
}

export const onChainArtifact: <...>(spec: OnChainArtifactSpec<...>) =>
  LayeredTag<Name, T, any, EV | EP | ER>;
```

### 3.2 `ChainProbe` service

```ts
// File: packages/devstack/src/engine/chain-probe.ts
import { Context, Effect } from 'effect';
import { Schema } from 'effect';

/** Validated subset of `client.core.getObject(...)`'s response. */
export interface ObjectInfo {
	readonly objectId: string;
	/** Long-form objectType — already canonicalised. Use
	 *  `moveTypeEquals` / `moveTypeStartsWith` for matching. */
	readonly type: string;
	readonly owner: { readonly address?: string; readonly shared?: boolean };
	readonly version: bigint;
}

export class ChainProbe extends Context.Service<
	ChainProbe,
	{
		/** Fetch a typed object record. Returns `undefined` for any RPC
		 *  failure or missing object. Never throws. */
		readonly getObject: (objectId: string) => Effect.Effect<ObjectInfo | undefined>;

		/** Sum coin balance for `(owner, coinType)`. Returns 0n on any RPC
		 *  failure. */
		readonly balance: (args: {
			readonly owner: string;
			readonly coinType: string;
		}) => Effect.Effect<bigint>;

		/** Convenience: probe a list of object ids; resolves to true iff
		 *  every id resolves with a type matching its expected canonical form.
		 *  Used by multi-object verify probes (walrus deploy, deepbook pools,
		 *  margin pools). */
		readonly objectsMatchTypes: (
			expectations: ReadonlyArray<{ readonly objectId: string; readonly expectedType: string }>,
		) => Effect.Effect<boolean>;
	}
>()('@devstack/ChainProbe') {}
```

`ChainProbe` is wired against `Sui.client` in `InfraLive`. Tests get a mock `ChainProbeLive` that
implements the same contract — the SDK response shape is parsed/validated through a `Schema` once,
so neither the production nor the test implementation can produce a `{type: undefined}` shape that
masks bug B1.

### 3.3 `containerPrimitive` — race-safe long-running container

```ts
// File: packages/devstack/src/advanced/plugin-author/container-primitive.ts
import type { LayeredTag } from '../tag.js';
import type { DockerContainerImageInternal } from './docker-container.ts';

export interface ContainerPrimitiveSpec<Name extends string, Handle> {
	readonly name: Name;
	readonly plugin: string;

	/** Image source. Same shape as `dockerContainer({image})`. */
	readonly image: DockerContainerImageInternal;

	/** Per-stack network. Substrate derives the canonical name from
	 *  identity + a `purpose` discriminator so two stacks of the same
	 *  app land on disjoint networks (subsumes the hand-rolled
	 *  `walrus-${name}-net` / `<app>-<stack>-seal-image` patterns). */
	readonly network?: { readonly purpose: string; readonly subnet?: 'auto' | string };

	/** Caller-provided run options (env, mounts, ports, traefik routing,
	 *  ready probe). */
	readonly run: import('./docker-container.ts').DockerContainerOptions;

	/** Optional: how to compute Handle from the resolved
	 *  `DockerContainerHandle` (URL, ports, container id). */
	readonly handle?: (raw: import('./docker-container.ts').DockerContainerHandle) => Handle;

	/** What to do when the engine's per-primitive scope releases
	 *  (selective restart, watch-fire, full teardown). Substrate guarantees
	 *  the `docker stop` + name-collision sweep + ready-probe race; this
	 *  hook is for extra cleanup (e.g. removing per-stack docker volumes
	 *  the caller created). */
	readonly onRelease?: Effect.Effect<void>;

	readonly upstream: ReadonlyArray<LayeredTag<any, any, any, any> | undefined>;
}

export const containerPrimitive: <Name extends string, Handle = DockerContainerHandle>(
	spec: ContainerPrimitiveSpec<Name, Handle>,
) => LayeredTag<Name, Handle, any, DockerError | ReadyProbeError>;
```

Race-safety is in the substrate: `ensureContainer(name, expectedImage)` serialises through a
per-name `Synchronized.Ref` so two concurrent `apply` cycles don't both hit the `inspect → rm → run`
window. Bug B6 disappears here.

### 3.4 Auto-derived `upstreamKeys` via a build-body tracer

The substrate intercepts the Effect.gen body's `yield* X` calls when `X.[DevstackTagBrand]` is true,
records the keys, and on first acquire diffs against the declared `upstream` list. Undeclared
upstream tags trigger a `logError` plus a `__missingUpstreamKeys: [...]` field on the tag. The
supervisor's startup check fails the boot if any tag has non-empty `__missingUpstreamKeys`.

This isn't a compile-time check, but it does turn B11-shaped bugs into deterministic test failures
the first time a primitive runs. Cost: ~30 lines of tracer in `tag.ts` (`yield*` wrap is already in
`withEngineLifecycle`).

A stricter compile-time approach via TypeScript template literals is possible — see §8.1 — but isn't
required for the bug-fix win.

### 3.5 Multi-cache eviction cascades

`OnChainArtifactSpec.verify` returns `T | undefined`. For primitives that need cross-cache
invalidation (seal keygen + register), `verify` can read other state-store entries — but the
substrate also offers an opt-in helper:

```ts
verify: (cached, chain) => Effect.gen(function* () {
  // Piggy-back on a sibling primitive's cache: if its key is missing
  // or invalid, my cache must also drop.
  const sibling = yield* chain.lookupArtifact('seal/key-server-id', { chainId: sui.chainId });
  if (sibling === undefined) return undefined;
  ...
});
```

This formalises the seal eviction cascade (B8) without changing the primitive's surface.

## 4. Worked examples

### 4.1 `publishMove` after migration

Before (today): 663 lines, with ~120 lines of cache-key derivation + verify probe + registerAll.
After:

```ts
export const publishMove = <Name, TCaptured>(options: PublishMoveOptions<Name, TCaptured>) =>
  onChainArtifact({
    name: options.name,
    kind: 'action',
    plugin: 'move',
    displayTitle: `publish.${options.name}`,
    display: (s) => ({ title: `publish.${s.name}`, primary: s.packageId, ... }),
    namespace: 'publishMove',
    upstream: [SuiTag, options.signer],
    inputs: Effect.gen(function* () {
      const sourcePath = typeof options.path === 'string' ? options.path : yield* options.path;
      const signer = yield* options.signer;
      return { sourceHash: yield* hashMoveSources(sourcePath), signer: signer.address };
    }),
    verify: (pkg, chain) =>
      chain.getObject(pkg.packageId).pipe(Effect.map((o) => (o !== undefined ? pkg : undefined))),
    produce: produceFreshPackage(options),
    register: (pkg) => Effect.gen(function* () {
      yield* publishPackage({...});
      for (const coin of Object.values(pkg.coins)) yield* publishCoin({...});
      yield* registerMintStrategies(signer, Object.values(pkg.coins));
    }),
  });
```

LoC: 663 → ~340 (the `produceFreshPackage` body, the `hashMoveSources` helper, and the coin/cap
discovery are still load-bearing; the boilerplate around them collapses).

### 4.2 `deepbookLocalDeploy` after migration

```ts
export const deepbookLocalDeploy = <TPools, Name>(options) => {
  const publish = options.movePackagePath !== undefined
    ? publishMove({ name: `${name}.publish`, path: options.movePackagePath, signer: options.signer, capture: deepbookCapture })
    : undefined;

  return onChainArtifact({
    name: options.name ?? 'deepbook',
    kind: 'action',
    plugin: 'deepbook',
    namespace: 'deepbook/pools',
    upstream: [SuiTag, options.signer, publish, ...resolvedCoinTags, ...(options.dependsOn ?? [])],
    inputs: Effect.gen(function* () {
      const pkg = yield* publish!;
      const resolvedSpecs = yield* resolvePoolSpecs(options.pools ?? []);
      return { packageId: pkg.packageId, pools: canonicalSpecs(resolvedSpecs) };
    }),
    verify: (cached, chain) => chain.objectsMatchTypes(
      cached.pools.map((p) => ({
        objectId: p.poolId,
        expectedType: `${cached.packageId}::pool::Pool<${p.base}, ${p.quote}>`,
      })),
    ).pipe(Effect.map((ok) => (ok ? cached : undefined))),
    produce: createPoolsBody({ publish, options }),
    register: (out) => Effect.gen(function* () {
      yield* publishPackage({...});
      yield* publishDeepbookState({...});
    }),
  });
};
```

The bespoke `verifyCached` loop, `state.get/remove/put` calls, the hand-rolled `objectType.endsWith`
matching, and the `upstreamKeys: [ SuiTag.key, options.signer, ..., ...specs.flatMap(...) ]`
re-derivation all collapse.

LoC: 783 → ~360.

### 4.3 `walrus.deploy` (acquireLocalCluster phase 2)

`acquireLocalCluster` is genuinely complex (image build → network create → deploy one-shot →
committee register → storage nodes → exchange discovery → proxy URL → seed accounts). But the
_deploy_ phase, the _register_ phase, and the _seed-wal_ phase are each `onChainArtifact`- shaped.

Today: 3 hand-rolled `withCache` blocks adding up to ~150 lines
(`services/walrus/internal.ts:340-468, 708-744, 760-821`). After migration: each block ~20 lines,
total ~60. The orchestration logic in between stays as-is — `containerPrimitive` covers the
storage-node case below.

### 4.4 `seal.keygen + register`

```ts
const keypair = onChainArtifact({
  name: `${name}.keypair`,
  hidden: true,
  namespace: 'seal/bls-keypair',
  upstream: [SuiTag, sealImage],
  inputs: Effect.succeed({ name }),
  verify: (cached, chain) => Effect.gen(function* () {
    const ksId = yield* chain.lookupArtifact('seal/key-server-id', { chainId, name });
    if (ksId === undefined) return cached; // never registered yet
    return (yield* chain.getObject(ksId)) !== undefined ? cached : undefined;
  }),
  produce: runSealKeygenContainer({...}),
  register: () => Effect.void,
});

const keyServer = onChainArtifact({
  name: `${name}.keyServer`,
  namespace: 'seal/key-server-id',
  upstream: [SuiTag, options.signer, keypair, publish],
  inputs: Effect.gen(function* () {
    const kp = yield* keypair;
    return { publicKey: kp.publicKey, name };
  }),
  verify: (id, chain) => chain.getObject(id).pipe(Effect.map((o) => (o !== undefined ? id : undefined))),
  produce: registerKeyServerTx({...}),
  register: (id) => publishSealState({name, objectId: id}),
});
```

The keygen → key-server eviction cascade is encoded in `verify`'s call to `chain.lookupArtifact`.
The container lifecycle stays as a separate `containerPrimitive` call below.

### 4.5 Walrus storage nodes via `containerPrimitive`

```ts
const startStorageNode = (i: number) =>
	containerPrimitive({
		name: `walrus-${args.name}-node-${i}`,
		plugin: 'walrus',
		image: { tag: image }, // image was already built
		network: { purpose: `walrus-${args.name}`, subnet: 'auto' },
		run: {
			/* env, mounts, ip, ports, traefik, ready */
		},
		upstream: [deploySpec],
	});
```

The `Docker.removeContainerByName` race-fix from `services/walrus/internal.ts:429-439` is no longer
needed — the substrate's `ensureContainer` serialises through a per-name lock. Bugs B6 + B12 both
disappear.

## 5. LoC delta estimate

| Primitive                                                       | Today     | After     | Δ          | Bug-class wins                                                                             |
| --------------------------------------------------------------- | --------- | --------- | ---------- | ------------------------------------------------------------------------------------------ |
| `services/package/internal.ts` (`publishMove`)                  | 663       | ~340      | −323       | reference impl; migration validates the contract                                           |
| `services/deepbook/local-deploy.ts` (`deepbookLocalDeploy`)     | 783       | ~360      | −423       | B1, B5, B7, B11                                                                            |
| `services/deepbook/margin.ts` (`deepbookMargin`)                | 944       | ~450      | −494       | B5, B7, B11                                                                                |
| `services/deepbook/margin-seed.ts`                              | 329       | ~140      | −189       | B7, B11                                                                                    |
| `services/deepbook/market-maker.ts` (BalanceManager cache)      | 490       | ~270      | −220       | B3, B11                                                                                    |
| `services/pyth/local-deploy.ts` (`pythLocalDeploy`)             | 368       | ~170      | −198       | B2, B11                                                                                    |
| `services/pyth/pusher.ts` (`PythPusher` — minor verify)         | 334       | ~290      | −44        | small                                                                                      |
| `services/coin.ts` (`mintFromTreasury`)                         | 615       | ~510      | −105       | B11                                                                                        |
| `services/walrus/internal.ts` (deploy/register/seed-wal blocks) | 953       | ~720      | −233       | B6, B9, B10, B12                                                                           |
| `services/seal/internal.ts` (keygen/register blocks)            | 1243      | ~880      | −363       | B6, B8, B11, B12                                                                           |
| `engine/sui-build-container.ts`                                 | 662       | ~430      | −232       | B6                                                                                         |
| `services/walrus/local-cluster.ts` (cluster orchestrator)       | 352       | ~310      | −42        | small (network derivation collapse)                                                        |
| `services/action.ts` (`Action`)                                 | 207       | ~150      | −57        | B11 (signer + needs auto-derive)                                                           |
| `services/dev/internal.ts` (hostProcess — partial overlap)      | 396       | ~396      | 0          | no on-chain artifact pattern                                                               |
| `services/wallet/internal.ts` (walletApp)                       | 719       | ~719      | 0          | container plumbing covered separately                                                      |
| `services/faucet/index.ts`                                      | 265       | ~265      | 0          | strategy registry shape stays                                                              |
| **Cost: new substrate files**                                   | 0         | +480      | +480       | onChainArtifact (180) + ChainProbe (150) + containerPrimitive (120) + upstream tracer (30) |
| **Total**                                                       | **9 562** | **6 100** | **−2 942** |                                                                                            |

About **−3 000 LoC net** across the in-scope files, before counting the test-file collapse (each
primitive's `verifyCached` mock would no longer need to exist — those total another ~400 LoC across
the test files). The cost: ~480 LoC of new substrate. Net ~−2 500 LoC.

These numbers are conservative — they don't include the dependent-code reduction in
`services/sui.ts` (sui-build-container ties in there too) or the eventual collapse of
`services/dev/internal.ts` if `containerPrimitive` is extended to cover host processes.

## 6. Bug-class elimination

The three highest-impact eliminations:

1. **SDK shape divergence (B1, B5, B7, B9, B10)** — every `verify` probe reads SDK responses through
   the typed `ChainProbe` accessor. The accessor's `Schema`-validated shape can't return
   `{type: undefined}` in production while tests pass; the bugs that `deepbookLocalDeploy` and
   `deepbookMargin` hit (verify always returning false) become structurally impossible.

2. **Missing `__upstreamKeys` declarations (B4, B11)** — the runtime tracer that compares declared
   `upstream` against actually-yielded tags converts every B11-shaped bug into a deterministic test
   failure on first acquire. The composite-with-conditional-vendor case (B4) collapses because the
   `upstream: [..., publish, ...]` form treats `undefined` entries as drops, matching today's
   `[...(publish !== undefined ? [publish] : [])]` boilerplate but without the chance of forgetting
   an entry.

3. **Container TOCTOU races (B6, B12)** — `containerPrimitive`'s per-name `Synchronized.Ref` makes
   `ensureContainer(name, expectedImage)` atomic. Two concurrent apply cycles (or vitest workers)
   serialise through one critical section; the sui-build- container `rm/run` race that the
   integrate-devstack branch already touched stops being a race at all.

Other lower-incidence bug classes the contract closes (with no extra work beyond the migration
itself):

- **Verify-probe parsing inconsistency (B2)** — `produce` accepts a literal-or-Effect `path` shape
  uniformly. `pythLocalDeploy` gains the vendor branch for free because the substrate's `inputs`
  body and the publish call both go through `publishMove`'s shape.
- **Multi-cache eviction cascades (B8)** — the seal keygen → keyServer cascade encodes naturally in
  the new `verify` body's `chain.lookupArtifact` call. No bolt-on `stateStore.remove(other_key)`
  side effect inside a verify hidden behind `Effect.gen`.

### 6.x Restart-survival lessons (2026-05-19 audit)

Three warm-restart bugs landed as edge fixes in commit `aa3d510c`. Each maps to a design discipline
the substrate MUST encode so the bug class is structurally absent in migrated primitives.

**RS1 — `inputs` callbacks must canonicalise build-output mutations.** `hashMoveSources` byte-hashed
`Move.lock`, but `sui move build` mutates the `[pinned.<env>.*]` blocks on every build. Result: pre-
build hash ≠ post-build hash → every warm restart was a cache miss even though chain state was
preserved.

Substrate fix: the `inputs: ({ deps }) => Effect<Record<string,   unknown>>` contract treats inputs
as **source-authored content only**. Build-output, generation-timestamps, and any byte the primitive
itself writes back into the source tree MUST be canonicalised away before the `Record` is returned.
Document this in the `onChainArtifact` JSDoc + lint candidate: refuse `inputs` bodies that reference
a `Move.lock`-style file without an explicit `strip*` helper.

**RS2 — `verify` should probe via stable identifiers, not derived shapes.** `walrus/seed-wal`
synthesised a coin-type string (`${walrusPackageId}::wal::WAL`) and asked for the holder's balance.
The synthesised type was wrong (the wal coin lives in a separate package whose id was never
captured) → verify always returned 0 → verify-fail every restart.

Substrate fix: `ChainProbe`'s recommended verify call is `chain.getTransaction(digest)` or
`chain.getObject(objectId)` — both consume stable identifiers the produce body already returned. Add
a cautionary § in the `ChainProbe` JSDoc: probes that synthesise identifiers from package ids +
module names + type tags are an anti-pattern. Prefer "did the side effect's receipt still resolve"
over "does the derived shape match what we expected".

**RS3 — orphan/sweep helpers must read exit codes.** `docker network rm` returned exit-1 (in-use)
but the sweep counted every attempt as success via `Effect.map(() => true)`. The user saw "swept 2
orphan(s)" every cycle even on cold start.

Substrate fix: ship a shared `runOk(spawner, cmd): Effect<boolean,   never>` helper that maps
exit-code correctly. The `containerPrimitive` doesn't have this issue today (it uses
`decideRunAction` which inspects exit codes), but the sweep lives outside `containerPrimitive`.
Either lift orphan sweeping into the containerPrimitive scope's finalizer pass OR centralise the
spawn-and-check pattern via `runOk` so future call sites can't re-create the bug.

**Bonus**: each of these three was reachable on every restart of a working stack — silent footguns
the substrate must prevent at the contract level, not just patch at the call site.

## 7. Migration phases

### Phase A — substrate (no migrations) — ~3 days, low risk

- `engine/chain-probe.ts` — `ChainProbe` service + `ChainProbeLive` against `Sui.client`.
  Schema-validate response shapes. Unit tests against both gRPC long-form and JSON-RPC short-form
  objectType.
- `advanced/on-chain-artifact.ts` — `onChainArtifact(spec)` helper + tests. Internally calls
  `withCache` so we don't fork the cache code path.
- `advanced/plugin-author/container-primitive.ts` — `containerPrimitive(spec)` + `ensureContainer`
  lock. Tests cover the TOCTOU race fix.
- `tag.ts` — upstream-key tracer (~30 lines). Gated behind `process.env.DEVSTACK_STRICT_UPSTREAM=1`
  initially.

Deliverable: new helpers exist; no existing primitive uses them; all existing tests pass.

### Phase B — canonical migration: `publishMove` — ~2 days, medium risk

Pick `publishMove` as the canonical migration. It's the most-used primitive, every other on-chain
primitive depends on it transitively, and the current `withCache` adoption gives us a clean
before/after to diff against. Update internal tests to assert the substrate observably calls
`register` on both cache-hit and cache-miss paths.

Deliverable: `services/package/internal.ts` is ~340 LoC; the `internal.test.ts` and
`package.test.ts` suites still pass; the example apps in `examples/*` boot unchanged.

### Phase C — fan-out — ~4-6 days, low risk per primitive

In parallel (fanned-out subagent work, per user-mandated preference):

- `deepbookLocalDeploy` + `deepbookMargin` + `deepbookMarginSeed`
- `deepbookMarketMaker` (BalanceManager cache only — tick body stays)
- `pythLocalDeploy` + `PythPusher` (minor)
- `mintFromTreasury`
- `walrus.deploy + register + seed-wal` (three blocks of `acquireLocalCluster`)
- `seal.keygen + register + rotate` blocks
- `walrus` storage nodes → `containerPrimitive`
- `seal` key-server → `containerPrimitive`
- `sui-build-container` → `containerPrimitive`

Each migration is a `git diff`-able single-primitive change. Per-PR checklist: bug-class win is
verified against the audit table; example apps still boot.

### Phase D — strict upstream-key check + dead code removal — ~1-2 days, low risk

- Flip `DEVSTACK_STRICT_UPSTREAM=1` to the default. The supervisor's startup invariant fails on
  undeclared upstreams.
- Remove now-unused exports: `STATE_KEY_*_PREFIX_INTERNAL` constants (used today by tests that
  locked the on-disk shape — replace with assertions against `buildCacheKey`).
- Retire `dockerOneShot` if no plugin-author callers materialised by the scheduled 2026-11-19 sunset
  (sub-task in scope only if the timeline aligns).
- Update `notes/api-simplification.md` and `notes/parallel-graph- resolution.md` to point at this
  doc.

Deliverable: docs sync, dead code gone.

## 8. Open questions

### 8.1 Compile-time upstream-key check

A purely-runtime tracer (Phase A + D) catches B11 in the first test run but doesn't show up in
TypeScript errors. A stricter compile-time check would require either:

- Threading the upstream type list through `LayeredTag<Name, A, R, E, Upstreams>` so the body's R
  channel can be intersected against `Upstreams` — feasible but adds a type parameter everywhere;
  high friction.
- A custom TS transformer / Effect compiler plugin to introspect `yield*` calls — out of scope per
  hard constraint.

Recommendation: runtime check for now; revisit a typed-upstream encoding in a follow-up if the
runtime check misses bugs in practice.

### 8.2 `register` ordering with multi-tag composites

`deepbookLocalDeploy` provides three interface tags (`DeepbookCoreTag` + `DeepbookAdminTag` +
`DeepbookMarketMakerTag`). The current shape uses a composite tag + three projection layers; each
projection's `Effect.gen` re-yields the composite. `register` runs on the composite's resolve path,
which is exactly once per cycle — but the projection layers may run BEFORE `register`, leading to a
transient window where consumers see the composite but registries aren't yet populated.

In practice today this is fine (registries are read async). If we want to tighten it: the
`onChainArtifact` substrate could gate the resolved value on `register` completing — adds one extra
`Effect.tap` per primitive, no contract change.

### 8.3 `containerPrimitive` for multi-container composites

The walrus N-storage-node case + the deepbook indexer+server case both spawn multiple containers
from one composite. The strawman supports the single-container shape; multi-container composites
would either call `containerPrimitive` N times (and surface them as `__extraMembers` from the outer
composite) or get a `containerCluster` higher-level shape. The seal + walrus migrations will
exercise this; I lean toward the former (composition is cleaner than a new top-level helper).

### 8.4 `ChainProbe` and fork mode

Today `ChainProbe.getObject` would resolve through `sui.client`. The fork variants (`sui-fork`) have
known gaps in the gRPC surface (`getBalance` is `todo!()`'d upstream). `ChainProbe.balance` would
need to mirror the `listCoins`-sum fallback that `services/walrus/internal.ts` already implements
(`probeWalBalance` at 833-872). Plan: encode the fallback inside `ChainProbeLive` so primitives
never see it.

### 8.5 Cache shape migration

**Obsoleted by the 2026-05-19 versioning-shim sweep.** Devstack is unreleased; the previous
version-bump bookkeeping (`publishMove/v2`, `walrus/deploy-output/v3`, etc.) is gone, the
`keyOverride` escape hatch is gone from `withCache` / `onChainArtifact`, and the canonical cache key
shape is fixed at `<namespace>/<chainId>/<inputsHash>`. New primitives just declare a bare namespace
string (`'publishMove'`, `'deepbook/pools'`, `'seal/bls-keypair'`) — no vN segments anywhere.

Migration to `onChainArtifact` therefore inherits zero legacy state- store entries; first warm
restart after rollout re-derives every cache and persists under the canonical shape. Operators are
expected to `rm -rf .devstack/` post-merge or accept the one-cycle re-build.

### 8.6 Should `Action` migrate?

`services/action.ts:85-207` already has its own `cacheKey` + `probeCachedTx` shape. It's user-facing
— example configs `Action({...})` directly. Migrating it to `onChainArtifact` underneath would
preserve the user surface AND collapse the duplication. Worth doing in Phase C.

---

End of plan. The reference primitive (`publishMove`) is the prior art; the substrate generalises one
verified pattern across N call-sites that have each re-derived it slightly wrong. The migration is
fan-out-shaped and the bug-class wins are mechanical.
