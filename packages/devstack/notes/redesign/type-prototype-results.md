# devstack type-prototype results

Prototype location: `/tmp/devstack-type-prototype/` Run:
`npx tsc --noEmit -p /tmp/devstack-type-prototype/tsconfig.json` TypeScript: 5.9.3 (from this repo's
`node_modules`)

## Summary

| Scenario                            | Pass / Partial / Fail  | One-liner                                                                                                                                       |
| ----------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A — variadic + trailing options     | **Pass**               | Members in any order; options bag detected structurally; missing fields error.                                                                  |
| B — tag/provide typed flow          | **Pass**               | Typed `ctx.get(tag)`; missing-provider error via `AssertNoMissing<Members>` type-level scan.                                                    |
| C — composite mode discriminator    | **Pass**               | Mode-keyed factory namespaces narrow correctly; cross-plugin phantom witnesses unify at stack level.                                            |
| C2 — network threading via callback | **Pass** (with caveat) | Callback-form `defineDevstack({network}, ns => [...])` narrows nicely, but it conflicts with the flat variadic in Scenario A.                   |
| D — lifted-sibling dedup            | **Pass**               | Same `(plugin, kind, scope)` + different `inputHash` literal flagged by union-to-intersection trick.                                            |
| E — multi-capability composition    | **Pass** (with caveat) | 4-capability member compiles; codegen-emitted shape flows to consumer **but only because** the third `Caps` generic was added to `StackMember`. |
| F — renderer projection             | **Pass**               | `title` / `primary` / `extras` are NOT keys of `Row` or `SubscribableState`; renderers compute display vocab in their own derived type.         |
| G — ergonomics                      | **Pass**               | 5-line minimal config and 20-line complex config both compile.                                                                                  |

All 18 `@ts-expect-error` directives verified to mark real errors (toggling them on shows 18 fresh
`error TS…` lines, with `exit=0` when restored).

## TypeScript techniques used

| Technique                                                        | Where                                                                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Branded primitives** (`Brand<T, B>` via `unique symbol`)       | `PluginKey`, `ContentHash`, `ChainId`, `LitHash`                                                                                                       |
| **Phantom-typed marker fields**                                  | `Tag._resolved`, `Witness._witness`, `CodegenableDecl._emitted`                                                                                        |
| **Covariant phantom (thunk-returning)** instead of `(x: T) => T` | Fixed Scenario A/E variance failures; the `(x: T) => T` form is contravariant on `T` and breaks `Tag<'x', narrow>` flowing into `Tag<string, unknown>` |
| **`MEMBER_BRAND` discriminator** for variadic                    | Distinguishes members from options structurally                                                                                                        |
| **Variadic tuple types**                                         | `devstack<Args extends ReadonlyArray<AnyMember \| OptionsLike>>(...args: Args)`                                                                        |
| **Tuple slicing via `infer` rest**                               | `Last<T>`, `Init<T>` to peel trailing options at the type level                                                                                        |
| **Mapped object indexed by discriminator**                       | `WalrusFactories<Mode>` — narrows the namespace by `mode`                                                                                              |
| **Distributive conditional + union-to-intersection**             | `IsUniform<G, AllSiblings>` — collapses a group of literal-hash strings; intersection of `'a' & 'b'` is `never`                                        |
| **`Exclude` for set difference at the type level**               | `MissingProviders` (B), `UnsatisfiedWitnesses` (C)                                                                                                     |
| **Literal-preserving generics**                                  | `CodegenableDecl<Shape, Emitter extends string>` so emitter names survive                                                                              |
| **Third generic on `StackMember<Provides, Consumes, Caps>`**     | Required so capabilities' phantom shapes (codegen emit shape) flow through                                                                             |
| **`Equal<X, Y>` proof type**                                     | Verifies `_SuiEmitted` is exactly `SuiCodegenExports` (Scenario E)                                                                                     |
| **Callback-form for narrowing across multiple namespaces**       | Scenario C2                                                                                                                                            |

## Where the architecture's claims survived

1. **Tag/provide typed value flow (B).** Inference flowed naturally from
   `consumes: [tagA, tagB] as const` into `ctx: BuildContext<tagA | tagB>` and `ctx.get(tagA)` was
   correctly narrowed. Negative test (consuming a tag not in `consumes`) errors crisply.

2. **Mode-narrowed factory namespaces (C, C2).** This was the load-bearing claim of Tension 11 and
   it survives. `WalrusFactories<Mode>` indexed by mode discriminator does exactly what the
   architecture promises: `Walrus.localCluster()` does not exist on the fork-mode factory.

3. **Phantom-typed cross-plugin witnesses (C).** A composite's resolved value can carry a
   `Witness<'sui-local'>` phantom; a stack-level `witnessStack` computes
   `Exclude<Required, Provided>` and rejects mismatched stacks. Negative test fires.

4. **Lifted-sibling dedup at the type level (D).** Same `(plugin, kind, scope)` with different
   literal hashes is caught at compile time via union-to-intersection collapsing to `never`. This is
   more aggressive than the architecture commits to ("refuse at compose time") — we got it for free
   at compile time when keys carry literal hashes.

5. **Renderer projection field-list closed (F).**
   `Equal<keyof SubscribableState, 'identity'|'cycle'|...>` is `true`; the no-display-vocab
   discipline is verifiable as a type-level invariant. The architecture's claim "adding a field
   requires an architecture revision" is enforceable: an attempt to access `row.title` is a type
   error.

6. **Capability composition (E).** A plugin's `CodegenableDecl<Exports, EmitterName>` survives
   through to a consumer who picks emitted shapes by literal name.

7. **Variadic + structural options discrimination (A, G).** `MEMBER_BRAND` (unique symbol) is
   unambiguous; the type-level `Last<Args>` peel works correctly.

## Where the architecture's claims broke / needed adjustment

### 1. `StackMember` capabilities tuple needs a third generic (E)

**Architecture wording.**
`NodePlugin … produces a resolved value plus zero or more capability declarations (Snapshotable, Routable, Codegenable, etc.).`
Doesn't mention threading capabilities through as a tuple type.

**What broke.** My first cut had `capabilities?: ReadonlyArray<CapabilityDecl>` on `StackMember`.
That widened all decls to their union form; `CodegenableDecl<SuiCodegenExports, 'sui-bindings'>`
collapsed to `CodegenableDecl<unknown, string>` and a consumer's
`EmittedFor<typeof member, 'sui-bindings'>` resolved to `never`.

**Workaround.** Added a third generic `Caps extends ReadonlyArray<CapabilityDecl>` to
`StackMember<Provides, Consumes, Caps>` and to `makeMember`. Then
`capabilities: [suiSnapshot, suiRoute, suiCodegen] as const` (the `as const` matters at the call
site) preserves the per-decl narrow type.

**Architecture should adjust.** Spell out that `StackMember` (or its plugin-author helper
equivalent) must keep the capabilities tuple as a generic-typed array — not erase to
`ReadonlyArray<CapabilityDecl>` — otherwise typed codegen outputs and typed Snapshotable
contributions don't flow through to consumers.

### 2. Phantom variance: function-parameter phantoms break subtyping

**Architecture wording.** Does not specify phantom shape; just says "phantom-typed cross-plugin
witnesses".

**What broke.** My first cut at `Tag<Id, Resolved>` used `_resolved?: (x: Resolved) => Resolved`.
This is contravariant on `Resolved` (function parameter position). The result:
`Tag<'sui', { rpcUrl: string }>` did NOT flow into the `Tag<string, unknown>` slot of `AnyMember`,
because `unknown` is not assignable to `{ rpcUrl: string }`. Scenario A originally produced six
errors of "Types of property '\_resolved' are incompatible".

**Workaround.** Changed all phantoms to thunk-returning form: `_resolved?: () => Resolved`. Return
position is covariant — narrower types flow into wider slots correctly. Same fix applied to
`CodegenableDecl._emitted` and `Witness`.

**Architecture should adjust.** Phase-3 spec needs a sentence: _Phantom marker fields on types that
must satisfy `<...string, unknown>` slots use return-only (covariant) function phantoms, not
parameter-bearing ones._ This is a real footgun.

### 3. Tag covariance soundness gap (Bonus 2)

**Symptom.** Because we used a covariant phantom (the necessary fix above),
`Tag<'t1', { a: number; extra: string }>` IS assignable to `Tag<'t1', { a: number }>`. A consumer
that yields a "narrow" tag and gets back a wider value would, in principle, be fine at runtime
(extra fields are ignored), but two tag objects with the same `id` but different declared shapes
would compare equal at the type level. In practice tags are constructed once at a plugin's barrel
and not passed around, so this doesn't bite — but it IS a soundness gap.

**Workaround / mitigation.** None applied. Acceptable risk for now. To close it, the phantom would
need to be a _bivariant_ invariant ("both at once"), achievable via
`{ readonly _resolved?: { (): Resolved; readonly tag: Resolved } }` or a `[Resolved]` tuple-wrapped
phantom. Not worth the complexity unless tag values are intentionally passed around.

**Architecture should note.** This is a known type-level soundness gap. If consumers ever pass tag
_values_ around (not just `import { suiTag }`), revisit.

### 4. Network threading: callback vs. flat variadic (C vs C2)

**Architecture wording.** "`defineDevstack` takes a `network` config that is a discriminated union
over `mode`. Each plugin namespace exposes its factories as a mapped object keyed by mode."

**What broke.** The flat variadic form
`devstack(Walrus.localCluster(), Sui.local(), { network: localNet })` cannot automatically thread
the trailing-options `network` into the plugin factories — by the time the type checker sees
`Walrus.localCluster()`, the `network` option hasn't been parsed yet. The user has to either:

(a) Pass `network` explicitly to every plugin factory: `Walrus.for(localNet).localCluster()` —
verbose but flat. (Scenario C demonstrates this works.) (b) Use a callback form:
`defineDevstack({ network: localNet }, ({ Walrus, Sui }) => [Walrus.localCluster(), Sui.local()])`.
Clean narrowing, but not a flat variadic list. (Scenario C2 demonstrates this works.)

**Architecture should adjust.** Pick one. The distilled `22-programmable-api.md` says variadic +
trailing options; Tension 11's resolution implies mode-narrowed namespaces. Without a callback or
per-factory threading, the two are in tension. My recommendation based on this prototyping: **expose
BOTH forms**. The flat form for the simple case (user manually says
`walrusFor(network).localCluster()` or accepts a default-local-network shorthand). The callback form
for cases where the user wants the compiler to do all the mode-narrowing for them.

### 5. Lifted-sibling: literal `inputHash` required for type-level dedup (D)

**Architecture wording.** "`inputHash` — content-hash of the inputs that determine the sibling's
output."

**What broke.** Content hashes computed at runtime are opaque `string`s; the type system cannot see
two opaque branded strings as different. To get _compile-time_ dedup conflict detection (rather than
runtime), the input hash had to be a string literal type (e.g. `'v2.0.0'`, `'v3.0.0'`).

**Workaround.** Introduced `LitHash<S extends string>` with a
`litSiblingKey(plugin, kind, scope, literalHash)` constructor that preserves the literal at the type
level. In real life this is fine — plugin authors often _can_ declare a literal hash for an upstream
pin (e.g. a git ref string is already a literal). But content-hash-of-Move.toml will be
runtime-computed, and that variant degrades to runtime refusal — same as today.

**Architecture should adjust.** Reword the dedup contract: _literal-typed inputs_ (a pinned git ref)
yield compile-time refusal; _runtime-computed inputs_ (a Move.toml content hash) yield runtime
refusal. Both are present, by construction.

### 6. Excess-property check on trailing options (A)

**Symptom.** `devstack(member, { unknownKey: 'oops' })` is caught — but only because the union
`AnyMember | OptionsLike` and excess-property checking conspire. If the user inlines an `options`
object into a variable first (`const opts = { unknownKey: 'x' }; devstack(member, opts)`), the union
widens and the excess key is silently allowed. This is standard TS behavior; mention it so users
know.

**Architecture should note.** Type-level rejection of unknown option keys is sensitive to call-site
form. Doc the recommended form (inline literal) and rely on a runtime check for the via-variable
form.

## Where I had to use `any` / casts / non-test `@ts-expect-error`

- `as unknown as LitHash<S>` in `litHash()` — necessary because a literal-string-branded type isn't
  directly assignable from a `string` parameter. Standard branded-primitive constructor pattern.
- `as WalrusFactories<Mode>` / `as SuiFactories<Mode>` / `as NamespacesFor<Mode>` — runtime returns
  all factories, type system narrows. The cast is the boundary where runtime breadth meets
  type-level narrowness. Acceptable; this is the mode-narrowing pattern's standard implementation.
- `as unknown` casts inside `tuiProject` for `endpointKey === (k as unknown)` — because endpoint
  keys are branded `EndpointKey` (different brand than the plugin keys in `row.endpoints`).
  Cosmetic; the real implementation would type endpoints under plugin keys properly.
- `AnyMember` uses `Tag<string, any>` for the erased form (Provides) and
  `ReadonlyArray<Tag<string, any>>` (Consumes). `any` is load-bearing here because variance-sound
  `unknown` would break the upcast pattern (see point 2). Documented; recommended Phase-3 wording.

**No `// @ts-expect-error` outside the negative tests.**

## Bonus findings (architecture didn't anticipate)

1. **Negative-test sensitivity to scenario isolation.** When the negative test relies on a function
   whose constraint is `never` (the strict-devstack / dedup-checker pattern), the error is "Argument
   of type [...] is not assignable to parameter of type 'never'". This is correct but the diagnostic
   is opaque to users. Phase 3 should use
   [TypeScript's branded-error pattern](https://www.typescriptlang.org/play?#code/C4TwDgpgBAYg9nKBeKBvAviIQ)
   — a tagged error object with a descriptive field name — so the user sees
   `__missing_providers: 'account'` instead of `not assignable to never`.

2. **Distributive conditional union explosions.** With three members where m3 consumes [t1, t2],
   `ctx: BuildContext<t1 | t2>` worked cleanly. **No** union explosion. Tested at Bonus 1.

3. **Void-typed resolved values work.** A tag whose resolved type is `void` flows through ctx.get
   correctly — no surprises. Tested at Bonus 4–5.

4. **Empty member list with only options.** `devstack({ stackName: 'opts-only' })` compiles. Tested
   at Bonus 3.

5. **The `as const` requirement on capabilities is fragile.** If a plugin author forgets `as const`
   on the `capabilities` array, the literal-typed decls widen and the codegen-emitted-shape
   extraction silently returns `never`. This is a footgun. Phase 3 should expose a typed builder
   (`pluginCapabilities(snap, route, codegen)` variadic helper) that infers and preserves the tuple
   shape, removing the need for `as const`.

## Open questions raised by this prototyping

1. **Should the user-facing `defineDevstack` adopt the callback form for network narrowing, the flat
   variadic, or both?** (See finding #4.)

2. **Should phantom witnesses be implementation-defined per-plugin or have a substrate-level
   helper?** Right now `Witness<'sui-local'>` is just `{ readonly [_witness]: 'sui-local' }`. Phase
   3 should provide a `defineWitness<'sui-local'>()` constructor so the witness symbol is
   centralized (and so two plugins can't accidentally collide).

3. **What's the type-level recovery when an out-of-tree plugin author doesn't expose mode-narrowed
   factories?** The architecture says runtime refusal is the fallback. My prototype doesn't model
   that fallback — both type-level and runtime fire together, but Phase 3 needs the out-of-tree
   shape spec'd.

4. **Should `capabilities` be a builder rather than an array?** A builder pattern
   (`.snapshot({ ... }).route({ ... }).codegen({ ... })`) preserves narrow types without `as const`
   and reads better than a tuple literal.

## Raw tsc output (clean compile)

```
$ /Users/michaelhayes/code/ts-sdks-incubation/node_modules/.bin/tsc --noEmit -p /tmp/devstack-type-prototype/tsconfig.json
$ echo $?
0
```

## Raw tsc output (negative-test verification — all 18 directives toggled off)

```
src/scenario-A-variadic.ts(72,39): error TS2345: Argument of type '{ provides: Tag<"sui", { readonly rpcUrl: string; }>; consumes: readonly []; }' is not assignable …
src/scenario-A-variadic.ts(78,39): error TS2345: … 'provides' is missing …
src/scenario-A-variadic.ts(92,49): error TS2322: Type '"fancy"' is not assignable to type '"tui" | "plain" | "silent" | undefined'.
src/scenario-A-variadic.ts(98,49): error TS2353: Object literal may only specify known properties, and 'unknownKey' does not exist in type 'AnyMember | OptionsLike'.
src/scenario-B-tag-provide.ts(74,26): error TS2345: Argument of type 'Tag<"account", { readonly address: string; sign: …; }>' is not assignable to parameter of type 'never'.
src/scenario-B-tag-provide.ts(124,40): error TS2345: … is not assignable to parameter of type 'never'.
src/scenario-C-composite-mode.ts(131,49): error TS2339: Property 'localCluster' does not exist on type '{ readonly forked: () => … }'.
src/scenario-C-composite-mode.ts(135,51): error TS2339: Property 'known' does not exist on type '{ readonly localCluster: () => … }'.
src/scenario-C-composite-mode.ts(139,50): error TS2339: Property 'forked' does not exist on type '{ readonly known: () => … }'.
src/scenario-C-composite-mode.ts(229,45): error TS2345: … is not assignable to parameter of type 'never'.
src/scenario-C2-network-thread.ts(65,27): error TS2339: Property 'localCluster' does not exist on type '{ readonly forked: () => string; }'.
src/scenario-C2-network-thread.ts(72,21): error TS2339: Property 'live' does not exist on type '{ readonly local: () => string; }'.
src/scenario-D-lifted-sibling.ts(180,63): error TS2345: … 'walrus|upstream-git|per-app' conflict, is not assignable to parameter of type 'never'.
src/scenario-E-capability-composition.ts(149,7): error TS2322: Type '{ SUI_RPC: …; SUI_CHAIN_ID: …; client: () => …; }' is not assignable to type 'never'.
src/scenario-E-capability-composition.ts(158,7): error TS2741: Property 'subtrees' is missing in type '{ kind: "snapshotable"; missingTolerance: "fine"; }' but required in type 'SnapshotableDecl'.
src/scenario-F-renderer-projection.ts(122,22): error TS2339: Property 'title' does not exist on type 'Row'.
src/scenario-F-renderer-projection.ts(132,30): error TS2339: Property 'extras' does not exist on type 'SubscribableState'.
src/scenario-F-renderer-projection.ts(167,34): error TS2322: Type '"title.set"' is not assignable to type '"plugin.acquiring" | "plugin.ready" | "plugin.failed" | "endpoint.registered" | "strategy.registered" | "log.appended" | "sibling.deduped" | "build.progress"'.
```

18 errors → 18 `@ts-expect-error` directives. One-to-one coverage.

## Files produced

- `/tmp/devstack-type-prototype/tsconfig.json` — strict TS5.9 config
- `/tmp/devstack-type-prototype/package.json` — minimal stub
- `/tmp/devstack-type-prototype/src/substrate.ts` — shared substrate types (branded primitives, Tag,
  StackMember, capabilities, projection)
- `/tmp/devstack-type-prototype/src/devstack.ts` — variadic `devstack(...)` + `makeMember`
- `/tmp/devstack-type-prototype/src/scenario-A-variadic.ts`
- `/tmp/devstack-type-prototype/src/scenario-B-tag-provide.ts`
- `/tmp/devstack-type-prototype/src/scenario-C-composite-mode.ts`
- `/tmp/devstack-type-prototype/src/scenario-C2-network-thread.ts`
- `/tmp/devstack-type-prototype/src/scenario-D-lifted-sibling.ts`
- `/tmp/devstack-type-prototype/src/scenario-E-capability-composition.ts`
- `/tmp/devstack-type-prototype/src/scenario-F-renderer-projection.ts`
- `/tmp/devstack-type-prototype/src/scenario-G-ergonomics.ts`
- `/tmp/devstack-type-prototype/src/scenario-bonus-pressure.ts`

## Recommendations for Phase 3 architecture revisions

1. **Spell out the phantom variance rule.** Cite this section: phantoms that participate in
   `<T, unknown>` widening relations must be return-only (covariant).
2. **Add a third `Caps` generic to `StackMember`** so capabilities' phantom shapes (especially
   codegen emit shapes) flow through to consumers.
3. **Pick a network-threading story** (callback vs flat-variadic-with-explicit-threading vs both).
   Currently implicit; the prototype shows both work, neither is automatic.
4. **Differentiate literal-typed vs runtime-computed `inputHash`** in the lifted-sibling contract.
   Literal → compile-time refusal; runtime → runtime refusal. Both are real.
5. **Provide a typed builder for capabilities** to avoid the `as const` footgun.
6. **Provide branded structured-error types** for `MissingProviders`, `UnsatisfiedWitnesses`,
   `SiblingHashConflict` so the diagnostic isn't "not assignable to never".
7. **Document the tag covariance soundness gap** — it's acceptable today, would bite if tags are
   passed around as runtime values.
