---
'@mysten-incubation/dev-wallet': minor
'@mysten-incubation/devstack': minor
---

Dev wallet: explicit test-only connect, no pre-connect or storage seeding.

The injected dev wallet no longer seeds dApp Kit's localStorage to fake an auto-connect to a specific
account on page load. A fresh page now loads disconnected, and dApp Kit's own `autoConnect` does only
what it's meant to — re-connect a genuine prior session.

A new devstack `/dapp-kit` entrypoint exports `registerDAppKitForTesting(dAppKit)`, which the app
wires DEV-only after `createDAppKit(...)`. It publishes the `connectAs` slot that drives a REAL
connection through dApp Kit's public API (`connectWallet` / `switchAccount`, resolving accounts by
label) instead of narrowing/widening the wallet's exposed accounts to exploit reconciliation. The dev
wallet auto-approves `standard:connect` only when signing is auto-approved (the headless-e2e
`DEVSTACK_AUTO_APPROVE` signal); in normal dev a human approves the connect. This fixes wallet
connection under `@mysten/dapp-kit-core` ≥1.6, whose rewritten auto-connect state machine broke the
old storage-seeding approach.
