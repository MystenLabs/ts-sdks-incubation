# Core types + plugin SPI

**Verdict**: B+ — Small, deliberate, and largely sound. The biggest gap is that the `ActionRunContext` discriminated union is undermined at construction time, plus a few smaller footguns around `provides:` namespacing and `inputs` typing.

## Architecture

**Discriminated `ActionType` (`'Build' | 'Service' | 'Publish' | 'Register' | 'Seed' | 'Emit'`)** — Per-kind interfaces (`BuildAction`, `PublishAction`, etc.) carry their `type` as a literal, which makes filters (`cli/filters.ts`) safe `switch` blocks with exhaustive narrowing. `dependsOnKind` correctly lives on `EmitAction` only and `path` only on `PublishAction` — no carrier-of-everything `Action` blob. Good fit.

**`ActionRunContext` discriminated union — leaky in practice.** `LocalnetActionRunContext` carries `stack`, `LiveNetActionRunContext` does not, and `requireLocalnetCtx(ctx)` narrows via `asserts ctx is LocalnetActionRunContext`. **But** the reconciler at `runtime/reconcile.ts:284` builds the context as a single object literal:

```ts
const ctx: ActionRunContext = { ..., stack: base.stack, network: base.network, ... };
```

`base.stack: string` is always present (per `ReconcileBaseContext`), and the doc on `ResolvedTarget` admits "Live-network targets carry the placeholder `DEFAULT_STACK` so the type stays narrow" — i.e. the union's "live nets don't have a stack" promise is literally false at runtime. The narrowing is purely a typesystem hint to plugin authors; if a plugin author forgets to call `requireLocalnetCtx` and uses `ctx.stack` on testnet, they get the placeholder string `'main'` silently, not a runtime error. **This is the single most consequential typing weakness in core: the type asserts a precondition the runtime doesn't enforce.**

**Capability model (`provides`/`needs` with `:before`/`:after`).** The dual model — direct `needs: ['sui.localnet']` plus capability queries `'walrus.app-network:before'` — is paying off: walrus declares `provides: ['walrus.app-network']` and the sui plugin opportunistically queries `'walrus.app-network:before'` so walrus runs first when present, no-op when absent. `validateProvides` warns on un-namespaced capabilities (foot-gun); the comment says v2 escalates to error. **Promote it now** — it's a one-line change and the warning has no production users to break.

## Plugin SPI (`plugin.ts`)

**`definePlugin` is a no-op identity function plus name validation** (`PLUGIN_NAME_RE = /^[a-z][a-z0-9_-]*$/`). Tight, easy to learn. **`expandPluginActions`** is the real work: namespace expansion (`bare → 'plugin.bare'`), needs resolution (bare → local FQN, dotted → cross-plugin pass-through, `:before`/`:after` → topo passthrough), and the foreign-namespace forge guard (`'arena' plugin can't declare 'sui.localnet'`).

The one cast (`out.push({ ...action, name: fullName, needs: resolvedNeeds } as Action)` at line 61) is unfortunate — TypeScript can't preserve discriminant narrowing through `{...action, ...}` spread. A safer expression is to spread per-kind inside a `switch (action.type)`, but the cast is local and the test suite covers the relevant behavior, so this is a minor cosmetic.

**Test coverage in `plugin.test.ts` is solid for the SPI:** name validation across legal/illegal forms, auto-prefix, foreign-namespace rejection, duplicate detection, bare-need resolution, FQN passthrough, capability passthrough, and warn-on-bare-capability.

## `Registry` and `RegistryQuery<T>` — well-designed footguns

`RegistryQuery<T>` is `{ list, find, require, register }` — minimal and complete. `register()` overwrites by `name` (last-write-wins) silently — fine for Publish-then-rerun, dangerous if two plugins both publish under `'walrus'`. No collision detection.

**`ns<T>(name)` is the right escape hatch but the typing is loose by design.** It's deliberately `T = any`. The cost: nothing prevents `registry.ns<{ nodes: RegistryQuery<Node> }>('walrus').nodes` from being `registry.ns<{ misspelt: ... }>('walrus').misspelt`. The proxy auto-creates the kind. Two plugins using `registry.ns<X>('walrus')` and `registry.ns<Y>('walrus')` will silently share a namespace bucket.

**`Action.inputs?: TInputs = unknown`** — typed via factory generics but the consumer side (reconciler hashing, file-watcher input resolution) reads `action.inputs` as `unknown`. That's the right tradeoff for a generic action graph, but it means a plugin author who mistypes their `inputs` field gets silently re-hashed on every cycle.

## Customizability + extensibility gaps

- **No custom `ActionType`.** Plugins can't add a kind beyond the six.
- **Lifecycle hooks are limited to `getStatus`/`run`.** No `onCleanup` separate from `ShutdownHook`, no `onStackDestroy`, no `onManifestRead`.
- **`Plugin` interface has no `version`, `description`, or metadata.** Authors can't surface "this plugin needs sui >= 1.7" or "this plugin pins a docker image" through the type. Add three optional fields (`version?`, `description?`, `requires?: { devstack?: string }`) before publishing — almost free, prevents one class of mismatch bug.

## Discoverability

A plugin author who reads `core/types.ts` top-to-bottom learns the model in ~10 minutes. The barrel `index.ts` is well-organized into Public types / Authoring helpers / Action factories / Signer factories / Built-in plugins, so `import { definePlugin, publish, emit, register } from '@mysten-incubation/devstack'` covers 90% of authoring. The split between `cli`, `runtime`, `helpers` subpaths keeps the authoring surface uncluttered.

## Top recommendations

1. **Fix `LocalnetActionRunContext` narrowing**: drop `stack` from `LiveNetActionRunContext` for real (`stack?: undefined` plus an `if (network === 'localnet')` branch in `evaluateAndRun` to construct two different shapes).
2. **Promote the un-namespaced `provides` warning to an error.**
3. **Add a runtime warning when a namespace is re-opened with a different shape** in `Registry.ns<T>()`.
4. **Add `version?`, `description?`, `requires?` fields to `Plugin`** for metadata.
5. **Add a name-collision guard in `Registry.register()`** with last-write-wins as the explicit policy or first-write-wins for safety.
