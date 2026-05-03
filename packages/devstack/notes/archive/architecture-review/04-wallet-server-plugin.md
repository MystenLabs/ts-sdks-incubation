# Wallet-server plugin

**Verdict**: B — Tight, well-scoped piece of glue with two real architectural seams: a module-level singleton that mismodels port/lifecycle ownership, and a getStatus that mistakes any in-flight server for the one this supervisor owns.

## Architecture

In-process Node `http.createServer` inside the supervisor is the right call for "scaffold-eth-2 for Sui": no extra container, no extra process tree, accounts already live in `ctx.accounts`, and signing is a same-process function call. A separate process or container would have given us nothing except a port juggling problem already solved by the `vite()` plugin.

The implementation matches the rest of the devstack: a single `service()` action (`wallet-server.serve`), `needs: ['sui.accounts']` so funded accounts exist before any sign request, `getStatus` HEAD-probes `/health`, `run` is idempotent on warm cycles, and an `onShutdown` hook closes the server. CORS is wide open (`*`), which is fine — this is dev-only and the bearer token is the gate.

The seam: **module-level mutable state**. `activeServer` and `activeToken` (`index.ts:40-41`) are top-level `let`s. That works while one supervisor lives in one process, but it conflates two concepts: "is *my* server up" and "is *something* listening on this port." That conflation is exactly what bit us during the walrus debugging session.

`server.ts` is clean: token comparison goes through `timingSafeEqual` after a length check, body-size cap is 2MB, JSON parse errors map to 400, address validation uses `isValidSuiAddress`. The account snapshot is built once at server start (`buildAccountSnapshot`, line 52). That's a deliberate choice and a constraint — accounts added or rotated mid-cycle won't appear without a restart.

## Problem fit

It actually replaces a real wallet for dev. `DevstackProxySigner` implements `Signer.signTransaction`/`signPersonalMessage` over HTTP, throws on `sign()` (raw digest) since the server only signs BCS-serialized `TransactionData`, and surfaces the same wallet-standard features as in-memory adapters. Account switching works: every account in the manifest's `accounts` config materializes through `resolveAccounts`, lands in the snapshot, and the Devstack adapter exposes them to `dapp-kit` via `setInitialAccounts`. The wallet example's e2e (`examples/wallet/e2e/panels.spec.ts:16`) exercises the full path: panel mints MUSDC → Devstack adapter → wallet-server → on-chain.

What it doesn't do: **multi-wallet** (it's exactly one paired adapter per app), **approval-gated flows** (every authorized request signs, no human-in-the-loop modal — `DevstackSignerAdapter.allowAutoSign = true`), and **persistent tokens** (every `run()` calls `generateToken()` afresh).

## Integration

Discoverable through one entry in `index.ts` (export at lines 106-110), one service registration in the manifest (`{ name: 'wallet-server', kind: 'wallet-server', url, port, endpointLabel: '<url>/?token=<hex>' }`), and one consumer helper (`createDevstackAdapterFromManifest` at `packages/dev-wallet/src/adapters/devstack-adapter.ts:277`). The Vite virtual-module exposes the manifest, `configureDevstackPanels(manifest)` feeds the panel custom elements, and `createDevstackDappKit({ walletInitializers: [devWalletInitializer({ adapters: [devstackAdapter] })] })` ties it to dapp-kit. Token transport via `endpointLabel` is a small abuse — it's nominally a display string — but `parseDevstackToken` localizes the parse so it's a contained pattern.

## Customizability + gaps

`port` (default 9420), `publicOrigin` (override for tunneled hosts), and `needs` (default `['sui.accounts']`) are the knobs. Real gaps:

1. **Token persistence across restarts.** Every supervisor start regenerates the token. The browser caches the manifest into the SPA bundle at startup; on a hot restart the manifest's token can disagree with the running server's. Persisting the token to `<stack>/.devstack/wallet-server.token` would close this.
2. **No per-account approval mode.** Useful for local fuzzing of approval UX before shipping to a real wallet.
3. **Snapshot is taken once.** A new account added mid-`watch` won't appear without restarting the server; rebuilding the snapshot per request (or invalidating on `accounts` registry dirty) is a small change.
4. **No health beyond reachability.** `/health` returns `{ ok: true }` unconditionally, regardless of whether `accounts.names()` is empty.

## The connect-failure race

This is the architectural seam that hurt during the walrus debugging session. Sequence:

1. A prior `devstack watch` left a wallet-server bound to 9420 with token `T1`.
2. The supervisor's reconciler runs `getStatus` on `wallet-server.serve`, HEAD-probes `http://localhost:9420/health`, gets 200, returns `{ ok: true }`.
3. Per `reconcile.ts:307-316`, the action is marked `healthy` and `run` is **never called**. `registerService` at `index.ts:96-103` therefore never executes, and the new manifest is written **without** a `wallet-server` entry — or with a stale one if the reader hydrated from the prior file.
4. The browser bundle reads the manifest, finds no service or finds an entry whose `endpointLabel` carries token `T1`. If the prior server actually exited cleanly the port is free but the token in the manifest is stale; if the prior server is still alive, the token in the new manifest is missing. Either way, "Connection failed."

Two architectural fixes, in order of cost. **Cheap:** re-run `registerService` from `getStatus` itself when ok (or, equivalently, when `getStatus` returns ok, ensure the registry already carries the entry; if not, demote to `{ ok: false, detail: 'reachable but not owned' }`). **Better:** stop using `localhost:port` reachability as the health signal at all — instead probe `/health?token=T` with the token the plugin would have minted, so a foreign server fails the probe and `run()` fires.

## Testing

Unit coverage of the plugin and server is **zero**. There are no `wallet-server/*.test.ts` files; no test in `runtime/supervisor.test.ts` or `runtime/reconcile.test.ts` references it. The only integration coverage is `examples/wallet/e2e/panels.spec.ts` — three Playwright tests, real chain. Recommended additions: a `server.test.ts` covering token mismatch (401), invalid address (400), oversize body (413), unknown signer (404), and `signPersonalMessage`'s response shape; a supervisor test asserting that re-up registers a fresh token in the manifest even when the prior port is still bound.

## Top recommendations

1. **Fix the warm-path registration bug** by re-running `registerService` from `getStatus` when ok=true (or demoting to ok=false when the registry doesn't carry an entry for our process).
2. **Persist the wallet-server token** across restarts to a per-stack file so manifest readers don't see a fresh token on every supervisor cycle.
3. **Add `server.test.ts`** covering the auth + body-validation paths.
4. **Move `activeServer`/`activeToken` out of module scope** into the factory closure so multiple plugin instances in one process don't interleave.
