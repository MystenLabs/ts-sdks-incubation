# Supervisor + one-shot

**Verdict**: B− — Tight implementation, but `devstack up` defaulting to `--once` (which tears down) is a real design bug that has confused real users.

## Architecture

The `Supervisor` class is small (~340 lines) and the responsibilities are cleanly factored: a `Reconciler` owns ordering, a `StatusRenderer` owns the terminal block, a `FileWatcher` owns chokidar, and the supervisor itself is a thin coordinator. The cycle-coalescing model (`cycleInFlight` + `cyclePending`, microtask-deferred re-fire) is tight and avoids parallel cycles racing on the registry.

The lifecycle is well-thought-out in places I'd expect to be wrong:
- The `keepAlive` setInterval (line 131) is the right fix for headless mode where libuv has no other handle anchoring it.
- `installSignalHandlers` deliberately leaves SIGINT/SIGTERM hooked through shutdown (`stopped` guard idempotent) — yanking signal handlers mid-shutdown can race Node's exit.
- `Promise.allSettled` + per-hook completion logging gives users visible progress during the slow `docker stop` SIGTERM grace period.
- LIFO is *claimed* in the comment (line 175) but the implementation is parallel `Promise.allSettled` over `this.shutdownHooks.map(...)` — there's no LIFO ordering. The comment justifies parallel-fan-out; the LIFO claim is dead text from an earlier design.

`runOnce` (lines 138-144) is the headline gotcha. It reuses the same fields as `start()` but: (1) installs signal handlers, (2) does not install key handlers, (3) does not arm the watcher, (4) does not call `setInterval`, (5) calls `runCycle` once, (6) **calls `shutdown()`**. Step 6 is what surprised the walrus debugging session.

## Problem fit (terminal experience)

Live status block + 'r' (retry failed) + 'l' (toggle verbose) + 'q'/'s' (shutdown) is a believable scaffold-eth-2 caliber experience, and the reconciler's progress callback drives the renderer per-action — no batched-end-of-cycle redraw lag. The `markStale` pre-emptive paint (line 280) for instant visual feedback on file-watcher fire is the kind of detail that separates good DX from *good* DX. The renderer's headless fallback prints each state change inline, which matters for CI logs.

One gap: `appendLog('supervisor', ...)` is the only error surface for cycle aborts (line 253) and manifest write/hydrate failures. A dedicated supervisor-error highlight would make these stand out.

## Integration

`onShutdown` is plumbed through `ActionRunContext` only by the supervisor — `runOneShot` (one-shot.ts line 131) deliberately does not pass it. That's the right call for live-net deploys (you don't tear down testnet on Ctrl-C), but it means **wallet-server's `ctx.onShutdown` registration silently becomes a no-op in `apply` / `deploy` paths**.

Playwright integration (`playwright/global-setup.ts` line 17-22) calls `runUp({ once: true })`, which hits `Supervisor.runOnce()` — this brings up *and* tears down inside globalSetup. That's exactly the surprise. globalSetup completes, every hook fires, every container is stopped, then the test workers start running against a non-existent stack.

## The `--once` UX bug — design, not naming

The CLI dispatcher in `cli/index.ts` line 39 **forces `--once` ON for every `devstack up` invocation**. The `up`/`watch` split was added later: `up` is the always-once path; `watch` is the long-running path. But `--once` semantically means "reconcile then tear down" — *not* "reconcile and exit, leaving services running."

This is a design bug, not a naming bug:
- A scaffold-eth-2 caliber tool should NEVER tear down docker services as a side effect of "I just brought my stack up." The user's mental model is `up = up`. Today, `devstack up` brings the stack up, immediately fires every `onShutdown` hook (wallet-server `server.close()`, etc), and exits.
- Real Service actions that detach docker containers don't register `onShutdown` (per the supervisor header comment), so localnet sui/walrus/seal *survive*. But anything that runs in-process — wallet-server is the canonical case — is killed.
- The Playwright path is the same code path, so e2e tests inherit the bug: the wallet-server registered during `globalSetup`'s `runOnce()` is dead before any test runs.
- All four example apps ship `localnet:up: devstack up --once` and `localnet:watch: devstack watch`. Users follow the script names; they do not know about the asymmetry.

The fix is to introduce *three* distinct modes, not two:
1. `runUpKeepalive` — reconcile once, then do not tear down. **Should be the default `devstack up` behavior.**
2. `runWatch` — current `Supervisor.start()`. Long-running with file watcher.
3. `runOnceAndShutdown` — current `runOnce()`. Should be renamed `runEphemeral` or used only in tests.

## Testing

`supervisor.test.ts` (54 lines) tests only constructor guards — `localnet`-only network rejection. Zero coverage of: the `cyclePending` coalesce, the keepAlive timer, signal-handler install/uninstall idempotency, key handler dispatch, the `shutdown()` LIFO claim, `runOnce` semantics. `one-shot.test.ts` is healthier: filter behavior, manifest read-only mode, sui-rpc pre-registration, scope walking. The supervisor file is the one carrying the high-stakes process-lifecycle logic, and it's the one without coverage.

## Top recommendations

1. **Flip `devstack up` default to keepalive.** Move the current `--once` semantics behind `--once`.
2. **Add `runUpKeepalive` to Supervisor** — reconcile, don't fire shutdown hooks, return when reconciler's queue is drained.
3. **Fix Playwright `globalSetup`** to use the new keepalive entry; add a corresponding `globalTeardown` that calls shutdown.
4. **Remove the LIFO claim** from `shutdown()`'s comment, or implement it.
5. **Document the `onShutdown` no-op** on `runOneShot`'s context.
6. **Expand `supervisor.test.ts`** to cover the lifecycle paths that surprise users.
