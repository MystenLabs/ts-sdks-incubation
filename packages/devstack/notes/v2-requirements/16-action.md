# action

## Purpose

`Action(name, opts)` is the one-shot transaction primitive in devstack. It declares a Sui
programmable-transaction to run once after its declared upstream refs (typically a signer `Account`
and one or more published `Package` refs) are ready, then surfaces the resulting `TxResult` (digest,
effects, object changes, balance changes) as a yieldable `LayeredTag`. The user-facing shape is
positional (`Action('name', { signer, needs, build })`); under the hood it runs through the
`onChainArtifact(...)` substrate so it shares cache/verify/register discipline with `publishMove`,
`deepbookLocalDeploy`, `walrus deploy`, and every other on-chain primitive — meaning the same
`Action(...)` does NOT re-fire across hot-restarts or `docker stop`/`docker commit` cycles, but DOES
re-fire after `devstack stack down --force`, `wipe`, or a regenesis (which flips `sui.chainId`).
Used for setup/seed/one-off operations the user wants ordered in the dep graph: minting initial
supply to test addresses, creating singleton on-chain objects (lobbies, configs), publishing
fixtures.

## Current implementation

File-by-file:

- `services/action.ts` (193 LOC, src) — defines `ActionOptions<Name, R, E>` and the
  `Action<Name, R, E>(name, opts)` factory. Internally builds a record of `upstream` LayeredTags
  (typed `signer` alias plus synthetic positional `need0`/`need1`/… aliases for `opts.needs`),
  normalizes `opts.cacheKey` (string → `Effect.succeed(string)` | already-Effect | undefined →
  undefined), then delegates to `onChainArtifact({...})` with `kind: 'action'`, `plugin: 'action'`,
  `namespace: 'action'`, `displayTitle: 'tx.<name>'`, a TxResult `display` projection, an `inputs`
  callback that hashes `(name, signer.address, needs[].key, userKey?)`, a `verify` callback that
  probes `ChainProbe.getTransaction(digest)`, and a `produce` callback that constructs a fresh
  `Transaction`, applies `opts.gasBudget` (if set), runs `opts.build(transaction)`, then
  `signer.signAndExecute(t)`, wrapping any signing failure in
  `PublishError({ phase: 'publish-tx', ... })`. No `register` callback (no in-process registry to
  populate).
- `services/action.test.ts` (452 LOC, test) — unit tests covering cache miss (build+sign on first
  acquire, persist TxResult), cache hit (second acquire skips build+sign), cache invalidation via
  `verify`-undefined eviction, different `cacheKey` values producing different cache keys, different
  `chainId` producing different cache keys, and `cacheKey: Effect<string>` form (Effect-style
  derivation runs at acquire time).
- `services/action.fork.docker.test.ts` (22 LOC, test) — fork-mode docker gate, currently a
  placeholder (`expect(SHOULD_RUN).toBe(true)`) behind `RUN_FORK_DOCKER_TESTS=1` env gate. Documents
  intended coverage (Action runs on fork stack; verify probe uses
  `client.core.getObject(...)`/`getTransaction`, not the forbidden `getBalance` surface; second run
  cache-hits). The actual round-trip is "pending docker wiring".

Totals: src LOC = 193, test LOC = 452 + 22 = 474. Implementation is heavily delegated to
`engine/on-chain-artifact.ts` (the substrate), `engine/cache.ts` (`withCache`),
`engine/chain-probe.ts` (verify probe), `advanced/tag.ts` (lifecycle + engine wiring),
`engine/state-store.ts` (cache persistence). The action service itself is mostly a spec-shaped
wrapper that maps the positional `(name, opts)` surface onto the substrate's
`(namespace, upstream, inputs, verify, produce, register)` shape.

## Configuration

`Action(name, opts)` knobs — all consumed at construction time, none read from env vars or CLI
flags:

| Key                       | Type                                                             | Default    | Read at file:line                       | Notes                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------- | ---------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name` (positional arg 1) | `string` (literal-generic `Name`)                                | — required | `services/action.ts:75-76`              | Tag identity key. Folded into both the cache `inputs` hash and the `displayTitle` (`tx.<name>`) and the `PublishError.message` if signing fails.                                                                                                                                                                                                                                  |
| `opts.signer`             | `LayeredTag<any, Account, any, any>`                             | — required | `services/action.ts:24, 100-102`        | Yielded once at acquire time via the substrate's `upstream` resolution; `signer.address` is folded into the cache key, `signer.signAndExecute(...)` runs the built transaction.                                                                                                                                                                                                   |
| `opts.needs`              | `ReadonlyArray<LayeredTag<any, any, any, any>>`                  | `[]`       | `services/action.ts:28, 91-95`          | Refs this action depends on. Each entry is yielded once at acquire time (ordering), and its `tag.key` is folded into the cache `inputs` (so changing the set of deps invalidates the cache). Synthesized record aliases are `need0`, `need1`, … (positional; not exposed to user).                                                                                                |
| `opts.gasBudget`          | `bigint`                                                         | undefined  | `services/action.ts:30, 172-174`        | If set, applied via `t.setGasBudget(gasBudget)` on the freshly-constructed `Transaction` BEFORE `opts.build(t)` runs. NOT hashed into the cache key (see "Hard requirements / invariants").                                                                                                                                                                                       |
| `opts.build`              | `(t: Transaction) => Effect.Effect<void, E, R>`                  | — required | `services/action.ts:34, 175`            | User callback. Receives a fresh `Transaction` builder. Return Effect's `E`/`R` channels propagate (typically `E = PublishError` from a yielded `Package` ref). NOT hashed into the cache key (it's an arbitrary closure).                                                                                                                                                         |
| `opts.cacheKey`           | `Effect.Effect<string, unknown, unknown> \| string \| undefined` | undefined  | `services/action.ts:47, 79-84, 138-141` | Per-action discriminator folded into the cache `inputs`. String literal is wrapped via `Effect.succeed(...)`. Effect form is yielded at acquire time (runs every acquire, even on hit — see test `services/action.test.ts:418-451`). When undefined, no `userKey` field appears in inputs — distinction across instances comes solely from `(name, signer.address, needs[].key)`. |
| `opts._name`              | `Name` (phantom)                                                 | —          | `services/action.ts:50`                 | Reserved for explicit `Name` parameterization. Not read at runtime.                                                                                                                                                                                                                                                                                                               |

No CLI flags, env vars, or `defineDevstack` top-level keys directly affect action behavior. The
action's behavior is fully derivable from its `opts` plus the resolved upstream `signer.address` +
`Sui.chainId`. Note that environment that indirectly affects action: `wipe` / `stack down --force` /
regenesis events invalidate the `StateStore` cache that action depends on (causing re-fire);
`RUN_FORK_DOCKER_TESTS=1` gates the fork-mode test file
(`services/action.fork.docker.test.ts:12-14`).

## Capabilities CONSUMED

### Other devstack primitives / refs

- **Account** ref via `opts.signer` — `services/action.ts:24, 100-102, 136, 144, 177`. Yielded as a
  typed upstream so the substrate flattens its identity into `__upstreamKeys`, then
  `signer.signAndExecute(t)` is invoked. The `signer.address` field is read for the cache key.
- **Arbitrary user refs** via `opts.needs` — `services/action.ts:28, 91-95, 100-102`. Each entry is
  yielded once for ordering and contributes its `tag.key` to the cache `inputs`. Common case:
  `Package` refs whose `packageId` the action references in `t.moveCall(...)` targets.

### Engine substrate / on-chain primitives

- **`onChainArtifact(spec)`** — `engine/on-chain-artifact.ts` via `services/action.ts:19, 104-192`.
  Action is one of the primitives migrated onto the unified `publish-cache-verify-register` shape
  (`services/action.ts:1-13`). The substrate provides: typed `upstream` resolution, `withCache`
  discipline, `ChainProbe` verify scope, the `register` slot (omitted here), the `tag()` wrapping
  (so the result is a yieldable `LayeredTag`), automatic `__upstreamKeys` flattening for the dep
  graph.
- **`withCache(spec)`** — `engine/cache.ts:109-157` via `onChainArtifact`. State-store IO,
  content-hash key derivation, verify-fail eviction, span annotations (`cache.outcome` ∈
  `'hit' | 'miss' | 'verify-fail'`), log lines (`<label>: cache hit | miss | verify-fail`).
- **`ChainProbe.getTransaction(digest)`** — `engine/chain-probe.ts:181-191` via
  `services/action.ts:159-162`. The verify probe used to check the cached `TxResult.digest` still
  resolves on chain. Lenient (returns `undefined` for any RPC failure / missing transaction). The
  `engine/on-chain-artifact.ts:228-256` substrate yields `ChainProbe` itself; action declares no
  dependency.
- **`SuiTag`** — `services/sui.ts` via `engine/on-chain-artifact.ts:243`. Yielded by the substrate
  to read `sui.chainId`, which becomes the middle slot of the cache key
  (`action/<chainId>/<inputsHash>`). Action declares no direct dependency.
- **`StateStore`** — `engine/state-store.ts` via `engine/cache.ts:121` (inside `withCache`).
  Get/put/remove ops for the persisted `TxResult`. Action declares no direct dependency.

### Engine lifecycle / observability

- **`tag(name, build, options)`** — `advanced/tag.ts:519-575` via `onChainArtifact`. Wraps the
  produce Effect with `withEngineLifecycle`, which observes:
  - `engine.markAcquiring(name, kind: 'action')` — `advanced/tag.ts:346`.
  - `engine.markReady(name, display(value))` — `advanced/tag.ts:367-370`. `display` projects
    `TxResult` to `{ title: 'tx.<name>', primary: 'digest <digest>', extras?: ['<N> objects'] }` —
    `services/action.ts:109-119`.
  - `engine.markFailed(name, cause)` + `engine.appendLog(...)` — `advanced/tag.ts:371-378`.
  - `engine.setEntryTitle(name, 'tx.<name>')` (the pre-acquire `displayTitle`) —
    `advanced/tag.ts:351-353` driven by `services/action.ts:108`.
  - `engine.registerPrimitiveScope(name, scope)` — `advanced/tag.ts:345`. Captures the per-primitive
    layer scope so `engine.invalidateSubset` can tear down JUST this action's resources on a
    selective restart (though action has no long-lived resources to tear down).
- **`setPhase(phase)`** — `advanced/tag.ts:73-80` via `services/action.ts:17, 170, 176`. The action
  body narrates two sub-phases:
  - `'building'` — emitted before `t.setGasBudget` / `opts.build(t)` — `services/action.ts:170`.
  - `'executing'` — emitted before `signer.signAndExecute(t)` — `services/action.ts:176`. Both are
    noops outside an engine-wrapped context (e.g. unit tests; see `advanced/tag.ts:74-79`).
- **`Identity` / `annotateDevstackContext`** — `advanced/tag.ts:322-328`. The engine lifecycle wrap
  stamps `service.name = 'action'` (from `plugin: 'action'`), `devstack.stack`, `devstack.app`
  annotations onto the ambient OpenTelemetry span.
- **`CurrentTagKey`** reference — `advanced/tag.ts:51-53`. Pinned to the action's tag key so nested
  `setPhase` calls land on the right engine entry.

### TUI / dashboard

- The action shows in the TUI **actions** section because `kind: 'action'` is stamped on the
  LayeredTag via `engine/on-chain-artifact.ts:283` and rendered by `tui/components.tsx:484-490`
  (`SECTION_ORDER: ['service', 'package', 'account', 'action', 'app']`).
- Status word collapses to `'done'` (not `'ready'`) for action rows once status is `'ready'` —
  `tui/components.tsx:232-235`
  (`if (entry.status === 'ready' && entry.kind !== 'service') return 'done';`).
- During teardown shutdown count, action rows are NOT counted as pending — only `kind === 'service'`
  and `kind === 'package'` rows count — `tui/components.tsx:875-876`.

### Effect / Layer machinery

- `Effect.gen`, `Effect.sync`, `Effect.succeed`, `Effect.mapError` from `effect` —
  `services/action.ts:15`.
- `Transaction` from `@mysten/sui/transactions` — `services/action.ts:16`. The construct passed to
  `opts.build`.
- `setPhase`, `LayeredTag` from `../advanced/tag.js` — `services/action.ts:17`.
- `PublishError` from `../engine/errors.js` — `services/action.ts:18`.
- `onChainArtifact` from `../engine/on-chain-artifact.js` — `services/action.ts:19`.
- `Account`, `TxResult` types from `../engine/shared.js` — `services/action.ts:20`.

### npm dependencies

- `effect` — direct (the substrate type `Effect.Effect`).
- `@mysten/sui` — direct (`Transaction` builder import from `/transactions` subpath).

No workspace-package imports beyond devstack itself.

## Capabilities PRODUCED

### Yieldable LayeredTag

- **`Action(name, opts)` returns a
  `LayeredTag<Name, TxResult, never, EInputs | EVerify | EProduce | ERegister | UpstreamE<U>>`** —
  `services/action.ts:75-78, 104` (delegated). Consumers `yield* actionRef` and receive the
  `TxResult` (digest + effects + objectChanges + balanceChanges; shape from
  `engine/shared.ts:92-97`).
- The tag carries:
  - `kind: 'action'` (drives TUI section + status-word "done" mapping).
  - `__upstreamKeys: [signer.key, ...needs.map(n => n.key)]` (auto-flattened by the substrate at
    `engine/on-chain-artifact.ts:262-264`).
  - `__layers`: the substrate folds upstream tags' `__layers` plus the action's own layer so the
    supervisor's runtime graph satisfies inner-tag identities
    (`engine/on-chain-artifact.ts:277, 281, 290`).
  - `__pluginName: 'action'` — `engine/on-chain-artifact.ts:280` (`plugin: spec.plugin` → `'action'`
    from `services/action.ts:107`).
  - `__displayTitle: 'tx.<name>'` — `services/action.ts:108`.
  - Brand `DevstackTagBrand`.

### State-store entry

- **Cache key shape**: `action/<chainId>/<inputsHash>` where `inputsHash` is a 16-char hex content
  hash — `engine/cache.ts:123-128, 171-178`, asserted by
  `services/action.test.ts:207, 239, 356-357, 383-384, 414`.
- **Value shape**: `TxResult` (the post-execute receipt with `digest`, `effects`, `objectChanges`,
  `balanceChanges`). Same shape `signer.signAndExecute` returns.
- **Inputs hashed (in order; canonical JSON via `jsonBigintReplacer`)**:
  - `name: <action name>` — `services/action.ts:142`.
  - `signer: <signer.address>` — `services/action.ts:143`.
  - `needs: [<tag.key>, ...]` — `services/action.ts:144`.
  - `userKey: <cacheKey-resolved-string>` — only present when `opts.cacheKey !== undefined` —
    `services/action.ts:145-146`.

### TUI row

- **Row in actions section**, label `tx.<name>` while acquiring, becomes `display(TxResult)`
  projection on ready:
  - `title: 'tx.<name>'` — `services/action.ts:110`.
  - `primary: 'digest <digest>'` — `services/action.ts:111`.
  - `extras: ['<N> objects']` — only when `objectChanges.length > 0` — `services/action.ts:112-118`.
- During execute, the row's status column shows `'building'` then `'executing'` (via `setPhase`).
- On success, the row's status word becomes `'done'` (not `'ready'`) — `tui/components.tsx:234`.

### Span annotations (observability)

Via `withCache` (`engine/cache.ts:129-132, 139, 143, 150`):

- `cache.namespace = 'action'`
- `cache.key = action/<chainId>/<hash>`
- `cache.outcome ∈ {'hit', 'miss', 'verify-fail'}`

Via the engine lifecycle wrap (`advanced/tag.ts:322-328`):

- `service.name = 'action'` (from `plugin: 'action'`)
- `devstack.stack`, `devstack.app`

### Log lines

Via `withCache` (`engine/cache.ts:140, 144, 151`):

- `Action(<name>): cache hit`
- `Action(<name>): cache miss`
- `Action(<name>): cache verify-fail`

(The `label` is `'Action(<name>)'` — `services/action.ts:125`.) The
`engine/snapshot.docker.test.ts:232` snapshot test asserts `/Action\(arena\.openLobby\): cache hit/`
on the post-restore apply.

### TypeScript exports

Surfaced from the root `@mysten-incubation/devstack` barrel:

- `Action` — `src/index.ts:55`.
- `type ActionOptions` — `src/index.ts:56`.

`PublishError` (which an action's signing failure raises) is also exported on `/advanced` for
`catchTag` use — `src/index.ts:148`.

No CLI commands, routes, container images, or volumes are registered by action itself. (Side effects
like minted coins / created objects live on the underlying Sui chain — captured by `docker commit`
of the sui-localnet container, NOT directly produced by action.)

## Lifecycle

### Startup (per-cycle acquire)

Ordered sequence when an action LayeredTag is yielded (e.g. by `Dev({ needs: [..., theAction] })` or
directly via `yield* theAction`):

1. **Substrate setup** (`engine/on-chain-artifact.ts:228-256`):
   1. The substrate's `withEngineLifecycle` wrap fires `engine.markAcquiring(name, 'action')` — the
      TUI row flips from `pending` to `acquiring`.
   2. The substrate yields `signer` and every `needs[i]` in turn —
      `engine/on-chain-artifact.ts:230-238`. This blocks until all upstream refs are themselves
      `ready`. Order within the loop is JS `Object.entries(spec.upstream)` order — the
      `__upstreamKeys` dep graph determines the real ordering across primitives; within-spec
      ordering doesn't change the graph.
   3. The substrate yields `SuiTag` (for `chainId`) and `ChainProbe` (for verify) —
      `engine/on-chain-artifact.ts:243-244`.
2. **Cache lookup** (`withCache`, `engine/cache.ts:120-152`):
   1. Evaluate the `inputs` Effect — this runs `cacheKeyEff` if set (so `Effect`-form `cacheKey`
      re-evaluates EVERY acquire, even on hit — see `services/action.test.ts:418-451`).
   2. Compute `inputsHash` and `key = action/<chainId>/<hash>`.
   3. `state.get<TxResult>(key)`.
   4. **Hit path**: run `verify({ cached, chain, deps })` → `chain.getTransaction(cached.digest)` →
      if defined, return cached value; emit `Action(<name>): cache hit` and `cache.outcome = 'hit'`;
      SKIP build + sign. No state-store puts. Behaviour change vs pre-Phase-C: there is no "no
      cacheKey → always run" branch anymore (`services/action.ts:67-74` notes this —
      `services/action.test.ts:212-241` covers the change).
   5. **Verify-fail path**: `verify` returns `undefined` → state.remove(key) → fall through to
      produce. Emits `Action(<name>): cache verify-fail` and `cache.outcome = 'verify-fail'`. Tested
      at `services/action.test.ts:280-332`.
   6. **Miss path**: `state.get` returns `Option.none()` → emit `cache.outcome = 'miss'` and
      `Action(<name>): cache miss` → fall through to produce. Tested at
      `services/action.test.ts:180-241`.
3. **Produce (cache miss / verify-fail)** (`services/action.ts:168-187`):
   1. `setPhase('building')` → row's status column reads `building`.
   2. `t = new Transaction()`.
   3. If `opts.gasBudget !== undefined`: `t.setGasBudget(opts.gasBudget)`.
   4. `yield* opts.build(t)` — user callback mutates `t`. Free to `yield*` upstream refs (each
      yields its resolved value; refs already participated in `upstream` so they're memoized).
   5. `setPhase('executing')` → row's status column reads `executing`.
   6. `yield* signer.signAndExecute(t)` — returns `Effect<TxResult, SignAndExecuteError>`. Failure
      is wrapped:
      `Effect.mapError(cause => new PublishError({ phase: 'publish-tx', message: 'Action(<name>): sign+execute failed', cause }))`
      — `services/action.ts:177-186`.
4. **Persist (cache miss / verify-fail)** (`engine/cache.ts:154-156`):
   - `state.put(key, fresh)` (`Effect.ignore` on failure — a state-store IO defect mustn't fail the
     primitive).
5. **Register**: omitted (action declares no `register` callback — the substrate treats absence as
   noop; `engine/on-chain-artifact.ts:253-255`).
6. **Lifecycle finish**: `engine.markReady(name, display(TxResult))` — the row's status flips to
   `ready` (rendered as `'done'`); `display` populates `title`, `primary`, `extras`.

### Ready criteria

The action's LayeredTag resolves (= "ready") when EITHER:

- The cached `TxResult` is returned (hit path, verify succeeds), OR
- A fresh `TxResult` from `signer.signAndExecute(t)` is returned (miss/verify-fail path) AND
  `state.put` has been attempted (best-effort).

`engine.markReady` fires inside the lifecycle wrap's `Effect.onExit` success branch
(`advanced/tag.ts:367-370`); consumers downstream of the action (e.g. `Dev({ needs: [theAction] })`)
start their own acquire when the action's `markReady` resolves. There is NO long-running fiber for
the action — it completes and stays in `ready` state forever (status word: `'done'`).

### Restart behavior

**Within-process hot-restart (`r` key / watch-fire):**

- The supervisor closes the previous run's per-primitive scope, then re-yields the LayeredTag.
- `withCache` consults the state-store cache. Because `state.put` from the previous cycle persisted
  the entry (and `docker stop` of sui-localnet preserves the writable layer holding the chain state
  — `services/action.ts:60-66`), the cache hits, verify probes the on-chain digest (still resolves —
  chain state survived), and the action's `build` + `signAndExecute` are SKIPPED.
- Net effect: subsequent restarts emit `Action(<name>): cache hit` and the row goes ready instantly.
  Asserted by `engine/snapshot.docker.test.ts:232`.

**`devstack stack down --force` / `wipe`:**

- The container's writable layer is discarded → chain state lost → on next `apply`, a fresh genesis
  runs → `sui.chainId` flips → cache key shape changes (`action/<chainId-new>/<hash>` vs old
  `action/<chainId-old>/<hash>`) → cache miss → action re-fires. Tested by chainId variation at
  `services/action.test.ts:361-386`.
- The state-store entries for the old chainId remain in the `.devstack/state.json` file, but are
  unreferenced. (See "Pain points" — there is no GC.)

**Snapshot restore (`devstack snapshot restore <label>` → `apply`):**

- The snapshot captures the docker container's writable layer (chain state) AND copies the
  state-store file (`state.json`) back.
- On `apply`, `sui.chainId` matches the snapshot's chainId → cache hits → action does NOT re-fire.
  The snapshot test (`engine/snapshot.docker.test.ts:217-232`) treats `Action(<name>): cache hit` as
  the smoking gun for a correct restore.

**Regenesis (e.g. `sui-fork` mode reset, or a `wipe` followed by `apply`):**

- New `chainId` → cache miss → action re-fires automatically. No explicit cleanup needed (old
  entries dangle but don't collide).

### Teardown

Action has NO long-lived resources to tear down — no container, no socket, no file handle. The
action body runs once during acquire, then idles. On supervisor shutdown:

- The action's per-primitive scope closes alongside every other primitive's scope
  (`advanced/tag.ts:311, 345`).
- No `markStopping` / `markStopped` events are emitted (those fire only for primitives with
  long-lived resources, e.g. docker containers via `Docker.run`'s stop finalizer).
- The state-store entry persists across teardown — that's the whole point of caching.

OPEN QUESTION: What happens to the action's row in the TUI on shutdown? It likely stays in `ready`
(status word `'done'`) until the process exits, but no explicit `markStopped` is fired. The TUI
Footer shutdown count excludes `action`-kind rows (`tui/components.tsx:875-876`).

## Hard requirements / invariants

These are load-bearing constraints — violation breaks the action's contract or downstream consumers.

1. **Cache key MUST fold `(name, signer.address, needs[].key, chainId, userKey?)`
   deterministically** — `services/action.ts:136-148`; tested at `services/action.test.ts:336-386`.
   Two `Action(...)` factories with the same `(name, signer, needs)` and same `cacheKey` MUST
   produce the same cache key; differing any one of `name` / `signer.address` / `needs[].key` /
   `userKey` / `chainId` MUST produce a different key.

2. **`opts.build` is NOT hashed into the cache key** — `services/action.ts:131-135`. The substrate
   cannot canonicalize a function body. Mutating the build callback to a meaningfully-different
   transaction WITHOUT changing `cacheKey` would result in the old cached `TxResult` continuing to
   resolve — caller responsibility to pass a fresh `cacheKey` (e.g. a content hash of relevant
   inputs) when the build body's semantics change.

3. **`opts.gasBudget` is NOT hashed into the cache key** — `services/action.ts:131-135` (covered by
   same comment); not asserted by any test. OPEN QUESTION: is this intentional? It means changing
   `gasBudget` doesn't invalidate the cache; the cached digest would still pass `getTransaction`
   verify, and a stale-but-resolved tx with the wrong gas budget would be returned. Probably fine
   for the action's use case (one-shot setup ops — once it succeeded, the gas budget is irrelevant)
   but worth flagging.

4. **`verify` MUST be lenient against transient RPC failures** —
   `services/action.ts:156-158, 159-162`. `ChainProbe.getTransaction` returns `undefined` for any
   RPC failure (not just "not found"); the action relies on this — if `verify` raised an error
   instead, transient blips would invalidate the cache and re-fire the action unnecessarily.

5. **`cacheKey: Effect<string>` MUST be evaluated at acquire time, not construction time** —
   `services/action.ts:140-141, 79-84`; tested at `services/action.test.ts:389-451`. Evaluating at
   construction would lose access to other primitives' resolved state (e.g.
   `cacheKey: Effect.gen(function* () { const pkg = yield* connectFour; return pkg.packageId; })` —
   `examples/arena/devstack.config.ts:37-40`).

6. **The `cacheKey` Effect is evaluated on EVERY acquire (hit OR miss)** — implied by
   `engine/cache.ts:122` (inputs is yielded before consulting the cache); asserted by
   `services/action.test.ts:418-451`. Side-effecting cacheKey Effects (e.g. logging) WILL re-run on
   cache hits. The test verifies `cacheKeyEvals === 2` and `buildRuns === 1` after two acquires.

7. **Every `Action(...)` is cached (no opt-out)** — `services/action.ts:68-74`; explicitly tested at
   `services/action.test.ts:212-241`. There is no longer an "always re-run" branch; callers force
   re-fire via dynamic `cacheKey` (e.g. `Effect.sync(() => uuid())`).

8. **`signAndExecute` failure MUST be wrapped in `PublishError({ phase: 'publish-tx', ... })`** —
   `services/action.ts:177-186`. The supervisor catches errors at the engine level (per the file
   header: "the supervisor catches errors at the engine level so users don't have to `catchTag`
   inside every action" — `services/action.ts:4-5`); the `PublishError` shape gives `catchTag`-style
   downstream handlers a stable discriminator.

9. **Action does NOT populate any in-process registries** — `services/action.ts:189-191`. The
   substrate's `register` callback is omitted. This is correct: actions emit ad-hoc receipts that
   don't fit the `PackageRegistry` / `CoinRegistry` shape. (Compare to `publishMove` which registers
   each `{name, packageId}` for cross-ref lookups.)

10. **`upstream` MUST contain `signer` first** — `services/action.ts:100-102`. The substrate's typed
    `Resolved<U>` shape carries a typed `signer: Account` slot the `inputs` and `produce` callbacks
    unpack — losing the `signer` alias would break the type machinery.

11. **Synthetic `need0`/`need1`/… aliases must be stable across runs** — `services/action.ts:91-95`.
    The `__upstreamKeys` are derived from the record's _values_ (which carry `tag.key`), not the
    alias names, so the synthetic aliases don't surface to the dep graph; but the inputs hashing
    folds in `needs.map(n => n.key)` (the array of keys in declaration order —
    `services/action.ts:144`), so reordering `opts.needs` WOULD change the cache key. Caller
    responsibility.

12. **`kind: 'action'` MUST be stamped** — `services/action.ts:106`; via
    `engine/on-chain-artifact.ts:283`
    (`...(spec.kind !== undefined ? { kind: spec.kind } : { kind: 'action' as TagKind })`). This
    drives the TUI section placement, the `'done'` status-word mapping, and the shutdown-count
    exclusion. A change to `kind` would break TUI rendering.

13. **Action's TxResult MUST be serializable for the state-store** — implied by
    `engine/cache.ts:155` (`state.put(key, fresh)`). The `TxResult` shape (`digest: string`,
    `effects: { status }`, `objectChanges: ReadonlyArray<SuiObjectChange>`,
    `balanceChanges: ReadonlyArray<BalanceChange> | undefined`) is plain-JSON-able. OPEN QUESTION:
    are there `bigint` fields that depend on `jsonBigintReplacer`? The cache module uses
    `jsonBigintReplacer` for inputs (`engine/cache.ts:123`) but `state.put`/`get` go through the
    StateStore implementation; if the live `StateStore` writes via `JSON.stringify` it would need
    bigint handling too. (Not action's concern, just flagging.)

## Failure modes

| Failure                                                                                         | Trigger                                                                                                                                                                                                      | Current behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Recovery                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `opts.build` throws / yields a failing Effect                                                   | User code defect or yielded upstream ref failed                                                                                                                                                              | Error bubbles up through the `produce` Effect — surfaces in `Effect.onExit`'s failure branch in the lifecycle wrap (`advanced/tag.ts:371-378`) — `markFailed(name, cause)` + `appendLog` with prettyError of the cause tree. TUI row flips to `failed` with one-line summary; full multi-line cause in global log tail. Build's `E` channel typically carries `PublishError` (from a yielded `Package` ref) — surfaces via `catchTag` if a downstream consumer handles it; otherwise propagates. Downstream consumers (`Dev({ needs: [theAction] })`) stay blocked at `pending` because the action never reached `ready`. | Hot-restart (`r`) re-runs; `wipe` re-derives chain state. The user must fix the underlying issue.                                                                                          |
| `signer.signAndExecute(t)` returns `SignAndExecuteError`                                        | RPC failure, insufficient gas, transaction-execution failure on chain, signer key missing                                                                                                                    | Mapped to `PublishError({ phase: 'publish-tx', message: 'Action(<name>): sign+execute failed', cause: <original> })` — `services/action.ts:178-185`. Same `markFailed` + global-log flow as above.                                                                                                                                                                                                                                                                                                                                                                                                                        | Same as above.                                                                                                                                                                             |
| `ChainProbe.getTransaction(digest)` returns `undefined` (verify-fail) on cache hit              | Regenesis where digest no longer resolves, transient RPC failure (returns `undefined` for any failure), or genuine "tx evicted" (unlikely on Sui mainnet but possible on a local node that pruned its tx db) | `withCache` evicts the cache entry (`state.remove(key)`, best-effort), emits `Action(<name>): cache verify-fail`, falls through to `produce` → action re-fires. Tested at `services/action.test.ts:280-332`.                                                                                                                                                                                                                                                                                                                                                                                                              | Automatic — action re-fires immediately.                                                                                                                                                   |
| `state.put(key, fresh)` IO defect on cache persist                                              | StateStore implementation failure                                                                                                                                                                            | Swallowed by `Effect.ignore` (`engine/cache.ts:155`) — fresh value is returned to the consumer; cache entry is NOT persisted. Next cycle WILL re-fire (cache miss).                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Automatic — re-runs next cycle. Hidden from user.                                                                                                                                          |
| `state.remove(key)` IO defect on verify-fail eviction                                           | StateStore implementation failure                                                                                                                                                                            | Swallowed by `Effect.ignore` (`engine/cache.ts:148`) — produce path still runs, fresh value still returned. Stale cache entry may persist (but next cycle's verify will fail again, and so on).                                                                                                                                                                                                                                                                                                                                                                                                                           | Automatic per-cycle; or `wipe` to clear state.                                                                                                                                             |
| Upstream ref fails before action's `upstream` resolution completes                              | An entry in `opts.signer` / `opts.needs` itself failed to acquire                                                                                                                                            | The substrate's `resolveUpstream` Effect (`engine/on-chain-artifact.ts:228-239`) raises immediately — action's lifecycle wrap fires `markFailed` with the inner failure's cause; the row flips to `failed` AT the action level. Downstream consumers see the action's failure (not the upstream's directly).                                                                                                                                                                                                                                                                                                              | Fix the upstream issue. Action will auto-recover when upstream does (next hot-restart cycle).                                                                                              |
| `cacheKey: Effect<string>` Effect throws                                                        | User code in `Effect.gen` body raises                                                                                                                                                                        | Surfaces in `inputs(deps)` evaluation inside `withCache` — failure propagates up through `produce`'s lifecycle wrap → `markFailed`. NOT tested directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | User-code bug; needs fix.                                                                                                                                                                  |
| Action body succeeds, then a hot-restart re-runs `verify` on a digest the local node has pruned | E.g. ran action, then docker-restarted sui-localnet container                                                                                                                                                | If sui pruned txs older than its retention window, `getTransaction` returns `undefined` → verify-fail → action re-fires. May surprise the user (action they thought was idempotent ran again).                                                                                                                                                                                                                                                                                                                                                                                                                            | Automatic re-run; usually safe because the build callback is idempotent against the resolved upstream state (e.g. arena's `openLobby` would create a SECOND lobby — see "Open questions"). |

## Persistence model

| Asset                                                     | Survives hot-restart (`r`)                                                              | Survives `docker stop` of sui-localnet         | Survives snapshot capture/restore                                            | Survives `wipe` / `stack down --force`                                        | Survives `devstack devstack reset` (n/a — same as wipe) | Process-local only |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------ |
| State-store entry `action/<chainId>/<hash>` → `TxResult`  | yes (`state.json` is on host disk; `engine/state-store.ts` impl persists across cycles) | yes                                            | yes (snapshot copies `state.json`; `engine/snapshot.docker.test.ts:217-232`) | no (`wipe` clears `state.json` AND the docker writable layer — chainId flips) | n/a                                                     | —                  |
| On-chain side effects (the actual mint / object creation) | yes (chain state lives in docker writable layer; `services/action.ts:60-66`)            | yes (docker stop preserves the writable layer) | yes (snapshot does `docker commit`)                                          | no (writable layer discarded → genesis)                                       | n/a                                                     | —                  |
| Span annotations / log lines                              | no — emitted to the observability sink per cycle                                        | —                                              | —                                                                            | —                                                                             | —                                                       | yes                |
| TUI row                                                   | no — re-seeded each cycle                                                               | —                                              | —                                                                            | —                                                                             | —                                                       | yes                |
| Per-primitive scope (no resources to release anyway)      | no — closes at cycle end                                                                | —                                              | —                                                                            | —                                                                             | —                                                       | yes                |

**`devstack wipe`** clears the cache (because chain state goes away → chainId flips on next genesis
→ entries are unreferenced). It does NOT explicitly remove `action/*` entries; they're just
naturally orphaned (see "Pain points").

**Process-local only**: TUI rendering state, the engine's in-memory `tuiState` ref, per-primitive
scope, span context.

## Modes & variants

Action has a single mode at the engine level — its body behavior does NOT change based on whether
the underlying Sui is in `local` / `live` / `fork` mode. The substrate just resolves `SuiTag` via
whatever Layer the user composed (`Sui()` / `Sui.fork({...})` / `Sui.live({...})`), and the action's
`signer.signAndExecute(t)` flows through that same Sui client. The
`services/action.fork.docker.test.ts` file exists specifically to assert that:

- An action's verify probe uses `ChainProbe.getTransaction(digest)` (which under the hood calls
  `client.core.getTransaction(...)`), NOT the unsupported `getBalance` / `listBalances` surfaces —
  those would be intercepted by Phase 1's `forkGuard` Proxy and throw `ForkUnsupportedError` before
  the RPC fires.
- The full round-trip (cache miss → build → sign → verify → cache hit on second run) works
  end-to-end on a fork stack.

The test file is currently a placeholder (`services/action.fork.docker.test.ts:15-21`:
`// Pending docker wiring. ... expect(SHOULD_RUN).toBe(true);`) — the file exists to (a) document
the intent, (b) hold the `RUN_FORK_DOCKER_TESTS=1` gate, (c) be filled in once the docker fork
wiring is in place. So the file is "test fixture infrastructure" rather than executable coverage
today.

Since action has only one observable mode (its body is mode-agnostic), a brief paragraph (above)
replaces the modes table per the template. The fork-mode test exists only as a guard against the
verify-probe surface accidentally using a fork-forbidden RPC method.

## Test coverage

### `services/action.test.ts` (452 LOC)

Encoded spec — describes/its and what each asserts. Mocks: in-memory StateStore (records all
`put`/`remove`/`get`), mock SuiTag with configurable `chainId`, mock ChainProbe with configurable
`getTransaction` (defaults to "digest always resolves"), mock signer (records `signAndExecute`
calls, returns a deterministic TxResult).

- **`describe('Action — cache miss')`**:
  - `it.effect('runs build + sign on first acquire and persists the TxResult')`
    (`services/action.test.ts:180-210`) — asserts `buildRuns === 1`, `signCalls.length === 1`,
    exactly one state-store put with key matching `/^action\/mock-chain-A\/[0-9a-f]{16}$/`, and that
    the persisted value's digest matches the returned result.
  - `it.effect('every Action is cached — omitting cacheKey still persists a TxResult')`
    (`services/action.test.ts:212-241`) — same shape but with `opts.cacheKey` undefined. Asserts the
    behavior change vs pre-Phase-C: NO opt-out. Still produces an `action/<chainId>/<hash>` key.
- **`describe('Action — cache hit')`**:
  - `it.effect('second run with the same cacheKey skips build and returns the cached TxResult')`
    (`services/action.test.ts:245-278`) — runs the action twice with the same cacheKey; second run
    does NOT increment `buildRuns` or `signCalls`; the cached TxResult is returned verbatim (same
    digest); no additional `state.put` calls.
  - `it.effect('cache hit evicts the entry and re-runs when getTransaction returns undefined')`
    (`services/action.test.ts:280-332`) — primes the cache with one run, then re-runs with a
    verify-fail probe (`getTransaction: () => Effect.succeed(undefined)`); asserts `state.removes`
    contains the cached key, `buildRuns === 1`, `signCalls.length === 1`, and the entry is
    re-persisted with `state.puts.length === 1` post-reset.
- **`describe('Action — cache key invalidation')`**:
  - `it.effect('different userKey produces a different cache key (build re-runs)')`
    (`services/action.test.ts:336-359`) — same name/signer/needs but different `cacheKey` values
    (`'v1'` vs `'v2'`); asserts two distinct cache keys with the canonical shape, both signed
    independently.
  - `it.effect('different chainId produces a different cache key (regenesis invalidation)')`
    (`services/action.test.ts:361-386`) — same action acquired against `chainId: 'chain-A'` then
    `chainId: 'chain-B'`; asserts two distinct cache keys with `chain-A` and `chain-B` in the
    chainId slot respectively.
- **`describe('Action — cacheKey as Effect')`**:
  - `it.effect('Effect-form cacheKey is yielded and folded into the persistence key')`
    (`services/action.test.ts:390-416`) — uses a Ref-incrementing `cacheKey` Effect; asserts the
    Effect was evaluated once (`Ref.get(counter) === 1`) and that a cache entry was persisted with
    the canonical key shape. Confirms cacheKey is yielded AT ACQUIRE TIME, not construction time.
  - `it.effect('Effect-form cacheKey hits the cache on the second acquire (no double build)')`
    (`services/action.test.ts:418-451`) — runs the action twice; asserts `cacheKeyEvals === 2`
    (Effect evaluates every acquire, even on hit), `buildRuns === 1`, `signCalls.length === 1`. The
    second acquire's cacheKey evaluation finds the persisted entry and short-circuits.

### `services/action.fork.docker.test.ts` (22 LOC)

- **`describe.skipIf(!SHOULD_RUN)('services/action fork docker gate (P3.T7)')`**
  (`services/action.fork.docker.test.ts:14`):
  - `it('Action() runs on a fork stack; probeCachedTx hits client.core.getObject; second run cache-hits')`
    — placeholder. Test body is `expect(SHOULD_RUN).toBe(true)`. The "unit-equivalent" (verify probe
    uses `getObject`/`getTransaction` not `getBalance`) is verified at the engine layer; docker
    round-trip is pending.

### Coverage gaps

Not directly covered by `action.test.ts` (potential gaps from a reading of `services/action.ts`):

- `opts.gasBudget` being applied to `t.setGasBudget(...)` — not asserted in any test.
- `setPhase('building')` / `setPhase('executing')` narration — implicit in lifecycle wrap testing
  elsewhere, not action-specific.
- `PublishError` wrap of `signAndExecute` failure with `phase: 'publish-tx'` — not asserted.
- The `display(TxResult)` projection (title `tx.<name>`, primary `digest ...`, extras `N objects`) —
  not asserted.
- Multi-`needs` action behavior (the synthetic `need0`/`need1` aliases) — not asserted by any test;
  only single-or-zero `needs` cases appear.
- `gasBudget`'s exclusion from the cache key — not asserted.
- Build callback yielding upstream refs (the closure-capture pattern from
  `examples/_template/devstack.config.ts:33-39`) — not asserted by unit tests; covered indirectly by
  example apps' e2e tests.

Coverage is decent on the cache discipline (the hard part) but light on the action-specific surfaces
(gasBudget, display, error wrapping).

## Pain points today

1. **`opts.build` is opaque to the cache** — `services/action.ts:131-135`. The substrate cannot
   canonicalize a function body, so changing the build's semantics WITHOUT also bumping `cacheKey`
   silently uses the old cached digest. This is correct per design (action assumes build is
   idempotent against the resolved upstream state), but it's a footgun for new users who don't
   realize "if I change the body, I need a new cacheKey".

2. **`opts.gasBudget` exclusion from cache key is unstated** — same comment block as above. If a
   user discovers their gas budget was insufficient and bumps it, the cached digest still resolves
   and the action doesn't re-run. They'd have to manually `wipe` or pass a new `cacheKey`. Not
   tested.

3. **Synthetic alias indirection (`need0`, `need1`, …)** — `services/action.ts:91-95`. The substrate
   wants a typed record (`upstream: { signer, ... }`), so the positional `opts.needs` array is
   shoehorned into a synthetic record. The aliases are never user-visible (closure-captured by
   `opts.build`), but they exist for the `__upstreamKeys` auto-flattening. Two reasonable
   alternatives: (a) extend the substrate to accept a positional array for the needs slot, (b) hoist
   the synthesis into the substrate itself so other primitives like `Codegen` / `Dev` benefit.
   As-is, it's an awkward bridge layer.

4. **`cacheKey: Effect<string>` re-evaluates on EVERY acquire, even on hit** — `engine/cache.ts:122`
   and tested at `services/action.test.ts:418-451`. This is correct in that side-effecting cacheKey
   Effects (e.g. yielding upstream refs to derive a key from `pkg.packageId` per
   `examples/arena/devstack.config.ts:37-40`) need to re-run to participate in the dep graph. But it
   means a costly cacheKey computation runs even when the cache will hit. Not a real performance
   problem today (cacheKey computations are cheap), but the asymmetry between "cache HIT means we
   can skip everything" and "we still must yield the cacheKey" deserves a doc-comment audit.

5. **State-store entries dangle after chain regenesis** — `wipe` clears chain state (writable docker
   layer) but does NOT explicitly clear the state-store `action/*` entries. They're "naturally
   orphaned" because chainId flips, but the `state.json` file grows monotonically across regenesis
   cycles. There is no GC. Same issue affects every `onChainArtifact` consumer, not just action.

6. **Fork-mode test is a placeholder** — `services/action.fork.docker.test.ts:15-21`. The file
   exists to document intent, but the assertion `expect(SHOULD_RUN).toBe(true)` is trivially true
   when the test runs. Until the docker round-trip is wired up, the file's only function is to be a
   tombstone for the missing coverage.

7. **`R` channel of `opts.build` declared but unused** — `services/action.ts:34, 75-77` (`R = never`
   in the generic), then in `produce` it's typecast away
   (`yield* opts.build(t) as Effect.Effect<void, unknown, never>` — `services/action.ts:175`). The
   `R` channel is captured for type-inference (so `yield* hello` inside build threads the package
   ref's identity into the action's overall E channel), but the runtime resolution happens via
   closure capture — the substrate doesn't actually provide `R` services to the build Effect. The
   dual-purpose role is subtle and underdocumented.

8. **No retry / backoff** — if `signer.signAndExecute(t)` fails for a transient reason (RPC blip,
   nonce conflict, etc.), the action's lifecycle wrap fires `markFailed` immediately. The user has
   to manually `r` (hot-restart) to retry. `withCache`'s verify lenience saves the cache-hit path
   from transient blips, but the produce path has no such protection.

9. **Action's TxResult is opaque to downstream consumers beyond `digest`** — consumers
   `yield* theAction` and get the `TxResult`, but the most useful fields (created object IDs,
   balance changes) require navigating `objectChanges` / `balanceChanges` arrays. There's no helper
   to e.g. "give me the objectId of the first created `<Type>`". The build callback knows the object
   types it creates but doesn't surface a typed record. Compare to `Package` which auto-discovers
   coin records and exposes `pkg.coins`. (See "Open questions" on whether this is by design.)

10. **`plugin: 'action'` is generic** — `services/action.ts:107`. The TUI groups rows by plugin
    attribution for color/section purposes, and every `Action` lands in the same `'action'` plugin
    bucket. A user with 10 actions sees them all painted the same color; there's no way to attribute
    an action to a logical group ("seedTokens belongs to the wallet plugin", "openLobby belongs to
    the arena plugin"). Compare to `Package` / `Sui` / `Walrus` which carry their plugin's identity.

## Open questions

- **What happens to the action's row in the TUI on supervisor shutdown?** The lifecycle wrap fires
  `markReady` on success; there is no corresponding teardown event (no resources to stop). The row
  presumably stays `ready` (rendered as `'done'`) until the process exits. NOT verified against the
  TUI tests. (`tui/components.tsx:875-876` excludes action from the shutdown count, confirming
  there's no expectation of `markStopping` / `markStopped` for actions.)

- **`gasBudget`'s exclusion from the cache key — by design or oversight?** The comment at
  `services/action.ts:131-135` says "Builder / gasBudget are NOT hashed: the build callback is an
  arbitrary closure and the substrate cannot canonicalize a function body". The reasoning conflates
  `build` (uncanonical-able) with `gasBudget` (a `bigint` which IS canonical-able). Either: (a)
  intentional because gas-budget changes don't change the _semantic effect_ of the tx — once
  succeeded, the receipt is what matters; or (b) overlooked. Worth confirming with the substrate's
  author.

- **Is the action body required to be idempotent against the resolved upstream state?** The
  fork-mode and snapshot-restore semantics assume "if cache hits, the build/sign was idempotent —
  running it again would produce the same on-chain effect". But there's no enforcement: arena's
  `openLobby` mints a new Lobby every time it runs (`examples/arena/devstack.config.ts:32-36` notes
  the cacheKey is necessary "without this, each `r` / process restart minted a fresh Lobby"). If the
  user forgets to set a stable cacheKey AND the chain state is preserved AND the cache invalidates
  (e.g. verify-fail due to RPC blip), the action re-runs and creates a second Lobby. There's no
  detection mechanism.

- **What's the contract for `opts.build` failing partway through (e.g. yielded `Package` ref's E
  channel raises)?** Today: `Effect.Effect<void, E, R>` (`services/action.ts:34`) — any `E` raised
  propagates through `produce` and surfaces as a `markFailed` cause. The `E` is widened to `unknown`
  for the lifecycle wrap (`services/action.ts:175 as Effect.Effect<void, unknown, never>`), so
  `catchTag` discrimination requires hoisting the catch into the user's build callback. Unclear from
  comments whether this is recommended or whether the supervisor's engine-level catch is expected to
  be enough.

- **Why does `services/action.fork.docker.test.ts` exist as a tombstone rather than just being
  deleted?** Could be (a) intent-documentation, (b) the test gate `RUN_FORK_DOCKER_TESTS=1` is part
  of CI infrastructure for the docker fleet, (c) someone planned to fill it in. The file's content
  is a 22-line placeholder. Per the user memory `feedback_no_compat_for_never_cases.md`, intent-only
  files should be deleted; but since this carries an env gate matching other fork docker tests (e.g.
  `sui-fork.container.docker.test.ts`), it might be load-bearing infrastructure.

- **Are TxResult fields stable across SDK upgrades?** The shape is folded together by
  `account.ts::mapTxResult` per `engine/shared.ts:88-91`. If `@mysten/sui` ships a
  non-backwards-compatible projection (e.g. drops `balanceChanges`), cached `TxResult` entries
  persisted with the older shape would silently deserialize with `undefined` fields. The state-store
  doesn't version entries.

- **How does action interact with `defineDevstack`'s `watch` aggregation?** The substrate accepts
  `watch:` in `OnChainArtifactSpec` (`engine/on-chain-artifact.ts:106`), but `services/action.ts`
  doesn't pass one. Could a user declare a watch pattern on their action so that a change to (say)
  the Move source they reference triggers a re-fire? Not surfaced today; would require extending
  `ActionOptions`.

- **Is the `action.fork.docker.test.ts` test gate the only signal of action being
  fork-mode-supported, or does it work without the env gate?** OPEN QUESTION: the placeholder is
  gated by `RUN_FORK_DOCKER_TESTS=1`; the actual runtime support comes from the fact that action's
  verify probe routes through `ChainProbe.getTransaction` (which uses `client.core.getTransaction` —
  a method `forkGuard` permits per the test file comment `services/action.fork.docker.test.ts:1-8`).
  So action SHOULD work in fork mode without further changes; the test gate is just for the docker
  e2e of the round-trip.

## Opportunities noticed

- **Lift the synthetic-alias pattern into the substrate.** `services/action.ts:91-95` shoehorns
  `opts.needs: ReadonlyArray<...>` into a synthetic record (`{ need0, need1, ... }`) because
  `onChainArtifact`'s `upstream` slot is strictly a record. Several primitives (`Codegen`, `Dev`,
  future ones) likely face the same friction. Two options: (a) add a positional `needs:` array to
  `OnChainArtifactSpec` that the substrate flattens internally, (b) accept any iterable shape and
  the substrate normalizes.

- **`fork.docker.test.ts` is a 22-line tombstone.** Per `feedback_no_compat_for_never_cases.md` and
  `feedback_completed_plans_should_be_deleted.md`, this file should either be filled in or deleted.
  The test gate (`RUN_FORK_DOCKER_TESTS=1`) is shared infrastructure for fork docker tests, so
  deleting JUST this file shouldn't break the gate — other test files exist using the same gate
  (`sui-fork.container.docker.test.ts` is referenced in the comment).

- **`opts.gasBudget` exclusion from cache key deserves a test (or a fix).** If the exclusion is
  intentional, encode it as an asserted invariant. If it's an oversight, fix.

- **Document the `build` callback's `R` channel role.** Today `R` is `never` in the public type but
  used internally for type inference of yielded upstream refs. A new contributor would not realize
  this from the signature. A doc-comment on `ActionOptions.build` would help.

- **Consider a typed `Action.objectCreated<T>(...)` helper.** Pain point #9 — TxResult is opaque
  beyond `digest`. A helper that lets callers say
  `const lobbyId = yield* action.objectCreated('arena::game::Lobby')` would mirror
  `Package.fromCoin` / `Coin.fromPackage` ergonomics. Open question whether this belongs at the
  action level or in a new helper module.

- **Plugin attribution.** Pain point #10 — every `Action(...)` is plugin `'action'`. Threading a
  `plugin:` option through `ActionOptions` would let users group their actions visually by domain.
  The substrate already accepts `plugin: string` via `OnChainArtifactSpec.plugin`.

- **Cache GC**. Pain point #5 affects every `onChainArtifact` consumer. A `devstack state gc` or
  implicit cleanup on chainId-flip-detected would help. Not action-specific.

- **The `services/action.ts` file's role inside `services/` is questionable** — there is no "Action
  service" the way there's a "Sui service" or a "Walrus service". Action is a _primitive factory_
  like `Account` / `Package`. The `services/` directory mixes long-running services with one-shot
  primitive factories. A future restructure might split into `services/` (long-running) and
  `primitives/` (factories that return LayeredTags).

- **`action.test.ts` has duplicated `mockSuiLayer` / `mockChainProbeLayer` / `acquireAction`
  boilerplate**. The same scaffolding likely appears in `services/package.test.ts` / similar. A
  shared `testing/onChainArtifactHarness.ts` would let those primitives' tests share a single
  mock-StateStore + mock-Sui + mock-ChainProbe + mock-signer suite, reducing the maintenance burden
  when the substrate evolves.
