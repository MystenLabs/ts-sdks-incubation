# Playwright integration

**Verdict**: C+ — Mostly the right shape ("real chain, real walrus, real seal, real wallet, no mocks"), but the two-supervisor architecture has a real seam: in-process services (wallet-server) get torn down by globalSetup's `runOnce` and the new supervisor's getStatus mistakes the orphaned port for a healthy server.

## Architecture: the two-supervisor dance

The current shape is `globalSetup → runUp({once: true}) → Supervisor.runOnce() → shutdown()`, then Playwright's own `webServer` block fires `pnpm dev` (= `devstack watch`), which constructs a **second** `Supervisor` over the same `appDir`/`stack`. This is the central architectural seam, and it is wrong in a subtle way.

`runOnce()` calls `shutdown()` after one reconcile cycle. In the supervisor, `shutdown()` runs all registered `onShutdown` hooks, in parallel, regardless of whether the underlying process is a *long-lived service that should outlive the supervisor* or a *transient owned by it*. The wallet-server plugin registers an `onShutdown` hook that calls `handle.server.close()` and clears the module-level `activeServer`/`activeToken`. So `globalSetup`'s `runOnce` brings the wallet-server up, then immediately tears it down — and worse, **forgets the token**. The compose-managed services (sui, walrus, seal containers) survive because their hooks aren't registered, but the in-process wallet-server isn't backed by Docker — it's a Node `http.Server` and can't survive its parent.

When `pnpm dev` then spawns `devstack watch`, a fresh Supervisor starts another wallet-server with a fresh random token. The frontend bundle is happy because it reads the manifest at request time. **But anything cached against the first token — including a Playwright page that loaded before `webServer.reuseExistingServer` decided to reuse — will 401 on every signing call.**

The mental model "globalSetup brings the stack up; webServer just serves the SPA" is leaky because part of the stack (the wallet-server) lives inside the same Node process tree as `devstack watch`.

## The wallet-server connect race we observed

Concretely: when `reuseExistingServer: true` is on (non-CI default) and a developer has `devstack watch` already running, Playwright skips the `webServer` step but **still** runs `globalSetup` → `runOnce` → `shutdown`. That `shutdown` walks the freshly-created Supervisor's hook list, which is empty for the *already-running* server (it was registered against a different Supervisor instance). The hook for the new instance does fire, killing the new server. But the manifest was already written with the new token. The standing `devstack watch` Supervisor has no idea its in-process server got nuked. The frontend reads the manifest, gets the new (now-dead) token, gets connection refused, and the test fails.

Even when there's no preexisting watcher, there's a TOCTOU: `runOnce` writes the manifest, then `shutdown` kills the server, then Playwright launches `pnpm dev` and the new Supervisor reaches the wallet-server `serve` action's `getStatus` — which `fetch()`s `/health` — but the new instance also re-registers under `wallet-server` in `ctx.registry.services` with a **different** token. There's a window where the SPA bundle has stale token in memory.

## Problem fit: e2e believability

Modulo the race, this is genuinely "real chain, real walrus, real seal, real wallet" — `seal-flow.spec.ts` exercises encrypt → upload to walrus → grant cap → fresh-load + connect-as bob → decrypt, no mocks. That's the right shape.

The cost is honesty about what *can* be parallelised: `defineConfig.ts:71-72` hardcodes `fullyParallel: false, workers: 1`. There's no per-test isolation primitive — every test mutates one shared chain, one shared walrus blob store. The CLAUDE.md aspiration is "fresh localnet per test file via testcontainers"; today that's "single localnet for the whole suite". Honest, but it caps suite size before flakiness from cross-test-state dominates.

## Integration warts

- `DEVSTACK_E2E_CONFIG_PATH` env handoff is set at config-evaluation time, then read in `global-setup.ts` and `global-teardown.ts`. Fine for one config per Playwright run; breaks if a developer ever invokes Playwright with multiple project configs.
- `DEVSTACK_E2E_TEARDOWN=drop` (CI mode) calls `runStack({force: true})` which the `dropStack` guard now allows. But teardown does **not** stop the wallet-server — same hook-registration gap as setup. In CI, that's fine because the process exits. In local re-runs, you can leak Node servers across runs.
- The `.ts` vs `.mjs` extension switching detects `'/src/playwright'` in `__dirname` to choose loader. This works but is fragile to symlinked workspace layouts.

## Customizability + meta-testing

`extend` (line 14) gives consumers a `Partial<PlaywrightTestConfig>` escape hatch — good. But the `webServer.command`, the `manageStack`-driven `globalSetup`/`globalTeardown`, and the workers/parallel knobs all live above the spread. That's the right precedence for the common case, but consumers can't, e.g., swap globalSetup for a multi-app variant. There's no `globalSetup: string[]` chain. Trace + screenshot defaults (`trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`) are sensible. No video, no reporter customization beyond the CI/list switch.

The integration is testing infrastructure, so the meta-question is: is the setup itself robust to env churn? **It's not.**

## Top recommendations

1. **Drop `runOnce` from globalSetup entirely** and have it only `apply` (one-shot deploy actions, no service actions), letting `pnpm dev`'s watch be the sole authority on services. The current design conflates "bring chain to a known state" with "start every service" — those are different lifecycles.
2. **Or: persist the wallet-server token** to `.devstack/stacks/<stack>/wallet-token` so it's stable across Supervisor incarnations.
3. **Or: make wallet-server a Docker container** so its lifecycle is decoupled from Supervisor instances.
4. **Move workers/parallel below `...extend`** so consumers can override.
5. **Add `globalSetup: string[]` chain support** for multi-app suites.
