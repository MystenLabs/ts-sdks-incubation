# Reconciler + topo executor

**Verdict**: B+ — Tight, terraform-flavored declarative reconciler with one real correctness bug (`getStatus` priority) and several missing observability hooks.

## Architecture

The supervisor's heart is roughly 380 lines split between three files: `reconcile.ts` (the executor), `topo.ts` (Kahn's-algorithm sort with capability resolution), and `hash.ts` (stable JSON fingerprinting). The shape is recognisably terraform-/k8s-controller-flavored — declarative actions describe `inputs` + `needs` + optional `getStatus` + `run`, the reconciler walks them, and idempotency is the contract. But two design choices set it apart from those lineages:

1. **No reconcile loop, just reconcile cycles.** A cycle runs once per supervisor trigger (start, file event, retry); the supervisor coalesces concurrent triggers via a `cycleInFlight`/`cyclePending` flag. This is closer to a `make` invocation than a kubelet — there's no continuous control loop fighting drift, just discrete passes.
2. **Two-phase walk: topo wave + Emit cascade.** Non-Emit actions run in the topo walk (concurrency 4). Emit actions are the only nodes that can re-fire within a cycle, gated by the `Set<string>` of "dirty kinds" their `dependsOnKind` overlaps. The cascade is bounded to 4 rounds — a mild safety net against runaway plugins.

The capability handshake (`provides: ['walrus.app-network']` / `needs: ['walrus.app-network:before']`) is implemented as a pre-pass that rewrites capability queries into concrete `needs` edges (`topo.ts:64-104`). `:before` is provider→me; `:after` synthesizes me→provider in the *provider's* edge set (the inverse synthesis is the subtle move). Queries against capabilities with no providers are silently dropped, which is what makes the sui-only-stack fallback work.

## Correctness — the `getStatus` priority is a bug

The header comment says: "Hash mismatch + no `getStatus` → run. Hash mismatch + `getStatus.ok === true` (cold cycle) → skip." The code (`reconcile.ts:307-321`) reads:

```ts
if (action.getStatus !== undefined) {
  const status = await action.getStatus(ctx);
  if (status.ok) { ... return 'healthy'; }
} else if (hashMatches) { ... return 'healthy'; }
```

The matrix is asymmetric and the asymmetry is a footgun. **An action with `getStatus` short-circuits whenever `getStatus.ok === true`, even if `inputs` changed.** Consider seal: `getStatus` checks for a cached `KeyServer` objectId on chain. If a developer edits the seal `inputs` (say, threshold k changes from 2→3), the input hash mismatches, but `getStatus` finds the *old* KeyServer still alive — `ok: true` — and the action skips. The new threshold never lands.

The header says this is intended ("cold cycle"), but it isn't gated to cold cycles in code. There's no `prior === undefined` guard around the `getStatus` branch. The fix is a one-liner: only consult `getStatus` when `prior === undefined || hashMatches`.

## Race conditions and ordering surprises

- **`failed`-state hash invariant.** On run failure, `lastInputHash: prior?.lastInputHash` is preserved — meaning a failed run "forgets" the new hash and the next cycle still sees `hashMatches === false`. Correct, but only for non-`getStatus` actions.
- **Emit serialization vs. `inflight` lookup** (`reconcile.ts:169-172`). The `sorted.find(x => x.name === name)` per inflight is O(N) per scheduling decision. Invisible at ~30 actions; worth a Map at hundreds.
- **Failure cascade is one-directional.** `blocked` is set when a `needs` is `failed`, which propagates through subsequent `isReadyToRun` checks. But `blocked` is *not* re-checked after an Emit cascade run that fails.
- **`hydrateRegistry` runs before the cycle but after Reconciler construction.** The Reconciler's in-memory `state` map is *not* hydrated from the manifest — only the registry is. So `hashMatches` is always false on supervisor start, and the cold-cycle skip relies entirely on `getStatus`.

## Integration

The reconciler is well-decoupled: it consumes a `Registry` (`flushDirty`/`consumeDirty`), an `AccountsContext`, an optional `progress` callback, and a `lenient` flag for the one-shot path's `ActionFilter`-stripped graphs. The supervisor wires it to `StatusRenderer`, `FileWatcher`, `manifest-reader/writer`, and SIGINT/keystroke handlers. The split is clean — no reconciler code knows about TTYs, manifests, or file watching.

## Customizability and gaps

- **No retry/timeout primitives.** Per-action retries land in `Supervisor.retryFailed()` (full-graph re-cycle, key `r`). No per-action retry policy, no backoff, no deadline.
- **Concurrency is global, not per-action.** Walrus's 4 storage-node parallelism is a side effect of the global pool — a heavyweight Build action gets the same 4 slots as cheap Registers. No `weight` or `category` knobs.
- **Cascade depth fixed at 4.** Bounded mainly to prevent infinite loops; a "real" multi-stage codegen pipeline might want it tunable.
- **No observability hooks beyond `progress` + `appendLog`.** Per-action duration, per-cell skip-reason classification — none surfaced.
- **`--target`/`--filter` are out-of-band.** Implemented as `actionFilter` + `actionScope` in `runOneShot`. The capability dropping in `scopeActions` warns to console but doesn't fail loudly.

## Testing

- `topo.test.ts` (110 lines): solid coverage of direct needs, `:before`/`:after` queries, cycle/dup/unknown errors, and the walrus migration scenario.
- `reconcile.test.ts` (123 lines): asserts the queued-snapshot, the Emit-after-non-Emit ordering invariant, and progress idempotence. **Does not test the `getStatus`-vs-hash-mismatch interaction at all** — the bug above slips because the test fixtures don't construct an action with both `getStatus: ok=true` and a changed `inputs`.
- `scope-actions.test.ts` (162 lines): well-structured coverage of `actionScope` filtering through a mocked Reconciler.
- Missing: cascade-loop boundedness, failure isolation across waves, `:after` synthesis with multi-providers, registry-dirty consumption ordering, and the four-cell decision matrix as an explicit table.

## Top recommendations

1. **Fix `getStatus`-vs-hash-mismatch priority** at `reconcile.ts:307-321`. Only consult `getStatus` when `prior === undefined || hashMatches`. One-line fix; closes a silent failure mode.
2. **Add per-cell skip-reason classification** to the progress callback so the renderer can show "skipped (hash match)" vs "skipped (status ok)" vs "skipped (cascade unaffected)".
3. **Test the four-cell decision matrix as an explicit fixture table** — every cell, with input drift × getStatus presence × ok value.
4. **Per-action concurrency weights** so a 5-min Rust build doesn't starve cheap Registers.
