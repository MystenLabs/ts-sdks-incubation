# fork-greeting

Minimal sui-fork harness — publishes a tiny Move package against a
`testnet-fork`, posts a greeting to a shared object, and reads it back
through the UI. The gate-keeper for sui-fork Phase 5 work (walrus shim,
seal audit, auto-tick, parallel stacks, dev-wallet fork UI,
subscriptions).

## What it shows

- `Sui({ network: 'testnet-fork', fork: { seed: { addresses } } })` —
  the canonical fork-mode service factory. Devstack stands up a
  `sui-fork` container anchored at testnet at the configured seed
  addresses.
- `Account('publisher' | 'alice' | 'bob')` auto-promoted to
  `{kind: 'impersonate', sender: <seed-addr>}` per the Phase-2
  auto-promotion rule. There's no faucet on a fork; devstack signs
  with the empty-signature branch instead (`executeImpersonated`).
- `PackageWithCapture('greeting', …, { capture: { boardId: '::board::Board' } })`
  publishes the Move package and projects the shared `Board` object's
  id into `captured.greeting.boardId` (typed, IDE-discoverable).
- A two-card React UI: post a greeting, read the latest one back.
- A playwright e2e that drives the full flow and asserts round-trip.

## Run it

```bash
# Seed addresses must point at testnet wallets you control (so the
# fork can drain them for publish + downstream funding). The default
# is a placeholder — override.
export FORK_SEED_ADDRESSES='0xYOUR_TESTNET_ADDR_1,0xYOUR_TESTNET_ADDR_2'
pnpm install
pnpm dev
```

First boot:

- TUI shows a `sui` row (fork mode) + `wallet` + `dev`.
- Fork cold start runs system-state warming against upstream testnet
  (~30–60s — Phase 5 §7 will optimize this).
- Greeting publishes; the `Board` shared object surfaces in the
  manifest's `packages.greeting.captured.boardId` slot.
- Vite serves at `http://localhost:5181`. Click Connect Wallet, pick
  `Dev: alice`, type a greeting, click Send.

## Run the e2e

```bash
PLAYWRIGHT=1 pnpm test:e2e
```

The supervisor brings the stack up; `playwright.config.ts` (via
`defineDevstackPlaywrightConfig()`) wires the webServer + baseURL.

## What's deferred to Phase 5

This harness is a stub for the broader phase-5 surface:

- **Walrus on fork** (P5.1) — write/read a blob against this fork.
- **Seal on fork** (P5.3) — re-encrypt / re-share against this fork.
- **Auto-tick clock** (P5.5) — pass `fork: { autoTickMs }` once the
  option lands; clock-gated Move logic stops needing manual
  `advanceClock` calls.
- **Dev-wallet fork tab** (P5.8) — surface `advanceClock` /
  `advanceCheckpoint` buttons in the wallet UI.
- **Subscriptions** (P5.10) — replace 1.5s polling on the shared Board
  with a `SubscribeCheckpoints` stream.

See `packages/devstack/notes/sui-fork-phase-5.md` for the full plan.
