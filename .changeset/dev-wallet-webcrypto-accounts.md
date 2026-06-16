---
'@mysten-incubation/dev-wallet': minor
---

The injected devstack dev wallet now bundles a `WebCryptoSignerAdapter` alongside the stack's server-resolved accounts, so users can create their own accounts from the wallet UI. Created accounts persist across reloads in IndexedDB via non-extractable WebCrypto keys (not in-memory), and the stack's `alice`/`bob`/`carol` accounts remain available.
