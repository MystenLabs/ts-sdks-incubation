# Registry

**Verdict**: A− — Quietly load-bearing piece. Small (91 lines), sharp, well-suited to the build-then-extract methodology. A few rough edges will bite as the plugin set grows.

## Architecture

The split between `RegistryQuery<T>` (per-kind facade) and `RegistryImpl` (the umbrella with dirty set + namespace map) is clean. Dirty tracking lives on a single `Set<string>` keyed by flat `kindKey` strings (`'tokens'`, `'walrus/nodes'`), which keeps `flushDirty()` / `consumeDirty()` simple and matches what `EmitAction.dependsOnKind` declares. The `ns<T>(name)` Proxy is the most clever move: `bag` is a plain object that auto-vivifies a `RegistryQueryImpl` per-kind on first property access, with a stable `kindKey = '<ns>/<kind>'` injected so dirty bits work identically to core kinds.

The unconstrained generic `T` (justified inline in `core/types.ts`) is the right call — narrowing to `Record<string, RegistryQuery<unknown>>` would force every plugin's namespace interface to carry a redundant index signature.

Last-write-wins on `register()` is intentional and correct for the reconciliation model: a cycle either produces the same state (idempotent) or a strictly newer one. There is no merge logic; `Map.set(item.name, item)` replaces wholesale.

## Problem fit

This works well today and should scale to the long tail. Walrus uses `ns<WalrusNamespace>('walrus').nodes`; seal uses `ns<SealNamespace>('seal')`. The Proxy layer means a new plugin needs zero registry changes to declare a new kind — they just write `ctx.registry.ns<MyNS>('plugin').myKind.register(...)`. The auto-vivification is also what lets the manifest reader hydrate a manifest from a future devstack version with kinds the local code doesn't know about (it iterates serialized bag entries; unknown kinds get a fresh query).

## Integration

The dirty-bit handshake is the most subtle piece, and it works:

- Plugin source actions call `register()` → kind goes into `dirtySet`.
- After the topo walk, the reconciler reads `flushDirty()` → returns + clears.
- `consumeDirty(emit.dependsOnKind)` is called per-Emit immediately after that Emit ran, so a *later* register of the same kind in the same cycle correctly re-fires the Emit. This subtle lifecycle (`flushDirty` then incremental `consumeDirty` per Emit) is what enables the bounded cascade loop in `reconcile.ts:251`.

Manifest writer reaches into the private `namespaces` Map with a typed `as unknown as { namespaces: ... }` cast — ugly but localized. Manifest reader uses the public Proxy to round-trip namespaced kinds and explicitly calls `flushDirty()` after hydration to suppress spurious cascades. Both halves of the round-trip work, but the cast in `manifest-writer.ts:82` is an architectural smell: serialization is a registry concern and should be a public method (`reg.snapshot(): SerializedRegistry`), not an external poke into private state.

## Gaps

1. **No `unregister`**. Idempotent reconciliation relies on overwriting, but there's no way to express "this package was deleted from config." Stale entries persist forever in the manifest until a `devstack reset`. Low-urgency now, will become a paper cut.
2. **No namespace collision detection.** Two plugins both calling `ns<X>('walrus')` silently share state. The current shape (one plugin per namespace) is convention, not enforcement.
3. **`ns<T>()` is type-erased at runtime.** A typo in a kind name (`ns<WalrusNamespace>('walrus').node` vs `.nodes`) creates a fresh empty kind silently — no warning, no error. A plugin-author pitfall waiting to happen. Cheap fix: optional schema registration (`ns('walrus', { kinds: ['nodes'] })`).
4. **No observability hooks.** Can't see `register` events for a debug renderer or an audit log without monkey-patching.
5. **`ctx.registry` is the *Registry interface*, not `RegistryImpl`.** `dirtySet`-aware methods (`isDirty`, `flushDirty`, `consumeDirty`) are exposed on the interface but plugins shouldn't call them — they're reconciler-private concerns mixed into a public API.

## Testing

There is **no `registry.test.ts`**. Coverage is incidental — `reconcile.test.ts`, `imports/index.test.ts`, and `publish.test.ts` instantiate `RegistryImpl` and exercise it, but Proxy auto-vivification, namespace round-trip, and dirty-set ordering have no direct unit tests. This is the largest gap. A focused suite (~50 lines) covering `ns<T>()` lazy creation, consumeDirty's "later-register wins" semantic, and the manifest writer's private-state reach would prevent regressions when (not if) a follow-up adds `unregister` or schema registration.

## Top recommendations

1. **Add `registry.test.ts`** with the Proxy auto-viv, namespace round-trip, and dirty-set ordering cases.
2. **Expose `Registry.snapshot(): SerializedRegistry`** as a public method to drop the `manifest-writer.ts:82` private-field cast.
3. **Optional namespace schema registration** (`ns('walrus', { kinds: ['nodes'] })`) so typos surface at runtime instead of silently creating empty kinds.
4. **Split reader vs writer concerns** in the public interface — `dirtySet`-aware methods should not be on `Registry` (the type plugins see).
5. **Add `unregister` + a name-collision warning** for two-plugin clobbering on the same name.
