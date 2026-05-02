# `register`, `seed`, and `emit` action types

**Verdict**: Register C+, Seed B, Emit A− — Two of the three could collapse if Register loses its identity crisis. Emit's `dependsOnKind` cascade is the most sophisticated piece of the action ABI.

## Architecture

The three factories at `packages/devstack/src/actions/{register,seed,emit}.ts` are 30-line pass-throughs that brand a tagged-union literal onto the same `ActionBase` shape. The `ActionType` discriminator drives three different reconciler/filter behaviors:

- **Register**: no per-type behavior in `runtime/reconcile.ts`. The filters in `cli/filters.ts:24-36` keep it on every network. It is *literally a `service()` without container side-effects* — same `inputs`/`needs`/`provides`/`getStatus`/`run` shape, no extra slots.
- **Seed**: adds `liveNetworks?: boolean | Network[]` and the `seedRunsOn()` predicate consumed at two distinct sites — `cli/filters.ts:29` (filter-time strip on the one-shot path) and `runtime/reconcile.ts:296-300` (runtime-skip-as-`'skipped'` on every path). The double check is correct: filters only run on `runOneShot`; the supervisor takes the unfiltered graph and relies on the runtime gate.
- **Emit**: adds `dependsOnKind?: string[]` plus three orthogonal scheduling rules in `reconcile.ts:160-173, 226-274` — Emit serialization (one Emit at a time), Emit-after-non-Emits (line 166), and the dirty-cascade re-fire (line 251). The `dirty` UI marker (`core/types.ts:80`) is Emit-specific.

`dependsOnKind` and `needs` are genuinely orthogonal. `needs` is a hard topo edge ("don't even start until X is healthy"); `dependsOnKind` is a soft re-fire signal ("if this kind dirties after I run, run me again"). Codegen demonstrates both — it doesn't `needs:` any specific Publish (since plugins compose freely), but it does `dependsOnKind: ['packages']` so any Publish in the cycle re-fires it. Collapsing them would be wrong.

## Problem fit

**Register's "no-on-chain bootstrap" framing is too narrow.** The header at `register.ts:1-7` says it's for arbitrary on-chain transactions distinct from `Publish`. But the three callsites disagree:
- `walrus.register` — read a deploy file, register tokens/packages/nodes (no chain write).
- `seal.register` — does a chain write (publish KeyServer object).
- `sui.accounts` — funds accounts via faucet.

These have nothing in common except "post-Service work that mutates the registry." The doc is fiction. In practice, `Register` means "an action that isn't Build/Service/Publish/Seed/Emit" — a residual category.

**Seed's "fund accounts" framing is right and the network gate carries weight.** The `localnet-only by default` policy is exactly the safety rail you want. The opt-in shape (`true` / `Network[]`) is well-judged.

**Emit's `dependsOnKind` framing is the sharpest in the codebase.** The cascade-after-topo-walk model fits codegen's actual dependency. The interim `'dirty'` UI marker is a thoughtful affordance. The 4-round cascade cap is a correct guard against pathological plugins.

## Integration

The reconciler's per-type handling lives in three places: filters strip Service (and gate Seed), runtime skips Seed-by-network, the Emit cascade re-fires by dirty kind. Register has zero per-type logic anywhere — it's `getStatus`/`run` semantics like everything else.

A subtle issue: Register's `getStatus`-as-warm-path-registry-rehydrator pattern is entrenched. `walrus.register:386-405`, `sui.accounts:288-321` and `seal.register:147-168` all manually rehydrate captured state in `getStatus`. There's no ABI affordance to declare "these are the registry rows this action provides" — every plugin reimplements the warm-path mirror.

## Customizability + gaps

- **`provides: { registry: { packages, tokens, services, ns } }` slot** — the reconciler could replay registry mutations on skip without plugins duplicating in `getStatus`.
- **A `Verify` / `assert` action** — there's no read-only "assert chain state matches manifest, fail loudly otherwise." Plugins fake this by writing a `Register` action with a no-op `run`.
- **`dependsOnAction` for Publish/Register** — Emit has dirty-kind re-fire, but Publish/Register only have hard `needs:`.
- **No `liveNetworks` on Register** — Register defaults to running on every network with no opt-out. Most `register` callsites *should* be localnet-only.
- **`getStatus` skip-after-input-drift** — same issue from build/service review applies.

## Testing

`reconcile.test.ts:27-122` exercises Emit ordering, the queued→running→healthy transitions, and the no-progress-callback case. `filters.test.ts:17-82` covers the type discriminator. `one-shot.test.ts:154-186` covers the Seed network gate.

**No unit tests for the factory functions.** **No coverage for the dirty-cascade re-fire** — `reconcile.test.ts:28-81` tests the *non-cascade* path only. The 4-round cap, the cascade triggering on a kind dirtied during a non-Emit's run, the `consumeDirty` interaction — all uncovered. **No test for Register's intended one-shot semantics**. **No coverage of Seed's runtime gate** at `reconcile.ts:296-300`.

## Top recommendations

1. **Either rename `Register` → `Action` (catch-all) or split it** into `Register` (registry-only writes, no chain), `Bootstrap` (one-shot chain write), `Configure` (in-cluster setup).
2. **Add `liveNetworks` (or `runsOn`) to Register** symmetrically to Seed.
3. **Add a `Verify` action type** — read-only `getStatus`-like predicate that *fails the cycle* on `ok:false` instead of running.
4. **Add `provides: { registry: { ... } }` slot** so the reconciler can replay registry mutations on warm-path skip.
5. **Add unit tests for the dirty cascade**: kind dirtied during a non-Emit run, multi-round cascades, cap-hit behavior.
