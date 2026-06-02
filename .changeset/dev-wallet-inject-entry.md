---
'@mysten-incubation/dev-wallet': minor
'@mysten-incubation/devstack': minor
---

Auto-inject the devstack dev wallet via the Vite plugin.

`@mysten-incubation/dev-wallet` adds a `/inject` entry (`registerDevstackDevWallet`) that constructs the dev wallet from a devstack stack's config and registers it on the page via the wallet-standard window protocol (plus the Playwright `connectAs` slot). The devstack Vite plugin uses it to inject + register the dev wallet in DEV only, so dapp-kit apps discover it through wallet-standard with no app-side wiring — apps no longer need a `dapp-kit.dev.ts` or any `@devstack-dev` import, and production builds carry no dev-wallet code. The dev wallet exposes all of its accounts to the dApp while `connectAs` still drives the active account.
