// LongLivedScope — a Context.Reference carrying a Scope whose lifetime
// spans across hot-restart cycles. The per-cycle `runOnce` supervisor
// scope tears down on every `r` / file-watch trigger; finalizers
// registered there fire on each restart, taking the user's containers
// with them and forcing a fresh-genesis Sui (NEW chain id) and a
// publishMove cache-miss (NEW packageId), breaking any frontend that
// cached the old one.
//
// Containers that are safe to reuse across restarts (Sui localnet,
// indexer-db, walrus storage nodes) register their `docker rm -f`
// finalizer on this longer-lived scope instead. Two consequences:
//
//   1. On `r`: the per-cycle scope tears down, but this scope stays
//      alive — containers keep running, the next cycle's reuse-if-healthy
//      check finds them, chain id stays stable, publishMove cache hits.
//
//   2. On Ctrl-C / `q`: the OUTER launch scope tears down (it IS this
//      scope), all finalizers fire, containers get cleaned up. Same
//      end-state as today for process exit.
//
// `defineDevstack.buildLaunchEffect` provides this reference at the
// outermost `Effect.scoped` boundary so every nested effect sees the
// same scope. Default fall-back is `undefined`, in which case
// `Docker.run` registers on `Effect.scope` (the current scope) and
// behaves as before — useful for the standalone tests that exercise
// `Docker.run` directly without a surrounding devstack lifecycle.

import { Context } from 'effect';
import type { Scope } from 'effect/Scope';

export const LongLivedScope = Context.Reference<Scope | undefined>('@devstack/LongLivedScope', {
	defaultValue: () => undefined,
});
