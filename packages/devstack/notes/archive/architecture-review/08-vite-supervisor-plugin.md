# Vite plugin (supervisor-side)

**Verdict**: B+ — Tight, justified plugin that earns its keep through dependency-graph ordering and unified logging. Three small structural issues but all fixable.

## Architecture

The plugin defines a single `service()` action `vite.dev-server` whose `run` spawns `pnpm exec vite --port <port>` via `node:child_process.spawn`, pipes stdout/stderr through `streamLines` into `ctx.appendLog`, and registers a SIGINT shutdown hook with a 5s SIGKILL escalation. `getStatus` HEAD-probes the dev URL; any positive HTTP status counts as live (even 4xx — the comment acknowledges the process is what's being checked, not the response). A module-scoped `let child` makes `run` idempotent across warm reconcile cycles: if the existing child is alive, return without spawning a duplicate.

The implementation is small and tidy. The line-buffered ANSI-stripping streamer (`streamLines` / `stripAnsi` with `\x1b\[[0-9;?]*[a-zA-Z]` regex, `FORCE_COLOR=0`) is appropriate — the supervisor's panel renderer needs plain text, and vite emits liberal ANSI cursor moves. `waitForReachable` uses 250ms polling with a 30s budget, which matches typical cold-start.

The few flaws are real but minor:

1. **No restart on crash.** If vite exits for any reason (config error, port collision late in startup), `child.exitCode` becomes non-null and the next reconcile cycle's `run` will respawn — but only if a cycle happens. The supervisor doesn't observe child exits proactively; nothing logs the exit. Compare `sui.localnet`, which uses Docker's `restart: 'unless-stopped'` policy.
2. **`requireLocalnetCtx(ctx)` on a host process is a category error.** The comment at lines 66-69 acknowledges this explicitly. Vite isn't a container, so the localnet narrowing is purely about excluding `devstack deploy`/live-net code paths from spawning a dev server. Live-net builds with HMR (testnet preview) would break.
3. **Module-scoped `child` variable.** Two `vite()` plugin instances in one process would interleave. Not a practical issue today, but the wallet-server has the same anti-pattern.
4. **No `/health` endpoint awareness.** Probing `/` returns the index HTML, which Vite serves before HMR is ready.

## Problem fit

This *should* exist. The supervisor already runs localnet + walrus + seal + wallet-server; folding vite in lets one log stream interleave codegen output, manifest writes, and HMR refreshes. The `needs: ['codegen.generate']` ordering specifically prevents the "stack is empty" first paint flash — `concurrently` cannot express this dependency. That alone justifies the plugin. The CLAUDE.md anti-pattern list calls out hardcoded ports outside the allocator and copy-pasted `concurrently` setups; this plugin avoids both.

The value over `concurrently` is concrete: shared log panel, dependency-graph ordering, manifest hot-reload timing, and centralized shutdown.

## Integration

**Playwright `webServer` overlap.** The four examples' `playwright.config.ts` all call `defineDevstackPlaywrightConfig({ port: 5173, manageStack: true })`. With `manageStack: true`, `globalSetup` runs `devstack up` (which starts vite via this plugin), and Playwright's `webServer.command = 'pnpm dev'` *also* starts vite — but Playwright sets `reuseExistingServer: !process.env.CI`, so locally the second `pnpm dev` no-ops on the already-bound port. CI without `manageStack` would invoke `pnpm dev` directly, bypassing devstack. This works but is subtle; the timeout values (60s webServer, 120s test, 30s `waitForReachable`) are layered without coordination.

**Manifest registration.** Notably, the vite plugin does *not* call `ctx.registry.services.register(...)`. The wallet-server does, and so does sui. That means `services.dev-server.url` won't appear in the manifest — frontends can't discover the dev URL through the same mechanism they use for the wallet-server URL. This is probably fine (the dev server *is* the frontend), but it's an asymmetry worth noting.

## Customizability + gaps

`port`, `command`, `cwd`, `needs` are all overridable. Real gaps:

- **No multi-port support** (admin UI on a separate port, preview server). Today users would instantiate the plugin twice — but the module-scoped `child` would conflict.
- **Framework-agnostic frontend.** The package is named `vite` and hardcodes `pnpm exec vite`. Next.js/Remix/SvelteKit need `pnpm dev` style commands; users *can* override `command` but the default `--port` flag append assumes Vite's CLI shape. A more honest API would be `frontend({ command, readyUrl, port })`.
- **No HMR signal.** The probe knows nothing about when HMR is ready vs. just-listening. `appendLog` is the only feedback channel; a richer status (`detail: 'HMR ready'`) would help.
- **No env var pass-through.** `FORCE_COLOR=0` is forced; other vite-specific env (`VITE_*`, `BROWSER`, `HOST`) can't be overridden.
- **`baseUrl` hardcodes `localhost`.** The wallet-server has `publicOrigin` for tunneling; vite doesn't.

## Testing

**Zero test coverage.** No `vite.test.ts` exists. Compare `imports/` (3 test files) and `runtime/` (6). Service-action behavior (idempotent run, ANSI stripping, shutdown SIGKILL escalation, probe semantics) is all untested. `streamLines` and `stripAnsi` are pure functions trivially unit-testable; `run`/`getStatus` would need a fake spawn, but the wallet-server has the same gap so a shared harness would amortize.

## Top recommendations

1. **Rename `vite` → `frontend` and drop the `--port` auto-append assumption** to support Next/SvelteKit. The current name implies ownership of one specific tool.
2. **Move module-scoped `child` into the factory closure** and add a `child.on('exit')` listener that logs and clears state. Eliminates the multi-instance interleaving risk.
3. **Add a unit test for `stripAnsi`** and an integration test that spawns a fake server and verifies idempotent run + shutdown.
4. **Register `vite.dev-server` as a service** in the registry with kind `'dev-server'`. Even if no consumer reads it today, the asymmetry with sui/wallet-server is unjustified.
