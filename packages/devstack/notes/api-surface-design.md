# Devstack rewrite — public API surface design (2026-05-20)

> Companion to `api-comparison.md` (regression catalog) and the seven reviews under `reviews/`. This
> doc is the **design** answer for the user-facing config surface; `api-comparison.md` is the
> diagnosis.
>
> **Scope.** L4 user surface for `devstack.config.ts` + the plugin-author surface that authors
> third-party plugins (the redis-plugin example). Out of scope: CLI/TUI projection, runtime
> orchestration, codegen emission, snapshot/prune verbs.
>
> **Non-goal.** Sugar shims over the rewrite. Every recommendation below is justified against the
> 5-layer architecture, the nine capability contracts, composite refusal, and the OCA primitive.
> Where the substrate itself is the obstacle, the proposed substrate change is flagged explicitly.

---

## Section 1 — Design principles (eight)

These eight are derived from the user's framing (plugin-author / power- user / first-time dev
grow-with-you) crossed with the rewrite's architectural invariants. Each one is concrete enough to
test any specific decision below against.

### P1. **Cross-plugin refs are values, not strings.**

The reference a user types at site B to refer to plugin A is the same JS binding A returned. No
magic strings (`{ accountName: 'publisher' }` in seal), no per-instance string tag ids surfaced as
user vocabulary (`pkg.provides`), no rename-footgun classes. This is a hard non-negotiable: the
rewrite's strongest type-safety claim is "the user threads values through the config" and surfacing
identity as a string breaks it.

> Concretely: `seal({ signer: publisher })` ✓; `seal({ signer: { accountName: 'publisher' } })` ✗.

### P2. **The same factory name authors and uses.**

`account('alice')`, `localPackage('hello', …)`, `wallet({…})`, `redis({…})` — the lowercase factory
name is both what a first-time user writes AND what a plugin author exports. The plugin-author
surface is **not** a separate package, a separate subpath, or a different naming convention.
Plugin-author docs are app-author docs plus one extra page about `defineNodePlugin`.

> **Factory naming policy (locked):** every plugin factory — built-in and user-authored — is
> **lowercase** (`sui()`, `account('alice')`, `walrus()`, `postgres()`, `redis()`, …). PascalCase
> factories from v3 (`Sui`, `Account`, `Redis`) are dropped. STYLE_GUIDE §6 + the per-plugin naming
> roster in ARCHITECTURE.md are the canonical source; earlier drafts of this document that wrote
> `Redis({…})` are illustrative-pre-decision and have been corrected.

### P3. **Convention is aggressive; escape hatches are first-class.**

Every default infers from the smallest legible signal: `stackName` from cwd, `sui()` auto-mount when
any sui-needing plugin is present, `account('alice')`'s ephemeral funded variant when no opts,
network from `DEVSTACK_NETWORK` env, publisher inference when only one account is in the stack (see
§4 catalog). But every default has a visible override on the trailing `defineDevstack(…, opts)` bag,
and every plugin factory accepts the long form. The user can always type their way out.

### P4. **Type errors fire at compose, not at acquire.**

Missing providers, conflicting sibling hashes, refused composites (`walrus.localOf(forkSui)`),
unsatisfied witnesses, and per-instance tag-id collisions all surface as branded structured errors
at the `defineDevstack(…)` call site. Acquire-time runtime errors are for network/IO/cause failures
only. The rewrite already nails this; the API surface design must preserve it (and extend it: see
§7).

### P5. **One root barrel; subpaths are tree-shaking, not vocabulary.**

`@mysten-incubation/devstack` exports every user-facing factory, every plugin-author primitive, and
the composer. Subpaths exist so build tooling can prune unused plugins, **not** because the user has
to remember "wallet lives at `/plugins/wallet`". A first-time user types one import line; an
autocomplete prompt on `import { } from '@mysten-incubation/devstack'` shows the whole vocabulary.

### P6. **Substrate is name-aware-of-nothing; the surface is name-aware-of-everything.**

The substrate kernel (L0) must never name `sui` / `walrus` / `seal` / `deepbook` / `coin` /
`package`. The L4 user surface MUST. The composer is allowed to special-case "auto-mount sui when
not present" because the composer is L4 — it lives one layer above the kernel and is the natural
home for surface-level conventions. We push specific- plugin knowledge OUT of the substrate (lifting
`per-stack-registries/ {coin,package}.ts` to L2 — see `reviews/substrate.md`) and INTO the composer
(where it belongs).

### P7. **The config tells the story; the codegen carries the values.**

`devstack.config.ts` is a _declaration_. It declares which services boot, who signs what, what the
wallet's account list is. It does NOT import resolved values at boot time. Resolved values
(packageId, port, walletUrl, openLobbyId) flow to the app via codegen-emitted `src/generated/*`. The
config never imports anything that the app bundle would pull at runtime. This keeps L4 (user config)
and L5 (app code) cleanly separated.

### P8. **Growth is monotonic — adding a plugin never moves an existing line.**

A user who has `defineDevstack(sui(), alice, bob, hello)` adds wallet by appending one member:
`defineDevstack(sui(), alice, bob, hello, wallet({accounts: [alice, bob]}))`. No reshuffle. No "now
you need an options object because you have more than 3 members." Cross-plugin refs (the value
passed to `wallet({accounts})`) don't force changes to upstream plugins. The composer's order is
observation order, not dependency order — the substrate's topological sort handles dep order at
acquire.

---

## Section 2 — The cross-plugin reference problem

This is the centerpiece of the rewrite's API surface. Survey of the options, then a position.

The setup: in `arena`, the user composes sui + 2 accounts (alice + publisher) + 1 package
(connectFour, published by publisher) + 1 action (openLobby, signed by alice, depending on
connectFour) + 1 wallet (containing alice + bob). Cross-plugin refs needed:

- `localPackage(…, { publisher })` — needs the publisher account ref.
- `action(…, { consumes: [alice, connectFour], body: (ctx) => … ctx.get(…) })` — needs the alice +
  connectFour refs.
- `wallet({ accounts: [alice, bob, publisher] })` — needs all three.

This shape recurs in every non-trivial config. Get this right and 80% of the rewrite's ergonomic
regressions vanish.

### A. Direct instance passing (the "pass the member" pattern)

```ts
const alice = account('alice');
const bob = account('bob');
const publisher = account('publisher');

const connectFour = localPackage('connect_four', {
  sourcePath: …,
  publisher,                       // member, not member.provides
});

const openLobby = action('arena.openLobby', {
  consumes: [alice, connectFour],
  body: (ctx) =>
    ctx.signAndExecute(ctx.use(alice), (tx) => {
      const pkg = ctx.use(connectFour);
      tx.moveCall({ target: `${pkg.packageId}::game::create_lobby` });
    }),
});

const w = wallet({ accounts: [alice, bob, publisher] });
```

Note: `ctx.use(memberRef)` replaces `ctx.get(tag.provides)`. The member's resolved-value type is
inferred from the member itself.

**Discoverability:** ★★★★★. Autocomplete on `alice` shows the account-member shape including its
`.provides`, `.consumes`, `.acquire` return type. Jump-to-definition lands on `account('alice')`.
Hover shows the literal tag id `account/alice`.

**Type-safety:** ★★★★★. The factory accepts a typed `StackMember<…account/${Name}…>` parameter;
passing the wrong member (e.g. `localPackage({publisher: connectFour})`) is a TS error at the call
site because `connectFour`'s `.provides` is a `Tag<'package: connect_four', …>` not a
`Tag<'account/${Name}', …>`. The factory's parameter type names the constraint precisely.

**Readability:** ★★★★★. `publisher` reads naturally; the config has zero `.provides` ceremony, zero
magic strings.

**Plugin-author symmetry:** ★★★★★. The plugin author writes `acquireOptions.publisher` knowing they
got a `WalletAccountMember` and yields `ctx.use(opts.publisher)` to read its resolved address. The
mechanism for "I want plugin A's resolved value" is the same whether you're an app author
(`ctx.use(alice)`) or a plugin author writing `redis({…})` (`ctx.use(opts.upstream)`).

**Failure mode:** wrong ref at call site → TS error names the expected member shape and the actual
member's tag id. Missing ref at config level → branded
`__MissingProvidersError<'account/publisher'>` at the `defineDevstack(…)` call (the substrate
already does this).

**Scaling:** Linear. 15 plugins → 15 const bindings, each cross-ref is one binding name. No
collision pressure because each `account(…)`, `localPackage(…)`, etc. binds to a JS variable.

**Substrate cost:** **one substrate change** — the BuildContext's `get(tag)` becomes `use(member)`
(or `get` keeps existing while we add `use`). The current substrate threads
`Consumes extends ReadonlyArray<AnyTag>` because the supervisor's BuildContext walker key on tag
ids. We change three things:

1. `defineNodePlugin`'s `consumes:` accepts `ReadonlyArray<AnyMember | AnyTag>` (members are
   auto-projected to their `.provides`). Internal: project in the factory wrapper, store the tag
   tuple in the StackMember.
2. `BuildContext` gains `use<M extends AnyMember>(m: M): ResolvedOf<M['provides']>`. Implementation:
   `get(m.provides)`. Same lookup, typed against the member's literal tag generic — the
   cast-to-`{get: (t: …) => …}` escape hatch (currently in package/coin/wallet — see
   `reviews/stable-plugins.md` item 3) disappears because the literal generic is preserved from the
   member.
3. The substrate's variadic `Consumes` problem (reduced inside dependent types) is sidestepped: the
   factory's user-facing signature is `consumes: readonly [AliceMember, ConnectFourMember]` and we
   infer per-member at the use site, never reducing through the variadic tuple.

This is a **substrate change** (per the orchestrator's allowance to propose substrate changes for a
better surface) but it's narrow, purely additive (existing `get(tag)` still works), and fixes a
documented type gap.

### B. Tag/witness (current rewrite)

```ts
const alice = account('alice');
const connectFour = localPackage('connect_four', { …, publisher: alice });

const openLobby = action('arena.openLobby', {
  consumes: [alice, connectFour],
  body: (ctx) =>
    ctx.signAndExecute(ctx.get(alice.provides), (tx) => {
      const pkg = ctx.get(connectFour.provides);
      …
    }),
});
```

**Discoverability:** ★★★. The `.provides` field is visible but its name implies "what this plugin
provides" not "the way you reference it from elsewhere". The cognitive model is "member has a tag
inside it; pass the tag to ctx.get".

**Type-safety:** ★★. In practice the variadic `Consumes` reduction breaks (see
`reviews/stable-plugins.md` cross-plugin issue 3) and plugin authors paper it with
`(ctx as { get: (t: typeof …) => … })` casts. Three plugins do this today; every new plugin will hit
it. **That cast is a load-bearing escape hatch the substrate type system can't close without the
change proposed in (A).**

**Readability:** ★★★. `.provides` ceremony at every site. Reads as "reach into the box to get the
address label" — fine once but mechanical.

**Plugin-author symmetry:** ★★. Plugin authors must write the same `.provides` ceremony. Worse, they
must hand-write the variadic `Consumes` reduction (`WalletConsumes<Accounts>`, `ActionConsumes<…>`)
to preserve narrow tag ids — see `plugins/wallet/index.ts:56-59`. That boilerplate is repeated in
every multi-account plugin.

**Failure mode:** wrong tag at acquire → silent type widening to `unknown` at the cast site →
runtime "tag not found" on the ResolvedMap lookup. The error fires deep in the supervisor, not at
the config site.

**Scaling:** Quadratic in cognitive load. Each new cross-plugin ref adds `.provides` to the user's
mental model. Plugin authors paying the type-gymnastics tax compounds.

### C. Context-builder callback (`defineDevstackWith`)

```ts
export default defineDevstackWith({network}, (ctx) => [
  ctx.sui(),
  ctx.account('alice'),
  ctx.account('bob'),
  ctx.localPackage('connect_four', {sourcePath: …, publisher: ctx.refs.account.alice}),
  ctx.action('arena.openLobby', {
    consumes: [ctx.refs.account.alice, ctx.refs.package.connect_four],
    body: (b) => b.signAndExecute(b.use(ctx.refs.account.alice), …),
  }),
  ctx.wallet({accounts: [ctx.refs.account.alice, …]}),
]);
```

**Discoverability:** ★★★★. `ctx.refs.account.alice` autocompletes beautifully — the typed registry
of refs is a navigable namespace.

**Type-safety:** ★★. **The fatal flaw:** `ctx.refs` can only see refs that have already been
produced — within a single array-returning callback, refs declared later in the array are not in
scope earlier (or if they are, via a type-level "forward ref" hack, the ordering discipline is
invisible to the reader). This breaks P4 (errors fire at compose, not later) — forward-ref misuse is
a runtime issue.

**Readability:** ★. The pattern looks like dependency injection but fights JS's lexical-binding
intuition. New users will write `ctx.refs.package.connect_four` before
`ctx.localPackage('connect_four', …)` is in scope and the failure mode is non-obvious.

**Plugin-author symmetry:** ★★★. The plugin author still uses `defineNodePlugin`; they don't see
`ctx` at all, so the surface is asymmetric — app authors learn one model, plugin authors a different
one.

**Failure mode:** forward-ref → either runtime `undefined.address` or a type-system gymnastic that's
hard to explain.

**Scaling:** ★★. The `ctx.refs.<category>.<name>` namespace grows unbounded; with 15 plugins users
navigate a deep tree.

This shape exists today (`defineDevstackWith` for mode-narrowing) and is the right shape _for the
network mode case_ (where the typed-narrow `BuildCtx<Mode>` is a structural projection of the
options). Trying to extend it to the full cross-ref namespace is overreach.

### D. Builder/chain

```ts
export default devstack()
  .sui()
  .account('alice')
  .account('bob')
  .localPackage('connect_four', (b) => ({sourcePath: …, publisher: b.alice}))
  .action('arena.openLobby', (b) => ({
    consumes: [b.alice, b.connect_four],
    body: (ctx) => ctx.signAndExecute(ctx.use(b.alice), …),
  }))
  .wallet((b) => ({accounts: [b.alice, b.bob, b.publisher]}))
  .stackName('arena-rewrite');
```

**Discoverability:** ★★★★. The builder's autocomplete advances through the chain monotonically.

**Type-safety:** ★★★. The builder threads an accumulator type across `this` returns — feasible but
expensive in TS performance. The "refs are members of the builder, accessed via `b.alice`" pattern
re-introduces stringly-typed lookup (the property name `alice` is not a JS binding the IDE can
rename across files).

**Readability:** ★★★. Fluent but indented. For 3-line configs the chain is more line-count than
direct.

**Plugin-author symmetry:** ★. Plugin authors don't write chains; the model splits hard. Worst of
the five.

**Failure mode:** wrong builder access → `b.alic` is a TS error but without rename refactoring.

**Scaling:** ★★★. Works but the `b.<name>` registry has the same unbounded-tree problem as (C).

### E. Hybrid: direct refs default, tag system reserved for plugin-author cross-cutting

This is essentially "(A) for app authors; the tag/witness system is the substrate primitive plugin
authors compose on top of."

The app-author surface IS exactly (A). The plugin-author surface includes `defineTag`,
`defineWitness`, the substrate's `Witness` brand machinery — these stay exposed via the root barrel
(per P2 same name does double duty), but they're not what app authors touch.

The plugin author writing `redis({…})` calls `defineNodePlugin({…, consumes: [], …})` and exports
the `redis` factory. The plugin author writing `coin.witness(pkg, 'MOCK_USDC')` (where `pkg` is a
member, not a tag) gets the exact same direct-ref ergonomics as the app author.

The witness/tag substrate is then a _plugin-author-internal_ mechanism for cross-cutting concerns:
"Walrus REQUIRES a chain identity that any Sui mode provides" expressed as
`requiresWitness('chainIdentity')` / `providesWitness('chainIdentity')` inside the plugin's
resolved-value type. The user never types `requiresWitness` in a config.

### Recommendation: **(E) Hybrid, with (A) as the default surface.**

**Rationale:**

1. **It's the only choice that delivers all of P1–P8.** Direct refs (P1, P3 escape hatch, P4 typed
   errors, P7 the config tells the story); same factory names (P2); root barrel (P5); substrate
   name-blind, surface name-aware (P6 — witnesses are substrate, refs are surface); growth monotonic
   (P8 — adding a plugin adds one binding).

2. **It collapses the three `.provides`-cast escape hatches in coin/package/wallet** (cross-cutting
   issue 3 in `reviews/stable-plugins.md`) into one substrate change. That change is _narrow_
   (BuildContext gains `use(member)` alongside `get(tag)`), _additive_ (`get(tag)` keeps working for
   the substrate itself), and _fixes a documented type gap_ rather than working around it.

3. **The witness/tag layer earns its keep** as the right primitive for cross-cutting plugin concerns
   (composite refusal, fork-mode refusal, the "any Sui-mode plugin satisfies chainIdentity"
   pattern). We don't delete it — we move it down a layer so it stops leaking into user vocabulary.

4. **Discoverability scales with the JS binding model.** `alice`, `bob`, `publisher`, `connectFour`,
   `usdc`, `weth` are JS bindings the IDE renames across files. Power users with 15 plugins compose
   them from helpers (`const { alice, bob } = standardAccounts()`) the same way they'd compose any
   other module's exports.

5. **It generalizes to plugin authors without a model shift.** The redis plugin's `redis(opts)`
   factory accepts a hypothetical `opts.upstream: SuiMember` the same way `localPackage(name, opts)`
   accepts `opts.publisher: AccountMember`. Plugin authors learn the composer; they don't learn a
   separate framework.

The **single substrate change** required (BuildContext.use(member)) is justified against
`reviews/substrate.md`: that file flags `BuildContext<Consumes[number]>.get(tag)` as a type-system
hole the plugins paper over. Closing the hole at the type level is the right direction.

---

## Section 3 — Top-level composer shape

Given (E) chosen, the composer's shape is:

```ts
// Variadic, members first, optional trailing options bag.
export default defineDevstack(
  // Optional auto-mount candidates: any AnyMember (incl. sui()).
  …members,
  // Optional trailing object literal — structurally distinguished by
  // absence of MEMBER_BRAND.
  options?,
);
```

This is **exactly today's shape**. Don't change it. The variadic + trailing-options form satisfies
P3 (aggressive convention: trailing options optional), P5 (one root barrel), P8 (growth monotonic),
and preserves the substrate's compose-time validation (P4).

What changes is what's _legal as a member_ and what's _inferred when absent_:

- Members may be any `StackMember` from any factory (today's rule).
- The composer auto-mounts `sui()` if no `SuiTag`-providing member is in the tuple (a NEW behavior —
  see §4 D1).
- `options.stackName` defaults to `basename(cwd())` (NEW — §4 D2).
- `options.network` defaults to `DEVSTACK_NETWORK` env or `local` (already implicit; document
  explicitly — §4 D3).
- Members are positionally ordered for _readability_ only; the substrate's topological sort handles
  acquire-order (preserved from today).

There is **no** chain form, **no** builder, **no** mandatory callback.

`defineDevstackWith({network}, (b) => […])` stays as the _opt-in_ mode-narrowing surface, retained
for advanced users threading `suiFor.fork.testnet(…)` and similar. It is **not** the primary shape.
Documentation puts `defineDevstack` first, mentions `defineDevstackWith` in an "advanced" section.

### What about the Stack handle?

The composer returns `Stack<Members>` (today's shape). The **runtime-execution methods**
(`.run() / .runMain() / .layer`) the v3 analog `DevstackHandle` carries are a separate concern —
they belong to the **build-integration tier (L5)** because the runtime execution path is what runs a
stack (CLI verb, vite plugin, vitest hook).

`Stack<Members>` is a _static manifest_ the orchestrators consume. Apps that need to
programmatically run a stack import from `@mysten-incubation/devstack/runtime`:

```ts
import { defineDevstack } from '@mysten-incubation/devstack';
import { runStack } from '@mysten-incubation/devstack/runtime';

const stack = defineDevstack(/* … */);
await runStack(stack); // or runStack(stack).runMain()
```

This satisfies P7 (config tells the story; runtime is separate). `devstack.config.ts` files
default-export `Stack<…>`, never a runnable; CLI/TUI/vite/vitest consume the `Stack<…>` via the
import-from-disk mechanism. The `cli/main.ts` binary is the canonical runner.

---

## Section 4 — Defaults & inference catalog

Every auto-mount and every inference, with precedence and failure modes. **Defaults must be
inspectable** (the composer logs the inferred values to the substrate's observability span so the
user can `--verbose` and see what was inferred).

### D1. Auto-mount `sui()` when no SuiTag-providing member

- **Trigger:** any non-`sui()` member's `consumes` includes `SuiTag` (most do).
- **Behavior:** the composer prepends `sui()` to the member tuple before validation.
- **Override:** user passes any sui factory (`sui()`, `suiFor.local(…)`, `suiFor.fork.testnet(…)`);
  composer detects and skips auto-mount.
- **Failure mode:** if a member needs sui and auto-mount is suppressed (via
  `options.disableSuiAutoMount: true`), the substrate's `MissingProviders<'sui'>` fires — branded
  error at the call site.
- **Why:** every example has `const suiPlugin = sui();` as line 1. Ceremonial. The substrate already
  needs SuiTag for chainProbe so the dep edge is universal.

### D2. `stackName` inferred from cwd

- **Source order:** `options.stackName` (explicit) > `process.env.DEVSTACK_STACK_NAME` >
  `basename(process.cwd())`.
- **Override:** trailing options bag `{stackName: 'foo'}`.
- **Failure mode:** `basename(cwd())` returns a non-identifier-ish string (whitespace, slashes,
  etc.) → composer normalizes via `stackName()` brand constructor, which validates (already does
  today) and dies with a typed `InvalidStackNameError<'<inferred-name>'>` if invalid. The user is
  then forced to set `stackName` explicitly. Visible compile-time error (the brand validates at
  construction).

### D3. Network from env

- **Source order:** `options.network` (explicit) > `process.env.DEVSTACK_NETWORK` > `'local'`.
- **Override:** trailing `{network: {…}}` OR a `suiFor.live.testnet(…)` member that pins network at
  factory time.
- **Failure mode:** `DEVSTACK_NETWORK=mainnet` while user composes `walrus({local: {…}})` →
  composite refusal at compose (see §7). Branded typed error.

### D4. Default account variant: ephemeral-funded

- `account('alice')` is identical to `account('alice', {kind: 'ephemeral-funded'})` (already true
  today).
- The discriminated union remains; the bare form is the documented default for getting-started
  examples.

### D5. Publisher inferred when stack has exactly one account

- **Trigger:** `localPackage('hello', {sourcePath: …})` with no `publisher` field, AND
  `defineDevstack(…)` contains exactly one account member.
- **Behavior:** composer inserts the lone account as publisher.
- **Override:** `localPackage('hello', {sourcePath: …, publisher: alice})`.
- **Failure mode:** if zero accounts: branded
  `PublisherInferenceFailed<'hello', 'no accounts in stack'>`. If 2+ accounts: branded
  `PublisherInferenceFailed<'hello', 'ambiguous: alice | bob'>`.
- **Why:** the hello-world / fork-greeting examples all have one publisher; the explicit field is
  ceremonial when there's only one candidate.
- **Substrate cost:** none — composer-level inference, runs at `defineDevstack(…)` and rewrites the
  member's `consumes` tuple.

### D6. Wallet accounts: opt-in or "all of them"

- `wallet({accounts: 'all'})` becomes a typed shorthand for "every account member in the stack". The
  composer expands at compose time. Default if `accounts:` is omitted entirely and the stack has ≥1
  account: same as `'all'`.
- **Override:** explicit `accounts: [alice, bob]` (today's form).
- **Failure mode:** stack has zero accounts → typed `WalletAccountsEmpty` at compose.
- **Why:** the dev-wallet typically wants every account the stack has; needing to repeat the list is
  monotony.

### D7. allowedOrigins inferred from stack identity + vite port

- The wallet's `allowedOrigins` defaults to
  `['http://dev.<stackName>.localhost:<vitePort>', 'http://localhost:<vitePort>']` when a
  vite-build-integration member is present in the same stack.
- `allowLocalhostVite: true` opt-in for headless test runners (today's shape).
- **Override:** explicit `allowedOrigins: […]`.
- **Why:** every config today hand-rolls this string; it's derivable.

### D8. Coin auto-discovery

- `localPackage('mock_usdc', …)` whose publish receipt contains `coin::create_currency<W>` calls
  populates `pkg.coins[symbol]` on the resolved value (today's deferred behavior, distilled-doc
  P12).
- `coin.witness(pkg, 'WITNESS')` is then **optional** — if a downstream plugin (action body) wants
  `pkg.coins.mUSDC.treasuryCapId` directly, it can. The `coin.witness(…)` factory is reserved for "I
  want this coin to appear as a distinct stack member with its own tag id" (e.g. deepbook pools
  reference coins as members, not as fields of a package).
- **Failure mode:** package has no coins → `pkg.coins` is `{}`, `pkg.coins.X` is `undefined`. TS
  surfaces this if `coins` is typed `Record<string, CoinRecord | undefined>`.

---

## Section 5 — Subpath strategy

### Root barrel (`@mysten-incubation/devstack`) exports:

**For app authors (most users):**

- `defineDevstack`, `defineDevstackWith`
- Every plugin factory: `sui`, `suiFor`, `account`, `localPackage`, `knownPackage`, `coin` (the
  four-form namespace), `action`, `wallet`, `walrus`, `walrusFor`, `seal`, `sealFor`, `postgres`,
  `deepbook`, `faucet`, `requestFunds`
- Branded primitives plugin factories need at call sites: `chainId`, `endpointKey`, `appName`,
  `stackName`, `pluginKey`, `contentHash` — plus their `Brand` types.
- Reusable constants: `USDC_MARGIN_DEFAULTS`, `SUI_MARGIN_DEFAULTS`, `DEFAULT_POOL_RISK_CONFIG`,
  `SUI_PRICE_FEED_ID`, `USDC_PRICE_FEED_ID`, `DEEP_PRICE_FEED_ID`.

**For plugin authors (same barrel — P2):**

- `defineNodePlugin`, `defineTag`, `defineWitness`
- `capabilities`, `capabilityBuilder`
- `defineModeNamespace`, `forNetwork`
- `MEMBER_BRAND`, type-only: `AnyMember`, `StackMember`, `AnyTag`, `Tag`, `ResolvedOf`, `TagIdOf`,
  `BuildContext`, `AcquireContext`, `CapabilitiesFactory`, `MissingProviders`, `WatchDecl`
- Every capability decl type: `CapabilityDecl`, `CodegenableDecl`, `SnapshotableDecl`,
  `RoutableDecl`, `RoutableHttpDecl`, `RoutableTcpDecl`, `StrategyContributorDecl`,
  `LifenessClassifierDecl`, `CompositePrimitiveDecl`, `DispatchId`, `RoutableUpstream`,
  `ContainerLabelTuple`
- Lifecycle primitives: `LifecycleFact`, `LifecycleStatus`, `PluginKind`, `RebootCost`,
  `PhaseNarration`
- Lifted-sibling primitives: `litHash`, `litSiblingKey`, `LitHash`, `LitSiblingKey`,
  `LiftedSiblingKey`, `SiblingScope`
- Network: `NetworkConfig`, `NetworkMode`, `DefaultNetwork`, `DevstackOptions`, `OptionsLike`

### Subpaths (existing, for tree-shaking and isolation):

- `/runtime` — `runStack`, `Stack` (re-exported), the orchestrator entry the CLI/vitest/vite use to
  actually boot.
- `/vite`, `/playwright`, `/vitest` — build-integration presets.
- `/contracts` — the nine capability contract type-only barrels (for plugin authors who want to
  import a single contract without pulling the rest). Today's shape; keep.
- `/substrate` — kept for orchestrator-internal access; plugin authors should NOT need this if the
  root barrel is complete.
- `/samples` — sample types used by plugin-author tutorials.

### Subpaths that disappear:

`/plugins/sui`, `/plugins/account`, `/plugins/package`, … — **delete these subpath exports**. They
become internal modules under `src/plugins/…` only. Tree-shaking happens at the bundler level off
the root barrel (the package is `sideEffects: false` already).

**Why delete:** the api-comparison's #1 friction point is 4-8 import lines per config. The cause is
the subpath surface. Removing it collapses every config's import block to one line. Bundler tree-
shaking handles unused plugins (today's `sideEffects: false` already enables this).

**Cost of deletion:** the root barrel grows from ~50 to ~120 named exports. Acceptable — TS imports
are O(1) at parse time; the surface size is a function of vocabulary, not bundle size.

**Migration:** delete the subpath entries in `package.json` → `exports`. Anyone (orchestrator code,
build integrations) that imports from `/plugins/…` either gets the same factory from the root barrel
or moves their import to a `/runtime` subpath if they need internal plumbing.

---

## Section 6 — Plugin-author surface

The plugin-author surface is the SAME barrel as the app-author surface, plus three extra concepts:
`defineNodePlugin`, `defineTag`, `defineWitness`. That's the entire framework.

### What `defineNodePlugin` accepts:

```ts
defineNodePlugin({
  provides: tag,                  // Tag<id, Resolved>
  consumes: [member, member, …],  // MEMBERS or tags — both legal
  kind: 'leaf-long-running',
  rebootCost: 'cheap',
  watch?: {paths: [...], cascade?},
  acquire: (ctx) => Effect.gen(function* () {
    const upstream = ctx.use(member);  // or ctx.get(tag)
    …
    return resolvedValue;
  }),
  capabilities: capabilities(…), // or (resolved, ctx) => capabilities(…)
})
```

The key change: **`consumes` accepts members directly**. The factory wrapper projects to `.provides`
internally. This is the same hybrid recommended in §2: the cast-as-escape-hatch in
coin/package/wallet (`reviews/stable-plugins.md` cross-cut #3) disappears because `ctx.use(member)`
is typed against the member's literal tag generic, not against a reduced variadic.

### Capability decls in factory return vs. separate object:

Status quo (capability declarations live in the StackMember's `capabilities:` field, optionally a
function of (resolved, ctx)) is correct and works. Don't change the shape. The dynamic-factory form
(`capabilities: (resolved, ctx) => capabilities(…)`) is the one that matters for OCA-emitted
artifacts where decls need the real packageId.

### Writing a Walrus-equivalent (stripped example):

```ts
// my-walrus-plugin.ts
import {
	defineNodePlugin,
	defineTag,
	defineWitness,
	capabilities,
	requiresWitness,
	type StackMember,
	type SnapshotableDecl,
	type RoutableDecl,
} from '@mysten-incubation/devstack';
import { Effect } from 'effect';

const ChainIdentity = defineWitness('chainIdentity');

export const myWalrus = (opts: { nodeCount: number; sui: SuiMember }) => {
	const tag = defineTag<'my-walrus', { url: string }>('my-walrus', 'my-walrus');
	return defineNodePlugin({
		provides: tag,
		consumes: [opts.sui] as const, // member, not tag
		kind: 'leaf-long-running',
		rebootCost: 'heavy',
		acquire: (ctx) =>
			Effect.gen(function* () {
				const sui = ctx.use(opts.sui); // typed: ResolvedOf<SuiTag>
				// … bring up cluster, dial sui.chain, etc.
				return { url: `walrus://node-${opts.nodeCount}` };
			}),
		capabilities: (resolved) =>
			capabilities(makeSnapshotable(/* … */), makeRoutable(resolved.url /* … */)),
	});
};
```

The user uses it:

```ts
const suiPlugin = sui();
const walrus = myWalrus({ nodeCount: 4, sui: suiPlugin });
export default defineDevstack(suiPlugin, walrus);
```

This is **symmetric** with how `localPackage(name, {publisher: aliceMember})` works. The plugin
author treats `opts.sui` exactly as the app author treats `opts.publisher`. P2 is delivered.

### What stays at the substrate layer (plugin-author concerns only):

- `requiresWitness('chainIdentity')` / `providesWitness('chainIdentity')` — phantom-typed brand on
  the resolved-value type, picked up by the `UnsatisfiedWitnesses` check at compose. Authors of
  cross-cutting plugins (walrus needs _any_ sui mode; the witness machinery is how the type system
  says that) reach for this. App authors never do.
- `liftedSiblings` — composite-children dedup keys. Author concern. Not surfaced in user docs.
- The capability sink registry — to be lifted out of supervisor.ts (per substrate review item
  "supervisor.ts imports five contracts modules by name"), but that's substrate-internal.

---

## Section 7 — Composite refusal at the config site

The architecture's "compose-time refusal" claim is one of the rewrite's strongest properties. The
surface design must preserve it and make it **legible at the config site**.

### Today's working example (preserved):

```ts
const fork = suiFor.fork.testnet({…});
seal.for(fork.network).localKeygen({…});  // ✓
seal.for(fork.network).key                // ← compile error: property doesn't exist
```

`seal.for(network)` returns the `FactoriesFor<…, network['mode']>` narrowing. Properties that aren't
valid for that mode are simply not on the returned object. The IDE's autocomplete refuses to suggest
them; an explicit access is a TS error naming the missing property.

### Extension: composite-name refusal at the config site

When the user types `walrus({local: {…}})` against a fork-mode sui, they get a compile error. The
mechanism: `walrus`'s factory takes an optional `sui:` member, defaulting to "infer from stack". The
type of the inferred member is checked against the requested mode at the factory's `consumes` site,
and refused with a branded error type:

```ts
walrus({local: {…}, sui: forkSui})
// → __IncompatibleCompositeError<'walrus.local', 'sui.fork'>
```

The IDE shows the brand string at the parameter site, so the user reads "walrus.local cannot compose
with sui.fork" not "type X is not assignable to type Y".

This pattern generalizes: any plugin with a mode-narrowing surface declares the legal upstream modes
via a type-level `AcceptedUpstreamModes` constraint; the factory's parameter type refuses
incompatible upstream members.

### Discovering what's allowed without trial-and-error

The mode-narrowed factory namespaces (`suiFor`, `walrusFor`, `sealFor`) serve double duty: their
object shape _is_ the table of "what's available in each mode". Autocomplete on `walrusFor.fork.` is
the answer to "what walrus surfaces work against a fork sui?".

For composites, the typed `defineCompositeOptions<MyComposite>({…})` helper (not yet implemented;
documented as a future seam) constrains the option type so that a user typing
`walrus({local: {seedAccounts: [alice], …}})` against a fork sui can't even get the option through
the type checker — it's the parameter type, not just the eventual `consumes` check.

---

## Section 8 — Worked examples

All examples assume the (A)+§4 inference rules: single root barrel, direct refs, `sui()`
auto-mounted, `stackName` from cwd.

### Example 1 — hello-world (the absolute minimum)

```ts
import { defineDevstack, account } from '@mysten-incubation/devstack';

const alice = account('alice');
const bob = account('bob');

export default defineDevstack(alice, bob);
```

**Three lines**. (Compare today's 21.) `sui()` auto-mounts; `stackName` from cwd. The first-time
user has zero plugin-subpath imports to learn.

### Example 2 — token-studio

```ts
import { defineDevstack, account, localPackage, wallet } from '@mysten-incubation/devstack';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const alice = account('alice');
const bob = account('bob');
const carol = account('carol');

const studio = localPackage('managed_coin', {
	sourcePath: resolve(HERE, 'move/managed_coin'),
	// publisher: alice  // inferred — single account candidate? no — three accounts; explicit required:
	publisher: alice,
});

export default defineDevstack(alice, bob, carol, studio, wallet({ accounts: 'all' }));
```

**~16 lines.** (Compare today's 47.) One import line; `accounts: 'all'` captures every account in
the stack.

Commentary: `wallet({accounts: 'all'})` is the §4 D6 inference. The `publisher: alice` is required
because §4 D5 only infers when there's exactly one account candidate.

### Example 3 — arena (action + signers + packages)

```ts
import { defineDevstack, account, localPackage, action, wallet } from '@mysten-incubation/devstack';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const publisher = account('publisher');
const alice = account('alice');
const bob = account('bob');

const connectFour = localPackage('connect_four', {
	sourcePath: resolve(HERE, 'move/connect_four'),
	publisher,
});

const openLobby = action('arena.openLobby', {
	consumes: [alice, connectFour],
	body: (ctx) =>
		ctx.signAndExecute(ctx.use(alice), (tx) => {
			const pkg = ctx.use(connectFour);
			tx.moveCall({ target: `${pkg.packageId}::game::create_lobby` });
		}),
});

export default defineDevstack(
	publisher,
	alice,
	bob,
	connectFour,
	openLobby,
	wallet({ accounts: 'all' }),
);
```

**~26 lines.** (Compare today's 254 — but today's count includes 160 lines of hand-rolled SDK
boilerplate; the action plugin now provides `signAndExecute`.)

Commentary: `ctx.use(alice)` typed-against the alice member's literal
`Tag<'account/alice', AccountValue>`. No `.provides` ceremony. No `(ctx as {…}).get(…)` cast.
Composite refusal can fire if a later add (e.g. `seal()`) wants a non-local-keygen mode against this
local sui.

### Example 4 — private-content (composite: walrus + seal + sui local)

```ts
import {
	defineDevstack,
	account,
	localPackage,
	wallet,
	walrus,
	seal,
} from '@mysten-incubation/devstack';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const publisher = account('publisher');
const alice = account('alice');
const bob = account('bob');

const vault = localPackage('vault', {
	sourcePath: resolve(HERE, 'move/vault'),
	publisher,
});

export default defineDevstack(
	publisher,
	alice,
	bob,
	walrus({ local: { nodeCount: 4, seedAccounts: [publisher, alice, bob] } }),
	seal({ mode: 'local-keygen', signer: publisher }), // ref, not magic string
	vault,
	wallet({ accounts: 'all' }),
);
```

**~17 lines.** (Compare today's 102.)

Commentary: `seal({signer: publisher})` accepts the account member directly (S7 from
api-comparison). `walrus({local: {seedAccounts: […]}})` restores the declarative WAL grants (S8 from
api-comparison). The composite refusal fires here if any of: walrus is asked for fork mode
(composite refusal at `walrus.for(network).fork` — property doesn't exist), or seal's mode is
unsupported against the inferred sui mode.

### Example 5 — deepbook-full (composite + multi-plugin)

```ts
import {
	defineDevstack,
	account,
	localPackage,
	postgres,
	wallet,
	deepbook,
	USDC_MARGIN_DEFAULTS,
	SUI_MARGIN_DEFAULTS,
	DEFAULT_POOL_RISK_CONFIG,
	SUI_PRICE_FEED_ID,
	USDC_PRICE_FEED_ID,
	DEEP_PRICE_FEED_ID,
} from '@mysten-incubation/devstack';

const publisher = account('publisher');
const pythPusher = account('pyth-pusher');
const marketMaker = account('market-maker');
const alice = account('alice');
const bob = account('bob');

const pg = postgres({ databases: ['deepbook'] }); // 'devstack' is implicit; name 'postgres' is default

const dex = deepbook({
	mode: 'local',
	publisher, // ref
	pools: [
		{
			name: 'deep_sui',
			base: 'DEEP',
			quote: 'SUI',
			tickSize: 1_000n,
			lotSize: 100_000_000n,
			minSize: 1_000_000_000n,
		},
		{
			name: 'sui_usdc',
			base: 'SUI',
			quote: 'USDC',
			tickSize: 1_000n,
			lotSize: 100_000_000n,
			minSize: 1_000_000_000n,
		},
	],
	pyth: {
		pusher: pythPusher, // ref
		feeds: [
			{ symbol: 'SUI', feedId: SUI_PRICE_FEED_ID, initialPrice: 350_000_000n },
			{ symbol: 'DEEP', feedId: DEEP_PRICE_FEED_ID, initialPrice: 10_000_000n },
			{ symbol: 'USDC', feedId: USDC_PRICE_FEED_ID, initialPrice: 100_000_000n },
		],
	},
	margin: {
		assets: [USDC_MARGIN_DEFAULTS, SUI_MARGIN_DEFAULTS],
		pools: [{ pool: 'sui_usdc', risk: DEFAULT_POOL_RISK_CONFIG }],
	},
	marketMaker: {
		signer: marketMaker,
		strategy: { kind: 'bps', spreadBps: 10, levelSpacingBps: 100, levels: 3 },
	},
	postgres: pg, // ref
});

export default defineDevstack(
	publisher,
	pythPusher,
	marketMaker,
	alice,
	bob,
	pg,
	dex,
	wallet({ accounts: 'all' }),
);
```

**~30 lines.** (Compare today's 225.)

Commentary: deepbook is the canonical composite. `USDC_MARGIN_DEFAULTS` re-exported from the root
barrel (S6). `priceSpec(…)` helper folded into `initialPrice` field. Pool `base`/`quote` accept
symbol strings that the deepbook plugin resolves to coin records via its internal registry (using
witness from packages it composes). `pythPusher` and `marketMaker` are member refs threaded through
opts.

### Example 6 — plugin author (custom Redis plugin)

```ts
// redis-plugin.ts
import {
	defineNodePlugin,
	defineTag,
	capabilities,
	type RoutableDecl,
} from '@mysten-incubation/devstack';
import { Effect } from 'effect';

export interface RedisOptions {
	readonly maxMemory?: string;
	readonly name?: string;
	readonly route?: boolean;
}

export interface RedisHandle {
	readonly url: string;
	readonly networkAlias: string;
}

const makeTag = <N extends string>(name: N) =>
	defineTag<`redis/${N}`, RedisHandle>(`redis/${name}`, 'redis');

export const redis = <const N extends string = 'redis'>(opts: RedisOptions & { name?: N } = {}) => {
	const name = (opts.name ?? 'redis') as N;
	const tag = makeTag(name);

	const routable: RoutableDecl | null = opts.route
		? {
				kind: 'routable',
				endpointName: 'redis-tcp',
				dispatchId: { compositeKey: `redis.${name}`, role: name },
				upstream: { type: 'container', containerKey: `${name}-container` },
				wireProtocol: 'tcp',
			}
		: null;

	return defineNodePlugin({
		provides: tag,
		consumes: [] as const,
		kind: 'leaf-long-running',
		rebootCost: 'cheap',
		acquire: () =>
			Effect.succeed({
				url: `redis://${name}:6379`,
				networkAlias: name,
			} satisfies RedisHandle),
		capabilities: routable === null ? capabilities() : capabilities(routable),
	});
};
```

```ts
// devstack.config.ts
import { defineDevstack } from '@mysten-incubation/devstack';
import { redis } from './redis-plugin.ts';

export default defineDevstack(redis({ route: true }));
```

Commentary: the plugin file is **65 lines** of which ~25 are types and ~25 are implementation.
Compared to today's 170-line redis-plugin file, the bulk of the savings comes from (a) typed-tag
construction in one place (`defineTag` plus the per-instance template), (b) no `ctx.get(SuiTag)`
cast (this plugin has no upstream), (c) cleaner RoutableDecl. The capability shape is unchanged.

The two-line user config:

```ts
import { defineDevstack } from '@mysten-incubation/devstack';
import { redis } from './redis-plugin.ts';
export default defineDevstack(redis({ route: true }));
```

### Example 7 — power user (5 stacks composed across files)

```ts
// shared/accounts.ts
import { account } from '@mysten-incubation/devstack';
export const standardAccounts = () => ({
	publisher: account('publisher'),
	alice: account('alice'),
	bob: account('bob'),
});

// shared/coins.ts
import { localPackage, coin } from '@mysten-incubation/devstack';
import type { AccountMember } from '@mysten-incubation/devstack';
export const mockCoins = (
	publisher: AccountMember<'publisher'>,
	sourcePathFor: (n: string) => string,
) => {
	const usdc = localPackage('mock_usdc', { sourcePath: sourcePathFor('mock_usdc'), publisher });
	const weth = localPackage('mock_weth', { sourcePath: sourcePathFor('mock_weth'), publisher });
	return {
		usdc,
		weth,
		mUSDC: coin.witness(usdc, 'MOCK_USDC'),
		mWETH: coin.witness(weth, 'MOCK_WETH'),
	};
};

// per-app devstack.config.ts
import { defineDevstack, wallet, action } from '@mysten-incubation/devstack';
import { standardAccounts } from './shared/accounts.ts';
import { mockCoins } from './shared/coins.ts';
import { sourcePathFor } from './paths.ts';

const { publisher, alice, bob } = standardAccounts();
const { usdc, weth, mUSDC, mWETH } = mockCoins(publisher, sourcePathFor);

const seedTokens = action('wallet.seedTokens', {
	consumes: [usdc, weth, publisher, alice, bob],
	body: (ctx) =>
		ctx.signAndExecute(ctx.use(publisher), (tx) => {
			const usdcPkg = ctx.use(usdc);
			const wethPkg = ctx.use(weth);
			// … per-coin mint loop using pkg.coins[symbol].treasuryCapId (D8)
		}),
});

export default defineDevstack(
	publisher,
	alice,
	bob,
	usdc,
	weth,
	mUSDC,
	mWETH,
	seedTokens,
	wallet({ accounts: 'all' }),
);
```

Commentary: the cross-file composition works because **members are JS values**. `standardAccounts()`
returns a typed object whose property types preserve each account's literal name. A second app's
devstack.config.ts imports the same `standardAccounts` and gets the same typed members — but each
call to `standardAccounts()` produces fresh members with fresh per-instance tag ids (the literal
`'alice'` is folded into the tag id at factory time; per-call accounts are distinct members under
the same name).

The `AccountMember<'publisher'>` type is a re-export from the root barrel — power users typed shared
helpers against it.

---

## Section 9 — Tradeoffs & open questions

### Things this design does NOT solve:

1. **Cross-process programmatic API.** What does a vite plugin (in another process) consuming the
   manifest emitted by a running stack look like? Today the manifest path is the contract. This is
   L5 territory and out of scope for this doc, but the L4 → L5 boundary should be cleanly drawn
   elsewhere.

2. **Watching the config file.** When the user edits `devstack.config.ts` itself (not a Move source,
   the config file), how does the supervisor know to re-execute and recompose? The watch declaration
   on each plugin handles its OWN source watches; the config-file watch is supervisor-level. Should
   the composer participate? Open.

3. **Multi-stack composition (one process, two stacks).** The parallel-stack model is
   one-process-per-stack today. Composing two `Stack<…>` values into one runtime is undefined — and
   arguably shouldn't be a first-class case (use two processes; that's the parallel-stack design).

4. **`coin` factory's symbol-form publisher inference.** Today `coin.local('mUSDC')` has no dep edge
   to the publisher (Pain Point #4 in `13-coin.md`). The witness form
   (`coin.witness(pkg, 'WITNESS')`) is preferred. Should the composer warn (or refuse) on bare
   `coin.local(...)` when a publishing package is in the stack? Inference might do more harm than
   good here — leave as-is, document.

### Open questions for the user (top 3):

1. **Subpath deletion timing.** §5 proposes deleting `/plugins/<name>` exports in favor of one root
   barrel. This touches every example config and every build-integration import. Acceptable in one
   shot, or phase over a few PRs?

2. **Substrate change `BuildContext.use(member)`.** §2 recommends a narrow additive substrate change
   to close the cast-as-escape-hatch gap. Confirm the substrate is fair game (per the orchestrator's
   "allowed to propose substrate changes" guidance).

3. **Inference precedence: env vs. cwd.** §4 D2/D3 propose `options > env > cwd`. Some teams have
   multiple stacks in one repo sharing one cwd — they'd want env to dominate over cwd. Default
   precedence good as proposed, or invert env > cwd > options-default? (Pretty sure options > env >
   cwd is right but worth flagging.)

---

## Section 10 — Migration plan (high level)

A single deliverable can land this design behind one PR, organized into ~6 conceptual diff zones.
The substrate change is the only one that touches the kernel; the rest is composer + plugin
barrels + example configs.

### Step 1 — substrate (`src/substrate/plugin.ts`)

- Add `use<M extends AnyMember>(m: M): ResolvedOf<M['provides']>` to `BuildContext`. Existing
  `get(tag)` stays.
- The supervisor's BuildContext walker projects `use(m)` → `get(m.provides)` at the impl level (one
  line). The type-level win is the `M extends AnyMember` constraint preserves the literal generic
  where `Consumes[number]` reduction does not.

### Step 2 — composer (`src/api/define-devstack.ts`)

- Add §4 D1 auto-mount logic: detect any member whose `consumes` contains `SuiTag`, prepend `sui()`
  if no SuiTag-provider present.
- Add §4 D2 cwd-based `stackName` inference (uses Effect `FileSystem` / `Process` services).
- Add §4 D6 `accounts: 'all'` expansion for wallet (composer rewrites the member's options when
  serializing).
- Add §4 D5 publisher inference for `localPackage` when stack has exactly one account.
- Inference results emit observability span attributes (`devstack.composer.inferred.*`) for
  `--verbose` introspection.

### Step 3 — plugin barrels

- Each plugin's factory's `consumes:` type becomes `ReadonlyArray<AnyMember | AnyTag>`. Internal:
  project to tags in the factory wrapper.
- Update plugins-that-cast (`package`, `coin`, `wallet`, `action`) to use `ctx.use(member)` —
  deletes the four `(ctx as { get: … }).get(…)` cast sites.
- `seal({signer})` accepts `AccountMember` (delete the magic-string variant).
- `walrus({local: {seedAccounts: […]}})` restored.
- `coin.witness(pkg, witness)` accepts package MEMBER (not `pkg.provides`).
- Re-export `USDC_MARGIN_DEFAULTS` / `SUI_MARGIN_DEFAULTS` / `DEFAULT_POOL_RISK_CONFIG` from
  deepbook plugin barrel (then the root).

### Step 4 — root barrel (`src/index.ts`)

- Expand to ~120 named exports per §5.
- Delete `package.json` `/plugins/<name>` entries.

### Step 5 — runtime subpath (`src/runtime/index.ts`)

- New: `runStack`, `runStackProgrammatic`, `Stack` re-export. CLI/vite/vitest use this.

### Step 6 — example configs

- Rewrite each existing `*-rewrite/devstack.config.ts` to the §8 shape. Net loss of ~50% LOC across
  the 11 examples.

### Step 7 — docs (no migration guide — devstack is pre-release)

- The README / getting-started uses §8 Example 1 as the literal first code block.

### Net surface diff

- **Lines of user-facing code in example configs:** down ~60% in aggregate (estimated from §8 line
  counts vs. today's).
- **Number of plugin barrel files imported per typical config:** down from 4–8 to 1.
- **Number of `.provides` references in user code:** zero.
- **Number of `ctx.get(tag.provides)` ceremonies:** zero (replaced by `ctx.use(member)`).
- **Number of magic-string identity references (e.g. `accountName: 'publisher'`):** zero.
- **Number of `as never` / `as any` casts in example configs:** zero.
- **Substrate impact:** one new method on BuildContext, no kernel rewrite, no contract changes,
  capability-decl model unchanged.

---

## Appendix A — Decisions cross-referenced to principles

| Decision                                      | P1  | P2  | P3  | P4  | P5  | P6  | P7  | P8  |
| --------------------------------------------- | --- | --- | --- | --- | --- | --- | --- | --- |
| Direct member refs (§2.A)                     | ✓   | ✓   | –   | ✓   | –   | –   | –   | ✓   |
| One root barrel (§5)                          | –   | ✓   | –   | –   | ✓   | –   | –   | ✓   |
| Auto-mount sui() (§4 D1)                      | –   | –   | ✓   | ✓   | –   | ✓   | –   | –   |
| stackName from cwd (§4 D2)                    | –   | –   | ✓   | ✓   | –   | –   | –   | –   |
| accounts: 'all' (§4 D6)                       | –   | –   | ✓   | ✓   | –   | –   | –   | ✓   |
| Publisher inference (§4 D5)                   | –   | –   | ✓   | ✓   | –   | –   | –   | ✓   |
| Witness reserved for plugin-author (§2.E)     | –   | –   | –   | –   | –   | ✓   | –   | –   |
| Stack handle stripped of runtime methods (§3) | –   | –   | –   | –   | ✓   | –   | ✓   | –   |
| `BuildContext.use(member)` (§2.E)             | ✓   | ✓   | –   | ✓   | –   | ✓   | –   | –   |
| Composite refusal at config site (§7)         | –   | –   | –   | ✓   | –   | ✓   | –   | –   |

Every column has at least one row delivering it. P5 (one root barrel), P3 (aggressive convention)
and P4 (errors at compose) are most heavily relied upon.

---

## Appendix B — Things explicitly NOT changed

- The 5-layer architecture (L0 substrate / L1 runtime adapters / L2 plugins / L3 orchestrators / L4
  user surfaces / L5 build-integration consumers). The composer remains at L4; substrate stays
  name-blind; capability decls remain the kernel's plugin-discovery vocabulary.
- The 9 capability contracts. The user surface doesn't reach for them directly; plugin authors emit
  them via `capabilities(…)`.
- Composite refusal as the type-system primitive. Extended to the config site (§7) but not weakened.
- The OCA primitive. Unchanged.
- The variadic-with-trailing-options shape of `defineDevstack`. Kept exactly.
- The `defineNodePlugin` / `defineTag` / `defineWitness` triad. Kept exactly. (`defineWitness` is
  plugin-author-internal but stays in the root barrel per P2.)
- The mode-narrowed factory namespace pattern (`suiFor`, `walrusFor`, `sealFor`). Kept exactly.
  Composite refusal sits on top of it.
- The branded structured error pattern (`__MissingProvidersError`, `__SiblingHashConflictError`,
  `__UnsatisfiedWitnessesError`). Kept and extended (`__IncompatibleCompositeError`,
  `__PublisherInferenceFailed`).

---

## Appendix C — Opportunities noticed (per the standing report-back rule)

- **`per-stack-registries/{coin,package}.ts` lift to L2.** The substrate review flags this as a
  name-leak. The API surface redesign is the natural moment to lift them, because the composer now
  owns "what plugins are present" knowledge. No surface impact; pure substrate-layer cleanup.
- **`OnChainArtifactPublisher` rename.** Substrate-review item. Either rename to
  "artifact-publisher" (drop "on-chain") or move to L2. Neutral from the surface; worth doing in the
  same PR sweep.
- **`Endpoint` projection slice needs `pluginKey`.** Substrate-review open. Touches the projection's
  `Endpoint` shape but the user surface doesn't observe it directly.
- **`CrossProcessLock` flock Layer.** Substrate-review item; release blocker per `substrate.md`. Not
  surface but should land in the same release window.
- **Stack handle's `_providedIds` phantom**: today unused by anything; may be safe to delete and
  rely on `members` directly. Investigate before §6 changes.
- **`AccountMember<Name>` type export**: the §8 power-user example assumes this. Today the surface
  exports `WalletAccountMember` and the per-plugin variants but no generic `AccountMember<Name>`.
  Add to the root barrel as part of §6.
- **`postgres({name})` vs other plugins**: per api-comparison cross-cut #16, the name knob is
  exposed inconsistently. Recommend: every per-instance plugin takes `name` as the first positional
  arg (account, package, coin); every singleton plugin doesn't expose it (sui, wallet); deepbook
  composite stays per-instance with `name` in opts (because deepbook may legitimately be
  multi-instance). Postgres becomes `postgres('postgres', {databases: …})` for consistency,
  defaulting the first arg.
- **Action body return type**: today returns
  `Effect.Effect<ActionReceipt, ActionError, Scope.Scope>`. The ergonomics of having to know about
  `Scope.Scope` at the user surface is wrong; the scope should be ambient via the supervisor's
  Layer. Lift the constraint to substrate-context.
- **`isProduction` env-flip pattern (effect-app-rewrite)**: the
  `account('alice', {kind: 'env', key: 'ALICE_PRIVATE_KEY'})` variant is the right shape per the
  example's own TODO. Land it; no surface redesign needed beyond exposing the discriminator.
