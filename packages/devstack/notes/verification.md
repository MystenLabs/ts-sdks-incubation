# Verification owed

Hands-on tasks that complete prior rounds' "done criteria" but can't be
checked from a typecheck or test pass alone. Tick items off as they're
verified; remove the file when empty.

- **Three sequential `apply` runs healthy on arena.** Proves PR 0
  (state hydration) + A1 (sui.accounts non-mutating getStatus) + A3
  (transient probe failures) work end-to-end.
- **Real cold/warm cycle timings on a fixed hardware profile.** The
  README claims got stripped (C3) because they didn't reproduce; we owe
  ourselves real numbers next time someone has a clean box and a
  stopwatch.
- **G3 e2e CI matrix runs green.** The workflow rewrite covers all 4
  examples × 2 shards but hasn't been pushed yet — first push to a PR
  is the proof.
- **`pnpm create @mysten-incubation/devstack-app smoke` produces an
  installable scaffolded app.** C1 made the rewriting work; whether the
  result actually `pnpm install`s end-to-end depends on the workspace
  packages being publishable, which is C2-gated.
