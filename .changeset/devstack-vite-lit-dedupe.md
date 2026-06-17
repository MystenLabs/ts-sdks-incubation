---
'@mysten-incubation/devstack': patch
---

Fix the injected dev wallet failing with `Illegal constructor` and an unusable connection state on disconnect/reconnect in scaffolded apps. The Vite plugin now pre-bundles the dev-wallet entries it injects (`optimizeDeps.include` for `@mysten-incubation/dev-wallet/inject` + `/adapters`) and dedupes Lit (`resolve.dedupe`), so Vite never re-optimizes them mid-session into a second Lit instance — which had registered the wallet's web components in a separate custom-element realm the page couldn't construct.
